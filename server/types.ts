/**
 * @fileoverview Data shapes shared by the server and the browser (the browser imports
 * these as types only).
 */

export type InstanceStatus = 'connecting' | 'online' | 'offline' | 'auth_error';
export type BlockingState = 'enabled' | 'disabled' | 'failed' | 'unknown';
export type QueryOutcome = 'allowed' | 'blocked' | 'cached';
export type Severity = 'good' | 'warning' | 'serious' | 'critical';
export type InstanceSource = 'config' | 'ui';
/** Express "trust proxy": off, on, a hop count, or proxy IPs/subnets. */
export type TrustProxy = boolean | number | string;

/** One poll result, for the status history strip. */
export interface Heartbeat {
  t: number;
  ok: boolean;
  ms: number | null;
}

export interface Summary {
  total: number;
  blocked: number;
  percentBlocked: number;
  uniqueDomains: number;
  forwarded: number;
  cached: number;
  frequency: number;
  types: Record<string, number>;
  activeClients: number;
  totalClients: number;
  gravityDomains: number;
  gravityUpdated: number | null;
}

export interface Blocking {
  state: BlockingState;
  timer: number | null;
}

export interface Query {
  id: number;
  time: number;
  type: string;
  domain: string;
  client: string;
  clientIp: string;
  status: string;
  outcome: QueryOutcome;
  replyMs: number | null;
  upstream: string | null;
}

/** A top-domains or top-clients entry. */
export interface TopItem {
  domain?: string;
  name?: string;
  ip?: string;
  count: number;
}

export interface Upstream {
  name: string;
  ip: string;
  port: number;
  count: number;
  responseMs: number | null;
}

export interface SystemInfo {
  uptime: number | null;
  memPercent: number | null;
  cpuPercent: number | null;
  load: number[] | null;
  cores: number | null;
}

export interface VersionInfo {
  core: string | null;
  web: string | null;
  ftl: string | null;
  docker: string | null;
  updateAvailable: boolean;
}

export interface HistoryPoint {
  t: number;
  total: number;
  blocked: number;
}

/** Everything known about one Pi-hole; optional parts arrive as they are polled. */
export interface InstanceState {
  id: string;
  name: string;
  url: string;
  status: InstanceStatus;
  error: string | null;
  lastUpdated: number | null;
  lastSeen: number | null;
  latencyMs: number | null;
  heartbeat: Heartbeat[];
  summary?: Summary;
  blocking?: Blocking;
  queries?: Query[];
  topDomains?: TopItem[];
  topBlocked?: TopItem[];
  topClients?: TopItem[];
  upstreams?: Upstream[];
  system?: SystemInfo | null;
  history?: HistoryPoint[];
  version?: VersionInfo | null;
}

export interface DashboardEvent {
  id: number;
  t: number;
  instanceId: string;
  instanceName: string;
  severity: Severity;
  message: string;
}

/** What the server pushes over the live stream. */
export interface Snapshot {
  generatedAt: number;
  buildId: string | null;
  readOnly: boolean;
  authEnabled: boolean;
  canManage: boolean;
  pollIntervalMs: number;
  instances: InstanceState[];
  events: DashboardEvent[];
  sync: SyncSummary | null;
}

/** Connection settings for one Pi-hole. */
export interface InstanceConfig {
  id: string;
  name: string;
  url: string;
  password: string;
  insecure: boolean;
  timeoutMs: number;
}

export interface InstanceDef extends InstanceConfig {
  source: InstanceSource;
}

/** An instance as shown in the settings page (the password is never sent). */
export interface PublicInstance {
  id: string;
  name: string;
  url: string;
  insecure: boolean;
  timeoutMs: number;
  source: InstanceSource;
  hasPassword: boolean;
}

export interface InstancesResponse {
  instances: PublicInstance[];
  canManage: boolean;
  reason: string | null;
  maxInstances: number;
}

export interface TestResult {
  ok: boolean;
  version?: string | null;
  error?: string;
}

/** Settings that can be changed from the settings page. */
export interface SettingsValues {
  allowedHosts: string[] | null;
  trustProxy: TrustProxy;
  pollIntervalMs: number;
  readOnly: boolean;
  sessionHours: number;
  maxStreams: number;
}

export interface SettingsResponse {
  values: SettingsValues;
  autoAllowedHosts: string[];
  /** Setting name -> what fixes it (an environment variable name or "config file"). */
  locked: Partial<Record<keyof SettingsValues, string>>;
  password: {set: boolean; locked: string | null; minLength: number};
  server: {port: number; host: string; dataDir: string};
  currentHost: string;
  canEdit: boolean;
  reason: string | null;
}

export interface SessionStatus {
  authRequired: boolean;
  authenticated: boolean;
}

// --- Config sync: one primary Pi-hole, the others mirror it.

/** What can be mirrored from the primary. */
export type SyncItem =
  'adlists' | 'domains' | 'clients' | 'localDns' | 'dnsSettings';

export interface SyncSettings {
  /** The instance others mirror; null = sync off. */
  primaryId: string | null;
  /** Instances that don't mirror the primary. */
  excluded: string[];
  items: Record<SyncItem, boolean>;
  /** Sync automatically every `intervalMin` minutes (otherwise only on demand). */
  auto: boolean;
  intervalMin: number;
  /** Update gravity on a replica after its adlists change. */
  runGravity: boolean;
}

export type ReplicaSyncState =
  'unknown' | 'in_sync' | 'drift' | 'syncing' | 'error';

/** Gravity database tables compared between the primary and a replica. */
export type GravityTable = 'groups' | 'adlists' | 'domains' | 'clients';

export interface TableDiff {
  added: number;
  removed: number;
  changed: number;
}

/** How a replica differs from the primary. */
export interface SyncDiff {
  /** Changed config keys, e.g. "dns.upstreams". */
  config: string[];
  gravity: Partial<Record<GravityTable, TableDiff>>;
}

export interface ReplicaStatus {
  id: string;
  state: ReplicaSyncState;
  checkedAt: number | null;
  syncedAt: number | null;
  error: string | null;
  drift: SyncDiff | null;
  /** Keys that differ but are fixed by an environment variable on the replica. */
  skipped: string[];
}

export interface SyncStatus {
  running: 'check' | 'sync' | null;
  lastRun: number | null;
  nextRun: number | null;
  primaryError: string | null;
  replicas: ReplicaStatus[];
}

export interface SyncResponse {
  settings: SyncSettings;
  status: SyncStatus;
  canEdit: boolean;
  reason: string | null;
}

/** The part of the sync state the dashboard shows (in the live snapshot). */
export interface SyncSummary {
  primaryId: string;
  running: SyncStatus['running'];
  replicas: Record<string, ReplicaSyncState>;
}
