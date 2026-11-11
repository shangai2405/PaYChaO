/** Money in minor units of one currency. Never mixed, never floating point sums. */
export interface MoneyTotal {
  currency: string;
  amount_minor: number;
  findings: number;
}

const ZERO_DECIMAL = new Set(['JPY', 'HUF', 'TWD']);

export function exponent(currency: string): number {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

/** "1,250.00 USD", "500 JPY". */
export function formatMoney(amountMinor: number | string, currency: string): string {
  const n = BigInt(amountMinor);
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString();
  const exp = exponent(currency);
  const padded = digits.padStart(exp + 1, '0');
  const whole = padded.slice(0, padded.length - exp).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = exp > 0 ? `.${padded.slice(padded.length - exp)}` : '';
  return `${neg ? '-' : ''}${whole}${frac} ${currency}`;
}

/** Totals per currency, largest first. */
export function totals(items: { amount_minor?: number | string | null; currency?: string | null }[]): MoneyTotal[] {
  const by = new Map<string, MoneyTotal>();
  for (const it of items) {
    if (!it.currency || it.amount_minor === null || it.amount_minor === undefined) continue;
    const t = by.get(it.currency) ?? { currency: it.currency, amount_minor: 0, findings: 0 };
    t.amount_minor += Number(it.amount_minor);
    t.findings += 1;
    by.set(it.currency, t);
  }
  return [...by.values()].sort((a, b) => b.amount_minor - a.amount_minor || a.currency.localeCompare(b.currency));
}

export function moneyText(ts: MoneyTotal[]): string {
  return ts.map((t) => formatMoney(t.amount_minor, t.currency)).join(' + ');
}
