# Pi-hole Fleet Dashboard

A single live view across all your Pi-hole instances. A small Node server polls
each Pi-hole's v6 REST API and streams the combined state to a React UI over
Server-Sent Events.

**What you get**

- **Health banner:** fleet status at a glance, naming any unreachable instance and the reason
- **Stat strip:** queries, blocked, block rate, cache hit rate, active clients and blocklist size, with 24h sparklines
- **Instances table:** status, blocking control, queries, block %, rate, clients, API latency, CPU/RAM gauges, uptime, version and update flag, plus a 60-poll history strip with success rate
- **Query volume:** 24h chart split by outcome (allowed/blocked) or by instance
- **Events:** instances going down or recovering, auth failures and blocking changes
- **Top-N tables:** permitted domains, blocked domains, clients, upstreams (with average response time) and query types, merged across instances; hover a row for the per-instance breakdown
- **Query log:** streams from every instance, with search, an outcome filter and pause
- **Blocking control:** for one instance, the current selection or the whole fleet (30s / 5m / 30m / 1h / until re-enabled)
- **Filtering:** click a row in the instances table to scope the whole dashboard to it; Shift-click to add more
- **Themes:** dark by default, light and auto available; fonts are bundled locally (IBM Plex), so it works offline

## Requirements

- Node.js 20+
- **Pi-hole v6 or newer** (the dashboard uses the `/api` REST endpoints; v5's `api.php` is not supported)

## Quick start

```bash
npm install
npm run demo          # three mock Pi-holes + one deliberately offline, no hardware needed
```

Open http://localhost:5173.

## Using your own Pi-holes

```bash
cp config.example.json config.json
# edit config.json
npm run dev           # API on :3030, UI with hot reload on :5173
```

```jsonc
{
  "port": 3030,
  "pollIntervalMs": 5000,                 // how often to poll each instance
  "readOnly": false,                      // true removes the enable/disable controls
  "auth": { "password": "env:DASHBOARD_PASSWORD", "sessionHours": 12 },
  "allowedHosts": ["192.168.1.10", "dashboard.lan"],
  "trustProxy": false,
  "instances": [
    { "name": "Primary",   "url": "http://192.168.1.2",  "password": "env:PIHOLE1_PASSWORD" },
    { "name": "Secondary", "url": "https://pihole2.lan", "password": "env:PIHOLE2_PASSWORD" }
  ]
}
```

**Pi-hole instances**

- `password`: the web password, or (recommended) an **app password** from
  *Settings → Web interface / API → Configure app password* in Pi-hole. App
  passwords also work when 2FA is enabled. Leave it out if the Pi-hole has no password.
- `url`: must be `http://` or `https://` and must not contain credentials.
  Prefer HTTPS, because over HTTP the Pi-hole password and session cross your network unencrypted.
- `insecure: true`: accepts self-signed certificates but disables certificate
  verification, which allows interception. Prefer adding a proper certificate.
- `env:NAME`: reads the value from an environment variable instead of the file.
- Instead of a file, you can set `PIHOLE_INSTANCES` to a JSON array of instances,
  pass `--config path/to/file.json`, or set `CONFIG=path`.

**Dashboard security settings** (each one can also be set with the environment variable shown)

| Setting | Env | Default | Purpose |
|---|---|---|---|
| `auth.password` | `DASHBOARD_PASSWORD` | none | Login password. Without one, the server only listens on `127.0.0.1`. |
| `auth.sessionHours` | | `12` | Idle timeout for login sessions |
| `host` | `HOST` | `0.0.0.0` with a password, `127.0.0.1` without | Interface to listen on |
| `allowedHosts` | `ALLOWED_HOSTS` (comma-separated) | this machine's hostname and IPs | Hostnames the dashboard answers to (blocks DNS rebinding). `["*"]` turns the check off. |
| `trustProxy` | `TRUST_PROXY` | `false` | Set when behind a reverse proxy (e.g. `1`, or the proxy's subnet) so client IPs and HTTPS are detected |
| `port` | `PORT` | `3030` | Listen port |

## Production

```bash
npm run build         # outputs dist/
npm start             # serves the UI and API on http://localhost:3030
```

## Docker

```bash
cp config.example.json config.json   # list your instances
cp .env.example .env                 # set DASHBOARD_PASSWORD, ALLOWED_HOSTS and Pi-hole passwords
docker compose up -d --build
```

The dashboard is served on `http://<host>:3030`; set `DASHBOARD_PORT` in `.env` to change the host port.
Compose won't start without `DASHBOARD_PASSWORD` and `ALLOWED_HOSTS`. List every
address you'll type into the browser (for example `192.168.1.10,dashboard.lan`);
any other hostname gets a `421` response.

- `config.json` is mounted read-only at `/config/config.json`. You can drop the
  file and set `PIHOLE_INSTANCES` in the compose file instead.
- A Pi-hole running on the same Docker host is reachable as `http://host.docker.internal`.
  Pi-holes on your LAN are reached by their normal IP or hostname.
- The container runs as a non-root user with a read-only filesystem, no Linux
  capabilities and a 256 MB memory limit. Its healthcheck calls `/api/health`.
- The base image is pinned by digest. To update it, run
  `docker buildx imagetools inspect node:22-alpine` and copy the new digest into the `Dockerfile`.
- Status history and the event feed are held in memory, so they reset when the container restarts.

### Prebuilt image (GitHub Container Registry)

`.github/workflows/docker.yml` builds the image for `linux/amd64`, `linux/arm64` and
`linux/arm/v7` (Raspberry Pi) and publishes it to `ghcr.io/adam-prickett/pihole-fleet`:

| Trigger | Tags pushed |
|---|---|
| Push to `main` | `latest`, `main`, `sha-<short>` |
| Tag `v1.2.3` | `1.2.3`, `1.2`, `1`, `sha-<short>` |
| Pull request | builds only, nothing is pushed |

To run the published image instead of building locally, add this to `.env`:

```bash
DASHBOARD_IMAGE=ghcr.io/adam-prickett/pihole-fleet:latest   # or pin a version, e.g. :1.2.3
```

then `docker compose pull && docker compose up -d`.

Each image comes with an SBOM and a signed build-provenance attestation. To check one:
`gh attestation verify oci://ghcr.io/adam-prickett/pihole-fleet:latest --owner adam-prickett`.
Dependabot (`.github/dependabot.yml`) opens weekly PRs for the pinned actions, the base image and npm packages.

## How it works

```
Pi-hole A ─┐                       ┌─ SSE /api/stream ──> React UI
Pi-hole B ─┼─> server/poller.js ───┤
Pi-hole C ─┘   (one session each)  └─ POST /api/blocking
```

- Passwords stay on the server, and the browser never talks to a Pi-hole
  directly, so there are no CORS problems.
- Each instance keeps a single API session that's renewed when it expires and
  logged out on shutdown. This matters because Pi-hole limits concurrent sessions.
- The summary, blocking state and recent queries refresh every poll. Top lists,
  upstreams and system stats refresh every 3rd poll; 24h history and versions every 12th.
- Aggregation runs in the browser (`src/lib/aggregate.js`), so the filtered views
  use the same logic as the fleet view.

## Security

- **Login:** a single shared password, kept in an HttpOnly, `SameSite=Strict` session
  cookie (marked `Secure` when served over HTTPS). Failed logins are rate-limited
  to 10 per 15 minutes per IP. Without a password the server only listens on
  localhost, and it prints a warning if you expose it anyway.
- **Request checks:** requests for hostnames outside `allowedHosts` are rejected.
  State-changing requests must be same-origin and send `application/json`, which
  blocks cross-site request forgery.
- **Headers:** a strict Content-Security-Policy (`script-src 'self'`,
  `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: no-referrer`, and no `X-Powered-By`.
- **Limits:** the API allows 600 requests per minute per IP, blocking changes 20
  per minute and manual refreshes 6 per minute. Live streams are capped at 50
  in total and 10 per IP. Forced Pi-hole refreshes are coalesced.
- **Errors:** clients never receive stack traces or internal details; those go to
  the server log only. A Pi-hole with a failing login is retried with exponential
  backoff, up to 5 minutes.
- **Audit trail:** logins, failed logins, logouts and blocking changes are written
  to stdout as JSON lines (`"type":"audit"`) with the client IP. Blocking changes
  also show in the Events panel, along with changes made outside the dashboard.
- **TLS:** the dashboard serves plain HTTP. If you open it from anywhere but a
  trusted LAN, put it behind a TLS-terminating reverse proxy and set `trustProxy`.
