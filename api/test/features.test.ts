import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueKey, normalizePath, tracksIssues, wasExercised } from '../src/issues.js';
import { formatMoney, totals } from '../src/money.js';
import { finding, json, projectWithToken, record, runMeta, setup, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx?.close();
});

let minute = 0;
/** Streams one complete run: requests, then the finish with its final findings. */
async function fullRun(
  token: string,
  opts: { findings?: Record<string, unknown>[]; requests?: Record<string, unknown>[]; ci?: Record<string, unknown>; name?: string } = {},
) {
  const id = randomUUID();
  minute += 1;
  const started = new Date(Date.UTC(2026, 10, 10, 10, minute)).toISOString();
  expect(
    (await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, runMeta({ name: opts.name ?? `run ${minute}`, started_at: started, ci: opts.ci }), token)).status,
  ).toBe(201);
  const reqs = opts.requests ?? [record(1, { fault: 'drop_after_commit' }), record(2)];
  expect((await json(ctx.app, 'POST', `/api/ingest/runs/${id}/batches`, { seq: 1, events: reqs }, token)).status).toBe(201);
  const fin = await json(
    ctx.app,
    'POST',
    `/api/ingest/runs/${id}/finish`,
    { finished_at: started, findings: opts.findings ?? [], request_count: reqs.length },
    token,
  );
  expect(fin.status).toBe(200);
  return id;
}

const dupCapture = (amount = 125000) =>
  finding({
    code: 'UNSAFE_RETRY_AFTER_LOST_RESPONSE', path: '/v2/checkout/orders/5O190127TN364715T/capture', operation: 'capture_order',
    amount_minor: amount, currency: 'USD',
  });
const missingId = () =>
  finding({ code: 'MISSING_REQUEST_ID', severity: 'MEDIUM', path: '/v2/payments/captures/2GG279541U471931P/refund', operation: 'refund_capture' });
const captureUnderLoss = (seq: number) =>
  record(seq, { path: '/v2/checkout/orders/X/capture', operation: 'capture_order', fault: 'drop_after_commit', fingerprint: `c${seq}` });

describe('money', () => {
  it('formats minor units per currency without floating point', () => {
    expect(formatMoney(125000, 'USD')).toBe('1,250.00 USD');
    expect(formatMoney('5', 'USD')).toBe('0.05 USD');
    expect(formatMoney(1234567, 'JPY')).toBe('1,234,567 JPY');
    expect(formatMoney('9007199254740993', 'USD')).toBe('90,071,992,547,409.93 USD');
    expect(totals([{ amount_minor: 100, currency: 'USD' }, { amount_minor: '250', currency: 'USD' }, { amount_minor: 7, currency: 'EUR' }, {}])).toEqual([
      { currency: 'USD', amount_minor: 350, findings: 2 },
      { currency: 'EUR', amount_minor: 7, findings: 1 },
    ]);
  });

  it('stores amounts on requests and findings and totals them per run', async () => {
    const { projectId, token } = await projectWithToken(ctx.app, 'money');
    const id = await fullRun(token, {
      requests: [record(1, { amount_minor: 5000, currency: 'USD' }), record(2, { amount_minor: 5000, currency: 'USD' })],
      findings: [dupCapture(5000), finding({ code: 'COMMITTED_BUT_REPORTED_AS_FAILED', severity: 'MEDIUM', amount_minor: 700, currency: 'EUR' }), missingId()],
    });
    const run = await json(ctx.app, 'GET', `/api/runs/${id}`);
    expect(run.body.money_at_risk).toEqual([
      { currency: 'USD', amount_minor: 5000, findings: 1 },
      { currency: 'EUR', amount_minor: 700, findings: 1 },
    ]);
    const fs = await json(ctx.app, 'GET', `/api/runs/${id}/findings`);
    expect(fs.body.findings[0]).toMatchObject({ code: 'UNSAFE_RETRY_AFTER_LOST_RESPONSE', amount_minor: '5000', currency: 'USD' });
    expect(fs.body.findings.find((f: { code: string }) => f.code === 'MISSING_REQUEST_ID').amount_minor).toBeNull();
    const reqs = await json(ctx.app, 'GET', `/api/runs/${id}/requests`);
    expect(reqs.body.requests[0]).toMatchObject({ amount_minor: '5000', currency: 'USD' });
    const projects = await json(ctx.app, 'GET', '/api/projects');
    const p = projects.body.projects.find((x: { id: string }) => x.id === projectId);
    expect(p.latest.money_at_risk[0]).toEqual({ currency: 'USD', amount_minor: 5000, findings: 1 });

    const md = await ctx.app.inject({ method: 'GET', url: `/api/runs/${id}/export?format=markdown` });
    expect(md.body).toContain('**Money at risk: 50.00 USD + 7.00 EUR**');
    expect(md.body).toContain('| HIGH | `UNSAFE_RETRY_AFTER_LOST_RESPONSE` | 50.00 USD |');
    const junit = await ctx.app.inject({ method: 'GET', url: `/api/runs/${id}/export?format=junit` });
    expect(junit.body).toContain('at risk: 50.00 USD');
  });

  it('rejects malformed currencies and amounts without a currency are not stored', async () => {
    const { token } = await projectWithToken(ctx.app, 'money-bad');
    const id = randomUUID();
    await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, runMeta(), token);
    const bad = await json(ctx.app, 'POST', `/api/ingest/runs/${id}/batches`, { seq: 1, events: [record(1, { currency: 'usd', amount_minor: 1 })] }, token);
    expect(bad.status).toBe(400);
    const half = await json(ctx.app, 'POST', `/api/ingest/runs/${id}/batches`, { seq: 2, events: [record(1, { amount_minor: 1 })] }, token);
    expect(half.status).toBe(201);
    const { rows } = await ctx.pool.query('SELECT amount_minor, currency FROM requests WHERE run_id = $1', [id]);
    expect(rows[0]).toEqual({ amount_minor: null, currency: null });
  });
});

describe('issues', () => {
  it('derives a stable key from code and operation, or path without ids', () => {
    expect(normalizePath('/v2/checkout/orders/5O190127TN364715T/capture')).toBe('/v2/checkout/orders/:id/capture');
    expect(issueKey({ code: 'X', operation: 'capture_order', path: '/v2/checkout/orders/A1B2C3D4E5/capture' })).toBe('X|capture_order');
    expect(issueKey({ code: 'X', operation: '', path: '/v2/checkout/orders/A1B2C3D4E5' })).toBe('X|/v2/checkout/orders/:id');
    expect(wasExercised({ code: 'UNSAFE_RETRY_AFTER_LOST_RESPONSE', operation: 'capture_order' }, [{ operation: 'capture_order', fault: 'none' }])).toBe(false);
    expect(wasExercised({ code: 'UNSAFE_RETRY_AFTER_LOST_RESPONSE', operation: 'capture_order' }, [{ operation: 'capture_order', fault: 'hold_response' }])).toBe(true);
    expect(wasExercised({ code: 'MISSING_REQUEST_ID', operation: 'refund_capture' }, [{ operation: 'refund_capture', fault: 'none' }])).toBe(true);
    expect(wasExercised({ code: 'SOMETHING_NEW', operation: '' }, [{ operation: 'x', fault: 'none' }])).toBe(false);
    expect(tracksIssues({ branch: 'main', pr_number: 4 }, 'main')).toBe(false);
    expect(tracksIssues({ branch: 'feature', pr_number: null }, 'main')).toBe(false);
    expect(tracksIssues({ branch: '', pr_number: null }, 'main')).toBe(true);
    expect(tracksIssues({ branch: 'develop', pr_number: null }, '')).toBe(true);
  });

  it('tracks new, open, fixed and regressed across runs', async () => {
    const { projectId, token } = await projectWithToken(ctx.app, 'issues');
    const issues = async (status = 'all') =>
      (await json(ctx.app, 'GET', `/api/projects/${projectId}/issues?status=${status}`)).body.issues as {
        id: string; key: string; status: string; times_seen: number; amount_minor: string; fixed_run: string | null;
      }[];

    // Run 1: two problems appear. Two findings with one key make one issue.
    const r1 = await fullRun(token, { findings: [dupCapture(), dupCapture(), missingId()] });
    let all = await issues();
    expect(all.map((i) => [i.key, i.status])).toEqual([
      ['UNSAFE_RETRY_AFTER_LOST_RESPONSE|capture_order', 'new'],
      ['MISSING_REQUEST_ID|refund_capture', 'new'],
    ]);
    const f1 = await json(ctx.app, 'GET', `/api/runs/${r1}/findings`);
    expect(f1.body.findings.every((f: { issue_id: string | null }) => f.issue_id !== null)).toBe(true);
    expect(f1.body.findings[0].issue_status).toBe('new');

    // Resending a finish (it is idempotent) must not count a sighting twice.
    await json(ctx.app, 'POST', `/api/ingest/runs/${r1}/finish`, { finished_at: '2026-11-10T10:01:00Z', findings: [dupCapture(), missingId()], request_count: 2 }, token);
    expect((await issues()).every((i) => i.times_seen === 1)).toBe(true);

    // Run 2: both seen again -> open. The refund retry problem is gone,
    // but this run never sent a refund, so it is not called fixed.
    await fullRun(token, { findings: [dupCapture(99900)] });
    all = await issues();
    const cap = all.find((i) => i.key.startsWith('UNSAFE'))!;
    expect(cap).toMatchObject({ status: 'open', times_seen: 2, amount_minor: '99900' });
    expect(all.find((i) => i.key.startsWith('MISSING'))!.status).toBe('new');

    // Run 3: captures were exercised under a lost response and nothing was
    // found, so the capture problem is fixed; refunds sent without faults
    // are enough to retest MISSING_REQUEST_ID, which is fixed too.
    const r3 = await fullRun(token, {
      findings: [],
      requests: [captureUnderLoss(1), record(2, { operation: 'refund_capture', path: '/v2/payments/captures/A/refund', fingerprint: 'r' })],
    });
    all = await issues();
    expect(all.every((i) => i.status === 'fixed')).toBe(true);
    expect(all[0]!.fixed_run).toBe(r3);
    expect(await issues('active')).toEqual([]);

    // Run 4: the capture problem is back.
    await fullRun(token, { findings: [dupCapture()] });
    const back = (await issues('regressed'))[0]!;
    expect(back.key).toBe('UNSAFE_RETRY_AFTER_LOST_RESPONSE|capture_order');
    const health = await json(ctx.app, 'GET', `/api/projects/${projectId}/health`);
    expect(health.body.issues).toEqual({ new: 0, open: 0, regressed: 1, fixed: 1 });

    // Ignoring hides it from active issues and the project count.
    expect((await json(ctx.app, 'PATCH', `/api/issues/${back.id}`, { ignored: true, reason: 'sandbox-only path' })).status).toBe(200);
    expect(await issues('active')).toEqual([]);
    expect((await issues('ignored'))[0]).toMatchObject({ id: back.id, ignored_reason: 'sandbox-only path' });
    expect((await json(ctx.app, 'PATCH', `/api/issues/${back.id}`, { ignored: false })).status).toBe(200);
    expect((await json(ctx.app, 'PATCH', '/api/issues/999999', { ignored: true })).status).toBe(404);
    expect((await json(ctx.app, 'PATCH', `/api/issues/${back.id}`, { ignored: 'yes' })).status).toBe(400);
  });

  it('pull-request runs do not change issue status, and the default branch is learned from CI', async () => {
    const { projectId, token } = await projectWithToken(ctx.app, 'issues-pr');
    await fullRun(token, { findings: [dupCapture()], ci: { provider: 'github', branch: 'main', default_branch: 'main' } });
    const proj = await json(ctx.app, 'GET', `/api/projects/${projectId}`);
    expect(proj.body.default_branch).toBe('main');
    // A PR that fixes it (and exercised captures) does not mark it fixed...
    await fullRun(token, { requests: [captureUnderLoss(1)], ci: { provider: 'github', branch: 'fix', pr_number: 7, base_branch: 'main' } });
    // ...nor does a run on another branch.
    await fullRun(token, { requests: [captureUnderLoss(1)], ci: { provider: 'github', branch: 'experiment' } });
    const list = await json(ctx.app, 'GET', `/api/projects/${projectId}/issues`);
    expect(list.body.issues.map((i: { status: string }) => i.status)).toEqual(['new']);
    // The default branch can be changed by an admin.
    const patched = await json(ctx.app, 'PATCH', `/api/projects/${projectId}`, { default_branch: 'trunk' });
    expect(patched.body.default_branch).toBe('trunk');
  });
});

describe('pull-request verdict', () => {
  it('compares a PR run with the latest run of its base branch', async () => {
    const { projectId, token } = await projectWithToken(ctx.app, 'verdict');
    const main = { provider: 'github', repo: 'acme/shop', branch: 'main', commit: 'aaaaaaa1111', default_branch: 'main' };
    await fullRun(token, { findings: [missingId()], ci: main }); // older main run, ignored
    const base = await fullRun(token, {
      findings: [missingId(), finding({ code: 'TOKEN_NOT_REFRESHED', severity: 'MEDIUM', operation: '', path: '/v2/checkout/orders/ABCDEFGH12' })],
      ci: { ...main, commit: 'bbbbbbb2222' },
    });
    const pr = await fullRun(token, {
      findings: [dupCapture(125000), dupCapture(5000)],
      requests: [captureUnderLoss(1), record(2, { operation: 'refund_capture', path: '/v2/payments/captures/A/refund', fingerprint: 'r' })],
      ci: { provider: 'github', repo: 'acme/shop', branch: 'feature', commit: 'ccccccc', pr_number: 12, base_branch: 'main' },
    });
    const v = await json(ctx.app, 'GET', `/api/ingest/runs/${pr}/verdict`, undefined, token);
    expect(v.status).toBe(200);
    expect(v.body.baseline.id).toBe(base);
    expect(v.body.base_branch).toBe('main');
    expect(v.body.new.map((i: { key: string; count: number }) => [i.key, i.count])).toEqual([['UNSAFE_RETRY_AFTER_LOST_RESPONSE|capture_order', 2]]);
    expect(v.body.new_money_at_risk).toEqual([{ currency: 'USD', amount_minor: 130000, findings: 2 }]);
    expect(v.body.worst_new).toBe('HIGH');
    // The refund was sent, so the missing request id is fixed; no token
    // fault was injected, so TOKEN_NOT_REFRESHED is only "not retested".
    expect(v.body.fixed.map((i: { code: string }) => i.code)).toEqual(['MISSING_REQUEST_ID']);
    expect(v.body.not_retested.map((i: { code: string }) => i.code)).toEqual(['TOKEN_NOT_REFRESHED']);
    expect(v.body.markdown).toContain('**1 new problem** (1 high), **1,300.00 USD at risk**');
    expect(v.body.markdown).toContain('latest run on `main` (bbbbbbb)');
    expect(v.body.markdown).toContain('#### Not retested');

    // The same verdict on the admin route; another project's token cannot read it.
    expect((await json(ctx.app, 'GET', `/api/runs/${pr}/verdict`)).body.new.length).toBe(1);
    const other = await projectWithToken(ctx.app, 'verdict-other');
    expect((await json(ctx.app, 'GET', `/api/ingest/runs/${pr}/verdict`, undefined, other.token)).status).toBe(404);
    expect((await json(ctx.app, 'GET', `/api/ingest/runs/${pr}/verdict`)).status).toBe(401);

    // Ignored issues are listed separately, not as new.
    await fullRun(token, { findings: [dupCapture()], ci: { ...main, commit: 'ddd' } });
    const issue = (await json(ctx.app, 'GET', `/api/projects/${projectId}/issues`)).body.issues.find((i: { code: string }) => i.code === 'UNSAFE_RETRY_AFTER_LOST_RESPONSE');
    await json(ctx.app, 'PATCH', `/api/issues/${issue.id}`, { ignored: true });
    const pr2 = await fullRun(token, { findings: [dupCapture()], ci: { provider: 'github', branch: 'f2', pr_number: 13, base_branch: 'main' } });
    const v2 = await json(ctx.app, 'GET', `/api/runs/${pr2}/verdict`);
    expect(v2.body.new).toEqual([]);
    expect(v2.body.ignored.map((i: { code: string }) => i.code)).toEqual(['UNSAFE_RETRY_AFTER_LOST_RESPONSE']);
    expect(v2.body.markdown).toContain('No new payment-safety problems');
  });

  it('treats everything as new without a baseline, and refuses unfinished runs', async () => {
    const { token } = await projectWithToken(ctx.app, 'verdict-first');
    const r = await fullRun(token, { findings: [dupCapture()], ci: { provider: 'github', branch: 'x', pr_number: 1, base_branch: 'main' } });
    const v = await json(ctx.app, 'GET', `/api/runs/${r}/verdict`);
    expect(v.body.baseline).toBeNull();
    expect(v.body.new.length).toBe(1);
    expect(v.body.markdown).toContain('No earlier run on `main`');
    const running = randomUUID();
    await json(ctx.app, 'PUT', `/api/ingest/runs/${running}`, runMeta(), token);
    expect((await json(ctx.app, 'GET', `/api/runs/${running}/verdict`)).status).toBe(409);
  });

  it('records CI details on the run', async () => {
    const { token } = await projectWithToken(ctx.app, 'ci-meta');
    const r = await fullRun(token, {
      ci: { provider: 'github', repo: 'acme/shop', branch: 'feature', commit: 'abc123', pr_number: 9, base_branch: 'main', url: 'https://ci.example/run/1' },
    });
    const run = await json(ctx.app, 'GET', `/api/runs/${r}`);
    expect(run.body).toMatchObject({ ci_provider: 'github', repo: 'acme/shop', branch: 'feature', commit_sha: 'abc123', pr_number: 9, base_branch: 'main', ci_url: 'https://ci.example/run/1' });
  });

  it('accepts only http(s) CI links, since the dashboard renders them', async () => {
    const { token } = await projectWithToken(ctx.app, 'ci-url');
    const res = await json(ctx.app, 'PUT', `/api/ingest/runs/${randomUUID()}`, runMeta({ ci: { provider: 'github', url: 'javascript:alert(1)' } }), token);
    expect(res.status).toBe(400);
  });
});

describe('scenarios by name', () => {
  const config = { seed: 3, rules: [{ name: 'lose', fault: 'drop_after_commit', probability: 0.5 }] };

  it('serves a saved scenario to its own project token and versions every change', async () => {
    const { projectId, token } = await projectWithToken(ctx.app, 'scen-name');
    const created = await json(ctx.app, 'POST', `/api/projects/${projectId}/scenarios`, { name: 'checkout-strict', config });
    expect(created.body.version).toBe(1);
    const got = await json(ctx.app, 'GET', '/api/ingest/scenarios/checkout-strict', undefined, token);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ name: 'checkout-strict', version: 1, config });
    // Saving without a change keeps the version; a real change bumps it.
    expect((await json(ctx.app, 'PUT', `/api/scenarios/${created.body.id}`, { name: 'checkout-strict', config })).body.version).toBe(1);
    const changed = await json(ctx.app, 'PUT', `/api/scenarios/${created.body.id}`, { name: 'checkout-strict', config: { ...config, seed: 4 } });
    expect(changed.body.version).toBe(2);
    expect((await json(ctx.app, 'GET', '/api/ingest/scenarios/checkout-strict', undefined, token)).body.version).toBe(2);

    const other = await projectWithToken(ctx.app, 'scen-name-other');
    expect((await json(ctx.app, 'GET', '/api/ingest/scenarios/checkout-strict', undefined, other.token)).status).toBe(404);
    expect((await json(ctx.app, 'GET', '/api/ingest/scenarios/checkout-strict')).status).toBe(401);

    const id = randomUUID();
    await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, runMeta({ scenario_name: 'checkout-strict', scenario_version: 2 }), token);
    expect((await json(ctx.app, 'GET', `/api/runs/${id}`)).body).toMatchObject({ scenario_name: 'checkout-strict', scenario_version: 2 });
  });
});
