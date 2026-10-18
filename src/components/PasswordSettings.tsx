import {useEffect, useState, type ChangeEvent, type FormEvent} from 'react';
import type {SettingsResponse} from '../../server/types.js';
import {refreshSession, settingsApi} from '../lib/useDashboard.js';
import {IconLock} from './Icons.js';

interface PasswordForm {
  current: string;
  next: string;
  confirm: string;
}

const EMPTY: PasswordForm = {current: '', next: '', confirm: ''};

export function PasswordTab() {
  const [info, setInfo] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<PasswordForm>(EMPTY);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function load(): Promise<void> {
    try {
      setInfo(await settingsApi.get());
    } catch (err) {
      setError((err as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  if (!info) {
    return error ? (
      <div className="notice notice-critical">{error}</div>
    ) : (
      <div className="empty">Loading…</div>
    );
  }
  const {password, canEdit, reason} = info;

  if (password.locked) {
    return (
      <div className="notice">
        <IconLock size={10} /> The dashboard password is set by{' '}
        {password.locked === 'config file' ? (
          'the config file'
        ) : (
          <span className="mono">{password.locked}</span>
        )}{' '}
        and can only be changed there.
      </div>
    );
  }

  function set(key: keyof PasswordForm) {
    return (e: ChangeEvent<HTMLInputElement>) => {
      setForm(f => ({...f, [key]: e.target.value}));
      setDone(null);
      setError(null);
    };
  }
  const tooShort = form.next && form.next.length < password.minLength;
  const mismatch = form.confirm && form.next !== form.confirm;

  async function run(
    kind: 'save' | 'remove',
    fn: () => Promise<unknown>,
    message: string,
  ): Promise<void> {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      setForm(EMPTY);
      setConfirmRemove(false);
      setDone(message);
      refreshSession(); // sign-in may have been turned on or off
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function save(e: FormEvent): void {
    e.preventDefault();
    void run(
      'save',
      () => settingsApi.changePassword(form.current, form.next),
      password.set
        ? 'Password changed. Any other signed-in browsers have been signed out.'
        : 'Password set. Sign-in is now required.',
    );
  }
  function remove(): void {
    void run(
      'remove',
      () => settingsApi.removePassword(form.current),
      'Password removed. Sign-in is no longer required.',
    );
  }

  return (
    <form className="settings-form instance-form" onSubmit={save}>
      {!canEdit && <div className="notice">{reason}</div>}
      <h3 className="section-title">
        {password.set ? 'Change password' : 'Set a password'}
      </h3>
      <p className="hint">
        {password.set
          ? 'The dashboard asks for this password before showing anything.'
          : 'No password is set, so anyone who can reach the dashboard can view DNS activity and change settings. A password is optional but recommended.'}
      </p>
      {password.set && (
        <label className="field">
          <span className="field-label">Current password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={form.current}
            onChange={set('current')}
            disabled={!canEdit}
          />
        </label>
      )}
      <label className="field">
        <span className="field-label">New password</span>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={form.next}
          onChange={set('next')}
          minLength={password.minLength}
          maxLength={256}
          disabled={!canEdit}
        />
        <span className={tooShort ? 'hint error-text' : 'hint'}>
          At least {password.minLength} characters.
        </span>
      </label>
      <label className="field">
        <span className="field-label">Confirm new password</span>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={form.confirm}
          onChange={set('confirm')}
          disabled={!canEdit}
        />
        {mismatch && (
          <span className="hint error-text">Passwords don’t match.</span>
        )}
      </label>
      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
      {done && (
        <div className="status status-good" role="status">
          <span className="led" aria-hidden="true" />
          {done}
        </div>
      )}
      <div className="form-actions">
        {password.set &&
          canEdit &&
          (confirmRemove ? (
            <>
              <span className="dim">
                Remove the password and turn sign-in off?
              </span>
              <button
                type="button"
                className="btn btn-danger"
                onClick={remove}
                disabled={busy !== null || !form.current}
                title={
                  !form.current ? 'Enter the current password first' : undefined
                }
              >
                {busy === 'remove' ? 'Removing…' : 'Remove'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setConfirmRemove(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() => setConfirmRemove(true)}
            >
              Remove password…
            </button>
          ))}
        <span className="spacer" />
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={
            busy !== null ||
            !canEdit ||
            !form.next ||
            tooShort ||
            mismatch ||
            !form.confirm ||
            (password.set && !form.current)
          }
        >
          {busy === 'save'
            ? 'Saving…'
            : password.set
              ? 'Change password'
              : 'Set password'}
        </button>
      </div>
      {confirmRemove && !form.current && (
        <span className="hint">
          Enter your current password above to remove it.
        </span>
      )}
    </form>
  );
}
