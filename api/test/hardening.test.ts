import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toJUnit, toMarkdown } from '../src/routes/export.js';
import { AuthFailureLimiter, checkStartupSecurity, SECURITY_HEADERS } from '../src/security.js';
import { finding, json, projectWithToken, record, runMeta, setup, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx?.close();
});

const RUN_1 = '11111111-1111-4111-8111-111111111111';
const RUN_2 = '22222222-2222-4222-8222-222222222222';

async function finishedRun(token: string, id: string, startedAt: string, findings: unknown[], seed = 7) {
  await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, runMeta({ name: `run ${id.slice(0, 1)}`, started_at: startedAt, seed }), token);
  await json(ctx.app, 'POST', `/api/ingest/runs/${id}/batches`, { seq: 1, events: [record(1), record(2)] }, token);
  const fin = await json(
    ctx.app,
    'POST',
    `/api/ingest/runs/${id}/finish`,
    { finished_at: startedAt.replace('00Z', '30Z'), findings, request_count: 2, faults_applied: { drop_after_commit: 1 }, webhook_notes: ['event E1 delivered twice'] },
    token,
  );
  expect(fin.status).toBe(200);
}

describe('security headers', () => {
  it('are sent on API responses and errors', async () => {
    for (const url of ['/api/health', '/api/projects/not-a-uuid']) {
      const res = await ctx.app.inject({ url });
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers[k]).toBe(v);
    }
  });

  it('500s carry a request id and no internals', async () => {
    const app = ctx.app;
    const orig = ctx.pool.query.bind(ctx.pool);
    (ctx.pool as any).query = async () => {
      throw new Error('connection to secret-db-host refused');
    };
    try {
      const res = await app.inject({ url: '/api/projects' });
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('internal error');
      expect(body.request_id).toBeTruthy();
      expect(res.body).not.toContain('secret-db-host');
    } finally {
      (ctx.pool as any).query = orig;
    }
  });
});

describe('auth failure limiter', () => {
  it('blocks an address after repeated failures, then forgets it', () => {
    let t = 0;
    const l = new AuthFailureLimiter(3, 1000, () => t);
    for (let i = 0; i < 3; i++) {
      l.check('a');
      l.fail('a');
    }
    expect(() => l.check('a')).toThrow(/too many/);
    expect(() => l.check('b')).not.toThrow();
    t = 1001;
    expect(() => l.check('a')).not.toThrow();
  });

  it('never tracks more than its cap', () => {
    const l = new AuthFailureLimiter(3, 60_000, () => 0, 100);
    for (let i = 0; i < 1000; i++) l.fail(`ip${i}`);
    expect(l.size).toBeLessThanOrEqual(100);
  });

  it('answers 429 to ingest after too many bad tokens, even for a good one', async () => {
    const c = await setup();
    try {
      const { token } = await projectWithToken(c.app, 'limited');
      for (let i = 0; i < 20; i++) {
        expect((await json(c.app, 'PUT', `/api/ingest/runs/${RUN_1}`, runMeta(), `pct_wrong${i}`)).status).toBe(401);
      }
      expect((await json(c.app, 'PUT', `/api/ingest/runs/${RUN_1}`, runMeta(), token)).status).toBe(429);
    } finally {
      await c.close();
    }
  });

  it('limits admin token guessing too', async () => {
    const c = await setup({ adminToken: 'a-long-enough-admin-token' });
    try {
      for (let i = 0; i < 20; i++) expect((await json(c.app, 'GET', '/api/projects', undefined, 'nope')).status).toBe(401);
      expect((await json(c.app, 'GET', '/api/projects', undefined, 'a-long-enough-admin-token')).status).toBe(429);
    } finally {
      await c.close();
    }
  });
});

describe('startup security', () => {
  it('refuses an open dashboard on a public address', () => {
    expect(checkStartupSecurity({ host: '127.0.0.1' })).toEqual([]);
    expect(checkStartupSecurity({ host: '0.0.0.0' })[0]).toMatch(/refusing/);
    expect(checkStartupSecurity({ host: '0.0.0.0', allowOpen: true })).toEqual([]);
    expect(checkStartupSecurity({ host: '0.0.0.0', adminToken: 'x'.repeat(24) })).toEqual([]);
    expect(checkStartupSecurity({ host: '127.0.0.1', adminToken: 'short' })[0]).toMatch(/16 characters/);
  });
});

describe('tokens record their last use', () => {
  it('stamps last_used_at on ingest', async () => {
    const { projectId, token } = await projectWithToken(ctx.app, 'last-used');
    let list = await json(ctx.app, 'GET', `/api/projects/${projectId}/tokens`);
    expect(list.body.tokens[0].last_used_at).toBeNull();
    await json(ctx.app, 'PUT', `/api/ingest/runs/${RUN_1}`, runMeta(), token);
    list = await json(ctx.app, 'GET', `/api/projects/${projectId}/tokens`);
    expect(list.body.tokens[0].last_used_at).not.toBeNull();
    await json(ctx.app, 'DELETE', `/api/runs/${RUN_1}`);
  });
});

describe('projects: edit and health', () => {
  it('renames and describes a project, rejecting empty and duplicate edits', async () => {
    const p = await json(ctx.app, 'POST', '/api/projects', { name: 'editable', description: 'first' });
    expect(p.body.description).toBe('first');
    const e = await json(ctx.app, 'PATCH', `/api/projects/${p.body.id}`, { name: 'edited', description: 'checkout v2' });
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ name: 'edited', description: 'checkout v2' });
    expect((await json(ctx.app, 'PATCH', `/api/projects/${p.body.id}`, {})).status).toBe(400);
    expect((await json(ctx.app, 'PATCH', `/api/projects/${p.body.id}`, { owner: 'x' })).status).toBe(400);
    await json(ctx.app, 'POST', '/api/projects', { name: 'taken' });
    expect((await json(ctx.app, 'PATCH', `/api/projects/${p.body.id}`, { name: 'taken' })).status).toBe(409);
    expect((await json(ctx.app, 'PATCH', `/api/projects/${RUN_2}`, { name: 'ghost' })).status).toBe(404);
  });

  it('reports no runs, then a trend, recurring codes and a regression', async () => {
    const { projectId, token } = await projectWithToken(ctx.app, 'health');
    let h = await json(ctx.app, 'GET', `/api/projects/${projectId}/health`);
    expect(h.body).toMatchObject({ status: 'no_runs', runs: [], codes: [], latest: null, change: null });

    await finishedRun(token, RUN_1, '2026-11-10T10:00:00Z', [finding({ severity: 'MEDIUM', code: 'MISSING_REQUEST_ID' })]);
    h = await json(ctx.app, 'GET', `/api/projects/${projectId}/health`);
    expect(h.body.status).toBe('warning');
    expect(h.body.change).toBeNull();

    await finishedRun(token, RUN_2, '2026-11-10T11:00:00Z', [finding(), finding({ severity: 'MEDIUM', code: 'MISSING_REQUEST_ID' })]);
    h = await json(ctx.app, 'GET', `/api/projects/${projectId}/health`);
    expect(h.body.status).toBe('failing');
    expect(h.body.runs.map((r: { id: string }) => r.id)).toEqual([RUN_1, RUN_2]); // chronological
    expect(h.body.codes[0]).toMatchObject({ code: 'UNSAFE_RETRY_AFTER_LOST_RESPONSE', severity: 'HIGH', runs: 1 });
    expect(h.body.codes[1]).toMatchObject({ code: 'MISSING_REQUEST_ID', runs: 2, occurrences: 2 });
    expect(h.body.change).toMatchObject({ regressed: true, worst_new: 'HIGH', new_findings: 1, fixed_findings: 0, comparable: true });

    const list = await json(ctx.app, 'GET', '/api/projects');
    const mine = list.body.projects.find((p: { id: string }) => p.id === projectId);
    expect(mine.latest).toMatchObject({ id: RUN_2, high: 1, medium: 1 });
    await json(ctx.app, 'DELETE', `/api/projects/${projectId}`);
  });
});

describe('run export', () => {
  it('downloads JSON, JUnit and Markdown', async () => {
    const { projectId, token } = await projectWithToken(ctx.app, 'export');
    await finishedRun(token, RUN_1, '2026-11-10T10:00:00Z', [finding({ message: 'dup <&> "quoted" | piped' })]);

    const j = await ctx.app.inject({ url: `/api/runs/${RUN_1}/export` });
    expect(j.statusCode).toBe(200);
    expect(j.headers['content-disposition']).toBe('attachment; filename="paychaos-run-1.json"');
    const doc = JSON.parse(j.body);
    expect(doc.run.seed).toBe('7');
    expect(doc.requests).toHaveLength(2);
    expect(doc.findings[0].code).toBe('UNSAFE_RETRY_AFTER_LOST_RESPONSE');

    const x = await ctx.app.inject({ url: `/api/runs/${RUN_1}/export?format=junit` });
    expect(x.headers['content-type']).toContain('application/xml');
    expect(x.body).toContain('failures="1"');
    expect(x.body).toContain('dup &lt;&amp;&gt; &quot;quoted&quot;');
    expect(x.body).not.toContain('<&>');

    const m = await ctx.app.inject({ url: `/api/runs/${RUN_1}/export?format=markdown` });
    expect(m.body).toContain('**1 high**');
    expect(m.body).toContain('piped'.padStart(0));
    expect(m.body).toContain('\\| piped');
    expect(m.body).toContain('`drop_after_commit` × 1');

    expect((await ctx.app.inject({ url: `/api/runs/${RUN_1}/export?format=pdf` })).statusCode).toBe(400);
    expect((await ctx.app.inject({ url: `/api/runs/${RUN_2}/export` })).statusCode).toBe(404);
    await json(ctx.app, 'DELETE', `/api/projects/${projectId}`);
  });

  it('formats an empty run as passing', () => {
    const run = { id: RUN_1, name: '', seed: '1', upstream: 'mock', status: 'running', started_at: '2026-11-10T10:00:00Z', finished_at: null, request_count: 0, faults_applied: {}, webhook_notes: [] };
    expect(toJUnit(run, [])).toContain('name="no findings"');
    const md = toMarkdown(run, []);
    expect(md).toContain('No retry-safety problems');
    expect(md).toContain('provisional');
  });
});

describe('static dashboard', () => {
  it('falls back to index.html for pages but 404s missing assets', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { buildApp } = await import('../src/app.js');
    const dir = mkdtempSync(join(tmpdir(), 'pcweb-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dir, 'assets', 'app-abc.js'), 'console.log(1)');
    const app = await buildApp({ pool: ctx.pool, hub: ctx.hub, staticDir: dir });
    try {
      const page = await app.inject({ url: '/projects/123' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.headers['cache-control']).toBe('no-cache');
      const asset = await app.inject({ url: '/assets/app-abc.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toContain('immutable');
      expect((await app.inject({ url: '/assets/app-old.js' })).statusCode).toBe(404);
      expect((await app.inject({ url: '/favicon.ico' })).statusCode).toBe(404);
      expect((await app.inject({ url: '/api/nope' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
