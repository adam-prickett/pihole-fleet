import { useMemo, useState } from 'react';
import { useDashboard, useNow, useSession, useTheme } from './lib/useDashboard.js';
import { aggregate } from './lib/aggregate.js';
import { fmtAgo } from './lib/format.js';
import StatPanels from './components/StatPanels.jsx';
import InstanceTable from './components/InstanceTable.jsx';
import HistoryChart from './components/HistoryChart.jsx';
import RankedList, { upstreamExtra } from './components/RankedList.jsx';
import QueryLog from './components/QueryLog.jsx';
import EventLog from './components/EventLog.jsx';
import BlockingControl from './components/BlockingControl.jsx';
import Login from './components/Login.jsx';
import { StatusLabel } from './components/Panel.jsx';
import { IconAuto, IconLogo, IconLogout, IconMoon, IconSun, IconX } from './components/Icons.jsx';

// Categorical slots, assigned by config order so an instance keeps its colour
// regardless of filtering. Past eight, instances fall back to neutral grey.
const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);

const CONNECTION = {
  live: { label: 'Live', cls: 'good' },
  connecting: { label: 'Connecting', cls: 'unknown' },
  reconnecting: { label: 'Reconnecting', cls: 'warning' },
  closed: { label: 'Disconnected', cls: 'critical' },
};

function HealthBanner({ instances, names }) {
  const down = instances.filter((i) => i.status === 'offline' || i.status === 'auth_error');
  const pending = instances.filter((i) => i.status === 'connecting');
  const level = down.length === 0 ? 'good' : down.length === instances.length ? 'critical' : 'serious';
  const title =
    down.length === 0
      ? pending.length ? `Waiting on ${pending.length} instance${pending.length > 1 ? 's' : ''}` : 'All instances operational'
      : `${down.length} of ${instances.length} instance${instances.length > 1 ? 's' : ''} degraded`;
  return (
    <div className={`health health-${level}`} role="status">
      <StatusLabel status={level}>{title}</StatusLabel>
      {down.length > 0 && (
        <span className="health-detail">
          {down.map((i) => (
            <span key={i.id}><strong>{names[i.id]}</strong> {i.error}</span>
          ))}
        </span>
      )}
    </div>
  );
}

export default function App() {
  const { session, login, logout } = useSession();
  const theme = useTheme();
  const signedIn = Boolean(session && !session.error && (!session.authRequired || session.authenticated));

  if (!session) return <div className="loading">Connecting…</div>;
  if (session.error) return <div className="loading">{session.error}. Retrying…</div>;
  if (!signedIn) return <Login onLogin={login} />;
  return <Dashboard onLogout={session.authRequired ? logout : null} theme={theme} />;
}

function Dashboard({ onLogout, theme: { theme, cycle } }) {
  const { data, connection } = useDashboard(true);
  const now = useNow(1000);
  const [selected, setSelected] = useState(() => new Set());

  const instances = data?.instances ?? [];
  const colorIndex = useMemo(() => new Map(instances.map((i, idx) => [i.id, idx])), [instances]);
  const colorOf = (id) => SERIES[colorIndex.get(id)] ?? 'var(--text-muted)';
  const instanceNames = useMemo(() => Object.fromEntries(instances.map((i) => [i.id, i.name])), [instances]);

  // Ignore selections for instances that no longer exist.
  const activeSelection = [...selected].filter((id) => colorIndex.has(id));
  const filtered = activeSelection.length > 0;
  const focused = useMemo(
    () => (filtered ? instances.filter((i) => selected.has(i.id)) : instances),
    [instances, selected, filtered],
  );
  const agg = useMemo(() => aggregate(focused), [focused]);

  const toggleSelect = (id, additive) => {
    setSelected((prev) => {
      if (additive) {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      }
      return prev.size === 1 && prev.has(id) ? new Set() : new Set([id]);
    });
  };

  const conn = CONNECTION[connection];
  const ThemeIcon = theme === 'auto' ? IconAuto : theme === 'light' ? IconSun : IconMoon;

  return (
    <div className="app">
      <header className="topbar">
        <div className="crumbs">
          <IconLogo />
          <span className="product">Pi-hole Fleet</span>
          <span className="sep">/</span>
          {filtered ? (
            <span className="scope">
              {focused.map((i) => i.name).join(', ')}
              <button className="btn btn-icon" onClick={() => setSelected(new Set())} title="Clear filter">
                <IconX size={12} />
              </button>
            </span>
          ) : (
            <span className="scope">All instances</span>
          )}
        </div>
        <div className="topbar-meta">
          <span className="meta-item"><span className="dim">Range</span> Last 24h</span>
          {data && <span className="meta-item"><span className="dim">Poll</span> {data.pollIntervalMs / 1000}s</span>}
          <span className="meta-item" title={data ? `Last update ${fmtAgo(data.generatedAt, now)}` : undefined}>
            <StatusLabel status={conn.cls}>{conn.label}</StatusLabel>
            {data && <span className="mono dim"> {fmtAgo(data.generatedAt, now)}</span>}
          </span>
          {data && (
            <BlockingControl
              targets={filtered ? activeSelection : 'all'}
              state={agg.blocking}
              readOnly={data.readOnly}
              scopeLabel={filtered ? `${activeSelection.length} selected` : 'all'}
            />
          )}
          <button className="btn btn-icon" onClick={cycle} title={`Theme: ${theme} (click to change)`} aria-label="Change theme">
            <ThemeIcon />
          </button>
          {onLogout && (
            <button className="btn btn-icon" onClick={onLogout} title="Sign out" aria-label="Sign out">
              <IconLogout />
            </button>
          )}
        </div>
      </header>

      {!data ? (
        <div className="loading">
          {connection === 'live' || connection === 'connecting'
            ? 'Connecting to dashboard server…'
            : 'Cannot reach the dashboard server. Is it running?'}
        </div>
      ) : (
        <main className="grid">
          <div className="span-12"><HealthBanner instances={instances} names={instanceNames} /></div>
          <div className="span-12"><StatPanels agg={agg} /></div>
          <InstanceTable
            instances={instances}
            selected={selected}
            onSelect={toggleSelect}
            colorOf={colorOf}
            readOnly={data.readOnly}
            now={now}
          />
          <HistoryChart className="span-8" history={agg.history} instances={focused} colorOf={colorOf} />
          <EventLog
            className="span-4"
            events={data.events ?? []}
            instanceNames={instanceNames}
            focusedIds={filtered ? selected : null}
          />
          <RankedList title="Top permitted domains" meta="24h" items={agg.topDomains} barColor="var(--allowed-wash)" nameHeader="Domain" instanceNames={instanceNames} />
          <RankedList title="Top blocked domains" meta="24h" items={agg.topBlocked} barColor="var(--blocked-wash)" nameHeader="Domain" instanceNames={instanceNames} />
          <RankedList title="Top clients" meta="24h" items={agg.topClients} barColor="var(--neutral-wash)" nameHeader="Client" instanceNames={instanceNames} />
          <QueryLog className="span-8" queries={agg.queries} instanceNames={instanceNames} colorOf={colorOf} />
          <div className="span-4 stack">
            <RankedList title="Upstreams" meta="24h" className="" items={agg.upstreams} barColor="var(--neutral-wash)" nameHeader="Server" instanceNames={instanceNames} extra={upstreamExtra} />
            <RankedList title="Query types" meta="24h" className="" items={agg.queryTypes} barColor="var(--neutral-wash)" nameHeader="Type" instanceNames={instanceNames} />
          </div>
        </main>
      )}
    </div>
  );
}
