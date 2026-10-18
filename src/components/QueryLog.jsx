import { useMemo, useState } from 'react';
import Panel from './Panel.jsx';
import { IconPause, IconPlay, IconSearch } from './Icons.jsx';
import { fmtClock, fmtMs } from '../lib/format.js';

const OUTCOME = {
  blocked: { label: 'BLOCKED', cls: 'tag-blocked' },
  allowed: { label: 'OK', cls: 'tag-ok' },
  cached: { label: 'CACHED', cls: 'tag-neutral' },
};

export default function QueryLog({ queries, instanceNames, colorOf, className }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  // While paused, keep showing the snapshot taken at the moment of pausing.
  const [frozen, setFrozen] = useState(null);
  const paused = frozen !== null;
  const source = frozen ?? queries;

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return source.filter((q) => {
      if (filter === 'blocked' && q.outcome !== 'blocked') return false;
      if (filter === 'allowed' && q.outcome === 'blocked') return false;
      if (needle && !q.domain.toLowerCase().includes(needle) && !q.client.toLowerCase().includes(needle)) return false;
      return true;
    }).slice(0, 150);
  }, [source, filter, search]);

  return (
    <Panel
      title="Query log"
      meta={paused ? 'paused' : <span className="streaming"><span className="led led-pulse" />streaming</span>}
      className={className}
      flush
      actions={
        <>
          <label className="search">
            <IconSearch />
            <input
              type="search"
              placeholder="domain or client"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Filter queries by domain or client"
            />
          </label>
          <div className="segmented" role="tablist" aria-label="Outcome filter">
            {['all', 'allowed', 'blocked'].map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <button
            className="btn"
            onClick={() => setFrozen(paused ? null : queries)}
            aria-pressed={paused}
            title={paused ? 'Resume' : 'Pause'}
          >
            {paused ? <IconPlay /> : <IconPause />}
          </button>
        </>
      }
    >
      <div className="table-scroll log-scroll">
        <table className="grid-table log">
          <thead>
            <tr>
              <th>Time</th>
              <th>Instance</th>
              <th>Status</th>
              <th>Type</th>
              <th>Domain</th>
              <th>Client</th>
              <th className="num">Reply</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="empty">No matching queries</td></tr>
            )}
            {rows.map((q) => {
              const o = OUTCOME[q.outcome];
              return (
                <tr key={q.key}>
                  <td className="mono dim">{fmtClock(q.time)}</td>
                  <td>
                    <span className="swatch" style={{ background: colorOf(q.instanceId) }} aria-hidden="true" />
                    {instanceNames[q.instanceId]}
                  </td>
                  <td><span className={`tag ${o.cls}`} title={q.status}>{o.label}</span></td>
                  <td className="mono dim">{q.type}</td>
                  <td className="mono domain" title={q.domain}>{q.domain}</td>
                  <td className="mono dim" title={q.clientIp}>{q.client}</td>
                  <td className="num mono dim">{fmtMs(q.replyMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
