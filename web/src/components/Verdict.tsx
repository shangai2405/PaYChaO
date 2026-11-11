import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Run, type Verdict, type VerdictItem } from '../api';
import { guideFor } from '../guides';
import { CopyButton, Empty, ErrorBox, Money, SeverityBadge, Skeleton } from './ui';

function Items({ items }: { items: VerdictItem[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Severity</th>
            <th>Problem</th>
            <th className="hide-sm">Where</th>
            <th>At risk</th>
            <th className="num">Count</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.key}>
              <td>
                <SeverityBadge s={i.severity} />
              </td>
              <td>
                {guideFor(i.code) ? <Link to={`/guides#${i.code}`}>{guideFor(i.code)!.title}</Link> : i.code}
                <div className="small muted">
                  <code>{i.code}</code>
                </div>
              </td>
              <td className="hide-sm">
                <code>{i.operation || i.path}</code>
              </td>
              <td>
                <Money totals={i.money_at_risk} empty="—" />
              </td>
              <td className="num">{i.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * This run judged against its base: the latest finished run of the pull
 * request's base branch, or the previous run of the same branch. The same
 * text the engine posts on the pull request.
 */
export function VerdictPanel({ run }: { run: Run }) {
  const q = useQuery({ queryKey: ['verdict', run.id], queryFn: () => api<Verdict>(`/api/runs/${run.id}/verdict`) });
  if (q.isPending) return <Skeleton rows={4} height={28} />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const v = q.data;
  const newHigh = v.new.filter((i) => i.severity === 'HIGH').length;
  const base = v.base_branch || v.baseline?.branch;
  return (
    <>
      <p className="verdict-head">
        <span aria-hidden="true">{v.new.length === 0 ? '✅' : newHigh > 0 ? '❌' : '⚠️'}</span>
        {v.new.length === 0 ? 'No new payment-safety problems' : `${v.new.length} new problem${v.new.length === 1 ? '' : 's'} (${newHigh} high)`}
        {v.new_money_at_risk.length > 0 && (
          <span className="at-risk">
            <Money totals={v.new_money_at_risk} /> newly at risk
          </span>
        )}
      </p>
      <p className="verdict-sub">
        {v.baseline ? (
          <>
            Compared with <Link to={`/runs/${v.baseline.id}`}>{v.baseline.name || v.baseline.id.slice(0, 8)}</Link>
            {base && (
              <>
                , the latest run on <code>{base}</code>
              </>
            )}
            {v.baseline.commit_sha && <> ({v.baseline.commit_sha.slice(0, 7)})</>}.{' '}
          </>
        ) : (
          <>No earlier run{base ? <> on <code>{base}</code></> : ''} to compare with, so every problem counts as new. </>
        )}
        Fixed {v.fixed.length} · still open {v.unchanged.length}
        {v.not_retested.length > 0 && <> · not retested {v.not_retested.length}</>}
        {v.ignored.length > 0 && <> · ignored {v.ignored.length}</>}
      </p>
      {v.baseline && !v.comparable && (
        <p className="notice">The two runs used different seeds, so different faults fired. Use a fixed seed in CI for a fair comparison.</p>
      )}
      {v.new.length > 0 && (
        <div className="verdict-group">
          <h3>New</h3>
          <Items items={v.new} />
        </div>
      )}
      {v.fixed.length > 0 && (
        <div className="verdict-group">
          <h3>Fixed</h3>
          <Items items={v.fixed} />
        </div>
      )}
      {v.not_retested.length > 0 && (
        <div className="verdict-group">
          <h3>Not retested</h3>
          <p className="muted">
            These were open before, but this run never sent the same operation under a fault that could show them, so it cannot say whether they are
            fixed.
          </p>
          <Items items={v.not_retested} />
        </div>
      )}
      {v.unchanged.length > 0 && (
        <div className="verdict-group">
          <h3>Still open</h3>
          <Items items={v.unchanged} />
        </div>
      )}
      {v.new.length + v.fixed.length + v.unchanged.length + v.not_retested.length === 0 && (
        <Empty>Neither run found a problem.</Empty>
      )}
      <div className="verdict-group">
        <h3>Pull-request comment</h3>
        <p className="muted">
          <code>paychaos ci</code> posts this on the pull request. Copy it to paste somewhere else.
        </p>
        <CopyButton text={v.markdown} label="Copy as Markdown" />
      </div>
    </>
  );
}
