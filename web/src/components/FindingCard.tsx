import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Finding } from '../api';
import { guideFor, type Guide } from '../guides';
import { CopyButton, SeverityBadge } from './ui';

export function GuideBody({ g }: { g: Guide }) {
  return (
    <div className="guide">
      <p>
        <strong>Impact.</strong> {g.impact}
      </p>
      <p>
        <strong>Why it happens.</strong> {g.cause}
      </p>
      <p className="guide-h">How to fix it</p>
      <ol>
        {g.fix.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ol>
      {g.example && (
        <div className="code-block">
          <div className="code-head">
            <span>Example</span>
            <CopyButton text={g.example} />
          </div>
          <pre>
            <code>{g.example}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

/** One finding: what happened in this run, and on demand, how to fix it. */
export function FindingCard({ f }: { f: Finding }) {
  const g = guideFor(f.code);
  const [open, setOpen] = useState(false);
  const panel = `guide-${f.id}`;
  return (
    <li className={`finding sev-border-${f.severity.toLowerCase()}`}>
      <div className="finding-head">
        <SeverityBadge s={f.severity} />
        <span className="finding-title">{g?.title ?? f.code}</span>
      </div>
      <div className="finding-meta">
        <code>{f.code}</code>
        <span>{f.operation || f.path}</span>
        {f.requests.length > 0 && <span>requests {f.requests.map((n) => `#${n}`).join(', ')}</span>}
      </div>
      <p className="finding-msg">{f.message}</p>
      {f.object_ids.length > 0 && (
        <p className="objects">
          <span className="muted">Resources</span>
          {f.object_ids.map((o) => (
            <code key={o}>{o}</code>
          ))}
        </p>
      )}
      {g && (
        <>
          <button className="link small" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide fix guide' : 'How to fix this'}
          </button>
          {open && (
            <div id={panel}>
              <GuideBody g={g} />
              <Link className="small" to={`/guides#${g.code}`}>
                All finding types
              </Link>
            </div>
          )}
        </>
      )}
    </li>
  );
}
