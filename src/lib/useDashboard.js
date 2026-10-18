import { useCallback, useEffect, useState } from 'react';

const UNAUTHORIZED = 'pfd:unauthorized';
const notifyUnauthorized = () => window.dispatchEvent(new Event(UNAUTHORIZED));

/** JSON POST to our own API. Always sends a JSON content type (the server requires it). */
async function postJson(url, body = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') notifyUnauthorized();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** Tracks whether a login is needed / present. */
export function useSession() {
  const [session, setSession] = useState(null); // { authRequired, authenticated } | { error }

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/session', { credentials: 'same-origin' });
      if (res.ok) return setSession(await res.json());
      throw new Error(`Server responded ${res.status}`);
    } catch (err) {
      // Keep a known-good session through brief outages; the live stream shows "Reconnecting".
      const message = err instanceof TypeError ? 'Cannot reach the dashboard server' : err.message;
      setSession((prev) => (prev && !prev.error ? prev : { error: message }));
    }
  }, []);

  useEffect(() => {
    check();
    window.addEventListener(UNAUTHORIZED, check);
    return () => window.removeEventListener(UNAUTHORIZED, check);
  }, [check]);

  // Server unreachable (e.g. restarting): keep retrying.
  useEffect(() => {
    if (!session?.error) return undefined;
    const id = setTimeout(check, 4000);
    return () => clearTimeout(id);
  }, [session, check]);

  const login = async (password) => {
    await postJson('/api/login', { password });
    await check();
  };
  const logout = async () => {
    await postJson('/api/logout').catch(() => {});
    await check();
  };

  return { session, check, login, logout };
}

/** Subscribes to the server's SSE stream (only while `enabled`) and returns the latest snapshot. */
export function useDashboard(enabled) {
  const [data, setData] = useState(null);
  const [connection, setConnection] = useState('connecting');

  useEffect(() => {
    if (!enabled) {
      setData(null);
      return undefined;
    }
    const es = new EventSource('/api/stream', { withCredentials: true });
    es.onopen = () => setConnection('live');
    es.onmessage = (e) => {
      setConnection('live');
      try { setData(JSON.parse(e.data)); } catch { /* ignore malformed frame */ }
    };
    es.onerror = () => {
      setConnection(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
      // EventSource hides the status code; a dropped stream may mean the session ended.
      notifyUnauthorized();
    };
    return () => es.close();
  }, [enabled]);

  return { data, connection };
}

/** A clock that re-renders the caller every `ms` (for countdowns, "x ago"). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export async function setBlocking(instances, enabled, timer = null) {
  const body = await postJson('/api/blocking', { instances, enabled, timer });
  const failed = (body.results ?? []).filter((r) => !r.ok);
  if (failed.length) throw new Error(failed.map((f) => `${f.id}: ${f.error}`).join('\n'));
  return body;
}

export function useTheme() {
  const read = () => {
    try { return localStorage.getItem('theme') ?? 'auto'; } catch { return 'auto'; }
  };
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* storage unavailable */ }
  }, [theme]);
  const cycle = () => setTheme((t) => (t === 'auto' ? 'light' : t === 'light' ? 'dark' : 'auto'));
  return { theme, cycle };
}
