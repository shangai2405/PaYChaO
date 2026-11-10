import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, post, type Project } from '../api';
import { Counts, Empty, ErrorBox, HealthBadge, healthOf, PageHeader, Section, Skeleton, useToast } from '../components/ui';
import { ago } from '../format';

export function Projects() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const q = useQuery({ queryKey: ['projects'], queryFn: () => api<{ projects: Project[] }>('/api/projects') });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [filter, setFilter] = useState('');
  const create = useMutation({
    mutationFn: () => post<Project>('/api/projects', { name: name.trim(), description: description.trim() }),
    onSuccess: (p) => {
      setName('');
      setDescription('');
      void qc.invalidateQueries({ queryKey: ['projects'] });
      toast(`Created ${p.name}`);
      nav(`/projects/${p.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };
  const projects = q.data?.projects ?? [];
  const shown = projects.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const failing = projects.filter((p) => healthOf(p.latest) === 'failing').length;

  return (
    <>
      <PageHeader
        title="Projects"
        meta={
          q.data
            ? `${projects.length} project${projects.length === 1 ? '' : 's'}${failing ? ` · ${failing} failing` : ''}`
            : 'A project groups the runs of one PayPal integration.'
        }
      />
      <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      {q.isPending && (
        <div className="project-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card">
              <Skeleton rows={3} />
            </div>
          ))}
        </div>
      )}
      {q.data && projects.length > 3 && (
        <input
          className="search"
          type="search"
          aria-label="Filter projects"
          placeholder="Filter projects…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {q.data && projects.length > 0 && shown.length === 0 && <Empty>No project matches “{filter}”.</Empty>}
      {shown.length > 0 && (
        <ul className="project-grid">
          {shown.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="card project-card">
                <div className="project-card-head">
                  <h2>{p.name}</h2>
                  <HealthBadge status={healthOf(p.latest)} />
                </div>
                {p.description && <p className="muted clamp">{p.description}</p>}
                <div className="project-card-foot">
                  {p.latest ? (
                    <>
                      <Counts high={p.latest.high} medium={p.latest.medium} low={p.latest.low} />
                      <span className="muted small">
                        latest run {ago(p.latest.started_at)} · {p.run_count ?? 0} run{p.run_count === 1 ? '' : 's'}
                      </span>
                    </>
                  ) : (
                    <span className="muted small">{p.run_count ? `${p.run_count} run in progress` : 'No runs yet'}</span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Section
        title={projects.length === 0 && q.data ? 'Create your first project' : 'New project'}
        description="Each project gets its own ingest tokens for the engine's -report-to flag."
      >
        <form className="form-grid" onSubmit={submit}>
          <label className="field">
            <span>Name</span>
            <input placeholder="checkout-service" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field">
            <span>
              Description <span className="muted">(optional)</span>
            </span>
            <input placeholder="Node checkout API, PayPal Orders v2" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div>
            <button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
        <ErrorBox error={create.error} />
      </Section>
    </>
  );
}
