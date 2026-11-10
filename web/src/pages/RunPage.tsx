import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  api,
  del,
  downloadExport,
  type Delivery,
  type ExportFormat,
  type Finding,
  type Operation,
  type Project,
  type Run,
  type Severity,
} from '../api';
import { FindingCard } from '../components/FindingCard';
import { Timeline } from '../components/Timeline';
import {
  Counts,
  Crumbs,
  Empty,
  ErrorBox,
  HealthBadge,
  healthOf,
  PageHeader,
  Section,
  Skeleton,
  StatusPill,
  useConfirm,
  useToast,
} from '../components/ui';
import { duration, when } from '../format';
import { useLive } from '../live';

type Tab = 'findings' | 'timeline' | 'webhooks' | 'scenario';
const TABS: { id: Tab; label: string }[] = [
  { id: 'findings', label: 'Findings' },
  { id: 'timeline', label: 'Retry timeline' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'scenario', label: 'Scenario' },
];

function ExportMenu({ runId }: { runId: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const go = (f: ExportFormat) => {
    setBusy(f);
    downloadExport(runId, f)
      .catch((e: Error) => toast(`Export failed: ${e.message}`, 'error'))
      .finally(() => setBusy(null));
  };
  return (
    <div className="segmented" role="group" aria-label="Export run">
      {(
        [
          ['json', 'JSON'],
          ['junit', 'JUnit'],
          ['markdown', 'Markdown'],
        ] as const
      ).map(([f, label]) => (
        <button key={f} onClick={() => go(f)} disabled={busy !== null} title={`Download as ${label}`}>
          {busy === f ? '…' : label}
        </button>
      ))}
    </div>
  );
}

export function RunPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.id === params.get('tab'))?.id ?? 'findings';
  const [sev, setSev] = useState<Severity | ''>('');
  const run = useQuery({ queryKey: ['run', id], queryFn: () => api<Run>(`/api/runs/${id}`) });
  const r = run.data;
  const project = useQuery({
    queryKey: ['project', r?.project_id],
    queryFn: () => api<Project>(`/api/projects/${r!.project_id}`),
    enabled: !!r,
  });
  const running = r?.status === 'running';
  useLive({ run: running ? id : undefined }, [['run', id], ['findings', id], ['operations', id], ['webhooks', id]]);

  const findings = useQuery({
    queryKey: ['findings', id, sev],
    queryFn: () => api<{ findings: Finding[]; final: boolean }>(`/api/runs/${id}/findings${sev ? `?severity=${sev}` : ''}`),
    enabled: tab === 'findings',
  });
  const ops = useQuery({
    queryKey: ['operations', id],
    queryFn: () => api<{ operations: Operation[] }>(`/api/runs/${id}/operations`),
    enabled: tab === 'timeline',
  });
  const hooks = useQuery({
    queryKey: ['webhooks', id],
    queryFn: () => api<{ deliveries: Delivery[]; notes: string[] }>(`/api/runs/${id}/webhooks`),
    enabled: tab === 'webhooks',
  });

  const remove = () =>
    r &&
    ask(
      {
        title: 'Delete this run?',
        body: <p>Its requests, findings and webhook deliveries are deleted permanently. Re-run the engine to get them back.</p>,
        confirm: 'Delete run',
        danger: true,
      },
      async () => {
        await del(`/api/runs/${id}`);
        qc.removeQueries({ queryKey: ['run', id] });
        await qc.invalidateQueries({ queryKey: ['runs', r.project_id] });
        await qc.invalidateQueries({ queryKey: ['health', r.project_id] });
        toast('Run deleted');
        nav(`/projects/${r.project_id}?tab=runs`);
      },
    );

  return (
    <>
      {dialog}
      <Crumbs
        items={[
          { to: '/', label: 'Projects' },
          r ? { to: `/projects/${r.project_id}`, label: project.data?.name ?? 'Project' } : { label: '…' },
          { label: r ? r.name || `Run ${r.id.slice(0, 8)}` : '…' },
        ]}
      />
      <ErrorBox error={run.error} onRetry={() => void run.refetch()} />
      {run.isPending && <Skeleton rows={4} height={24} />}
      {r && (
        <>
          <PageHeader
            title={r.name || `Run ${r.id.slice(0, 8)}`}
            meta={
              <>
                <StatusPill status={r.status} />
                {r.status === 'finished' && <HealthBadge status={healthOf(r)} />}
              </>
            }
            actions={
              <>
                <ExportMenu runId={r.id} />
                <button className="secondary danger" onClick={remove}>
                  Delete
                </button>
              </>
            }
          />
          <dl className="stats">
            <div>
              <dt>Findings</dt>
              <dd>{r.status === 'finished' ? <Counts high={r.high} medium={r.medium} low={r.low} /> : <span className="muted">provisional</span>}</dd>
            </div>
            <div>
              <dt>Audited requests</dt>
              <dd>{r.request_count || '—'}</dd>
            </div>
            <div>
              <dt>Seed</dt>
              <dd>
                <code>{r.seed}</code>
              </dd>
            </div>
            <div>
              <dt>Upstream</dt>
              <dd>
                <code>{r.upstream}</code>
              </dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{when(r.started_at)}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{duration(r.started_at, r.finished_at)}</dd>
            </div>
          </dl>
          {Object.keys(r.faults_applied).length > 0 && (
            <p className="faults">
              <span className="muted">Faults injected</span>
              {Object.entries(r.faults_applied)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([f, n]) => (
                  <code key={f} className="fault">
                    {f} × {n}
                  </code>
                ))}
            </p>
          )}
        </>
      )}

      <div className="tabs" role="tablist" aria-label="Run sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'tab active' : 'tab'}
            onClick={() => setParams(t.id === 'findings' ? {} : { tab: t.id }, { replace: true })}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'findings' && (
          <Section
            title="Findings"
            actions={
              <select aria-label="Severity filter" value={sev} onChange={(e) => setSev(e.target.value as Severity | '')}>
                <option value="">All severities</option>
                <option value="HIGH">High</option>
                <option value="MEDIUM">Medium</option>
                <option value="LOW">Low</option>
              </select>
            }
          >
            <ErrorBox error={findings.error} onRetry={() => void findings.refetch()} />
            {findings.isPending && <Skeleton rows={4} height={40} />}
            {findings.data && !findings.data.final && (
              <p className="notice">
                The run is still going. Findings that depend on what the client does next (a lost response never retried) appear when it finishes.
              </p>
            )}
            {findings.data?.findings.length === 0 && (
              <Empty title={sev ? `No ${sev.toLowerCase()} findings` : 'No findings'}>
                {sev ? 'Try another severity.' : 'Every retry in this run was safe. Nice.'}
              </Empty>
            )}
            <ul className="findings">
              {findings.data?.findings.map((f) => <FindingCard key={f.id} f={f} />)}
            </ul>
          </Section>
        )}

        {tab === 'timeline' && (
          <Section
            title="Retry timeline by operation"
            description={
              <>
                Each row is one business operation (grouped by fingerprint or <code>operation_id</code>), attempts left to right. Two
                different resource ids in one row is a duplicate. Only retried operations or ones with findings are shown, worst first.
              </>
            }
          >
            <ErrorBox error={ops.error} onRetry={() => void ops.refetch()} />
            {ops.isPending && <Skeleton rows={3} height={60} />}
            {ops.data?.operations.length === 0 && <Empty>No operation was retried.</Empty>}
            {ops.data?.operations.map((op) => <Timeline key={op.fingerprint} op={op} />)}
          </Section>
        )}

        {tab === 'webhooks' && (
          <Section title="Webhook deliveries" description="Rows with a coloured edge arrived out of order.">
            <ErrorBox error={hooks.error} onRetry={() => void hooks.refetch()} />
            {hooks.isPending && <Skeleton rows={3} height={28} />}
            {hooks.data?.notes && hooks.data.notes.length > 0 && (
              <ul className="notes">
                {hooks.data.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            {hooks.data?.deliveries.length === 0 && (
              <Empty>
                No webhooks went through the relay in this run. Start the engine with <code>-webhook-listen</code> to test them.
              </Empty>
            )}
            {hooks.data && hooks.data.deliveries.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="num">Delivered</th>
                      <th className="num">Received</th>
                      <th>Event</th>
                      <th>Type</th>
                      <th>Copy</th>
                      <th className="num">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hooks.data.deliveries.map((d) => (
                      <tr key={d.delivered_order} className={d.received_order !== d.delivered_order ? 'reordered' : ''}>
                        <td className="num">{d.delivered_order}</td>
                        <td className="num">{d.received_order}</td>
                        <td>
                          <code>{d.event_id}</code>
                        </td>
                        <td>{d.type}</td>
                        <td>{d.copy === 0 ? 'original' : `duplicate ${d.copy}`}</td>
                        <td className="num">{d.error ? <span title={d.error}>error</span> : d.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        )}

        {tab === 'scenario' && r && (
          <Section title="Scenario used" description="The exact configuration the engine ran with. Save it to reproduce this run.">
            <pre className="json">{JSON.stringify(r.scenario, null, 2)}</pre>
          </Section>
        )}
      </div>
      {!r && !run.isPending && !run.error && (
        <p>
          <Link to="/">Back to projects</Link>
        </p>
      )}
    </>
  );
}
