import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Finding, TrendRun } from '../src/api';
import { FindingCard } from '../src/components/FindingCard';
import { ticks, TrendChart } from '../src/components/TrendChart';
import { ConfirmDialog, HealthBadge, healthOf } from '../src/components/ui';
import { ago } from '../src/format';
import { GUIDES, guideFor } from '../src/guides';

afterEach(cleanup);

// The engine's finding codes (internal/audit/audit.go). A new code without a
// guide fails here, so the dashboard never shows a finding it can't explain.
const ENGINE_CODES = ['ALREADY_CAPTURED_NOT_RECONCILED','COMMITTED_BUT_REPORTED_AS_FAILED','MISSING_REQUEST_ID','NEW_REQUEST_ID_AFTER_INDETERMINATE_ERROR','REQUEST_ID_REUSED_WITH_DIFFERENT_BODY','REQUEST_ID_TOO_LONG','RETRY_WITHOUT_BACKOFF','TOKEN_NOT_REFRESHED','TRUNCATED_SUCCESS_NOT_RETRIED','UNSAFE_RETRY_AFTER_LOST_RESPONSE','UNSAFE_RETRY_FAILED_THIS_TIME'];

describe('fix guides', () => {
  it('cover every finding code the engine can raise, and nothing else', () => {
    expect(GUIDES.map((g) => g.code).sort()).toEqual([...ENGINE_CODES].sort());
    for (const g of GUIDES) {
      expect(g.fix.length).toBeGreaterThan(0);
      expect(g.impact.length).toBeGreaterThan(10);
    }
  });
});

const finding: Finding = {
  id: '1', code: 'UNSAFE_RETRY_AFTER_LOST_RESPONSE', severity: 'HIGH', message: 'request #1 succeeded upstream…', path: '/v2/checkout/orders',
  operation: 'create_order', fingerprint: 'fp', requests: [1, 2], object_ids: ['A', 'B'], at: '2026-11-10T10:00:00Z', final: true,
};

describe('FindingCard', () => {
  it('shows the plain-language title and opens the fix guide on demand', () => {
    render(<MemoryRouter><ul><FindingCard f={finding} /></ul></MemoryRouter>);
    expect(screen.getByText('Retry created a duplicate payment')).toBeTruthy();
    expect(screen.getByText('requests #1, #2')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'How to fix this' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/How to fix it/)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide fix guide' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('How to fix it')).toBeTruthy();
  });

  it('still renders an unknown code from a newer engine', () => {
    render(<MemoryRouter><ul><FindingCard f={{ ...finding, code: 'SOMETHING_NEW' }} /></ul></MemoryRouter>);
    expect(screen.getAllByText('SOMETHING_NEW').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'How to fix this' })).toBeNull();
    expect(guideFor('SOMETHING_NEW')).toBeUndefined();
  });
});

describe('ConfirmDialog', () => {
  it('needs the typed name before a destructive confirm, and Escape cancels', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open options={{ title: 'Delete shop?', body: 'gone', confirm: 'Delete project', danger: true, typeToConfirm: 'shop' }} onConfirm={onConfirm} onCancel={onCancel} />,
    );
    const btn = screen.getByRole('button', { name: 'Delete project' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'shop' } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('renders nothing when closed', () => {
    const { container } = render(<ConfirmDialog open={false} options={{ title: 'x', body: '', confirm: 'ok' }} onConfirm={() => {}} onCancel={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('health', () => {
  it('derives status from the latest run and labels it with text, not colour alone', () => {
    expect(healthOf(null)).toBe('no_runs');
    expect(healthOf({ high: 1, medium: 0 })).toBe('failing');
    expect(healthOf({ high: 0, medium: 2 })).toBe('warning');
    expect(healthOf({ high: 0, medium: 0 })).toBe('passing');
    render(<HealthBadge status="failing" />);
    expect(screen.getByText('Failing')).toBeTruthy();
  });
});

describe('TrendChart', () => {
  const run = (i: number, high: number, medium: number, low: number): TrendRun => ({
    id: `0000000${i}-0000-4000-8000-000000000000`, name: `run ${i}`, seed: '7', started_at: `2026-11-0${i}T10:00:00Z`,
    finished_at: null, request_count: 10, high, medium, low,
  });

  it('picks round axis ticks that cover the maximum', () => {
    expect(ticks(0)).toEqual([0, 1]);
    expect(ticks(9)).toEqual([0, 5, 10]);
    expect(ticks(4)).toEqual([0, 1, 2, 3, 4]);
    expect(ticks(37).at(-1)).toBeGreaterThanOrEqual(37);
    for (const t of ticks(1234)) expect(Number.isInteger(t)).toBe(true);
  });

  it('labels each column for screen readers and offers a table view', () => {
    render(<MemoryRouter><TrendChart runs={[run(1, 2, 1, 0), run(2, 0, 0, 0)]} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'run 1: 2 high, 1 medium, 0 low' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show as table' }));
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });
});

describe('ago', () => {
  it('says how long ago, in words', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    expect(ago('2026-11-10T11:59:50Z', now)).toBe('just now');
    expect(ago('2026-11-10T11:55:00Z', now)).toBe('5 min ago');
    expect(ago('2026-11-10T09:00:00Z', now)).toBe('3 hours ago');
    expect(ago('2026-11-09T12:00:00Z', now)).toBe('1 day ago');
    expect(ago(null)).toBe('—');
  });
});
