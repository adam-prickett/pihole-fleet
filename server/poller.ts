import {EventEmitter} from 'node:events';
import {PiholeClient, PiholeError} from './pihole.js';
import type {
  Blocking,
  BlockingState,
  Heartbeat,
  HistoryPoint,
  InstanceConfig,
  InstanceState,
  Query,
  QueryOutcome,
  Summary,
  SystemInfo,
  TopItem,
  Upstream,
  VersionInfo,
} from './types.js';

// Fast data refreshes every tick; slower data every N ticks.
const SLOW_EVERY = 3; // top lists, upstreams, system
const RARE_EVERY = 12; // 24h history, versions

const HEARTBEATS = 60; // poll results kept for the status history strip
const MAX_BACKOFF_MS = {auth: 5 * 60_000, network: 30_000};
const MIN_FORCED_REFRESH_MS = 2000;

// --- Raw Pi-hole v6 API responses (only the fields we use; all optional).

interface RawSummary {
  queries?: {
    total?: number;
    blocked?: number;
    percent_blocked?: number;
    unique_domains?: number;
    forwarded?: number;
    cached?: number;
    frequency?: number;
    types?: Record<string, number>;
  };
  clients?: {active?: number; total?: number};
  gravity?: {domains_being_blocked?: number; last_update?: number};
}

interface RawQuery {
  id: number;
  time: number;
  type: string;
  domain: string;
  status: string;
  client?: {name?: string; ip?: string};
  reply?: {time?: number};
  upstream?: string | null;
}

interface RawUpstream {
  name?: string;
  ip: string;
  port: number;
  count?: number;
  statistics?: {response?: number};
}

interface RawSystem {
  uptime?: number;
  memory?: {ram?: {'%used'?: number}};
  cpu?: {
    '%cpu'?: number;
    nprocs?: number;
    load?: {raw?: number[]; percent?: number[]};
  };
}

interface RawVersionPart {
  local?: {version?: string; branch?: string; hash?: string};
  remote?: {version?: string; hash?: string};
}

interface RawVersion {
  core?: RawVersionPart;
  web?: RawVersionPart;
  ftl?: RawVersionPart;
  docker?: {local?: string | null; remote?: string | null};
}

/** The slower endpoints, fetched only on some ticks. */
interface PollResults {
  blocking?: {blocking: BlockingState; timer?: number | null};
  queries?: {queries?: RawQuery[]};
  topDomains?: {domains?: TopItem[]};
  topBlocked?: {domains?: TopItem[]};
  topClients?: {clients?: TopItem[]};
  upstreams?: {upstreams?: RawUpstream[]};
  system?: {system?: RawSystem};
  history?: {
    history?: Array<{timestamp: number; total?: number; blocked?: number}>;
  };
  version?: {version?: RawVersion};
}

/** Polls one Pi-hole and emits 'update' with its latest InstanceState. */
export class InstancePoller extends EventEmitter {
  readonly instance: InstanceConfig;
  readonly client: PiholeClient;
  intervalMs: number;
  state: InstanceState;
  /** When a blocking change was last made through the dashboard. */
  lastAction = 0;
  private tick = 0;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private failures = 0;
  private lastForced = 0;

  constructor(instance: InstanceConfig, intervalMs: number) {
    super();
    this.instance = instance;
    this.intervalMs = intervalMs;
    this.client = new PiholeClient(instance);
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

  start(): void {
    this.running = true;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.client.logout();
  }

  /** Immediate full refresh. `force` skips coalescing (used right after a blocking change). */
  refreshNow({force = false}: {force?: boolean} = {}): void {
    // Coalesce bursts so the dashboard can't be used to hammer a Pi-hole.
    if (!force && Date.now() - this.lastForced < MIN_FORCED_REFRESH_MS) return;
    this.lastForced = Date.now();
    clearTimeout(this.timer);
    this.tick = 0;
    void this.loop();
  }

  private async loop(): Promise<void> {
    if (!this.running) return;
    const tick = this.tick++;
    let delay = this.intervalMs;
    try {
      await this.poll(tick);
      this.failures = 0;
    } catch (err) {
      const known = err instanceof PiholeError;
      const authProblem =
        known && (err.code === 'auth' || err.code === 'version');
      if (!known) {
        console.error(`[poller:${this.instance.id}] unexpected error:`, err);
      }
      this.update({
        status: authProblem ? 'auth_error' : 'offline',
        error: known
          ? err.message
          : 'Unexpected error while polling (see server log)',
        heartbeat: this.beat(false, null),
      });
      // Pull fresh slow data as soon as we reconnect.
      this.tick = 0;
      // Exponential backoff; repeated bad logins back off further so we don't flood the Pi-hole.
      this.failures++;
      const cap = authProblem ? MAX_BACKOFF_MS.auth : MAX_BACKOFF_MS.network;
      delay = Math.min(
        this.intervalMs * 2 ** (this.failures - 1),
        Math.max(cap, this.intervalMs),
      );
    }
    if (this.running) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.loop(), delay);
    }
  }

  private async poll(tick: number): Promise<void> {
    const c = this.client;
    const slow = tick % SLOW_EVERY === 0;
    const rare = tick % RARE_EVERY === 0;

    const started = performance.now();
    // Summary is the health check: if it fails, the instance is considered down.
    const summary = await c.get<RawSummary>('/stats/summary');
    const latencyMs = Math.round(performance.now() - started);

    const jobs: Partial<Record<keyof PollResults, Promise<unknown>>> = {
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

    // One failing endpoint shouldn't drop the rest.
    const keys = Object.keys(jobs);
    const settled = await Promise.allSettled(Object.values(jobs));
    const r: PollResults = Object.fromEntries(
      keys.map((k, i) => {
        const result = settled[i];
        return [k, result.status === 'fulfilled' ? result.value : undefined];
      }),
    );

    const patch: Partial<InstanceState> = {
      status: 'online',
      error: null,
      lastSeen: Date.now(),
      latencyMs,
      heartbeat: this.beat(true, latencyMs),
      summary: normalizeSummary(summary),
    };
    if (r.blocking) {
      patch.blocking = {
        state: r.blocking.blocking,
        timer: r.blocking.timer ?? null,
      } satisfies Blocking;
    }
    if (r.queries) patch.queries = normalizeQueries(r.queries.queries);
    if (r.topDomains) patch.topDomains = r.topDomains.domains ?? [];
    if (r.topBlocked) patch.topBlocked = r.topBlocked.domains ?? [];
    if (r.topClients) patch.topClients = r.topClients.clients ?? [];
    if (r.upstreams) {
      patch.upstreams = normalizeUpstreams(r.upstreams.upstreams);
    }
    if (r.system) patch.system = normalizeSystem(r.system.system);
    if (r.history) {
      patch.history = (r.history.history ?? []).map((h): HistoryPoint => ({
        t: h.timestamp,
        total: h.total ?? 0,
        blocked: h.blocked ?? 0,
      }));
    }
    if (r.version) patch.version = normalizeVersion(r.version.version);

    this.update(patch);
  }

  private beat(ok: boolean, ms: number | null): Heartbeat[] {
    return [...this.state.heartbeat, {t: Date.now(), ok, ms}].slice(
      -HEARTBEATS,
    );
  }

  private update(patch: Partial<InstanceState>): void {
    this.state = {...this.state, ...patch, lastUpdated: Date.now()};
    this.emit('update', this.state);
  }
}

function normalizeSummary(s: RawSummary): Summary {
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
  'GRAVITY',
  'REGEX',
  'DENYLIST',
  'EXTERNAL_BLOCKED_IP',
  'EXTERNAL_BLOCKED_NULL',
  'EXTERNAL_BLOCKED_NXRA',
  'EXTERNAL_BLOCKED_EDE15',
  'GRAVITY_CNAME',
  'REGEX_CNAME',
  'DENYLIST_CNAME',
  'SPECIAL_DOMAIN',
  'DBBUSY',
]);
const CACHED_STATUSES = new Set(['CACHE', 'CACHE_STALE']);

function outcomeOf(status: string): QueryOutcome {
  if (BLOCKED_STATUSES.has(status)) return 'blocked';
  if (CACHED_STATUSES.has(status)) return 'cached';
  return 'allowed';
}

function normalizeQueries(list: RawQuery[] = []): Query[] {
  return list.map(q => ({
    id: q.id,
    time: q.time,
    type: q.type,
    domain: q.domain,
    client: q.client?.name || q.client?.ip || '',
    clientIp: q.client?.ip ?? '',
    status: q.status,
    outcome: outcomeOf(q.status),
    replyMs:
      q.reply?.time != null && q.reply.time >= 0 ? q.reply.time * 1000 : null,
    upstream: q.upstream ?? null,
  }));
}

function normalizeUpstreams(list: RawUpstream[] = []): Upstream[] {
  return list.map(u => ({
    name: u.name || u.ip,
    ip: u.ip,
    port: u.port,
    count: u.count ?? 0,
    responseMs:
      u.statistics?.response != null ? u.statistics.response * 1000 : null,
  }));
}

function normalizeSystem(sys: RawSystem | undefined): SystemInfo | null {
  if (!sys) return null;
  return {
    uptime: sys.uptime ?? null,
    memPercent: sys.memory?.ram?.['%used'] ?? null,
    cpuPercent: sys.cpu?.['%cpu'] ?? sys.cpu?.load?.percent?.[0] ?? null,
    load: sys.cpu?.load?.raw ?? null,
    cores: sys.cpu?.nprocs ?? null,
  };
}

/** True if version `b` is newer than `a` ("v6.1.2", "2025.06.0"); false if either can't be read. */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/i, '').split('.').map(Number);
  const x = parse(a);
  const y = parse(b);
  if ([...x, ...y].some(n => !Number.isFinite(n))) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? 0) - (x[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * Same rule as Pi-hole's own web UI: on release builds compare version numbers (the local and
 * remote hashes are recorded differently, so they rarely match even when up to date); on a
 * development branch compare commit hashes.
 */
function partOutdated(p: RawVersionPart | undefined): boolean {
  const local = p?.local;
  const remote = p?.remote;
  if (!local || !remote) return false;
  const branch = local.branch;
  if (branch && branch !== 'master' && local.hash && remote.hash) {
    const [l, r] = [local.hash, remote.hash].map(h => h.toLowerCase());
    return !(l.startsWith(r) || r.startsWith(l));
  }
  return Boolean(
    local.version && remote.version && isNewer(local.version, remote.version),
  );
}

function normalizeVersion(v: RawVersion | undefined): VersionInfo | null {
  if (!v) return null;
  const local = (x: RawVersionPart | undefined) => x?.local?.version ?? null;
  const docker = v.docker;
  const dockerOutdated = Boolean(
    docker?.local && docker.remote && isNewer(docker.local, docker.remote),
  );
  return {
    core: local(v.core),
    web: local(v.web),
    ftl: local(v.ftl),
    docker: docker?.local ?? null,
    updateAvailable:
      [v.core, v.web, v.ftl].some(partOutdated) || dockerOutdated,
  };
}
