import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { projectForToken as resolveToken } from '../auth.js';
import { limited, type AuthFailureLimiter } from '../security.js';
import type { FastifyRequest } from 'fastify';
import { tx } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { notify } from '../events.js';
import {
  batchSchema,
  finishSchema,
  runMetaSchema,
  uuid,
  type DeliveryIn,
  type FindingIn,
  type RecordIn,
} from '../schemas.js';

/** Ensures the run exists and belongs to the token's project. */
async function ownRun(q: pg.ClientBase, runId: string, projectId: string, lock = false): Promise<void> {
  const { rows } = await q.query<{ project_id: string }>(
    `SELECT project_id FROM runs WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [runId],
  );
  const row = rows[0];
  if (!row || row.project_id !== projectId) throw notFound('run');
}

// Each insert below is one statement for the whole batch: the rows travel as
// parallel arrays and unnest() turns them back into rows, so a batch of 500
// events costs one round trip per table, not 500.

async function insertRequests(q: pg.ClientBase, runId: string, recs: RecordIn[]): Promise<void> {
  if (recs.length === 0) return;
  // A record can appear twice in one batch (completed, then marked
  // delivered); ON CONFLICT DO UPDATE may touch a row only once per
  // statement, so keep the latest version of each.
  const latest = new Map<number, RecordIn>();
  for (const r of recs) latest.set(r.seq, r);
  const rs = [...latest.values()];
  await q.query(
    `INSERT INTO requests (run_id, seq, at, done, method, path, operation, request_id, fingerprint, rule,
                           fault, upstream_status, issue, object_id, committed, response_delivered)
     SELECT $1::uuid, * FROM unnest($2::int[], $3::timestamptz[], $4::timestamptz[], $5::text[], $6::text[], $7::text[],
                              $8::text[], $9::text[], $10::text[], $11::text[], $12::int[], $13::text[], $14::text[],
                              $15::bool[], $16::bool[])
     ON CONFLICT (run_id, seq) DO UPDATE SET
       done = EXCLUDED.done, rule = EXCLUDED.rule, fault = EXCLUDED.fault,
       upstream_status = EXCLUDED.upstream_status, issue = EXCLUDED.issue, object_id = EXCLUDED.object_id,
       committed = EXCLUDED.committed,
       response_delivered = requests.response_delivered OR EXCLUDED.response_delivered`,
    [
      runId,
      rs.map((r) => r.seq),
      rs.map((r) => r.at),
      rs.map((r) => r.done ?? null),
      rs.map((r) => r.method),
      rs.map((r) => r.path),
      rs.map((r) => r.operation),
      rs.map((r) => r.request_id),
      rs.map((r) => r.fingerprint),
      rs.map((r) => r.rule),
      rs.map((r) => r.fault || 'none'),
      rs.map((r) => r.upstream_status),
      rs.map((r) => r.issue),
      rs.map((r) => r.object_id),
      rs.map((r) => r.committed),
      rs.map((r) => r.response_delivered),
    ],
  );
}

/** Postgres array literal for text[][]/int[][] is awkward; send JSON and expand. */
async function insertFindings(q: pg.ClientBase, runId: string, fs: FindingIn[], final: boolean): Promise<void> {
  if (fs.length === 0) return;
  await q.query(
    `INSERT INTO findings (run_id, code, severity, message, path, operation, fingerprint, requests, object_ids, at, final)
     SELECT $1::uuid, f.code, f.severity, f.message, f.path, f.operation, f.fingerprint,
            ARRAY(SELECT jsonb_array_elements_text(f.requests)::int),
            ARRAY(SELECT jsonb_array_elements_text(f.object_ids)),
            f.at, $3::boolean
     FROM jsonb_to_recordset($2::jsonb) AS f(code text, severity text, message text, path text, operation text,
                                             fingerprint text, requests jsonb, object_ids jsonb, at timestamptz)`,
    [runId, JSON.stringify(fs), final],
  );
}

async function insertDeliveries(q: pg.ClientBase, runId: string, ds: DeliveryIn[]): Promise<void> {
  if (ds.length === 0) return;
  await q.query(
    `INSERT INTO webhook_deliveries (run_id, delivered_order, event_id, type, copy, received_order, status, error, at)
     SELECT $1::uuid, * FROM unnest($2::int[], $3::text[], $4::text[], $5::int[], $6::int[], $7::int[], $8::text[], $9::timestamptz[])
     ON CONFLICT DO NOTHING`,
    [
      runId,
      ds.map((d) => d.delivered_order),
      ds.map((d) => d.event_id),
      ds.map((d) => d.type),
      ds.map((d) => d.copy),
      ds.map((d) => d.received_order),
      ds.map((d) => d.status),
      ds.map((d) => d.error),
      ds.map((d) => d.at),
    ],
  );
}

export async function ingestRoutes(app: FastifyInstance, pool: pg.Pool, limiter: AuthFailureLimiter): Promise<void> {
  const projectForToken = (p: pg.Pool, req: FastifyRequest) => limited(limiter, req, () => resolveToken(p, req));

  // Idempotent: the engine generates the run id and may send this twice.
  app.put<{ Params: { id: string } }>('/api/ingest/runs/:id', async (req, reply) => {
    const projectId = await projectForToken(pool, req);
    const runId = uuid.parse(req.params.id);
    const meta = runMetaSchema.parse(req.body);
    const created = await tx(pool, async (c) => {
      const { rowCount } = await c.query(
        `INSERT INTO runs (id, project_id, name, seed, upstream, scenario, engine_version, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [runId, projectId, meta.name, meta.seed, meta.upstream, JSON.stringify(meta.scenario ?? {}), meta.engine_version, meta.started_at],
      );
      if (rowCount === 0) {
        await ownRun(c, runId, projectId); // a retry is fine; another project's id is not
        return false;
      }
      await notify(c, { type: 'run.started', run_id: runId, project_id: projectId });
      return true;
    });
    reply.code(created ? 201 : 200);
    return { run_id: runId, created };
  });

  // Retry-safe: (run_id, seq) is unique, so a batch sent twice stores once.
  app.post<{ Params: { id: string } }>('/api/ingest/runs/:id/batches', async (req, reply) => {
    const projectId = await projectForToken(pool, req);
    const runId = uuid.parse(req.params.id);
    const batch = batchSchema.parse(req.body);
    const stored = await tx(pool, async (c) => {
      await ownRun(c, runId, projectId);
      const ins = await c.query(
        `INSERT INTO ingest_batches (run_id, seq, event_count) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [runId, batch.seq, batch.events.length],
      );
      if (ins.rowCount === 0) return false;
      const recs: RecordIn[] = [];
      const finds: FindingIn[] = [];
      const dels: DeliveryIn[] = [];
      for (const ev of batch.events) {
        if (ev.kind === 'request') recs.push(ev.request);
        else if (ev.kind === 'finding') finds.push(ev.finding);
        else dels.push(ev.webhook);
      }
      await insertRequests(c, runId, recs);
      await insertFindings(c, runId, finds, false);
      await insertDeliveries(c, runId, dels);
      await notify(c, {
        type: 'run.batch', run_id: runId, project_id: projectId,
        requests: recs.length, findings: finds.length, webhooks: dels.length,
      });
      return true;
    });
    reply.code(stored ? 201 : 200);
    return { seq: batch.seq, duplicate: !stored };
  });

  // Idempotent: replaces provisional findings with the final list.
  app.post<{ Params: { id: string } }>('/api/ingest/runs/:id/finish', async (req) => {
    const projectId = await projectForToken(pool, req);
    const runId = uuid.parse(req.params.id);
    const fin = finishSchema.parse(req.body);
    const count = (s: string) => fin.findings.filter((f) => f.severity === s).length;
    await tx(pool, async (c) => {
      await ownRun(c, runId, projectId, true);
      await c.query('DELETE FROM findings WHERE run_id = $1', [runId]);
      await insertFindings(c, runId, fin.findings, true);
      const { rowCount } = await c.query(
        `UPDATE runs SET status = 'finished', finished_at = $2, request_count = $3, high = $4, medium = $5, low = $6,
                faults_applied = $7, webhooks = $8, webhook_notes = $9
         WHERE id = $1`,
        [runId, fin.finished_at, fin.request_count, count('HIGH'), count('MEDIUM'), count('LOW'),
          JSON.stringify(fin.faults_applied), JSON.stringify(fin.webhooks), JSON.stringify(fin.webhook_notes)],
      );
      if (rowCount !== 1) throw new HttpError(500, 'run vanished');
      await notify(c, { type: 'run.finished', run_id: runId, project_id: projectId, findings: fin.findings.length });
    });
    return { run_id: runId, status: 'finished' };
  });
}
