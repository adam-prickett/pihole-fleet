import type {
  Heartbeat as Beat,
  InstanceState,
  InstanceStatus,
  ReplicaSyncState,
  SyncSummary,
} from '../../server/types.js';
import {fmtAgo, fmtCompact, fmtDuration, fmtMs, hostOf} from '../lib/format.js';
import {BlockingControl} from './BlockingControl.js';
import {IconArrowUp, IconExternal} from './Icons.js';
import {Panel, StatusLabel, type Status} from './Panel.js';

const STATUS: Record<InstanceStatus, {label: string; cls: Status}> = {
  online: {label: 'Up', cls: 'good'},
  offline: {label: 'Down', cls: 'critical'},
  auth_error: {label: 'Auth', cls: 'serious'},
  connecting: {label: 'Pending', cls: 'unknown'},
};

const SYNC_TAG: Record<ReplicaSyncState, {cls: string; label: string}> = {
  in_sync: {cls: 'tag-ok', label: 'IN SYNC'},
  drift: {cls: 'tag-warning', label: 'DIFFERS'},
  syncing: {cls: 'tag-neutral', label: 'SYNCING'},
  error: {cls: 'tag-blocked', label: 'SYNC ERROR'},
  unknown: {cls: 'tag-neutral', label: 'REPLICA'},
};

/** PRIMARY, or a replica's sync state. */
function SyncTag({id, sync}: {id: string; sync: SyncSummary | null}) {
  if (!sync) return null;
  if (sync.primaryId === id) {
    return (
      <span
        className="tag tag-neutral tag-role"
        title="Other Pi-holes mirror this one"
      >
        PRIMARY
      </span>
    );
  }
  const state = sync.replicas[id];
  if (!state) return null;
  const t = SYNC_TAG[state];
  return (
    <span
      className={`tag ${t.cls} tag-role`}
      title="Mirrors the primary (see Settings → Sync)"
    >
      {t.label}
    </span>
  );
}

function level(pct: number): string {
  if (pct >= 90) return 'critical';
  if (pct >= 75) return 'warning';
  return 'normal';
}

function Gauge({value}: {value: number | null | undefined}) {
  if (value == null) return <span className="dim">—</span>;
  return (
    <span className={`gauge gauge-${level(value)}`}>
      <span className="gauge-track">
        <span
          className="gauge-fill"
          style={{width: `${Math.min(100, value)}%`}}
        />
      </span>
      <span className="mono">{value.toFixed(0)}%</span>
    </span>
  );
}

/** Last N poll results as a strip: one tick per poll, newest on the right. */
function Heartbeat({beats = [], slots = 60}: {beats?: Beat[]; slots?: number}) {
  const okCount = beats.filter(b => b.ok).length;
  const ms = beats
    .map(b => (b.ok ? b.ms : null))
    .filter((m): m is number => m != null);
  const avg = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
  const pad = slots - beats.length;
  const w = 2;
  const gap = 1;
  return (
    <span
      className="heartbeat"
      title={`Last ${beats.length} polls · ${okCount} OK · avg ${fmtMs(avg)}`}
    >
      <svg
        width={slots * (w + gap)}
        height={14}
        role="img"
        aria-label={`${okCount} of ${beats.length} recent polls succeeded`}
      >
        {Array.from({length: slots}, (_, i) => {
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
      <span className="mono dim">
        {beats.length ? `${((okCount / beats.length) * 100).toFixed(0)}%` : '—'}
      </span>
    </span>
  );
}

interface InstanceTableProps {
  instances: InstanceState[];
  selected: Set<string>;
  /** `additive` adds to (or removes from) the selection instead of replacing it. */
  onSelect: (id: string, additive: boolean) => void;
  colorOf: (id: string) => string;
  readOnly: boolean;
  sync: SyncSummary | null;
  now: number;
}

export function InstanceTable({
  instances,
  selected,
  onSelect,
  colorOf,
  readOnly,
  sync,
  now,
}: InstanceTableProps) {
  const up = instances.filter(i => i.status === 'online').length;
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
            {instances.map(inst => {
              const st = STATUS[inst.status];
              const s = inst.status === 'online' ? inst.summary : undefined;
              const remaining =
                inst.blocking?.timer && inst.lastUpdated
                  ? Math.max(
                      0,
                      inst.blocking.timer - (now - inst.lastUpdated) / 1000,
                    )
                  : null;
              const isSel = selected.has(inst.id);
              return (
                <tr
                  key={inst.id}
                  className={`${isSel ? 'selected' : ''} ${s ? '' : 'row-down'}`}
                  onClick={e =>
                    onSelect(inst.id, e.shiftKey || e.metaKey || e.ctrlKey)
                  }
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(inst.id, e.shiftKey);
                    }
                  }}
                  tabIndex={0}
                  aria-selected={isSel}
                >
                  <td>
                    <StatusLabel status={st.cls}>{st.label}</StatusLabel>
                  </td>
                  <td>
                    <div className="inst-name">
                      <span
                        className="swatch"
                        style={{background: colorOf(inst.id)}}
                        aria-hidden="true"
                      />
                      <span>{inst.name}</span>
                      <SyncTag id={inst.id} sync={sync} />
                    </div>
                    <a
                      className="inst-host"
                      href={`${inst.url}/admin/`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={e => e.stopPropagation()}
                    >
                      {hostOf(inst.url)} <IconExternal size={11} />
                    </a>
                  </td>
                  {s ? (
                    <>
                      <td>
                        <BlockingControl
                          compact
                          targets={[inst.id]}
                          state={inst.blocking?.state ?? 'unknown'}
                          remaining={remaining}
                          readOnly={readOnly}
                        />
                      </td>
                      <td className="num mono">{fmtCompact(s.total)}</td>
                      <td className="num mono">
                        {s.percentBlocked.toFixed(1)}%
                      </td>
                      <td className="num mono">
                        {s.frequency.toFixed(1)}
                        <span className="dim">/s</span>
                      </td>
                      <td className="num mono">{s.activeClients}</td>
                      <td className="num mono">{fmtMs(inst.latencyMs)}</td>
                      <td>
                        <Gauge value={inst.system?.cpuPercent} />
                      </td>
                      <td>
                        <Gauge value={inst.system?.memPercent} />
                      </td>
                      <td className="num mono">
                        {inst.system?.uptime != null
                          ? fmtDuration(inst.system.uptime)
                          : '—'}
                      </td>
                      <td>
                        <span
                          className="mono"
                          title={
                            inst.version
                              ? `Core ${inst.version.core ?? '?'} · Web ${inst.version.web ?? '?'} · FTL ${inst.version.ftl ?? '?'}`
                              : undefined
                          }
                        >
                          {inst.version?.core ?? '—'}
                        </span>
                        {inst.version?.updateAvailable && (
                          <span
                            className="tag tag-warning"
                            title="Update available"
                          >
                            <IconArrowUp size={10} /> update
                          </span>
                        )}
                      </td>
                    </>
                  ) : (
                    <td colSpan={10} className="row-error">
                      <span className="error-text">
                        {inst.error ?? 'Waiting for first response…'}
                      </span>
                      {inst.lastSeen && (
                        <span className="dim">
                          {' '}
                          · last seen {fmtAgo(inst.lastSeen, now)}
                        </span>
                      )}
                    </td>
                  )}
                  <td>
                    <Heartbeat beats={inst.heartbeat} />
                  </td>
                  <td className="num mono dim">
                    {fmtAgo(inst.lastUpdated, now)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
