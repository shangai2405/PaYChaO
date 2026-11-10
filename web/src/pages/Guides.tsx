import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { Severity } from '../api';
import { GuideBody } from '../components/FindingCard';
import { PageHeader, SeverityBadge } from '../components/ui';
import { GUIDES } from '../guides';

/** Every finding code the auditor can raise, with its fix. */
export function Guides() {
  const { hash } = useLocation();
  const [sev, setSev] = useState<Severity | ''>('');
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);
  const shown = GUIDES.filter((g) => !sev || g.severity === sev);
  return (
    <>
      <PageHeader
        title="Fix guides"
        meta="What each finding means for your business, why it happens, and the code change that fixes it."
        actions={
          <div className="segmented" role="group" aria-label="Filter by severity">
            {(['', 'HIGH', 'MEDIUM', 'LOW'] as const).map((s) => (
              <button key={s || 'all'} className={sev === s ? 'on' : ''} aria-pressed={sev === s} onClick={() => setSev(s)}>
                {s ? s[0] + s.slice(1).toLowerCase() : 'All'}
              </button>
            ))}
          </div>
        }
      />
      <div className="guide-list">
        {shown.map((g) => (
          <article key={g.code} id={g.code} className={`card guide-card sev-border-${g.severity.toLowerCase()}`}>
            <header className="finding-head">
              <SeverityBadge s={g.severity} />
              <h2>{g.title}</h2>
            </header>
            <code className="muted">{g.code}</code>
            <GuideBody g={g} />
          </article>
        ))}
      </div>
    </>
  );
}
