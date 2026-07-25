import type { JSX } from 'react'
import {
  ArrowRight,
  GraduationCap,
  Layers,
  Puzzle as PuzzleIcon,
  Target,
  type LucideIcon
} from 'lucide-react'
import type {
  GameRow,
  ProgressSummary,
  SchoolChapterMeta,
  SchoolMastery
} from '../../../../shared/types'
import type { HomeNavTarget } from './HomeView'
import { nextSchoolStep, resultKind, schoolCompletedCount } from './format'

export interface InsightsStripProps {
  summary: ProgressSummary | null
  games: GameRow[]
  chapters: SchoolChapterMeta[]
  mastery: SchoolMastery | null
  /** Solved-count baseline captured at first load this run; null until known. */
  sessionBaseline: number | null
  onNavigate: (view: HomeNavTarget) => void
}

const NEXT_KICKER: Record<'placement' | 'continue' | 'start' | 'review', string> = {
  placement: 'Start here',
  continue: 'Continue',
  start: 'Up next',
  review: 'Review'
}

interface StatTileProps {
  Icon: LucideIcon
  label: string
  value: string
  hint?: string
}

function StatTile({ Icon, label, value, hint }: StatTileProps): JSX.Element {
  return (
    <div className="insight-tile">
      <span className="insight-tile-icon" aria-hidden>
        <Icon size={16} />
      </span>
      <div className="insight-tile-body">
        <span className="insight-tile-label">{label}</span>
        <span className="insight-tile-value">{value}</span>
        {hint && <span className="insight-tile-hint small muted">{hint}</span>}
      </div>
    </div>
  )
}

/**
 * Pull the most recent game that carries an accuracy figure for the user's
 * side. Returns a rounded percentage string or null when nothing is reviewed.
 */
function recentAccuracy(games: GameRow[]): string | null {
  for (const g of games) {
    const acc = g.user_color === 'black' ? g.accuracy_black : g.accuracy_white
    if (acc != null && Number.isFinite(acc)) return `${Math.round(acc)}%`
  }
  return null
}

/** Win count among the recent games (best-effort form indicator). */
function recentForm(games: GameRow[]): { wins: number; total: number } {
  let wins = 0
  let total = 0
  for (const g of games) {
    const kind = resultKind(g)
    if (kind === 'unknown') continue
    total += 1
    if (kind === 'win') wins += 1
  }
  return { wins, total }
}

export default function InsightsStrip({
  summary,
  games,
  chapters,
  mastery,
  sessionBaseline,
  onNavigate
}: InsightsStripProps): JSX.Element {
  const solvedTotal =
    summary && Number.isFinite(summary.puzzlesSolved) ? summary.puzzlesSolved : 0
  const solvedSession =
    sessionBaseline != null ? Math.max(0, solvedTotal - sessionBaseline) : 0

  // School progress drives the learning card now (the old curriculum is gone).
  const completedChapters = schoolCompletedCount(mastery)
  const totalChapters = chapters.length
  const nextStep = nextSchoolStep(chapters, mastery)

  const accuracy = recentAccuracy(games)
  const form = recentForm(games)

  // Brand-new profile: nothing rated, nothing solved, no games, no progress.
  const isFresh =
    solvedTotal === 0 &&
    games.length === 0 &&
    (summary == null || summary.gamesPlayed === 0) &&
    completedChapters === 0

  if (isFresh) {
    return (
      <section className="card home-card insights-card">
        <div className="insights-empty">
          <span className="insights-empty-icon" aria-hidden>
            <Target size={18} />
          </span>
          <div className="insights-empty-body">
            <p className="insights-empty-title">Your insights will appear here</p>
            <p className="small muted">
              Solve a puzzle or play a game to start tracking accuracy, progress, and a
              suggested lesson path.
            </p>
          </div>
          <button className="btn" onClick={() => onNavigate('puzzles')}>
            Solve a puzzle
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="card home-card insights-card" aria-label="Insights">
      <div className="insights-stats">
        <StatTile
          Icon={PuzzleIcon}
          label="Puzzles solved"
          value={solvedTotal.toLocaleString()}
          hint={solvedSession > 0 ? `+${solvedSession} this session` : 'total'}
        />
        <StatTile
          Icon={Target}
          label="Recent accuracy"
          value={accuracy ?? '·'}
          hint={accuracy ? 'last reviewed game' : 'review a game'}
        />
        <StatTile
          Icon={Layers}
          label="School"
          value={totalChapters > 0 ? `${completedChapters}/${totalChapters}` : '·'}
          hint={
            totalChapters > 0
              ? completedChapters > 0
                ? 'chapters complete'
                : form.total > 0
                  ? `${form.wins}/${form.total} recent wins`
                  : 'just getting started'
              : 'with Viktor'
          }
        />
      </div>

      {nextStep && (
        <button
          className="insights-next"
          onClick={() => onNavigate('school')}
          aria-label={`${NEXT_KICKER[nextStep.mode]}: ${nextStep.title}`}
        >
          <span className="insights-next-icon" aria-hidden>
            <GraduationCap size={18} />
          </span>
          <span className="insights-next-body">
            <span className="insights-next-kicker small muted">
              School · {NEXT_KICKER[nextStep.mode]}
            </span>
            <span className="insights-next-title">{nextStep.title}</span>
          </span>
          <ArrowRight size={16} aria-hidden className="insights-next-arrow" />
        </button>
      )}
    </section>
  )
}
