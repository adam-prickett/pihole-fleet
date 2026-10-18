import {useCallback, useEffect, useState} from 'react';
import type {
  InstancesResponse,
  PublicInstance,
  SessionStatus,
  SettingsResponse,
  SettingsValues,
  Snapshot,
  SyncResponse,
  SyncSettings,
  TestResult,
} from '../../server/types.js';

const UNAUTHORIZED = 'pfd:unauthorized';

function notifyUnauthorized(): void {
  window.dispatchEvent(new Event(UNAUTHORIZED));
}

/** JSON request to our own API. Always sends a JSON content type (the server requires it). */
async function requestJson<T>(
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? {'Content-Type': 'application/json'} : {},
    credentials: 'same-origin',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as {error?: string};
  if (res.status === 401 && url !== '/api/login') notifyUnauthorized();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

function postJson<T = {ok: boolean}>(url: string, body: unknown = {}) {
  return requestJson<T>('POST', url, body);
}

/** Instance fields the settings form sends (password omitted = keep the saved one). */
export interface InstanceInput {
  id?: string;
  name?: string;
  url?: string;
  password?: string;
  insecure?: boolean;
  timeoutMs?: number;
}

/** Instance settings (settings page). */
export const instancesApi = {
  list: () => requestJson<InstancesResponse>('GET', '/api/instances'),
  create: (inst: InstanceInput) =>
    postJson<{instance: PublicInstance}>('/api/instances', inst),
  update: (id: string, inst: InstanceInput) =>
    requestJson<{instance: PublicInstance}>(
      'PUT',
      `/api/instances/${encodeURIComponent(id)}`,
      inst,
    ),
  remove: (id: string) =>
    requestJson<{ok: boolean}>(
      'DELETE',
      `/api/instances/${encodeURIComponent(id)}`,
    ),
  test: (inst: InstanceInput) =>
    postJson<TestResult>('/api/instances/test', inst),
};

/** Dashboard settings (settings page). */
export const settingsApi = {
  get: () => requestJson<SettingsResponse>('GET', '/api/settings'),
  update: (patch: Partial<SettingsValues>) =>
    requestJson<SettingsResponse>('PUT', '/api/settings', patch),
  changePassword: (current: string, password: string) =>
    postJson('/api/settings/password', {current, password}),
  removePassword: (current: string) =>
    postJson('/api/settings/password/remove', {current}),
};

/** Config sync (settings page). */
export const syncApi = {
  get: () => requestJson<SyncResponse>('GET', '/api/sync'),
  update: (patch: Partial<SyncSettings>) =>
    requestJson<SyncResponse>('PUT', '/api/sync', patch),
  /** Compare replicas with the primary without changing anything. */
  check: () => postJson<SyncResponse>('/api/sync/check'),
  run: () => postJson<SyncResponse>('/api/sync/run'),
};

/** The session state, or why it couldn't be checked. */
export type Session = SessionStatus | {error: string};

export function isSessionError(s: Session | null): s is {error: string} {
  return s !== null && 'error' in s;
}

/** Tracks whether a login is needed / present. */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/session', {credentials: 'same-origin'});
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      setSession((await res.json()) as SessionStatus);
    } catch (err) {
      // Keep a known-good session through brief outages; the live stream shows "Reconnecting".
      const message =
        err instanceof TypeError
          ? 'Cannot reach the dashboard server'
          : (err as Error).message;
      setSession(prev =>
        prev && !isSessionError(prev) ? prev : {error: message},
      );
    }
  }, []);

  useEffect(() => {
    const onUnauthorized = () => void check();
    onUnauthorized();
    window.addEventListener(UNAUTHORIZED, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED, onUnauthorized);
  }, [check]);

  // Server unreachable (e.g. restarting): keep retrying.
  useEffect(() => {
    if (!isSessionError(session)) return undefined;
    const id = setTimeout(() => void check(), 4000);
    return () => clearTimeout(id);
  }, [session, check]);

  async function login(password: string): Promise<void> {
    await postJson('/api/login', {password});
    await check();
  }

  async function logout(): Promise<void> {
    await postJson('/api/logout').catch(() => {});
    await check();
  }

  return {session, check, login, logout};
}

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'closed';

/** Subscribes to the server's SSE stream (only while `enabled`) and returns the latest snapshot. */
export function useDashboard(enabled: boolean) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');

  useEffect(() => {
    if (!enabled) {
      setData(null);
      return undefined;
    }
    const es = new EventSource('/api/stream', {withCredentials: true});
    es.onopen = () => setConnection('live');
    es.onmessage = (e: MessageEvent<string>) => {
      setConnection('live');
      try {
        setData(JSON.parse(e.data) as Snapshot);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      setConnection(
        es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting',
      );
      // EventSource hides the status code; a dropped stream may mean the session ended.
      notifyUnauthorized();
    };
    return () => es.close();
  }, [enabled]);

  return {data, connection};
}

/** A clock that re-renders the caller every `ms` (for countdowns, "x ago"). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

interface BlockingResult {
  id: string;
  ok: boolean;
  error?: string;
}

export async function setBlocking(
  instances: string[] | 'all',
  enabled: boolean,
  timer: number | null = null,
): Promise<void> {
  const body = await postJson<{results?: BlockingResult[]}>('/api/blocking', {
    instances,
    enabled,
    timer,
  });
  const failed = (body.results ?? []).filter(r => !r.ok);
  if (failed.length) {
    throw new Error(failed.map(f => `${f.id}: ${f.error}`).join('\n'));
  }
}

export type Theme = 'auto' | 'light' | 'dark';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('theme');
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
  function cycle(): void {
    setTheme(t => (t === 'auto' ? 'light' : t === 'light' ? 'dark' : 'auto'));
  }
  return {theme, cycle};
}

/** Re-check the session (e.g. after the password was set, which turns sign-in on). */
export const refreshSession = notifyUnauthorized;
