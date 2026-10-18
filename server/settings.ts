import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {ConfigError} from './config.js';
import {writePrivateJson} from './store.js';
import type {SettingsValues, TrustProxy} from './types.js';

/**
 * Dashboard settings that can be changed from the settings page, with the environment
 * variable that overrides (and locks) each one.
 */
export const SETTINGS: Record<keyof SettingsValues, string> = {
  allowedHosts: 'ALLOWED_HOSTS',
  trustProxy: 'TRUST_PROXY',
  pollIntervalMs: 'POLL_INTERVAL_MS',
  readOnly: 'READ_ONLY',
  sessionHours: 'SESSION_HOURS',
  maxStreams: 'MAX_STREAMS',
};
export const MIN_PASSWORD = 12;

type NumericSetting = 'pollIntervalMs' | 'sessionHours' | 'maxStreams';

const RANGES: Record<NumericSetting, [number, number, string]> = {
  pollIntervalMs: [
    1000,
    300_000,
    'Poll interval must be between 1 and 300 seconds',
  ],
  sessionHours: [
    0.25,
    720,
    'Session timeout must be between 15 minutes and 30 days',
  ],
  maxStreams: [1, 1000, 'Live connection limit must be between 1 and 1000'],
};
const HOST_RE =
  /^(\*|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?|[0-9a-f:.]+)$/;
const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isSetting(key: string): key is keyof SettingsValues {
  return key in SETTINGS;
}

/** True for "addr/bits" where addr is an IP and bits fits its family. */
function isSubnet(entry: string): boolean {
  const [addr, bits, extra] = entry.split('/');
  const family = net.isIP(addr);
  return (
    family !== 0 &&
    extra === undefined &&
    bits !== undefined &&
    /^\d+$/.test(bits) &&
    Number(bits) <= (family === 6 ? 128 : 32)
  );
}

/** Hostnames, IPs and CIDR subnets. Empty = not set (null): the default host check applies. */
function parseHosts(value: unknown): string[] | null {
  if (value === null) return null;
  const list = (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map(h =>
      String(h)
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, ''),
    )
    .filter(Boolean);
  if (list.length === 0) return null;
  if (list.length > 50) {
    throw new ConfigError('Allowed hosts can list at most 50 entries');
  }
  for (const h of list) {
    if (h.includes('/')) {
      if (!isSubnet(h)) {
        throw new ConfigError(
          `"${h}" is not a valid subnet (use CIDR form, e.g. 10.1.68.0/24)`,
        );
      }
    } else if (h.length > 253 || !HOST_RE.test(h)) {
      throw new ConfigError(
        `"${h}" is not a valid hostname, IP address or subnet`,
      );
    }
  }
  return [...new Set(list)];
}

/** Express "trust proxy": false, true, a hop count, or IPs/subnets/keywords. */
function parseTrustProxy(value: unknown): TrustProxy {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 10) {
      throw new ConfigError('Proxy hop count must be 0–10');
    }
    return value;
  }
  const s = String(value ?? '').trim();
  if (s === '' || s === 'false') return false;
  if (s === 'true') return true;
  if (/^\d+$/.test(s)) return parseTrustProxy(Number(s));
  const parts = s
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (!(PROXY_KEYWORDS.has(p) || net.isIP(p) || isSubnet(p))) {
      throw new ConfigError(
        `"${p}" is not an IP address, subnet or proxy keyword`,
      );
    }
  }
  return parts.join(', ');
}

/** Validate a partial settings object (from the UI or the saved file). Throws ConfigError. */
export function validateSettings(input: unknown): Partial<SettingsValues> {
  const out: Partial<SettingsValues> = {};
  const entries = Object.entries((input ?? {}) as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (!isSetting(key) || value === undefined) continue;
    if (value === null && key !== 'allowedHosts') continue;
    if (key === 'allowedHosts') {
      out.allowedHosts = parseHosts(value);
    } else if (key === 'trustProxy') {
      out.trustProxy = parseTrustProxy(value);
    } else if (key === 'readOnly') {
      if (typeof value !== 'boolean') {
        throw new ConfigError('Read-only must be true or false');
      }
      out.readOnly = value;
    } else {
      const [min, max, message] = RANGES[key];
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < min ||
        value > max
      ) {
        throw new ConfigError(message);
      }
      out[key] = key === 'sessionHours' ? value : Math.round(value);
    }
  }
  return out;
}

// --- Password hashing (scrypt, salted) for passwords set from the UI.
const SCRYPT = {N: 16384, r: 8, p: 1, keylen: 32};

export interface PasswordHash {
  algo: 'scrypt';
  N: number;
  r: number;
  p: number;
  keylen: number;
  salt: string;
  hash: string;
}

export type PasswordVerifier = (supplied: string) => boolean;

export function hashPassword(password: string): PasswordHash {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return {
    algo: 'scrypt',
    ...SCRYPT,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  };
}

/** Returns a verifier function for a stored hash record. */
export function hashVerifier(record: PasswordHash): PasswordVerifier {
  const salt = Buffer.from(record.salt, 'base64');
  const expected = Buffer.from(record.hash, 'base64');
  const {N, r, p} = record;
  return supplied => {
    const got = crypto.scryptSync(String(supplied), salt, expected.length, {
      N,
      r,
      p,
    });
    return crypto.timingSafeEqual(got, expected);
  };
}

/** Throws ConfigError unless `password` is an acceptable new password. */
export function checkNewPassword(
  password: unknown,
): asserts password is string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new ConfigError(
      `The password must be at least ${MIN_PASSWORD} characters`,
    );
  }
  if (password.length > 256) {
    throw new ConfigError('The password must be 256 characters or fewer');
  }
}

export interface SavedSettings {
  settings: Partial<SettingsValues>;
  passwordHash: PasswordHash | null;
}

function isPasswordHash(h: unknown): h is PasswordHash {
  const x = h as Partial<PasswordHash> | null;
  return Boolean(
    x &&
    x.algo === 'scrypt' &&
    typeof x.salt === 'string' &&
    typeof x.hash === 'string',
  );
}

/** settings.json in the data directory: saved settings plus the dashboard password hash. */
export class SettingsStore {
  readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, 'settings.json');
  }

  load(): SavedSettings {
    let raw: {settings?: Record<string, unknown>; passwordHash?: unknown};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as typeof raw;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        console.error(
          `  Could not read ${this.file}: ${err.message}. Using defaults.`,
        );
      }
      return {settings: {}, passwordHash: null};
    }
    const settings: Partial<SettingsValues> = {};
    for (const [key, value] of Object.entries(raw.settings ?? {})) {
      try {
        Object.assign(settings, validateSettings({[key]: value}));
      } catch (err) {
        console.warn(
          `  Ignoring saved setting "${key}": ${(err as Error).message}`,
        );
      }
    }
    const h = raw.passwordHash;
    return {settings, passwordHash: isPasswordHash(h) ? h : null};
  }

  save({settings, passwordHash}: SavedSettings): void {
    writePrivateJson(this.file, {version: 1, settings, passwordHash});
  }
}
