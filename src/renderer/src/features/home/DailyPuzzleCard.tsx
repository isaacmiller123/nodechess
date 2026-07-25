import { useEffect, useMemo, useState, type JSX } from 'react'
import { Sparkles } from 'lucide-react'
import type { Role } from 'chessops/types'
import type { DailyResult, Puzzle } from '../../../../shared/types'
import { Board } from '../../board/Board'
import { applyMove, turnColor, type Color } from '../../chess/chess'
import { useSettings } from '../../state/settings'
import type { HomeNavTarget } from './HomeView'
import { humanizeTheme } from './format'
// PuzzlesView persists its active mode tab under MODE_KEY and reads it on
// mount: writing 'daily' before navigating deep-links this card into the
// Daily tab without a new nav target.
import { MODE_KEY as PUZZLES_MODE_KEY } from '../puzzles/modeKey'

export interface DailyPuzzleCardProps {
  onNavigate: (view: HomeNavTarget) => void
}

interface DailyState {
  puzzle: Puzzle | null
  /** Today's recorded outcome (null until attempted; always null for fallback). */
  result: DailyResult | null
  /** False when no daily was available and we fell back to a generic puzzle. */
  isDaily: boolean
  loading: boolean
}

const PROMO_ROLES: Record<string, Role> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }

export default function DailyPuzzleCard({ onNavigate }: DailyPuzzleCardProps): JSX.Element {
  const { settings } = useSettings()
  const [state, setState] = useState<DailyState>({
    puzzle: null,
    result: null,
    isDaily: true,
    loading: true
  })

  useEffect(() => {
    let cancelled = false
    const api = window.api
    if (!api) {
      setState({ puzzle: null, result: null, isDaily: true, loading: false })
      return
    }
    void (async () => {
      try {
        // The real deterministic daily (same puzzle all day) + today's result.
        const res = await api.puzzles.daily()
        if (res.puzzle) {
          if (!cancelled) {
            setState({ puzzle: res.puzzle, result: res.result, isDaily: true, loading: false })
          }
          return
        }
        // Lean install: no daily available; fall back to any puzzle as a teaser.
        const fallback = await api.puzzles.next({})
        if (!cancelled) {
          setState({ puzzle: fallback.puzzle ?? null, result: null, isDaily: false, loading: false })
        }
      } catch {
        if (!cancelled) setState({ puzzle: null, result: null, isDaily: true, loading: false })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const { puzzle, result, isDaily, loading } = state

  // Preview the position the SOLVER faces: moves[0] is the opponent's lead-in
  // (auto-played by the solve UI), so apply it and orient to the side to move
  // after it. If anything is malformed, render text-only (no board preview).
  const preview = useMemo<{ fen: string; orientation: Color } | null>(() => {
    if (!puzzle) return null
    try {
      const m0 = puzzle.moves[0]
      if (m0 && m0.length >= 4) {
        const applied = applyMove(
          puzzle.fen,
          m0.slice(0, 2),
          m0.slice(2, 4),
          m0.length > 4 ? PROMO_ROLES[m0[4]] : undefined
        )
        if (applied) return { fen: applied.fen, orientation: turnColor(applied.fen) }
      }
      // No (or corrupt) lead-in: show the raw position, oriented to the
      // solver: the side NOT to move (the mover plays the auto lead-in).
      return {
        fen: puzzle.fen,
        orientation: turnColor(puzzle.fen) === 'white' ? 'black' : 'white'
      }
    } catch {
      return null
    }
  }, [puzzle])

  const openPuzzles = (deepLinkDaily: boolean): void => {
    if (deepLinkDaily) {
      try {
        localStorage.setItem(PUZZLES_MODE_KEY, 'daily')
      } catch {
        /* storage may be unavailable */
      }
    }
    onNavigate('puzzles')
  }

  const theme = puzzle && puzzle.themes.length > 0 ? humanizeTheme(puzzle.themes[0]) : ''

  const boardPreview = preview && (
    <div className={`daily-board board-${settings.boardTheme}`}>
      <Board
        fen={preview.fen}
        orientation={preview.orientation}
        turnColor={preview.orientation}
        dests={new Map()}
        viewOnly
        coordinates={false}
        showDests={false}
        animation={false}
      />
    </div>
  )

  return (
    <section className="card home-card daily-card">
      <div className="card-title-row">
        <h3 className="card-title">
          <Sparkles size={14} aria-hidden /> Daily puzzle
        </h3>
      </div>

      {loading ? (
        <p className="muted small">Loading…</p>
      ) : !puzzle ? (
        <div className="daily-body">
          <p className="muted small">No puzzle available.</p>
          <button className="btn ghost" onClick={() => onNavigate('puzzles')}>
            Open puzzles
          </button>
        </div>
      ) : result ? (
        // Today's daily already attempted: don't advertise it as unsolved.
        <div className="daily-body">
          {boardPreview}
          <div className="daily-meta">
            <div className="daily-rating">
              <span className="daily-rating-num">{result.solved ? 'Solved' : 'Attempted'}</span>
              {result.solved && result.firstTry && <span className="muted small">first try</span>}
            </div>
            <span className="daily-theme small muted">Come back tomorrow for the next one.</span>
            <button className="btn ghost daily-solve" onClick={() => openPuzzles(true)}>
              Review
            </button>
          </div>
        </div>
      ) : (
        <div className="daily-body">
          {boardPreview}
          <div className="daily-meta">
            <div className="daily-rating">
              <span className="daily-rating-num">{Math.round(puzzle.rating)}</span>
              <span className="muted small">rating</span>
            </div>
            {/* The daily is one-shot. Its theme would spoil the solution, so the
                theme chip only shows on the generic fallback teaser. */}
            {!isDaily && theme && <span className="daily-theme small muted">{theme}</span>}
            <button className="btn daily-solve" onClick={() => openPuzzles(isDaily)}>
              Solve
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
