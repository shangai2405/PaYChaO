import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { Operation } from '../src/api';
import { CompareTable } from '../src/components/CompareTable';
import { Timeline } from '../src/components/Timeline';
import { outcome } from '../src/format';
import { parseConfig, STARTER } from '../src/pages/Scenarios';

afterEach(cleanup);

const attempt = (seq: number, over: Partial<Operation['timeline'][number]> = {}) => ({
  seq, at: '', done: null, method: 'POST', path: '/v2/payments/captures/C/refund', request_id: '', fault: 'none',
  upstream_status: 201, issue: '', object_id: `REF${seq}`, committed: true, response_delivered: false, ...over,
});

describe('Timeline', () => {
  it('shows a lost response followed by a duplicate', () => {
    const op: Operation = {
      fingerprint: 'fp', operation: 'refund_capture', path: '/v2/payments/captures/C/refund', attempts: 2, created: 2,
      timeline: [attempt(4, { fault: 'drop_after_commit' }), attempt(5)],
      findings: [{ code: 'UNSAFE_RETRY_AFTER_LOST_RESPONSE', severity: 'HIGH' }],
    };
    render(<MemoryRouter><Timeline op={op} /></MemoryRouter>);
    expect(screen.getByText('refund_capture')).toBeTruthy();
    expect(screen.getByText('committed, connection reset')).toBeTruthy();
    expect(screen.getByText(/2 resources created/)).toBeTruthy();
    expect(screen.getByText('REF4')).toBeTruthy();
    expect(screen.getByText('REF5')).toBeTruthy();
    expect(screen.getAllByText('no request id')).toHaveLength(2);
  });

  it('does not claim a duplicate when a same-id retry returned the same resource', () => {
    const op: Operation = {
      fingerprint: 'fp', operation: 'capture_order', path: '/p', attempts: 2, created: 1,
      timeline: [attempt(1, { fault: 'drop_after_commit', object_id: 'CAP', request_id: 'abc' }), attempt(2, { object_id: 'CAP', request_id: 'abc' })],
      findings: [],
    };
    render(<Timeline op={op} />);
    expect(screen.queryByText(/resources created/)).toBeNull();
  });
});

describe('CompareTable', () => {
  it('marks regressions and improvements', () => {
    const { container } = render(
      <CompareTable rows={[
        { severity: 'HIGH', code: 'UNSAFE_RETRY_AFTER_LOST_RESPONSE', path: '/v2/checkout/orders', baseline: 0, current: 2, delta: 2 },
        { severity: 'LOW', code: 'RETRY_WITHOUT_BACKOFF', path: '/v2/checkout/orders', baseline: 3, current: 1, delta: -2 },
      ]} />,
    );
    expect(container.querySelector('tr.worse td.delta')?.textContent).toBe('+2');
    expect(container.querySelector('tr.better td.delta')?.textContent).toBe('-2');
  });
});

describe('outcome', () => {
  it('describes what the client saw', () => {
    expect(outcome({ fault: 'none', upstream_status: 422, committed: false, issue: 'ORDER_ALREADY_CAPTURED', response_delivered: false }).label)
      .toBe('422 ORDER_ALREADY_CAPTURED');
    expect(outcome({ fault: 'hold_response', upstream_status: 201, committed: true, issue: '', response_delivered: true }).tone).toBe('ok');
    expect(outcome({ fault: 'token_expired_401', upstream_status: 0, committed: false, issue: '', response_delivered: false }).label).toBe('401 injected');
  });
});

describe('scenario editor', () => {
  it('reports JSON syntax errors before validation', () => {
    expect(parseConfig('{').issues[0]?.message).toMatch(/not valid JSON/);
    expect(parseConfig(JSON.stringify(STARTER)).issues).toEqual([]);
  });
});
