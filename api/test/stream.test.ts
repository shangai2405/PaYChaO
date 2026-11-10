import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, projectWithToken, record, runMeta, setup, type Ctx } from './helpers.js';

let ctx: Ctx;
let base: string;
beforeAll(async () => {
  ctx = await setup();
  base = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await ctx?.close();
});

async function readEvents(res: Response, n: number, timeoutMs = 5000): Promise<string[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < n && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now())),
    ]);
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const m = chunk.match(/^event: (.+)$/m);
      if (m) events.push(m[1]!);
    }
  }
  await reader.cancel();
  return events;
}

describe('live stream', () => {
  it('delivers NOTIFYs from ingest as Server-Sent Events, filtered by project', async () => {
    const mine = await projectWithToken(ctx.app, 'live');
    const other = await projectWithToken(ctx.app, 'other');
    const ac = new AbortController();
    const res = await fetch(`${base}/api/stream?project=${mine.projectId}`, { signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const got = readEvents(res, 3);
    await new Promise((r) => setTimeout(r, 100));
    await json(ctx.app, 'PUT', '/api/ingest/runs/99999999-9999-4999-8999-999999999999', runMeta(), other.token);
    const id = '12121212-1212-4121-8121-121212121212';
    await json(ctx.app, 'PUT', `/api/ingest/runs/${id}`, runMeta(), mine.token);
    await json(ctx.app, 'POST', `/api/ingest/runs/${id}/batches`, { seq: 1, events: [record(1)] }, mine.token);
    await json(ctx.app, 'POST', `/api/ingest/runs/${id}/finish`, { finished_at: '2026-11-10T10:01:00Z', request_count: 1, findings: [] }, mine.token);
    expect(await got).toEqual(['run.started', 'run.batch', 'run.finished']);
    ac.abort();
  });
});

describe('admin token', () => {
  it('protects dashboard routes but not ingest or health', async () => {
    const guarded = await setup({ adminToken: 'let-me-in' });
    try {
      expect((await json(guarded.app, 'GET', '/api/projects')).status).toBe(401);
      expect((await json(guarded.app, 'GET', '/api/projects', undefined, 'wrong')).status).toBe(401);
      const p = await json(guarded.app, 'POST', '/api/projects', { name: 'x' }, 'let-me-in');
      expect(p.status).toBe(201);
      const t = await json(guarded.app, 'POST', `/api/projects/${p.body.id}/tokens`, {}, 'let-me-in');
      expect((await json(guarded.app, 'PUT', '/api/ingest/runs/13131313-1313-4131-8131-131313131313', runMeta(), t.body.token)).status).toBe(201);
      expect((await json(guarded.app, 'GET', '/api/health')).status).toBe(200);
      const sse = await guarded.app.inject({ method: 'GET', url: '/api/stream?access_token=wrong' });
      expect(sse.statusCode).toBe(401);
    } finally {
      await guarded.close();
    }
  });
});
