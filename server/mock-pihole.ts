// Simulates a few Pi-hole v6 instances (the subset of /api the dashboard uses)
// so you can try the dashboard without real hardware: `npm run demo`.
import http from 'node:http';
import crypto from 'node:crypto';

interface Sim {
  port: number;
  password: string;
  rate: number;
  blockRate: number;
  clients: string[];
}

interface HistoryBucket {
  timestamp: number;
  total: number;
  blocked: number;
  cached: number;
  forwarded: number;
}

interface MockQuery {
  id: number;
  time: number;
  [field: string]: unknown;
}

interface BlockingBody {
  blocking?: boolean;
  timer?: number;
}

type Route = (url: URL, body: BlockingBody) => unknown;

const DOMAINS = [
  'www.google.com',
  'api.github.com',
  'i.ytimg.com',
  'clients4.google.com',
  'cdn.jsdelivr.net',
  'www.icloud.com',
  'gateway.icloud.com',
  'netflix.com',
  'occ-0-1.nflxso.net',
  'en.wikipedia.org',
  'time.apple.com',
  'push.services.mozilla.com',
  'graph.facebook.com',
  'open.spotify.com',
  'connectivitycheck.gstatic.com',
  'outlook.office365.com',
  'login.microsoftonline.com',
];
const ADS = [
  'doubleclick.net',
  'googleads.g.doubleclick.net',
  'ads.yahoo.com',
  'telemetry.microsoft.com',
  'app-measurement.com',
  'pagead2.googlesyndication.com',
  'ssl.google-analytics.com',
  'device-metrics-us.amazon.com',
  'samsungads.com',
  'adservice.google.com',
  'scorecardresearch.com',
];
const UPSTREAMS = [
  {ip: '1.1.1.1', name: 'one.one.one.one', port: 53},
  {ip: '9.9.9.9', name: 'dns9.quad9.net', port: 53},
  {ip: '127.0.0.1', name: 'localhost#5335', port: 5335},
];
const TYPES = ['A', 'AAAA', 'HTTPS', 'PTR', 'SRV', 'TXT'];

const SIMS: Sim[] = [
  {
    port: 8081,
    password: 'demo',
    rate: 3.2,
    blockRate: 0.21,
    clients: [
      'macbook.lan',
      'iphone.lan',
      'tv.lan',
      'nas.lan',
      'ipad.lan',
      '192.168.1.44',
    ],
  },
  {
    port: 8082,
    password: 'demo',
    rate: 1.6,
    blockRate: 0.18,
    clients: ['desktop.lan', 'pixel.lan', 'printer.lan', '192.168.1.61'],
  },
  {
    port: 8083,
    password: '',
    rate: 0.9,
    blockRate: 0.42,
    clients: ['camera-1.iot', 'thermostat.iot', 'plug-03.iot', 'speaker.iot'],
  },
];

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** A random element, skewed towards the start of the list. */
function choice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() ** 1.6 * arr.length)];
}

function now(): number {
  return Date.now() / 1000;
}

function createSim(sim: Sim): void {
  const sessions = new Set<string>();
  const queries: MockQuery[] = [];
  let blocking: {enabled: boolean; until: number | null} = {
    enabled: true,
    until: null,
  };
  let nextId = 1;

  // Pre-fill 24h of 10-minute history buckets.
  const history: HistoryBucket[] = [];
  const startBucket = Math.floor(now() / 600) * 600 - 143 * 600;
  for (let i = 0; i < 144; i++) {
    const t = startBucket + i * 600;
    const hour = new Date(t * 1000).getHours();
    const diurnal =
      0.35 +
      0.65 * Math.max(0, Math.sin(((hour - 6) / 24) * Math.PI * 2) * 0.5 + 0.5);
    const total = Math.round(sim.rate * 600 * diurnal * rand(0.7, 1.2));
    history.push({
      timestamp: t,
      total,
      blocked: Math.round(total * sim.blockRate * rand(0.8, 1.2)),
      cached: 0,
      forwarded: 0,
    });
  }
  const counts = {
    domains: new Map<string, number>(),
    blocked: new Map<string, number>(),
    clients: new Map<string, number>(),
    upstreams: new Map<string, number>(),
    types: new Map<string, number>(),
  };
  function bump(m: Map<string, number>, k: string, n = 1): void {
    m.set(k, (m.get(k) ?? 0) + n);
  }

  function generate() {
    const n = Math.max(0, Math.round(sim.rate * rand(0.4, 1.6)));
    const isBlocking =
      blocking.enabled || (blocking.until && now() >= blocking.until);
    if (!blocking.enabled && blocking.until && now() >= blocking.until) {
      blocking = {enabled: true, until: null};
    }
    for (let i = 0; i < n; i++) {
      const ad = Math.random() < sim.blockRate;
      const domain = ad ? choice(ADS) : choice(DOMAINS);
      const client = choice(sim.clients);
      const blocked = ad && isBlocking;
      const cached = !blocked && Math.random() < 0.35;
      const upstream = blocked || cached ? null : choice(UPSTREAMS);
      const type = choice(TYPES);
      const q: MockQuery = {
        id: nextId++,
        time: now(),
        type,
        domain,
        cname: null,
        status: blocked
          ? Math.random() < 0.9
            ? 'GRAVITY'
            : 'REGEX'
          : cached
            ? 'CACHE'
            : 'FORWARDED',
        client: {
          ip: client.startsWith('192.')
            ? client
            : `192.168.1.${(client.length * 7) % 250}`,
          name: client.startsWith('192.') ? null : client,
        },
        dnssec: 'UNKNOWN',
        reply: {
          type: blocked ? 'IP' : 'IP',
          time: blocked || cached ? rand(0.00002, 0.0002) : rand(0.006, 0.06),
        },
        list_id: null,
        upstream: upstream ? `${upstream.ip}#${upstream.port}` : null,
        dbid: 0,
      };
      queries.unshift(q);
      bump(blocked ? counts.blocked : counts.domains, domain);
      bump(counts.clients, client);
      bump(counts.types, type);
      if (upstream) bump(counts.upstreams, upstream.ip);
      const bucket = history[history.length - 1];
      if (q.time - bucket.timestamp >= 600) {
        history.shift();
        history.push({
          timestamp: bucket.timestamp + 600,
          total: 0,
          blocked: 0,
          cached: 0,
          forwarded: 0,
        });
      }
      history[history.length - 1].total++;
      if (blocked) history[history.length - 1].blocked++;
    }
    queries.length = Math.min(queries.length, 500);
  }
  setInterval(generate, 1000);

  function totals(): {total: number; blocked: number} {
    const total = history.reduce((a, h) => a + h.total, 0);
    const blocked = history.reduce((a, h) => a + h.blocked, 0);
    return {total, blocked};
  }
  function top(m: Map<string, number>, count: number): Array<[string, number]> {
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, count);
  }
  // Scale the simulated counts up to plausible daily totals.
  function scale(n: number): number {
    return Math.round(n * 40);
  }

  const routes: Record<string, Route> = {
    'GET /stats/summary': () => {
      const {total, blocked} = totals();
      const types = Object.fromEntries(
        TYPES.map(t => [t, scale(counts.types.get(t) ?? 0)]),
      );
      return {
        queries: {
          total,
          blocked,
          percent_blocked: total ? (blocked / total) * 100 : 0,
          unique_domains: 400 + DOMAINS.length * 13,
          forwarded: Math.round((total - blocked) * 0.62),
          cached: Math.round((total - blocked) * 0.38),
          frequency: sim.rate,
          types,
        },
        clients: {active: sim.clients.length, total: sim.clients.length + 2},
        gravity: {
          domains_being_blocked: 168_432 + (sim.port === 8083 ? 61_220 : 0),
          last_update: Math.floor(now() - 86400 * 2),
        },
        took: 0.0003,
      };
    },
    'GET /history': () => ({history, took: 0.001}),
    'GET /queries': url => {
      const length = Number(url.searchParams.get('length') ?? 100);
      return {
        queries: queries.slice(0, length),
        cursor: nextId,
        recordsTotal: queries.length,
        recordsFiltered: queries.length,
        draw: 0,
        took: 0.001,
      };
    },
    'GET /stats/top_domains': url => {
      const blocked = url.searchParams.get('blocked') === 'true';
      const count = Number(url.searchParams.get('count') ?? 10);
      return {
        domains: top(blocked ? counts.blocked : counts.domains, count).map(
          ([domain, c]) => ({domain, count: scale(c)}),
        ),
        took: 0.001,
      };
    },
    'GET /stats/top_clients': url => {
      const count = Number(url.searchParams.get('count') ?? 10);
      return {
        clients: top(counts.clients, count).map(([name, c]) => ({
          ip: name.startsWith('192.')
            ? name
            : `192.168.1.${(name.length * 7) % 250}`,
          name: name.startsWith('192.') ? '' : name,
          count: scale(c),
        })),
        took: 0.001,
      };
    },
    'GET /stats/upstreams': () => ({
      upstreams: UPSTREAMS.map(u => ({
        ...u,
        count: scale(counts.upstreams.get(u.ip) ?? 0),
        statistics: {response: rand(0.008, 0.04), variance: 0.001},
      })),
      forwarded_queries: 0,
      total_queries: 0,
      took: 0.001,
    }),
    'GET /dns/blocking': () => ({
      blocking: blocking.enabled ? 'enabled' : 'disabled',
      timer: blocking.until ? Math.max(0, blocking.until - now()) : null,
      took: 0.0001,
    }),
    'POST /dns/blocking': (_url, body) => {
      blocking = {
        enabled: Boolean(body.blocking),
        until: body.timer ? now() + body.timer : null,
      };
      return routes['GET /dns/blocking'](_url, body);
    },
    'GET /info/system': () => ({
      system: {
        uptime: 86400 * 12 + sim.port,
        procs: 140,
        memory: {ram: {'%used': rand(28, 46)}},
        cpu: {
          nprocs: 4,
          '%cpu': rand(1, 9),
          load: {raw: [rand(0, 0.6), 0.3, 0.2], percent: [rand(0, 15), 7, 5]},
        },
      },
      took: 0.001,
    }),
    'GET /info/version': () => ({
      version: {
        core: {
          local: {version: 'v6.1', hash: 'abc1'},
          remote: {version: 'v6.1', hash: 'abc1'},
        },
        web: {
          local: {version: 'v6.1', hash: 'def2'},
          remote: {version: 'v6.1', hash: 'def2'},
        },
        ftl: {
          local: {version: 'v6.1', hash: '9a8b'},
          remote: {
            version: sim.port === 8082 ? 'v6.2' : 'v6.1',
            hash: sim.port === 8082 ? '9a8c' : '9a8b',
          },
        },
        docker: {local: sim.port === 8083 ? '2025.03.0' : null},
      },
      took: 0.001,
    }),
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
    });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', `http://localhost:${sim.port}`);
      const sid = String(req.headers['x-ftl-sid'] ?? '');
      function send(status: number, data: unknown): void {
        res.writeHead(status, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(data));
      }
      if (!url.pathname.startsWith('/api/')) {
        return send(404, {error: {key: 'not_found'}});
      }
      const route = url.pathname.slice(4);

      if (route === '/auth' && req.method === 'POST') {
        const {password} = JSON.parse(body || '{}') as {password?: string};
        if (!sim.password) {
          return send(200, {
            session: {
              valid: true,
              totp: false,
              sid: null,
              csrf: null,
              validity: -1,
            },
          });
        }
        if (password !== sim.password) {
          return send(401, {
            session: {
              valid: false,
              totp: false,
              sid: null,
              message: 'password incorrect',
            },
          });
        }
        const newSid = crypto.randomBytes(12).toString('base64');
        sessions.add(newSid);
        return send(200, {
          session: {
            valid: true,
            totp: false,
            sid: newSid,
            csrf: 'x',
            validity: 1800,
          },
        });
      }
      if (route === '/auth' && req.method === 'DELETE') {
        sessions.delete(sid);
        res.writeHead(204);
        return res.end();
      }
      if (sim.password && !sessions.has(sid)) {
        return send(401, {
          error: {key: 'unauthorized', message: 'Unauthorized'},
        });
      }
      const handler = routes[`${req.method} ${route}`];
      if (!handler) {
        return send(404, {
          error: {key: 'not_found', message: `No route ${route}`},
        });
      }
      // Simulate a little network latency.
      setTimeout(
        () => send(200, handler(url, JSON.parse(body || '{}') as BlockingBody)),
        rand(5, 40),
      );
    });
  });
  server.listen(sim.port, '127.0.0.1', () =>
    console.log(
      `Mock Pi-hole listening on http://127.0.0.1:${sim.port}${sim.password ? ' (password: demo)' : ' (no password)'}`,
    ),
  );
}

for (const sim of SIMS) createSim(sim);
