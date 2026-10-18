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
- **Config sync:** pick a primary Pi-hole and the others mirror its adlists, domains, clients, local DNS records and DNS settings
- **Settings in the browser:** add and test Pi-holes, set an optional password, allowed hosts (including subnets), proxy and polling, with no config files
- **Themes:** dark by default, light and auto available; fonts are bundled locally (IBM Plex), so it works offline

## Requirements

- Node.js 20+ (22 recommended)
- **Pi-hole v6 or newer** (the dashboard uses the `/api` REST endpoints; v5's `api.php` is not supported)

## Quick start

```bash
npm install
npm run demo          # three mock Pi-holes + one deliberately offline, no hardware needed
```

Open http://localhost:5173.

## First run

Start it and open it in a browser; nothing has to be configured first. Add your
Pi-holes with **gear icon → Instances → Add instance**.

A dashboard password is **optional**. Without one, anyone who can reach the dashboard
can view DNS activity, toggle blocking and change settings, and a banner says so. Set one
any time under **gear icon → Password**; from then on the dashboard asks for it. You can
remove it again there.

## Settings

Everything is managed from the dashboard: click the **gear icon**.

- **Instances:** add, edit and remove Pi-holes. **Test connection** checks the URL
  and password before you save, and changes take effect immediately.
- **Sync:** choose a primary Pi-hole for the others to mirror (see [Config sync](#config-sync)).
- **Dashboard:** allowed hosts, reverse proxy, session timeout, live connection limit,
  poll interval and read-only mode. Changes take effect without a restart.
- **Password:** set, change or remove the (optional) dashboard password. Changing it signs other browsers out.

**Allowed hosts** is optional. It controls which addresses in the browser's address bar the
dashboard answers to, which blocks DNS-rebinding attacks. Left empty, any IP address works,
plus the server's own hostname. To open the dashboard by a DNS name such as `dashboard.lan`,
add that name. To restrict it, list names, IPs and subnets, e.g. `dashboard.lan, 10.1.68.0/24`.
Saving a list that would exclude the address you're using is refused, so you can't lock yourself out.

Settings and the password hash are saved in `settings.json`, instances in
`instances.json` and sync settings in `sync.json`, all in the data directory (`DATA_DIR`, default `./data`; `/data` in Docker).
They are written readable by their owner only. `instances.json` contains the Pi-hole passwords.

Prefer HTTPS for your Pi-holes. Over HTTP, the Pi-hole password and session cross your
network unencrypted. Use an **app password** where you can (*Settings → Web interface /
API → Configure app password*); these also work when 2FA is on. "Skip TLS certificate
verification" accepts self-signed certificates but allows interception, so prefer a proper certificate.

**Read-only mode** hides the blocking controls and locks the instance list, but the
settings stay editable so it can be turned off again (unless it's set with `READ_ONLY`).

### Config sync

Under **Settings → Sync**, choose one Pi-hole as the **primary**. The others become
**replicas** and mirror whichever of these you tick:

| Item | What's copied |
|---|---|
| Adlists | Blocklists and allowlists (gravity is updated afterwards so the lists are downloaded) |
| Domains | Allowed and denied domains, exact and regex |
| Clients | Client definitions and their group assignments |
| Local DNS records | Local DNS (`dns.hosts`) and CNAME records |
| DNS settings | The rest of the DNS settings: upstreams, conditional forwarding, blocking mode and so on |

- **Groups** are copied along with adlists, domains or clients, so group assignments line up.
- **Never copied:** the network interface, DNS port, listening mode and the Pi-hole's own
  reply addresses (`dns.reply.*`), DHCP, and the web interface settings, including passwords.
  Settings fixed by an environment variable on a replica (`FTLCONF_…`) are left alone and listed.
- **Check now** compares every replica with the primary and lists the differences
  without changing anything. **Sync now** copies the primary's configuration over.
- **Automatic sync** runs every 5 to 1440 minutes. Each run compares first and only writes to
  replicas that differ, so an in-sync fleet isn't touched.
- Lists are copied with Pi-hole's own backup format (Teleporter), and DNS settings
  through its config API. A replica restarts its DNS service for a few seconds after
  lists are imported, and replicas are synced one at a time so they never all restart together.
- Untick a replica to leave it out. The dashboard's instances table marks the primary
  and shows each replica's sync state.

Replicas, and the primary, need a password that is allowed to change settings: the
admin password, or an app password with `webserver.api.app_sudo` enabled
(*Settings → All settings → Webserver and API* on that Pi-hole).

Make changes on the primary's own admin page; anything changed directly on a replica
is overwritten at the next sync. Sync keeps running in read-only mode, but the sync
settings can't be changed and **Sync now** is unavailable.

### Fixing settings with environment variables (optional)

Any of these can be set in the environment instead. A setting fixed this way is shown
with a lock in the settings page and can't be changed there, which is useful if you
manage the deployment as code.

| Variable | Default | Setting |
|---|---|---|
| `DASHBOARD_PASSWORD` | none (no sign-in) | Dashboard password |
| `ALLOWED_HOSTS` | any IP address, plus the server's own name | Comma-separated hostnames, IPs and subnets (e.g. `10.1.68.0/24`) the dashboard answers to. Other hostnames get a `421` (this blocks DNS rebinding). `*` turns the check off. |
| `TRUST_PROXY` | `false` | Reverse proxy: a hop count (e.g. `1`), or the proxies' IPs/subnets |
| `POLL_INTERVAL_MS` | `5000` | How often each Pi-hole is polled |
| `READ_ONLY` | `false` | Read-only mode |
| `SESSION_HOURS` | `12` | Idle timeout for sign-in sessions |
| `MAX_STREAMS` | `50` | Maximum concurrent live connections |

These are only read when the server starts:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3030` | Listen port |
| `HOST` | `0.0.0.0` once a password exists, else `127.0.0.1` (`0.0.0.0` in Docker) | Interface to listen on |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where settings and instances are saved |
| `RESET_PASSWORD` | | `true` clears the saved password (see below) |

Any variable can be read from a file by appending `_FILE`, e.g.
`DASHBOARD_PASSWORD_FILE=/run/secrets/dashboard_password` (Docker and Portainer secrets).

**Forgotten password:** set `RESET_PASSWORD=true` and restart. The saved password is
cleared, so the dashboard opens without one. Remove the variable, then set a new password
under **Password**. Your other settings and instances are kept.

**Optional config file.** You can also put settings and instances in a JSON file: copy
`config.example.json` to `config.json`, or point `CONFIG` / `--config` at one. In the
file, `"env:NAME"` reads a value from the environment. Like environment variables,
anything set in the file is locked in the UI. Instances from the file are marked
**FILE** (the demo uses this).

## Production

```bash
npm run build         # outputs dist/
npm start             # serves the UI and API on http://localhost:3030
```

## Docker

`docker-compose.yml` pulls the published image. It needs no other files and no
environment variables, so it works as-is in Portainer.

### Portainer

1. **Stacks → Add stack → Web editor**, paste in `docker-compose.yml`, and deploy.
2. Open `http://<docker host>:3030` and add your Pi-holes with **gear icon → Instances → Add instance**.
3. Optionally set a dashboard password under **gear icon → Password**.

### docker compose

```bash
docker compose up -d             # then open http://<host>:3030
```

To build from this checkout instead of pulling the image:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

### Notes

- Settings, the password hash and instances live in the `pihole-fleet-data` volume (mounted at `/data`),
  so they survive redeploys and image updates. Removing the volume (`docker compose down -v`, or
  deleting it in Portainer) resets everything.
- `DASHBOARD_PORT` changes the host port (default `3030`). `DASHBOARD_IMAGE` pins a release,
  e.g. `ghcr.io/adam-prickett/pihole-fleet:0.3.0`.
- To fix any setting with an environment variable, add it to the stack's **Environment variables** in
  Portainer (or a `.env` file), e.g. `ALLOWED_HOSTS=dashboard.lan,10.1.68.0/24`. The compose file
  passes every setting listed under `environment:` through to the container; empty ones are ignored.
- A Pi-hole running on the same Docker host is reachable as `http://host.docker.internal`.
  Pi-holes on your LAN are reached by their normal IP or hostname.
- The container runs as a non-root user with a read-only filesystem, no Linux
  capabilities and a 256 MB memory limit. Its healthcheck calls `/api/health`.
- The base image is pinned by digest. To update it, run
  `docker buildx imagetools inspect node:22-alpine` and copy the new digest into the `Dockerfile`.
- Status history and the event feed are held in memory, so they reset when the container restarts.

### Published image

`.github/workflows/docker.yml` builds the image for `linux/amd64`, `linux/arm64` and
`linux/arm/v7` (Raspberry Pi) and publishes it to `ghcr.io/adam-prickett/pihole-fleet`:

| Trigger | Tags pushed |
|---|---|
| Push to `main` | `latest`, `main`, `sha-<short>` |
| Tag `v1.2.3` | `1.2.3`, `1.2`, `1` (not for `0.x`), `sha-<short>` |
| Pull request | builds only, nothing is pushed |

Each image comes with an SBOM and a signed build-provenance attestation. To check one:
`gh attestation verify oci://ghcr.io/adam-prickett/pihole-fleet:latest --owner adam-prickett`.
Dependabot (`.github/dependabot.yml`) opens weekly PRs for the pinned actions, the base image and npm packages.

## How it works

```
Pi-hole A ─┐                       ┌─ SSE /api/stream ──> React UI
Pi-hole B ─┼─> server/poller.ts ───┤
Pi-hole C ─┘   (one session each)  └─ POST /api/blocking
```

- Passwords stay on the server, and the browser never talks to a Pi-hole
  directly, so there are no CORS problems.
- Each instance keeps a single API session that's renewed when it expires and
  logged out on shutdown. This matters because Pi-hole limits concurrent sessions.
- The summary, blocking state and recent queries refresh every poll. Top lists,
  upstreams and system stats refresh every 3rd poll; 24h history and versions every 12th.
- Aggregation runs in the browser (`src/lib/aggregate.ts`), so the filtered views
  use the same logic as the fleet view.

## Development

The project is written in TypeScript (strict mode) and follows the
[Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html).

| Command | What it does |
|---|---|
| `npm run dev` | API (via `tsx`, restarts on change) on :3030 and the UI with hot reload on :5173 |
| `npm run demo` | The same, against three mock Pi-holes |
| `npm run check` | Type-checks everything, then lints. CI runs this on every push and pull request. |
| `npm run typecheck` | `tsc` for the server, the browser code and the build config |
| `npm run lint` | `gts lint`: ESLint with Google's rules and Prettier formatting |
| `npm run fix` | `gts fix`: formats the code and applies automatic lint fixes |
| `npm run build` | Builds the UI into `dist/` and compiles the server into `build/` |

**Layout**
- `server/`: the Node server, compiled to `build/` (`tsconfig.server.json`).
- `src/`: the React UI, bundled by Vite (`tsconfig.app.json`).
- `server/types.ts`: the data shapes shared by both; the browser imports them as types only.

**Style checks.** [gts](https://github.com/google/gts), Google's tooling for the guide,
provides the base rules and formatting. `eslint.config.cjs` adds checks for other parts of
the guide:
- named exports only (no `export default`);
- the TypeScript `private` modifier rather than `#private` fields;
- `interface` for object types, `import type` for type-only imports, `T[]` for simple arrays;
- no `any`, only `Error` objects thrown, no `public` modifier, no `for...in`;
- lowerCamelCase / UpperCamelCase / CONSTANT_CASE naming.

Object keys that mirror external formats, such as Pi-hole API fields and HTTP headers,
are exempt from the naming rule. `vite.config.ts` keeps the default export Vite requires.

## Security

- **Login (optional):** a single shared password, kept in an HttpOnly, `SameSite=Strict`
  session cookie (marked `Secure` when served over HTTPS). Failed logins are rate-limited
  to 10 per 15 minutes per IP. Passwords set in the UI are stored as salted scrypt hashes
  and must be at least 12 characters. Changing or removing one requires the current
  password, and changing it signs out every other session. Without a password the dashboard
  is open to anyone who can reach it: it shows a warning banner and logs a note at startup.
  When run outside Docker without a password or `HOST`, it only listens on localhost.
- **Settings changes:** with a password set, they need a signed-in session. An
  allowed-hosts change that would lock out the browser making it is refused. Settings fixed
  by environment variables can't be changed from the UI. Every change is audit-logged
  (passwords never are).
- **Request checks:** requests for hostnames outside the allowed hosts are rejected.
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
- **Audit trail:** logins, failed logins, logouts, password and settings changes, blocking changes and instance changes are written
  to stdout as JSON lines (`"type":"audit"`) with the client IP. Blocking changes
  also show in the Events panel, along with changes made outside the dashboard.
- **Instance settings:** adding, editing or removing a Pi-hole requires a signed-in
  session and goes through the same origin and JSON checks. Each change is written to
  the audit log (without the password) and shown in the Events panel. Saved Pi-hole
  passwords are never sent back to the browser. A saved password is only reused for
  the same Pi-hole address, so changing an instance's URL means re-entering its
  password. `env:NAME` references are only honoured in the config file,
  never in values typed into the UI. **Test connection** makes the server
  contact the address you enter, so anyone signed in can use it to probe hosts the
  server can reach; this is another reason to set a strong `DASHBOARD_PASSWORD`.
- **TLS:** the dashboard serves plain HTTP. If you open it from anywhere but a
  trusted LAN, put it behind a TLS-terminating reverse proxy and set the reverse proxy setting.
