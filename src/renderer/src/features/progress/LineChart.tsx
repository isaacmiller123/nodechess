import { useId, type JSX } from 'react'
import type { SeriesPoint } from './format'

export interface LineChartProps {
  points: SeriesPoint[]
  /** Accessible description, e.g. "Estimated rating over your last 12 games". */
  label: string
  /** Optional value formatter for the min/max gridline captions. */
  formatValue?: (v: number) => string
  width?: number
  height?: number
  /** Tone hint -> drives the line color via a CSS class. */
  tone?: 'accent' | 'success'
}

/**
 * A compact, dependency-free line chart for a dated numeric series (rating or
 * accuracy over games). Distinct from Sparkline: it scales to the data's own
 * min/max (not a zero baseline), draws min/max gridlines with captions, and a
 * soft area fill. Points are spaced evenly by index. The series is already
 * chronological, so this reads left (oldest) to right (newest).
 *
 * Renders nothing for an empty series; callers show their own empty state.
 */
export default function LineChart({
  points,
  label,
  formatValue = (v) => String(Math.round(v)),
  width = 320,
  height = 96,
  tone = 'accent'
}: LineChartProps): JSX.Element | null {
  const gradId = useId()
  if (points.length === 0) return null

  const padX = 6
  const padTop = 10
  const padBottom = 16
  const innerW = width - padX * 2
  const innerH = height - padTop - padBottom

  const values = points.map((p) => p.value)
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (min === max) {
    // Flat series: pad the range so the line sits mid-box.
    const bump = Math.max(1, Math.abs(min) * 0.02)
    min -= bump
    max += bump
  }
  const span = max - min

  const x = (i: number): number =>
    points.length === 1 ? padX + innerW / 2 : padX + (i / (points.length - 1)) * innerW
  const y = (v: number): number => padTop + innerH - ((v - min) / span) * innerH

  const linePts = points.map((p, i) => `${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(' ')

  const first = x(0)
  const last = x(points.length - 1)
  const baseY = padTop + innerH
  const areaD =
    points.length > 1
      ? `M ${first.toFixed(2)} ${baseY.toFixed(2)} L ${points
          .map((p, i) => `${x(i).toFixed(2)} ${y(p.value).toFixed(2)}`)
          .join(' L ')} L ${last.toFixed(2)} ${baseY.toFixed(2)} Z`
      : ''

  const lastPoint = points[points.length - 1]
  const maxY = y(max)
  const minY = y(min)

  return (
    <svg
      className={`linechart tone-${tone}`}
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Min / max gridlines */}
      <line className="lc-grid" x1={padX} x2={width - padX} y1={maxY} y2={maxY} />
      <line className="lc-grid" x1={padX} x2={width - padX} y1={minY} y2={minY} />

      {/* Range captions (top = max, bottom = min) */}
      <text className="lc-caption" x={padX} y={maxY - 3}>
        {formatValue(max)}
      </text>
      <text className="lc-caption" x={padX} y={minY + 11}>
        {formatValue(min)}
      </text>

      {areaD && <path className="lc-area" d={areaD} fill={`url(#${gradId})`} />}
      {points.length > 1 && <polyline className="lc-line" points={linePts} />}
      <circle className="lc-dot" cx={last} cy={y(lastPoint.value)} r={3} />
    </svg>
  )
}
