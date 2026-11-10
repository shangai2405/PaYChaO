import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/auth.js';
import { migrate } from '../src/db.js';
import { compareFindings } from '../src/routes/dashboard.js';
import { finding, json, projectWithToken, record, RUN_A, runMeta, setup, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx?.close();
});

describe('migrations', () => {
  it('are recorded and not re-applied', async () => {
    expect(await migrate(ctx.pool)).toEqual([]);
    const { rows } = await ctx.pool.query('SELECT version FROM schema_migrations');
    expect(rows.map((r) => r.version)).toContain('001_init.sql');
  });
});

describe('projects and tokens', () => {
  it('creates projects and rejects duplicates and blank names', async () => {
    expect((await json(ctx.app, 'POST', '/api/projects', { name: 'alpha' })).status).toBe(201);
    expect((await json(ctx.app, 'POST', '/api/projects', { name: 'alpha' })).status).toBe(409);
    const bad = await json(ctx.app, 'POST', '/api/projects', { name: '  ' });
    expect(bad.status).toBe(400);
    expect(bad.body.issues[0].path).toBe('name');
    const list = await json(ctx.app, 'GET', '/api/projects');
    expect(list.body.projects.some((p: { name: string }) => p.name === 'alpha')).toBe(true);
    expect((await json(ctx.app, 'GET', '/api/projects/not-a-uuid')).status).toBe(400);
    expect((await json(ctx.app, 'GET', `/api/projects/${RUN_A}`)).status).toBe(404);
  });

  it('shows a token once and stores only its hash', async () => {
    const { projectId, token, tokenId } = await projectWithToken(ctx.app, 'tokens');
    expect(token).toMatch(/^pct_[A-Za-z0-9_-]{43}$/);
    const listed = await json(ctx.app, 'GET', `/api/projects/${projectId}/tokens`);
    expect(JSON.stringify(listed.body)).not.toContain(token);
    expect(listed.body.tokens[0].prefix).toBe(token.slice(0, 10));
    const { rows } = await ctx.pool.query('SELECT token_hash FROM ingest_tokens WHERE id = $1', [tokenId]);
    expect(rows[0].token_hash.equals(hashToken(token))).toBe(true);
    const dump = await ctx.pool.query("SELECT to_jsonb(t)::text AS j FROM ingest_tokens t");
    expect(dump.rows.map((r) => r.j).join()).not.toContain(token.slice(10));
  });

  it('refuses a revoked token', async () => {
    const { token, tokenId } = await projectWithToken(ctx.app, 'revoked');
    expect((await json(ctx.app, 'PUT', `/api/ingest/runs/${RUN_A}`, runMeta(), token)).status).toBe(201);
    expect((await json(ctx.app, 'DELETE', `/api/tokens/${tokenId}`)).status).toBe(204);
    expect((await json(ctx.app, 'PUT', `/api/ingest/runs/${RUN_A}`, runMeta(), token)).status).toBe(401);
    expect((await json(ctx.app, 'PUT', `/api/ingest/runs/${RUN_A}`, runMeta())).status).toBe(401);
    await json(ctx.app, 'DELETE', `/api/runs/${RUN_A}`);
  });
});

describe('ingest', () => {
  it('creates a run idempotently and keeps it in its project', async () => {
    const a = await projectWithToken(ctx.app, 'ingest-a');
    const b = await projectWithToken(ctx.app, 'ingest-b');
    const id = '11111111-1111-4111-8111-111111111111';
    const first = await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, runMeta({ seed: '18446744073709551615' }), a.token);
    expect(first.status).toBe(201);
    expect((await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, runMeta(), a.token)).status).toBe(200);
    expect((await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, runMeta(), b.token)).status).toBe(404);
    const run = await json(ctx.app, 'GET', `/api/runs/${id}`);
    expect(run.body.seed).toBe('18446744073709551615'); // uint64 kept exact
    expect(run.body.status).toBe('running');
  });

  it('stores a batch once even when it is sent twice', async () => {
    const { token } = await projectWithToken(ctx.app, 'dupes');
    const id = '22222222-2222-4222-8222-222222222222';
    await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, runMeta(), token);
    const batch = {
      seq: 1,
      events: [
        record(1, { fault: 'drop_after_commit' }),
        record(2),
        { kind: 'finding', finding: finding() },
        { kind: 'webhook', webhook: { event_id: 'WH-1', type: 'PAYMENT.CAPTURE.COMPLETED', copy: 0, received_order: 1, delivered_order: 1, status: 200, at: '2026-11-10T10:00:03Z' } },
      ],
    };
    const r1 = await json(ctx.app, 'POST', `/api/ingest/runs/${id}/batches`, batch, token);
    const r2 = await json(ctx.app, 'POST', `/api/ingest/runs/${id}/batches`, batch, token);
    expect([r1.status, r1.body.duplicate]).toEqual([201, false]);
    expect([r2.status, r2.body.duplicate]).toEqual([200, true]);
    const reqs = await json(ctx.app, 'GET', `/api/runs/${id}/requests`);
    expect(reqs.body.requests).toHaveLength(2);
    expect(reqs.body.requests[0].done).toBeNull(); // Go's zero time
    const fs = await json(ctx.app, 'GET', `/api/runs/${id}/findings`);
    expect(fs.body.findings).toHaveLength(1);
    expect(fs.body.findings[0]).toMatchObject({ requests: [1, 2], object_ids: ['ORDER1', 'ORDER2'], final: false });
    const wh = await json(ctx.app, 'GET', `/api/runs/${id}/webhooks`);
    expect(wh.body.deliveries).toHaveLength(1);
  });

  it('applies a later version of a record, even within one batch', async () => {
    const { token } = await projectWithToken(ctx.app, 'updates');
    const id = '33333333-3333-4333-8333-333333333333';
    await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, runMeta(), token);
    const res = await json(ctx.app, 'POST', `/api/ingest/runs/${id}/batches`, {
      seq: 1, events: [record(1, { fault: 'hold_response' }), record(1, { fault: 'hold_response', response_delivered: true })],
    }, token);
    expect(res.status).toBe(201);
    await json(ctx.app, 'POST', `/api/ingest/runs/${id}/batches`, { seq: 2, events: [record(1, { fault: 'hold_response', response_delivered: false })] }, token);
    const reqs = await json(ctx.app, 'GET', `/api/runs/${id}/requests`);
    expect(reqs.body.requests[0].response_delivered).toBe(true); // never un-delivered
  });

  it('rejects malformed batches and unknown runs', async () => {
    const { token } = await projectWithToken(ctx.app, 'bad');
    const id = '44444444-4444-4444-8444-444444444444';
    await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, runMeta(), token);
    expect((await json(ctx.app, 'POST', `/api/ingest/runs/${id}/batches`, { seq: 0, events: [] }, token)).status).toBe(400);
    expect((await json(ctx.app, 'POST', `/api/ingest/runs/${id}/batches`, { seq: 1, events: [{ kind: 'nope' }] }, token)).status).toBe(400);
    expect((await json(ctx.app, 'POST', `/api/ingest/runs/${id}/batches`, { seq: 1, events: [{ kind: 'finding', finding: finding({ severity: 'URGENT' }) }] }, token)).status).toBe(400);
    expect((await json(ctx.app, 'POST', `/api/ingest/runs/${RUN_A}/batches`, { seq: 1, events: [] }, token)).status).toBe(404);
    expect((await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, { seed: -1 }, token)).status).toBe(400);
  });

  it('finish replaces provisional findings and is idempotent', async () => {
    const { token } = await projectWithToken(ctx.app, 'finish');
    const id = '55555555-5555-4555-8555-555555555555';
    await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, runMeta(), token);
    await json(ctx.app, 'POST', `/api/ingest/runs/${id}/batches`, { seq: 1, events: [{ kind: 'finding', finding: finding() }] }, token);
    const fin = {
      finished_at: '2026-11-10T10:05:00Z', request_count: 3,
      findings: [finding(), finding({ code: 'COMMITTED_BUT_REPORTED_AS_FAILED', severity: 'MEDIUM', requests: [3], object_ids: null })],
      faults_applied: { drop_after_commit: 2 }, webhooks: null, webhook_notes: null,
    };
    for (let i = 0; i < 2; i++) expect((await json(ctx.app, 'POST', `/api/ingest/runs/${id}/finish`, fin, token)).status).toBe(200);
    const fs = await json(ctx.app, 'GET', `/api/runs/${id}/findings`);
    expect(fs.body.findings.map((f: { code: string }) => f.code)).toEqual(['UNSAFE_RETRY_AFTER_LOST_RESPONSE', 'COMMITTED_BUT_REPORTED_AS_FAILED']);
    expect(fs.body.findings.every((f: { final: boolean }) => f.final)).toBe(true);
    expect(fs.body.final).toBe(true);
    const run = await json(ctx.app, 'GET', `/api/runs/${id}`);
    expect(run.body).toMatchObject({ status: 'finished', high: 1, medium: 1, low: 0, request_count: 3, faults_applied: { drop_after_commit: 2 } });
    const high = await json(ctx.app, 'GET', `/api/runs/${id}/findings?severity=high`);
    expect(high.body.findings).toHaveLength(1);
  });
});

describe('runs list', () => {
  it('pages with a keyset cursor, ties included, without gaps or repeats', async () => {
    const { projectId, token } = await projectWithToken(ctx.app, 'paging');
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`;
      ids.push(id);
      // Pairs share a timestamp to the microsecond, to exercise the id tiebreak.
      const ts = `2026-11-10T10:00:0${Math.floor(i / 2)}.123456Z`;
      await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, runMeta({ started_at: ts }), token);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = `/api/projects/${projectId}/runs?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await json(ctx.app, 'GET', q);
      expect(page.status).toBe(200);
      seen.push(...page.body.runs.map((r: { id: string }) => r.id));
      cursor = page.body.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());
    expect((await json(ctx.app, 'GET', `/api/projects/${projectId}/runs?cursor=garbage`)).status).toBe(400);
  });
});

describe('operations timeline', () => {
  it('groups attempts by operation and attaches findings', async () => {
    const { token } = await projectWithToken(ctx.app, 'timeline');
    const id = '66666666-6666-4666-8666-666666666666';
    await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, runMeta(), token);
    await json(ctx.app, 'POST', `/api/ingest/runs/${id}/batches`, {
      seq: 1,
      events: [
        record(1, { fault: 'drop_after_commit' }),
        record(2),
        record(3, { fingerprint: 'fp-single' }),
        record(4, { fingerprint: 'fp-quiet-a' }),
        { kind: 'finding', finding: finding() },
      ],
    }, token);
    const ops = await json(ctx.app, 'GET', `/api/runs/${id}/operations`);
    expect(ops.body.operations).toHaveLength(1);
    const op = ops.body.operations[0];
    expect(op).toMatchObject({ fingerprint: 'fp1', operation: 'create_order', attempts: 2, created: 2 });
    expect(op.timeline.map((t: { seq: number }) => t.seq)).toEqual([1, 2]);
    expect(op.findings).toEqual([{ code: 'UNSAFE_RETRY_AFTER_LOST_RESPONSE', severity: 'HIGH' }]);
  });
});

describe('compare', () => {
  it('counts findings by code, severity and path', () => {
    const f = (code: string, severity: 'HIGH' | 'MEDIUM' | 'LOW', path = '/p') => ({ code, severity, path });
    const d = compareFindings([f('A', 'MEDIUM'), f('B', 'LOW')], [f('A', 'MEDIUM'), f('A', 'MEDIUM'), f('C', 'HIGH')]);
    expect(d.regressed).toBe(true);
    expect(d.worst_new).toBe('HIGH');
    expect(d.rows.map((r) => [r.code, r.delta])).toEqual([['C', 1], ['A', 1], ['B', -1]]);
    expect(compareFindings([f('A', 'LOW')], []).regressed).toBe(false);
  });

  it('compares two stored runs and warns about different seeds', async () => {
    const { token } = await projectWithToken(ctx.app, 'compare');
    const a = '77777777-7777-4777-8777-777777777777';
    const b = '88888888-8888-4888-8888-888888888888';
    await json(ctx.app, 'PUT', `/api/ingest/runs/${a}`, runMeta({ seed: 1 }), token);
    await json(ctx.app, 'PUT', `/api/ingest/runs/${b}`, runMeta({ seed: 2 }), token);
    const fin = (fs: unknown[]) => ({ finished_at: '2026-11-10T11:00:00Z', request_count: 1, findings: fs });
    await json(ctx.app, 'POST', `/api/ingest/runs/${a}/finish`, fin([]), token);
    await json(ctx.app, 'POST', `/api/ingest/runs/${b}/finish`, fin([finding()]), token);
    const res = await json(ctx.app, 'GET', `/api/compare?base=${a}&current=${b}`);
    expect(res.status).toBe(200);
    expect(res.body.regressed).toBe(true);
    expect(res.body.warnings[0]).toContain('seeds differ');
  });
});

describe('scenarios', () => {
  const config = {
    seed: 7,
    rules: [{ name: 'drop', match: { method: 'POST', path_prefix: '/v2/checkout/orders' }, fault: 'drop_after_commit', probability: 0.2 }],
    operation_id: ['purchase_units.0.invoice_id'],
  };

  it('creates, updates, lists and deletes', async () => {
    const { projectId } = await projectWithToken(ctx.app, 'scenarios');
    const c = await json(ctx.app, 'POST', `/api/projects/${projectId}/scenarios`, { name: 'lost', config });
    expect(c.status).toBe(201);
    expect((await json(ctx.app, 'POST', `/api/projects/${projectId}/scenarios`, { name: 'lost', config })).status).toBe(409);
    const u = await json(ctx.app, 'PUT', `/api/scenarios/${c.body.id}`, { name: 'lost-2', config: { ...config, seed: 8 } });
    expect(u.body.config.seed).toBe(8);
    const l = await json(ctx.app, 'GET', `/api/projects/${projectId}/scenarios`);
    expect(l.body.scenarios.map((s: { name: string }) => s.name)).toEqual(['lost-2']);
    expect((await json(ctx.app, 'DELETE', `/api/scenarios/${c.body.id}`)).status).toBe(204);
    expect((await json(ctx.app, 'DELETE', `/api/scenarios/${c.body.id}`)).status).toBe(404);
  });

  it('validates the same way paychaos validate does', async () => {
    const ok = await json(ctx.app, 'POST', '/api/scenarios/validate', config);
    expect(ok.body).toEqual({ valid: true, issues: [] });
    const bad = await json(ctx.app, 'POST', '/api/scenarios/validate', { ...config, rules: [{ ...config.rules[0], fault: 'explode', probability: 2 }] });
    expect(bad.body.valid).toBe(false);
    expect(bad.body.issues.map((i: { path: string }) => i.path)).toEqual(['rules.0.fault', 'rules.0.probability']);
    const typo = await json(ctx.app, 'POST', '/api/scenarios/validate', { ...config, sede: 1 });
    expect(typo.body.valid).toBe(false);
  });
});
