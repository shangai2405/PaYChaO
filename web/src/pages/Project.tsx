import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, del, patch, post, type Health, type IssueStatus, type Project as P, type Run, type Token, type TrackedIssue } from '../api';
import { TrendChart } from '../components/TrendChart';
import {
  CopyButton,
  Counts,
  Crumbs,
  Empty,
  ErrorBox,
  HealthBadge,
  IssueChip,
  Money,
  PageHeader,
  Section,
  SeverityBadge,
  Skeleton,
  StatusPill,
  useConfirm,
  useToast,
} from '../components/ui';
import { ago, amountText, duration, when } from '../format';
import { guideFor } from '../guides';
import { useLive } from '../live';

type Tab = 'overview' | 'issues' | 'runs' | 'tokens';
const TABS: Tab[] = ['overview', 'issues', 'runs', 'tokens'];

function Overview({ projectId }: { projectId: string }) {
  const q = useQuery({ queryKey: ['health', projectId], queryFn: () => api<Health>(`/api/projects/${projectId}/health`) });
  if (q.isPending) return <Section title="Health"><Skeleton rows={5} /></Section>;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const h = q.data;
  if (h.status === 'no_runs') {
    return (
      <Section title="Get started">
        <ol className="steps">
          <li>
            Open the <Link to="?tab=tokens">Tokens</Link> tab and create an ingest token.
          </li>
          <li>
            Run the engine in front of your app: <code>PAYCHAOS_TOKEN=pct_… paychaos -report-to {window.location.origin} -run-name "baseline"</code>
          </li>
          <li>Run your checkout tests through it. Findings stream in here live.</li>
        </ol>
      </Section>
    );
  }
  const c = h.change;
  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Latest run</span>
          <HealthBadge status={h.status} />
          {h.latest && (
            <Link className="small" to={`/runs/${h.latest.id}`}>
              {h.latest.name || h.latest.id.slice(0, 8)} · {ago(h.latest.started_at)}
            </Link>
          )}
        </div>
        <div className="kpi">
          <span className="kpi-label">Findings in latest run</span>
          {h.latest && <span className="kpi-value">{h.latest.high + h.latest.medium + h.latest.low}</span>}
          {h.latest && <Counts high={h.latest.high} medium={h.latest.medium} low={h.latest.low} />}
        </div>
        <div className="kpi">
          <span className="kpi-label">Money at risk in latest run</span>
          <span className="kpi-value">
            <Money totals={h.latest?.money_at_risk} />
          </span>
          <span className="kpi-sub">Payments the findings could charge twice, refund twice or lose track of.</span>
        </div>
        {h.issues && (
          <div className="kpi">
            <span className="kpi-label">Open problems</span>
            <span className="kpi-value">{h.issues.new + h.issues.open + h.issues.regressed}</span>
            <span className="kpi-sub">
              {h.issues.new} new · {h.issues.regressed} regressed · {h.issues.fixed} fixed ·{' '}
              <Link to="?tab=issues">See all</Link>
            </span>
          </div>
        )}
        <div className="kpi">
          <span className="kpi-label">Since the run before</span>
          {c ? (
            <>
              <span className={`kpi-value ${c.regressed ? 'bad-text' : 'ok-text'}`}>
                {c.regressed ? `+${c.new_findings} new` : c.fixed_findings ? `${c.fixed_findings} fixed` : 'No change'}
              </span>
              <span className="small muted">
                {c.regressed && c.worst_new ? <>worst new: <SeverityBadge s={c.worst_new} /> </> : null}
                {!c.comparable && 'different seeds, so counts are indicative · '}
                <Link to={`/compare?base=${c.base}&current=${c.current}`}>Compare</Link>
              </span>
            </>
          ) : (
            <span className="small muted">Needs two finished runs.</span>
          )}
        </div>
      </div>
      <Section title="Findings per run" description={`The last ${h.runs.length} finished runs, oldest first. Select a column to open the run.`}>
        <TrendChart runs={h.runs} />
      </Section>
      {h.codes.length > 0 && (
        <Section title="Recurring problems" description="Finding types across these runs, worst first. Fix these and the chart goes flat.">
          <ul className="codes">
            {h.codes.map((k) => {
              const g = guideFor(k.code);
              return (
                <li key={k.code + k.severity}>
                  <SeverityBadge s={k.severity} />
                  <div>
                    <div className="code-title">{g?.title ?? k.code}</div>
                    <div className="small muted">
                      <code>{k.code}</code> · {k.occurrences}× in {k.runs} of {h.runs.length} runs
                    </div>
                  </div>
                  {g && (
                    <Link className="button secondary small" to={`/guides#${k.code}`}>
                      Fix guide
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </>
  );
}

type IssueFilter = 'active' | IssueStatus | 'ignored' | 'all';
const ISSUE_FILTERS: { id: IssueFilter; label: string }[] = [
  { id: 'active', label: 'Open' },
  { id: 'regressed', label: 'Regressed' },
  { id: 'new', label: 'New' },
  { id: 'fixed', label: 'Fixed' },
  { id: 'ignored', label: 'Ignored' },
  { id: 'all', label: 'All' },
];

/**
 * Problems tracked across runs: one row per problem however many runs saw
 * it. Status moves only with runs on the default branch; a problem is fixed
 * only when a later run tried the same operation under a fault that could
 * have shown it.
 */
function Issues({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const [filter, setFilter] = useState<IssueFilter>('active');
  const q = useQuery({
    queryKey: ['issues', projectId, filter],
    queryFn: () => api<{ issues: TrackedIssue[]; default_branch: string }>(`/api/projects/${projectId}/issues?status=${filter}`),
  });
  const setIgnored = async (i: TrackedIssue, ignored: boolean, reason = '') => {
    await patch(`/api/issues/${i.id}`, { ignored, reason });
    await qc.invalidateQueries({ queryKey: ['issues', projectId] });
    await qc.invalidateQueries({ queryKey: ['health', projectId] });
    toast(ignored ? 'Problem ignored' : 'Problem restored');
  };
  return (
    <Section
      title="Problems across runs"
      description={
        q.data?.default_branch ? (
          <>
            Status follows runs on <code>{q.data.default_branch}</code>. Pull-request runs are judged against it and never change it.
          </>
        ) : (
          'Status follows every run until the project learns its default branch from CI (or you set it under Edit).'
        )
      }
    >
      {dialog}
      <div className="filters" role="group" aria-label="Filter problems">
        {ISSUE_FILTERS.map((f) => (
          <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      {q.isPending && <Skeleton rows={4} height={36} />}
      {q.data && q.data.issues.length === 0 && (
        <Empty title={filter === 'active' ? 'No open problems' : 'Nothing here'}>
          {filter === 'active' ? 'Every problem found so far is fixed or ignored.' : 'No problem has this status.'}
        </Empty>
      )}
      {q.data && q.data.issues.length > 0 && (
        <ul className="issues-list">
          {q.data.issues.map((i) => {
            const g = guideFor(i.code);
            return (
              <li key={i.id}>
                <SeverityBadge s={i.severity} />
                <div>
                  <div className="issue-title">
                    {g?.title ?? i.code}
                    <IssueChip status={i.status} ignored={!!i.ignored_at} />
                    {amountText(i) && <span className="at-risk">{amountText(i)} at risk</span>}
                  </div>
                  <div className="issue-meta">
                    <code>{i.code}</code>
                    <code>{i.operation || i.path}</code>
                    <span>
                      seen in {i.times_seen} run{i.times_seen === 1 ? '' : 's'}, first {ago(i.first_seen_at)}
                    </span>
                    {i.last_seen_run && (
                      <Link to={`/runs/${i.last_seen_run}`} title={when(i.last_seen_at)}>
                        last seen {ago(i.last_seen_at)}
                      </Link>
                    )}
                    {i.fixed_run && i.fixed_at && (
                      <Link to={`/runs/${i.fixed_run}`} title={when(i.fixed_at)}>
                        fixed {ago(i.fixed_at)}
                      </Link>
                    )}
                    {i.regressed_at && i.status === 'regressed' && <span>came back {ago(i.regressed_at)}</span>}
                  </div>
                  {i.ignored_at && (
                    <div className="issue-meta">
                      Ignored {ago(i.ignored_at)}
                      {i.ignored_reason ? `: ${i.ignored_reason}` : ''}
                    </div>
                  )}
                </div>
                <div className="issue-actions">
                  {g && (
                    <Link className="button secondary small" to={`/guides#${i.code}`}>
                      Fix guide
                    </Link>
                  )}
                  {i.ignored_at ? (
                    <button className="secondary small" onClick={() => setIgnored(i, false).catch((e: Error) => toast(e.message, 'error'))}>
                      Stop ignoring
                    </button>
                  ) : (
                    <button
                      className="secondary small"
                      onClick={() =>
                        ask(
                          {
                            title: 'Ignore this problem?',
                            body: (
                              <p>
                                Runs keep reporting <code>{i.code}</code> on <code>{i.operation || i.path}</code>, but pull-request verdicts stop
                                counting it as new. You can undo this.
                              </p>
                            ),
                            confirm: 'Ignore problem',
                            input: { label: 'Reason (shown to your team)', placeholder: 'e.g. sandbox-only endpoint', maxLength: 500 },
                          },
                          (reason) => setIgnored(i, true, reason),
                        )
                      }
                    >
                      Ignore
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function Runs({ projectId }: { projectId: string }) {
  const nav = useNavigate();
  const runs = useInfiniteQuery({
    queryKey: ['runs', projectId],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<{ runs: Run[]; next_cursor: string | null }>(
        `/api/projects/${projectId}/runs?limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (runId: string) =>
    setPicked((p) => (p.includes(runId) ? p.filter((x) => x !== runId) : [...p, runId].slice(-2)));
  const all = runs.data?.pages.flatMap((p) => p.runs) ?? [];
  return (
    <Section
      title="Runs"
      description="Tick two runs to compare them. The older one is the baseline."
      actions={
        <button
          disabled={picked.length !== 2}
          onClick={() => {
            const [a, b] = picked
              .map((p) => all.find((r) => r.id === p)!)
              .sort((x, y) => x.started_at.localeCompare(y.started_at));
            nav(`/compare?base=${a!.id}&current=${b!.id}`);
          }}
        >
          Compare {picked.length}/2
        </button>
      }
    >
      <ErrorBox error={runs.error} onRetry={() => void runs.refetch()} />
      {runs.isPending && <Skeleton rows={4} height={28} />}
      {runs.data && all.length === 0 && (
        <Empty title="No runs yet">
          Create a token in the Tokens tab and start the engine with <code>-report-to</code>.
        </Empty>
      )}
      {all.length > 0 && (
        <div className="table-wrap">
          <table className="runs-table">
            <thead>
              <tr>
                <th>
                  <span className="sr-only">Select for comparison</span>
                </th>
                <th>Run</th>
                <th className="hide-sm">Branch</th>
                <th>Status</th>
                <th>Started</th>
                <th className="hide-sm">Duration</th>
                <th className="num hide-sm">Seed</th>
                <th className="num hide-sm">Requests</th>
                <th>Findings</th>
              </tr>
            </thead>
            <tbody>
              {all.map((r) => (
                <tr key={r.id} className={picked.includes(r.id) ? 'selected' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.name || r.id.slice(0, 8)} for comparison`}
                      checked={picked.includes(r.id)}
                      onChange={() => toggle(r.id)}
                    />
                  </td>
                  <td>
                    <Link to={`/runs/${r.id}`}>{r.name || r.id.slice(0, 8)}</Link>
                  </td>
                  <td className="hide-sm">
                    {r.branch ? <code>{r.branch}</code> : <span className="muted">—</span>}
                    {r.pr_number ? <span className="small muted"> · PR #{r.pr_number}</span> : null}
                  </td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                  <td title={when(r.started_at)}>{ago(r.started_at)}</td>
                  <td className="hide-sm">{duration(r.started_at, r.finished_at)}</td>
                  <td className="num hide-sm">{r.seed}</td>
                  <td className="num hide-sm">{r.request_count || '—'}</td>
                  <td>
                    {r.status === 'finished' ? <Counts high={r.high} medium={r.medium} low={r.low} /> : <span className="muted">in progress</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {runs.hasNextPage && (
        <button className="secondary load-more" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetchingNextPage}>
          {runs.isFetchingNextPage ? 'Loading…' : 'Load older runs'}
        </button>
      )}
    </Section>
  );
}

function Tokens({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const key = ['tokens', projectId];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ tokens: Token[] }>(`/api/projects/${projectId}/tokens`) });
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => post<Token>(`/api/projects/${projectId}/tokens`, { label: label.trim() }),
    onSuccess: (t) => {
      setFresh(t.token ?? null);
      setLabel('');
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const cmd = fresh ? `PAYCHAOS_TOKEN=${fresh} paychaos -report-to ${window.location.origin} -config scenario.json` : '';
  return (
    <Section title="Ingest tokens" description="The engine uses a token to stream runs into this project. Tokens are stored hashed.">
      {dialog}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input aria-label="Token label" placeholder="label, e.g. ci" value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'New token'}
        </button>
      </form>
      <ErrorBox error={create.error} />
      {fresh && (
        <div className="notice" role="status">
          <p>
            <strong>Copy this token now.</strong> It is stored hashed and can't be shown again.
          </p>
          <div className="copy-row">
            <pre className="copy">{fresh}</pre>
            <CopyButton text={fresh} />
          </div>
          <p className="muted small">Run the engine with it:</p>
          <div className="copy-row">
            <pre className="copy">{cmd}</pre>
            <CopyButton text={cmd} />
          </div>
          <button className="secondary small" onClick={() => setFresh(null)}>
            I've saved it
          </button>
        </div>
      )}
      <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      {q.isPending && <Skeleton rows={2} height={28} />}
      {q.data && q.data.tokens.length === 0 && !fresh && <Empty>No tokens yet.</Empty>}
      {q.data && q.data.tokens.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Starts with</th>
                <th className="hide-sm">Created</th>
                <th>Last used</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {q.data.tokens.map((t) => (
                <tr key={t.id} className={t.revoked_at ? 'revoked' : ''}>
                  <td>{t.label || <span className="muted">(none)</span>}</td>
                  <td>
                    <code>{t.prefix}…</code>
                  </td>
                  <td className="hide-sm" title={when(t.created_at)}>
                    {ago(t.created_at)}
                  </td>
                  <td title={when(t.last_used_at)}>{t.last_used_at ? ago(t.last_used_at) : <span className="muted">never</span>}</td>
                  <td className="right">
                    {t.revoked_at ? (
                      <span className="muted">revoked {ago(t.revoked_at)}</span>
                    ) : (
                      <button
                        className="secondary danger small"
                        onClick={() =>
                          ask(
                            {
                              title: 'Revoke this token?',
                              body: (
                                <p>
                                  Engines using <code>{t.prefix}…</code>
                                  {t.label ? ` (${t.label})` : ''} will get 401 on their next batch. Runs already stored are kept.
                                </p>
                              ),
                              confirm: 'Revoke token',
                              danger: true,
                            },
                            async () => {
                              await del(`/api/tokens/${t.id}`);
                              await qc.invalidateQueries({ queryKey: key });
                              toast('Token revoked');
                            },
                          )
                        }
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function EditProject({ project, onDone }: { project: P; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [branch, setBranch] = useState(project.default_branch ?? '');
  const save = useMutation({
    mutationFn: () =>
      patch<P>(`/api/projects/${project.id}`, { name: name.trim(), description: description.trim(), default_branch: branch.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['project', project.id] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      toast('Project updated');
      onDone();
    },
  });
  return (
    <Section title="Edit project">
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label className="field">
          <span>Name</span>
          <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          <span>Description</span>
          <input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          <span>
            Default branch <span className="muted">(runs on it update problem status; learned from CI if empty)</span>
          </span>
          <input value={branch} maxLength={200} placeholder="main" onChange={(e) => setBranch(e.target.value)} />
        </label>
        <div className="row">
          <button type="submit" disabled={save.isPending || !name.trim()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="secondary" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
      <ErrorBox error={save.error} />
    </Section>
  );
}

export function Project() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t === params.get('tab')) ?? 'overview';
  const [editing, setEditing] = useState(false);
  const project = useQuery({ queryKey: ['project', id], queryFn: () => api<P>(`/api/projects/${id}`) });
  const live = useLive({ project: id }, [['runs', id], ['projects'], ['health', id], ['issues', id]]);
  const p = project.data;

  return (
    <>
      {dialog}
      <Crumbs items={[{ to: '/', label: 'Projects' }, { label: p?.name ?? '…' }]} />
      {project.error ? (
        <ErrorBox error={project.error} onRetry={() => void project.refetch()} />
      ) : (
        <PageHeader
          title={p?.name ?? <span className="skeleton-inline" />}
          meta={
            <>
              {p?.description && <span>{p.description}</span>}
              <span className={`live ${live ? 'on' : ''}`} title={live ? 'Receiving live updates' : 'Live updates disconnected; reconnecting'}>
                {live ? 'live' : 'offline'}
              </span>
            </>
          }
          actions={
            <>
              <Link className="button secondary" to={`/projects/${id}/scenarios`}>
                Scenarios
              </Link>
              <button className="secondary" onClick={() => setEditing((e) => !e)} disabled={!p}>
                Edit
              </button>
              <button
                className="secondary danger"
                disabled={!p}
                onClick={() =>
                  p &&
                  ask(
                    {
                      title: `Delete ${p.name}?`,
                      body: <p>This permanently deletes the project with all its runs, findings, scenarios and tokens.</p>,
                      confirm: 'Delete project',
                      danger: true,
                      typeToConfirm: p.name,
                    },
                    async () => {
                      await del(`/api/projects/${id}`);
                      qc.removeQueries({ queryKey: ['project', id] });
                      await qc.invalidateQueries({ queryKey: ['projects'] });
                      toast(`Deleted ${p.name}`);
                      nav('/');
                    },
                  )
                }
              >
                Delete
              </button>
            </>
          }
        />
      )}
      {editing && p && <EditProject project={p} onDone={() => setEditing(false)} />}
      <div className="tabs" role="tablist" aria-label="Project sections">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'tab active' : 'tab'}
            onClick={() => setParams(t === 'overview' ? {} : { tab: t }, { replace: true })}
          >
            {t === 'issues' ? 'Problems' : t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'overview' && <Overview projectId={id} />}
        {tab === 'issues' && <Issues projectId={id} />}
        {tab === 'runs' && <Runs projectId={id} />}
        {tab === 'tokens' && <Tokens projectId={id} />}
      </div>
    </>
  );
}
