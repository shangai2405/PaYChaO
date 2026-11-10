import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { notFound } from '../errors.js';
import { uuid } from '../schemas.js';

interface ExportFinding {
  code: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
  path: string;
  operation: string;
  requests: number[];
  object_ids: string[];
  at: string;
}

interface ExportRun {
  id: string;
  name: string;
  seed: string;
  upstream: string;
  status: string;
  started_at: string | Date;
  finished_at: string | Date | null;
  request_count: number;
  faults_applied: Record<string, number>;
  webhook_notes: string[];
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // XML 1.0 forbids most control characters even when escaped.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const hashList = (xs: number[]) => xs.map((x) => `#${x}`).join(', ');
const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** JUnit XML in the same shape as the engine's -junit flag (internal/report/formats.go). */
export function toJUnit(run: ExportRun, findings: ExportFinding[]): string {
  const cases = findings.map((f, i) => {
    let body = f.message;
    if (f.object_ids.length) body += `\nobjects: ${f.object_ids.join(', ')}`;
    if (f.requests.length) body += `\nrequests: ${hashList(f.requests)}`;
    const name = `${String(i + 1).padStart(3, '0')} ${f.code} ${f.path}`;
    return (
      `    <testcase name="${xmlEscape(name)}" classname="paychaos.${f.severity.toLowerCase()}">\n` +
      `      <failure message="${xmlEscape(f.code)}" type="${f.severity}">${xmlEscape(body)}</failure>\n` +
      `    </testcase>`
    );
  });
  if (cases.length === 0) cases.push('    <testcase name="no findings" classname="paychaos"></testcase>');
  const out =
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n` +
    `  <testsuite name="${xmlEscape(`paychaos (seed ${run.seed})${run.name ? ` ${run.name}` : ''}`)}" tests="${cases.length}" ` +
    `failures="${findings.length}" timestamp="${new Date(run.finished_at ?? run.started_at).toISOString().slice(0, 19)}">\n` +
    cases.join('\n') +
    (run.webhook_notes.length ? `\n    <system-out>${xmlEscape('webhook notes:\n- ' + run.webhook_notes.join('\n- '))}</system-out>` : '') +
    `\n  </testsuite>\n</testsuites>\n`;
  return out;
}

/** Markdown summary in the same shape as the engine's -markdown flag. */
export function toMarkdown(run: ExportRun, findings: ExportFinding[]): string {
  const n = (s: string) => findings.filter((f) => f.severity === s).length;
  const lines = [
    `## paychaos report${run.name ? `: ${mdCell(run.name)}` : ''} (seed ${run.seed})`,
    '',
    `**${run.request_count}** audited payment requests · **${n('HIGH')} high**, ${n('MEDIUM')} medium, ${n('LOW')} low findings`,
    '',
  ];
  const faults = Object.entries(run.faults_applied)
    .map(([f, c]) => `\`${f}\` × ${c}`)
    .sort();
  if (faults.length) lines.push(`Faults injected: ${faults.join(', ')}`, '');
  if (run.status !== 'finished') lines.push('> The run had not finished when this was exported; findings are provisional.', '');
  if (findings.length === 0) {
    lines.push('No retry-safety problems detected in this run.');
  } else {
    lines.push('| Severity | Code | Path | Requests | Objects | Detail |', '|---|---|---|---|---|---|');
    for (const f of findings) {
      lines.push(
        `| ${f.severity} | \`${f.code}\` | \`${mdCell(f.path)}\` | ${hashList(f.requests)} | ${mdCell(f.object_ids.join(', '))} | ${mdCell(f.message)} |`,
      );
    }
  }
  if (run.webhook_notes.length) {
    lines.push('', '### Webhooks', '');
    for (const note of run.webhook_notes) lines.push(`- ${note}`);
  }
  return lines.join('\n') + '\n';
}

/** A filename-safe slug of the run name, falling back to its id. */
function fileStem(run: ExportRun): string {
  const slug = run.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `paychaos-${slug || run.id.slice(0, 8)}`;
}

export async function exportRoutes(app: FastifyInstance, pool: pg.Pool): Promise<void> {
  /**
   * GET /api/runs/:id/export?format=json|junit|markdown
   * Downloads a stored run in the same formats the engine writes, so a run
   * streamed from CI can be re-exported later from the dashboard.
   */
  app.get<{ Params: { id: string } }>('/api/runs/:id/export', async (req, reply) => {
    const id = uuid.parse(req.params.id);
    const { format } = z.object({ format: z.enum(['json', 'junit', 'markdown']).default('json') }).parse(req.query);
    const { rows } = await pool.query<ExportRun & { scenario: unknown; webhooks: unknown }>(
      `SELECT id, name, seed::text AS seed, upstream, status, started_at, finished_at, request_count,
              faults_applied, webhook_notes, scenario, webhooks
       FROM runs WHERE id = $1`,
      [id],
    );
    const run = rows[0];
    if (!run) throw notFound('run');
    const { rows: findings } = await pool.query<ExportFinding>(
      `SELECT code, severity, message, path, operation, requests, object_ids, at
       FROM findings WHERE run_id = $1
       ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, at, id`,
      [id],
    );
    const stem = fileStem(run);
    if (format === 'junit') {
      reply.header('content-type', 'application/xml; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${stem}-junit.xml"`);
      return toJUnit(run, findings);
    }
    if (format === 'markdown') {
      reply.header('content-type', 'text/markdown; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${stem}.md"`);
      return toMarkdown(run, findings);
    }
    const [{ rows: requests }, { rows: deliveries }] = await Promise.all([
      pool.query(
        `SELECT seq, at, done, method, path, operation, request_id, fingerprint, rule, fault, upstream_status, issue,
                object_id, committed, response_delivered
         FROM requests WHERE run_id = $1 ORDER BY seq`,
        [id],
      ),
      pool.query(
        `SELECT delivered_order, event_id, type, copy, received_order, status, error, at
         FROM webhook_deliveries WHERE run_id = $1 ORDER BY delivered_order`,
        [id],
      ),
    ]);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${stem}.json"`);
    return JSON.stringify({ run, findings, requests, webhook_deliveries: deliveries }, null, 2);
  });
}
