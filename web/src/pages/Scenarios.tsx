import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, del, post, put, type Issue, type Project, type Scenario } from '../api';
import { Crumbs, Empty, ErrorBox, PageHeader, Section, Skeleton, useConfirm, useToast } from '../components/ui';
import { when } from '../format';

export const FAULTS = [
  'drop_after_commit',
  'error_500_after_commit',
  'hold_response',
  'truncate_after_commit',
  'timeout_before_forward',
  'rate_limit_429',
  'error_500',
  'token_expired_401',
  'latency',
  'none',
];

export const STARTER = {
  seed: 7,
  rules: [
    { name: 'lost-response-on-order', match: { method: 'POST', path_prefix: '/v2/checkout/orders' }, fault: 'drop_after_commit', probability: 0.2 },
    { name: 'lost-response-on-refund', match: { method: 'POST', path_prefix: '/v2/payments/captures' }, fault: 'drop_after_commit', probability: 0.3 },
    { name: 'token-expired', match: { method: 'POST' }, fault: 'token_expired_401', probability: 0.03 },
    { name: 'rate-limited', match: { method: 'POST' }, fault: 'rate_limit_429', probability: 0.08 },
  ],
  webhooks: { duplicate_probability: 0.5, duplicate_count: 1, max_delay_ms: 200, reorder_window_ms: 1000 },
  min_backoff_ms: 200,
  operation_id: ['purchase_units.0.invoice_id', 'invoice_id'],
};

/** Parses the editor text; JSON errors are reported like validation issues. */
export function parseConfig(text: string): { value?: unknown; issues: Issue[] } {
  try {
    return { value: JSON.parse(text), issues: [] };
  } catch (e) {
    return { issues: [{ path: '', message: `not valid JSON: ${(e as Error).message}` }] };
  }
}

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = `${name || 'scenario'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function Scenarios() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const key = ['scenarios', id];
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const project = useQuery({ queryKey: ['project', id], queryFn: () => api<Project>(`/api/projects/${id}`) });
  const list = useQuery({ queryKey: key, queryFn: () => api<{ scenarios: Scenario[] }>(`/api/projects/${id}/scenarios`) });
  const [editing, setEditing] = useState<Scenario | null>(null);
  const [name, setName] = useState('lost-responses');
  const [text, setText] = useState(JSON.stringify(STARTER, null, 2));
  const [issues, setIssues] = useState<Issue[]>([]);

  const parsed = useMemo(() => parseConfig(text), [text]);
  // Validate on the server as the user types (debounced), with the same
  // rules as `paychaos validate`.
  useEffect(() => {
    if (parsed.issues.length) {
      setIssues(parsed.issues);
      return;
    }
    const t = setTimeout(() => {
      post<{ valid: boolean; issues: Issue[] }>('/api/scenarios/validate', parsed.value)
        .then((r) => setIssues(r.issues))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [parsed]);

  const save = useMutation({
    mutationFn: () =>
      editing
        ? put<Scenario>(`/api/scenarios/${editing.id}`, { name, config: parsed.value })
        : post<Scenario>(`/api/projects/${id}/scenarios`, { name, config: parsed.value }),
    onSuccess: (s) => {
      setEditing(s);
      void qc.invalidateQueries({ queryKey: key });
      toast(`Saved ${s.name}`);
    },
  });
  // Unsaved when the editor differs from what was loaded or last saved.
  const dirty = editing
    ? name !== editing.name || parsed.issues.length > 0 || JSON.stringify(parsed.value) !== JSON.stringify(editing.config)
    : true;

  const guard = (go: () => void) => {
    if (editing && dirty) {
      ask({ title: 'Discard unsaved changes?', body: <p>Your edits to {editing.name} haven't been saved.</p>, confirm: 'Discard' }, async () => go());
    } else go();
  };
  const open = (s: Scenario) => guard(() => load(s));
  const load = (s: Scenario) => {
    setEditing(s);
    setName(s.name);
    setText(JSON.stringify(s.config, null, 2));
  };
  const fresh = () => guard(() => {
    setEditing(null);
    setName('new-scenario');
    setText(JSON.stringify(STARTER, null, 2));
  });

  return (
    <>
      {dialog}
      <Crumbs items={[{ to: '/', label: 'Projects' }, { to: `/projects/${id}`, label: project.data?.name ?? 'Project' }, { label: 'Scenarios' }]} />
      <PageHeader
        title="Scenarios"
        meta={
          <span>
            Scenarios are the engine's <code>-config</code> files. Save them here to share with the team, then download one and run{' '}
            <code>paychaos -config scenario.json</code>.
          </span>
        }
      />
      <div className="split">
        <Section title="Saved" actions={<button className="secondary" onClick={fresh}>New</button>}>
          <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
          {list.isPending && <Skeleton rows={3} />}
          {list.data?.scenarios.length === 0 && <Empty>None saved yet. The editor starts from a sensible default.</Empty>}
          <ul className="list">
            {list.data?.scenarios.map((s) => (
              <li key={s.id} className={editing?.id === s.id ? 'active' : ''}>
                <button className="link" onClick={() => open(s)}>
                  {s.name}
                </button>
                <span className="muted">updated {when(s.updated_at)}</span>
              </li>
            ))}
          </ul>
        </Section>
        <Section title={editing ? `Edit ${editing.name}${dirty ? ' (unsaved)' : ''}` : 'New scenario'}>
          <label className="field">
            Name
            <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            Configuration (JSON)
            <textarea aria-label="Scenario JSON" spellCheck={false} rows={22} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <p className="fault-list small"><span className="muted">Faults</span>{FAULTS.map((f) => <code key={f}>{f}</code>)}</p>
          {issues.length > 0 ? (
            <ul className="issues" aria-live="polite">
              {issues.map((i) => (
                <li key={i.path + i.message}>
                  <code>{i.path || '(root)'}</code> {i.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="ok-text" aria-live="polite">
              Valid scenario.
            </p>
          )}
          <ErrorBox error={save.error} />
          <div className="row">
            <button disabled={issues.length > 0 || !name.trim() || save.isPending || !dirty} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Save'}
            </button>
            <button className="secondary" disabled={parsed.issues.length > 0} onClick={() => download(name, JSON.stringify(parsed.value, null, 2))}>
              Download .json
            </button>
            {editing && (
              <button
                className="secondary danger"
                onClick={() =>
                  ask(
                    { title: `Delete ${editing.name}?`, body: <p>Runs that used it keep their own copy of the configuration.</p>, confirm: 'Delete scenario', danger: true },
                    async () => {
                      await del(`/api/scenarios/${editing.id}`);
                      setEditing(null);
                      setName('new-scenario');
                      setText(JSON.stringify(STARTER, null, 2));
                      await qc.invalidateQueries({ queryKey: key });
                      toast('Scenario deleted');
                    },
                  )
                }
              >
                Delete
              </button>
            )}
          </div>
        </Section>
      </div>
    </>
  );
}
