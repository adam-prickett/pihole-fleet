import {useState, type FormEvent} from 'react';
import {IconLock, IconLogo} from './Icons.js';

export function Login({
  onLogin,
}: {
  onLogin: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onLogin(password);
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login panel" onSubmit={e => void submit(e)}>
        <div className="login-brand">
          <IconLogo size={22} />
          <span className="product">Pi-hole Fleet</span>
        </div>
        <label className="field">
          <span className="field-label">Dashboard password</span>
          <span className="search login-input">
            <IconLock />
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </span>
        </label>
        {error && (
          <div className="error-text login-error" role="alert">
            {error}
          </div>
        )}
        <button
          className="btn btn-primary"
          type="submit"
          disabled={busy || !password}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
