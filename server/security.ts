import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import type {
  ErrorRequestHandler,
  Request,
  RequestHandler,
  Response,
} from 'express';
import helmet from 'helmet';
import type {PasswordVerifier} from './settings.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** The session of a signed-in request (null when no password is set). */
    sessionId?: string | null;
  }
}

export type AuditFn = (entry: Record<string, unknown>) => void;

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

function sha256(s: unknown): Buffer {
  return crypto.createHash('sha256').update(String(s)).digest();
}

export function clientIp(req: Request): string {
  return String(req.ip ?? '').replace(/^::ffff:/, '');
}

export function isLoopback(host: string): boolean {
  return LOOPBACK.includes(host) || host.startsWith('127.');
}

/** Strip port and IPv6 brackets from a Host header value. */
function hostnameOf(hostHeader = ''): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  const colon = h.lastIndexOf(':');
  return colon > -1 && h.indexOf(':') === colon ? h.slice(0, colon) : h;
}

/** Hostname the client used, honouring X-Forwarded-Host only from a trusted proxy. */
export function requestHost(req: Request): string {
  const trustFn = req.app.get('trust proxy fn') as
    ((addr: string | undefined, i: number) => boolean) | undefined;
  const trusted = trustFn?.(req.socket.remoteAddress, 0);
  const forwarded = trusted
    ? req.get('x-forwarded-host')?.split(',')[0]
    : undefined;
  return hostnameOf(forwarded || req.get('host'));
}

/** This machine's names and addresses (plus loopback). */
export function defaultAllowedHosts(): string[] {
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

/**
 * Build a predicate for allowed hostnames. `list` entries are hostnames, IP addresses or
 * subnets in CIDR form (e.g. 10.1.68.0/24); "*" allows everything. With no list (null or
 * empty), the default applies: any IP address plus this machine's own names. That still
 * blocks DNS rebinding, which always arrives under an attacker-controlled domain name.
 * Loopback names are always allowed so container healthchecks keep working.
 */
export function hostMatcher(
  list: string[] | null | undefined,
  autoNames: string[] = defaultAllowedHosts(),
): (host: string) => boolean {
  if (list?.includes('*')) return () => true;
  const names = new Set(LOOPBACK);
  const subnets = new net.BlockList();
  const useDefault = !list || list.length === 0;
  for (const entry of useDefault ? autoNames : list) {
    const [addr, bits] = entry.toLowerCase().split('/');
    const family = net.isIP(addr);
    if (bits !== undefined && family) {
      subnets.addSubnet(addr, Number(bits), family === 6 ? 'ipv6' : 'ipv4');
    } else {
      names.add(addr);
    }
  }
  return host => {
    if (names.has(host)) return true;
    const family = net.isIP(host);
    if (!family) return false;
    return useDefault || subnets.check(host, family === 6 ? 'ipv6' : 'ipv4');
  };
}

type HostList = string[] | null | undefined;

/**
 * Reject requests for hostnames that aren't allowed. `allowed` is a host list (see
 * hostMatcher) or a function returning the current one, so it can change at runtime.
 */
export function hostGuard(
  allowed: HostList | (() => HostList),
): RequestHandler {
  const current = typeof allowed === 'function' ? allowed : () => allowed;
  let lastList: HostList;
  let matches: ((host: string) => boolean) | null = null;
  return (req, res, next) => {
    const list = current();
    if (matches === null || list !== lastList) {
      lastList = list;
      matches = hostMatcher(list);
    }
    const host = requestHost(req);
    if (matches(host)) return next();
    res
      .status(421)
      .type('text/plain')
      .send(
        `Host "${host}" is not allowed. Open the dashboard by IP address and add it under ` +
          'Settings > Dashboard > Allowed hosts, or set the ALLOWED_HOSTS environment variable.',
      );
  };
}

/** Reject state-changing requests that come from another origin. */
export const originGuard: RequestHandler = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let originHost: string | null;
    try {
      originHost = hostnameOf(new URL(origin).host);
    } catch {
      originHost = null;
    }
    if (originHost !== requestHost(req)) {
      res.status(403).json({error: 'Cross-origin request rejected'});
      return;
    }
  } else {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') {
      res.status(403).json({error: 'Cross-site request rejected'});
      return;
    }
  }
  next();
};

/** State-changing JSON endpoints must actually send JSON (blocks form-based CSRF). */
export const requireJson: RequestHandler = (req, res, next) => {
  if (
    ['POST', 'PUT', 'PATCH'].includes(req.method) &&
    !req.is('application/json')
  ) {
    res.status(415).json({error: 'Content-Type must be application/json'});
    return;
  }
  next();
};

// ---------------------------------------------------------------------------
// Rate limiting (fixed window, in memory, per key)
// ---------------------------------------------------------------------------

export function rateLimit({
  windowMs,
  max,
  key = req => req.ip ?? '',
  message = 'Too many requests, slow down',
}: {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
  message?: string;
}): RequestHandler {
  const hits = new Map<string, {count: number; reset: number}>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) {
      entry = {count: 0, reset: now + windowMs};
      hits.set(k, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      res.status(429).json({error: message});
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Authentication: optional shared password, HttpOnly session cookie
// ---------------------------------------------------------------------------

const COOKIE = 'pfd_sid';

function parseCookies(header = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      out[part.slice(0, i).trim()] = decodeURIComponent(
        part.slice(i + 1).trim(),
      );
    }
  }
  return out;
}

/** Verifier for a plaintext password (from the environment or config file). */
export function plaintextVerifier(password: string): PasswordVerifier {
  const expected = sha256(password);
  return supplied => crypto.timingSafeEqual(sha256(supplied), expected);
}

export interface Auth {
  readonly enabled: boolean;
  onSessionEnd(fn: (sid: string) => void): void;
  isValid(sid: string | null | undefined): boolean;
  /** True if `supplied` matches the password (or no password is set). */
  check(supplied: unknown): boolean;
  setVerifier(fn: PasswordVerifier | null): void;
  setSessionHours(hours: number): void;
  /** End every session except `keepSid` (after a password change). */
  endOtherSessions(keepSid: string | null): void;
  /** Create a session for this request and set its cookie; returns the session id. */
  startSession(req: Request, res: Response): string;
  /** Middleware: 401 unless the request carries a valid session. */
  require: RequestHandler;
  status: RequestHandler;
  login: RequestHandler;
  logout: RequestHandler;
}

/**
 * Session auth. The password is optional: with none set, every request is allowed. The
 * password verifier and session length can change at runtime.
 */
export function createAuth({
  password,
  sessionHours = 12,
  audit,
}: {
  password: string;
  sessionHours?: number;
  audit: AuditFn;
}): Auth {
  let verify: PasswordVerifier | null = password
    ? plaintextVerifier(password)
    : null;
  let ttl = sessionHours * 3600 * 1000;
  const sessions = new Map<string, {expires: number; ip?: string}>();
  const listeners = new Set<(sid: string) => void>();

  setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) {
      if (s.expires <= now) endSession(sid);
    }
  }, 60_000).unref();

  function endSession(sid: string) {
    if (!sessions.delete(sid)) return;
    for (const fn of listeners) fn(sid);
  }

  function sessionOf(req: Request): {sid: string | null} | null {
    if (!verify) return {sid: null};
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    const s = sid ? sessions.get(sid) : undefined;
    if (!s || s.expires <= Date.now()) return null;
    s.expires = Date.now() + ttl; // sliding expiry
    return {sid};
  }

  function cookie(req: Request, value: string, maxAgeSec: number): string {
    const parts = [
      `${COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAgeSec}`,
    ];
    if (req.secure) parts.push('Secure');
    return parts.join('; ');
  }

  function startSession(req: Request, res: Response): string {
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, {expires: Date.now() + ttl, ip: req.ip});
    res.set('Set-Cookie', cookie(req, sid, Math.floor(ttl / 1000)));
    return sid;
  }

  return {
    get enabled() {
      return Boolean(verify);
    },
    onSessionEnd: fn => {
      listeners.add(fn);
    },
    isValid: sid => !verify || (sid != null && sessions.has(sid)),
    check: supplied =>
      verify ? verify(typeof supplied === 'string' ? supplied : '') : true,
    setVerifier(fn) {
      verify = fn;
    },
    setSessionHours(hours) {
      ttl = hours * 3600 * 1000;
    },
    endOtherSessions(keepSid) {
      for (const sid of [...sessions.keys()]) {
        if (sid !== keepSid) endSession(sid);
      }
    },
    startSession,

    require(req, res, next) {
      const s = sessionOf(req);
      if (!s) {
        res.status(401).json({error: 'Authentication required'});
        return;
      }
      req.sessionId = s.sid;
      next();
    },

    status(req, res) {
      res.json({
        authRequired: Boolean(verify),
        authenticated: Boolean(sessionOf(req)),
      });
    },

    login(req, res) {
      if (!verify) {
        res.json({ok: true});
        return;
      }
      const body = req.body as {password?: unknown} | undefined;
      const supplied = typeof body?.password === 'string' ? body.password : '';
      if (!verify(supplied)) {
        audit({action: 'login_failed', ip: clientIp(req)});
        res.status(401).json({error: 'Incorrect password'});
        return;
      }
      startSession(req, res);
      audit({action: 'login', ip: clientIp(req)});
      res.json({ok: true});
    },

    logout(req, res) {
      const sid = parseCookies(req.headers.cookie)[COOKIE];
      if (sid && sessions.has(sid)) {
        endSession(sid);
        audit({action: 'logout', ip: clientIp(req)});
      }
      res.set('Set-Cookie', cookie(req, '', 0));
      res.json({ok: true});
    },
  };
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

export function securityHeaders(): RequestHandler {
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
    referrerPolicy: {policy: 'no-referrer'},
    frameguard: {action: 'deny'},
  });
}

// ---------------------------------------------------------------------------
// Errors: never leak stack traces or internals to clients
// ---------------------------------------------------------------------------

interface HttpError {
  status?: number;
  statusCode?: number;
  type?: string;
}

function clientMessage(status: number, type: string | undefined): string {
  if (status >= 500) return 'Internal server error';
  if (type === 'entity.parse.failed') return 'Malformed JSON body';
  if (type === 'entity.too.large') return 'Request body too large';
  return 'Bad request';
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const e = (err ?? {}) as HttpError;
  const status = e.status ?? e.statusCode ?? 500;
  if (status >= 500) console.error(`[error] ${req.method} ${req.path}:`, err);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({error: clientMessage(status, e.type)});
};
