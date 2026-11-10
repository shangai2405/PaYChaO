import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { EventHub } from '../src/events.js';

// Each test file gets its own throwaway database on the server named by
// TEST_DATABASE_URL (default: a local Postgres as user postgres).
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';

export interface Ctx {
  app: FastifyInstance;
  pool: pg.Pool;
  hub: EventHub;
  url: string;
  close: () => Promise<void>;
}

export async function setup(opts: { adminToken?: string } = {}): Promise<Ctx> {
  const name = `paychaos_test_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  const url = u.toString();
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  await migrate(pool);
  const hub = new EventHub(url);
  await hub.start();
  const app = await buildApp({ pool, hub, adminToken: opts.adminToken });
  return {
    app,
    pool,
    hub,
    url,
    close: async () => {
      await app.close();
      await hub.stop();
      await pool.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export async function json<T = any>(app: FastifyInstance, method: string, url: string, body?: unknown, token?: string) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: body === undefined ? undefined : (body as object),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : null) as T };
}

/** Creates a project and an ingest token for it. */
export async function projectWithToken(app: FastifyInstance, name = 'shop') {
  const p = await json(app, 'POST', '/api/projects', { name });
  const t = await json(app, 'POST', `/api/projects/${p.body.id}/tokens`, { label: 'ci' });
  return { projectId: p.body.id as string, token: t.body.token as string, tokenId: t.body.id as string };
}

export const RUN_A = '6f1c1e0a-3b7e-4b8f-9a42-1c2d3e4f5a6b';

export function runMeta(over: Record<string, unknown> = {}) {
  return { name: 'demo', seed: 7, upstream: 'mock', scenario: { seed: 7, rules: [] }, started_at: '2026-11-10T10:00:00Z', engine_version: 'test', ...over };
}

export function record(seq: number, over: Record<string, unknown> = {}) {
  return {
    kind: 'request',
    request: {
      seq, at: `2026-11-10T10:00:${String(seq).padStart(2, '0')}.123456789Z`, done: '0001-01-01T00:00:00Z',
      method: 'POST', path: '/v2/checkout/orders', operation: 'create_order', request_id: '', fingerprint: 'fp1',
      fault: 'none', upstream_status: 201, object_id: `ORDER${seq}`, committed: true, response_delivered: false, ...over,
    },
  };
}

export function finding(over: Record<string, unknown> = {}) {
  return {
    code: 'UNSAFE_RETRY_AFTER_LOST_RESPONSE', severity: 'HIGH', message: 'dup', path: '/v2/checkout/orders',
    operation: 'create_order', fingerprint: 'fp1', requests: [1, 2], object_ids: ['ORDER1', 'ORDER2'],
    at: '2026-11-10T10:00:05Z', ...over,
  };
}
