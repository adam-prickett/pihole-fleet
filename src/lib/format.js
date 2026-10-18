const nf = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export const fmtNumber = (n) => (n == null ? '—' : nf.format(Math.round(n)));
export const fmtCompact = (n) => (n == null ? '—' : n < 10000 ? nf.format(Math.round(n)) : compact.format(n));
export const fmtPercent = (n, digits = 1) => (n == null || Number.isNaN(n) ? '—' : `${n.toFixed(digits)}%`);

export function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

export function fmtDuration(seconds) {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function fmtAgo(ts, now = Date.now()) {
  if (!ts) return 'never';
  const s = Math.round((now - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const hmFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
export const fmtClock = (unixSeconds) => timeFmt.format(unixSeconds * 1000);
export const fmtHM = (unixSeconds) => hmFmt.format(unixSeconds * 1000);

export const hostOf = (url) => {
  try { return new URL(url).host; } catch { return url; }
};
