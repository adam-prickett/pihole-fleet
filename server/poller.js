import { EventEmitter } from 'node:events';
import { PiholeClient, PiholeError } from './pihole.js';

// Fast data refreshes every tick; slower data every N ticks.
const SLOW_EVERY = 3;   // top lists, upstreams, system
const RARE_EVERY = 12;  // 24h history, versions

const HEARTBEATS = 60;  // poll results kept for the status history strip
const MAX_BACKOFF_MS = { auth: 5 * 60_000, network: 30_000 };
const MIN_FORCED_REFRESH_MS = 2000;

const pick = (result) => (result.status === 'fulfilled' ? result.value : undefined);

export class InstancePoller extends EventEmitter {
  constructor(instance, intervalMs) {
    super();
    this.instance = instance;
    this.intervalMs = intervalMs;
    this.client = new PiholeClient(instance);
    this.tick = 0;
    this.timer = null;
    this.running = false;
    this.failures = 0;
    this.lastForced = 0;
    this.state = {
      id: instance.id,
      name: instance.name,
      url: instance.url,
      status: 'connecting',
      error: null,
      lastUpdated: null,
      lastSeen: null,
      latencyMs: null,
      heartbeat: [],
    };
  }

  start() {
    this.running = true;
    this.#loop();
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    await this.client.logout();
  }

  /** Immediate full refresh. `force` skips coalescing (used right after a blocking change). */
  refreshNow({ force = false } = {}) {
    // Coalesce bursts so the dashboard can't be used to hammer a Pi-hole.
    if (!force && Date.now() - this.lastForced < MIN_FORCED_REFRESH_MS) return;
    this.lastForced = Date.now();
    clearTimeout(this.timer);
    this.tick = 0;
    this.#loop();
  }

  async #loop() {
    if (!this.running) return;
    const tick = this.tick++;
    let delay = this.intervalMs;
    try {
      await this.#poll(tick);
      this.failures = 0;
    } catch (err) {
      const authProblem = err.code === 'auth' || err.code === 'version';
      if (!(err instanceof PiholeError)) {
        console.error(`[poller:${this.instance.id}] unexpected error:`, err);
      }
      this.#update({
        status: authProblem ? 'auth_error' : 'offline',
        error: err instanceof PiholeError ? err.message : 'Unexpected error while polling (see server log)',
        heartbeat: this.#beat(false, null),
      });
      // Pull fresh slow data as soon as we reconnect.
      this.tick = 0;
      // Exponential backoff; repeated bad logins back off further so we don't flood the Pi-hole.
      this.failures++;
      const cap = authProblem ? MAX_BACKOFF_MS.auth : MAX_BACKOFF_MS.network;
      delay = Math.min(this.intervalMs * 2 ** (this.failures - 1), Math.max(cap, this.intervalMs));
    }
    if (this.running) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.#loop(), delay);
    }
  }

  async #poll(tick) {
    const c = this.client;
    const slow = tick % SLOW_EVERY === 0;
    const rare = tick % RARE_EVERY === 0;

    const started = performance.now();
    // Summary is the health check: if it fails, the instance is considered down.
    const summary = await c.get('/stats/summary');
    const latencyMs = Math.round(performance.now() - started);

    const jobs = {
      blocking: c.get('/dns/blocking'),
      queries: c.get('/queries?length=60'),
    };
    if (slow) {
      jobs.topDomains = c.get('/stats/top_domains?count=10');
      jobs.topBlocked = c.get('/stats/top_domains?blocked=true&count=10');
      jobs.topClients = c.get('/stats/top_clients?count=10');
      jobs.upstreams = c.get('/stats/upstreams');
      jobs.system = c.get('/info/system');
    }
    if (rare) {
      jobs.history = c.get('/history');
      jobs.version = c.get('/info/version');
    }

    const keys = Object.keys(jobs);
    const results = await Promise.allSettled(Object.values(jobs));
    const r = Object.fromEntries(keys.map((k, i) => [k, pick(results[i])]));

    const patch = {
      status: 'online',
      error: null,
      lastSeen: Date.now(),
      latencyMs,
      heartbeat: this.#beat(true, latencyMs),
      summary: normalizeSummary(summary),
    };
    if (r.blocking) patch.blocking = { state: r.blocking.blocking, timer: r.blocking.timer ?? null };
    if (r.queries) patch.queries = normalizeQueries(r.queries.queries);
    if (r.topDomains) patch.topDomains = r.topDomains.domains ?? [];
    if (r.topBlocked) patch.topBlocked = r.topBlocked.domains ?? [];
    if (r.topClients) patch.topClients = r.topClients.clients ?? [];
    if (r.upstreams) patch.upstreams = normalizeUpstreams(r.upstreams.upstreams);
    if (r.system) patch.system = normalizeSystem(r.system.system);
    if (r.history) patch.history = (r.history.history ?? []).map((h) => ({
      t: h.timestamp, total: h.total ?? 0, blocked: h.blocked ?? 0,
    }));
    if (r.version) patch.version = normalizeVersion(r.version.version);

    this.#update(patch);
  }

  #beat(ok, ms) {
    return [...this.state.heartbeat, { t: Date.now(), ok, ms }].slice(-HEARTBEATS);
  }

  #update(patch) {
    this.state = { ...this.state, ...patch, lastUpdated: Date.now() };
    this.emit('update', this.state);
  }
}

function normalizeSummary(s) {
  const q = s.queries ?? {};
  return {
    total: q.total ?? 0,
    blocked: q.blocked ?? 0,
    percentBlocked: q.percent_blocked ?? 0,
    uniqueDomains: q.unique_domains ?? 0,
    forwarded: q.forwarded ?? 0,
    cached: q.cached ?? 0,
    frequency: q.frequency ?? 0,
    types: q.types ?? {},
    activeClients: s.clients?.active ?? 0,
    totalClients: s.clients?.total ?? 0,
    gravityDomains: s.gravity?.domains_being_blocked ?? 0,
    gravityUpdated: s.gravity?.last_update ?? null,
  };
}

const BLOCKED_STATUSES = new Set([
  'GRAVITY', 'REGEX', 'DENYLIST', 'EXTERNAL_BLOCKED_IP', 'EXTERNAL_BLOCKED_NULL',
  'EXTERNAL_BLOCKED_NXRA', 'EXTERNAL_BLOCKED_EDE15', 'GRAVITY_CNAME', 'REGEX_CNAME',
  'DENYLIST_CNAME', 'SPECIAL_DOMAIN', 'DBBUSY',
]);
const CACHED_STATUSES = new Set(['CACHE', 'CACHE_STALE']);

function normalizeQueries(list = []) {
  return list.map((q) => ({
    id: q.id,
    time: q.time,
    type: q.type,
    domain: q.domain,
    client: q.client?.name || q.client?.ip || '',
    clientIp: q.client?.ip ?? '',
    status: q.status,
    outcome: BLOCKED_STATUSES.has(q.status) ? 'blocked'
      : CACHED_STATUSES.has(q.status) ? 'cached' : 'allowed',
    replyMs: q.reply?.time != null && q.reply.time >= 0 ? q.reply.time * 1000 : null,
    upstream: q.upstream ?? null,
  }));
}

function normalizeUpstreams(list = []) {
  return list.map((u) => ({
    name: u.name || u.ip,
    ip: u.ip,
    port: u.port,
    count: u.count ?? 0,
    responseMs: u.statistics?.response != null ? u.statistics.response * 1000 : null,
  }));
}

function normalizeSystem(sys) {
  if (!sys) return null;
  const ram = sys.memory?.ram;
  return {
    uptime: sys.uptime ?? null,
    memPercent: ram?.['%used'] ?? null,
    cpuPercent: sys.cpu?.['%cpu'] ?? sys.cpu?.load?.percent?.[0] ?? null,
    load: sys.cpu?.load?.raw ?? null,
    cores: sys.cpu?.nprocs ?? null,
  };
}

function normalizeVersion(v) {
  if (!v) return null;
  const local = (x) => x?.local?.version ?? null;
  const updateAvailable = ['core', 'web', 'ftl'].some((k) => {
    const l = v[k]?.local?.hash, r = v[k]?.remote?.hash;
    return l && r && l !== r;
  });
  return {
    core: local(v.core),
    web: local(v.web),
    ftl: local(v.ftl),
    docker: v.docker?.local ?? null,
    updateAvailable,
  };
}
