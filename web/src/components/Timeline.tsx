import type { Operation } from '../api';
import { amountText, outcome } from '../format';
import { SeverityBadge } from './ui';

/**
 * One business operation's attempts, left to right: what the proxy did to
 * each, what the upstream answered, and which object it created. Two
 * different object ids in one row is the duplicate, made visible.
 */
export function Timeline({ op }: { op: Operation }) {
  const ids = [...new Set(op.timeline.filter((a) => a.committed && a.object_id).map((a) => a.object_id))];
  return (
    <div className="timeline">
      <div className="timeline-head">
        <code className="op">{op.operation || op.path}</code>
        <span className="muted">
          {op.attempts} attempt{op.attempts === 1 ? '' : 's'}
          {ids.length > 1 && <strong className="dup"> · {ids.length} resources created</strong>}
        </span>
        <span className="tags">
          {op.findings.map((f) => (
            <span key={f.code} className="tag">
              <SeverityBadge s={f.severity} /> {f.code}
            </span>
          ))}
        </span>
      </div>
      <ol className="attempts">
        {op.timeline.map((a, i) => {
          const o = outcome(a);
          const idIndex = a.committed && a.object_id ? ids.indexOf(a.object_id) : -1;
          return (
            <li key={a.seq} className={`attempt tone-${o.tone}`}>
              {i > 0 && <span className="arrow" aria-hidden="true">→</span>}
              <div className="attempt-box">
                <div className="attempt-seq">#{a.seq}</div>
                <div className="attempt-label">{o.label}</div>
                {amountText(a) && <div className="attempt-amount">{amountText(a)}</div>}
                <div className="attempt-meta">
                  {a.request_id ? <code title={a.request_id}>id {a.request_id.slice(0, 8)}…</code> : <span className="warn-text">no request id</span>}
                </div>
                {idIndex >= 0 && (
                  <div className={`object obj-${idIndex % 4}`} title={a.object_id}>
                    {a.object_id}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
