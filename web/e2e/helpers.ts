import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

/** Creates a project and an ingest token through the API. */
export async function seedProject(request: APIRequestContext, name: string) {
  const p = await (await request.post('/api/projects', { data: { name } })).json();
  const t = await (await request.post(`/api/projects/${p.id}/tokens`, { data: { label: 'e2e' } })).json();
  return { id: p.id as string, token: t.token as string };
}

/** Streams a finished run into a project, as the engine would. */
export async function seedRun(
  request: APIRequestContext,
  token: string,
  opts: {
    name: string;
    startedAt: string;
    high?: number;
    medium?: number;
    /** Amount on each HIGH finding, in minor units of USD. */
    amountMinor?: number;
    ci?: Record<string, unknown>;
  },
) {
  const id = randomUUID();
  const headers = { authorization: `Bearer ${token}` };
  await request.put(`/api/ingest/runs/${id}`, {
    headers,
    data: { name: opts.name, seed: 7, upstream: 'mock', scenario: { seed: 7, rules: [] }, started_at: opts.startedAt, engine_version: 'e2e', ci: opts.ci },
  });
  const rec = (seq: number, fault = 'none') => ({
    kind: 'request',
    request: {
      seq, at: opts.startedAt, done: opts.startedAt, method: 'POST', path: '/v2/checkout/orders', operation: 'create_order',
      request_id: '', fingerprint: 'fp1', fault, upstream_status: 201, object_id: `ORDER-${seq}`, committed: true, response_delivered: fault === 'none',
    },
  });
  await request.post(`/api/ingest/runs/${id}/batches`, { headers, data: { seq: 1, events: [rec(1, 'drop_after_commit'), rec(2)] } });
  const findings = [
    ...Array.from({ length: opts.high ?? 0 }, () => ({
      code: 'UNSAFE_RETRY_AFTER_LOST_RESPONSE', severity: 'HIGH', path: '/v2/checkout/orders', operation: 'create_order', fingerprint: 'fp1',
      requests: [1, 2], object_ids: ['ORDER-1', 'ORDER-2'], at: opts.startedAt,
      message: 'request #1 succeeded upstream but its response was lost; retry #2 also succeeded',
      ...(opts.amountMinor ? { amount_minor: opts.amountMinor, currency: 'USD' } : {}),
    })),
    ...Array.from({ length: opts.medium ?? 0 }, () => ({
      code: 'MISSING_REQUEST_ID', severity: 'MEDIUM', path: '/v2/checkout/orders', operation: 'create_order', fingerprint: 'fp1',
      requests: [1], object_ids: [], at: opts.startedAt, message: 'POST /v2/checkout/orders sent without a PayPal-Request-Id header',
    })),
  ];
  await request.post(`/api/ingest/runs/${id}/finish`, {
    headers,
    data: { finished_at: opts.startedAt, findings, request_count: 2, faults_applied: { drop_after_commit: 1 } },
  });
  return id;
}

export const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
