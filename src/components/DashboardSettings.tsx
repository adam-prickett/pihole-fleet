import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import type {
  SettingsResponse,
  SettingsValues,
  TrustProxy,
} from '../../server/types.js';
import {settingsApi} from '../lib/useDashboard.js';
import {IconLock} from './Icons.js';

type ProxyMode = 'off' | 'all' | 'hops' | 'list';

/** The form's (string) field values. */
interface FormState {
  allowedHosts: string;
  proxyMode: ProxyMode;
  proxyHops: string;
  proxyList: string;
  pollSec: string;
  sessionHours: string;
  maxStreams: string;
  readOnly: boolean;
}

function toForm(v: SettingsValues): FormState {
  const tp = v.trustProxy;
  return {
    allowedHosts: v.allowedHosts?.join(', ') ?? '',
    proxyMode:
      tp === false
        ? 'off'
        : tp === true
          ? 'all'
          : typeof tp === 'number'
            ? 'hops'
            : 'list',
    proxyHops: typeof tp === 'number' ? String(tp) : '1',
    proxyList: typeof tp === 'string' ? tp : '',
    pollSec: String(v.pollIntervalMs / 1000),
    sessionHours: String(v.sessionHours),
    maxStreams: String(v.maxStreams),
    readOnly: v.readOnly,
  };
}

function splitHosts(s: string): string[] {
  return s
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);
}

function ipv4(s: string): number | null {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s)
    ? s.split('.').reduce((n, o) => n * 256 + Number(o), 0)
    : null;
}

function isIp(s: string): boolean {
  return ipv4(s) !== null || s.includes(':');
}

/** Mirrors the server's host check closely enough to warn before a lock-out (IPv6 subnets aren't checked). */
function hostAllowed(
  host: string,
  hosts: string[],
  autoNames: string[],
): boolean {
  if (host === 'localhost' || host.startsWith('127.') || host === '::1') {
    return true;
  }
  if (hosts.length === 0) return isIp(host) || autoNames.includes(host);
  if (hosts.includes('*') || hosts.includes(host)) return true;
  const ip = ipv4(host);
  return hosts.some(h => {
    const [net, bits] = h.split('/');
    if (bits === undefined) return false;
    const base = ipv4(net);
    if (ip === null || base === null) return h.includes(':'); // IPv6: let the server decide
    const block = 2 ** (32 - Number(bits)); // addresses per subnet
    return Math.floor(ip / block) === Math.floor(base / block);
  });
}

/** The changed, unlocked fields as an API patch. */
function toPatch(
  form: FormState,
  data: SettingsResponse,
): Partial<SettingsValues> {
  const v = data.values;
  const locked = data.locked;
  const patch: Partial<SettingsValues> = {};
  const hosts = splitHosts(form.allowedHosts);
  if (
    !locked.allowedHosts &&
    (hosts.length || v.allowedHosts) &&
    hosts.join(',') !== (v.allowedHosts ?? []).join(',')
  ) {
    patch.allowedHosts = hosts;
  }
  const proxyValues: Record<ProxyMode, TrustProxy> = {
    off: false,
    all: true,
    hops: Number(form.proxyHops),
    list: form.proxyList.trim(),
  };
  const tp = proxyValues[form.proxyMode];
  if (!locked.trustProxy && tp !== v.trustProxy) patch.trustProxy = tp;
  const nums: Array<
    ['pollIntervalMs' | 'sessionHours' | 'maxStreams', number]
  > = [
    ['pollIntervalMs', Number(form.pollSec) * 1000],
    ['sessionHours', Number(form.sessionHours)],
    ['maxStreams', Number(form.maxStreams)],
  ];
  for (const [k, n] of nums) {
    if (!locked[k] && n !== v[k]) patch[k] = n;
  }
  if (!locked.readOnly && form.readOnly !== v.readOnly) {
    patch.readOnly = form.readOnly;
  }
  return patch;
}

function Locked({by}: {by: string | undefined}) {
  if (!by) return null;
  return (
    <span className="hint locked-note">
      <IconLock size={10} /> Set by{' '}
      {by === 'config file' ? (
        'the config file'
      ) : (
        <span className="mono">{by}</span>
      )}
      ; change it there.
    </span>
  );
}

export function DashboardTab({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    settingsApi
      .get()
      .then(d => {
        setData(d);
        setForm(toForm(d.values));
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const patch = useMemo(
    () => (data && form ? toPatch(form, data) : {}),
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

  const {locked, canEdit} = data;
  function set(key: keyof FormState) {
    return (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const t = e.target;
      const value =
        t instanceof HTMLInputElement && t.type === 'checkbox'
          ? t.checked
          : t.value;
      setForm(f => (f ? {...f, [key]: value} : f));
      setSaved(false);
    };
  }
  function disabled(key: keyof SettingsValues): boolean {
    return !canEdit || Boolean(locked[key]);
  }
  const hosts = splitHosts(form.allowedHosts);
  const missingCurrent =
    !locked.allowedHosts &&
    !hostAllowed(data.currentHost, hosts, data.autoAllowedHosts);

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await settingsApi.update(patch);
      setData(d);
      setForm(toForm(d.values));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={e => void save(e)}>
      {!canEdit && <div className="notice">{data.reason}</div>}

      <h3 className="section-title">Access</h3>
      <label className="field">
        <span className="field-label">Allowed hosts</span>
        <input
          className="input mono"
          value={form.allowedHosts}
          onChange={set('allowedHosts')}
          disabled={disabled('allowedHosts')}
          spellCheck={false}
          placeholder="Not set: any IP address is allowed"
        />
        <Locked by={locked.allowedHosts} />
        {!locked.allowedHosts && (
          <span className="hint">
            Optional. Hostnames, IP addresses or subnets (e.g.{' '}
            <span className="mono">10.1.68.0/24</span>) you use to open the
            dashboard, comma-separated. Left empty, any IP address works, plus
            this server’s own name
            {data.autoAllowedHosts.length ? (
              <>
                {' '}
                (
                <span className="mono">{data.autoAllowedHosts.join(', ')}</span>
                )
              </>
            ) : null}
            ; add a DNS name like <span className="mono">dashboard.lan</span> to
            use one. Other hostnames are refused, which blocks DNS-rebinding
            attacks. <span className="mono">*</span> turns the check off (not
            recommended).
          </span>
        )}
        {missingCurrent && (
          <span className="hint warning-text">
            “{data.currentHost}” (the address you’re using now) isn’t listed, so
            saving would lock you out.{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                setForm(f =>
                  f
                    ? {
                        ...f,
                        allowedHosts: [...hosts, data.currentHost].join(', '),
                      }
                    : f,
                )
              }
            >
              Add it
            </button>
          </span>
        )}
      </label>

      <div className="field">
        <span className="field-label">Reverse proxy</span>
        <div className="inline-fields">
          <select
            className="input"
            value={form.proxyMode}
            onChange={set('proxyMode')}
            disabled={disabled('trustProxy')}
          >
            <option value="off">None — clients connect directly</option>
            <option value="hops">Behind proxies (hop count)</option>
            <option value="list">Behind proxies at specific addresses</option>
            <option value="all">Trust any proxy (not recommended)</option>
          </select>
          {form.proxyMode === 'hops' && (
            <input
              className="input mono narrow"
              type="number"
              min={1}
              max={10}
              value={form.proxyHops}
              onChange={set('proxyHops')}
              disabled={disabled('trustProxy')}
              aria-label="Proxy hop count"
            />
          )}
          {form.proxyMode === 'list' && (
            <input
              className="input mono grow"
              value={form.proxyList}
              onChange={set('proxyList')}
              disabled={disabled('trustProxy')}
              placeholder="172.16.0.0/12, 10.0.0.5"
              spellCheck={false}
              aria-label="Proxy addresses"
            />
          )}
        </div>
        <Locked by={locked.trustProxy} />
        {!locked.trustProxy && (
          <span className="hint">
            Lets the dashboard see real client IPs (for rate limits and the
            audit log) and detect HTTPS behind a proxy.
          </span>
        )}
      </div>

      <div className="field-row">
        <label className="field">
          <span className="field-label">Session timeout (hours)</span>
          <input
            className="input mono"
            type="number"
            min={0.25}
            max={720}
            step="any"
            value={form.sessionHours}
            onChange={set('sessionHours')}
            disabled={disabled('sessionHours')}
          />
          <Locked by={locked.sessionHours} />
        </label>
        <label className="field">
          <span className="field-label">Live connection limit</span>
          <input
            className="input mono"
            type="number"
            min={1}
            max={1000}
            value={form.maxStreams}
            onChange={set('maxStreams')}
            disabled={disabled('maxStreams')}
          />
          <Locked by={locked.maxStreams} />
        </label>
      </div>

      <h3 className="section-title">Behaviour</h3>
      <label className="field field-narrow">
        <span className="field-label">Poll interval (seconds)</span>
        <input
          className="input mono"
          type="number"
          min={1}
          max={300}
          value={form.pollSec}
          onChange={set('pollSec')}
          disabled={disabled('pollIntervalMs')}
        />
        <Locked by={locked.pollIntervalMs} />
      </label>
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={form.readOnly}
            onChange={set('readOnly')}
            disabled={disabled('readOnly')}
          />
          Read-only mode — hide blocking controls and lock the instance list
        </label>
        <Locked by={locked.readOnly} />
      </div>

      <h3 className="section-title">Server</h3>
      <dl className="facts">
        <dt>Port</dt>
        <dd className="mono">{data.server.port}</dd>
        <dt>Listening on</dt>
        <dd className="mono">{data.server.host}</dd>
        <dt>Data directory</dt>
        <dd className="mono">{data.server.dataDir}</dd>
      </dl>
      <p className="hint">
        These are set when the server starts (<span className="mono">PORT</span>
        , <span className="mono">HOST</span>,{' '}
        <span className="mono">DATA_DIR</span>).
      </p>

      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions">
        {saved && !dirty && (
          <span className="status status-good">
            <span className="led" aria-hidden="true" />
            Saved
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          disabled={!dirty || busy}
          onClick={() => {
            setForm(toForm(data.values));
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
