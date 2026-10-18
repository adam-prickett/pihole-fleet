const nf = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

type MaybeNumber = number | null | undefined;

export function fmtNumber(n: MaybeNumber): string {
  return n == null ? '—' : nf.format(Math.round(n));
}

export function fmtCompact(n: MaybeNumber): string {
  if (n == null) return '—';
  return n < 10000 ? nf.format(Math.round(n)) : compact.format(n);
}

export function fmtPercent(n: MaybeNumber, digits = 1): string {
  return n == null || Number.isNaN(n) ? '—' : `${n.toFixed(digits)}%`;
}

export function fmtMs(ms: MaybeNumber): string {
  if (ms == null) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

export function fmtDuration(seconds: MaybeNumber): string {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function fmtAgo(ts: MaybeNumber, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.round((now - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const hmFmt = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});

export function fmtClock(unixSeconds: number): string {
  return timeFmt.format(unixSeconds * 1000);
}

export function fmtHM(unixSeconds: number): string {
  return hmFmt.format(unixSeconds * 1000);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
