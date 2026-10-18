/**
 * @fileoverview Combine per-instance state into one fleet-wide view. Runs client-side so
 * the same code powers both the "all instances" view and any filtered subset.
 */

import type {InstanceState, Query, TopItem} from '../../server/types.js';

const BUCKET = 600; // Pi-hole history uses 10-minute buckets

export interface Totals {
  total: number;
  blocked: number;
  cached: number;
  forwarded: number;
  activeClients: number;
  gravityDomains: number;
  frequency: number;
  gravityOldest: number | null;
  percentBlocked: number;
  percentCached: number;
}

/** One history bucket; per-instance totals are keyed by instance id. */
export interface HistoryRow {
  t: number;
  total: number;
  blocked: number;
  allowed: number;
  pct: number;
  [instanceId: string]: number;
}

/** A row in a ranked list, with its per-instance breakdown. */
export interface RankedItem {
  key: string;
  label: string;
  count: number;
  by: Record<string, number>;
  responseMs?: number | null;
}

export interface FleetQuery extends Query {
  instanceId: string;
  key: string;
}

export type FleetBlocking = 'enabled' | 'disabled' | 'mixed' | 'unknown';

export interface Aggregate {
  totals: Totals;
  history: HistoryRow[];
  topDomains: RankedItem[];
  topBlocked: RankedItem[];
  topClients: RankedItem[];
  upstreams: RankedItem[];
  queryTypes: RankedItem[];
  queries: FleetQuery[];
  blocking: FleetBlocking;
  onlineCount: number;
  totalCount: number;
}

type TopField = 'topDomains' | 'topBlocked' | 'topClients';

function mergeCounts(
  instances: InstanceState[],
  field: TopField,
  keyOf: (item: TopItem) => string,
): RankedItem[] {
  const map = new Map<string, RankedItem>();
  for (const inst of instances) {
    for (const item of inst[field] ?? []) {
      const key = keyOf(item);
      const entry = map.get(key) ?? {key, label: key, count: 0, by: {}};
      entry.count += item.count ?? 0;
      entry.by[inst.id] = (entry.by[inst.id] ?? 0) + (item.count ?? 0);
      map.set(key, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function sumTotals(online: InstanceState[]): Totals {
  const acc: Totals = {
    total: 0,
    blocked: 0,
    cached: 0,
    forwarded: 0,
    activeClients: 0,
    gravityDomains: 0,
    frequency: 0,
    gravityOldest: null,
    percentBlocked: 0,
    percentCached: 0,
  };
  for (const {summary: s} of online) {
    if (!s) continue;
    acc.total += s.total;
    acc.blocked += s.blocked;
    acc.cached += s.cached;
    acc.forwarded += s.forwarded;
    acc.activeClients += s.activeClients;
    acc.gravityDomains = Math.max(acc.gravityDomains, s.gravityDomains);
    acc.frequency += s.frequency;
    if (s.gravityUpdated) {
      acc.gravityOldest = Math.min(
        acc.gravityOldest ?? Infinity,
        s.gravityUpdated,
      );
    }
  }
  acc.percentBlocked = acc.total ? (acc.blocked / acc.total) * 100 : 0;
  acc.percentCached = acc.total ? (acc.cached / acc.total) * 100 : 0;
  return acc;
}

/** 24h history, aligned on bucket boundaries, with a per-instance breakdown. */
function mergeHistory(online: InstanceState[]): HistoryRow[] {
  const hist = new Map<number, HistoryRow>();
  for (const inst of online) {
    for (const h of inst.history ?? []) {
      const t = Math.floor(h.t / BUCKET) * BUCKET;
      const row = hist.get(t) ?? {t, total: 0, blocked: 0, allowed: 0, pct: 0};
      row.total += h.total;
      row.blocked += h.blocked;
      row.allowed = row.total - row.blocked;
      row[inst.id] = (row[inst.id] ?? 0) + h.total;
      hist.set(t, row);
    }
  }
  return [...hist.values()]
    .sort((a, b) => a.t - b.t)
    .map(row => ({
      ...row,
      pct: row.total ? (row.blocked / row.total) * 100 : 0,
    }));
}

/** Upstreams merged by address, with a count-weighted average response time. */
function mergeUpstreams(online: InstanceState[]): RankedItem[] {
  const map = new Map<
    string,
    RankedItem & {weightedMs: number; weight: number}
  >();
  for (const inst of online) {
    for (const u of inst.upstreams ?? []) {
      const key = `${u.ip}#${u.port}`;
      const e = map.get(key) ?? {
        key,
        label: u.name,
        count: 0,
        weightedMs: 0,
        weight: 0,
        by: {},
      };
      e.count += u.count;
      e.by[inst.id] = (e.by[inst.id] ?? 0) + u.count;
      if (u.responseMs != null && u.count > 0) {
        e.weightedMs += u.responseMs * u.count;
        e.weight += u.count;
      }
      map.set(key, e);
    }
  }
  return [...map.values()]
    .map(u => ({...u, responseMs: u.weight ? u.weightedMs / u.weight : null}))
    .sort((a, b) => b.count - a.count);
}

function fleetBlocking(online: InstanceState[]): FleetBlocking {
  const states = online
    .map(i => i.blocking?.state)
    .filter(s => s !== undefined);
  if (states.length === 0) return 'unknown';
  if (states.every(s => s === 'enabled')) return 'enabled';
  if (states.every(s => s === 'disabled')) return 'disabled';
  return 'mixed';
}

export function aggregate(instances: InstanceState[]): Aggregate {
  const online = instances.filter(i => i.status === 'online' && i.summary);

  const typeMap = new Map<string, number>();
  for (const inst of online) {
    for (const [type, n] of Object.entries(inst.summary?.types ?? {})) {
      typeMap.set(type, (typeMap.get(type) ?? 0) + n);
    }
  }
  const queryTypes = [...typeMap.entries()]
    .filter(([, n]) => n > 0)
    .map(([key, count]) => ({key, label: key, count, by: {}}))
    .sort((a, b) => b.count - a.count);

  const queries = online
    .flatMap(inst =>
      (inst.queries ?? []).map(q => ({
        ...q,
        instanceId: inst.id,
        key: `${inst.id}:${q.id}`,
      })),
    )
    .sort((a, b) => b.time - a.time)
    .slice(0, 200);

  return {
    totals: sumTotals(online),
    history: mergeHistory(online),
    topDomains: mergeCounts(online, 'topDomains', d => d.domain ?? ''),
    topBlocked: mergeCounts(online, 'topBlocked', d => d.domain ?? ''),
    topClients: mergeCounts(online, 'topClients', c => c.name || c.ip || ''),
    upstreams: mergeUpstreams(online),
    queryTypes,
    queries,
    blocking: fleetBlocking(online),
    onlineCount: online.length,
    totalCount: instances.length,
  };
}
