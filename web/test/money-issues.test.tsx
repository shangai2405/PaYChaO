import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Finding, Run, Verdict } from '../src/api';
import { FindingCard } from '../src/components/FindingCard';
import { ConfirmDialog, IssueChip, Money } from '../src/components/ui';
import { VerdictPanel } from '../src/components/Verdict';
import { amountText, formatMoney, moneyText } from '../src/format';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('money', () => {
  it('formats minor units exactly, per currency', () => {
    expect(formatMoney(125000, 'USD')).toBe('1,250.00 USD');
    expect(formatMoney('5', 'EUR')).toBe('0.05 EUR');
    expect(formatMoney('1500', 'JPY')).toBe('1,500 JPY');
    // Beyond Number.MAX_SAFE_INTEGER: still exact.
    expect(formatMoney('900719925474099312', 'USD')).toBe('9,007,199,254,740,993.12 USD');
    expect(moneyText([{ amount_minor: 5000, currency: 'USD' }, { amount_minor: '300', currency: 'EUR' }])).toBe('50.00 USD + 3.00 EUR');
    expect(amountText({ amount_minor: null, currency: 'USD' })).toBe('');
  });

  it('tells "no money at risk" apart from "not recorded"', () => {
    const { rerender } = render(<Money totals={[]} />);
    expect(screen.getByText('none')).toBeTruthy();
    rerender(<Money totals={null} />);
    expect(screen.getByText('—')).toBeTruthy();
  });
});

const finding: Finding = {
  id: '1', code: 'UNSAFE_RETRY_AFTER_LOST_RESPONSE', severity: 'HIGH', message: 'm', path: '/v2/checkout/orders',
  operation: 'create_order', fingerprint: 'fp', requests: [1, 2], object_ids: [], at: '2026-11-10T10:00:00Z', final: true,
  amount_minor: '5000', currency: 'USD', issue_id: '7', issue_status: 'regressed', issue_ignored_at: null,
};

describe('finding card', () => {
  it('shows the amount at risk and where the problem stands across runs', () => {
    render(<MemoryRouter><ul><FindingCard f={finding} /></ul></MemoryRouter>);
    expect(screen.getByText('50.00 USD at risk')).toBeTruthy();
    expect(screen.getByText('regressed')).toBeTruthy();
  });

  it('marks ignored problems in words', () => {
    render(<IssueChip status="open" ignored />);
    expect(screen.getByText('ignored')).toBeTruthy();
  });
});

describe('confirm dialog with a reason', () => {
  it('passes the typed reason to the action', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        options={{ title: 'Ignore?', body: null, confirm: 'Ignore problem', input: { label: 'Reason' } }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  sandbox only ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ignore problem' }));
    expect(onConfirm).toHaveBeenCalledWith('sandbox only');
  });
});

const verdict: Verdict = {
  run: { id: 'r2', branch: 'fix', commit_sha: 'abc', pr_number: 4, base_branch: 'main' },
  baseline: { id: 'r1', name: 'main nightly', branch: 'main', commit_sha: 'def4567890', started_at: '2026-11-09T00:00:00Z', seed: '1' },
  base_branch: 'main',
  new: [{ key: 'k1', code: 'UNSAFE_RETRY_AFTER_LOST_RESPONSE', severity: 'HIGH', operation: 'capture_order', path: '', message: '', count: 2,
    money_at_risk: [{ currency: 'USD', amount_minor: 5000, findings: 2 }] }],
  fixed: [], unchanged: [],
  not_retested: [{ key: 'k2', code: 'TOKEN_NOT_REFRESHED', severity: 'MEDIUM', operation: 'create_order', path: '', message: '', count: 1, money_at_risk: [] }],
  ignored: [], money_at_risk: [{ currency: 'USD', amount_minor: 5000, findings: 2 }],
  new_money_at_risk: [{ currency: 'USD', amount_minor: 5000, findings: 2 }], worst_new: 'HIGH', comparable: false, markdown: '### paychaos verdict',
};

describe('verdict panel', () => {
  it('shows new, not-retested and the comparison it is based on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(verdict), { status: 200 })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <VerdictPanel run={{ id: 'r2' } as Run} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('1 new problem (1 high)')).toBeTruthy());
    expect(screen.getByText('main nightly')).toBeTruthy();
    expect(screen.getByText('Not retested')).toBeTruthy();
    expect(screen.getByText(/different seeds/)).toBeTruthy();
    expect(screen.getAllByText('50.00 USD').length).toBeGreaterThan(0);
  });
});
