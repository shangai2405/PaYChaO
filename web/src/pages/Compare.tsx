import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Comparison, type Project } from '../api';
import { CompareTable } from '../components/CompareTable';
import { Counts, Crumbs, Empty, ErrorBox, PageHeader, Section, SeverityBadge, Skeleton } from '../components/ui';
import { when } from '../format';

export function Compare() {
  const [params] = useSearchParams();
  const base = params.get('base') ?? '';
  const current = params.get('current') ?? '';
  const q = useQuery({
    queryKey: ['compare', base, current],
    queryFn: () => api<Comparison>(`/api/compare?base=${base}&current=${current}`),
    enabled: !!base && !!current,
  });
  const d = q.data;
  const project = useQuery({
    queryKey: ['project', d?.base.project_id],
    queryFn: () => api<Project>(`/api/projects/${d!.base.project_id}`),
    enabled: !!d,
  });
  return (
    <>
      <Crumbs
        items={[
          { to: '/', label: 'Projects' },
          ...(d ? [{ to: `/projects/${d.base.project_id}?tab=runs`, label: project.data?.name ?? 'Project' }] : []),
          { label: 'Compare' },
        ]}
      />
      <PageHeader
        title="Compare runs"
        meta={
          <span>
            Same rule as <code>paychaos compare</code>: findings are counted by code, severity and path, because request numbers and resource ids
            differ between runs.
          </span>
        }
      />
      {(!base || !current) && (
        <Empty title="Pick two runs" action={<Link className="button" to="/">Go to projects</Link>}>
          Open a project's Runs tab and tick two runs to compare them.
        </Empty>
      )}
      {q.isFetching && !d && <Skeleton rows={4} />}
      <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      {d && (
        <>
          <div className="compare-heads">
            {[
              ['Baseline', d.base],
              ['Current', d.current],
            ].map(([label, r]) => {
              const run = r as Comparison['base'];
              return (
                <div key={label as string} className="card compare-card">
                  <div className="kpi-label">{label as string}</div>
                  <Link to={`/runs/${run.id}`}>{run.name || run.id.slice(0, 8)}</Link>
                  <div className="muted">
                    seed {run.seed} · {when(run.started_at)}
                  </div>
                  <Counts high={run.high} medium={run.medium} low={run.low} />
                </div>
              );
            })}
          </div>
          {d.warnings.map((w) => (
            <p key={w} className="notice">
              {w}
            </p>
          ))}
          <p className={`verdict ${d.regressed ? 'bad' : 'good'}`} role="status">
            <span aria-hidden="true">{d.regressed ? '✕ ' : '✓ '}</span>
            {d.regressed ? (
              <>
                Regressed: new findings up to <SeverityBadge s={d.worst_new!} />
              </>
            ) : (
              'No new findings.'
            )}
          </p>
          <Section title="By finding">
            <CompareTable rows={d.rows} />
          </Section>
        </>
      )}
    </>
  );
}
