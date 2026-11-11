import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { hashToken, newToken } from '../auth.js';
import { HttpError, notFound } from '../errors.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { verdictFor } from '../verdict.js';
import {
  issuePatchSchema,
  listQuerySchema,
  projectBodySchema,
  projectPatchSchema,
  scenarioBodySchema,
  SEVERITIES,
  tokenBodySchema,
  uuid,
} from '../schemas.js';

const RUN_COLUMNS = `id, project_id, name, seed::text AS seed, upstream, engine_version, status, started_at, finished_at,
  request_count, high, medium, low, faults_applied, money_at_risk, scenario_name, scenario_version,
  ci_provider, repo, branch, commit_sha, pr_number, base_branch, ci_url, started_at::text AS cursor_ts`;

const PROJECT_COLUMNS = 'id, name, description, default_branch, created_at';

function stripCursor<T extends { cursor_ts?: string }>(row: T): Omit<T, 'cursor_ts'> {
  const { cursor_ts: _ignored, ...rest } = row;
  return rest;
}

async function getProject(pool: pg.Pool, id: string) {
  const { rows } = await pool.query(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1`, [uuid.parse(id)]);
  if (!rows[0]) throw notFound('project');
  return rows[0];
}

async function getRun(pool: pg.Pool, id: string) {
  const { rows } = await pool.query(
    `SELECT ${RUN_COLUMNS}, scenario, webhooks, webhook_notes FROM runs WHERE id = $1`,
    [uuid.parse(id)],
  );
  if (!rows[0]) throw notFound('run');
  return stripCursor(rows[0]);
}

interface FindingRow {
  code: string;
  severity: (typeof SEVERITIES)[number];
  path: string;
}

/**
 * The same comparison as `paychaos compare`: findings are grouped by code,
 * severity and path and counted, because request numbers and object ids
 * differ between runs.
 */
export function compareFindings(base: FindingRow[], cur: FindingRow[]) {
  const key = (f: FindingRow) => `${f.severity}\u0000${f.code}\u0000${f.path}`;
  const count = (fs: FindingRow[]) => {
    const m = new Map<string, number>();
    for (const f of fs) m.set(key(f), (m.get(key(f)) ?? 0) + 1);
    return m;
  };
  const b = count(base);
  const c = count(cur);
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  const rows = [...new Set([...b.keys(), ...c.keys()])].map((k) => {
    const [severity, code, path] = k.split('\u0000') as [FindingRow['severity'], string, string];
    const baseline = b.get(k) ?? 0;
    const current = c.get(k) ?? 0;
    return { severity, code, path, baseline, current, delta: current - baseline };
  });
  rows.sort((x, y) => rank[x.severity] - rank[y.severity] || y.delta - x.delta || x.code.localeCompare(y.code));
  const worse = rows.filter((r) => r.delta > 0);
  return {
    rows,
    regressed: worse.length > 0,
    worst_new: worse.reduce<FindingRow['severity'] | null>(
      (w, r) => (w === null || rank[r.severity] < rank[w] ? r.severity : w),
      null,
    ),
  };
}

export async function dashboardRoutes(app: FastifyInstance, pool: pg.Pool): Promise<void> {
  // ---- projects -------------------------------------------------------
  app.get('/api/projects', async () => {
    const { rows } = await pool.query(
      // The latest finished run's counts give each project a health status
      // on the overview without a request per project.
      `SELECT p.id, p.name, p.description, p.default_branch, p.created_at,
              (SELECT count(*)::int FROM runs r WHERE r.project_id = p.id) AS run_count,
              (SELECT max(started_at) FROM runs r WHERE r.project_id = p.id) AS last_run_at,
              CASE WHEN l.id IS NULL THEN NULL
                   ELSE jsonb_build_object('id', l.id, 'name', l.name, 'started_at', l.started_at,
                                           'high', l.high, 'medium', l.medium, 'low', l.low,
                                           'money_at_risk', l.money_at_risk) END AS latest,
              (SELECT count(*)::int FROM issues i WHERE i.project_id = p.id AND i.status <> 'fixed' AND i.ignored_at IS NULL) AS open_issues
       FROM projects p
       LEFT JOIN LATERAL (
         SELECT id, name, started_at, high, medium, low, money_at_risk FROM runs r
         WHERE r.project_id = p.id AND r.status = 'finished'
         ORDER BY started_at DESC, id DESC LIMIT 1
       ) l ON true
       ORDER BY p.created_at DESC`,
    );
    return { projects: rows };
  });

  app.post('/api/projects', async (req, reply) => {
    const body = projectBodySchema.parse(req.body);
    try {
      const { rows } = await pool.query(
        `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING ${PROJECT_COLUMNS}`,
        [body.name, body.description],
      );
      reply.code(201);
      return rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'a project with that name exists');
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req) => getProject(pool, req.params.id));

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    const id = uuid.parse(req.params.id);
    const body = projectPatchSchema.parse(req.body ?? {});
    try {
      const { rows } = await pool.query(
        `UPDATE projects SET name = coalesce($2, name), description = coalesce($3, description),
                default_branch = coalesce($4, default_branch)
         WHERE id = $1 RETURNING ${PROJECT_COLUMNS}`,
        [id, body.name ?? null, body.description ?? null, body.default_branch ?? null],
      );
      if (!rows[0]) throw notFound('project');
      return rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'a project with that name exists');
      throw err;
    }
  });

  /**
   * Project health: the latest finished runs in chronological order (for the
   * trend chart), the finding codes that recur across them, and a verdict on
   * the latest run against the one before it, using the same rule as
   * `paychaos compare`.
   */
  app.get<{ Params: { id: string } }>('/api/projects/:id/health', async (req) => {
    const project = await getProject(pool, req.params.id);
    const { limit } = z.object({ limit: z.coerce.number().int().min(2).max(100).optional().default(30) }).parse(req.query);
    const { rows: recent } = await pool.query(
      `SELECT id, name, seed::text AS seed, started_at, finished_at, request_count, high, medium, low, money_at_risk,
              branch, pr_number
       FROM runs WHERE project_id = $1 AND status = 'finished'
       ORDER BY started_at DESC, id DESC LIMIT $2`,
      [project.id, limit],
    );
    const runs = recent.reverse();
    const ids = runs.map((r) => r.id as string);
    const { rows: codes } = ids.length
      ? await pool.query(
          `SELECT code, severity, count(*)::int AS occurrences, count(DISTINCT run_id)::int AS runs
           FROM findings WHERE run_id = ANY($1::uuid[])
           GROUP BY code, severity
           ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, occurrences DESC, code
           LIMIT 20`,
          [ids],
        )
      : { rows: [] };
    const latest = runs[runs.length - 1] ?? null;
    const previous = runs[runs.length - 2] ?? null;
    let change = null;
    if (latest && previous) {
      const load = async (id: string) =>
        (await pool.query<FindingRow>('SELECT code, severity, path FROM findings WHERE run_id = $1', [id])).rows;
      const [pf, lf] = await Promise.all([load(previous.id), load(latest.id)]);
      const cmp = compareFindings(pf, lf);
      change = {
        base: previous.id,
        current: latest.id,
        regressed: cmp.regressed,
        worst_new: cmp.worst_new,
        new_findings: cmp.rows.reduce((n, r) => n + Math.max(r.delta, 0), 0),
        fixed_findings: cmp.rows.reduce((n, r) => n + Math.max(-r.delta, 0), 0),
        comparable: previous.seed === latest.seed,
      };
    }
    const status = !latest ? 'no_runs' : latest.high > 0 ? 'failing' : latest.medium > 0 ? 'warning' : 'passing';
    const { rows: issueCounts } = await pool.query(
      `SELECT status, count(*)::int AS n FROM issues WHERE project_id = $1 AND ignored_at IS NULL GROUP BY status`,
      [project.id],
    );
    const issues = Object.fromEntries(['new', 'open', 'regressed', 'fixed'].map((s) => [s, issueCounts.find((r) => r.status === s)?.n ?? 0]));
    return { project, status, runs, codes, latest, change, issues };
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const { rowCount } = await pool.query('DELETE FROM projects WHERE id = $1', [uuid.parse(req.params.id)]);
    if (!rowCount) throw notFound('project');
    reply.code(204);
  });

  // ---- ingest tokens --------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/projects/:id/tokens', async (req) => {
    await getProject(pool, req.params.id);
    const { rows } = await pool.query(
      `SELECT id, label, prefix, created_at, last_used_at, revoked_at FROM ingest_tokens WHERE project_id = $1 ORDER BY created_at DESC`,
      [req.params.id],
    );
    return { tokens: rows };
  });

  // The plaintext token is returned here, once, and never again.
  app.post<{ Params: { id: string } }>('/api/projects/:id/tokens', async (req, reply) => {
    await getProject(pool, req.params.id);
    const body = tokenBodySchema.parse(req.body ?? {});
    const token = newToken();
    const { rows } = await pool.query(
      `INSERT INTO ingest_tokens (project_id, label, prefix, token_hash) VALUES ($1, $2, $3, $4)
       RETURNING id, label, prefix, created_at`,
      [req.params.id, body.label, token.slice(0, 10), hashToken(token)],
    );
    reply.code(201);
    return { ...rows[0], token };
  });

  app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req, reply) => {
    const { rowCount } = await pool.query(
      'UPDATE ingest_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [uuid.parse(req.params.id)],
    );
    if (!rowCount) throw notFound('token');
    reply.code(204);
  });

  // ---- runs -----------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/projects/:id/runs', async (req) => {
    await getProject(pool, req.params.id);
    const q = listQuerySchema.parse(req.query);
    const cur = decodeCursor(q.cursor);
    const params: unknown[] = [req.params.id, q.limit + 1];
    let where = 'project_id = $1';
    if (cur) {
      params.push(cur.ts, cur.id);
      where += ' AND (started_at, id) < ($3::timestamptz, $4::uuid)';
    }
    const { rows } = await pool.query(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE ${where} ORDER BY started_at DESC, id DESC LIMIT $2`,
      params,
    );
    const more = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      runs: page.map(stripCursor),
      next_cursor: more && last ? encodeCursor({ ts: last.cursor_ts, id: last.id }) : null,
    };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req) => getRun(pool, req.params.id));

  app.delete<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const { rowCount } = await pool.query('DELETE FROM runs WHERE id = $1', [uuid.parse(req.params.id)]);
    if (!rowCount) throw notFound('run');
    reply.code(204);
  });

  app.get<{ Params: { id: string }; Querystring: { severity?: string } }>('/api/runs/:id/findings', async (req) => {
    const run = await getRun(pool, req.params.id);
    const sev = z.enum(SEVERITIES).optional().parse(req.query.severity?.toUpperCase());
    const { rows } = await pool.query(
      `SELECT f.id, f.code, f.severity, f.message, f.path, f.operation, f.fingerprint, f.requests, f.object_ids, f.at, f.final,
              f.amount_minor, f.currency, f.issue_id, i.status AS issue_status, i.ignored_at AS issue_ignored_at
       FROM findings f LEFT JOIN issues i ON i.id = f.issue_id
       WHERE f.run_id = $1 AND ($2::text IS NULL OR f.severity = $2)
       ORDER BY CASE f.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, f.amount_minor DESC NULLS LAST, f.at, f.id`,
      [run.id, sev ?? null],
    );
    return { findings: rows, final: run.status === 'finished' };
  });

  // Keyset on seq: ?after=<seq>&limit=n
  app.get<{ Params: { id: string } }>('/api/runs/:id/requests', async (req) => {
    const run = await getRun(pool, req.params.id);
    const q = z
      .object({ after: z.coerce.number().int().min(0).optional().default(0), limit: z.coerce.number().int().min(1).max(500).optional().default(100) })
      .parse(req.query);
    const { rows } = await pool.query(
      `SELECT seq, at, done, method, path, operation, request_id, fingerprint, rule, fault, upstream_status, issue,
              object_id, committed, response_delivered, amount_minor, currency
       FROM requests WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [run.id, q.after, q.limit + 1],
    );
    const more = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    return { requests: page, next_after: more ? page[page.length - 1].seq : null };
  });

  /**
   * Per-operation retry timeline: requests grouped by fingerprint (one
   * business operation), in order, with the findings that cite them. Only
   * groups with a retry or a finding are returned, worst first.
   */
  app.get<{ Params: { id: string } }>('/api/runs/:id/operations', async (req) => {
    const run = await getRun(pool, req.params.id);
    const { rows } = await pool.query(
      `WITH groups AS (
         SELECT fingerprint, min(seq) AS first_seq, count(*)::int AS attempts,
                jsonb_agg(jsonb_build_object(
                  'seq', seq, 'at', at, 'done', done, 'method', method, 'path', path, 'request_id', request_id,
                  'fault', fault, 'upstream_status', upstream_status, 'issue', issue, 'object_id', object_id,
                  'committed', committed, 'response_delivered', response_delivered,
                  'amount_minor', amount_minor, 'currency', currency) ORDER BY seq) AS timeline,
                (array_agg(operation ORDER BY seq))[1] AS operation,
                (array_agg(path ORDER BY seq))[1] AS path,
                count(DISTINCT nullif(object_id, '')) FILTER (WHERE committed)::int AS created
         FROM requests WHERE run_id = $1 GROUP BY fingerprint
       ), cited AS (
         SELECT g.fingerprint,
                coalesce(jsonb_agg(DISTINCT jsonb_build_object('code', f.code, 'severity', f.severity))
                         FILTER (WHERE f.id IS NOT NULL), '[]') AS findings,
                min(CASE f.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 END) AS worst
         FROM groups g LEFT JOIN findings f ON f.run_id = $1 AND f.fingerprint = g.fingerprint
         GROUP BY g.fingerprint
       )
       SELECT g.fingerprint, g.operation, g.path, g.attempts, g.created, g.timeline, c.findings
       FROM groups g JOIN cited c USING (fingerprint)
       WHERE g.attempts > 1 OR c.worst IS NOT NULL
       ORDER BY coalesce(c.worst, 3), g.first_seq
       LIMIT 500`,
      [run.id],
    );
    return { operations: rows };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/verdict', async (req) => verdictFor(pool, uuid.parse(req.params.id)));

  // ---- issues -----------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/projects/:id/issues', async (req) => {
    const project = await getProject(pool, req.params.id);
    const q = z
      .object({
        status: z.enum(['active', 'new', 'open', 'regressed', 'fixed', 'ignored', 'all']).optional().default('active'),
      })
      .parse(req.query);
    const where: Record<typeof q.status, string> = {
      active: `status <> 'fixed' AND ignored_at IS NULL`,
      new: `status = 'new' AND ignored_at IS NULL`,
      open: `status = 'open' AND ignored_at IS NULL`,
      regressed: `status = 'regressed' AND ignored_at IS NULL`,
      fixed: `status = 'fixed'`,
      ignored: 'ignored_at IS NOT NULL',
      all: 'true',
    };
    const { rows } = await pool.query(
      `SELECT i.id, i.key, i.code, i.severity, i.operation, i.path, i.message, i.status, i.times_seen,
              i.first_seen_run, i.first_seen_at, i.last_seen_run, i.last_seen_at, i.fixed_run, i.fixed_at, i.regressed_at,
              i.amount_minor, i.currency, i.ignored_at, i.ignored_reason
       FROM issues i WHERE i.project_id = $1 AND ${where[q.status]}
       ORDER BY CASE i.status WHEN 'regressed' THEN 0 WHEN 'new' THEN 1 WHEN 'open' THEN 2 ELSE 3 END,
                CASE i.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
                i.amount_minor DESC NULLS LAST, i.last_seen_at DESC
       LIMIT 500`,
      [project.id],
    );
    return { issues: rows, default_branch: project.default_branch };
  });

  app.patch<{ Params: { id: string } }>('/api/issues/:id', async (req) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = issuePatchSchema.parse(req.body ?? {});
    const { rows } = await pool.query(
      `UPDATE issues SET ignored_at = CASE WHEN $2 THEN coalesce(ignored_at, now()) ELSE NULL END,
              ignored_reason = CASE WHEN $2 THEN $3 ELSE '' END
       WHERE id = $1 RETURNING id, status, ignored_at, ignored_reason`,
      [id, body.ignored, body.reason],
    );
    if (!rows[0]) throw notFound('issue');
    return rows[0];
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/webhooks', async (req) => {
    const run = await getRun(pool, req.params.id);
    const { rows } = await pool.query(
      `SELECT delivered_order, event_id, type, copy, received_order, status, error, at
       FROM webhook_deliveries WHERE run_id = $1 ORDER BY delivered_order LIMIT 2000`,
      [run.id],
    );
    return { deliveries: rows, summaries: run.webhooks, notes: run.webhook_notes };
  });

  app.get('/api/compare', async (req) => {
    const q = z.object({ base: uuid, current: uuid }).parse(req.query);
    const [base, current] = await Promise.all([getRun(pool, q.base), getRun(pool, q.current)]);
    const load = async (id: string) =>
      (await pool.query<FindingRow>('SELECT code, severity, path FROM findings WHERE run_id = $1', [id])).rows;
    const [bf, cf] = await Promise.all([load(base.id), load(current.id)]);
    const warnings: string[] = [];
    if (base.seed !== current.seed) {
      warnings.push(`seeds differ (${base.seed} vs ${current.seed}); different faults fire, so counts are not comparable`);
    }
    if (base.status !== 'finished' || current.status !== 'finished') {
      warnings.push('a run is still in progress; its findings are provisional');
    }
    return { base, current, warnings, ...compareFindings(bf, cf) };
  });

  // ---- scenarios ------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/projects/:id/scenarios', async (req) => {
    await getProject(pool, req.params.id);
    const { rows } = await pool.query(
      'SELECT id, name, version, config, created_at, updated_at FROM scenarios WHERE project_id = $1 ORDER BY name',
      [req.params.id],
    );
    return { scenarios: rows };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/scenarios', async (req, reply) => {
    await getProject(pool, req.params.id);
    const body = scenarioBodySchema.parse(req.body);
    try {
      const { rows } = await pool.query(
        `INSERT INTO scenarios (project_id, name, config) VALUES ($1, $2, $3)
         RETURNING id, name, version, config, created_at, updated_at`,
        [req.params.id, body.name, JSON.stringify(body.config)],
      );
      reply.code(201);
      return rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'a scenario with that name exists');
      throw err;
    }
  });

  app.put<{ Params: { id: string } }>('/api/scenarios/:id', async (req) => {
    const body = scenarioBodySchema.parse(req.body);
    const { rows } = await pool.query(
      `UPDATE scenarios SET name = $2, config = $3, updated_at = now(),
              version = version + CASE WHEN config IS DISTINCT FROM $3::jsonb THEN 1 ELSE 0 END
       WHERE id = $1
       RETURNING id, name, version, config, created_at, updated_at`,
      [uuid.parse(req.params.id), body.name, JSON.stringify(body.config)],
    );
    if (!rows[0]) throw notFound('scenario');
    return rows[0];
  });

  app.delete<{ Params: { id: string } }>('/api/scenarios/:id', async (req, reply) => {
    const { rowCount } = await pool.query('DELETE FROM scenarios WHERE id = $1', [uuid.parse(req.params.id)]);
    if (!rowCount) throw notFound('scenario');
    reply.code(204);
  });

  // Validates without saving; the editor calls it as the user types.
  app.post('/api/scenarios/validate', async (req) => {
    const r = scenarioBodySchema.shape.config.safeParse(req.body);
    return r.success ? { valid: true, issues: [] } : { valid: false, issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  });
}
