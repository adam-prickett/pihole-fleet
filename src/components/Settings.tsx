import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import type {
  InstanceState,
  InstanceStatus,
  InstancesResponse,
  PublicInstance,
  TestResult,
} from '../../server/types.js';
import {instancesApi, type InstanceInput} from '../lib/useDashboard.js';
import {DashboardTab} from './DashboardSettings.js';
import {IconEdit, IconLock, IconPlus, IconTrash, IconX} from './Icons.js';
import {PasswordTab} from './PasswordSettings.js';
import {StatusLabel, type Status} from './Panel.js';
import {SyncTab} from './SyncSettings.js';

const STATUS: Record<InstanceStatus, {cls: Status; label: string}> = {
  online: {cls: 'good', label: 'Online'},
  offline: {cls: 'critical', label: 'Offline'},
  auth_error: {cls: 'serious', label: 'Auth error'},
  connecting: {cls: 'unknown', label: 'Connecting'},
};

interface InstanceFormState {
  name: string;
  url: string;
  password: string;
  clearPassword: boolean;
  insecure: boolean;
  timeoutSec: number | string;
}

const emptyForm: InstanceFormState = {
  name: '',
  url: '',
  password: '',
  clearPassword: false,
  insecure: false,
  timeoutSec: 8,
};

/** Which part of the settings to open on. */
export type SettingsMode = 'list' | 'add' | 'password';

type Tab = 'instances' | 'sync' | 'dashboard' | 'password';

const TABS: Array<{id: Tab; label: string}> = [
  {id: 'instances', label: 'Instances'},
  {id: 'sync', label: 'Sync'},
  {id: 'dashboard', label: 'Dashboard'},
  {id: 'password', label: 'Password'},
];

/** Settings modal: Pi-hole instances, config sync, dashboard settings and the password. */
interface SettingsProps {
  onClose: () => void;
  initialMode?: SettingsMode;
  liveStates: Record<string, InstanceState>;
  colorOf: (id: string) => string;
}

export function Settings({
  onClose,
  initialMode = 'list',
  liveStates,
  colorOf,
}: SettingsProps) {
  const [tab, setTab] = useState<Tab>(
    initialMode === 'password' ? 'password' : 'instances',
  );
  const [busy, setBusy] = useState(false); // a form is open: don't close on backdrop click
  const onEditingChange = useCallback((v: boolean) => setBusy(v), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="modal panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="panel-head">
          <h2 className="panel-title" id="settings-title">
            Settings
          </h2>
          <div
            className="segmented"
            role="tablist"
            aria-label="Settings sections"
          >
            {TABS.map(t => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => {
                  setTab(t.id);
                  setBusy(false);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="panel-actions">
            <button
              className="btn btn-icon"
              onClick={onClose}
              aria-label="Close settings"
              title="Close (Esc)"
            >
              <IconX size={12} />
            </button>
          </div>
        </header>
        <div className="modal-body" role="tabpanel">
          {tab === 'instances' && (
            <InstancesTab
              initialMode={initialMode}
              liveStates={liveStates}
              colorOf={colorOf}
              onEditingChange={onEditingChange}
            />
          )}
          {tab === 'sync' && (
            <SyncTab
              liveStates={liveStates}
              colorOf={colorOf}
              onDirtyChange={onEditingChange}
            />
          )}
          {tab === 'dashboard' && (
            <DashboardTab onDirtyChange={onEditingChange} />
          )}
          {tab === 'password' && <PasswordTab />}
        </div>
      </div>
    </div>
  );
}

/** Instances tab: add, edit and remove Pi-hole instances. */
interface InstancesTabProps {
  initialMode: SettingsMode;
  liveStates: Record<string, InstanceState>;
  colorOf: (id: string) => string;
  onEditingChange: (editing: boolean) => void;
}

function InstancesTab({
  initialMode,
  liveStates,
  colorOf,
  onEditingChange,
}: InstancesTabProps) {
  const [list, setList] = useState<InstancesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<'new' | PublicInstance | null>(
    initialMode === 'add' ? 'new' : null,
  );
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);

  const reload = useCallback(async () => {
    try {
      setList(await instancesApi.list());
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    onEditingChange(Boolean(editing));
  }, [editing, onEditingChange]);

  async function remove(inst: PublicInstance): Promise<void> {
    setRowError(null);
    try {
      await instancesApi.remove(inst.id);
      setConfirmRemove(null);
      await reload();
    } catch (err) {
      setRowError({id: inst.id, message: (err as Error).message});
    }
  }

  const canManage = list?.canManage;
  const full = Boolean(list && list.instances.length >= list.maxInstances);

  return (
    <>
      <div className="tab-toolbar">
        <h3 className="section-title">
          {editing === 'new'
            ? 'Add instance'
            : editing
              ? `Edit ${editing.name}`
              : 'Pi-hole instances'}
        </h3>
        {!editing && canManage && (
          <button
            className="btn"
            onClick={() => setEditing('new')}
            disabled={full}
            title={full ? `Limit of ${list.maxInstances} reached` : undefined}
          >
            <IconPlus size={12} /> Add instance
          </button>
        )}
      </div>
      {loadError && <div className="notice notice-critical">{loadError}</div>}
      {list && !canManage && <div className="notice">{list.reason}</div>}

      {editing ? (
        <InstanceForm
          instance={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      ) : !list ? (
        !loadError && <div className="empty">Loading…</div>
      ) : list.instances.length === 0 ? (
        <div className="empty">
          No Pi-holes yet.
          {canManage && ' Use “Add instance” to connect your first one.'}
        </div>
      ) : (
        <div className="table-scroll">
          <table className="grid-table settings-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>URL</th>
                <th>Status</th>
                <th>Login</th>
                <th>Source</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.instances.map(inst => {
                const live =
                  STATUS[liveStates[inst.id]?.status ?? 'connecting'];
                const fromConfig = inst.source !== 'ui';
                return (
                  <tr key={inst.id}>
                    <td>
                      <span className="inst-name">
                        <span
                          className="swatch"
                          style={{background: colorOf(inst.id)}}
                        />
                        {inst.name}
                      </span>
                    </td>
                    <td className="mono dim">
                      {inst.url}
                      {inst.insecure && (
                        <span
                          className="tag tag-warning"
                          title="TLS certificate verification is off"
                        >
                          TLS UNVERIFIED
                        </span>
                      )}
                    </td>
                    <td>
                      <StatusLabel status={live.cls}>{live.label}</StatusLabel>
                    </td>
                    <td className="dim">
                      {inst.hasPassword ? 'Password' : 'None'}
                    </td>
                    <td>
                      {fromConfig ? (
                        <span
                          className="tag tag-neutral"
                          title="Defined in the config file; change it there"
                        >
                          <IconLock size={10} /> FILE
                        </span>
                      ) : (
                        <span className="tag tag-neutral">UI</span>
                      )}
                    </td>
                    <td className="row-actions">
                      {rowError?.id === inst.id && (
                        <span className="error-text">{rowError.message}</span>
                      )}
                      {!fromConfig &&
                        canManage &&
                        (confirmRemove === inst.id ? (
                          <>
                            <span className="dim">Remove?</span>
                            <button
                              className="btn btn-danger"
                              onClick={() => void remove(inst)}
                            >
                              Remove
                            </button>
                            <button
                              className="btn"
                              onClick={() => setConfirmRemove(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="btn btn-icon"
                              onClick={() => setEditing(inst)}
                              aria-label={`Edit ${inst.name}`}
                              title="Edit"
                            >
                              <IconEdit size={12} />
                            </button>
                            <button
                              className="btn btn-icon"
                              onClick={() => setConfirmRemove(inst.id)}
                              aria-label={`Remove ${inst.name}`}
                              title="Remove"
                            >
                              <IconTrash size={12} />
                            </button>
                          </>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!editing && list?.instances.some(i => i.source !== 'ui') && (
        <p className="hint">
          Instances marked FILE come from the config file and can only be
          changed there.
        </p>
      )}
    </>
  );
}

interface InstanceFormProps {
  /** The instance being edited, or null to add a new one. */
  instance: PublicInstance | null;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}

function InstanceForm({instance, onCancel, onSaved}: InstanceFormProps) {
  const [form, setForm] = useState<InstanceFormState>(() =>
    instance
      ? {
          ...emptyForm,
          name: instance.name,
          url: instance.url,
          insecure: instance.insecure,
          timeoutSec: instance.timeoutMs / 1000,
        }
      : emptyForm,
  );
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);

  function set(key: keyof InstanceFormState) {
    return (e: ChangeEvent<HTMLInputElement>) => {
      const value =
        e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      setForm(f => ({...f, [key]: value}));
      setTest(null);
    };
  }

  // Blank password on edit = keep the saved one (the server never sends it back).
  function payload(): InstanceInput {
    const body: InstanceInput = {
      name: form.name.trim(),
      url: form.url.trim(),
      insecure: form.url.trim().startsWith('https:') && form.insecure,
      timeoutMs: Math.round(Number(form.timeoutSec) * 1000),
    };
    if (form.clearPassword) body.password = '';
    else if (form.password || !instance) body.password = form.password;
    return body;
  }

  async function runTest(): Promise<void> {
    setBusy('test');
    setError(null);
    try {
      setTest(await instancesApi.test({...payload(), id: instance?.id}));
    } catch (err) {
      setTest({ok: false, error: (err as Error).message});
    } finally {
      setBusy(null);
    }
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy('save');
    setError(null);
    try {
      if (instance) await instancesApi.update(instance.id, payload());
      else await instancesApi.create(payload());
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  const https = form.url.trim().startsWith('https:');

  return (
    <form className="instance-form" onSubmit={e => void submit(e)}>
      <label className="field">
        <span className="field-label">Name</span>
        <input
          ref={first}
          className="input"
          value={form.name}
          onChange={set('name')}
          maxLength={64}
          placeholder="e.g. Primary"
        />
      </label>
      <label className="field">
        <span className="field-label">URL</span>
        <input
          className="input mono"
          value={form.url}
          onChange={set('url')}
          required
          maxLength={2048}
          placeholder="http://192.168.1.2"
          inputMode="url"
        />
        {form.url.trim().startsWith('http:') && (
          <span className="hint">
            Over plain HTTP the password and session cross your network
            unencrypted.
          </span>
        )}
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={set('password')}
          disabled={form.clearPassword}
          maxLength={512}
          placeholder={
            instance?.hasPassword
              ? 'Unchanged'
              : 'Leave empty if the Pi-hole has no password'
          }
        />
        <span className="hint">
          An app password is best (Pi-hole: Settings → Web interface / API →
          Configure app password).
        </span>
      </label>
      {instance?.hasPassword && (
        <label className="check">
          <input
            type="checkbox"
            checked={form.clearPassword}
            onChange={set('clearPassword')}
          />
          Remove the saved password
        </label>
      )}
      {https && (
        <label className="check">
          <input
            type="checkbox"
            checked={form.insecure}
            onChange={set('insecure')}
          />
          Skip TLS certificate verification (self-signed certificate)
        </label>
      )}
      <label className="field field-narrow">
        <span className="field-label">Timeout (seconds)</span>
        <input
          className="input mono"
          type="number"
          min={1}
          max={60}
          step={1}
          value={form.timeoutSec}
          onChange={set('timeoutSec')}
          required
        />
      </label>

      {test && (
        <div className="test-result" role="status">
          {test.ok ? (
            <StatusLabel status="good">
              Connected{test.version ? ` · Pi-hole ${test.version}` : ''}
            </StatusLabel>
          ) : (
            <StatusLabel status="critical">{test.error}</StatusLabel>
          )}
        </div>
      )}
      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}

      <div className="form-actions">
        <button
          type="button"
          className="btn"
          onClick={() => void runTest()}
          disabled={busy !== null || !form.url.trim()}
        >
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          onClick={onCancel}
          disabled={busy === 'save'}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={busy !== null}
        >
          {busy === 'save'
            ? 'Saving…'
            : instance
              ? 'Save changes'
              : 'Add instance'}
        </button>
      </div>
    </form>
  );
}
