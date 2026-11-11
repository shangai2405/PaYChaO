export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function duration(from: string, to: string | null): string {
  if (!to) return 'running';
  const ms = Date.parse(to) - Date.parse(from);
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Human description of one attempt's outcome, as the client saw it. */
export function outcome(a: {
  fault: string;
  upstream_status: number;
  committed: boolean;
  issue: string;
  response_delivered: boolean;
}): { label: string; tone: 'ok' | 'bad' | 'warn' | 'muted' } {
  switch (a.fault) {
    case 'drop_after_commit':
      return { label: a.committed ? 'committed, connection reset' : 'connection reset', tone: a.committed ? 'bad' : 'warn' };
    case 'truncate_after_commit':
      return { label: 'committed, body truncated', tone: 'bad' };
    case 'error_500_after_commit':
      return { label: 'committed, told 500', tone: 'bad' };
    case 'hold_response':
      return a.response_delivered ? { label: 'slow but delivered', tone: 'ok' } : { label: 'committed, client gave up', tone: 'bad' };
    case 'rate_limit_429':
      return { label: '429 injected', tone: 'warn' };
    case 'error_500':
      return { label: '500 injected', tone: 'warn' };
    case 'timeout_before_forward':
      return { label: '504 injected', tone: 'warn' };
    case 'token_expired_401':
      return { label: '401 injected', tone: 'warn' };
  }
  if (a.committed) return { label: `${a.upstream_status} ok`, tone: 'ok' };
  if (a.issue) return { label: `${a.upstream_status} ${a.issue}`, tone: 'warn' };
  return { label: a.upstream_status ? String(a.upstream_status) : 'no response', tone: 'muted' };
}

/** "3 min ago", "2 days ago": for lists, where the exact time is noise. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  const units: [number, string][] = [
    [60, 'min'],
    [3600, 'hour'],
    [86400, 'day'],
    [86400 * 30, 'month'],
    [86400 * 365, 'year'],
  ];
  let unit = units[0]!;
  for (const u of units) if (s >= u[0]) unit = u;
  const n = Math.round(s / unit[0]);
  const label = unit[1] === 'min' ? 'min' : unit[1] + (n === 1 ? '' : 's');
  return `${n} ${label} ago`;
}

const ZERO_DECIMAL = new Set(['JPY', 'HUF', 'TWD']);

/**
 * "1,250.00 USD" from minor units. BigInt, so large amounts stay exact; the
 * API sends bigint columns as strings.
 */
export function formatMoney(amountMinor: number | string, currency: string): string {
  let n: bigint;
  try {
    n = BigInt(amountMinor);
  } catch {
    return `? ${currency}`;
  }
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString();
  const exp = ZERO_DECIMAL.has(currency) ? 0 : 2;
  const padded = digits.padStart(exp + 1, '0');
  const whole = padded.slice(0, padded.length - exp).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = exp > 0 ? `.${padded.slice(padded.length - exp)}` : '';
  return `${neg ? '-' : ''}${whole}${frac} ${currency}`;
}

/** Per-currency totals joined with "+": currencies are never added together. */
export function moneyText(ts: { amount_minor: number | string; currency: string }[] | null | undefined): string {
  return (ts ?? []).map((t) => formatMoney(t.amount_minor, t.currency)).join(' + ');
}

/** The amount of one finding or request, or '' when it carried none. */
export function amountText(x: { amount_minor?: number | string | null; currency?: string | null }): string {
  return x.currency && x.amount_minor !== null && x.amount_minor !== undefined ? formatMoney(x.amount_minor, x.currency) : '';
}
