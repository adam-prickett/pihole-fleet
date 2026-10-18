import {Agent, fetch} from 'undici';
import type {InstanceConfig} from './types.js';

/** Why a Pi-hole request failed: unreachable, bad login, too old, or an HTTP error. */
export type PiholeErrorCode = 'network' | 'auth' | 'version' | 'http';

export class PiholeError extends Error {
  readonly code: PiholeErrorCode;
  readonly status?: number;

  constructor(
    message: string,
    {code, status}: {code: PiholeErrorCode; status?: number},
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Pi-hole API error body. */
interface ApiError {
  error?: {message?: string; hint?: string | null};
}

interface AuthResponse extends ApiError {
  session?: {valid?: boolean; totp?: boolean; sid?: string | null};
}

interface RequestOptions {
  method?: string;
  /** JSON body. */
  body?: unknown;
  /** Multipart body (sent instead of `body`). */
  form?: FormData;
  auth?: boolean;
  /** Return the raw bytes instead of parsing JSON. */
  binary?: boolean;
  /** Overrides the instance's timeout (for slow calls like backups and gravity). */
  timeoutMs?: number;
}

interface RawResponse {
  status: number;
  data: unknown;
}

const APP_SUDO_MESSAGE =
  'This app password may not change settings: on that Pi-hole enable webserver.api.app_sudo (Settings → All settings → Webserver and API), or use its admin password';

function errorMessage(data: unknown): string | undefined {
  const err = (data as ApiError | null)?.error;
  if (!err?.message) return undefined;
  if (err.hint?.includes('app_sudo')) return APP_SUDO_MESSAGE;
  // FTL puts the offending config key in the hint.
  return err.hint && err.hint.length < 120
    ? `${err.message} (${err.hint})`
    : err.message;
}

/** Friendly message for a failed fetch (the detail goes to the server log). */
function networkMessage(cause: string | undefined): string {
  switch (cause) {
    case 'TimeoutError':
      return 'Request timed out';
    case 'ECONNREFUSED':
      return 'Connection refused';
    case 'ENOTFOUND':
      return 'Host not found';
    case 'EHOSTUNREACH':
      return 'Host unreachable';
    case 'ECONNRESET':
      return 'Connection reset';
    default:
      return /CERT|SELF_SIGNED/.test(cause ?? '')
        ? 'TLS certificate rejected (turn on "Skip TLS certificate verification")'
        : 'Network error';
  }
}

/**
 * Minimal client for the Pi-hole v6 REST API (/api/...).
 * Keeps one session per instance and re-authenticates transparently on 401,
 * so we never leak sessions (Pi-hole caps concurrent API sessions).
 */
export class PiholeClient {
  private readonly base: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly dispatcher?: Agent;
  private sid: string | null = null;
  private authed = false;
  private authPromise: Promise<void> | null = null;

  constructor({
    url,
    password,
    insecure,
    timeoutMs,
  }: Pick<InstanceConfig, 'url' | 'password' | 'insecure' | 'timeoutMs'>) {
    this.base = url;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.dispatcher = insecure
      ? new Agent({connect: {rejectUnauthorized: false}})
      : undefined;
  }

  private async raw(
    path: string,
    {
      method = 'GET',
      body,
      form,
      auth = true,
      binary = false,
      timeoutMs = this.timeoutMs,
    }: RequestOptions = {},
  ): Promise<RawResponse> {
    const headers: Record<string, string> = {
      Accept: binary ? '*/*' : 'application/json',
    };
    if (body !== undefined && !form) {
      headers['Content-Type'] = 'application/json';
    }
    if (auth && this.sid) headers['X-FTL-SID'] = this.sid;

    let res;
    try {
      res = await fetch(`${this.base}/api${path}`, {
        method,
        headers,
        body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error & {cause?: {code?: string; message?: string}};
      const msg = networkMessage(err.cause?.code ?? err.name);
      // Full detail goes to the server log only; the UI gets the summary.
      if (msg === 'Network error') {
        console.warn(
          `[pihole ${this.base}] ${err.cause?.message ?? err.message}`,
        );
      }
      throw new PiholeError(msg, {code: 'network'});
    }

    if (binary && res.ok) {
      return {status: res.status, data: Buffer.from(await res.arrayBuffer())};
    }
    let data: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        /* non-JSON body */
      }
    }
    return {status: res.status, data};
  }

  async authenticate(): Promise<void> {
    // Coalesce concurrent auth attempts into one request.
    if (!this.authPromise) {
      this.authPromise = this.login().finally(() => {
        this.authPromise = null;
      });
    }
    return this.authPromise;
  }

  private async login(): Promise<void> {
    const {status, data: raw} = await this.raw('/auth', {
      method: 'POST',
      body: {password: this.password},
      auth: false,
    });
    const data = raw as AuthResponse | null;
    if (status === 401) {
      throw new PiholeError(
        'Authentication failed — check the password or app password',
        {code: 'auth', status},
      );
    }
    if (status === 429) {
      throw new PiholeError(
        'Too many API sessions on this Pi-hole — try again shortly',
        {code: 'auth', status},
      );
    }
    if (status === 404) {
      throw new PiholeError(
        'No /api endpoint — Pi-hole v6 or newer is required',
        {code: 'version', status},
      );
    }
    if (status >= 400 || !data?.session) {
      throw new PiholeError(
        errorMessage(data) ?? `Auth failed (HTTP ${status})`,
        {code: 'auth', status},
      );
    }
    if (data.session.totp && !data.session.valid) {
      throw new PiholeError('2FA is enabled — use an app password instead', {
        code: 'auth',
        status,
      });
    }
    // sid is null when the Pi-hole has no password set.
    this.sid = data.session.sid ?? null;
    this.authed = true;
  }

  async request<T = unknown>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    if (this.authPromise) await this.authPromise;
    else if (!this.authed && this.password) await this.authenticate();

    let {status, data} = await this.raw(path, options);
    if (status === 401) {
      this.sid = null;
      this.authed = false;
      await this.authenticate();
      ({status, data} = await this.raw(path, options));
    }
    if (status >= 400) {
      throw new PiholeError(errorMessage(data) ?? `HTTP ${status} on ${path}`, {
        code: status === 401 ? 'auth' : 'http',
        status,
      });
    }
    return data as T;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  setBlocking(enabled: boolean, timerSeconds: number | null = null) {
    return this.request('/dns/blocking', {
      method: 'POST',
      body: {blocking: enabled, timer: timerSeconds || null},
    });
  }

  async logout(): Promise<void> {
    if (!this.sid) return;
    try {
      await this.raw('/auth', {method: 'DELETE'});
    } catch {
      /* best effort */
    }
    this.sid = null;
    this.authed = false;
  }
}
