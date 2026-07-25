import { useMemo } from 'react'
import type { ReviewMoveEval } from '@shared/types'
import { badgeMeta, isNotableBadge } from '../features/analysis/badges'

export interface EvalGraphProps {
  moveEvals: ReviewMoveEval[]
  /** Ply currently shown on the board (0 = start). Highlights the matching point. */
  currentPly: number
  /** Jump the board to the position AFTER the move at `ply`. */
  onSeek: (ply: number) => void
}

// viewBox space: width is computed from the sample count so points are evenly
// spaced regardless of game length; the container scales the SVG to fit.
const VB_H = 100
const PAD_Y = 6

// White win-expectancy (0..100) for one ply, taken from the position AFTER the
// move so the curve reads as "advantage over time".
function yFor(winAfter: number): number {
  const clamped = Math.max(0, Math.min(100, winAfter))
  // 100% white at top, 0% at bottom.
  const usable = VB_H - PAD_Y * 2
  return PAD_Y + (100 - clamped) * (usable / 100)
}

export function EvalGraph({ moveEvals, currentPly, onSeek }: EvalGraphProps) {
  const n = moveEvals.length
  const vbW = Math.max(n - 1, 1) * 12 + 12

  const { areaPath, linePath, points, midY } = useMemo(() => {
    const step = n > 1 ? (vbW - 12) / (n - 1) : 0
    const xs = moveEvals.map((_, i) => 6 + i * step)
    // winAfter is mover-POV (see MoveEval in main/review/review.ts); convert to
    // white-POV per ply or every black move mirrors across the midline and the
    // chart saw-tooths between the two sides.
    const ys = moveEvals.map((m) => yFor(m.color === 'white' ? m.winAfter : 100 - m.winAfter))
    const pts = moveEvals.map((m, i) => ({ x: xs[i], y: ys[i], m, ply: m.ply }))

    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')

    const mid = yFor(50)
    let area = ''
    if (pts.length) {
      area =
        `M${pts[0].x.toFixed(2)},${mid.toFixed(2)} ` +
        pts.map((p) => `L${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ') +
        ` L${pts[pts.length - 1].x.toFixed(2)},${mid.toFixed(2)} Z`
    }
    return { areaPath: area, linePath: line, points: pts, midY: mid }
  }, [moveEvals, n, vbW])

  if (n === 0) {
    return (
      <div className="eval-graph empty muted small" role="status">
        Run a review to see the advantage chart.
      </div>
    )
  }

  return (
    <div className="eval-graph">
      <svg
        viewBox={`0 0 ${vbW} ${VB_H}`}
        preserveAspectRatio="none"
        className="eval-graph-svg"
        role="img"
        aria-label="Advantage over the course of the game"
      >
        {/* Black half background sits below the equality line. */}
        <rect x={0} y={midY} width={vbW} height={VB_H - midY} className="eg-black-zone" />
        <rect x={0} y={0} width={vbW} height={midY} className="eg-white-zone" />
        <line x1={0} y1={midY} x2={vbW} y2={midY} className="eg-axis" />
        {areaPath && <path d={areaPath} className="eg-area" />}
        <path d={linePath} className="eg-line" />
        {points.map((p) => {
          const isCurrent = p.ply === currentPly
          const notable = isNotableBadge(p.m.badge)
          return (
            <g key={p.ply} className="eg-pt-group" onClick={() => onSeek(p.ply)}>
              {/* Wide invisible hit target for easy clicking. */}
              <rect x={p.x - 6} y={0} width={12} height={VB_H} className="eg-hit" />
              {notable && <circle cx={p.x} cy={p.y} r={2.6} className={`eg-mark tone-${badgeMeta(p.m.badge).tone}`} />}
              {isCurrent && <circle cx={p.x} cy={p.y} r={3.4} className="eg-current" />}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
