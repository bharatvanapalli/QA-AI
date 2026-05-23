import React from 'react';

/**
 * Compact horizontal stacked bar showing pass / fail / blocked / pending split.
 * No external chart library — pure SVG.
 *
 * data = [{ label, pass, fail, blocked, pending }]
 */
export default function StackedBar({ data = [], width = 460, rowHeight = 34 }) {
  // Scale every row's track so totals fit. A row with all-zero counts gets
  // an empty light track plus a small "not yet run" placeholder so the user
  // can tell the difference between a zero-total row and a pending row.
  const maxTotal = Math.max(1, ...data.map((d) => (d.pass || 0) + (d.fail || 0) + (d.blocked || 0) + (d.pending || 0)));
  const labelW = 110;
  const numericW = 64;
  const barW = width - labelW - numericW;

  // Distinct, accessible colors. Pending now uses a clear cool-gray that
  // is visibly different from the track behind it (the previous #cbd5e1
  // was nearly identical to #eef0f4 — pending segments disappeared into
  // the background).
  const TRACK = '#f1f3f7';
  const PASS = '#10b981';
  const FAIL = '#ef4444';
  const BLOCKED = '#f59e0b';
  const PENDING = '#94a3b8';

  return (
    <svg width="100%" height={data.length * rowHeight + 18} viewBox={`0 0 ${width} ${data.length * rowHeight + 18}`} className="block">
      {data.map((row, i) => {
        const pass = row.pass || 0;
        const fail = row.fail || 0;
        const blocked = row.blocked || 0;
        const pending = row.pending || 0;
        const total = pass + fail + blocked + pending;
        const scale = (n) => (total ? (n / maxTotal) * barW : 0);
        const y = i * rowHeight + 8;
        const segments = [
          { value: pass,    fill: PASS },
          { value: fail,    fill: FAIL },
          { value: blocked, fill: BLOCKED },
          { value: pending, fill: PENDING },
        ];
        let x = labelW;
        return (
          <g key={row.label}>
            <text x={0} y={y + 15} fill="#0b1220" fontSize="12.5" fontWeight="600" fontFamily="Inter">
              {row.label}
            </text>
            {/* Track */}
            <rect x={labelW} y={y + 6} width={barW} height={14} rx={7} fill={TRACK} />
            {/* Segments — drawn left-to-right, each contributes its scaled
                width to the running cursor. Segments with value 0 are
                skipped entirely so they don't claim a pixel. */}
            {segments.map((s, idx) => {
              if (!s.value) return null;
              const w = scale(s.value);
              const seg = (
                <rect
                  key={idx}
                  x={x}
                  y={y + 6}
                  width={w}
                  height={14}
                  fill={s.fill}
                  // Round only the outermost edges of the filled portion
                  rx={idx === 0 ? 7 : 0}
                />
              );
              x += w;
              return seg;
            })}
            {/* Numeric label — show pass/total when there's any pass, else
                show the dominant non-zero bucket (so "0/6 blocked" reads
                "6 blocked" instead of an ambiguous "0/6"). */}
            <text
              x={width - 6}
              y={y + 15}
              fill="#4a5161"
              fontSize="11.5"
              textAnchor="end"
              fontFamily="Inter"
              fontVariantNumeric="tabular-nums"
            >
              {pass > 0 ? `${pass}/${total}` : blocked > 0 ? `${blocked} blocked` : pending > 0 ? `${pending} pending` : `${total}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
