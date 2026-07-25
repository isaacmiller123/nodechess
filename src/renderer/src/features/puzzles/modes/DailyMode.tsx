import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import {
  CalendarDays,
  Flame,
  Trophy,
  BarChart3,
  Check,
  X,
  Clock,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  History,
  Sparkles,
  Target,
  PartyPopper
} from 'lucide-react'
import { Board } from '../../../board/Board'
import { pieceSetClass } from '../../../board/pieceSets'
import { isWebBuild } from '../../../platform'
import { useSettings } from '../../../state/settings'
// Shared 3-stage hint UI from the classic trainer (read-only imports). The
// same ladder + board overlay Train and Custom use, for one consistent look.
import { HintLadder } from '../HintLadder'
import { HintArrow } from '../HintArrow'
import type {
  DailyPuzzle,
  DailyResult,
  DailyStreak,
  PuzzleStats,
  PuzzleHistoryRow,
  PuzzleMode
} from '@shared/types'
import { useDailySolver, type DailyOutcome } from './daily-session'
import './daily.css'

// ============================================================================
// SLICE C: Daily puzzle + streaks + stats/history.  ★ OWNED BY THE DAILY BUILDER ★
//
// One mode screen with three sub-tabs:
//   1. Daily:    the SAME puzzle for everyone on a given UTC day; solve it on a
//                board (lead-in -> solve -> auto-reply via useDailySolver), persist
//                the outcome (recordDaily + a mode:'daily' attempt that moves the
//                Glicko ladder), and show a "come back tomorrow" state once done.
//   2. Streak:   current / best consecutive-solved days + a calendar strip.
//   3. Stats:    overall accuracy/solved, per-theme accuracy bars, a daily
//                sparkline, and a paginated solve-history list.
// ============================================================================

type SubTab = 'daily' | 'streak' | 'stats'

const SUBTABS: { key: SubTab; label: string; Icon: typeof CalendarDays }[] = [
  { key: 'daily', label: 'Daily', Icon: CalendarDays },
  { key: 'streak', label: 'Streak', Icon: Flame },
  { key: 'stats', label: 'Stats', Icon: BarChart3 }
]

export default function DailyMode(): JSX.Element {
  const apiReady = typeof window !== 'undefined' && !!window.api
  const [tab, setTab] = useState<SubTab>('daily')

  // The streak is lifted here so solving the daily updates the Streak tab too.
  const [streak, setStreak] = useState<DailyStreak | null>(null)

  const refreshStreak = useCallback(() => {
    const api = window.api?.puzzles
    if (!api) return
    void api
      .dailyStreak()
      .then((r) => setStreak(r.streak))
      .catch(() => {
        /* streak optional */
      })
  }, [])

  useEffect(() => {
    refreshStreak()
  }, [refreshStreak])

  return (
    <div className="daily-mode">
      <nav className="daily-subtabs" aria-label="Daily sections">
        {SUBTABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            className={`daily-subtab${tab === key ? ' is-active' : ''}`}
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            <Icon size={15} aria-hidden />
            <span>{label}</span>
            {key === 'streak' && streak && streak.current > 0 && (
              <span className="daily-subtab-badge">{streak.current}</span>
            )}
          </button>
        ))}
      </nav>

      {!apiReady && (
        <div className="panel pad muted small daily-preview-note">
          Preview mode. Connect to the desktop app to load the daily puzzle, your
          streak, and stats.
        </div>
      )}

      {tab === 'daily' && <DailyTab onSolved={refreshStreak} streak={streak} />}
      {tab === 'streak' && <StreakSection streak={streak} onRefresh={refreshStreak} />}
      {tab === 'stats' && <StatsSection />}
    </div>
  )
}

// ============================================================================
// 1. DAILY TAB: solve the day's puzzle, or "come back tomorrow" if done.
// ============================================================================

type DailyLoad = 'loading' | 'ready' | 'empty' | 'error'

function DailyTab({
  onSolved,
  streak
}: {
  onSolved: () => void
  streak: DailyStreak | null
}): JSX.Element {
  const { settings } = useSettings()
  const [load, setLoad] = useState<DailyLoad>('loading')
  const [daily, setDaily] = useState<DailyPuzzle | null>(null)
  // The locally-recorded result (set on solve/fail or read from the server).
  const [result, setResult] = useState<DailyResult | null>(null)

  // Load today's daily once.
  useEffect(() => {
    let cancelled = false
    const api = window.api?.puzzles
    if (!api) {
      setLoad('empty')
      return
    }
    setLoad('loading')
    void api
      .daily()
      .then((d) => {
        if (cancelled) return
        setDaily(d)
        setResult(d.result)
        setLoad(d.puzzle ? 'ready' : 'empty')
      })
      .catch(() => {
        if (!cancelled) setLoad('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const puzzle = daily?.puzzle ?? null
  const [replaying, setReplaying] = useState(false)
  // Interactive only when today's daily is still open (no result) or the user
  // chose to replay for practice. When a result already exists we still hand the
  // puzzle to the solver so the board shows the real position, but the board is
  // rendered view-only (below), which also means onUserMove can never fire and
  // re-trigger persistence.
  const interactive = !result || replaying

  const onComplete = useCallback(
    (o: DailyOutcome) => {
      const api = window.api?.puzzles
      if (!daily || !puzzle) return
      // While replaying for practice we do not re-persist or re-rate.
      if (replaying) return

      const newResult: DailyResult = {
        ymd: daily.ymd,
        puzzleId: puzzle.id,
        solved: o.solved,
        firstTry: o.firstTry,
        ms: o.ms
      }
      setResult(newResult)

      if (!api) return
      // Persist the daily outcome (drives the streak)…
      void api
        .recordDaily({
          ymd: daily.ymd,
          puzzleId: puzzle.id,
          solved: o.solved,
          firstTry: o.firstTry,
          ms: o.ms
        })
        .then(() => onSolved())
        .catch(() => {
          /* recording failed; UI already reflects the local result */
        })
      // …and log a mode:'daily' attempt so the daily solve moves the Glicko ladder
      // (and feeds the Stats tab). This path DOES update the rating (unlike rush).
      // Tag the primary theme so the daily feeds "Accuracy by theme" too.
      void api
        .attempt({
          puzzleId: puzzle.id,
          puzzleRating: puzzle.rating,
          solved: o.solved,
          ms: o.ms,
          mode: 'daily',
          theme: puzzle.themes[0]
        })
        .catch(() => {
          /* rating update is best-effort */
        })
    },
    [daily, puzzle, replaying, onSolved]
  )

  const solver = useDailySolver(puzzle, onComplete)

  const startReplay = useCallback(() => {
    setReplaying(true)
    // Restart the solver too (same restart the Retry button uses). Otherwise it
    // stays in 'solved'/'failed' and the board remains view-only on the final
    // position. While `replaying` is set, onComplete skips re-persisting.
    solver.retry()
  }, [solver])

  // Keyboard: h bumps the hint ladder (parity with Train/Custom). Guarded on
  // `interactive` so a finished, view-only daily can't be marked assisted by a
  // stray keypress, and on settings.hintsEnabled (hints hidden app-wide).
  const hintsEnabled = settings.hintsEnabled
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'h' && interactive && hintsEnabled && solver.phase === 'solving')
        solver.bumpHint()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [interactive, hintsEnabled, solver])

  // ---- Render branches (all hooks above; safe to early-return below) ----

  if (load === 'loading') {
    return (
      <div className="daily-board-layout">
        <div className="board-area">
          <div className="board-stage">
            <div
              className={`board-wrap board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`}
            >
              <div className="puzzle-skeleton" aria-hidden />
            </div>
          </div>
        </div>
        <aside className="daily-side">
          <div className="panel pad daily-loading muted">Loading today’s puzzle…</div>
        </aside>
      </div>
    )
  }

  if (load === 'empty' || load === 'error' || !daily) {
    return (
      <div className="panel pad daily-empty">
        <CalendarDays size={26} aria-hidden />
        <h3>{load === 'error' ? 'Could not load the daily' : 'No daily puzzle yet'}</h3>
        <p className="muted">
          {/* Web: there's no dataset import. The puzzle DB lives server-side. */}
          {load === 'error'
            ? 'Something went wrong fetching today’s puzzle. Try again shortly.'
            : isWebBuild
              ? 'The daily puzzle is coming online soon.'
              : 'The puzzle library isn’t available yet. Import the datasets to unlock the daily puzzle.'}
        </p>
      </div>
    )
  }

  const showDone = result && !replaying

  return (
    <div className="daily-board-layout">
      <div className="board-area">
        <div className="board-stage">
          <div
            className={`board-wrap board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`}
          >
            <Board
              fen={solver.fen}
              orientation={solver.orientation}
              turnColor={solver.turn}
              dests={solver.dests}
              movableColor={solver.orientation}
              viewOnly={!interactive || solver.phase !== 'solving'}
              lastMove={solver.lastMove}
              check={solver.check}
              showDests={settings.showLegal}
              coordinates={settings.coordinates}
              animation={settings.animation}
              onMove={solver.onUserMove}
              syncNonce={solver.nonce}
            />
            {hintsEnabled && (
              <HintArrow
                from={solver.hintFrom}
                to={solver.hintTo}
                stage={solver.hintStage}
                orientation={solver.orientation}
              />
            )}
          </div>
        </div>
      </div>

      <aside className="daily-side">
        <DailyHeader ymd={daily.ymd} rating={puzzle?.rating ?? null} streak={streak} />

        {showDone ? (
          <DailyDoneCard result={result} streak={streak} onReplay={startReplay} />
        ) : (
          <DailySolvePanel solver={solver} replaying={replaying} />
        )}

        {puzzle?.themes && puzzle.themes.length > 0 && (showDone || solver.phase === 'solved') && (
          <div className="panel pad daily-themes">
            <div className="daily-themes-label">Themes</div>
            <div className="daily-theme-chips">
              {puzzle.themes.slice(0, 8).map((t) => (
                <span key={t} className="daily-theme-chip">
                  {prettyTheme(t)}
                </span>
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}

function DailyHeader({
  ymd,
  rating,
  streak
}: {
  ymd: string
  rating: number | null
  streak: DailyStreak | null
}): JSX.Element {
  return (
    <div className="panel pad daily-header">
      <div className="daily-header-main">
        <div className="daily-header-eyebrow">
          <CalendarDays size={14} aria-hidden /> Daily puzzle
        </div>
        <div className="daily-header-date">{formatYmdLong(ymd)}</div>
      </div>
      <div className="daily-header-meta">
        {rating != null && (
          <span className="daily-pill" title="Puzzle rating">
            <Target size={13} aria-hidden /> {rating}
          </span>
        )}
        {streak && streak.current > 0 && (
          <span className="daily-pill daily-pill-flame" title="Current streak">
            <Flame size={13} aria-hidden /> {streak.current}
          </span>
        )}
      </div>
    </div>
  )
}

function DailySolvePanel({
  solver,
  replaying
}: {
  solver: ReturnType<typeof useDailySolver>
  replaying: boolean
}): JSX.Element {
  const { settings } = useSettings()
  const { phase } = solver
  const solving = phase === 'solving' || phase === 'leadin'

  let title: string
  let subtitle: string
  let tone: 'neutral' | 'solved' | 'failed' = 'neutral'
  if (phase === 'solved') {
    title = 'Solved!'
    subtitle = replaying ? 'Nice practice solve.' : 'You’ve cracked today’s puzzle.'
    tone = 'solved'
  } else if (phase === 'failed') {
    title = 'Not today'
    subtitle = solver.correctSan ? `The move was ${solver.correctSan}.` : 'That wasn’t the move.'
    tone = 'failed'
  } else {
    title = `Find the best move for ${solver.orientation === 'white' ? 'White' : 'Black'}`
    subtitle = replaying ? 'Practice run. Solve it again.' : 'One shot. Make it count.'
  }

  return (
    <div className="daily-solve">
      <div className={`panel pad daily-prompt is-${tone}`}>
        <div className="daily-prompt-title">{title}</div>
        <div className="daily-prompt-sub">{subtitle}</div>
      </div>

      <div className="panel pad daily-controls">
        {/* Shared 3-stage ladder (piece -> destination -> reveal), as in Train.
            Using it clears today's "first try" flag but never the streak.
            Hidden entirely when hints are disabled in Settings. */}
        {settings.hintsEnabled && (
          <HintLadder
            stage={solver.hintStage}
            disabled={phase !== 'solving'}
            onHint={solver.bumpHint}
            revealSan={solver.revealSan}
          />
        )}
        <button
          type="button"
          className="btn ghost"
          onClick={solver.retry}
          disabled={solving}
          title="Replay this puzzle"
        >
          <RotateCcw size={15} aria-hidden /> Retry
        </button>
      </div>
    </div>
  )
}

function DailyDoneCard({
  result,
  streak,
  onReplay
}: {
  result: DailyResult
  streak: DailyStreak | null
  onReplay: () => void
}): JSX.Element {
  return (
    <div className={`panel daily-done is-${result.solved ? 'solved' : 'missed'}`}>
      <div className="daily-done-head">
        <span className="daily-done-icon" aria-hidden>
          {result.solved ? <PartyPopper size={22} /> : <X size={22} />}
        </span>
        <div>
          <div className="daily-done-title">
            {result.solved ? 'Daily complete' : 'Daily attempted'}
          </div>
          <div className="daily-done-sub muted">
            {result.solved
              ? result.firstTry
                ? 'Solved first try. Flawless.'
                : 'Solved. Come back tomorrow for the next one.'
              : 'You’ll get the next one. Come back tomorrow.'}
          </div>
        </div>
      </div>

      <div className="daily-done-stats">
        <div className="daily-done-stat">
          <span className="daily-done-stat-label">Result</span>
          <span className={`daily-done-stat-val ${result.solved ? 'is-good' : 'is-bad'}`}>
            {result.solved ? 'Solved' : 'Missed'}
          </span>
        </div>
        <div className="daily-done-stat">
          <span className="daily-done-stat-label">First try</span>
          <span className="daily-done-stat-val">{result.firstTry ? 'Yes' : 'No'}</span>
        </div>
        <div className="daily-done-stat">
          <span className="daily-done-stat-label">Time</span>
          <span className="daily-done-stat-val">{formatMs(result.ms)}</span>
        </div>
        <div className="daily-done-stat">
          <span className="daily-done-stat-label">Streak</span>
          <span className="daily-done-stat-val daily-done-streak">
            <Flame size={13} aria-hidden /> {streak?.current ?? 0}
          </span>
        </div>
      </div>

      <button type="button" className="btn ghost daily-replay" onClick={onReplay}>
        <RotateCcw size={15} aria-hidden /> Replay for practice
      </button>
    </div>
  )
}

// ============================================================================
// 2. STREAK SECTION: current / best + calendar strip.
// ============================================================================

function StreakSection({
  streak,
  onRefresh
}: {
  streak: DailyStreak | null
  onRefresh: () => void
}): JSX.Element {
  useEffect(() => {
    onRefresh()
  }, [onRefresh])

  if (!streak) {
    return <div className="panel pad muted daily-loading">Loading your streak…</div>
  }

  const total = streak.recent.filter((d) => d.solved).length

  return (
    <div className="daily-streak-view">
      <div className="daily-stat-cards">
        <StatCard
          icon={<Flame size={18} aria-hidden />}
          tone="flame"
          label="Current streak"
          value={String(streak.current)}
          unit={streak.current === 1 ? 'day' : 'days'}
        />
        <StatCard
          icon={<Trophy size={18} aria-hidden />}
          tone="gold"
          label="Best streak"
          value={String(streak.best)}
          unit={streak.best === 1 ? 'day' : 'days'}
        />
        <StatCard
          icon={streak.todaySolved ? <Check size={18} aria-hidden /> : <Clock size={18} aria-hidden />}
          tone={streak.todaySolved ? 'good' : 'neutral'}
          label="Today"
          value={streak.todaySolved ? 'Done' : 'Open'}
          unit={streak.todaySolved ? '' : 'go solve it'}
        />
      </div>

      <div className="panel daily-calendar-panel">
        <div className="panel-head">
          <span className="panel-title">Last 5 weeks</span>
          <span className="muted small">{total} solved</span>
        </div>
        <div className="daily-calendar pad">
          <DailyCalendar recent={streak.recent} />
        </div>
        <div className="daily-calendar-legend pad">
          <span className="daily-legend-item">
            <span className="daily-cell daily-cell-solved daily-legend-swatch" /> Solved
          </span>
          <span className="daily-legend-item">
            <span className="daily-cell daily-cell-missed daily-legend-swatch" /> Missed / skipped
          </span>
          <span className="daily-legend-item">
            <span className="daily-cell daily-cell-today daily-legend-swatch" /> Today
          </span>
        </div>
      </div>
    </div>
  )
}

function DailyCalendar({ recent }: { recent: { ymd: string; solved: boolean }[] }): JSX.Element {
  // `recent` is most-recent first; show oldest -> newest left to right.
  const days = useMemo(() => [...recent].reverse(), [recent])
  const todayKey = days.length ? days[days.length - 1].ymd : ''

  return (
    <div className="daily-calendar-grid">
      {days.map((d) => {
        const isToday = d.ymd === todayKey
        const cls = d.solved
          ? 'daily-cell-solved'
          : isToday
            ? 'daily-cell-today'
            : 'daily-cell-missed'
        return (
          <div
            key={d.ymd}
            className={`daily-cell ${cls}${isToday ? ' is-today-ring' : ''}`}
            title={`${formatYmdLong(d.ymd)}: ${d.solved ? 'solved' : isToday ? 'not yet' : 'missed'}`}
          >
            {d.solved && <Check size={11} aria-hidden />}
          </div>
        )
      })}
    </div>
  )
}

// ============================================================================
// 3. STATS SECTION: totals, per-theme bars, sparkline, paginated history.
// ============================================================================

const HISTORY_PAGE = 12

function StatsSection(): JSX.Element {
  const [stats, setStats] = useState<PuzzleStats | null>(null)
  const [statsLoad, setStatsLoad] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    const api = window.api?.puzzles
    if (!api) {
      setStatsLoad('error')
      return
    }
    void api
      .stats()
      .then((s) => {
        if (cancelled) return
        setStats(s)
        setStatsLoad('ready')
      })
      .catch(() => {
        if (!cancelled) setStatsLoad('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (statsLoad === 'loading') {
    return <div className="panel pad muted daily-loading">Crunching your numbers…</div>
  }
  if (statsLoad === 'error' || !stats) {
    return (
      <div className="panel pad daily-empty">
        <BarChart3 size={26} aria-hidden />
        <h3>No stats yet</h3>
        <p className="muted">Solve some puzzles and your accuracy and history will show up here.</p>
      </div>
    )
  }

  const hasData = stats.totalAttempts > 0

  return (
    <div className="daily-stats-view">
      <div className="daily-stat-cards">
        <StatCard
          icon={<Target size={18} aria-hidden />}
          tone="accent"
          label="Accuracy"
          value={hasData ? `${Math.round(stats.accuracy * 100)}%` : '·'}
          unit={hasData ? `${stats.totalSolved}/${stats.totalAttempts}` : 'no attempts'}
        />
        <StatCard
          icon={<Check size={18} aria-hidden />}
          tone="good"
          label="Solved"
          value={String(stats.totalSolved)}
          unit="puzzles"
        />
        <StatCard
          icon={<Sparkles size={18} aria-hidden />}
          tone="flame"
          label="Best run"
          value={String(stats.bestStreak)}
          unit="in a row"
        />
      </div>

      <div className="panel daily-spark-panel">
        <div className="panel-head">
          <span className="panel-title">Activity · 30 days</span>
          <span className="muted small">{spark30Total(stats)} attempts</span>
        </div>
        <div className="pad">
          <DailySparkline daily={stats.daily} />
        </div>
      </div>

      <div className="panel daily-theme-panel">
        <div className="panel-head">
          <span className="panel-title">Accuracy by theme</span>
          <span className="muted small">{stats.byTheme.length} themes</span>
        </div>
        {stats.byTheme.length === 0 ? (
          <div className="pad muted small">
            No themed attempts yet. Custom training and the daily tag their themes here.
          </div>
        ) : (
          <div className="daily-theme-bars pad">
            {stats.byTheme.map((t) => (
              <div key={t.theme} className="daily-theme-row">
                <div className="daily-theme-row-head">
                  <span className="daily-theme-name" title={prettyTheme(t.theme)}>
                    {prettyTheme(t.theme)}
                  </span>
                  <span className="daily-theme-acc">{Math.round(t.accuracy * 100)}%</span>
                </div>
                <div className="daily-bar-track">
                  <div
                    className={`daily-bar-fill ${accClass(t.accuracy)}`}
                    style={{ width: `${Math.max(2, Math.round(t.accuracy * 100))}%` }}
                  />
                </div>
                <div className="daily-theme-row-foot muted">
                  {t.solved}/{t.attempts}
                  {t.avgMs != null && <span> · {formatMs(t.avgMs)} avg</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <HistoryPanel />

      {!hasData && (
        <p className="muted small daily-stats-hint">
          Stats span every mode: Train, Custom, Rush, and Daily.
        </p>
      )}
    </div>
  )
}

const HISTORY_MODES: { key: PuzzleMode | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'train', label: 'Train' },
  { key: 'custom', label: 'Custom' },
  { key: 'rush', label: 'Rush' },
  { key: 'daily', label: 'Daily' }
]

function HistoryPanel(): JSX.Element {
  const [rows, setRows] = useState<PuzzleHistoryRow[]>([])
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState<PuzzleMode | 'all'>('all')
  const [loading, setLoading] = useState(true)
  // Whether another page likely exists (we fetched a full page).
  const [hasMore, setHasMore] = useState(false)
  const reqRef = useRef(0)

  useEffect(() => {
    const api = window.api?.puzzles
    if (!api) {
      setLoading(false)
      return
    }
    const myReq = ++reqRef.current
    setLoading(true)
    void api
      .history({
        limit: HISTORY_PAGE,
        offset: page * HISTORY_PAGE,
        mode: filter === 'all' ? undefined : filter
      })
      .then((r) => {
        if (reqRef.current !== myReq) return
        setRows(r.rows)
        setHasMore(r.rows.length === HISTORY_PAGE)
        setLoading(false)
      })
      .catch(() => {
        if (reqRef.current === myReq) setLoading(false)
      })
  }, [page, filter])

  const changeFilter = (f: PuzzleMode | 'all'): void => {
    setFilter(f)
    setPage(0)
  }

  return (
    <div className="panel daily-history-panel">
      <div className="panel-head daily-history-head">
        <span className="panel-title">
          <History size={14} aria-hidden /> History
        </span>
        <div className="daily-history-filters">
          {HISTORY_MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`daily-filter${filter === m.key ? ' is-active' : ''}`}
              aria-pressed={filter === m.key}
              onClick={() => changeFilter(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="pad muted small">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="pad muted small">
          {page === 0 ? 'No solves recorded yet.' : 'No more history.'}
        </div>
      ) : (
        <ul className="daily-history-list">
          {rows.map((r) => (
            <li key={r.id} className="daily-history-row">
              <span
                className={`daily-history-dot ${r.solved ? 'is-solved' : 'is-missed'}`}
                aria-hidden
              >
                {r.solved ? <Check size={13} /> : <X size={13} />}
              </span>
              <span className="daily-history-main">
                <span className="daily-history-puzzle">#{r.puzzleId}</span>
                <span className="daily-history-meta muted">
                  <span className={`daily-mode-tag mode-${r.mode}`}>{r.mode}</span>
                  {r.theme && <span className="daily-history-theme">{prettyTheme(r.theme)}</span>}
                </span>
              </span>
              <span className="daily-history-right">
                {r.ratingAfter != null && r.ratingBefore != null && r.ratingAfter !== r.ratingBefore && (
                  <span
                    className={`daily-history-delta ${
                      r.ratingAfter - r.ratingBefore >= 0 ? 'is-up' : 'is-down'
                    }`}
                  >
                    {r.ratingAfter - r.ratingBefore >= 0 ? '+' : ''}
                    {r.ratingAfter - r.ratingBefore}
                  </span>
                )}
                <span className="daily-history-time muted">{formatMs(r.ms)}</span>
                <span className="daily-history-when muted">{formatRelative(r.createdAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="daily-history-pager pad">
        <button
          type="button"
          className="btn ghost daily-pager-btn"
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0 || loading}
        >
          <ChevronLeft size={15} aria-hidden /> Newer
        </button>
        <span className="muted small daily-pager-page">Page {page + 1}</span>
        <button
          type="button"
          className="btn ghost daily-pager-btn"
          onClick={() => setPage((p) => p + 1)}
          disabled={!hasMore || loading}
        >
          Older <ChevronRight size={15} aria-hidden />
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// Small shared bits.
// ============================================================================

function StatCard({
  icon,
  label,
  value,
  unit,
  tone
}: {
  icon: JSX.Element
  label: string
  value: string
  unit?: string
  tone: 'accent' | 'good' | 'flame' | 'gold' | 'neutral'
}): JSX.Element {
  return (
    <div className={`daily-stat-card tone-${tone}`}>
      <span className="daily-stat-icon" aria-hidden>
        {icon}
      </span>
      <span className="daily-stat-label">{label}</span>
      <span className="daily-stat-value">{value}</span>
      {unit && <span className="daily-stat-unit muted">{unit}</span>}
    </div>
  )
}

function DailySparkline({
  daily
}: {
  daily: { ymd: string; attempts: number; solved: number }[]
}): JSX.Element {
  const max = Math.max(1, ...daily.map((d) => d.attempts))
  const anyData = daily.some((d) => d.attempts > 0)
  return (
    <div className="daily-spark">
      <div className="daily-spark-bars">
        {daily.map((d) => {
          const h = d.attempts > 0 ? Math.max(6, (d.attempts / max) * 100) : 0
          const acc = d.attempts > 0 ? d.solved / d.attempts : 0
          return (
            <div
              key={d.ymd}
              className="daily-spark-col"
              title={`${formatYmdLong(d.ymd)}: ${d.solved}/${d.attempts}`}
            >
              {d.attempts > 0 ? (
                <div
                  className={`daily-spark-bar ${accClass(acc)}`}
                  style={{ height: `${h}%` }}
                />
              ) : (
                <div className="daily-spark-bar is-empty" />
              )}
            </div>
          )
        })}
      </div>
      {!anyData && <div className="daily-spark-empty muted small">No activity in the last 30 days.</div>}
    </div>
  )
}

// ---- formatting helpers ----

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** 'YYYY-MM-DD' (UTC) -> e.g. "Tue, Jun 30 2026". Parsed as UTC to match the key. */
function formatYmdLong(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ymd
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`
}

function formatMs(ms: number | null): string {
  if (ms == null || ms <= 0) return '·'
  const totalSec = ms / 1000
  if (totalSec < 60) return `${totalSec.toFixed(totalSec < 10 ? 1 : 0)}s`
  const m = Math.floor(totalSec / 60)
  const s = Math.round(totalSec % 60)
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  const wk = Math.floor(day / 7)
  if (wk < 5) return `${wk}w ago`
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** Lichess theme keys are camelCase (e.g. "hangingPiece"); make them readable. */
function prettyTheme(key: string): string {
  if (!key) return 'Other'
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function accClass(acc: number): string {
  if (acc >= 0.75) return 'is-high'
  if (acc >= 0.5) return 'is-mid'
  return 'is-low'
}

function spark30Total(stats: PuzzleStats): number {
  return stats.daily.reduce((sum, d) => sum + d.attempts, 0)
}
