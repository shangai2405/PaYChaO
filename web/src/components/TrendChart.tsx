import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TrendRun } from '../api';
import { when } from '../format';

const SERIES = [
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
] as const;

const H = 220;
const PAD = { top: 12, right: 8, bottom: 28, left: 34 };

/** Clean axis ticks: 0 and up to four round steps covering max. */
export function ticks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const s = Math.max(1, Math.round(step));
  const out: number[] = [];
  for (let v = 0; v <= max + s - 1 && out.length < 6; v += s) out.push(v);
  if (out[out.length - 1]! < max) out.push(out[out.length - 1]! + s);
  return out;
}

/**
 * Findings per finished run, oldest to newest, stacked by severity. Severity
 * colours are the validated palette in styles.css (--chart-high/medium/low,
 * separate light and dark steps). Identity never rests on colour alone: a
 * legend, a tooltip per column and a table view carry the same numbers.
 */
export function TrendChart({ runs }: { runs: TrendRun[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totals = runs.map((r) => r.high + r.medium + r.low);
  const yTicks = useMemo(() => ticks(Math.max(...totals, 0)), [totals.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const yMax = yTicks[yTicks.length - 1]!;
  const plotW = width - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(runs.length, 1);
  const barW = Math.max(6, Math.min(36, slot * 0.6));
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const labelEvery = Math.ceil(runs.length / Math.max(1, Math.floor(plotW / 56)));

  const tip = hover !== null ? runs[hover] : null;
  // All runs on one day: label columns by time instead of a repeated date.
  const sameDay = new Set(runs.map((r) => new Date(r.started_at).toDateString())).size <= 1;

  return (
    <div className="chart">
      <div className="chart-bar">
        <ul className="legend" aria-label="Legend">
          {SERIES.map((s) => (
            <li key={s.key}>
              <span className={`swatch chart-${s.key}`} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
        <button className="link small" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          {table ? 'Show chart' : 'Show as table'}
        </button>
      </div>

      {table ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Findings per run</caption>
            <thead>
              <tr>
                <th>Run</th>
                <th>Started</th>
                <th className="num">High</th>
                <th className="num">Medium</th>
                <th className="num">Low</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{r.name || r.id.slice(0, 8)}</td>
                  <td>{when(r.started_at)}</td>
                  <td className="num">{r.high}</td>
                  <td className="num">{r.medium}</td>
                  <td className="num">{r.low}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrap} className="chart-plot" onMouseLeave={() => setHover(null)}>
          <svg width={width} height={H} role="img" aria-label={`Findings per run for the last ${runs.length} finished runs`}>
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'grid'} />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">
                  {t}
                </text>
              </g>
            ))}
            {runs.map((r, i) => {
              const cx = PAD.left + slot * i + slot / 2;
              let acc = 0;
              const segs = SERIES.map((s) => {
                const v = r[s.key];
                const seg = { key: s.key, v, y0: acc, y1: acc + v };
                acc += v;
                return seg;
              }).filter((s) => s.v > 0);
              return (
                <g
                  key={r.id}
                  className={`col ${hover === i ? 'active' : ''}`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  onClick={() => nav(`/runs/${r.id}`)}
                  onKeyDown={(e) => e.key === 'Enter' && nav(`/runs/${r.id}`)}
                  tabIndex={0}
                  role="link"
                  aria-label={`${r.name || r.id.slice(0, 8)}: ${r.high} high, ${r.medium} medium, ${r.low} low`}
                >
                  {/* Hit target: the whole slot, taller than the marks. */}
                  <rect x={cx - slot / 2} y={PAD.top} width={slot} height={plotH} className="hit" />
                  {segs.map((s, k) => {
                    const top = y(s.y1);
                    // 2px surface gap between stacked segments.
                    const h = Math.max(0, y(s.y0) - top - (k > 0 ? 2 : 0));
                    const last = k === segs.length - 1;
                    return last ? (
                      <path
                        key={s.key}
                        className={`chart-${s.key}`}
                        d={roundedTop(cx - barW / 2, top, barW, h, Math.min(4, h, barW / 2))}
                      />
                    ) : (
                      <rect key={s.key} className={`chart-${s.key}`} x={cx - barW / 2} y={top} width={barW} height={h} />
                    );
                  })}
                  {segs.length === 0 && <circle cx={cx} cy={y(0) - 4} r={3} className="zero-dot" />}
                  {i % labelEvery === 0 && (
                    <text x={cx} y={H - 8} textAnchor="middle" className="tick">
                      {shortDate(r.started_at, sameDay)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {tip && hover !== null && (
            <div
              className="chart-tip"
              style={{ left: Math.min(Math.max(PAD.left + slot * hover + slot / 2, 90), width - 90), top: 4 }}
              role="presentation"
            >
              <strong>{tip.name || tip.id.slice(0, 8)}</strong>
              <span className="muted">{when(tip.started_at)}</span>
              {SERIES.map((s) => (
                <span key={s.key} className="tip-row">
                  <span className={`swatch chart-${s.key}`} aria-hidden="true" />
                  {s.label}
                  <b>{tip[s.key]}</b>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return '';
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function shortDate(iso: string, sameDay: boolean): string {
  const d = new Date(iso);
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
