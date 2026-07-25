import type { JSX } from 'react'
import type { TrendPoint } from './format'

export interface SparklineProps {
  points: TrendPoint[]
  width?: number
  height?: number
}

/**
 * A lightweight SVG sparkline of a cumulative win/loss momentum series.
 * Single polyline + soft area fill + endpoint dot. No external deps, fully
 * driven by CSS tokens (via currentColor / className), scales to its box.
 */
export default function Sparkline({
  points,
  width = 320,
  height = 56
}: SparklineProps): JSX.Element | null {
  if (points.length === 0) return null

  // Single point can't form a line. Render a flat baseline dot.
  const pad = 4
  const innerW = width - pad * 2
  const innerH = height - pad * 2

  const values = points.map((p) => p.value)
  let min = Math.min(0, ...values)
  let max = Math.max(0, ...values)
  if (min === max) {
    // Avoid a divide-by-zero; center a flat line.
    min -= 1
    max += 1
  }
  const span = max - min

  const x = (i: number): number =>
    points.length === 1 ? pad + innerW / 2 : pad + (i / (points.length - 1)) * innerW
  const y = (v: number): number => pad + innerH - ((v - min) / span) * innerH

  const linePts = points.map((p, i) => `${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(' ')

  // Area path: line, then down to baseline and back to start.
  const baselineY = y(0)
  const first = x(0)
  const last = x(points.length - 1)
  const areaD = `M ${first.toFixed(2)} ${baselineY.toFixed(2)} L ${points
    .map((p, i) => `${x(i).toFixed(2)} ${y(p.value).toFixed(2)}`)
    .join(' L ')} L ${last.toFixed(2)} ${baselineY.toFixed(2)} Z`

  const lastPoint = points[points.length - 1]
  const trend =
    lastPoint.value > 0 ? 'up' : lastPoint.value < 0 ? 'down' : 'flat'

  return (
    <svg
      className={`sparkline trend-${trend}`}
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label="Recent results momentum"
    >
      {/* Zero baseline */}
      <line
        className="spark-baseline"
        x1={pad}
        x2={width - pad}
        y1={baselineY}
        y2={baselineY}
      />
      <path className="spark-area" d={areaD} />
      {points.length > 1 && <polyline className="spark-line" points={linePts} />}
      <circle className="spark-dot" cx={last} cy={y(lastPoint.value)} r={3} />
    </svg>
  )
}
