import type pg from 'pg';
import { HttpError, notFound } from './errors.js';
import { exercisedIn, issueKey, wasExercised } from './issues.js';
import { moneyText, totals, type MoneyTotal } from './money.js';

type Severity = 'HIGH' | 'MEDIUM' | 'LOW';
const RANK: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

interface FRow {
  code: string;
  severity: Severity;
  operation: string;
  path: string;
  message: string;
  amount_minor: string | null;
  currency: string | null;
}

export interface VerdictItem {
  key: string;
  code: string;
  severity: Severity;
  operation: string;
  path: string;
  message: string;
  count: number;
  money_at_risk: MoneyTotal[];
  ignored?: boolean;
}

export interface Verdict {
  run: {
    id: string;
    name: string;
    project_id: string;
    branch: string;
    commit_sha: string;
    pr_number: number | null;
    base_branch: string;
    seed: string;
  };
  baseline: { id: string; name: string; branch: string; commit_sha: string; started_at: string; seed: string } | null;
  base_branch: string;
  new: VerdictItem[];
  fixed: VerdictItem[];
  unchanged: VerdictItem[];
  not_retested: VerdictItem[];
  ignored: VerdictItem[];
  money_at_risk: MoneyTotal[];
  new_money_at_risk: MoneyTotal[];
  worst_new: Severity | null;
  counts: { high: number; medium: number; low: number };
  comparable: boolean;
  markdown: string;
}

function group(rows: FRow[]): Map<string, { item: VerdictItem; rows: FRow[] }> {
  const out = new Map<string, { item: VerdictItem; rows: FRow[] }>();
  for (const r of rows) {
    const key = issueKey(r);
    const g = out.get(key);
    if (g) {
      g.rows.push(r);
      if (RANK[r.severity] < RANK[g.item.severity]) g.item.severity = r.severity;
      continue;
    }
    out.set(key, {
      item: { key, code: r.code, severity: r.severity, operation: r.operation, path: r.path, message: r.message, count: 0, money_at_risk: [] },
      rows: [r],
    });
  }
  for (const g of out.values()) {
    g.item.count = g.rows.length;
    g.item.money_at_risk = totals(g.rows);
  }
  return out;
}

const bySeverity = (a: VerdictItem, b: VerdictItem) =>
  RANK[a.severity] - RANK[b.severity] ||
  (b.money_at_risk[0]?.amount_minor ?? 0) - (a.money_at_risk[0]?.amount_minor ?? 0) ||
  a.code.localeCompare(b.code);

/**
 * The pull-request verdict: this run's problems compared with the latest
 * finished run of its base branch (for a pull request) or the previous run
 * of its own branch. "Fixed" requires that this run exercised the operation
 * under a fault that could show the problem; otherwise it is "not retested".
 */
export async function verdictFor(pool: pg.Pool, runId: string, projectId?: string): Promise<Verdict> {
  const { rows: runs } = await pool.query(
    `SELECT r.id, r.name, r.project_id, r.status, r.branch, r.commit_sha, r.pr_number, r.base_branch, r.seed::text AS seed,
            r.started_at, p.default_branch
     FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = $1`,
    [runId],
  );
  const run = runs[0];
  if (!run || (projectId && run.project_id !== projectId)) throw notFound('run');
  if (run.status !== 'finished') throw new HttpError(409, 'run is still in progress; the verdict needs its final findings');

  const baseBranch: string = run.pr_number !== null ? run.base_branch || run.default_branch : run.branch;
  const { rows: bases } = await pool.query(
    `SELECT id, name, branch, commit_sha, started_at, seed::text AS seed FROM runs
     WHERE project_id = $1 AND status = 'finished' AND pr_number IS NULL AND id <> $2
       AND ($3 = '' OR branch = $3)
       AND ($4::boolean OR started_at < $5)
     ORDER BY started_at DESC, id DESC LIMIT 1`,
    [run.project_id, run.id, baseBranch, run.pr_number !== null, run.started_at],
  );
  const base = bases[0] ?? null;

  const load = async (id: string) =>
    (
      await pool.query<FRow>(
        'SELECT code, severity, operation, path, message, amount_minor, currency FROM findings WHERE run_id = $1',
        [id],
      )
    ).rows;
  const curRows = await load(run.id);
  const cur = group(curRows);
  const prev = base ? group(await load(base.id)) : new Map<string, { item: VerdictItem; rows: FRow[] }>();
  const { rows: ignoredRows } = await pool.query<{ key: string }>(
    'SELECT key FROM issues WHERE project_id = $1 AND ignored_at IS NOT NULL',
    [run.project_id],
  );
  const ignoredKeys = new Set(ignoredRows.map((r) => r.key));
  const seen = await exercisedIn(pool, run.id);

  const v: Omit<Verdict, 'markdown'> = {
    run: {
      id: run.id, name: run.name, project_id: run.project_id, branch: run.branch, commit_sha: run.commit_sha,
      pr_number: run.pr_number, base_branch: run.base_branch, seed: run.seed,
    },
    baseline: base
      ? { id: base.id, name: base.name, branch: base.branch, commit_sha: base.commit_sha, started_at: new Date(base.started_at).toISOString(), seed: base.seed }
      : null,
    base_branch: baseBranch,
    new: [], fixed: [], unchanged: [], not_retested: [], ignored: [],
    money_at_risk: totals(curRows),
    new_money_at_risk: [],
    worst_new: null,
    counts: {
      high: curRows.filter((r) => r.severity === 'HIGH').length,
      medium: curRows.filter((r) => r.severity === 'MEDIUM').length,
      low: curRows.filter((r) => r.severity === 'LOW').length,
    },
    comparable: base ? base.seed === run.seed : false,
  };
  for (const [key, g] of cur) {
    if (ignoredKeys.has(key)) v.ignored.push({ ...g.item, ignored: true });
    else if (prev.has(key)) v.unchanged.push(g.item);
    else v.new.push(g.item);
  }
  for (const [key, g] of prev) {
    if (cur.has(key)) continue;
    (wasExercised(g.item, seen) ? v.fixed : v.not_retested).push(g.item);
  }
  for (const list of [v.new, v.fixed, v.unchanged, v.not_retested, v.ignored]) list.sort(bySeverity);
  const newKeys = new Set(v.new.map((i) => i.key));
  v.new_money_at_risk = totals([...cur].filter(([k]) => newKeys.has(k)).flatMap(([, g]) => g.rows));
  v.worst_new = v.new.reduce<Severity | null>((w, i) => (w === null || RANK[i.severity] < RANK[w] ? i.severity : w), null);
  return { ...v, markdown: verdictMarkdown(v) };
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function table(items: VerdictItem[]): string {
  const lines = ['| Severity | Problem | Where | At risk | Count |', '|---|---|---|---|---|'];
  for (const i of items.slice(0, 20)) {
    lines.push(`| ${i.severity} | \`${i.code}\` | \`${cell(i.operation || i.path)}\` | ${moneyText(i.money_at_risk) || '—'} | ${i.count} |`);
  }
  if (items.length > 20) lines.push(`| | …and ${items.length - 20} more | | | |`);
  return lines.join('\n');
}

/** A pull-request comment body. The caller adds links (it knows the dashboard URL). */
export function verdictMarkdown(v: Omit<Verdict, 'markdown'>): string {
  const out: string[] = [];
  const newHigh = v.new.filter((i) => i.severity === 'HIGH').length;
  const head =
    v.new.length === 0
      ? '✅ **No new payment-safety problems.**'
      : `${newHigh > 0 ? '❌' : '⚠️'} **${v.new.length} new problem${v.new.length === 1 ? '' : 's'}** (${newHigh} high)` +
        (v.new_money_at_risk.length ? `, **${moneyText(v.new_money_at_risk)} at risk**` : '') +
        '.';
  out.push('### paychaos verdict', '', head, '');
  const against = v.baseline
    ? `Compared with the latest run on \`${v.base_branch || v.baseline.branch || 'the base branch'}\`` +
      (v.baseline.commit_sha ? ` (${v.baseline.commit_sha.slice(0, 7)})` : '') +
      '.'
    : `No earlier run${v.base_branch ? ` on \`${v.base_branch}\`` : ''} to compare with, so every problem counts as new.`;
  out.push(
    `${against} Fixed: ${v.fixed.length} · still open: ${v.unchanged.length}` +
      (v.not_retested.length ? ` · not retested: ${v.not_retested.length}` : '') +
      (v.ignored.length ? ` · ignored: ${v.ignored.length}` : '') +
      (v.money_at_risk.length ? ` · total at risk in this run: ${moneyText(v.money_at_risk)}` : ''),
    '',
  );
  if (v.baseline && !v.comparable) {
    out.push('> The two runs used different seeds, so different faults fired. Prefer a fixed seed in CI.', '');
  }
  if (v.new.length) out.push('#### New', '', table(v.new), '');
  if (v.fixed.length) out.push('#### Fixed', '', table(v.fixed), '');
  if (v.not_retested.length) {
    out.push(
      '#### Not retested',
      '',
      'These were open before, but this run never sent the same operation under a fault that could show them, so it cannot say whether they are fixed.',
      '',
      table(v.not_retested),
      '',
    );
  }
  return out.join('\n');
}
