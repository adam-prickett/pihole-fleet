import crypto from 'node:crypto';
import os from 'node:os';
import helmet from 'helmet';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

export const clientIp = (req) => String(req.ip ?? '').replace(/^::ffff:/, '');

export const isLoopback = (host) => LOOPBACK.includes(host) || host.startsWith('127.');

/** Strip port and IPv6 brackets from a Host header value. */
function hostnameOf(hostHeader = '') {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  const colon = h.lastIndexOf(':');
  return colon > -1 && h.indexOf(':') === colon ? h.slice(0, colon) : h;
}

/** Hostname the client used, honouring X-Forwarded-Host only from a trusted proxy. */
function requestHost(req) {
  const trusted = req.app.get('trust proxy fn')?.(req.socket.remoteAddress, 0);
  const forwarded = trusted ? req.get('x-forwarded-host')?.split(',')[0] : undefined;
  return hostnameOf(forwarded || req.get('host'));
}

/** Default allowlist: loopback, this machine's hostname and interface addresses. */
export function defaultAllowedHosts() {
  const names = new Set(LOOPBACK);
  const host = os.hostname().toLowerCase();
  names.add(host);
  names.add(`${host.split('.')[0]}.local`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) names.add(a.address.toLowerCase());
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Host / Origin validation (DNS-rebinding and cross-site request defence)
// ---------------------------------------------------------------------------

export function hostGuard(allowedHosts) {
  const allowAny = allowedHosts.includes('*');
  // Loopback is always allowed so container healthchecks keep working.
  const allowed = new Set([...allowedHosts.map((h) => h.toLowerCase()), ...LOOPBACK]);
  return (req, res, next) => {
    if (allowAny) return next();
    const host = requestHost(req);
    if (allowed.has(host)) return next();
    res.status(421).type('text/plain').send(
      `Host "${host}" is not allowed. Add it to "allowedHosts" in config.json or the ALLOWED_HOSTS environment variable.`,
    );
  };
}

/** Reject state-changing requests that come from another origin. */
export function originGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin) {
    let originHost;
    try { originHost = hostnameOf(new URL(origin).host); } catch { originHost = null; }
    if (originHost !== requestHost(req)) {
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    }
  } else {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') {
      return res.status(403).json({ error: 'Cross-site request rejected' });
    }
  }
  next();
}

/** State-changing JSON endpoints must actually send JSON (blocks form-based CSRF). */
export function requireJson(req, res, next) {
  if (req.method === 'POST' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window, in memory, per key)
// ---------------------------------------------------------------------------

export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many requests, slow down' }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Authentication: single shared password, HttpOnly session cookie
// ---------------------------------------------------------------------------

const COOKIE = 'pfd_sid';

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createAuth({ password, sessionHours = 12, audit }) {
  const enabled = Boolean(password);
  const expected = enabled ? sha256(password) : null;
  const ttl = sessionHours * 3600 * 1000;
  const sessions = new Map(); // sid -> { expires, ip }
  const listeners = new Set(); // called with sid when a session ends

  setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) {
      if (s.expires <= now) endSession(sid);
    }
  }, 60_000).unref();

  function endSession(sid) {
    if (!sessions.delete(sid)) return;
    for (const fn of listeners) fn(sid);
  }

  function sessionOf(req) {
    if (!enabled) return { sid: null };
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    const s = sid && sessions.get(sid);
    if (!s || s.expires <= Date.now()) return null;
    s.expires = Date.now() + ttl; // sliding expiry
    return { sid };
  }

  function cookie(req, value, maxAgeSec) {
    const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
    if (req.secure) parts.push('Secure');
    return parts.join('; ');
  }

  return {
    enabled,
    onSessionEnd: (fn) => listeners.add(fn),
    isValid: (sid) => !enabled || sessions.has(sid),

    /** Middleware: 401 unless the request carries a valid session. */
    require(req, res, next) {
      const s = sessionOf(req);
      if (!s) return res.status(401).json({ error: 'Authentication required' });
      req.sessionId = s.sid;
      next();
    },

    status(req, res) {
      res.json({ authRequired: enabled, authenticated: Boolean(sessionOf(req)) });
    },

    login(req, res) {
      if (!enabled) return res.json({ ok: true });
      const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
      const ok = crypto.timingSafeEqual(sha256(supplied), expected);
      if (!ok) {
        audit({ action: 'login_failed', ip: clientIp(req) });
        return res.status(401).json({ error: 'Incorrect password' });
      }
      const sid = crypto.randomBytes(32).toString('base64url');
      sessions.set(sid, { expires: Date.now() + ttl, ip: req.ip });
      audit({ action: 'login', ip: clientIp(req) });
      res.set('Set-Cookie', cookie(req, sid, Math.floor(ttl / 1000)));
      res.json({ ok: true });
    },

    logout(req, res) {
      const sid = parseCookies(req.headers.cookie)[COOKIE];
      if (sid && sessions.has(sid)) {
        endSession(sid);
        audit({ action: 'logout', ip: clientIp(req) });
      }
      res.set('Set-Cookie', cookie(req, '', 0));
      res.json({ ok: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // React/Recharts set inline style attributes; no inline <script> is allowed.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // Served over plain HTTP on most LANs; leave HSTS to a TLS-terminating proxy.
    strictTransportSecurity: false,
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
  });
}

// ---------------------------------------------------------------------------
// Errors: never leak stack traces or internals to clients
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) console.error(`[error] ${req.method} ${req.path}:`, err);
  if (res.headersSent) return res.end();
  res.status(status).json({
    error: status >= 500 ? 'Internal server error'
      : err.type === 'entity.parse.failed' ? 'Malformed JSON body'
      : err.type === 'entity.too.large' ? 'Request body too large'
      : 'Bad request',
  });
}
