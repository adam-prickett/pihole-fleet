import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express, {type Request, type Response} from 'express';
import {
  ConfigError,
  loadConfig,
  normalizeInstance,
  type InstanceInput,
} from './config.js';
import {PiholeClient, PiholeError} from './pihole.js';
import {InstancePoller} from './poller.js';
import {InstanceStore} from './store.js';
import {
  checkNewPassword,
  hashPassword,
  hashVerifier,
  MIN_PASSWORD,
  SETTINGS,
  SettingsStore,
  validateSettings,
  type PasswordHash,
} from './settings.js';
import {
  clientIp,
  createAuth,
  defaultAllowedHosts,
  errorHandler,
  hostGuard,
  hostMatcher,
  isLoopback,
  originGuard,
  rateLimit,
  requestHost,
  requireJson,
  securityHeaders,
} from './security.js';
import type {
  DashboardEvent,
  InstanceConfig,
  InstanceDef,
  InstanceState,
  InstancesResponse,
  PublicInstance,
  SettingsResponse,
  SettingsValues,
  Severity,
  Snapshot,
  TestResult,
} from './types.js';

const config = loadConfig();

/** Structured audit trail on stdout (picked up by `docker logs` / journald). */
function audit(entry: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ts: new Date().toISOString(), type: 'audit', ...entry}),
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Dashboard settings. Values from the environment / config file are locked; the rest come
// from settings.json in the data directory (saved from the settings page), else defaults.
const settingsStore = new SettingsStore(config.dataDir);
const saved = settingsStore.load();
let savedSettings: Partial<SettingsValues> = Object.fromEntries(
  Object.entries(saved.settings).filter(
    ([k]) => !config.locked[k as keyof SettingsValues],
  ),
);
let passwordHash: PasswordHash | null = config.locked.password
  ? null
  : saved.passwordHash;

/** Copy settings onto the live config. */
function applySettings(patch: Partial<SettingsValues>): void {
  if (patch.allowedHosts !== undefined) {
    config.allowedHosts = patch.allowedHosts;
  }
  if (patch.trustProxy !== undefined) config.trustProxy = patch.trustProxy;
  if (patch.pollIntervalMs !== undefined) {
    config.pollIntervalMs = patch.pollIntervalMs;
  }
  if (patch.readOnly !== undefined) config.readOnly = patch.readOnly;
  if (patch.sessionHours !== undefined) {
    config.auth.sessionHours = patch.sessionHours;
  }
  if (patch.maxStreams !== undefined) config.maxStreams = patch.maxStreams;
}
applySettings(savedSettings);

function persistSettings(
  nextSettings: Partial<SettingsValues>,
  nextHash: PasswordHash | null,
): boolean {
  try {
    settingsStore.save({settings: nextSettings, passwordHash: nextHash});
    return true;
  } catch (err) {
    console.error(`Could not save ${settingsStore.file}:`, errorText(err));
    return false;
  }
}

if (config.resetPassword && passwordHash) {
  if (persistSettings(savedSettings, null)) passwordHash = null;
  console.warn(
    '  RESET_PASSWORD is set: the saved dashboard password was cleared. Remove the variable, then set a new password in Settings.',
  );
}

// Listen on all interfaces once a password exists; otherwise loopback only (unless HOST says otherwise).
config.host =
  config.hostExplicit ||
  (config.auth.password || passwordHash ? '0.0.0.0' : '127.0.0.1');

const auth = createAuth({
  password: config.auth.password,
  sessionHours: config.auth.sessionHours,
  audit,
});
if (passwordHash) auth.setVerifier(hashVerifier(passwordHash));

// ALLOWED_HOSTS / config file values get the same validation as the settings page.
if (config.locked.allowedHosts) {
  try {
    config.allowedHosts =
      validateSettings({allowedHosts: config.allowedHosts}).allowedHosts ??
      null;
  } catch (err) {
    console.error(`\n  Config error: ALLOWED_HOSTS: ${errorText(err)}\n`);
    process.exit(1);
  }
}

// Allowed hostnames: null = the default (any IP address plus this machine's own names).
const autoHosts = defaultAllowedHosts();

// Instance definitions (`source`: 'config' = config file, 'ui' = saved from the settings
// page) and one poller per instance. Map order is display order.
const store = new InstanceStore(config.dataDir);
const storeProblem = store.checkWritable();
const MAX_INSTANCES = 32;
const defs = new Map<string, InstanceDef>();
const pollers = new Map<string, InstancePoller>();
let started = false;

// --- Event feed: status transitions and blocking changes, newest first.
const MAX_EVENTS = 100;
const ACTION_DEDUPE_MS = 15_000;
const events: DashboardEvent[] = [];
let eventSeq = 0;

function record(
  instance: Pick<InstanceConfig, 'id' | 'name'>,
  severity: Severity,
  message: string,
): void {
  // The name is kept so events still read correctly after an instance is removed.
  events.unshift({
    id: ++eventSeq,
    t: Date.now(),
    instanceId: instance.id,
    instanceName: instance.name,
    severity,
    message,
  });
  events.length = Math.min(events.length, MAX_EVENTS);
}

function fmtTimer(s: number): string {
  if (s >= 3600) return `${Math.round(s / 3600)}h`;
  if (s >= 60) return `${Math.round(s / 60)}m`;
  return `${Math.round(s)}s`;
}

/** Record status transitions and outside blocking changes for one poller. */
function watch(p: InstancePoller): void {
  let prevStatus: InstanceState['status'] | null = null;
  let prevBlocking: string | null = null;
  p.on('update', (s: InstanceState) => {
    if (s.status !== prevStatus) {
      if (s.status === 'online') {
        record(
          p.instance,
          'good',
          prevStatus === null || prevStatus === 'connecting'
            ? 'Connected'
            : 'Recovered — instance reachable again',
        );
      } else if (s.status === 'offline') {
        record(p.instance, 'critical', `Unreachable: ${s.error}`);
      } else if (s.status === 'auth_error') {
        record(p.instance, 'serious', s.error ?? 'Authentication failed');
      }
      prevStatus = s.status;
    }
    const blocking = s.status === 'online' ? s.blocking?.state : undefined;
    if (blocking && blocking !== prevBlocking) {
      // Changes made through this dashboard are already recorded with their source;
      // anything else was changed outside the dashboard (Pi-hole UI, timer expiry, CLI).
      const viaDashboard =
        p.lastAction && Date.now() - p.lastAction < ACTION_DEDUPE_MS;
      if (!viaDashboard && (prevBlocking !== null || blocking !== 'enabled')) {
        const timer = s.blocking?.timer;
        record(
          p.instance,
          blocking === 'enabled' ? 'good' : 'warning',
          blocking === 'enabled'
            ? 'Blocking enabled (outside dashboard or timer expired)'
            : `Blocking disabled outside dashboard${timer ? ` for ${fmtTimer(timer)}` : ''}`,
        );
      }
      prevBlocking = blocking;
    }
  });
  p.on('update', broadcast);
}

function startPoller(inst: InstanceConfig): void {
  const p = new InstancePoller(inst, config.pollIntervalMs);
  watch(p);
  const old = pollers.get(inst.id);
  pollers.set(inst.id, p); // replacing keeps the instance's position
  if (old) retirePoller(old);
  if (started) p.start();
}

function retirePoller(p: InstancePoller): void {
  p.removeAllListeners();
  p.stop().catch(() => {}); // logs out of the Pi-hole; best effort
}

function removePoller(id: string): void {
  const p = pollers.get(id);
  if (!p) return;
  pollers.delete(id);
  retirePoller(p);
}

/** Why the instance settings can't be changed right now, or null if they can. */
function manageBlocked(): string | null {
  return config.readOnly ? 'The dashboard is in read-only mode' : storeProblem;
}

// Identifies the frontend build being served, so open tabs can tell when the server was upgraded.
const distDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist',
);
const buildId = fs.existsSync(path.join(distDir, 'index.html'))
  ? crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(distDir, 'index.html')))
      .digest('hex')
      .slice(0, 12)
  : null;

function snapshot(): Snapshot {
  return {
    generatedAt: Date.now(),
    buildId,
    readOnly: config.readOnly,
    authEnabled: auth.enabled,
    canManage: !manageBlocked(),
    pollIntervalMs: config.pollIntervalMs,
    instances: [...pollers.values()].map(p => p.state),
    events: events.slice(0, 50),
  };
}

// Live stream clients (with the session and IP they belong to); every instance update is
// pushed to them as a fresh snapshot.
const clients = new Map<Response, {sid: string | null; ip: string}>();
let pending: NodeJS.Timeout | null = null;

function broadcast(): void {
  // Coalesce bursts (several instances finishing at once) into one push.
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients.keys()) res.write(payload);
  }, 150);
}

// Load instances: config file first (if any), then those saved from the UI.
for (const inst of config.instances) defs.set(inst.id, inst);
for (const inst of store.load(new Set(defs.keys()))) defs.set(inst.id, inst);
for (const inst of defs.values()) startPoller(inst);

// ---------------------------------------------------------------------------
// HTTP app
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use(hostGuard(() => config.allowedHosts));
app.use(securityHeaders());
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', rateLimit({windowMs: 60_000, max: 600}));
app.use('/api', originGuard, requireJson);
app.use(express.json({limit: '10kb'}));

// --- Public endpoints
// Liveness of the dashboard itself (not the Pi-holes), for container healthchecks.
app.get('/api/health', (_req, res) => {
  res.json({ok: true});
});
app.get('/api/session', auth.status);
app.post(
  '/api/login',
  rateLimit({
    windowMs: 15 * 60_000,
    max: 10,
    message: 'Too many login attempts, try again later',
  }),
  auth.login,
);
app.post('/api/logout', auth.logout);

/** Reject an allowed-hosts list that would lock out the browser making the change. */
function checkKeepsAccess(req: Request, hosts: string[] | null): void {
  const host = requestHost(req);
  if (!hostMatcher(hosts, autoHosts)(host)) {
    throw new ConfigError(
      `Allowed hosts must include "${host}", the address you're using now, or you'd be locked out`,
    );
  }
}

/** Send a ConfigError as a 400; anything else is unexpected and goes to the error handler. */
function sendConfigError(res: Response, err: unknown): void {
  if (err instanceof ConfigError) {
    res.status(400).json({error: err.message});
    return;
  }
  throw err;
}

function saveFailed(res: Response): void {
  res.status(500).json({error: 'Could not save settings (see server log)'});
}

// --- Everything below requires a session (when a password is configured)
app.use('/api', auth.require);

// Close live streams belonging to a session that logged out or expired.
auth.onSessionEnd(sid => {
  for (const [res, c] of clients) if (c.sid === sid) res.end();
});

const MAX_STREAMS_PER_IP = 10;
app.get('/api/stream', (req, res) => {
  const ip = req.ip ?? '';
  const fromIp = [...clients.values()].filter(c => c.ip === ip).length;
  if (clients.size >= config.maxStreams || fromIp >= MAX_STREAMS_PER_IP) {
    res.status(503).json({error: 'Too many open live connections'});
    return;
  }
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`retry: 3000\ndata: ${JSON.stringify(snapshot())}\n\n`);
  clients.set(res, {sid: req.sessionId ?? null, ip});
  const keepAlive = setInterval(() => {
    if (!auth.isValid(req.sessionId)) {
      res.end();
      return;
    }
    res.write(': ping\n\n');
  }, 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

app.get('/api/state', (_req, res) => {
  res.json(snapshot());
});

interface BlockingBody {
  instances?: unknown;
  enabled?: unknown;
  timer?: unknown;
}

// Blocking control: { instances: ["id", ...] | "all", enabled: bool, timer?: seconds }
const MAX_TIMER_SECONDS = 7 * 86400;
app.post(
  '/api/blocking',
  rateLimit({windowMs: 60_000, max: 20}),
  async (req, res) => {
    if (config.readOnly) {
      res.status(403).json({error: 'Dashboard is in read-only mode'});
      return;
    }

    const body = (req.body ?? {}) as BlockingBody;
    const {instances = 'all', enabled, timer = null} = body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({error: '"enabled" must be a boolean'});
      return;
    }
    if (
      timer !== null &&
      !(
        typeof timer === 'number' &&
        Number.isFinite(timer) &&
        timer > 0 &&
        timer <= MAX_TIMER_SECONDS
      )
    ) {
      res
        .status(400)
        .json({error: '"timer" must be between 1 second and 7 days, or null'});
      return;
    }
    const ids =
      Array.isArray(instances) &&
      instances.every((id): id is string => typeof id === 'string')
        ? instances
        : null;
    if (instances !== 'all' && !ids) {
      res
        .status(400)
        .json({error: '"instances" must be "all" or an array of instance ids'});
      return;
    }

    const targets = ids
      ? [...new Set(ids)]
          .map(id => pollers.get(id))
          .filter((p): p is InstancePoller => p !== undefined)
      : [...pollers.values()];
    if (targets.length === 0) {
      res.status(404).json({error: 'No matching instances'});
      return;
    }

    const timerSec = typeof timer === 'number' ? timer : null;
    const results = await Promise.all(
      targets.map(async p => {
        try {
          await p.client.setBlocking(enabled, timerSec);
          p.lastAction = Date.now();
          const what = enabled
            ? 'enabled'
            : `disabled${timerSec ? ` for ${fmtTimer(timerSec)}` : ' until re-enabled'}`;
          record(
            p.instance,
            enabled ? 'good' : 'warning',
            `Blocking ${what} from ${clientIp(req)}`,
          );
          p.refreshNow({force: true});
          return {id: p.instance.id, ok: true};
        } catch (err) {
          return {id: p.instance.id, ok: false, error: errorText(err)};
        }
      }),
    );

    audit({
      action: 'blocking',
      enabled,
      timer: timerSec,
      ip: clientIp(req),
      results: results.map(r => ({id: r.id, ok: r.ok})),
    });
    broadcast();
    const failed = results.filter(r => !r.ok);
    res.status(failed.length === results.length ? 502 : 200).json({results});
  },
);

app.post('/api/refresh', rateLimit({windowMs: 60_000, max: 6}), (_req, res) => {
  for (const p of pollers.values()) p.refreshNow();
  res.json({ok: true});
});

// --- Dashboard settings (settings page)
const LOCKED_BY_READ_ONLY =
  'The dashboard is in read-only mode (set by READ_ONLY)';

function settingsBlocked(): string | null {
  return config.locked.readOnly && config.readOnly
    ? LOCKED_BY_READ_ONLY
    : storeProblem;
}

const SETTING_KEYS = Object.keys(SETTINGS) as Array<keyof SettingsValues>;

function settingsPayload(req: Request): SettingsResponse {
  return {
    values: {
      allowedHosts: config.allowedHosts,
      trustProxy: config.trustProxy,
      pollIntervalMs: config.pollIntervalMs,
      readOnly: config.readOnly,
      sessionHours: config.auth.sessionHours,
      maxStreams: config.maxStreams,
    },
    autoAllowedHosts: autoHosts.filter(
      h => !isLoopback(h) && !/^[0-9a-f:.]+$/.test(h),
    ),
    locked: Object.fromEntries(
      SETTING_KEYS.filter(k => config.locked[k]).map(k => [
        k,
        config.locked[k],
      ]),
    ),
    password: {
      set: auth.enabled,
      locked: config.locked.password ?? null,
      minLength: MIN_PASSWORD,
    },
    server: {port: config.port, host: config.host, dataDir: config.dataDir},
    currentHost: requestHost(req),
    canEdit: !settingsBlocked(),
    reason: settingsBlocked(),
  };
}

app.get('/api/settings', (req, res) => {
  res.json(settingsPayload(req));
});

app.put('/api/settings', rateLimit({windowMs: 60_000, max: 30}), (req, res) => {
  const why = settingsBlocked();
  if (why) {
    res.status(403).json({error: why});
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  let patch: Partial<SettingsValues>;
  try {
    const lockedKey = SETTING_KEYS.find(k => k in body && config.locked[k]);
    if (lockedKey) {
      throw new ConfigError(
        `${lockedKey} is set by ${config.locked[lockedKey]} and can't be changed here`,
      );
    }
    patch = validateSettings(body);
    if (patch.allowedHosts !== undefined) {
      checkKeepsAccess(req, patch.allowedHosts);
    }
  } catch (err) {
    sendConfigError(res, err);
    return;
  }
  if (Object.keys(patch).length === 0) {
    res.json(settingsPayload(req));
    return;
  }
  const nextSettings = {...savedSettings, ...patch};
  if (!persistSettings(nextSettings, passwordHash)) {
    saveFailed(res);
    return;
  }

  savedSettings = nextSettings;
  applySettings(patch);
  if (patch.trustProxy !== undefined) {
    app.set('trust proxy', config.trustProxy);
  }
  if (patch.sessionHours !== undefined) {
    auth.setSessionHours(config.auth.sessionHours);
  }
  if (patch.pollIntervalMs !== undefined) {
    for (const p of pollers.values()) p.intervalMs = config.pollIntervalMs;
  }
  audit({action: 'settings_update', changed: patch, ip: clientIp(req)});
  broadcast();
  res.json(settingsPayload(req));
});

/** 403 if the password can't be changed from the UI; returns true if it can. */
function canChangePassword(res: Response): boolean {
  if (config.locked.password) {
    res.status(403).json({
      error: `The password is set by ${config.locked.password} and can't be changed here`,
    });
    return false;
  }
  const why = settingsBlocked();
  if (why) {
    res.status(403).json({error: why});
    return false;
  }
  return true;
}

const passwordLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  message: 'Too many attempts, try again later',
});

// Change (or, when running without one, set) the dashboard password: { current, password }
app.post('/api/settings/password', passwordLimit, (req, res) => {
  if (!canChangePassword(res)) return;
  const {current, password} = (req.body ?? {}) as {
    current?: unknown;
    password?: unknown;
  };
  if (auth.enabled && !auth.check(current)) {
    audit({action: 'password_change_failed', ip: clientIp(req)});
    res.status(403).json({error: 'Current password is incorrect'});
    return;
  }
  try {
    checkNewPassword(password);
  } catch (err) {
    sendConfigError(res, err);
    return;
  }

  const hash = hashPassword(password);
  if (!persistSettings(savedSettings, hash)) {
    saveFailed(res);
    return;
  }
  passwordHash = hash;
  auth.setVerifier(hashVerifier(hash));
  // Keep this browser signed in; sign every other session out.
  const keep = req.sessionId ?? auth.startSession(req, res);
  auth.endOtherSessions(keep);
  audit({action: 'password_change', ip: clientIp(req)});
  res.json({ok: true});
});

// Remove the dashboard password (sign-in turns off): { current }
app.post('/api/settings/password/remove', passwordLimit, (req, res) => {
  if (!canChangePassword(res)) return;
  if (!auth.enabled) {
    res.json({ok: true});
    return;
  }
  const {current} = (req.body ?? {}) as {current?: unknown};
  if (!auth.check(current)) {
    audit({action: 'password_remove_failed', ip: clientIp(req)});
    res.status(403).json({error: 'Current password is incorrect'});
    return;
  }
  if (!persistSettings(savedSettings, null)) {
    saveFailed(res);
    return;
  }
  passwordHash = null;
  auth.setVerifier(null);
  auth.endOtherSessions(null);
  audit({action: 'password_remove', ip: clientIp(req)});
  res.json({ok: true});
});

// --- Instance management (settings page)
function publicDef(d: InstanceDef): PublicInstance {
  return {
    id: d.id,
    name: d.name,
    url: d.url,
    insecure: d.insecure,
    timeoutMs: d.timeoutMs,
    source: d.source,
    hasPassword: Boolean(d.password),
  };
}

function requireManage(_req: Request, res: Response, next: () => void): void {
  const why = manageBlocked();
  if (why) {
    res.status(403).json({error: why});
    return;
  }
  next();
}

function originOf(url: string): string | null {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

/** A field of a request body that must be `type` when present. */
function optionalField<T>(
  body: Record<string, unknown>,
  key: string,
  type: 'string' | 'boolean' | 'number',
): T | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== type) throw new ConfigError(`"${key}" must be a ${type}`);
  return v as T;
}

/** Build a candidate instance from a request body, falling back to `existing` for omitted fields. */
function instanceFromBody(
  rawBody: unknown,
  existing?: InstanceDef,
): InstanceInput {
  const body = (rawBody ?? {}) as Record<string, unknown>;
  const name = optionalField<string>(body, 'name', 'string');
  const url = optionalField<string>(body, 'url', 'string');
  const password = optionalField<string>(body, 'password', 'string');
  const insecure = optionalField<boolean>(body, 'insecure', 'boolean');
  const timeoutMs = optionalField<number>(body, 'timeoutMs', 'number');
  if (url !== undefined && url.length > 2048) {
    throw new ConfigError('URL is too long');
  }
  if (password !== undefined && password.length > 512) {
    throw new ConfigError('Password is too long');
  }

  // A saved password is only reused for the same Pi-hole; otherwise changing the URL
  // would send the stored password to an arbitrary server.
  if (
    existing?.password &&
    password === undefined &&
    url !== undefined &&
    new URL(existing.url).origin !== originOf(url)
  ) {
    throw new ConfigError('Re-enter the password when changing the URL');
  }
  return {
    id: existing?.id,
    name: name ?? existing?.name,
    url: url ?? existing?.url,
    insecure: insecure ?? existing?.insecure ?? false,
    timeoutMs: timeoutMs ?? existing?.timeoutMs,
    password: password ?? existing?.password ?? '',
  };
}

function validate(candidate: InstanceInput, exceptId?: string): InstanceDef {
  const takenIds = new Set([...defs.keys()].filter(id => id !== exceptId));
  const inst = normalizeInstance(candidate, {label: 'Instance', takenIds});
  const dupe = [...defs.values()].find(
    d => d.id !== exceptId && d.url === inst.url,
  );
  if (dupe) {
    throw new ConfigError(
      `${inst.url} is already configured as "${dupe.name}"`,
    );
  }
  return {...inst, source: 'ui'};
}

function uiDefs(): InstanceDef[] {
  return [...defs.values()].filter(d => d.source === 'ui');
}

/** Persist the UI-managed instances; returns false (after logging) if the write failed. */
function persist(list: InstanceDef[]): boolean {
  try {
    store.save(list);
    return true;
  } catch (err) {
    console.error(`Could not save ${store.file}:`, errorText(err));
    return false;
  }
}

function uiInstanceOr404(req: Request, res: Response): InstanceDef | null {
  const def = defs.get(req.params.id);
  if (!def) {
    res.status(404).json({error: 'No such instance'});
    return null;
  }
  if (def.source !== 'ui') {
    res.status(403).json({
      error: 'This instance is defined in the config file; change it there',
    });
    return null;
  }
  return def;
}

function auditInstance(action: string, inst: InstanceDef, req: Request): void {
  audit({
    action,
    id: inst.id,
    name: inst.name,
    url: inst.url,
    ip: clientIp(req),
  });
}

const manageLimit = rateLimit({windowMs: 60_000, max: 30});

app.get('/api/instances', (_req, res) => {
  const body: InstancesResponse = {
    instances: [...defs.values()].map(publicDef),
    canManage: !manageBlocked(),
    reason: manageBlocked(),
    maxInstances: MAX_INSTANCES,
  };
  res.json(body);
});

app.post('/api/instances', manageLimit, requireManage, (req, res) => {
  if (defs.size >= MAX_INSTANCES) {
    res
      .status(400)
      .json({error: `At most ${MAX_INSTANCES} instances are supported`});
    return;
  }
  let inst: InstanceDef;
  try {
    inst = validate(instanceFromBody(req.body));
  } catch (err) {
    sendConfigError(res, err);
    return;
  }
  if (!persist([...uiDefs(), inst])) {
    saveFailed(res);
    return;
  }

  defs.set(inst.id, inst);
  startPoller(inst);
  record(inst, 'good', `Added by ${clientIp(req)}`);
  auditInstance('instance_add', inst, req);
  broadcast();
  res.status(201).json({instance: publicDef(inst)});
});

app.put('/api/instances/:id', manageLimit, requireManage, (req, res) => {
  const existing = uiInstanceOr404(req, res);
  if (!existing) return;
  let inst: InstanceDef;
  try {
    inst = validate(instanceFromBody(req.body, existing), existing.id);
  } catch (err) {
    sendConfigError(res, err);
    return;
  }
  if (!persist(uiDefs().map(d => (d.id === inst.id ? inst : d)))) {
    saveFailed(res);
    return;
  }

  defs.set(inst.id, inst);
  startPoller(inst);
  record(inst, 'good', `Settings changed by ${clientIp(req)}`);
  auditInstance('instance_update', inst, req);
  broadcast();
  res.json({instance: publicDef(inst)});
});

app.delete('/api/instances/:id', manageLimit, requireManage, (req, res) => {
  const existing = uiInstanceOr404(req, res);
  if (!existing) return;
  if (!persist(uiDefs().filter(d => d.id !== existing.id))) {
    saveFailed(res);
    return;
  }

  defs.delete(existing.id);
  removePoller(existing.id);
  record(existing, 'warning', `Removed by ${clientIp(req)}`);
  auditInstance('instance_remove', existing, req);
  broadcast();
  res.json({ok: true});
});

// Try a login + version lookup with the given settings, without saving anything.
app.post(
  '/api/instances/test',
  rateLimit({windowMs: 60_000, max: 20}),
  requireManage,
  async (req, res) => {
    const id = (req.body as {id?: unknown} | undefined)?.id;
    const existing = typeof id === 'string' ? defs.get(id) : undefined;
    let inst: InstanceConfig;
    try {
      inst = normalizeInstance(
        instanceFromBody(
          req.body,
          existing?.source === 'ui' ? existing : undefined,
        ),
      );
    } catch (err) {
      sendConfigError(res, err);
      return;
    }

    const client = new PiholeClient(inst);
    let result: TestResult;
    try {
      const v = await client.get<{
        version?: {core?: {local?: {version?: string}}};
      }>('/info/version');
      result = {ok: true, version: v?.version?.core?.local?.version ?? null};
    } catch (err) {
      result = {
        ok: false,
        error: err instanceof PiholeError ? err.message : 'Network error',
      };
    } finally {
      void client.logout();
    }
    res.json(result);
  },
);

app.use('/api', (_req, res) => {
  res.status(404).json({error: 'Not found'});
});

// --- Serve the built frontend in production.
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, {index: false}));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use(errorHandler);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function describeAllowedHosts(): string {
  const hosts = config.allowedHosts;
  if (!hosts) {
    const names = autoHosts.filter(h => !/^[0-9a-f:.]+$/.test(h)).join(', ');
    return `any IP address, ${names}`;
  }
  return hosts.includes('*') ? 'any (host check disabled)' : hosts.join(', ');
}

const server = app.listen(config.port, config.host, () => {
  const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(
    `Pi-hole dashboard on http://${shownHost}:${config.port} (listening on ${config.host})`,
  );
  if (defs.size === 0) {
    console.log(
      'No Pi-hole instances configured yet: add one from Settings in the dashboard.',
    );
  } else {
    console.log(
      `Polling ${defs.size} instance(s) every ${config.pollIntervalMs}ms:`,
    );
    for (const inst of defs.values()) {
      console.log(
        `  • ${inst.name}  ${inst.url}${inst.source === 'ui' ? '  (added in UI)' : ''}`,
      );
    }
  }
  console.log(
    `Instance settings: ${manageBlocked() ?? `editable, saved to ${store.file}`}`,
  );
  console.log(
    `Settings: ${settingsBlocked() ?? `editable, saved to ${settingsStore.file}`}`,
  );
  console.log(`Allowed hosts: ${describeAllowedHosts()}`);
  console.log(
    `Authentication: ${auth.enabled ? 'password required' : 'none (no dashboard password set)'}`,
  );
  if (!auth.enabled && !isLoopback(config.host)) {
    console.warn(
      '\n  Note: no dashboard password is set, so anyone who can reach this server can view DNS',
    );
    console.warn(
      '  activity and change settings. You can set one in Settings > Password.\n',
    );
  }
  if ([...defs.values()].some(i => i.insecure)) {
    console.warn(
      '  Note: TLS certificate verification is disabled for some instances.',
    );
  }
  if (!fs.existsSync(distDir)) {
    console.log(
      '(No dist/ build found — use `npm run dev` for the UI on :5173)',
    );
  }
  started = true;
  for (const p of pollers.values()) p.start();
});

// Log out of every Pi-hole on shutdown so we don't hold API session slots.
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const res of clients.keys()) res.end();
  server.close();
  await Promise.race([
    Promise.all([...pollers.values()].map(p => p.stop())),
    new Promise(r => setTimeout(r, 2000)),
  ]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
