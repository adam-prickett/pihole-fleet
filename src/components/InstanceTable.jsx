import Panel, { StatusLabel } from './Panel.jsx';
import BlockingControl from './BlockingControl.jsx';
import { IconArrowUp, IconExternal } from './Icons.jsx';
import { fmtAgo, fmtCompact, fmtDuration, fmtMs, hostOf } from '../lib/format.js';

const STATUS = {
  online: { label: 'Up', cls: 'good' },
  offline: { label: 'Down', cls: 'critical' },
  auth_error: { label: 'Auth', cls: 'serious' },
  connecting: { label: 'Pending', cls: 'unknown' },
};

const level = (pct) => (pct >= 90 ? 'critical' : pct >= 75 ? 'warning' : 'normal');

function Gauge({ value }) {
  if (value == null) return <span className="dim">—</span>;
  return (
    <span className={`gauge gauge-${level(value)}`}>
      <span className="gauge-track"><span className="gauge-fill" style={{ width: `${Math.min(100, value)}%` }} /></span>
      <span className="mono">{value.toFixed(0)}%</span>
    </span>
  );
}

/** Last N poll results as a strip: one tick per poll, newest on the right. */
function Heartbeat({ beats = [], slots = 60 }) {
  const okCount = beats.filter((b) => b.ok).length;
  const ms = beats.filter((b) => b.ok && b.ms != null).map((b) => b.ms);
  const avg = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
  const pad = slots - beats.length;
  const w = 2, gap = 1;
  return (
    <span className="heartbeat" title={`Last ${beats.length} polls · ${okCount} OK · avg ${fmtMs(avg)}`}>
      <svg width={slots * (w + gap)} height={14} role="img" aria-label={`${okCount} of ${beats.length} recent polls succeeded`}>
        {Array.from({ length: slots }, (_, i) => {
          const b = beats[i - pad];
          return (
            <rect
              key={i}
              x={i * (w + gap)}
              y={0}
              width={w}
              height={14}
              rx={0.5}
              className={b ? (b.ok ? 'hb-ok' : 'hb-fail') : 'hb-empty'}
            />
          );
        })}
      </svg>
      <span className="mono dim">{beats.length ? `${((okCount / beats.length) * 100).toFixed(0)}%` : '—'}</span>
    </span>
  );
}

export default function InstanceTable({ instances, selected, onSelect, colorOf, readOnly, now }) {
  const up = instances.filter((i) => i.status === 'online').length;
  return (
    <Panel
      title="Instances"
      meta={`${up}/${instances.length} up · click a row to filter, shift-click to add`}
      className="span-12"
      flush
    >
      <div className="table-scroll">
        <table className="grid-table instances">
          <thead>
            <tr>
              <th>Status</th>
              <th>Instance</th>
              <th>Blocking</th>
              <th className="num">Queries</th>
              <th className="num">Blocked</th>
              <th className="num">Rate</th>
              <th className="num">Clients</th>
              <th className="num">Latency</th>
              <th>CPU</th>
              <th>Memory</th>
              <th className="num">Uptime</th>
              <th>Version</th>
              <th>Poll history</th>
              <th className="num">Last poll</th>
            </tr>
          </thead>
          <tbody>
            {instances.map((inst) => {
              const st = STATUS[inst.status] ?? STATUS.connecting;
              const s = inst.summary;
              const online = inst.status === 'online' && s;
              const remaining = inst.blocking?.timer && inst.lastUpdated
                ? Math.max(0, inst.blocking.timer - (now - inst.lastUpdated) / 1000)
                : null;
              const isSel = selected.has(inst.id);
              return (
                <tr
                  key={inst.id}
                  className={`${isSel ? 'selected' : ''} ${online ? '' : 'row-down'}`}
                  onClick={(e) => onSelect(inst.id, e.shiftKey || e.metaKey || e.ctrlKey)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(inst.id, e.shiftKey); }
                  }}
                  tabIndex={0}
                  aria-selected={isSel}
                >
                  <td><StatusLabel status={st.cls}>{st.label}</StatusLabel></td>
                  <td>
                    <div className="inst-name">
                      <span className="swatch" style={{ background: colorOf(inst.id) }} aria-hidden="true" />
                      <span>{inst.name}</span>
                    </div>
                    <a className="inst-host" href={`${inst.url}/admin/`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                      {hostOf(inst.url)} <IconExternal size={11} />
                    </a>
                  </td>
                  {online ? (
                    <>
                      <td>
                        <BlockingControl compact targets={[inst.id]} state={inst.blocking?.state ?? 'unknown'} remaining={remaining} readOnly={readOnly} />
                      </td>
                      <td className="num mono">{fmtCompact(s.total)}</td>
                      <td className="num mono">{s.percentBlocked.toFixed(1)}%</td>
                      <td className="num mono">{s.frequency.toFixed(1)}<span className="dim">/s</span></td>
                      <td className="num mono">{s.activeClients}</td>
                      <td className="num mono">{fmtMs(inst.latencyMs)}</td>
                      <td><Gauge value={inst.system?.cpuPercent} /></td>
                      <td><Gauge value={inst.system?.memPercent} /></td>
                      <td className="num mono">{inst.system?.uptime != null ? fmtDuration(inst.system.uptime) : '—'}</td>
                      <td>
                        <span
                          className="mono"
                          title={inst.version ? `Core ${inst.version.core ?? '?'} · Web ${inst.version.web ?? '?'} · FTL ${inst.version.ftl ?? '?'}` : undefined}
                        >
                          {inst.version?.core ?? '—'}
                        </span>
                        {inst.version?.updateAvailable && (
                          <span className="tag tag-warning" title="Update available"><IconArrowUp size={10} /> update</span>
                        )}
                      </td>
                    </>
                  ) : (
                    <td colSpan={10} className="row-error">
                      <span className="error-text">{inst.error ?? 'Waiting for first response…'}</span>
                      {inst.lastSeen && <span className="dim"> · last seen {fmtAgo(inst.lastSeen, now)}</span>}
                    </td>
                  )}
                  <td><Heartbeat beats={inst.heartbeat} /></td>
                  <td className="num mono dim">{fmtAgo(inst.lastUpdated, now)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
