import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  port: 3030,
  pollIntervalMs: 5000,
  readOnly: false,
  trustProxy: false,
  maxStreams: 50,
};

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

// Values like "env:PIHOLE_PASSWORD" are resolved from the environment so
// secrets don't have to live in the config file.
function resolveSecret(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    return process.env[value.slice(4)] ?? '';
  }
  return value ?? '';
}

function slugify(name, index) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || `instance-${index + 1}`;
}

function fail(message) {
  console.error(`\n  Config error: ${message}\n`);
  process.exit(1);
}

function parseInstanceUrl(raw, index) {
  let url;
  try { url = new URL(raw); } catch { fail(`instance #${index + 1} has an invalid url: ${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`instance #${index + 1} url must use http:// or https:// (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    // The URL is shown in the UI, so embedded credentials would leak to every viewer.
    fail(`instance #${index + 1} url must not contain credentials; use the "password" field`);
  }
  return url;
}

function parseTrustProxy(v) {
  if (v === undefined || v === '') return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return /^\d+$/.test(v) ? Number(v) : v; // hop count, or subnet/IP list for Express
}

export function loadConfig() {
  const file = path.resolve(argValue('--config') ?? process.env.CONFIG ?? 'config.json');

  let raw;
  if (process.env.PIHOLE_INSTANCES) {
    // Allow configuring entirely via env (handy for Docker): JSON array of instances.
    try { raw = { instances: JSON.parse(process.env.PIHOLE_INSTANCES) }; }
    catch { fail('PIHOLE_INSTANCES is not valid JSON'); }
  } else if (fs.existsSync(file)) {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) { fail(`${file} is not valid JSON (${err.message})`); }
  } else {
    console.error(`\n  Config file not found: ${file}`);
    console.error('  Copy config.example.json to config.json and add your Pi-hole instances,');
    console.error('  or run `npm run demo` to try the dashboard against mock instances.\n');
    process.exit(1);
  }

  const config = { ...DEFAULTS, ...raw };
  if (process.env.PORT) config.port = Number(process.env.PORT);

  // --- Dashboard authentication
  const auth = raw.auth ?? {};
  config.auth = {
    password: process.env.DASHBOARD_PASSWORD || resolveSecret(auth.password),
    sessionHours: Number(auth.sessionHours ?? 12),
  };
  if (config.auth.password && config.auth.password.length < 12) {
    console.warn('  Warning: the dashboard password is shorter than 12 characters.');
  }

  // --- Network exposure: without a password, only listen on loopback unless told otherwise.
  config.host = process.env.HOST || raw.host || (config.auth.password ? '0.0.0.0' : '127.0.0.1');

  const envHosts = process.env.ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);
  config.allowedHosts = envHosts?.length ? envHosts : raw.allowedHosts ?? null; // null = auto-detect

  const tp = parseTrustProxy(process.env.TRUST_PROXY);
  if (tp !== undefined) config.trustProxy = tp;

  if (!Array.isArray(config.instances) || config.instances.length === 0) {
    fail('config must contain a non-empty "instances" array');
  }

  const seen = new Set();
  config.instances = config.instances.map((inst, i) => {
    if (!inst.url) fail(`instance #${i + 1} is missing "url"`);
    const url = parseInstanceUrl(inst.url, i);
    let id = slugify(inst.name ?? url.hostname, i);
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    return {
      id,
      name: String(inst.name ?? url.hostname),
      url: `${url.origin}${url.pathname}`.replace(/\/+$/, '').replace(/\/admin$/, ''),
      password: resolveSecret(inst.password),
      insecure: Boolean(inst.insecure),
      timeoutMs: inst.timeoutMs ?? 8000,
    };
  });

  return config;
}
