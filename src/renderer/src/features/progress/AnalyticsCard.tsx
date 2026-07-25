import type { JSX } from 'react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import type { GameRow, ProgressSummary } from '../../../../shared/types'
import LineChart from './LineChart'
import {
  accuracySeries,
  estEloSeries,
  formatAccuracy,
  seriesStats,
  solvePercent,
  type SeriesStats
} from './format'

export interface AnalyticsCardProps {
  games: GameRow[]
  summary: ProgressSummary | null
}

type DeltaTone = 'up' | 'down' | 'flat'

function deltaToneOf(delta: number): DeltaTone {
  if (delta > 0.05) return 'up'
  if (delta < -0.05) return 'down'
  return 'flat'
}

function DeltaPill({ stats, unit }: { stats: SeriesStats; unit: string }): JSX.Element {
  const tone = deltaToneOf(stats.delta)
  const Icon = tone === 'up' ? TrendingUp : tone === 'down' ? TrendingDown : Minus
  const rounded = Math.round(stats.delta * 10) / 10
  const sign = rounded > 0 ? '+' : ''
  const text = tone === 'flat' ? 'no change' : `${sign}${rounded}${unit}`
  return (
    <span className={`delta-pill ${tone}`} title="Change across this window">
      <Icon size={13} aria-hidden />
      <span className="num">{text}</span>
    </span>
  )
}

/**
 * One charted metric: header (label + delta pill), the line chart, and a footer
 * caption (avg / current). Falls back to an inline empty hint when there is no
 * usable series yet.
 */
function ChartBlock({
  title,
  hint,
  emptyHint,
  points,
  tone,
  unit,
  formatValue
}: {
  title: string
  hint: string
  emptyHint: string
  points: ReturnType<typeof estEloSeries>
  tone: 'accent' | 'success'
  unit: string
  formatValue: (v: number) => string
}): JSX.Element {
  const stats = seriesStats(points)
  return (
    <div className="chart-block">
      <div className="chart-block-head">
        <div className="chart-block-titles">
          <span className="chart-block-title">{title}</span>
          <span className="chart-block-hint small muted">{hint}</span>
        </div>
        {stats && points.length > 1 && <DeltaPill stats={stats} unit={unit} />}
      </div>

      {stats ? (
        <>
          <LineChart points={points} label={`${title}, ${hint}`} tone={tone} formatValue={formatValue} />
          <div className="chart-block-foot small muted num">
            <span>Now {formatValue(stats.last)}</span>
            <span aria-hidden>·</span>
            <span>Avg {formatValue(stats.avg)}</span>
            <span aria-hidden>·</span>
            <span>{stats.count} games</span>
          </div>
        </>
      ) : (
        <p className="chart-empty small muted">{emptyHint}</p>
      )}
    </div>
  )
}

export default function AnalyticsCard({ games, summary }: AnalyticsCardProps): JSX.Element {
  const elo = estEloSeries(games)
  const acc = accuracySeries(games)

  const solved = summary?.puzzlesSolved ?? 0
  const tried = summary?.puzzlesTried ?? 0
  const solveRate = solvePercent(solved, tried)

  return (
    <section className="card progress-card analytics-card">
      <div className="card-title-row">
        <h3 className="card-title">Performance over time</h3>
        {solveRate != null && (
          <span className="small muted">
            Puzzle solve rate <strong className="solverate-inline num">{solveRate}%</strong>
          </span>
        )}
      </div>

      <div className="analytics-charts">
        <ChartBlock
          title="Estimated strength"
          hint="reviewed games"
          emptyHint="Review a few games to chart your estimated playing strength."
          points={elo}
          tone="accent"
          unit=""
          formatValue={(v) => String(Math.round(v))}
        />
        <ChartBlock
          title="Accuracy"
          hint="per game"
          emptyHint="Play and review games to see your accuracy trend."
          points={acc}
          tone="success"
          unit="%"
          formatValue={(v) => formatAccuracy(v)}
        />
      </div>
    </section>
  )
}
