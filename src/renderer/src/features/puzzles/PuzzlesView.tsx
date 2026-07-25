import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import {
  RotateCcw,
  ChevronRight,
  GraduationCap,
  ChevronDown,
  Dumbbell,
  SlidersHorizontal,
  Timer,
  CalendarDays,
  Eye,
  SkipForward
} from 'lucide-react'
import { Board } from '../../board/Board'
import { pieceSetClass } from '../../board/pieceSets'
import { useSettings } from '../../state/settings'
import { usePuzzleSession } from './usePuzzleSession'
import { HintArrow } from './HintArrow'
import { PuzzlePrompt } from './PuzzlePrompt'
import { RatingPanel } from './RatingPanel'
import { StreakBadge } from './StreakBadge'
import { HintLadder } from './HintLadder'
import { ThemePicker } from './ThemePicker'
import { CoachHint } from '../../components/CoachHint'
import CustomMode from './modes/CustomMode'
import RushMode from './modes/RushMode'
import DailyMode from './modes/DailyMode'
import './puzzles.css'

// Puzzle modes + the persisted-tab MODE_KEY live in ./modeKey so Home cards can
// deep-link a tab without statically importing this lazily-loaded view.
import { MODE_KEY, type PuzzleModeKey } from './modeKey'

export type { PuzzleModeKey }

const MODES: { key: PuzzleModeKey; label: string; Icon: typeof Dumbbell }[] = [
  { key: 'train', label: 'Train', Icon: Dumbbell },
  { key: 'custom', label: 'Custom', Icon: SlidersHorizontal },
  { key: 'rush', label: 'Rush', Icon: Timer },
  { key: 'daily', label: 'Daily', Icon: CalendarDays }
]

function loadMode(): PuzzleModeKey {
  try {
    const raw = localStorage.getItem(MODE_KEY)
    if (raw === 'train' || raw === 'custom' || raw === 'rush' || raw === 'daily') return raw
  } catch {
    /* storage may be unavailable */
  }
  return 'train'
}

/**
 * Puzzles trainer shell: a top mode switcher over four puzzle modes. Default
 * export so it can be routed in App.tsx. Takes no props.
 */
export default function PuzzlesView(): JSX.Element {
  const [mode, setMode] = useState<PuzzleModeKey>(loadMode)

  const changeMode = (m: PuzzleModeKey): void => {
    setMode(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="puzzles-shell">
      <nav className="puzzle-modebar" aria-label="Puzzle modes">
        {MODES.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            className={`puzzle-modetab${mode === key ? ' is-active' : ''}`}
            aria-pressed={mode === key}
            onClick={() => changeMode(key)}
          >
            <Icon size={16} aria-hidden />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {mode === 'train' && <TrainMode />}
      {mode === 'custom' && <CustomMode />}
      {mode === 'rush' && <RushMode />}
      {mode === 'daily' && <DailyMode />}
    </div>
  )
}

/**
 * Classic adaptive trainer (the original PuzzlesView body). Board + side panel
 * over the bundled puzzle DB, with an adaptive rating walk, hint ladder, theme
 * filter, and on-demand coach. Lives here (scaffold-owned) so the new mode
 * builders never touch it.
 */
function TrainMode(): JSX.Element {
  const { settings } = useSettings()
  const s = usePuzzleSession()
  const [coachOpen, setCoachOpen] = useState(false)

  const isSolving = s.phase === 'solving'
  const isDone = s.phase === 'solved' || s.phase === 'failed'
  const isLoading = s.phase === 'loading'
  const isEmpty = s.phase === 'empty' || s.phase === 'error'
  const hintsEnabled = settings.hintsEnabled

  // Keyboard shortcuts: n = next, r = retry, h = hint (when hints are enabled),
  // s = show solution (records the fail, retry-on-wrong give-up path).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'n') {
        if (isDone || isEmpty) s.next()
      } else if (e.key === 'r') {
        if (s.puzzle) s.retry()
      } else if (e.key === 'h') {
        if (isSolving && hintsEnabled) s.bumpHint()
      } else if (e.key === 's') {
        if (isSolving) s.showSolution()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDone, isEmpty, isSolving, hintsEnabled, s])

  return (
    <div className="puzzles-view">
      <div className="board-area">
        <div className="board-stage">
          <div className={`board-wrap board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`}>
            <Board
              fen={s.fen}
              orientation={s.orientation}
              turnColor={s.turn}
              dests={s.dests}
              movableColor={s.orientation}
              viewOnly={!isSolving}
              lastMove={s.lastMove}
              check={s.check}
              showDests={settings.showLegal}
              coordinates={settings.coordinates}
              animation={settings.animation}
              onMove={s.onUserMove}
              syncNonce={s.nonce}
            />
            {hintsEnabled && (
              <HintArrow from={s.hintFrom} to={s.hintTo} stage={s.hintStage} orientation={s.orientation} />
            )}
            {isLoading && <div className="puzzle-skeleton" aria-hidden />}
          </div>
        </div>

        <div className="board-controls">
          <button className="icon-btn" onClick={s.retry} disabled={!s.puzzle} title="Retry (r)">
            <RotateCcw size={18} />
          </button>
          {/* Mid-solve, advancing = skipping, which records the fail (honest
              accounting: same rule as the Skip button in the sidebar). */}
          <button
            className="icon-btn"
            onClick={isSolving ? s.skip : s.next}
            title={isSolving ? 'Skip. Counts as failed.' : 'Next puzzle (n)'}
          >
            {isSolving ? <SkipForward size={18} /> : <ChevronRight size={18} />}
          </button>
        </div>
      </div>

      <aside className="analysis-sidebar">
        <PuzzlePrompt
          phase={s.phase}
          userColor={s.orientation}
          correctSan={s.correctSan}
          keepTrying={s.keepTrying}
          lateSolve={s.lateSolve}
        />

        {!s.apiReady && (
          <div className="panel pad muted small">
            Preview mode. Connect to the desktop app to load puzzles and ratings.
          </div>
        )}

        <div className="puzzle-meta">
          <RatingPanel
            rating={s.puzzleRating}
            rd={s.puzzleRd}
            delta={s.delta}
            ratingAfter={s.ratingAfter}
            animateKey={s.attemptCount}
          />
          <StreakBadge streak={s.streak} best={s.best} />
        </div>

        <div className="panel pad hint-row">
          {hintsEnabled && (
            <HintLadder
              stage={s.hintStage}
              disabled={!isSolving}
              onHint={s.bumpHint}
              revealSan={s.revealSan}
            />
          )}
          {/* Give-up actions (retry-on-wrong): available while solving. Incl.
              the keep-trying state after a wrong move. Both record the fail
              once if it isn't already on the books. */}
          {isSolving && (
            <div className="hint-actions">
              <button
                className="btn ghost"
                onClick={s.showSolution}
                disabled={!s.puzzle}
                title="Reveal the solution (s). Counts as failed."
              >
                <Eye size={16} aria-hidden /> Show solution
              </button>
              <button
                className="btn ghost"
                onClick={s.skip}
                disabled={!s.puzzle}
                title="Skip this puzzle. Counts as failed."
              >
                Skip <SkipForward size={16} aria-hidden />
              </button>
            </div>
          )}
          <div className="hint-actions">
            <button className="btn ghost" onClick={s.retry} disabled={!s.puzzle}>
              Retry
            </button>
            {/* Mid-solve the honest advance is Skip (above); Next unlocks once
                the puzzle is finished. */}
            <button className="btn" onClick={s.next} disabled={isSolving}>
              Next
            </button>
          </div>
        </div>

        {s.puzzle && (
          <div className="panel coachhint-panel">
            <button
              type="button"
              className="panel-head coachhint-toggle"
              onClick={() => setCoachOpen((o) => !o)}
              aria-expanded={coachOpen}
            >
              <span className="panel-title">
                <GraduationCap size={15} /> Coach
              </span>
              <ChevronDown
                size={16}
                className={`coachhint-chevron${coachOpen ? ' is-open' : ''}`}
              />
            </button>
            {coachOpen && (
              <div className="coachhint-panel-body">
                <p className="muted small coachhint-lede">
                  Conceptual guidance for this position. No solution spoilers.
                </p>
                <CoachHint fen={s.fen} />
              </div>
            )}
          </div>
        )}

        {isEmpty && (
          <div className="panel pad puzzle-empty">
            <div className="muted">
              {s.phase === 'error'
                ? 'Could not load a puzzle.'
                : s.theme
                  ? 'No puzzles match this theme.'
                  : 'No puzzles available.'}
            </div>
            {s.theme && (
              <button className="btn ghost" onClick={() => s.setTheme(null)}>
                Clear filter
              </button>
            )}
          </div>
        )}

        <ThemePicker themes={s.themes} active={s.theme} onPick={s.setTheme} />
      </aside>
    </div>
  )
}
