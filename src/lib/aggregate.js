// Combine per-instance state into one fleet-wide view. Runs client-side so the
// same code powers both the "all instances" view and any filtered subset.

const BUCKET = 600; // Pi-hole history uses 10-minute buckets

function mergeCounts(instances, field, keyOf, labelOf) {
  const map = new Map();
  for (const inst of instances) {
    for (const item of inst[field] ?? []) {
      const key = keyOf(item);
      const entry = map.get(key) ?? { key, label: labelOf(item), count: 0, by: {} };
      entry.count += item.count ?? 0;
      entry.by[inst.id] = (entry.by[inst.id] ?? 0) + (item.count ?? 0);
      map.set(key, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function aggregate(instances) {
  const online = instances.filter((i) => i.status === 'online' && i.summary);

  const totals = online.reduce(
    (acc, { summary: s }) => {
      acc.total += s.total;
      acc.blocked += s.blocked;
      acc.cached += s.cached;
      acc.forwarded += s.forwarded;
      acc.activeClients += s.activeClients;
      acc.gravityDomains = Math.max(acc.gravityDomains, s.gravityDomains);
      acc.frequency += s.frequency;
      if (s.gravityUpdated) acc.gravityOldest = Math.min(acc.gravityOldest ?? Infinity, s.gravityUpdated);
      return acc;
    },
    { total: 0, blocked: 0, cached: 0, forwarded: 0, activeClients: 0, gravityDomains: 0, frequency: 0, gravityOldest: null },
  );
  totals.percentBlocked = totals.total ? (totals.blocked / totals.total) * 100 : 0;
  totals.percentCached = totals.total ? (totals.cached / totals.total) * 100 : 0;

  // 24h history, aligned on bucket boundaries, with a per-instance breakdown.
  const hist = new Map();
  for (const inst of online) {
    for (const h of inst.history ?? []) {
      const t = Math.floor(h.t / BUCKET) * BUCKET;
      const row = hist.get(t) ?? { t, total: 0, blocked: 0, allowed: 0 };
      row.total += h.total;
      row.blocked += h.blocked;
      row.allowed = row.total - row.blocked;
      row[inst.id] = (row[inst.id] ?? 0) + h.total;
      hist.set(t, row);
    }
  }
  const history = [...hist.values()]
    .sort((a, b) => a.t - b.t)
    .map((row) => ({ ...row, pct: row.total ? (row.blocked / row.total) * 100 : 0 }));

  const topDomains = mergeCounts(online, 'topDomains', (d) => d.domain, (d) => d.domain);
  const topBlocked = mergeCounts(online, 'topBlocked', (d) => d.domain, (d) => d.domain);
  const topClients = mergeCounts(online, 'topClients', (c) => c.name || c.ip, (c) => c.name || c.ip);

  const upstreamMap = new Map();
  for (const inst of online) {
    for (const u of inst.upstreams ?? []) {
      const key = `${u.ip}#${u.port}`;
      const e = upstreamMap.get(key) ?? { key, label: u.name, ip: u.ip, port: u.port, count: 0, weightedMs: 0, weight: 0, by: {} };
      e.count += u.count;
      e.by[inst.id] = (e.by[inst.id] ?? 0) + u.count;
      if (u.responseMs != null && u.count > 0) {
        e.weightedMs += u.responseMs * u.count;
        e.weight += u.count;
      }
      upstreamMap.set(key, e);
    }
  }
  const upstreams = [...upstreamMap.values()]
    .map((u) => ({ ...u, responseMs: u.weight ? u.weightedMs / u.weight : null }))
    .sort((a, b) => b.count - a.count);

  const typeMap = new Map();
  for (const inst of online) {
    for (const [type, n] of Object.entries(inst.summary.types ?? {})) {
      typeMap.set(type, (typeMap.get(type) ?? 0) + n);
    }
  }
  const queryTypes = [...typeMap.entries()]
    .filter(([, n]) => n > 0)
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => b.count - a.count);

  const queries = online
    .flatMap((inst) => (inst.queries ?? []).map((q) => ({ ...q, instanceId: inst.id, key: `${inst.id}:${q.id}` })))
    .sort((a, b) => b.time - a.time)
    .slice(0, 200);

  const blockingStates = online.map((i) => i.blocking?.state).filter(Boolean);
  const blocking =
    blockingStates.length === 0 ? 'unknown'
    : blockingStates.every((s) => s === 'enabled') ? 'enabled'
    : blockingStates.every((s) => s === 'disabled') ? 'disabled'
    : 'mixed';

  return {
    totals,
    history,
    topDomains,
    topBlocked,
    topClients,
    upstreams,
    queryTypes,
    queries,
    blocking,
    onlineCount: online.length,
    totalCount: instances.length,
  };
}
