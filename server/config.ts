import fs from 'node:fs';
import path from 'node:path';
import type {
  InstanceConfig,
  InstanceDef,
  SettingsValues,
  TrustProxy,
} from './types.js';

const DEFAULTS = {
  port: 3030,
  pollIntervalMs: 5000,
  readOnly: false,
  trustProxy: false as TrustProxy,
  maxStreams: 50,
  sessionHours: 12,
};

/** Settings that the environment or a config file can fix (lock) in place. */
export type LockableSetting = keyof SettingsValues | 'password';

export interface Config {
  port: number;
  pollIntervalMs: number;
  readOnly: boolean;
  maxStreams: number;
  trustProxy: TrustProxy;
  /** null = not set: the default host check applies. */
  allowedHosts: string[] | null;
  auth: {password: string; sessionHours: number};
  /** HOST, if given; otherwise the listen address is chosen at startup. */
  hostExplicit: string | null;
  /** The address actually listened on (set at startup). */
  host: string;
  resetPassword: boolean;
  /** Setting -> what fixes it: an environment variable name or "config file". */
  locked: Partial<Record<LockableSetting, string>>;
  dataDir: string;
  instances: InstanceDef[];
}

/** The optional JSON config file. */
interface ConfigFile {
  port?: number;
  pollIntervalMs?: number;
  readOnly?: boolean;
  maxStreams?: number;
  trustProxy?: TrustProxy;
  allowedHosts?: string[];
  auth?: {password?: string; sessionHours?: number};
  host?: string;
  dataDir?: string;
  instances?: unknown;
}

/** Instance settings as supplied (config file, saved file or request body). */
export interface InstanceInput {
  id?: unknown;
  name?: unknown;
  url?: unknown;
  password?: unknown;
  insecure?: unknown;
  timeoutMs?: unknown;
}

/** Invalid settings; shown to whoever supplied them (startup log or settings UI). */
export class ConfigError extends Error {}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(`\n  Config error: ${message}\n`);
  process.exit(1);
}

/** An env var, or the contents of the file named by NAME_FILE (Docker/Portainer secrets). Empty = unset. */
function env(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      fail(`${name}_FILE points to a file that can't be read: ${file}`);
    }
  }
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function envBool(name: string): boolean | undefined {
  const v = env(name)?.toLowerCase();
  if (v === undefined) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fail(`${name} must be true or false (got "${v}")`);
}

function envNumber(name: string, {min = 0} = {}): number | undefined {
  const v = env(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) {
    fail(`${name} must be a number of at least ${min} (got "${v}")`);
  }
  return n;
}

/**
 * Values like "env:PIHOLE_PASSWORD" are resolved from the environment so secrets don't
 * have to live in the config file.
 */
function resolveSecret(value: unknown): string {
  if (typeof value === 'string' && value.startsWith('env:')) {
    return env(value.slice(4)) ?? '';
  }
  return value == null ? '' : String(value);
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'instance'
  );
}

function parseInstanceUrl(raw: unknown, label: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new ConfigError(`${label} has an invalid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(
      `${label} URL must use http:// or https:// (got ${url.protocol})`,
    );
  }
  if (url.username || url.password) {
    // The URL is shown in the UI, so embedded credentials would leak to every viewer.
    throw new ConfigError(
      `${label} URL must not contain credentials; use the password field`,
    );
  }
  return url;
}

export const TIMEOUT_RANGE = {min: 1000, max: 60_000, default: 8000};

/**
 * Validate and normalise one instance definition. `takenIds` is the set of ids already in
 * use; a fresh unique id is derived from the name unless `inst.id` is given (and free).
 * Throws ConfigError.
 */
export function normalizeInstance(
  inst: InstanceInput | null | undefined,
  {
    label = 'instance',
    takenIds = new Set<string>(),
    resolveEnv = false,
  }: {label?: string; takenIds?: Set<string>; resolveEnv?: boolean} = {},
): InstanceConfig {
  if (!inst || typeof inst !== 'object') {
    throw new ConfigError(`${label} must be an object`);
  }
  if (!inst.url) throw new ConfigError(`${label} is missing a URL`);
  const url = parseInstanceUrl(inst.url, label);

  const name = String(inst.name ?? '').trim() || url.hostname;
  if (name.length > 64) {
    throw new ConfigError(`${label} name must be 64 characters or fewer`);
  }

  const timeoutMs = inst.timeoutMs ?? TIMEOUT_RANGE.default;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < TIMEOUT_RANGE.min ||
    timeoutMs > TIMEOUT_RANGE.max
  ) {
    throw new ConfigError(
      `${label} timeout must be between ${TIMEOUT_RANGE.min} and ${TIMEOUT_RANGE.max} ms`,
    );
  }

  const requestedId = typeof inst.id === 'string' ? inst.id : '';
  let id =
    requestedId && !takenIds.has(requestedId) ? requestedId : slugify(name);
  for (let n = 2; takenIds.has(id); n++) id = `${slugify(name)}-${n}`;

  return {
    id,
    name,
    url: `${url.origin}${url.pathname}`
      .replace(/\/+$/, '')
      .replace(/\/admin$/, ''),
    // "env:NAME" is only honoured for operator-supplied config, never for UI input,
    // which could otherwise send any environment secret to a URL of the user's choosing.
    password: resolveEnv
      ? resolveSecret(inst.password)
      : String(inst.password ?? ''),
    insecure: Boolean(inst.insecure),
    timeoutMs,
  };
}

function parseTrustProxy(v: string | undefined): TrustProxy | undefined {
  if (v === undefined || v === '') return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return /^\d+$/.test(v) ? Number(v) : v; // hop count, or subnet/IP list for Express
}

function readConfigFile(): ConfigFile {
  // A config file is optional. An explicitly named file (--config / CONFIG) must
  // exist; the default config.json may not.
  const explicit = argValue('--config') ?? env('CONFIG');
  const file = path.resolve(explicit ?? 'config.json');
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as ConfigFile;
    } catch (err) {
      fail(`${file} is not valid JSON (${(err as Error).message})`);
    }
  }
  if (explicit) fail(`config file not found: ${file}`);
  return {};
}

export function loadConfig(): Config {
  const raw = readConfigFile();

  // Environment variables override the file. Anything set either way is "locked": the settings
  // page shows it but can't change it. Everything else can be changed (and saved) from the UI.
  const locked: Config['locked'] = {};
  function pick<T>(
    field: LockableSetting,
    envName: string,
    envValue: T | undefined,
    fileValue: T | undefined,
  ): T | undefined {
    if (envValue !== undefined) {
      locked[field] = envName;
      return envValue;
    }
    if (fileValue !== undefined && fileValue !== null) {
      locked[field] = 'config file';
      return fileValue;
    }
    return undefined;
  }

  // --- Dashboard authentication (a password set from the UI is loaded later, from the data dir)
  const auth = raw.auth ?? {};
  const filePassword =
    auth.password !== undefined
      ? resolveSecret(auth.password) || undefined
      : undefined;
  const password =
    pick(
      'password',
      'DASHBOARD_PASSWORD',
      env('DASHBOARD_PASSWORD'),
      filePassword,
    ) ?? '';
  if (password && password.length < 12) {
    console.warn(
      '  Warning: the dashboard password is shorter than 12 characters.',
    );
  }

  const envHosts = env('ALLOWED_HOSTS')
    ?.split(',')
    .map(h => h.trim())
    .filter(Boolean);

  // Instances are managed in the settings UI (or a config file); the old env vars are ignored.
  const legacy = Object.keys(process.env).filter(
    k => /^PIHOLE_(\d+_URL|INSTANCES)$/.test(k) && process.env[k],
  );
  if (legacy.length) {
    console.warn(
      `  Warning: ${legacy.join(', ')} ${legacy.length > 1 ? 'are' : 'is'} no longer supported and will be ignored.`,
    );
    console.warn(
      '  Add Pi-holes from the dashboard instead (gear icon -> Add instance).',
    );
  }

  if (raw.instances !== undefined && !Array.isArray(raw.instances)) {
    fail('"instances" must be an array');
  }

  // Instances from a config file are fixed; the UI shows them as read-only.
  const taken = new Set<string>();
  const instances = ((raw.instances as InstanceInput[] | undefined) ?? []).map(
    (inst, i): InstanceDef => {
      try {
        const out = normalizeInstance(inst, {
          label: `instance #${i + 1}`,
          takenIds: taken,
          resolveEnv: true,
        });
        taken.add(out.id);
        return {...out, source: 'config'};
      } catch (err) {
        if (err instanceof ConfigError) fail(err.message);
        throw err;
      }
    },
  );

  return {
    port: envNumber('PORT', {min: 1}) ?? raw.port ?? DEFAULTS.port,
    pollIntervalMs:
      pick(
        'pollIntervalMs',
        'POLL_INTERVAL_MS',
        envNumber('POLL_INTERVAL_MS', {min: 1000}),
        raw.pollIntervalMs,
      ) ?? DEFAULTS.pollIntervalMs,
    readOnly: Boolean(
      pick('readOnly', 'READ_ONLY', envBool('READ_ONLY'), raw.readOnly) ??
      DEFAULTS.readOnly,
    ),
    maxStreams:
      pick(
        'maxStreams',
        'MAX_STREAMS',
        envNumber('MAX_STREAMS', {min: 1}),
        raw.maxStreams,
      ) ?? DEFAULTS.maxStreams,
    trustProxy:
      pick(
        'trustProxy',
        'TRUST_PROXY',
        parseTrustProxy(env('TRUST_PROXY')),
        raw.trustProxy,
      ) ?? DEFAULTS.trustProxy,
    allowedHosts:
      pick(
        'allowedHosts',
        'ALLOWED_HOSTS',
        envHosts?.length ? envHosts : undefined,
        raw.allowedHosts,
      ) ?? null,
    auth: {
      password,
      sessionHours: Number(
        pick(
          'sessionHours',
          'SESSION_HOURS',
          envNumber('SESSION_HOURS', {min: 0.1}),
          auth.sessionHours,
        ) ?? DEFAULTS.sessionHours,
      ),
    },
    // Interface to listen on; when not set, it's decided once the saved password is known.
    hostExplicit: env('HOST') || raw.host || null,
    host: '',
    resetPassword: envBool('RESET_PASSWORD') ?? false,
    locked,
    // Where settings and instances added from the UI are saved.
    dataDir: path.resolve(env('DATA_DIR') ?? raw.dataDir ?? 'data'),
    instances,
  };
}
