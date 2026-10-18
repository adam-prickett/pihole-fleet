import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { InstancePoller } from './poller.js';
import {
  clientIp, createAuth, defaultAllowedHosts, errorHandler, hostGuard, isLoopback,
  originGuard, rateLimit, requireJson, securityHeaders,
} from './security.js';

const config = loadConfig();

// Structured audit trail on stdout (picked up by `docker logs` / journald).
function audit(entry) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), type: 'audit', ...entry }));
}

const auth = createAuth({ ...config.auth, audit });
const allowedHosts = config.allowedHosts ?? defaultAllowedHosts();

const pollers = new Map(
  config.instances.map((inst) => [inst.id, new InstancePoller(inst, config.pollIntervalMs)]),
);

// --- Event feed: status transitions and blocking changes, newest first.
const MAX_EVENTS = 100;
const ACTION_DEDUPE_MS = 15_000;
const events = [];
let eventSeq = 0;
function record(instance, severity, message) {
  events.unshift({ id: ++eventSeq, t: Date.now(), instanceId: instance.id, severity, message });
  events.length = Math.min(events.length, MAX_EVENTS);
}

const fmtTimer = (s) => (s >= 3600 ? `${Math.round(s / 3600)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${Math.round(s)}s`);

for (const p of pollers.values()) {
  let prevStatus = null;
  let prevBlocking = null;
  p.on('update', (s) => {
    if (s.status !== prevStatus) {
      if (s.status === 'online') {
        record(p.instance, 'good', prevStatus === null || prevStatus === 'connecting' ? 'Connected' : 'Recovered — instance reachable again');
      } else if (s.status === 'offline') {
        record(p.instance, 'critical', `Unreachable: ${s.error}`);
      } else if (s.status === 'auth_error') {
        record(p.instance, 'serious', s.error);
      }
      prevStatus = s.status;
    }
    const blocking = s.status === 'online' ? s.blocking?.state : null;
    if (blocking && blocking !== prevBlocking) {
      // Changes made through this dashboard are already recorded with their source;
      // anything else was changed outside the dashboard (Pi-hole UI, timer expiry, CLI).
      const viaDashboard = p.lastAction && Date.now() - p.lastAction < ACTION_DEDUPE_MS;
      if (!viaDashboard && (prevBlocking !== null || blocking !== 'enabled')) {
        record(
          p.instance,
          blocking === 'enabled' ? 'good' : 'warning',
          blocking === 'enabled' ? 'Blocking enabled (outside dashboard or timer expired)'
            : `Blocking disabled outside dashboard${s.blocking.timer ? ` for ${fmtTimer(s.blocking.timer)}` : ''}`,
        );
      }
      prevBlocking = blocking;
    }
  });
}

function snapshot() {
  return {
    generatedAt: Date.now(),
    readOnly: config.readOnly,
    authEnabled: auth.enabled,
    pollIntervalMs: config.pollIntervalMs,
    instances: [...pollers.values()].map((p) => p.state),
    events: events.slice(0, 50),
  };
}

// ---------------------------------------------------------------------------
// HTTP app
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use(hostGuard(allowedHosts));
app.use(securityHeaders());
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api', rateLimit({ windowMs: 60_000, max: 600 }));
app.use('/api', originGuard, requireJson);
app.use(express.json({ limit: '10kb' }));

// --- Public endpoints
// Liveness of the dashboard itself (not the Pi-holes), for container healthchecks.
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/session', auth.status);
app.post(
  '/api/login',
  rateLimit({ windowMs: 15 * 60_000, max: 10, message: 'Too many login attempts, try again later' }),
  auth.login,
);
app.post('/api/logout', auth.logout);

// --- Everything below requires a session (when a password is configured)
app.use('/api', auth.require);

// Server-Sent Events: push a fresh snapshot whenever any instance updates.
const MAX_STREAMS_PER_IP = 10;
const clients = new Set();
let pending = null;
function broadcast() {
  // Coalesce bursts (several instances finishing at once) into one push.
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) res.write(payload);
  }, 150);
}
for (const p of pollers.values()) p.on('update', broadcast);

// Close live streams belonging to a session that logged out or expired.
auth.onSessionEnd((sid) => {
  for (const res of clients) if (res.locals.sid === sid) res.end();
});

app.get('/api/stream', (req, res) => {
  const fromIp = [...clients].filter((c) => c.locals.ip === req.ip).length;
  if (clients.size >= config.maxStreams || fromIp >= MAX_STREAMS_PER_IP) {
    return res.status(503).json({ error: 'Too many open live connections' });
  }
  res.locals.sid = req.sessionId;
  res.locals.ip = req.ip;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`retry: 3000\ndata: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  const keepAlive = setInterval(() => {
    if (!auth.isValid(req.sessionId)) return res.end();
    res.write(': ping\n\n');
  }, 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

app.get('/api/state', (_req, res) => res.json(snapshot()));

// Blocking control: { instances: ["id", ...] | "all", enabled: bool, timer?: seconds }
const MAX_TIMER_SECONDS = 7 * 86400;
app.post('/api/blocking', rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
  if (config.readOnly) return res.status(403).json({ error: 'Dashboard is in read-only mode' });

  const { instances = 'all', enabled, timer = null } = req.body ?? {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: '"enabled" must be a boolean' });
  if (timer !== null && !(Number.isFinite(timer) && timer > 0 && timer <= MAX_TIMER_SECONDS)) {
    return res.status(400).json({ error: '"timer" must be between 1 second and 7 days, or null' });
  }
  if (instances !== 'all' && !(Array.isArray(instances) && instances.every((id) => typeof id === 'string'))) {
    return res.status(400).json({ error: '"instances" must be "all" or an array of instance ids' });
  }

  const targets = instances === 'all'
    ? [...pollers.values()]
    : [...new Set(instances)].map((id) => pollers.get(id)).filter(Boolean);
  if (targets.length === 0) return res.status(404).json({ error: 'No matching instances' });

  const results = await Promise.all(targets.map(async (p) => {
    try {
      await p.client.setBlocking(enabled, timer);
      p.lastAction = Date.now();
      record(
        p.instance,
        enabled ? 'good' : 'warning',
        `Blocking ${enabled ? 'enabled' : `disabled${timer ? ` for ${fmtTimer(timer)}` : ' until re-enabled'}`} from ${clientIp(req)}`,
      );
      p.refreshNow({ force: true });
      return { id: p.instance.id, ok: true };
    } catch (err) {
      return { id: p.instance.id, ok: false, error: err.message };
    }
  }));

  audit({
    action: 'blocking',
    enabled,
    timer,
    ip: clientIp(req),
    results: results.map((r) => ({ id: r.id, ok: r.ok })),
  });
  broadcast();
  const failed = results.filter((r) => !r.ok);
  res.status(failed.length === results.length ? 502 : 200).json({ results });
});

app.post('/api/refresh', rateLimit({ windowMs: 60_000, max: 6 }), (_req, res) => {
  for (const p of pollers.values()) p.refreshNow();
  res.json({ ok: true });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// --- Serve the built frontend in production.
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false }));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use(errorHandler);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = app.listen(config.port, config.host, () => {
  const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`Pi-hole dashboard on http://${shownHost}:${config.port} (listening on ${config.host})`);
  console.log(`Polling ${pollers.size} instance(s) every ${config.pollIntervalMs}ms:`);
  for (const inst of config.instances) console.log(`  • ${inst.name}  ${inst.url}`);
  console.log(`Allowed hosts: ${allowedHosts.includes('*') ? 'any (host check disabled)' : allowedHosts.join(', ')}`);
  console.log(`Authentication: ${auth.enabled ? 'password required' : 'DISABLED'}`);
  if (!auth.enabled && !isLoopback(config.host)) {
    console.warn('\n  WARNING: no dashboard password is set and the server is reachable from the network.');
    console.warn('  Anyone who can reach it can read DNS query logs and disable blocking.');
    console.warn('  Set DASHBOARD_PASSWORD (or "auth.password"), or only expose it behind an authenticating proxy.\n');
  }
  if (config.instances.some((i) => i.insecure)) {
    console.warn('  Note: TLS certificate verification is disabled for some instances ("insecure": true).');
  }
  if (!fs.existsSync(dist)) console.log('(No dist/ build found — use `npm run dev` for the UI on :5173)');
  for (const p of pollers.values()) p.start();
});

// Log out of every Pi-hole on shutdown so we don't hold API session slots.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const res of clients) res.end();
  server.close();
  await Promise.race([
    Promise.all([...pollers.values()].map((p) => p.stop())),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
