import {useMemo, useRef, useState} from 'react';
import type {InstanceState} from '../server/types.js';
import {
  isSessionError,
  useDashboard,
  useNow,
  useSession,
  useTheme,
  type Connection,
  type Theme,
} from './lib/useDashboard.js';
import {aggregate} from './lib/aggregate.js';
import {fmtAgo} from './lib/format.js';
import {StatPanels} from './components/StatPanels.js';
import {InstanceTable} from './components/InstanceTable.js';
import {HistoryChart} from './components/HistoryChart.js';
import {RankedList, upstreamExtra} from './components/RankedList.js';
import {QueryLog} from './components/QueryLog.js';
import {EventLog} from './components/EventLog.js';
import {BlockingControl} from './components/BlockingControl.js';
import {Login} from './components/Login.js';
import {Settings, type SettingsMode} from './components/Settings.js';
import {StatusLabel, type Status} from './components/Panel.js';
import {
  IconAuto,
  IconLogo,
  IconLogout,
  IconMoon,
  IconPlus,
  IconSettings,
  IconSun,
  IconX,
} from './components/Icons.js';

// Categorical slots, assigned by config order so an instance keeps its colour
// regardless of filtering. Past eight, instances fall back to neutral grey.
const SERIES = Array.from({length: 8}, (_, i) => `var(--series-${i + 1})`);

const CONNECTION: Record<Connection, {label: string; cls: Status}> = {
  live: {label: 'Live', cls: 'good'},
  connecting: {label: 'Connecting', cls: 'unknown'},
  reconnecting: {label: 'Reconnecting', cls: 'warning'},
  closed: {label: 'Disconnected', cls: 'critical'},
};

function HealthBanner({
  instances,
  names,
}: {
  instances: InstanceState[];
  names: Record<string, string>;
}) {
  const down = instances.filter(
    i => i.status === 'offline' || i.status === 'auth_error',
  );
  const pending = instances.filter(i => i.status === 'connecting');
  const level: Status =
    down.length === 0
      ? 'good'
      : down.length === instances.length
        ? 'critical'
        : 'serious';
  const title =
    down.length === 0
      ? pending.length
        ? `Waiting on ${pending.length} instance${pending.length > 1 ? 's' : ''}`
        : 'All instances operational'
      : `${down.length} of ${instances.length} instance${instances.length > 1 ? 's' : ''} degraded`;
  return (
    <div className={`health health-${level}`} role="status">
      <StatusLabel status={level}>{title}</StatusLabel>
      {down.length > 0 && (
        <span className="health-detail">
          {down.map(i => (
            <span key={i.id}>
              <strong>{names[i.id]}</strong> {i.error}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function NoPasswordBanner({
  onSet,
  onDismiss,
}: {
  onSet: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="health health-warning" role="status">
      <StatusLabel status="warning">No dashboard password</StatusLabel>
      <span className="health-detail">
        Anyone who can reach this page can view DNS activity and change
        settings.
      </span>
      <span className="banner-actions">
        <button className="btn" onClick={onSet}>
          Set a password
        </button>
        <button
          className="btn btn-icon"
          onClick={onDismiss}
          title="Hide for this browser session"
          aria-label="Dismiss"
        >
          <IconX size={12} />
        </button>
      </span>
    </div>
  );
}

function UpdateBanner() {
  return (
    <div className="health health-serious" role="status">
      <StatusLabel status="warning">The dashboard has been updated</StatusLabel>
      <span className="health-detail">
        This page is running the previous version.
      </span>
      <button className="btn" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}

export function App() {
  const {session, login, logout} = useSession();
  const theme = useTheme();
  if (!session) return <div className="loading">Connecting…</div>;
  if (isSessionError(session)) {
    return <div className="loading">{session.error}. Retrying…</div>;
  }
  if (session.authRequired && !session.authenticated) {
    return <Login onLogin={login} />;
  }
  return (
    <Dashboard onLogout={session.authRequired ? logout : null} theme={theme} />
  );
}

interface DashboardProps {
  onLogout: (() => Promise<void>) | null;
  theme: {theme: Theme; cycle: () => void};
}

function Dashboard({onLogout, theme: {theme, cycle}}: DashboardProps) {
  const {data, connection} = useDashboard(true);
  const now = useNow(1000);
  const [selected, setSelected] = useState(() => new Set<string>());
  const [settings, setSettings] = useState<SettingsMode | null>(null);
  const [noPasswordDismissed, setNoPasswordDismissed] = useState(() => {
    try {
      return sessionStorage.getItem('pfd:no-password-dismissed') === '1';
    } catch {
      return false;
    }
  });
  function dismissNoPassword(): void {
    setNoPasswordDismissed(true);
    try {
      sessionStorage.setItem('pfd:no-password-dismissed', '1');
    } catch {
      /* storage unavailable */
    }
  }

  // The server was upgraded while this tab stayed open: the page is running old code.
  const firstBuild = useRef<string | null | undefined>(undefined);
  if (data && firstBuild.current === undefined) {
    firstBuild.current = data.buildId;
  }
  const outdated = Boolean(
    data &&
    data.buildId &&
    firstBuild.current &&
    data.buildId !== firstBuild.current,
  );

  const instances = data?.instances ?? [];
  const colorIndex = useMemo(
    () => new Map(instances.map((i, idx) => [i.id, idx])),
    [instances],
  );
  function colorOf(id: string): string {
    const i = colorIndex.get(id);
    return (i !== undefined && SERIES[i]) || 'var(--text-muted)';
  }
  const instanceNames = useMemo(
    () => Object.fromEntries(instances.map(i => [i.id, i.name])),
    [instances],
  );
  const liveStates = useMemo(
    () => Object.fromEntries(instances.map(i => [i.id, i])),
    [instances],
  );

  // Ignore selections for instances that no longer exist.
  const activeSelection = [...selected].filter(id => colorIndex.has(id));
  const filtered = activeSelection.length > 0;
  const focused = useMemo(
    () => (filtered ? instances.filter(i => selected.has(i.id)) : instances),
    [instances, selected, filtered],
  );
  const agg = useMemo(() => aggregate(focused), [focused]);

  function toggleSelect(id: string, additive: boolean): void {
    setSelected(prev => {
      if (additive) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }
      return prev.size === 1 && prev.has(id)
        ? new Set<string>()
        : new Set([id]);
    });
  }

  const conn = CONNECTION[connection];
  const ThemeIcon =
    theme === 'auto' ? IconAuto : theme === 'light' ? IconSun : IconMoon;

  return (
    <div className="app">
      <header className="topbar">
        <div className="crumbs">
          <IconLogo />
          <span className="product">Pi-hole Fleet</span>
          <span className="sep">/</span>
          {filtered ? (
            <span className="scope">
              {focused.map(i => i.name).join(', ')}
              <button
                className="btn btn-icon"
                onClick={() => setSelected(new Set())}
                title="Clear filter"
              >
                <IconX size={12} />
              </button>
            </span>
          ) : (
            <span className="scope">All instances</span>
          )}
        </div>
        <div className="topbar-meta">
          <span className="meta-item">
            <span className="dim">Range</span> Last 24h
          </span>
          {data && (
            <span className="meta-item">
              <span className="dim">Poll</span> {data.pollIntervalMs / 1000}s
            </span>
          )}
          <span
            className="meta-item"
            title={
              data ? `Last update ${fmtAgo(data.generatedAt, now)}` : undefined
            }
          >
            <StatusLabel status={conn.cls}>{conn.label}</StatusLabel>
            {data && (
              <span className="mono dim"> {fmtAgo(data.generatedAt, now)}</span>
            )}
          </span>
          {data && (
            <BlockingControl
              targets={filtered ? activeSelection : 'all'}
              state={agg.blocking}
              readOnly={data.readOnly}
              scopeLabel={
                filtered ? `${activeSelection.length} selected` : 'all'
              }
            />
          )}
          <button
            className="btn btn-icon"
            onClick={() => setSettings('list')}
            title="Instance settings"
            aria-label="Instance settings"
          >
            <IconSettings />
          </button>
          <button
            className="btn btn-icon"
            onClick={cycle}
            title={`Theme: ${theme} (click to change)`}
            aria-label="Change theme"
          >
            <ThemeIcon />
          </button>
          {onLogout && (
            <button
              className="btn btn-icon"
              onClick={onLogout}
              title="Sign out"
              aria-label="Sign out"
            >
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
      ) : instances.length === 0 ? (
        <div className="welcome-wrap">
          {outdated && <UpdateBanner />}
          <section className="panel welcome">
            <h2 className="welcome-title">No Pi-holes configured yet</h2>
            <p className="dim">
              {data.canManage
                ? 'Add your first instance to start monitoring.'
                : 'Instances can’t be added right now; open settings (gear icon) to see why.'}
            </p>
            {data.canManage && (
              <button
                className="btn btn-primary"
                onClick={() => setSettings('add')}
              >
                <IconPlus size={12} /> Add instance
              </button>
            )}
          </section>
        </div>
      ) : (
        <main className="grid">
          {outdated && (
            <div className="span-12">
              <UpdateBanner />
            </div>
          )}
          {!data.authEnabled && !noPasswordDismissed && (
            <div className="span-12">
              <NoPasswordBanner
                onSet={() => setSettings('password')}
                onDismiss={dismissNoPassword}
              />
            </div>
          )}
          <div className="span-12">
            <HealthBanner instances={instances} names={instanceNames} />
          </div>
          <div className="span-12">
            <StatPanels agg={agg} />
          </div>
          <InstanceTable
            instances={instances}
            selected={selected}
            onSelect={toggleSelect}
            colorOf={colorOf}
            readOnly={data.readOnly}
            now={now}
          />
          <HistoryChart
            className="span-8"
            history={agg.history}
            instances={focused}
            colorOf={colorOf}
          />
          <EventLog
            className="span-4"
            events={data.events ?? []}
            instanceNames={instanceNames}
            focusedIds={filtered ? selected : null}
          />
          <RankedList
            title="Top permitted domains"
            meta="24h"
            items={agg.topDomains}
            barColor="var(--allowed-wash)"
            nameHeader="Domain"
            instanceNames={instanceNames}
          />
          <RankedList
            title="Top blocked domains"
            meta="24h"
            items={agg.topBlocked}
            barColor="var(--blocked-wash)"
            nameHeader="Domain"
            instanceNames={instanceNames}
          />
          <RankedList
            title="Top clients"
            meta="24h"
            items={agg.topClients}
            barColor="var(--neutral-wash)"
            nameHeader="Client"
            instanceNames={instanceNames}
          />
          <QueryLog
            className="span-8"
            queries={agg.queries}
            instanceNames={instanceNames}
            colorOf={colorOf}
          />
          <div className="span-4 stack">
            <RankedList
              title="Upstreams"
              meta="24h"
              className=""
              items={agg.upstreams}
              barColor="var(--neutral-wash)"
              nameHeader="Server"
              instanceNames={instanceNames}
              extra={upstreamExtra}
            />
            <RankedList
              title="Query types"
              meta="24h"
              className=""
              items={agg.queryTypes}
              barColor="var(--neutral-wash)"
              nameHeader="Type"
              instanceNames={instanceNames}
            />
          </div>
        </main>
      )}
      {settings && (
        <Settings
          initialMode={settings}
          onClose={() => setSettings(null)}
          liveStates={liveStates}
          colorOf={colorOf}
        />
      )}
    </div>
  );
}
