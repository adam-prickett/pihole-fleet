# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-18

### Added

- **Config sync** (Settings → Sync): choose a primary Pi-hole and the others
  mirror its configuration.
  - Choose what to mirror: adlists, domains, clients, local DNS and CNAME
    records, and other DNS settings. Groups come along with the lists.
  - Machine-specific settings (interface, port, listening mode, reply
    addresses), DHCP and web interface settings are never copied.
  - **Check now** lists each replica's differences without changing anything.
    **Sync now** copies the primary's configuration over.
  - Optional automatic sync every 5–1440 minutes, which only writes to
    replicas that differ.
  - Gravity is updated on a replica after its adlists change (optional).
  - The instances table marks the primary and each replica's sync state, and
    syncs and differences appear in the event log and audit log.

## [0.2.1] - 2026-10-18

### Fixed

- **Environment overrides were ignored in Portainer.** Values set in a stack's
  "Environment variables" (for example `ALLOWED_HOSTS`) never reached the
  container, because the compose file's `environment:` entries were commented
  out. The compose file now passes every setting through, empty by default,
  and empty values are treated as unset.

## [0.2.0] - 2026-10-18

The dashboard is now configured from the browser instead of from files, so it
runs as a plain Portainer stack with nothing to mount and no variables to set.

### Added

- **Settings page** (gear icon) for managing the dashboard without restarting it:
  - **Instances**: add, edit, test and remove Pi-holes. "Test connection" checks
    the URL and password before saving.
  - **Dashboard**: allowed hosts, reverse-proxy trust, session timeout, live
    connection limit, poll interval and read-only mode.
  - **Password**: set, change or remove the dashboard password. Changing it
    signs out every other browser.
- **Persistent storage**: settings and instances are saved to `/data`
  (`settings.json` and `instances.json`, mode 0600, written atomically). The
  compose file keeps them in the `pihole-fleet-data` named volume.
- **Environment overrides**: any setting can still be fixed with an environment
  variable (or `NAME_FILE` for Docker/Portainer secrets). Settings fixed this
  way show as locked in the UI.
- **Subnets in allowed hosts**: CIDR ranges such as `10.1.68.0/24` are accepted
  alongside hostnames and IP addresses, IPv4 and IPv6.
- **`RESET_PASSWORD=true`** clears a forgotten dashboard password on startup.
- **"Dashboard updated" banner**: browser tabs left open across an upgrade
  prompt you to reload instead of running stale code.
- **`docker-compose.build.yml`**: an override for building the image locally
  (`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`).
- **Code style tooling**: Google's TypeScript style guide, enforced with
  [gts](https://github.com/google/gts) plus extra ESLint rules for parts of the
  guide gts doesn't cover. New scripts: `npm run check` (type-check and lint),
  `lint`, `fix` and `typecheck`.
- **CI check job**: GitHub Actions runs `npm run check` and a build before
  publishing an image.

### Changed

- **The dashboard password is optional.** Without one, the dashboard is open
  and shows a dismissible warning. If neither a password nor `HOST` is set, it
  listens on `127.0.0.1` only (the Docker image sets `HOST` itself).
- **Allowed hosts are optional.** Left empty, the dashboard accepts any IP
  address plus the server's own hostname. Other hostnames are refused, so
  DNS-rebinding attacks are still blocked. A save that would lock out the
  address you're using is refused.
- **`docker-compose.yml` uses the published GHCR image** and needs no `.env`,
  `config.json` or required variables.
- **Rewritten in TypeScript (strict mode)**, server and frontend. The server is
  compiled to `build/` and the image now runs `node build/index.js`.
- **Clearer TLS error**: an untrusted certificate now points to the
  instance's "Skip TLS certificate verification" option.

### Fixed

- **False "update" badges**: a Pi-hole showed an update even when it was on the
  latest release. Update detection now matches Pi-hole's own web interface. On
  release builds it compares version numbers. On development branches it
  compares commit hashes, treating a short hash as matching the long hash it
  begins with. Docker installs are also checked for a newer image tag.
- **Leftover temporary files**: a failed save (for example, a full disk) no
  longer leaves temporary files in the data directory.

### Removed

- **Defining instances with environment variables** (`PIHOLE_INSTANCES`,
  `PIHOLE_<n>_URL`, …). These are now ignored and a startup warning is logged.
  Add Pi-holes from the settings page instead. Instances in an optional
  `config.json` still work and are shown as read-only.
- **The `CONFIG=/config/config.json` default and its bind mount** in the
  compose file.

### Upgrading from 0.1.0

1. Replace your stack with the new `docker-compose.yml`. Any
   `DASHBOARD_PASSWORD`, `ALLOWED_HOSTS` or `TRUST_PROXY` values you keep in
   the `environment:` block still apply, but they lock those settings.
2. Open the dashboard and re-add your Pi-holes under Settings → Instances,
   unless you keep mounting a `config.json` and point `CONFIG` at it.

## [0.1.0] - 2026-10-18

First release.

### Added

- **One page for the whole fleet**: combined query and block stats, 24-hour
  history, top domains, blocked domains and clients, upstreams, and a merged
  live query log.
- **Per-instance health**: status, latency, CPU, RAM, uptime, version and poll
  history.
- **Blocking controls**: pause or resume blocking across the whole fleet or per
  instance.
- **Live updates**: the Node server polls each Pi-hole's v6 REST API, backs off
  when one is down, and pushes updates to browsers over server-sent events.
- **Security hardening**: optional password login, host allowlisting against
  DNS rebinding, same-origin checks on state changes, rate limits, strict
  security headers, sanitised errors and an audit log.
- **Docker**: a hardened image (non-root, read-only filesystem, no
  capabilities, digest-pinned base) and a GitHub Actions workflow that
  publishes amd64/arm64/armv7 images to GHCR with an SBOM and provenance
  attestation, plus Dependabot updates.

[0.3.0]: https://github.com/adam-prickett/pihole-fleet/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/adam-prickett/pihole-fleet/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/adam-prickett/pihole-fleet/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/adam-prickett/pihole-fleet/releases/tag/v0.1.0
