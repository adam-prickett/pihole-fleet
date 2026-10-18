import {useCallback, useEffect, useMemo, useState, type FormEvent} from 'react';
import type {
  InstanceState,
  PublicInstance,
  ReplicaStatus,
  ReplicaSyncState,
  SyncDiff,
  SyncItem,
  SyncResponse,
  SyncSettings,
} from '../../server/types.js';
import {fmtAgo} from '../lib/format.js';
import {instancesApi, syncApi, useNow} from '../lib/useDashboard.js';
import {StatusLabel, type Status} from './Panel.js';

const ITEMS: Array<{id: SyncItem; label: string; hint: string}> = [
  {id: 'adlists', label: 'Adlists', hint: 'Blocklists and allowlists'},
  {
    id: 'domains',
    label: 'Domains',
    hint: 'Allowed and denied domains, including regex',
  },
  {id: 'clients', label: 'Clients', hint: 'Client definitions and groups'},
  {id: 'localDns', label: 'Local DNS records', hint: 'Local DNS and CNAMEs'},
  {
    id: 'dnsSettings',
    label: 'DNS settings',
    hint: 'Upstream servers, conditional forwarding, blocking mode and other DNS options. Never the interface, port or the Pi-hole’s own addresses.',
  },
];

const STATE: Record<ReplicaSyncState, {cls: Status; label: string}> = {
  in_sync: {cls: 'good', label: 'In sync'},
  drift: {cls: 'warning', label: 'Differs'},
  syncing: {cls: 'unknown', label: 'Syncing…'},
  error: {cls: 'serious', label: 'Error'},
  unknown: {cls: 'unknown', label: 'Not checked'},
};

const TABLE_LABELS: Record<string, string> = {
  groups: 'Groups',
  adlists: 'Adlists',
  domains: 'Domains',
  clients: 'Clients',
};

/** The form's editable fields. */
interface FormState {
  primaryId: string;
  excluded: string[];
  items: Record<SyncItem, boolean>;
  auto: boolean;
  intervalMin: string;
  runGravity: boolean;
}

function toForm(s: SyncSettings): FormState {
  return {
    primaryId: s.primaryId ?? '',
    excluded: s.excluded,
    items: {...s.items},
    auto: s.auto,
    intervalMin: String(s.intervalMin),
    runGravity: s.runGravity,
  };
}

function toPatch(f: FormState, s: SyncSettings): Partial<SyncSettings> {
  const patch: Partial<SyncSettings> = {};
  const primaryId = f.primaryId || null;
  if (primaryId !== s.primaryId) patch.primaryId = primaryId;
  if ([...f.excluded].sort().join() !== [...s.excluded].sort().join()) {
    patch.excluded = f.excluded;
  }
  if (JSON.stringify(f.items) !== JSON.stringify(s.items)) {
    patch.items = f.items;
  }
  if (f.auto !== s.auto) patch.auto = f.auto;
  if (Number(f.intervalMin) !== s.intervalMin) {
    patch.intervalMin = Number(f.intervalMin);
  }
  if (f.runGravity !== s.runGravity) patch.runGravity = f.runGravity;
  return patch;
}

function DiffDetails({diff}: {diff: SyncDiff}) {
  const keys = diff.config;
  return (
    <ul className="diff-list">
      {Object.entries(diff.gravity).map(([table, d]) => (
        <li key={table}>
          {TABLE_LABELS[table] ?? table}:{' '}
          {[
            d.added && `${d.added} to add`,
            d.removed && `${d.removed} to remove`,
            d.changed && `${d.changed} changed`,
          ]
            .filter(Boolean)
            .join(', ')}
        </li>
      ))}
      {keys.length > 0 && (
        <li>
          {keys.length} setting{keys.length > 1 ? 's' : ''}:{' '}
          <span className="mono">
            {keys.slice(0, 4).join(', ')}
            {keys.length > 4 ? ` +${keys.length - 4} more` : ''}
          </span>
        </li>
      )}
    </ul>
  );
}

function ReplicaDetail({r, now}: {r: ReplicaStatus; now: number}) {
  return (
    <>
      {r.error && <div className="error-text">{r.error}</div>}
      {r.state === 'drift' && r.drift && <DiffDetails diff={r.drift} />}
      {r.skipped.length > 0 && (
        <div className="hint">
          Not copied (set by an environment variable on this Pi-hole):{' '}
          <span className="mono">{r.skipped.join(', ')}</span>
        </div>
      )}
      <div className="hint">
        {r.syncedAt ? `Last synced ${fmtAgo(r.syncedAt, now)}` : 'Never synced'}
        {r.checkedAt ? ` · checked ${fmtAgo(r.checkedAt, now)}` : ''}
      </div>
    </>
  );
}

interface SyncTabProps {
  liveStates: Record<string, InstanceState>;
  colorOf: (id: string) => string;
  onDirtyChange: (dirty: boolean) => void;
}

/** Sync tab: choose a primary Pi-hole and keep the others mirroring it. */
export function SyncTab({liveStates, colorOf, onDirtyChange}: SyncTabProps) {
  const [data, setData] = useState<SyncResponse | null>(null);
  const [instances, setInstances] = useState<PublicInstance[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSync, setConfirmSync] = useState(false);
  const now = useNow(5000);

  const refresh = useCallback(async (resetForm: boolean) => {
    try {
      const d = await syncApi.get();
      setData(d);
      if (resetForm) setForm(toForm(d.settings));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    instancesApi
      .list()
      .then(l => setInstances(l.instances))
      .catch((err: Error) => setError(err.message));
  }, [refresh]);

  // Follow a running check or sync.
  const running = data?.status.running;
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => void refresh(false), 1500);
    return () => clearInterval(id);
  }, [running, refresh]);

  const patch = useMemo(
    () => (data && form ? toPatch(form, data.settings) : {}),
    [form, data],
  );
  const dirty = Object.keys(patch).length > 0;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  if (!data || !form) {
    return error ? (
      <div className="notice notice-critical">{error}</div>
    ) : (
      <div className="empty">Loading…</div>
    );
  }

  const {status, canEdit} = data;
  const name = (id: string) => instances.find(i => i.id === id)?.name ?? id;
  const replicas = instances.filter(i => i.id !== form.primaryId);
  const statusOf = new Map(status.replicas.map(r => [r.id, r]));
  const mirroring = replicas.filter(i => !form.excluded.includes(i.id));
  const anyItem = Object.values(form.items).some(Boolean);
  const savedPrimary = data.settings.primaryId;

  function update(p: Partial<FormState>): void {
    setForm(f => (f ? {...f, ...p} : f));
  }

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await syncApi.update(patch);
      setData(d);
      setForm(toForm(d.settings));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function start(mode: 'check' | 'run'): Promise<void> {
    setError(null);
    setConfirmSync(false);
    try {
      setData(await syncApi[mode]());
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (instances.length < 2) {
    return (
      <div className="empty">
        Add at least two Pi-holes to keep their configuration in sync.
      </div>
    );
  }

  return (
    <form className="settings-form" onSubmit={e => void save(e)}>
      {!canEdit && <div className="notice">{data.reason}</div>}

      <h3 className="section-title">Primary</h3>
      <label className="field field-wide">
        <span className="field-label">Mirror the configuration of</span>
        <select
          className="input"
          value={form.primaryId}
          onChange={e => update({primaryId: e.target.value})}
          disabled={!canEdit}
        >
          <option value="">Nobody (sync off)</option>
          {instances.map(i => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <span className="hint">
          Make changes on the primary’s own admin page; the other Pi-holes copy
          them. Anything changed directly on a replica is overwritten at the
          next sync.
        </span>
      </label>

      {form.primaryId && (
        <>
          <h3 className="section-title">What to mirror</h3>
          <div className="check-grid">
            {ITEMS.map(item => (
              <label className="check check-block" key={item.id}>
                <input
                  type="checkbox"
                  checked={form.items[item.id]}
                  onChange={e =>
                    update({
                      items: {...form.items, [item.id]: e.target.checked},
                    })
                  }
                  disabled={!canEdit}
                />
                <span>
                  {item.label}
                  <span className="hint">{item.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="hint">
            Groups are copied whenever adlists, domains or clients are, so group
            assignments stay correct. DHCP and the web interface’s own settings
            are never copied.
          </p>

          <h3 className="section-title">Replicas</h3>
          <div className="table-scroll">
            <table className="grid-table settings-table">
              <thead>
                <tr>
                  <th>Mirror</th>
                  <th>Instance</th>
                  <th>Sync status</th>
                </tr>
              </thead>
              <tbody>
                {replicas.map(inst => {
                  const on = !form.excluded.includes(inst.id);
                  const r =
                    form.primaryId === savedPrimary
                      ? statusOf.get(inst.id)
                      : undefined;
                  const st = STATE[r?.state ?? 'unknown'];
                  return (
                    <tr key={inst.id}>
                      <td>
                        <input
                          type="checkbox"
                          className="row-check"
                          checked={on}
                          aria-label={`Mirror the primary on ${inst.name}`}
                          onChange={e =>
                            update({
                              excluded: e.target.checked
                                ? form.excluded.filter(x => x !== inst.id)
                                : [...form.excluded, inst.id],
                            })
                          }
                          disabled={!canEdit}
                        />
                      </td>
                      <td>
                        <span className="inst-name">
                          <span
                            className="swatch"
                            style={{background: colorOf(inst.id)}}
                          />
                          {inst.name}
                        </span>
                        {liveStates[inst.id]?.status !== 'online' && (
                          <div className="hint">Currently unreachable</div>
                        )}
                      </td>
                      <td className="sync-cell">
                        {!on ? (
                          <span className="dim">Not mirrored</span>
                        ) : (
                          <>
                            <StatusLabel status={st.cls}>
                              {st.label}
                            </StatusLabel>
                            {r && <ReplicaDetail r={r} now={now} />}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {status.primaryError && form.primaryId === savedPrimary && (
            <div className="notice notice-critical">{status.primaryError}</div>
          )}
          <p className="hint">
            Replicas need a password that can change settings: the admin
            password, or an app password with{' '}
            <span className="mono">webserver.api.app_sudo</span> enabled.
          </p>

          <h3 className="section-title">Schedule</h3>
          <div className="field">
            <div className="inline-fields inline-center">
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.auto}
                  onChange={e => update({auto: e.target.checked})}
                  disabled={!canEdit}
                />
                Sync automatically every
              </label>
              <input
                className="input mono narrow"
                type="number"
                min={5}
                max={1440}
                step={1}
                value={form.intervalMin}
                onChange={e => update({intervalMin: e.target.value})}
                disabled={!canEdit || !form.auto}
                aria-label="Sync interval in minutes"
              />
              <span className="dim">minutes</span>
            </div>
            <span className="hint">
              Each run compares first and only writes to replicas that differ.
              {form.auto && !data.settings.auto
                ? ' Once saved, the next run overwrites differences on the replicas.'
                : ''}
              {status.nextRun
                ? ` Next run in ${Math.max(1, Math.round((status.nextRun - now) / 60_000))} min.`
                : ''}
            </span>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={form.runGravity}
              onChange={e => update({runGravity: e.target.checked})}
              disabled={!canEdit}
            />
            Update gravity on a replica after its adlists change (downloads the
            lists; can take a few minutes)
          </label>
        </>
      )}

      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}

      {confirmSync && (
        <div className="notice" role="alertdialog">
          This replaces the selected configuration on {mirroring.length} replica
          {mirroring.length === 1 ? '' : 's'} with {name(savedPrimary ?? '')}’s.
          A replica restarts its DNS service for a few seconds when lists are
          copied.
          <div className="form-actions">
            <span className="spacer" />
            <button
              type="button"
              className="btn"
              onClick={() => setConfirmSync(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void start('run')}
            >
              Sync now
            </button>
          </div>
        </div>
      )}

      <div className="form-actions">
        {savedPrimary && !dirty && (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => void start('check')}
              disabled={!canEdit || Boolean(running)}
              title="Compare the replicas with the primary without changing anything"
            >
              {running === 'check' ? 'Checking…' : 'Check now'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setConfirmSync(true)}
              disabled={
                !canEdit ||
                Boolean(running) ||
                !anyItem ||
                mirroring.length === 0
              }
            >
              {running === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
            {status.lastRun && !running && (
              <span className="hint">
                Last run {fmtAgo(status.lastRun, now)}
              </span>
            )}
          </>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          disabled={!dirty || busy}
          onClick={() => {
            setForm(toForm(data.settings));
            setError(null);
          }}
        >
          Discard
        </button>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={!dirty || busy || !canEdit}
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
