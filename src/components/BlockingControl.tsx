import {useEffect, useRef, useState} from 'react';
import {setBlocking} from '../lib/useDashboard.js';
import {fmtDuration} from '../lib/format.js';
import type {FleetBlocking} from '../lib/aggregate.js';
import {IconChevron, IconLock, IconShield, IconShieldOff} from './Icons.js';
import type {Status} from './Panel.js';

const DURATIONS: Array<{label: string; seconds: number | null}> = [
  {label: '30 seconds', seconds: 30},
  {label: '5 minutes', seconds: 300},
  {label: '30 minutes', seconds: 1800},
  {label: '1 hour', seconds: 3600},
  {label: 'Until re-enabled', seconds: null},
];

const STATE: Record<FleetBlocking, {label: string; cls: Status}> = {
  enabled: {label: 'Enabled', cls: 'good'},
  disabled: {label: 'Disabled', cls: 'warning'},
  mixed: {label: 'Mixed', cls: 'warning'},
  unknown: {label: 'Unknown', cls: 'unknown'},
};

/**
 * Enable/disable blocking for one instance, a subset, or "all".
 * `compact` renders the table-cell variant.
 */
interface BlockingControlProps {
  /** Instance ids, or "all". */
  targets: string[] | 'all';
  state: FleetBlocking | 'failed';
  /** Seconds until blocking is re-enabled automatically, if known. */
  remaining?: number | null;
  readOnly: boolean;
  scopeLabel?: string;
  compact?: boolean;
}

export function BlockingControl({
  targets,
  state,
  remaining,
  readOnly,
  scopeLabel,
  compact = false,
}: BlockingControlProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function run(enabled: boolean, seconds: number | null = null) {
    setOpen(false);
    setBusy(true);
    setError(null);
    try {
      await setBlocking(targets, enabled, seconds);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const st = state === 'failed' ? STATE.unknown : STATE[state];
  const locked = readOnly || busy || state === 'unknown';
  const canEnable = state === 'disabled' || state === 'mixed';
  const canDisable = state === 'enabled' || state === 'mixed';

  return (
    <div
      className={`blocking${compact ? ' compact' : ''}`}
      ref={ref}
      onClick={e => e.stopPropagation()}
    >
      {!compact && (
        <span className="blocking-label">
          Blocking{scopeLabel ? ` · ${scopeLabel}` : ''}
        </span>
      )}
      <span className={`status status-${st.cls}`}>
        <span className="led" aria-hidden="true" />
        {st.label}
        {state === 'disabled' && remaining ? (
          <span className="mono dim"> {fmtDuration(remaining)}</span>
        ) : null}
      </span>
      {readOnly ? (
        <span className="dim" title="Dashboard is read-only">
          <IconLock />
        </span>
      ) : (
        <div className="btn-group">
          {canEnable && (
            <button
              className="btn"
              disabled={locked}
              onClick={() => void run(true)}
              title="Enable blocking"
            >
              <IconShield /> {!compact && 'Enable'}
            </button>
          )}
          {canDisable && (
            <div className="popover-anchor">
              <button
                className="btn"
                disabled={locked}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(o => !o)}
                title="Disable blocking"
              >
                <IconShieldOff /> {!compact && 'Disable'}{' '}
                <IconChevron size={12} />
              </button>
              {open && (
                <div className="popover" role="menu">
                  <div className="popover-title">Disable blocking</div>
                  {DURATIONS.map(d => (
                    <button
                      key={d.label}
                      role="menuitem"
                      className="popover-item"
                      onClick={() => void run(false, d.seconds)}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {error && (
        <span className="error-text" role="alert" title={error}>
          {error.split('\n')[0]}
        </span>
      )}
    </div>
  );
}
