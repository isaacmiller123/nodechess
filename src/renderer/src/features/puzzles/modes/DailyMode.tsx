import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type {
  DailyPuzzle,
  DailyResult,
  DailyStreak,
  PuzzleHistoryRow,
  PuzzleMode,
  PuzzleStats
} from '@shared/types'
import { Board } from '../../../board/Board'
import { pieceSetClass } from '../../../board/pieceSets'
import { useSettings } from '../../../state/settings'
import { HintArrow } from '../HintArrow'
import { HintButton } from '../HintButton'
import { PuzzleTask, type TaskState } from '../PuzzleTask'
import { dateToYmd, formatAgo, formatDuration, formatYmd, formatYmdShort, ymdToDate } from '../format'
import { useDailySolver, type DailyOutcome } from './daily-session'

// ============================================================================
// DAILY. One puzzle a day, the same one for everybody, drawn deterministically
// from a fixed rating window. v1 draws the lobby: today's row, the week, what
// the puzzle is, and the days that got away. The board itself it never drew, so
// it is built from the same parts Train uses.
//
// The rating window is real (daily.repo draws from 1200 to 1800), the streak is
// real, and the missed list only counts days that were never opened: a day you
// tried and failed is not a day you missed.
// ============================================================================

const WEEK_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
/** The window the daily is drawn from (daily.repo DAILY_RATING_LO/HI). */
const DAILY_BAND = '1200 to 1800'
const MISSED_SHOWN = 6
const THEMES_SHOWN = 8
/** One page of solve history. The store is asked for exactly this many, so a
 *  full page is also how we know another one probably exists. */
const HISTORY_PAGE = 10

const HISTORY_FILTERS: { key: PuzzleMode | 'all'; label: string }[] = [
  { key: 'all', label: 'all' },
  { key: 'train', label: 'train' },
  { key: 'custom', label: 'custom' },
  { key: 'rush', label: 'rush' },
  { key: 'daily', label: 'daily' }
]

type Load = 'loading' | 'ready' | 'empty' | 'error'

export default function DailyMode({
  onRecorded
}: {
  /** Today's daily has just been recorded, solved or missed. The page above
   *  owns the readout line about it. */
  onRecorded?: () => void
}): JSX.Element {
  const { settings } = useSettings()
  const [load, setLoad] = useState<Load>('loading')
  const [day, setDay] = useState<DailyPuzzle | null>(null)
  const [result, setResult] = useState<DailyResult | null>(null)
  const [streak, setStreak] = useState<DailyStreak | null>(null)
  const [attempted, setAttempted] = useState<Set<string>>(new Set())
  const [stats, setStats] = useState<PuzzleStats | null>(null)
  const [open, setOpen] = useState(false)
  const [replaying, setReplaying] = useState(false)
  const apiReady = typeof window !== 'undefined' && !!window.api

  const todayKey = useMemo(() => dateToYmd(new Date()), [])

  const loadDay = useCallback((ymd?: string) => {
    const api = window.api?.puzzles
    if (!api) {
      setLoad('empty')
      return
    }
    setLoad('loading')
    void api
      .daily(ymd ? { ymd } : undefined)
      .then((d) => {
        setDay(d)
        setResult(d.result)
        setLoad(d.puzzle ? 'ready' : 'empty')
      })
      .catch(() => setLoad('error'))
  }, [])

  const refreshStreak = useCallback(() => {
    const api = window.api?.puzzles
    if (!api) return
    void api
      .dailyStreak()
      .then((r) => setStreak(r.streak))
      .catch(() => {
        /* the week strip stays blank */
      })
  }, [])

  useEffect(() => {
    loadDay()
    refreshStreak()
    const api = window.api?.puzzles
    if (!api) return
    // Which past days were actually opened. DailyStreak.recent reports a failed
    // day and a day nobody looked at exactly the same way, and those are not the
    // same thing, so the attempts are what tell them apart.
    void api
      .history({ mode: 'daily', limit: 200 })
      .then((r) => {
        const rows = (r?.rows ?? []) as PuzzleHistoryRow[]
        setAttempted(new Set(rows.map((x) => dateToYmd(new Date(x.createdAt)))))
      })
      .catch(() => {
        /* then the missed list stays conservative and shows nothing */
      })
    void api
      .stats()
      .then((r) => setStats(r ?? null))
      .catch(() => {
        /* the solving panel simply stays out */
      })
  }, [loadDay, refreshStreak])

  const puzzle = day?.puzzle ?? null
  const isToday = day?.ymd === todayKey

  const onComplete = useCallback(
    (o: DailyOutcome) => {
      if (!day || !puzzle || replaying) return
      const api = window.api?.puzzles
      const fresh: DailyResult = {
        ymd: day.ymd,
        puzzleId: puzzle.id,
        solved: o.solved,
        firstTry: o.firstTry,
        ms: o.ms
      }
      setResult(fresh)
      if (day.ymd === todayKey) onRecorded?.()
      if (!api) return
      void api
        .recordDaily({
          ymd: day.ymd,
          puzzleId: puzzle.id,
          solved: o.solved,
          firstTry: o.firstTry,
          ms: o.ms
        })
        .then(() => {
          refreshStreak()
          setAttempted((prev) => new Set(prev).add(day.ymd))
        })
        .catch(() => {
          /* the local result already reflects it */
        })
      // A daily is one of the two modes that move the ladder.
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
          /* rating update is best effort */
        })
    },
    [day, puzzle, replaying, refreshStreak, todayKey, onRecorded]
  )

  // The solver only gets the puzzle once the board is open, so nothing animates
  // or sounds behind the lobby.
  const solver = useDailySolver(open && puzzle ? puzzle : null, onComplete)

  const hintsEnabled = settings.hintsEnabled
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (!open) return
      if (e.key === 'Escape') setOpen(false)
      else if (e.key === 'h' && hintsEnabled && solver.phase === 'solving') solver.bumpHint()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, hintsEnabled, solver])

  // The day you first opened a daily. A day before that is not a day you
  // missed, it is a day before you started, and nothing on this screen may
  // mark it against you. Null until you have opened one at all.
  const started = useMemo(() => {
    let first: string | null = null
    for (const ymd of attempted) if (first === null || ymd < first) first = ymd
    return first
  }, [attempted])

  const openDay = (ymd: string): void => {
    setReplaying(false)
    setOpen(true)
    loadDay(ymd)
  }

  const openToday = (): void => {
    // An already-recorded day replays as practice: it is not persisted twice
    // and it cannot turn a miss into a solve.
    setReplaying(result !== null)
    setOpen(true)
  }

  if (open) {
    return (
      <DailyBoard
        s={solver}
        day={day}
        result={result}
        replaying={replaying}
        load={load}
        onBack={() => {
          setOpen(false)
          // Leaving an old daily puts today back in front of you.
          if (day && day.ymd !== todayKey) loadDay()
        }}
        onReplay={() => {
          setReplaying(true)
          solver.retry()
        }}
      />
    )
  }

  return (
    <div className="lesson">
      <div className="lesson-main">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">{isToday ? 'Today' : 'That day'}</h2>
            {day && <span className="sec-count">{formatYmd(day.ymd)}</span>}
          </div>

          {load === 'ready' && puzzle ? (
            <div className="startrow is-first">
              <div>
                <div className="startrow-name">
                  One puzzle <span className="tag">{tagFor(result)}</span>
                </div>
                <div className="startrow-spec">
                  {isToday
                    ? 'The same position everybody gets today. One try, no clock.'
                    : 'The same position everybody got that day. One try, no clock.'}
                </div>
              </div>
              <button className="btn is-primary" type="button" onClick={openToday}>
                Open it
              </button>
            </div>
          ) : (
            <div className="well">
              <div className="empty">
                <p className="empty-line">
                  {load === 'loading'
                    ? 'Getting the day.'
                    : load === 'error'
                      ? 'That day would not load.'
                      : 'No puzzle for that day.'}
                </p>
                <p className="empty-line">
                  {apiReady
                    ? 'The puzzle set is what the daily is drawn from.'
                    : 'The desktop app is where the daily lives.'}
                </p>
              </div>
            </div>
          )}

        </section>

        <ThisWeek streak={streak} todayKey={todayKey} started={started} />

        {stats && stats.totalAttempts > 0 && <YourSolving stats={stats} />}

        <SolveHistory />
      </div>

      <aside className="side">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Today&apos;s puzzle</h2>
          </div>
          <div className="panel">
            <div className="facts">
              {/* v1 prints one number here: the puzzle's own rating. That is a
                  real column on the row, so it is the number. Before the day
                  has loaded there is no rating to print, and the window it will
                  be drawn from is the only true thing left to say. */}
              <div className="fact">
                <span className="lbl">Band</span>
                <span className="fact-value">
                  {puzzle ? (
                    puzzle.rating
                  ) : (
                    <>
                      {DAILY_BAND}
                      <span className="fact-note">the window every daily is drawn from</span>
                    </>
                  )}
                </span>
              </div>
              <div className="fact">
                <span className="lbl">Themes</span>
                <span className="fact-value">
                  {result && puzzle?.themes.length
                    ? puzzle.themes.join(', ')
                    : 'shown after you solve it'}
                </span>
              </div>
              {result && (
                <div className="fact">
                  <span className="lbl">Your try</span>
                  <span className="fact-value">
                    {result.solved ? 'solved' : 'missed'}
                    {result.solved && result.firstTry && (
                      <span className="fact-note">first try, no help</span>
                    )}
                  </span>
                </div>
              )}
              {result !== null && result.ms !== null && result.ms > 0 && (
                <div className="fact">
                  <span className="lbl">Took you</span>
                  <span className="fact-value">{formatDuration(result.ms)}</span>
                </div>
              )}
              <div className="fact">
                <span className="lbl">Solved by</span>
                <span className="fact-value">
                  not counted
                  <span className="fact-note">no network, so no global tally</span>
                </span>
              </div>
            </div>
          </div>
        </section>

        <MissedDays
          streak={streak}
          attempted={attempted}
          started={started}
          todayKey={todayKey}
          onOpen={openDay}
        />
      </aside>
    </div>
  )
}

function tagFor(result: DailyResult | null): string {
  if (!result) return 'not started'
  return result.solved ? 'solved' : 'missed'
}

// ----------------------------------------------------------------- week ----

function ThisWeek({
  streak,
  todayKey,
  started
}: {
  streak: DailyStreak | null
  todayKey: string
  /** The first day this player ever opened a daily, or null for never. */
  started: string | null
}): JSX.Element {
  const solvedDays = useMemo(() => {
    const set = new Set<string>()
    for (const r of streak?.recent ?? []) if (r.solved) set.add(r.ymd)
    return set
  }, [streak])

  // Monday first, as v1 labels it.
  const week = useMemo(() => {
    const today = ymdToDate(todayKey) ?? new Date()
    const monday = new Date(today)
    const shift = (today.getDay() + 6) % 7
    monday.setDate(today.getDate() - shift)
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday)
      d.setDate(monday.getDate() + i)
      return dateToYmd(d)
    })
  }, [todayKey])

  const solvedThisWeek = week.filter((y) => solvedDays.has(y)).length
  const last35 = streak?.recent.filter((r) => r.solved).length ?? 0

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">This week</h2>
        <span className="sec-count">streak {streak?.current ?? 0}</span>
      </div>
      <div className="panel">
        <div className="puz-week">
          {week.map((ymd, i) => {
            const solved = solvedDays.has(ymd)
            const ahead = ymd > todayKey
            // Only a day you were already playing can be a day you missed.
            const missed =
              !solved && !ahead && ymd !== todayKey && started !== null && ymd >= started
            return (
              <div
                className={`puz-day${ymd === todayKey ? ' is-today' : ''}${ahead ? ' is-ahead' : ''}`}
                key={ymd}
              >
                <span
                  className={`puz-day-dot${solved ? ' is-solved' : missed ? ' is-missed' : ''}`}
                  title={solved ? 'Solved' : ahead ? 'Not yet' : 'Not solved'}
                />
                <span className="lbl">{WEEK_LETTERS[i]}</span>
              </div>
            )
          })}
        </div>
        <div className="facts">
          <div className="fact">
            <span className="lbl">Solved this week</span>
            <span className="fact-value">{solvedThisWeek} of 7</span>
          </div>
          <div className="fact">
            <span className="lbl">Best streak</span>
            <span className="fact-value">{streak?.best ?? 0}</span>
          </div>
          <div className="fact">
            <span className="lbl">Last 35 days</span>
            <span className="fact-value">{last35} of 35</span>
          </div>
        </div>
      </div>
    </section>
  )
}

// --------------------------------------------------------------- missed ----

function MissedDays({
  streak,
  attempted,
  started,
  todayKey,
  onOpen
}: {
  streak: DailyStreak | null
  attempted: Set<string>
  /** A day before your first daily is not a day you missed: it is a day before
   *  you started, so the window opens there and never earlier. */
  started: string | null
  todayKey: string
  onOpen: (ymd: string) => void
}): JSX.Element {
  const missed = (streak?.recent ?? [])
    .filter(
      (r) => started !== null && r.ymd > started && r.ymd < todayKey && !r.solved && !attempted.has(r.ymd)
    )
    .slice(0, MISSED_SHOWN)

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Missed days</h2>
        {missed.length > 0 && <span className="sec-count">{missed.length}</span>}
      </div>
      {missed.length === 0 ? (
        <div className="well">
          <div className="empty">
            <p className="empty-line">Nothing missed yet.</p>
            <p className="empty-line">Old dailies stay open, so a skipped day is still there.</p>
          </div>
        </div>
      ) : (
        <div className="panel">
          {missed.map((d) => (
            <button className="go" type="button" key={d.ymd} onClick={() => onOpen(d.ymd)}>
              <span>
                <span className="go-name">{formatYmdShort(d.ymd)}</span>
                <span className="go-sub">never opened</span>
              </span>
              <svg className="icon go-arrow" aria-hidden focusable="false">
                <use href="#i-arrow" />
              </svg>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

// -------------------------------------------------------------- solving ----

function YourSolving({ stats }: { stats: PuzzleStats }): JSX.Element {
  const themes = stats.byTheme.slice(0, THEMES_SHOWN)
  // The day buckets the store keeps, oldest first. Every column is a real day
  // and an empty day draws nothing rather than a floor.
  const days = stats.daily
  const busiest = Math.max(1, ...days.map((d) => d.attempts))
  const windowAttempts = days.reduce((sum, d) => sum + d.attempts, 0)

  return (
    <>
      <section className="sec">
        <div className="sec-head">
          <h2 className="lbl">Your solving</h2>
          <span className="sec-count">every mode</span>
        </div>
        <div className="panel">
          {days.length > 0 && (
            <div className="puz-spark" aria-label={`Attempts over the last ${days.length} days`}>
              {days.map((d) => (
                <span
                  className="puz-sparkcol"
                  key={d.ymd}
                  title={`${d.ymd}: ${d.solved} of ${d.attempts}`}
                >
                  <span
                    className={`puz-sparkbar${d.attempts === 0 ? ' is-idle' : d.solved * 2 >= d.attempts ? ' is-good' : ' is-poor'}`}
                    style={{
                      height: d.attempts === 0 ? '2px' : `${Math.max(12, (d.attempts / busiest) * 100)}%`
                    }}
                  />
                </span>
              ))}
            </div>
          )}
          <div className="facts">
            <div className="fact">
              <span className="lbl">Solved</span>
              <span className="fact-value">
                {stats.totalSolved} of {stats.totalAttempts}
              </span>
            </div>
            <div className="fact">
              <span className="lbl">Accuracy</span>
              <span className="fact-value">{Math.round(stats.accuracy * 100)}%</span>
            </div>
            <div className="fact">
              <span className="lbl">Best run</span>
              <span className="fact-value">{stats.bestStreak}</span>
            </div>
            {days.length > 0 && (
              <div className="fact">
                <span className="lbl">Last {days.length} days</span>
                <span className="fact-value">
                  {windowAttempts}
                  <span className="fact-note">
                    {windowAttempts === 1 ? 'attempt' : 'attempts'}
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>
      </section>

      {themes.length > 0 && (
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">By theme</h2>
            <span className="sec-count">
              {themes.length} of {stats.byTheme.length}
            </span>
          </div>
          <div className="panel">
            <div className="facts">
              {themes.map((t) => (
                <div className="fact" key={t.theme}>
                  <span className="lbl">{t.theme}</span>
                  <span className="fact-value">
                    {Math.round(t.accuracy * 100)}%
                    <span className="fact-note">
                      {t.solved} of {t.attempts}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  )
}

// -------------------------------------------------------------- history ----

/**
 * Every attempt the app kept, newest first, one mode at a time, a page at a
 * time. Train and Daily move the ladder so their rows carry the points they
 * moved it by; Custom and Rush record the attempt but not a rating, and their
 * rows say nothing there rather than a zero.
 */
function SolveHistory(): JSX.Element {
  const [rows, setRows] = useState<PuzzleHistoryRow[]>([])
  const [filter, setFilter] = useState<PuzzleMode | 'all'>('all')
  const [page, setPage] = useState(0)
  const [more, setMore] = useState(false)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  // Only the newest request may write: switching filter mid-flight otherwise
  // lands the old page under the new heading.
  const reqRef = useRef(0)

  useEffect(() => {
    const api = window.api?.puzzles
    if (!api) {
      setState('error')
      return
    }
    const mine = ++reqRef.current
    setState('loading')
    void api
      .history({
        limit: HISTORY_PAGE,
        offset: page * HISTORY_PAGE,
        mode: filter === 'all' ? undefined : filter
      })
      .then((r) => {
        if (reqRef.current !== mine) return
        const got = r?.rows ?? []
        setRows(got)
        setMore(got.length === HISTORY_PAGE)
        setState('ready')
      })
      .catch(() => {
        if (reqRef.current === mine) setState('error')
      })
  }, [page, filter])

  const pick = (key: PuzzleMode | 'all'): void => {
    setFilter(key)
    setPage(0)
  }

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Every attempt</h2>
        {rows.length > 0 && <span className="sec-count">page {page + 1}</span>}
      </div>

      <div className="chips">
        {HISTORY_FILTERS.map((f) => (
          <button
            key={f.key}
            className="chip"
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => pick(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="well">
        <div className="empty-head">
          <span className="lbl">Puzzle</span>
          <span className="lbl">Result</span>
          <span className="lbl">Moved</span>
          <span className="lbl">When</span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            <p className="empty-line">
              {state === 'loading'
                ? 'Reading your attempts.'
                : state === 'error'
                  ? 'Your attempts could not be read.'
                  : page > 0
                    ? 'That is the end of it.'
                    : filter === 'all'
                      ? 'No attempt recorded yet.'
                      : `No ${filter} attempt yet.`}
            </p>
            <p className="empty-line">
              {page > 0 ? 'Newer goes back.' : 'Every mode records here, solved or not.'}
            </p>
          </div>
        ) : (
          rows.map((r) => {
            const moved =
              r.ratingAfter !== null && r.ratingBefore !== null
                ? r.ratingAfter - r.ratingBefore
                : null
            return (
              <div className="puz-runrow" key={r.id}>
                <span>
                  {r.puzzleId}
                  <span className="go-sub">
                    {r.mode}
                    {r.theme ? `, ${r.theme}` : ''}
                    {r.ms ? `, ${formatDuration(r.ms)}` : ''}
                  </span>
                </span>
                <span>{r.solved ? 'solved' : 'missed'}</span>
                <span>{moved === null || moved === 0 ? '' : moved > 0 ? `+${moved}` : moved}</span>
                <span className="puz-runrow-when">{formatAgo(r.createdAt)}</span>
              </div>
            )
          })
        )}
      </div>

      {(page > 0 || more) && (
        <div className="puz-pager">
          <button
            className="btn"
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || state === 'loading'}
          >
            Newer
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => setPage((p) => p + 1)}
            disabled={!more || state === 'loading'}
          >
            Older
          </button>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- board ----

function DailyBoard({
  s,
  day,
  result,
  replaying,
  load,
  onBack,
  onReplay
}: {
  s: ReturnType<typeof useDailySolver>
  day: DailyPuzzle | null
  result: DailyResult | null
  replaying: boolean
  load: Load
  onBack: () => void
  onReplay: () => void
}): JSX.Element {
  const { settings } = useSettings()
  const hintsEnabled = settings.hintsEnabled
  const isSolving = s.phase === 'solving'
  const done = s.phase === 'solved' || s.phase === 'failed'

  const taskState: TaskState =
    load === 'loading'
      ? 'loading'
      : s.phase === 'solved'
        ? 'solved'
        : s.phase === 'failed'
          ? 'failed'
          : 'solving'

  return (
    <div className="lesson">
      <div className="lesson-main">
        <div className="board-area">
          <div className="board-stage">
            <div className={`board-wrap ${pieceSetClass(settings.pieceSet)}`}>
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
            </div>
          </div>

          <div className="boardbar">
            <div className="turn">
              <span className={`turn-chip${s.turn === 'black' ? ' is-black' : ''}`} />
              {s.turn === 'white' ? 'White to move' : 'Black to move'}
            </div>
            {isSolving && hintsEnabled && (
              <HintButton
                stage={s.hintStage}
                disabled={!isSolving}
                onHint={s.bumpHint}
                revealSan={s.revealSan}
              />
            )}
            {done && (
              <button className="btn is-quiet" type="button" onClick={onReplay}>
                Play it again
              </button>
            )}
            <button className="btn is-quiet" type="button" onClick={onBack}>
              Back
            </button>
          </div>
        </div>
      </div>

      <aside className="side">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">This puzzle</h2>
            {day && <span className="sec-count">{formatYmd(day.ymd)}</span>}
          </div>

          <PuzzleTask state={taskState} userColor={s.orientation} correctSan={s.correctSan} />

          <div className="panel">
            <div className="facts">
              <div className="fact">
                <span className="lbl">Band</span>
                <span className="fact-value">{day?.puzzle ? day.puzzle.rating : DAILY_BAND}</span>
              </div>
              <div className="fact">
                <span className="lbl">Themes</span>
                <span className="fact-value">
                  {result && day?.puzzle?.themes.length
                    ? day.puzzle.themes.join(', ')
                    : 'shown after you solve it'}
                </span>
              </div>
              <div className="fact">
                <span className="lbl">This run</span>
                <span className="fact-value">
                  {replaying ? 'practice' : 'counts'}
                  <span className="fact-note">
                    {replaying
                      ? 'the day is already recorded'
                      : s.assisted
                        ? 'help used, so it is not a first try'
                        : 'one try, and it moves your rating'}
                  </span>
                </span>
              </div>
            </div>
          </div>
        </section>
      </aside>
    </div>
  )
}
