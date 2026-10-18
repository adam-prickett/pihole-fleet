import fs from 'node:fs';
import path from 'node:path';
import {ConfigError} from './config.js';
import {PiholeError, type PiholeClient} from './pihole.js';
import {writePrivateJson} from './store.js';
import type {
  GravityTable,
  InstanceConfig,
  ReplicaStatus,
  Severity,
  SyncDiff,
  SyncItem,
  SyncResponse,
  SyncSettings,
  SyncStatus,
  SyncSummary,
  TableDiff,
} from './types.js';

export const SYNC_ITEMS: SyncItem[] = [
  'adlists',
  'domains',
  'clients',
  'localDns',
  'dnsSettings',
];
const GRAVITY_ITEMS = new Set<SyncItem>(['adlists', 'domains', 'clients']);
const INTERVAL_RANGE = {min: 5, max: 1440};

export const DEFAULT_SYNC: SyncSettings = {
  primaryId: null,
  excluded: [],
  items: {
    adlists: true,
    domains: true,
    clients: true,
    localDns: true,
    dnsSettings: false,
  },
  auto: false,
  intervalMin: 15,
  runGravity: true,
};

const LOCAL_DNS_KEYS = new Set(['dns.hosts', 'dns.cnameRecords']);
// Settings that belong to one machine (its interface, port and own addresses), never copied.
const MACHINE_KEYS = ['dns.interface', 'dns.port', 'dns.listeningMode'];
const MACHINE_PREFIXES = ['dns.reply.'];
// Pi-hole shows write-only values (passwords) as this placeholder.
const HIDDEN_VALUE = '********';

const BACKUP_TIMEOUT_MS = 60_000;
const GRAVITY_TIMEOUT_MS = 15 * 60_000;
const RESTART_WAIT_MS = 90_000;

function configItemOf(key: string): SyncItem | null {
  if (!key.startsWith('dns.')) return null;
  if (LOCAL_DNS_KEYS.has(key)) return 'localDns';
  if (MACHINE_KEYS.includes(key)) return null;
  if (MACHINE_PREFIXES.some(p => key.startsWith(p))) return null;
  return 'dnsSettings';
}

// --- Reading a Pi-hole's state

interface ConfigLeaf {
  value: unknown;
  envVar: boolean;
}

interface RawGroup {
  id: number;
  name: string;
  enabled?: boolean;
  comment?: string | null;
}

interface RawList {
  address: string;
  type?: string;
  enabled?: boolean;
  comment?: string | null;
  groups?: number[];
}

interface RawDomain {
  domain: string;
  type?: string;
  kind?: string;
  enabled?: boolean;
  comment?: string | null;
  groups?: number[];
}

interface RawClient {
  client: string;
  comment?: string | null;
  groups?: number[];
}

/** Each table as key -> comparable fingerprint. */
type Tables = Record<GravityTable, Map<string, string>>;

interface PiholeState {
  config: Map<string, ConfigLeaf> | null;
  tables: Tables | null;
}

/** Flatten GET /config?detailed=true into "dns.upstreams" -> {value, envVar}. */
function flattenConfig(
  node: unknown,
  prefix: string,
  out: Map<string, ConfigLeaf>,
): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  const flags = obj.flags as {env_var?: boolean} | undefined;
  if ('value' in obj && flags && typeof flags === 'object') {
    out.set(prefix, {value: obj.value, envVar: Boolean(flags.env_var)});
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    flattenConfig(v, prefix ? `${prefix}.${k}` : k, out);
  }
}

function fingerprint(...parts: unknown[]): string {
  return JSON.stringify(parts);
}

async function readState(
  client: PiholeClient,
  settings: SyncSettings,
): Promise<PiholeState> {
  const wantConfig = settings.items.localDns || settings.items.dnsSettings;
  const wantGravity = SYNC_ITEMS.some(
    i => GRAVITY_ITEMS.has(i) && settings.items[i],
  );
  const state: PiholeState = {config: null, tables: null};

  if (wantConfig) {
    const res = await client.get<{config?: unknown}>(
      '/config/dns?detailed=true',
    );
    state.config = new Map();
    flattenConfig(res?.config, '', state.config);
  }

  if (wantGravity) {
    const [groups, lists, domains, clients] = await Promise.all([
      client.get<{groups?: RawGroup[]}>('/groups'),
      client.get<{lists?: RawList[]}>('/lists'),
      client.get<{domains?: RawDomain[]}>('/domains'),
      client.get<{clients?: RawClient[]}>('/clients'),
    ]);
    // Group ids can differ between Pi-holes, so memberships are compared by name.
    const names = new Map<number, string>(
      (groups?.groups ?? []).map(g => [g.id, g.name]),
    );
    const groupNames = (ids: number[] = []) =>
      ids.map(id => names.get(id) ?? `#${id}`).sort();
    state.tables = {
      groups: new Map(
        (groups?.groups ?? []).map(g => [
          g.name,
          fingerprint(g.enabled ?? true, g.comment ?? ''),
        ]),
      ),
      adlists: new Map(
        (lists?.lists ?? []).map(l => [
          `${l.type ?? 'block'} ${l.address}`,
          fingerprint(l.enabled ?? true, l.comment ?? '', groupNames(l.groups)),
        ]),
      ),
      domains: new Map(
        (domains?.domains ?? []).map(d => [
          `${d.type ?? ''}/${d.kind ?? ''} ${d.domain}`,
          fingerprint(d.enabled ?? true, d.comment ?? '', groupNames(d.groups)),
        ]),
      ),
      clients: new Map(
        (clients?.clients ?? []).map(c => [
          c.client,
          fingerprint(c.comment ?? '', groupNames(c.groups)),
        ]),
      ),
    };
  }
  return state;
}

function diffTable(
  primary: Map<string, string>,
  replica: Map<string, string>,
): TableDiff | null {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [k, v] of primary) {
    const r = replica.get(k);
    if (r === undefined) added++;
    else if (r !== v) changed++;
  }
  for (const k of replica.keys()) if (!primary.has(k)) removed++;
  return added || removed || changed ? {added, removed, changed} : null;
}

interface Comparison {
  diff: SyncDiff;
  /** Changed config keys -> the primary's value. */
  patch: Map<string, unknown>;
  skipped: string[];
}

function compare(
  primary: PiholeState,
  replica: PiholeState,
  settings: SyncSettings,
): Comparison {
  const diff: SyncDiff = {config: [], gravity: {}};
  const patch = new Map<string, unknown>();
  const skipped: string[] = [];

  if (primary.config && replica.config) {
    for (const [key, leaf] of primary.config) {
      const item = configItemOf(key);
      if (!item || !settings.items[item]) continue;
      const theirs = replica.config.get(key);
      if (!theirs || leaf.value === HIDDEN_VALUE) continue;
      if (JSON.stringify(theirs.value) === JSON.stringify(leaf.value)) {
        continue;
      }
      if (theirs.envVar) {
        skipped.push(key);
        continue;
      }
      diff.config.push(key);
      patch.set(key, leaf.value);
    }
  }

  if (primary.tables && replica.tables) {
    const tables: GravityTable[] = ['groups'];
    for (const t of ['adlists', 'domains', 'clients'] as const) {
      if (settings.items[t]) tables.push(t);
    }
    for (const t of tables) {
      const d = diffTable(primary.tables[t], replica.tables[t]);
      if (d) diff.gravity[t] = d;
    }
  }
  return {diff, patch, skipped};
}

function hasDrift(d: SyncDiff): boolean {
  return d.config.length > 0 || Object.keys(d.gravity).length > 0;
}

/** {"dns.upstreams": [...]} -> {dns: {upstreams: [...]}} */
function nest(patch: Map<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of patch) {
    const parts = key.split('.');
    let node = root;
    for (const p of parts.slice(0, -1)) {
      node[p] ??= {};
      node = node[p] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
  }
  return root;
}

/** A short human summary of a diff, for the event log. */
export function describeDiff(d: SyncDiff): string {
  const parts: string[] = [];
  if (d.config.length) {
    parts.push(`${d.config.length} setting${d.config.length > 1 ? 's' : ''}`);
  }
  for (const [table, t] of Object.entries(d.gravity)) {
    parts.push(`${table} (+${t.added} −${t.removed} ~${t.changed})`);
  }
  return parts.join(', ');
}

function errorText(err: unknown): string {
  if (err instanceof PiholeError) return err.message;
  console.error('[sync] unexpected error:', err);
  return 'Unexpected error (see server log)';
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// --- Settings validation

/** Validate a partial sync settings object. Throws ConfigError. */
export function validateSync(
  input: unknown,
  instanceIds: Set<string>,
): Partial<SyncSettings> {
  const body = (input ?? {}) as Record<string, unknown>;
  const out: Partial<SyncSettings> = {};
  if ('primaryId' in body) {
    const v = body.primaryId;
    if (v !== null && (typeof v !== 'string' || !instanceIds.has(v))) {
      throw new ConfigError('Choose one of your instances as the primary');
    }
    out.primaryId = v;
  }
  if ('excluded' in body) {
    const v = body.excluded;
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) {
      throw new ConfigError('"excluded" must be a list of instance ids');
    }
    out.excluded = [...new Set(v as string[])].filter(id =>
      instanceIds.has(id),
    );
  }
  if ('items' in body) {
    const v = body.items as Record<string, unknown> | null;
    if (!v || typeof v !== 'object') {
      throw new ConfigError('"items" must be an object');
    }
    const items: Record<SyncItem, boolean> = {...DEFAULT_SYNC.items};
    for (const k of SYNC_ITEMS) {
      const value = v[k];
      if (typeof value !== 'boolean') {
        throw new ConfigError(`"items.${k}" must be true or false`);
      }
      items[k] = value;
    }
    out.items = items;
  }
  for (const k of ['auto', 'runGravity'] as const) {
    if (k in body) {
      if (typeof body[k] !== 'boolean') {
        throw new ConfigError(`"${k}" must be true or false`);
      }
      out[k] = body[k];
    }
  }
  if ('intervalMin' in body) {
    const v = body.intervalMin;
    if (
      typeof v !== 'number' ||
      !Number.isInteger(v) ||
      v < INTERVAL_RANGE.min ||
      v > INTERVAL_RANGE.max
    ) {
      throw new ConfigError(
        `Sync interval must be a whole number of minutes from ${INTERVAL_RANGE.min} to ${INTERVAL_RANGE.max}`,
      );
    }
    out.intervalMin = v;
  }
  return out;
}

// --- The sync manager

export interface SyncHost {
  dataDir: string;
  /** The live client for an instance (shared with its poller), if it exists. */
  client(id: string): PiholeClient | undefined;
  instance(id: string): InstanceConfig | undefined;
  instanceIds(): string[];
  record(inst: InstanceConfig, severity: Severity, message: string): void;
  audit(entry: Record<string, unknown>): void;
  /** Something in the sync state changed (push a fresh snapshot). */
  changed(): void;
  /** Ask an instance's poller for an immediate refresh. */
  refresh(id: string): void;
}

/**
 * Keeps replica Pi-holes in line with a primary. Lists, groups and clients are copied
 * with Pi-hole's own backup format (teleporter); DNS settings with PATCH /config. A
 * replica is only written to when it actually differs from the primary.
 */
export class SyncManager {
  settings: SyncSettings;
  private readonly host: SyncHost;
  private readonly file: string;
  private readonly status = new Map<string, ReplicaStatus>();
  private running: SyncStatus['running'] = null;
  private lastRun: number | null = null;
  private nextRun: number | null = null;
  private primaryError: string | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(host: SyncHost) {
    this.host = host;
    this.file = path.join(host.dataDir, 'sync.json');
    this.settings = this.load();
  }

  private load(): SyncSettings {
    let raw: unknown;
    try {
      raw = (
        JSON.parse(fs.readFileSync(this.file, 'utf8')) as {settings?: unknown}
      ).settings;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        console.error(`  Could not read ${this.file}: ${err.message}`);
      }
      return structuredClone(DEFAULT_SYNC);
    }
    const ids = new Set(this.host.instanceIds());
    const out = structuredClone(DEFAULT_SYNC);
    for (const [k, v] of Object.entries((raw ?? {}) as object)) {
      try {
        Object.assign(out, validateSync({[k]: v}, ids));
      } catch (err) {
        console.warn(
          `  Ignoring saved sync setting "${k}": ${(err as Error).message}`,
        );
      }
    }
    return out;
  }

  /** Validate, save and apply a settings change. Throws ConfigError or a write error. */
  update(patch: Partial<SyncSettings>): void {
    const next = {...this.settings, ...patch};
    writePrivateJson(this.file, {version: 1, settings: next});
    const primaryChanged = next.primaryId !== this.settings.primaryId;
    const itemsChanged =
      JSON.stringify(next.items) !== JSON.stringify(this.settings.items);
    this.settings = next;
    if (primaryChanged || itemsChanged || patch.excluded) {
      this.status.clear();
      this.primaryError = null;
    }
    this.schedule();
    this.host.changed();
  }

  /** Start the schedule; also runs a first check shortly after startup. */
  start(): void {
    this.schedule();
    if (this.settings.primaryId) {
      setTimeout(() => void this.run('check', 'startup'), 10_000).unref();
    }
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  /** An instance was removed or its connection settings changed. */
  instanceChanged(id: string, removed: boolean): void {
    this.status.delete(id);
    if (!removed) return;
    const patch: Partial<SyncSettings> = {};
    if (this.settings.primaryId === id) patch.primaryId = null;
    if (this.settings.excluded.includes(id)) {
      patch.excluded = this.settings.excluded.filter(x => x !== id);
    }
    if (Object.keys(patch).length) {
      try {
        this.update(patch);
      } catch (err) {
        console.error(`Could not save ${this.file}:`, (err as Error).message);
      }
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.nextRun = null;
    if (!this.settings.primaryId || !this.settings.auto) return;
    const ms = this.settings.intervalMin * 60_000;
    this.nextRun = Date.now() + ms;
    this.timer = setTimeout(() => {
      void this.run('sync', 'schedule').finally(() => this.schedule());
    }, ms);
    this.timer.unref();
  }

  private replicaIds(): string[] {
    const {primaryId, excluded} = this.settings;
    return this.host
      .instanceIds()
      .filter(id => id !== primaryId && !excluded.includes(id));
  }

  private setStatus(id: string, patch: Partial<ReplicaStatus>): void {
    const prev = this.status.get(id) ?? {
      id,
      state: 'unknown',
      checkedAt: null,
      syncedAt: null,
      error: null,
      drift: null,
      skipped: [],
    };
    this.status.set(id, {...prev, ...patch});
    this.host.changed();
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  /**
   * Compare every replica with the primary; with mode 'sync', also bring drifted ones
   * back in line. Returns false if a run was already in progress.
   */
  async run(
    mode: 'check' | 'sync',
    trigger: 'manual' | 'schedule' | 'startup',
  ): Promise<boolean> {
    const primaryId = this.settings.primaryId;
    if (this.running || !primaryId) return false;
    const primary = this.host.instance(primaryId);
    const primaryClient = this.host.client(primaryId);
    if (!primary || !primaryClient) return false;

    this.running = mode;
    this.host.changed();
    const settings = structuredClone(this.settings);
    const results: Array<{id: string; ok: boolean; synced: boolean}> = [];
    try {
      let source: PiholeState;
      try {
        source = await readState(primaryClient, settings);
        this.primaryError = null;
      } catch (err) {
        const message = `Couldn't read the primary: ${errorText(err)}`;
        if (message !== this.primaryError) {
          this.host.record(primary, 'serious', `Sync: ${message}`);
        }
        this.primaryError = message;
        return true;
      }
      let backup: Promise<Buffer> | null = null;
      const getBackup = () =>
        (backup ??= primaryClient.request<Buffer>('/teleporter', {
          binary: true,
          timeoutMs: BACKUP_TIMEOUT_MS,
        }));

      // Replicas are handled one at a time so they never all restart at once.
      for (const id of this.replicaIds()) {
        const inst = this.host.instance(id);
        const client = this.host.client(id);
        if (!inst || !client) continue;
        try {
          const synced = await this.syncOne(
            mode,
            inst,
            client,
            source,
            settings,
            getBackup,
            primary,
          );
          results.push({id, ok: true, synced});
        } catch (err) {
          const message = errorText(err);
          if (this.status.get(id)?.error !== message) {
            this.host.record(inst, 'serious', `Sync failed: ${message}`);
          }
          this.setStatus(id, {state: 'error', error: message});
          results.push({id, ok: false, synced: false});
        }
      }
    } finally {
      this.running = null;
      this.lastRun = Date.now();
      this.host.changed();
      if (mode === 'sync' || trigger === 'manual') {
        this.host.audit({
          action: mode === 'sync' ? 'sync_run' : 'sync_check',
          trigger,
          primary: primaryId,
          primaryError: this.primaryError,
          results,
        });
      }
    }
    return true;
  }

  /** Check (and in 'sync' mode, fix) one replica. Returns true if it was written to. */
  private async syncOne(
    mode: 'check' | 'sync',
    inst: InstanceConfig,
    client: PiholeClient,
    source: PiholeState,
    settings: SyncSettings,
    getBackup: () => Promise<Buffer>,
    primary: InstanceConfig,
  ): Promise<boolean> {
    const before = this.status.get(inst.id)?.state;
    let cmp = compare(source, await readState(client, settings), settings);
    const now = Date.now();
    if (!hasDrift(cmp.diff)) {
      this.setStatus(inst.id, {
        state: 'in_sync',
        checkedAt: now,
        error: null,
        drift: null,
        skipped: cmp.skipped,
      });
      return false;
    }
    if (mode === 'check') {
      if (before !== 'drift') {
        this.host.record(
          inst,
          'warning',
          `Differs from ${primary.name}: ${describeDiff(cmp.diff)}`,
        );
      }
      this.setStatus(inst.id, {
        state: 'drift',
        checkedAt: now,
        error: null,
        drift: cmp.diff,
        skipped: cmp.skipped,
      });
      return false;
    }

    this.setStatus(inst.id, {state: 'syncing', drift: cmp.diff});
    const summary = describeDiff(cmp.diff);
    const lists = Object.keys(cmp.diff.gravity).length > 0;
    const adlistsChanged = Boolean(cmp.diff.gravity.adlists);

    if (cmp.patch.size) {
      await client.request('/config', {
        method: 'PATCH',
        body: {config: nest(cmp.patch)},
        timeoutMs: BACKUP_TIMEOUT_MS,
      });
      // Some DNS settings make Pi-hole restart its DNS service.
      await this.waitForRestart(client);
    }
    if (lists) {
      const form = new FormData();
      const zip = await getBackup();
      form.append(
        'file',
        new Blob([new Uint8Array(zip)], {type: 'application/zip'}),
        'pihole-fleet-sync.zip',
      );
      form.append(
        'import',
        JSON.stringify({
          config: false,
          dhcp_leases: false,
          gravity: {
            group: true,
            adlist: settings.items.adlists,
            adlist_by_group: settings.items.adlists,
            domainlist: settings.items.domains,
            domainlist_by_group: settings.items.domains,
            client: settings.items.clients,
            client_by_group: settings.items.clients,
          },
        }),
      );
      await client.request('/teleporter', {
        method: 'POST',
        form,
        timeoutMs: BACKUP_TIMEOUT_MS,
      });
      // Pi-hole restarts its DNS service after an import.
      await this.waitForRestart(client);
    }
    if (adlistsChanged && settings.runGravity) {
      // Downloads the new adlists. Its output streams until done, which can take minutes.
      await client.request('/action/gravity', {
        method: 'POST',
        timeoutMs: GRAVITY_TIMEOUT_MS,
      });
    }

    this.host.record(inst, 'good', `Synced from ${primary.name}: ${summary}`);
    this.host.refresh(inst.id);

    // Confirm the result.
    cmp = compare(source, await readState(client, settings), settings);
    const ok = !hasDrift(cmp.diff);
    this.setStatus(inst.id, {
      state: ok ? 'in_sync' : 'drift',
      checkedAt: Date.now(),
      syncedAt: Date.now(),
      error: ok
        ? null
        : `Still differs after syncing: ${describeDiff(cmp.diff)}`,
      drift: ok ? null : cmp.diff,
      skipped: cmp.skipped,
    });
    return true;
  }

  /** Wait (up to 90s) for a Pi-hole to answer again after restarting. */
  private async waitForRestart(client: PiholeClient): Promise<void> {
    await sleep(3000);
    const deadline = Date.now() + RESTART_WAIT_MS;
    for (;;) {
      try {
        await client.get('/info/version');
        return;
      } catch (err) {
        const network = err instanceof PiholeError && err.code === 'network';
        if (!network || Date.now() > deadline) throw err;
        await sleep(2000);
      }
    }
  }

  /** The full state, for the settings page. */
  response(blocked: string | null): SyncResponse {
    const ids = this.settings.primaryId ? this.replicaIds() : [];
    return {
      settings: this.settings,
      status: {
        running: this.running,
        lastRun: this.lastRun,
        nextRun: this.nextRun,
        primaryError: this.primaryError,
        replicas: ids.map(
          id =>
            this.status.get(id) ?? {
              id,
              state: 'unknown',
              checkedAt: null,
              syncedAt: null,
              error: null,
              drift: null,
              skipped: [],
            },
        ),
      },
      canEdit: !blocked,
      reason: blocked,
    };
  }

  /** The part shown on the dashboard. */
  summary(): SyncSummary | null {
    const primaryId = this.settings.primaryId;
    if (!primaryId) return null;
    return {
      primaryId,
      running: this.running,
      replicas: Object.fromEntries(
        this.replicaIds().map(id => [
          id,
          this.status.get(id)?.state ?? 'unknown',
        ]),
      ),
    };
  }
}
