import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import {
  SlidersHorizontal,
  Search,
  Flame,
  Check,
  X,
  ArrowRight,
  RotateCcw,
  Target,
  Clock,
  TrendingDown,
  ChevronLeft,
  Sparkles,
  Play,
  SkipForward,
  Eye
} from 'lucide-react'
import type { ThemeCount } from '@shared/types'
import { Board } from '../../../board/Board'
import { pieceSetClass } from '../../../board/pieceSets'
import { useSettings } from '../../../state/settings'
// Shared 3-stage hint UI from the classic trainer (read-only imports; the
// components live in the puzzles feature root and are reused verbatim).
import { HintLadder } from '../HintLadder'
import { HintArrow } from '../HintArrow'
import {
  useCustomSession,
  humanizeTheme,
  BANDS,
  SET_LENGTHS,
  SOLUTION_LENGTHS,
  POPULARITY_LEVELS,
  type Band,
  type SetLength,
  type SolutionLength,
  type CustomSummary
} from './custom-session'
import './custom.css'

// ============================================================================
// SLICE A: Themed / Custom training.  ★ OWNED BY THE CUSTOM-TRAINING BUILDER ★
//
// Deliberate-practice trainer: configure a fixed set (themes + difficulty band +
// length), drill it on a board with live progress + streak, then read an
// end-of-set summary (accuracy, time, weakest theme). All session/solver logic
// lives in ./custom-session; this file is the three screens (setup / solve /
// summary) and their chrome.
// ============================================================================

export default function CustomMode(): JSX.Element {
  const s = useCustomSession()

  if (s.phase === 'setup') return <SetupScreen session={s} />
  if (s.phase === 'summary' && s.summary) return <SummaryScreen session={s} summary={s.summary} />
  return <SolveScreen session={s} />
}

type Session = ReturnType<typeof useCustomSession>

// ---------------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------------

function SetupScreen({ session }: { session: Session }): JSX.Element {
  const { config, setConfig, start, apiReady } = session
  const [themes, setThemes] = useState<ThemeCount[]>([])
  const [query, setQuery] = useState('')
  const [loadingThemes, setLoadingThemes] = useState(true)

  useEffect(() => {
    let cancelled = false
    const api = window.api?.puzzles
    if (!api) {
      setLoadingThemes(false)
      return
    }
    void api
      .themes()
      .then((r) => {
        if (cancelled) return
        // Most-common themes first: the picker reads as a "popular tactics" menu.
        const sorted = [...(r?.themes ?? [])].sort((a, b) => b.count - a.count)
        setThemes(sorted)
      })
      .catch(() => {
        /* themes optional */
      })
      .finally(() => {
        if (!cancelled) setLoadingThemes(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const selected = config.themes
  const toggleTheme = (key: string): void => {
    setConfig({
      themes: selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]
    })
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return themes
    return themes.filter(
      (t) => t.key.toLowerCase().includes(q) || humanizeTheme(t.key).toLowerCase().includes(q)
    )
  }, [themes, query])

  // Always surface the active selections, even when filtered out by the query.
  const selectedChips = useMemo(
    () => themes.filter((t) => selected.includes(t.key)),
    [themes, selected]
  )

  return (
    <div className="custom-setup">
      <header className="custom-setup-head">
        <div className="custom-setup-titles">
          <h2 className="custom-title">
            <SlidersHorizontal size={20} aria-hidden /> Custom training
          </h2>
          <p className="muted custom-lede">
            Build a focused set, then drill it. Custom sets sharpen specific motifs and
            don&rsquo;t affect your puzzle rating.
          </p>
        </div>
      </header>

      {!apiReady && (
        <div className="panel pad muted small custom-preview-note">
          Preview mode. Connect to the desktop app to load puzzles.
        </div>
      )}

      <div className="custom-setup-grid">
        {/* ---- Themes ---- */}
        <section className="panel custom-card custom-themes-card">
          <div className="panel-head custom-card-head">
            <span className="panel-title">Themes</span>
            <span className="custom-card-hint">
              {selected.length === 0
                ? 'Any (mixed)'
                : `${selected.length} selected`}
            </span>
          </div>

          <div className="custom-search">
            <Search size={15} aria-hidden className="custom-search-icon" />
            <input
              type="text"
              className="custom-search-input"
              placeholder="Search themes…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search themes"
            />
            {query && (
              <button
                type="button"
                className="custom-search-clear"
                onClick={() => setQuery('')}
                aria-label="Clear search"
              >
                <X size={14} aria-hidden />
              </button>
            )}
          </div>

          {selected.length > 0 && (
            <div className="custom-selected-row">
              {selectedChips.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className="custom-tag"
                  onClick={() => toggleTheme(t.key)}
                  title={`Remove ${humanizeTheme(t.key)}`}
                >
                  {humanizeTheme(t.key)}
                  <X size={13} aria-hidden />
                </button>
              ))}
              <button
                type="button"
                className="custom-tag custom-tag-clear"
                onClick={() => setConfig({ themes: [] })}
              >
                Clear all
              </button>
            </div>
          )}

          <div className="custom-theme-grid">
            {loadingThemes
              ? Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="custom-theme-chip is-skeleton" aria-hidden />
                ))
              : filtered.map((t) => {
                  const on = selected.includes(t.key)
                  return (
                    <button
                      key={t.key}
                      type="button"
                      className={`custom-theme-chip${on ? ' is-active' : ''}`}
                      onClick={() => toggleTheme(t.key)}
                      aria-pressed={on}
                      title={humanizeTheme(t.key)}
                    >
                      <span className="custom-theme-check" aria-hidden>
                        {on && <Check size={12} strokeWidth={3} />}
                      </span>
                      <span className="custom-theme-name">{humanizeTheme(t.key)}</span>
                      <span className="custom-theme-count num">{formatCount(t.count)}</span>
                    </button>
                  )
                })}
            {!loadingThemes && filtered.length === 0 && (
              <p className="muted small custom-noresults">No themes match “{query}”.</p>
            )}
          </div>
        </section>

        {/* ---- Difficulty + length + start ---- */}
        <aside className="custom-setup-side">
          <section className="panel custom-card">
            <div className="panel-head custom-card-head">
              <span className="panel-title">Difficulty</span>
            </div>
            <div className="custom-band-list">
              {BANDS.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  className={`custom-band${config.band === b.key ? ' is-active' : ''}`}
                  onClick={() => setConfig({ band: b.key as Band })}
                  aria-pressed={config.band === b.key}
                >
                  <span className="custom-band-label">{b.label}</span>
                  <span className="custom-band-sub num">{b.sub}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel custom-card">
            <div className="panel-head custom-card-head">
              <span className="panel-title">Set length</span>
            </div>
            <div className="custom-length-row">
              {SET_LENGTHS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`custom-length${config.count === n ? ' is-active' : ''}`}
                  onClick={() => setConfig({ count: n as SetLength })}
                  aria-pressed={config.count === n}
                >
                  <span className="custom-length-num num">{n}</span>
                  <span className="custom-length-cap">puzzles</span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel custom-card">
            <div className="panel-head custom-card-head">
              <span className="panel-title">Filters</span>
            </div>
            <div className="custom-filters">
              {/* Solution length */}
              <div className="custom-filter-group">
                <span className="custom-filter-label">Solution length</span>
                <div className="custom-seg">
                  {SOLUTION_LENGTHS.map((l) => (
                    <button
                      key={l.key}
                      type="button"
                      className={`custom-seg-btn${config.length === l.key ? ' is-active' : ''}`}
                      onClick={() => setConfig({ length: l.key as SolutionLength })}
                      aria-pressed={config.length === l.key}
                      title={l.sub}
                    >
                      <span className="custom-seg-main">{l.label}</span>
                      <span className="custom-seg-sub num">{l.sub}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Minimum popularity */}
              <div className="custom-filter-group">
                <span className="custom-filter-label">Minimum popularity</span>
                <div className="custom-seg custom-seg-3">
                  {POPULARITY_LEVELS.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      className={`custom-seg-btn${config.minPopularity === p.value ? ' is-active' : ''}`}
                      onClick={() => setConfig({ minPopularity: p.value })}
                      aria-pressed={config.minPopularity === p.value}
                    >
                      <span className="custom-seg-main">{p.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Exclude solved */}
              <button
                type="button"
                className={`custom-toggle${config.excludeSolved ? ' is-on' : ''}`}
                onClick={() => setConfig({ excludeSolved: !config.excludeSolved })}
                aria-pressed={config.excludeSolved}
              >
                <span className="custom-toggle-text">
                  <span className="custom-toggle-title">Exclude solved</span>
                  <span className="custom-toggle-sub">Only puzzles you haven&rsquo;t solved yet</span>
                </span>
                <span className="custom-toggle-switch" aria-hidden>
                  <span className="custom-toggle-knob" />
                </span>
              </button>
            </div>
          </section>

          <button type="button" className="btn custom-start" onClick={start}>
            <Play size={16} aria-hidden />
            Start set
          </button>
          <p className="custom-start-note muted small">{summarize(config)}</p>
        </aside>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Solve screen
// ---------------------------------------------------------------------------

function SolveScreen({ session: s }: { session: Session }): JSX.Element {
  const { settings } = useSettings()

  const isSolving = s.phase === 'solving'
  const isLoading = s.phase === 'loading'
  const isReview = s.phase === 'review'
  const isEmpty = s.phase === 'empty' || s.phase === 'error'
  const hintsEnabled = settings.hintsEnabled

  // Keyboard: Enter/n advances during the review flash; r retries; h hints
  // (when hints are enabled in Settings).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if ((e.key === 'n' || e.key === 'Enter') && isReview) s.advance()
      else if (e.key === 'r' && (isSolving || isReview)) s.retry()
      else if (e.key === 'h' && isSolving && hintsEnabled) s.bumpHint()
      else if (e.key === 's' && isSolving) s.showSolution()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isReview, isSolving, hintsEnabled, s])

  if (isEmpty) {
    return (
      <div className="custom-empty-wrap">
        <div className="panel pad custom-empty">
          <div className="custom-empty-icon" aria-hidden>
            <Search size={26} />
          </div>
          <h3>{s.phase === 'error' ? 'Could not build a set' : 'No puzzles match'}</h3>
          <p className="muted">
            {s.phase === 'error'
              ? 'Something went wrong fetching your set. Try again.'
              : 'No puzzles fit those themes and difficulty. Loosen the filters and try a new set.'}
          </p>
          <button type="button" className="btn" onClick={s.newSet}>
            <ChevronLeft size={16} aria-hidden /> Back to setup
          </button>
        </div>
      </div>
    )
  }

  const userColor = s.orientation
  // Fill the bar by puzzles *finished*: while a puzzle is in play the bar sits at
  // its start; the review flash completes the segment for the one just finished.
  const finished = s.index + (isReview ? 1 : 0)
  const pct = s.total > 0 ? (finished / s.total) * 100 : 0

  return (
    <div className="custom-solve">
      {/* Top bar: progress + streak + quit */}
      <div className="custom-solvebar">
        <button type="button" className="custom-quit" onClick={s.quit} title="End set">
          <ChevronLeft size={16} aria-hidden />
          <span>End set</span>
        </button>

        <div className="custom-progress">
          <div className="custom-progress-track">
            <div className="custom-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="custom-progress-label num">
            {Math.min(s.index + 1, s.total)} <span className="custom-progress-sep">/</span> {s.total}
          </span>
        </div>

        <div className={`custom-streak${s.streak > 0 ? ' is-active' : ''}`} title={`Streak ${s.streak}`}>
          <Flame size={15} aria-hidden />
          <span className="num">{s.streak}</span>
        </div>
      </div>

      <div className="custom-solve-body">
        <div className="board-area">
          <div className="board-stage">
            <div
              className={`board-wrap board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`}
            >
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
                <HintArrow
                  from={s.hintFrom}
                  to={s.hintTo}
                  stage={s.hintStage}
                  orientation={s.orientation}
                />
              )}
              {isLoading && <div className="puzzle-skeleton" aria-hidden />}
              {isReview && (
                <div
                  className={`custom-flash${s.lastSolved ? ' is-solved' : ' is-failed'}`}
                  aria-hidden
                >
                  <span className="custom-flash-badge">
                    {s.lastSolved ? <Check size={30} strokeWidth={3} /> : <X size={30} strokeWidth={3} />}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="custom-solve-side">
          <SolvePrompt session={s} userColor={userColor} />

          <div className="panel custom-statgrid">
            <div className="custom-stat">
              <span className="custom-stat-label">Solved</span>
              <span className="custom-stat-value num">
                {s.solvedCount}
                <span className="custom-stat-sub">/ {Math.max(s.index + (isReview ? 1 : 0), 0)}</span>
              </span>
            </div>
            <div className="custom-stat">
              <span className="custom-stat-label">Accuracy</span>
              <span className="custom-stat-value num">{liveAccuracy(s, isReview)}%</span>
            </div>
            <div className="custom-stat">
              <span className="custom-stat-label">Best streak</span>
              <span className="custom-stat-value num">{s.bestStreak}</span>
            </div>
          </div>

          {/* Same hint-row chrome as the classic trainer: ladder on top, actions below. */}
          <div className="panel pad hint-row">
            {hintsEnabled && (
              <HintLadder
                stage={s.hintStage}
                disabled={!isSolving}
                onHint={s.bumpHint}
                revealSan={s.revealSan}
              />
            )}
            {/* Give-up actions: available while solving (incl. the keep-trying
                state after a wrong move). Skip records a fail if needed and moves
                on; Show solution reveals the line first. */}
            {isSolving && (
              <div className="hint-actions custom-giveup">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={s.showSolution}
                  disabled={!s.puzzle}
                  title="Reveal the solution (s)"
                >
                  <Eye size={16} aria-hidden /> Show solution
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={s.skip}
                  disabled={!s.puzzle}
                  title="Skip this puzzle"
                >
                  Skip <SkipForward size={16} aria-hidden />
                </button>
              </div>
            )}
            <div className="hint-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={s.retry}
                disabled={!s.puzzle}
                title="Retry this puzzle (r)"
              >
                <RotateCcw size={16} aria-hidden /> Retry
              </button>
              <button
                type="button"
                className="btn"
                onClick={s.advance}
                disabled={!isReview}
                title="Next puzzle (n)"
              >
                Next <ArrowRight size={16} aria-hidden />
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

function SolvePrompt({ session: s, userColor }: { session: Session; userColor: string }): JSX.Element {
  if (s.phase === 'review') {
    if (s.lastSolved) {
      return (
        <div className="panel pad custom-prompt is-solved">
          <span className="custom-prompt-title">
            <Check size={16} aria-hidden /> Solved
          </span>
          <span className="custom-prompt-sub">Nice. Loading the next one…</span>
        </div>
      )
    }
    return (
      <div className="panel pad custom-prompt is-failed">
        <span className="custom-prompt-title">
          <X size={16} aria-hidden /> Not quite
        </span>
        <span className="custom-prompt-sub">
          {s.correctSan ? (
            <>
              The move was <strong className="num">{s.correctSan}</strong>.
            </>
          ) : (
            'Keep going.'
          )}
        </span>
      </div>
    )
  }

  if (s.phase === 'leadin') {
    return (
      <div className="panel pad custom-prompt">
        <span className="custom-prompt-title">Get ready…</span>
        <span className="custom-prompt-sub">Watch the opponent&rsquo;s move.</span>
      </div>
    )
  }

  if (s.phase === 'loading') {
    return (
      <div className="panel pad custom-prompt">
        <span className="custom-prompt-title">Building your set…</span>
        <span className="custom-prompt-sub">Fetching puzzles.</span>
      </div>
    )
  }

  // Retry-on-wrong: the fail is already recorded, but the learner keeps trying
  // until they find it (or Skip / Show solution). Make that explicit.
  if (s.keepTrying) {
    return (
      <div className="panel pad custom-prompt is-keeptrying">
        <span className="custom-prompt-title">
          <RotateCcw size={16} aria-hidden /> Recorded as failed. Keep trying.
        </span>
        <span className="custom-prompt-sub">
          Take your time and find the move for {userColor === 'white' ? 'White' : 'Black'}.
        </span>
      </div>
    )
  }

  return (
    <div className="panel pad custom-prompt is-live">
      <span className="custom-prompt-title">Your move</span>
      <span className="custom-prompt-sub">
        Find the best move for {userColor === 'white' ? 'White' : 'Black'}.
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Summary screen
// ---------------------------------------------------------------------------

function SummaryScreen({
  session: s,
  summary
}: {
  session: Session
  summary: CustomSummary
}): JSX.Element {
  const accPct = Math.round(summary.accuracy * 100)
  const grade = gradeFor(summary.accuracy)
  // SVG ring geometry for the accuracy dial.
  const R = 52
  const C = 2 * Math.PI * R
  const dash = (summary.accuracy * C).toFixed(1)

  return (
    <div className="custom-summary-wrap">
      <div className="panel custom-summary">
        <div className="custom-summary-head">
          <span className={`custom-grade custom-grade-${grade.tone}`}>{grade.label}</span>
          <h2 className="custom-summary-title">Set complete</h2>
          <p className="muted small">
            {summary.solved} of {summary.total} solved
          </p>
        </div>

        <div className="custom-summary-body">
          <div className="custom-ring" role="img" aria-label={`Accuracy ${accPct} percent`}>
            <svg viewBox="0 0 120 120" className="custom-ring-svg">
              <circle className="custom-ring-bg" cx="60" cy="60" r={R} />
              <circle
                className={`custom-ring-fg custom-ring-${grade.tone}`}
                cx="60"
                cy="60"
                r={R}
                strokeDasharray={`${dash} ${C.toFixed(1)}`}
                transform="rotate(-90 60 60)"
              />
            </svg>
            <div className="custom-ring-center">
              <span className="custom-ring-pct num">{accPct}</span>
              <span className="custom-ring-unit">% accuracy</span>
            </div>
          </div>

          <div className="custom-summary-stats">
            <SummaryStat
              icon={<Target size={16} aria-hidden />}
              label="Solved"
              value={`${summary.solved} / ${summary.total}`}
            />
            <SummaryStat
              icon={<Clock size={16} aria-hidden />}
              label="Total time"
              value={formatDuration(summary.totalMs)}
            />
            <SummaryStat
              icon={<Flame size={16} aria-hidden />}
              label="Best streak"
              value={String(summary.bestStreak)}
            />
            <SummaryStat
              icon={<Clock size={16} aria-hidden />}
              label="Avg / puzzle"
              value={summary.total > 0 ? formatDuration(Math.round(summary.totalMs / summary.total)) : '·'}
            />
          </div>
        </div>

        {(summary.weakest || summary.strongest) && (
          <div className="custom-themes-readout">
            {summary.strongest && (
              <div className="custom-readout custom-readout-strong">
                <span className="custom-readout-icon" aria-hidden>
                  <Sparkles size={15} />
                </span>
                <span className="custom-readout-body">
                  <span className="custom-readout-label">Strongest</span>
                  <span className="custom-readout-theme">{humanizeTheme(summary.strongest.theme)}</span>
                </span>
                <span className="custom-readout-score num">
                  {summary.strongest.solved}/{summary.strongest.attempts}
                </span>
              </div>
            )}
            {summary.weakest && (
              <div className="custom-readout custom-readout-weak">
                <span className="custom-readout-icon" aria-hidden>
                  <TrendingDown size={15} />
                </span>
                <span className="custom-readout-body">
                  <span className="custom-readout-label">Work on</span>
                  <span className="custom-readout-theme">{humanizeTheme(summary.weakest.theme)}</span>
                </span>
                <span className="custom-readout-score num">
                  {summary.weakest.solved}/{summary.weakest.attempts}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="custom-summary-actions">
          <button type="button" className="btn ghost" onClick={s.newSet}>
            <SlidersHorizontal size={16} aria-hidden /> New set
          </button>
          <button type="button" className="btn" onClick={s.playAgain}>
            <RotateCcw size={16} aria-hidden /> Play again
          </button>
        </div>
      </div>
    </div>
  )
}

function SummaryStat({
  icon,
  label,
  value
}: {
  icon: JSX.Element
  label: string
  value: string
}): JSX.Element {
  return (
    <div className="custom-sumstat">
      <span className="custom-sumstat-icon" aria-hidden>
        {icon}
      </span>
      <span className="custom-sumstat-label">{label}</span>
      <span className="custom-sumstat-value num">{value}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (m === 0) return `${sec}s`
  return `${m}m ${sec.toString().padStart(2, '0')}s`
}

/** Live running accuracy over puzzles finished so far (review counts the current). */
function liveAccuracy(s: Session, isReview: boolean): number {
  const done = s.index + (isReview ? 1 : 0)
  if (done <= 0) return 0
  return Math.round((s.solvedCount / done) * 100)
}

function gradeFor(acc: number): { label: string; tone: 'good' | 'mid' | 'low' } {
  if (acc >= 0.9) return { label: 'Excellent', tone: 'good' }
  if (acc >= 0.7) return { label: 'Solid', tone: 'good' }
  if (acc >= 0.5) return { label: 'Decent', tone: 'mid' }
  return { label: 'Keep at it', tone: 'low' }
}

function summarize(config: {
  themes: string[]
  band: Band
  count: number
  length: SolutionLength
  minPopularity: number
  excludeSolved: boolean
}): string {
  const b = BANDS.find((x) => x.key === config.band)
  const themeCount = config.themes.length
  const themePart = themeCount === 0 ? 'mixed themes' : `${themeCount} theme${themeCount > 1 ? 's' : ''}`
  const parts = [`${config.count} puzzles`, themePart, `${b?.label ?? ''} difficulty`]
  const len = SOLUTION_LENGTHS.find((l) => l.key === config.length)
  if (config.length !== 'any' && len) parts.push(`${len.label.toLowerCase()} solutions`)
  const pop = POPULARITY_LEVELS.find((p) => p.value === config.minPopularity)
  if (config.minPopularity > -100 && pop) parts.push(pop.label.toLowerCase())
  if (config.excludeSolved) parts.push('unsolved only')
  return parts.join(' · ')
}
