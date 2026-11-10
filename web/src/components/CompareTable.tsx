import type { CompareRow } from '../api';
import { SeverityBadge } from './ui';

export function CompareTable({ rows }: { rows: CompareRow[] }) {
  if (rows.length === 0) return <p className="muted">Neither run has findings.</p>;
  return (
    <div className="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Severity</th>
          <th>Code</th>
          <th>Path</th>
          <th className="num">Baseline</th>
          <th className="num">Current</th>
          <th className="num">Change</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.severity}|${r.code}|${r.path}`} className={r.delta > 0 ? 'worse' : r.delta < 0 ? 'better' : ''}>
            <td>
              <SeverityBadge s={r.severity} />
            </td>
            <td>
              <code>{r.code}</code>
            </td>
            <td>
              <code>{r.path}</code>
            </td>
            <td className="num">{r.baseline}</td>
            <td className="num">{r.current}</td>
            <td className="num delta">{r.delta > 0 ? `+${r.delta}` : r.delta}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
