import { Agent, fetch } from 'undici';

export class PiholeError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Minimal client for the Pi-hole v6 REST API (/api/...).
 * Keeps one session per instance and re-authenticates transparently on 401,
 * so we never leak sessions (Pi-hole caps concurrent API sessions).
 */
export class PiholeClient {
  constructor({ url, password, insecure, timeoutMs }) {
    this.base = url;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.sid = null;
    this.authed = false;
    this.authPromise = null;
    this.dispatcher = insecure
      ? new Agent({ connect: { rejectUnauthorized: false } })
      : undefined;
  }

  async #raw(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.sid) headers['X-FTL-SID'] = this.sid;

    let res;
    try {
      res = await fetch(`${this.base}/api${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const cause = err.cause?.code ?? err.name;
      const msg =
        cause === 'TimeoutError' ? 'Request timed out'
        : cause === 'ECONNREFUSED' ? 'Connection refused'
        : cause === 'ENOTFOUND' ? 'Host not found'
        : cause === 'EHOSTUNREACH' ? 'Host unreachable'
        : cause === 'ECONNRESET' ? 'Connection reset'
        : /CERT|SELF_SIGNED/.test(cause ?? '') ? 'TLS certificate rejected (set "insecure": true)'
        : 'Network error';
      // Full detail goes to the server log only; the UI gets the summary above.
      if (msg === 'Network error') console.warn(`[pihole ${this.base}] ${err.cause?.message ?? err.message}`);
      throw new PiholeError(msg, { code: 'network' });
    }

    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { /* non-JSON body */ }
    }
    return { status: res.status, data };
  }

  async authenticate() {
    // Coalesce concurrent auth attempts into one request.
    if (!this.authPromise) {
      this.authPromise = (async () => {
        const { status, data } = await this.#raw('/auth', {
          method: 'POST',
          body: { password: this.password },
          auth: false,
        });
        if (status === 401) {
          throw new PiholeError('Authentication failed — check the password or app password', { code: 'auth', status });
        }
        if (status === 429) {
          throw new PiholeError('Too many API sessions on this Pi-hole — try again shortly', { code: 'auth', status });
        }
        if (status === 404) {
          throw new PiholeError('No /api endpoint — Pi-hole v6 or newer is required', { code: 'version', status });
        }
        if (status >= 400 || !data?.session) {
          throw new PiholeError(data?.error?.message ?? `Auth failed (HTTP ${status})`, { code: 'auth', status });
        }
        if (data.session.totp && !data.session.valid) {
          throw new PiholeError('2FA is enabled — use an app password instead', { code: 'auth', status });
        }
        // sid is null when the Pi-hole has no password set.
        this.sid = data.session.sid ?? null;
        this.authed = true;
      })().finally(() => { this.authPromise = null; });
    }
    return this.authPromise;
  }

  async request(path, options = {}) {
    if (this.authPromise) await this.authPromise;
    else if (!this.authed && this.password) await this.authenticate();

    let { status, data } = await this.#raw(path, options);
    if (status === 401) {
      this.sid = null;
      this.authed = false;
      await this.authenticate();
      ({ status, data } = await this.#raw(path, options));
    }
    if (status >= 400) {
      throw new PiholeError(data?.error?.message ?? `HTTP ${status} on ${path}`, {
        code: status === 401 ? 'auth' : 'http',
        status,
      });
    }
    return data;
  }

  get(path) { return this.request(path); }

  setBlocking(enabled, timerSeconds = null) {
    return this.request('/dns/blocking', {
      method: 'POST',
      body: { blocking: enabled, timer: timerSeconds || null },
    });
  }

  async logout() {
    if (!this.sid) return;
    try { await this.#raw('/auth', { method: 'DELETE' }); } catch { /* best effort */ }
    this.sid = null;
    this.authed = false;
  }
}
