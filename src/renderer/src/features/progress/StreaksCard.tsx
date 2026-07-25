import type { JSX } from 'react'
import { Flame, Snowflake, Trophy, Target } from 'lucide-react'
import type { GameRow, ProgressSummary } from '../../../../shared/types'
import { computeStreaks, formatCount, solvePercent } from './format'

export interface StreaksCardProps {
  games: GameRow[]
  summary: ProgressSummary | null
}

interface StreakStat {
  key: string
  Icon: typeof Flame
  value: string
  label: string
  tone: 'success' | 'danger' | 'neutral'
}

/**
 * Streaks + solve-rate at a glance: the current run (win/loss), best win streak,
 * and puzzle solve rate. Tones are semantic (win=success, loss=danger). Empty
 * profiles render neutral placeholders rather than zeros that imply a loss run.
 */
export default function StreaksCard({ games, summary }: StreaksCardProps): JSX.Element {
  const { current, bestWin, worstLoss } = computeStreaks(games)
  const solved = summary?.puzzlesSolved ?? 0
  const tried = summary?.puzzlesTried ?? 0
  const solveRate = solvePercent(solved, tried)
  const hasGames = games.length > 0

  const currentStat: StreakStat = !hasGames
    ? { key: 'current', Icon: Flame, value: '·', label: 'Current streak', tone: 'neutral' }
    : current > 0
      ? {
          key: 'current',
          Icon: Flame,
          value: `${current}W`,
          label: 'On a win streak',
          tone: 'success'
        }
      : current < 0
        ? {
            key: 'current',
            Icon: Snowflake,
            value: `${Math.abs(current)}L`,
            label: 'On a losing run',
            tone: 'danger'
          }
        : { key: 'current', Icon: Flame, value: '0', label: 'No active streak', tone: 'neutral' }

  const stats: StreakStat[] = [
    currentStat,
    {
      key: 'best',
      Icon: Trophy,
      value: bestWin > 0 ? `${bestWin}W` : '·',
      label: 'Best win streak',
      tone: bestWin > 0 ? 'success' : 'neutral'
    },
    {
      key: 'solve',
      Icon: Target,
      value: solveRate == null ? '·' : `${solveRate}%`,
      label: 'Puzzle solve rate',
      tone: 'neutral'
    }
  ]

  return (
    <section className="card progress-card streaks-card">
      <h3 className="card-title">Streaks &amp; form</h3>
      <div className="streaks-grid">
        {stats.map((s) => (
          <div className={`streak-stat tone-${s.tone}`} key={s.key}>
            <span className="streak-icon" aria-hidden>
              <s.Icon size={16} />
            </span>
            <span className="streak-value num">{s.value}</span>
            <span className="streak-label small muted">{s.label}</span>
          </div>
        ))}
      </div>
      {worstLoss > 1 && (
        <p className="streaks-foot small muted">
          Longest losing run this window: {formatCount(worstLoss)}.
        </p>
      )}
    </section>
  )
}
