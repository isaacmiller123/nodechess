import type { JSX } from 'react'
import type { ProgressSummary } from '../../../../shared/types'
import { formatCount, solvePercent } from './format'

export interface HeadlineStatsProps {
  summary: ProgressSummary | null
}

interface Stat {
  label: string
  value: string
  sub?: string
}

export default function HeadlineStats({ summary }: HeadlineStatsProps): JSX.Element {
  const solved = summary?.puzzlesSolved ?? 0
  const tried = summary?.puzzlesTried ?? 0
  const played = summary?.gamesPlayed ?? 0
  const pct = solvePercent(solved, tried)

  const stats: Stat[] = [
    {
      label: 'Puzzles solved',
      value: formatCount(solved),
      sub: tried > 0 ? `of ${formatCount(tried)} tried` : 'none tried yet'
    },
    {
      label: 'Solve rate',
      value: pct == null ? '·' : `${pct}%`,
      sub: pct == null ? 'attempt a puzzle' : `${formatCount(tried)} attempts`
    },
    {
      label: 'Games played',
      value: formatCount(played),
      sub: played > 0 ? 'vs bots' : 'none yet'
    }
  ]

  return (
    <section className="card progress-card headline-card">
      <h3 className="card-title">Totals</h3>
      <div className="headline-grid">
        {stats.map((s) => (
          <div className="headline-stat" key={s.label}>
            <span className="headline-value">{s.value}</span>
            <span className="headline-label">{s.label}</span>
            {s.sub && <span className="headline-sub small muted">{s.sub}</span>}
          </div>
        ))}
      </div>
    </section>
  )
}
