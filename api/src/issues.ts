import type pg from 'pg';
import type { FindingIn } from './schemas.js';

/**
 * Issues are the cross-run identity of a finding: the same code on the same
 * PayPal operation (or, for requests outside the audited operations, the
 * same path with ids removed) is one issue however many runs report it.
 */
export function normalizePath(path: string): string {
  return path
    .split('/')
    .map((seg) => (seg.length >= 8 && /\d/.test(seg) ? ':id' : seg))
    .join('/');
}

export function issueKey(f: { code: string; operation?: string; path?: string }): string {
  return `${f.code}|${f.operation || normalizePath(f.path ?? '')}`;
}

const LOST_RESPONSE = ['drop_after_commit', 'error_500_after_commit', 'truncate_after_commit', 'hold_response'];

/**
 * Faults under which each code can appear. A run that did not exercise an
 * issue's operation under one of these says nothing about whether the issue
 * is fixed, so the issue stays open. 'any' means the code needs no fault
 * (it is about what the client sends). Unknown codes are never auto-fixed.
 */
export const TRIGGERS: Record<string, string[] | 'any'> = {
  UNSAFE_RETRY_AFTER_LOST_RESPONSE: LOST_RESPONSE,
  UNSAFE_RETRY_FAILED_THIS_TIME: LOST_RESPONSE,
  COMMITTED_BUT_REPORTED_AS_FAILED: LOST_RESPONSE,
  ALREADY_CAPTURED_NOT_RECONCILED: LOST_RESPONSE,
  TRUNCATED_SUCCESS_NOT_RETRIED: ['truncate_after_commit'],
  NEW_REQUEST_ID_AFTER_INDETERMINATE_ERROR: ['timeout_before_forward', 'error_500'],
  RETRY_WITHOUT_BACKOFF: ['error_500', 'rate_limit_429'],
  TOKEN_NOT_REFRESHED: ['token_expired_401'],
  MISSING_REQUEST_ID: 'any',
  REQUEST_ID_TOO_LONG: 'any',
  REQUEST_ID_REUSED_WITH_DIFFERENT_BODY: 'any',
};

export interface Exercised {
  operation: string;
  fault: string;
}

/** Whether a run's traffic could have shown the issue again. */
export function wasExercised(issue: { code: string; operation: string }, seen: Exercised[]): boolean {
  const trig = TRIGGERS[issue.code];
  if (!trig) return false;
  return seen.some(
    (s) => (issue.operation === '' || s.operation === issue.operation) && (trig === 'any' || trig.includes(s.fault)),
  );
}

export async function exercisedIn(q: pg.ClientBase | pg.Pool, runId: string): Promise<Exercised[]> {
  const { rows } = await q.query<Exercised>(
    'SELECT DISTINCT operation, fault FROM requests WHERE run_id = $1',
    [runId],
  );
  return rows;
}

interface RunCi {
  id: string;
  project_id: string;
  branch: string;
  pr_number: number | null;
  issues_applied: boolean;
  started_at: Date;
}

/**
 * Whether a run moves issue status. Pull-request runs never do: they are
 * judged against their base branch instead. Branch runs do when the branch
 * is the project's default branch, or when either is unknown (runs started
 * outside CI, or a project that has not learned its default branch yet).
 */
export function tracksIssues(run: { branch: string; pr_number: number | null }, defaultBranch: string): boolean {
  if (run.pr_number !== null) return false;
  return run.branch === '' || defaultBranch === '' || run.branch === defaultBranch;
}

/**
 * Updates the project's issues from a finished run's final findings and
 * links each finding to its issue. Idempotent: a resent finish links again
 * but counts nothing twice. Call inside the finish transaction.
 */
export async function applyIssues(c: pg.ClientBase, runId: string, findings: FindingIn[]): Promise<void> {
  const { rows } = await c.query<RunCi & { default_branch: string }>(
    `SELECT r.id, r.project_id, r.branch, r.pr_number, r.issues_applied, r.started_at, p.default_branch
     FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = $1 FOR UPDATE OF r`,
    [runId],
  );
  const run = rows[0];
  if (!run) return;

  if (!run.issues_applied && tracksIssues(run, run.default_branch)) {
    // One representative per key: the most severe, then the most money.
    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
    const byKey = new Map<string, FindingIn>();
    for (const f of findings) {
      const k = issueKey(f);
      const cur = byKey.get(k);
      if (!cur || rank[f.severity] < rank[cur.severity] || (f.amount_minor ?? 0) > (cur.amount_minor ?? 0)) byKey.set(k, f);
    }
    const reps = [...byKey.entries()].map(([key, f]) => ({
      key,
      code: f.code,
      severity: f.severity,
      operation: f.operation,
      path: f.operation ? '' : normalizePath(f.path),
      message: f.message,
      amount_minor: f.amount_minor ?? null,
      currency: f.currency ?? null,
    }));
    if (reps.length > 0) {
      await c.query(
        `INSERT INTO issues (project_id, key, code, severity, operation, path, message, status,
                             first_seen_run, first_seen_at, last_seen_run, last_seen_at, amount_minor, currency)
         SELECT $1::uuid, r.key, r.code, r.severity, r.operation, r.path, r.message, 'new',
                $2::uuid, $3::timestamptz, $2::uuid, $3::timestamptz, r.amount_minor, r.currency
         FROM jsonb_to_recordset($4::jsonb) AS r(key text, code text, severity text, operation text, path text,
                                                 message text, amount_minor bigint, currency text)
         ON CONFLICT (project_id, key) DO UPDATE SET
           status = CASE WHEN issues.status = 'fixed' THEN 'regressed' ELSE 'open' END,
           regressed_at = CASE WHEN issues.status = 'fixed' THEN EXCLUDED.last_seen_at ELSE issues.regressed_at END,
           fixed_run = CASE WHEN issues.status = 'fixed' THEN NULL ELSE issues.fixed_run END,
           fixed_at = CASE WHEN issues.status = 'fixed' THEN NULL ELSE issues.fixed_at END,
           times_seen = issues.times_seen + 1,
           severity = EXCLUDED.severity, message = EXCLUDED.message,
           amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency,
           last_seen_run = EXCLUDED.last_seen_run, last_seen_at = EXCLUDED.last_seen_at`,
        [run.project_id, run.id, run.started_at, JSON.stringify(reps)],
      );
    }
    // Open issues this run did not report are fixed only if the run tried
    // the same operation under a fault that could have shown them.
    const { rows: open } = await c.query<{ id: string; key: string; code: string; operation: string }>(
      `SELECT id, key, code, operation FROM issues
       WHERE project_id = $1 AND status IN ('new', 'open', 'regressed') AND NOT (key = ANY($2::text[]))`,
      [run.project_id, [...byKey.keys()]],
    );
    if (open.length > 0) {
      const seen = await exercisedIn(c, run.id);
      const fixed = open.filter((i) => wasExercised(i, seen)).map((i) => i.id);
      if (fixed.length > 0) {
        await c.query(
          `UPDATE issues SET status = 'fixed', fixed_run = $2, fixed_at = $3 WHERE id = ANY($1::bigint[])`,
          [fixed, run.id, run.started_at],
        );
      }
    }
    await c.query('UPDATE runs SET issues_applied = true WHERE id = $1', [run.id]);
  }

  await c.query(
    `UPDATE findings f SET issue_id = i.id FROM issues i
     WHERE f.run_id = $1 AND i.project_id = $2 AND i.key = f.issue_key`,
    [run.id, run.project_id],
  );
}
