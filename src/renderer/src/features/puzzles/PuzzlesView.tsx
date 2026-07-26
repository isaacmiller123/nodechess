import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ProgressSummary, PuzzleHistoryRow, RatingValue, ThemeCount } from '@shared/types'
import { Board } from '../../board/Board'
import { pieceSetClass } from '../../board/pieceSets'
import { useSettings } from '../../state/settings'
import { useReadoutSlot } from '../../components/Layout'
import { usePuzzleSession } from './usePuzzleSession'
import { HintArrow } from './HintArrow'
import { HintButton } from './HintButton'
import { PuzzleTask, type TaskState } from './PuzzleTask'
import { formatFull, ordinal, startOfToday } from './format'
import CustomMode from './modes/CustomMode'
import RushMode from './modes/RushMode'
import DailyMode from './modes/DailyMode'
import './puzzles.css'

// Puzzle modes + the persisted-tab MODE_KEY live in ./modeKey so Home cards can
// deep-link a tab without statically importing this lazily-loaded view.
import { MODE_KEY, type PuzzleModeKey } from './modeKey'

export type { PuzzleModeKey }

const MODES: { key: PuzzleModeKey; label: string }[] = [
  { key: 'train', label: 'Train' },
  { key: 'custom', label: 'Custom' },
  { key: 'rush', label: 'Rush' },
  { key: 'daily', label: 'Daily' }
]

/** A rating is provisional until its deviation settles. Same threshold the
 *  Progress screen uses, so one number never reads two ways. */
export const PROVISIONAL_RD = 110
/** A fresh ladder starts here (ratings.repo's default Glicko). */
const START_RD = 350

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
 * Puzzles, transcribed from design-lab/v1/puzzles.html.
 *
 * One control at the top, four words, and the pane below it IS the mode: Train
 * and Daily hand you a position, Custom is a chooser, Rush is a start line.
 *
 * v1 keeps all four panes in the document and hides three of them. Here only
 * the chosen pane is mounted: these panes own clocks, prefetch queues and IPC
 * sessions, and three of those running behind a display:none is not the same
 * page. The .puz-pane wrapper and its id are v1's.
 */
export default function PuzzlesView(): JSX.Element {
  const [mode, setMode] = useState<PuzzleModeKey>(loadMode)
  const [themes, setThemes] = useState<ThemeCount[]>([])
  // null = not asked yet. The puzzle DB is an optional dataset: without it every
  // channel on this page answers empty, so the page says so instead of drawing
  // four blank surfaces.
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [rating, setRating] = useState<RatingValue | null>(null)
  // Is today's daily still there to be played? A day is open until it has a
  // result, and a day you tried and missed is not open: replaying it is
  // practice and cannot change what was recorded. null = not asked yet.
  const [dailyOpen, setDailyOpen] = useState<boolean | null>(null)
  // The size of the installed set, straight from the DB. v1 prints a number
  // here; this is that number rather than one like it.
  const [positions, setPositions] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const api = window.api
    if (!api) return
    void api.datasets
      ?.status()
      .then((s) => {
        if (!cancelled) setInstalled(s.puzzles)
      })
      .catch(() => {
        /* leave unknown: the panes still report their own emptiness */
      })
    void api.puzzles
      ?.themes()
      .then((r) => {
        if (!cancelled && r?.themes) setThemes(r.themes)
      })
      .catch(() => {
        /* the theme catalog simply stays out */
      })
    void api.puzzles
      ?.count()
      .then((r) => {
        if (!cancelled) setPositions(r.puzzles)
      })
      .catch(() => {
        /* the corpus line simply stays out */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The readout's NEXT is about the page, so it is re-read when the pane
  // changes: that is the moment after a daily has been solved or a run has
  // moved the ladder.
  useEffect(() => {
    let cancelled = false
    const api = window.api
    if (!api) return
    void api.ratings
      ?.get('puzzle')
      .then((r) => {
        if (!cancelled && r) setRating(r)
      })
      .catch(() => {
        /* no rating line then */
      })
    void api.puzzles
      ?.daily()
      .then((d) => {
        if (!cancelled) setDailyOpen(d.puzzle !== null && d.result === null)
      })
      .catch(() => {
        /* no daily line then */
      })
    return () => {
      cancelled = true
    }
  }, [mode])

  const provisional = rating !== null && rating.rd >= PROVISIONAL_RD
  const next =
    installed === false
      ? 'Install the puzzle set from Settings'
      : dailyOpen === true
        ? "Today's puzzle is still open"
        : provisional
          ? // v1 names a count here. What settles this rating is deviation, and
            // how many solves that takes depends on every one of them, so there
            // is no honest number to put in front of "more".
            'Keep solving to set your puzzle rating'
          : null
  // The one ratio this screen is about: how far the puzzle rating is from being
  // a number rather than a band. Deviation, which is what actually settles it.
  const trace =
    provisional && rating
      ? Math.min(1, Math.max(0, (START_RD - rating.rd) / (START_RD - PROVISIONAL_RD)))
      : null
  useReadoutSlot(next, trace)

  const changeMode = (m: PuzzleModeKey): void => {
    setMode(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      {/* The four modes, and the size of the set they draw from. The count is
          read off the installed puzzle DB, so a lean install says nothing here
          rather than a number. */}
      <div className="filterbar">
        <div className="segmented" role="group" aria-label="Puzzle mode">
          {MODES.map((m) => (
            <button
              key={m.key}
              className="seg"
              type="button"
              aria-pressed={mode === m.key}
              onClick={() => changeMode(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
        {positions !== null && positions > 0 && (
          <span className="sec-count num">{formatFull(positions)} positions</span>
        )}
      </div>

      {installed === false ? (
        <NoPuzzleSet />
      ) : (
        <>
          {mode === 'train' && (
            <section className="puz-pane" id="pane-train">
              <TrainMode />
            </section>
          )}
          {mode === 'custom' && (
            <section className="puz-pane" id="pane-custom">
              <CustomMode themes={themes} />
            </section>
          )}
          {mode === 'rush' && (
            <section className="puz-pane" id="pane-rush">
              <RushMode />
            </section>
          )}
          {mode === 'daily' && (
            <section className="puz-pane" id="pane-daily">
              {/* Recording the day closes it, and the readout above says whether
                  it is open. It is told at that moment rather than at the next
                  pane change, so the line can never outlive the fact. */}
              <DailyMode onRecorded={() => setDailyOpen(false)} />
            </section>
          )}
        </>
      )}
    </>
  )
}

/** The whole page needs the puzzle DB, so the whole page says when it is absent. */
function NoPuzzleSet(): JSX.Element {
  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Puzzle set</h2>
      </div>
      <div className="well">
        <div className="empty">
          <p className="empty-line">The puzzle set is not installed.</p>
          <p className="empty-line">Settings, then Datasets, brings it in. Every mode here needs it.</p>
        </div>
      </div>
    </section>
  )
}

// ============================================================================
// TRAIN. v1's .lesson: the board on the left, three sections on the right that
// answer what this puzzle is, where your rating stands, and how today has gone.
// ============================================================================

/** Today's finished train attempts, oldest first, as solved/missed. */
function usePriorRun(): boolean[] {
  const [run, setRun] = useState<boolean[]>([])
  useEffect(() => {
    let cancelled = false
    const api = window.api?.puzzles
    if (!api) return
    const cut = startOfToday()
    void api
      .history({ mode: 'train', limit: 200 })
      .then((r) => {
        if (cancelled) return
        const rows = (r?.rows ?? []) as PuzzleHistoryRow[]
        const today = rows.filter((x) => x.createdAt >= cut)
        // history is newest first; the strip reads oldest first.
        setRun(today.reverse().map((x) => x.solved))
      })
      .catch(() => {
        /* today's strip starts from this session then */
      })
    return () => {
      cancelled = true
    }
  }, [])
  return run
}

function longestRun(marks: boolean[]): number {
  let best = 0
  let run = 0
  for (const solved of marks) {
    run = solved ? run + 1 : 0
    if (run > best) best = run
  }
  return best
}

/** The run you are on: solves back from the most recent attempt. Read off the
 *  same marks the rest of the panel counts, so the two can never disagree. */
function currentRun(marks: boolean[]): number {
  let run = 0
  for (let i = marks.length - 1; i >= 0 && marks[i]; i -= 1) run += 1
  return run
}

/**
 * On-demand coaching for the position on the board, in v1's coach block. It
 * reads the position, never the solution: the whole point of a puzzle is that
 * nobody hands you the move.
 */
function CoachSection({ fen }: { fen: string }): JSX.Element | null {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [text, setText] = useState<string | null>(null)
  const [terms, setTerms] = useState<string[]>([])
  const tokenRef = useRef(0)

  // A new position is a new question, so the last answer goes.
  useEffect(() => {
    tokenRef.current += 1
    setState('idle')
    setText(null)
    setTerms([])
  }, [fen])

  if (!window.api?.coach) return null

  const ask = (): void => {
    const coach = window.api?.coach
    if (!coach) return
    const token = ++tokenRef.current
    setState('busy')
    void coach
      .positional({ fen })
      .then((r) => {
        if (tokenRef.current !== token) return
        setText(r?.text ?? null)
        setTerms(r?.terms ?? [])
        setState(r ? 'done' : 'error')
      })
      .catch(() => {
        if (tokenRef.current === token) setState('error')
      })
  }

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Coach</h2>
        {terms.length > 0 && <span className="sec-count">{terms.join(', ')}</span>}
      </div>
      <div className="panel">
        <div className="coach">
          <div className="coach-head">
            <span className="coach-name">Coach</span>
            <span className="coach-role">no spoilers</span>
          </div>
          <p className="coach-said">
            {state === 'error'
              ? 'Nothing to say about this one right now.'
              : (text ?? 'What is going on in this position, without being told the move.')}
          </p>
        </div>
        <div className="panel-foot">
          <button className="btn" type="button" onClick={ask} disabled={state === 'busy'}>
            {state === 'busy' ? 'Reading it' : 'Read this position'}
          </button>
        </div>
      </div>
    </section>
  )
}

function TrainMode(): JSX.Element {
  const { settings } = useSettings()
  const s = usePuzzleSession()
  const priorRun = usePriorRun()
  const [liveRun, setLiveRun] = useState<boolean[]>([])
  const [summary, setSummary] = useState<ProgressSummary | null>(null)
  const countedRef = useRef(0)

  const isSolving = s.phase === 'solving'
  const isLive = isSolving || s.phase === 'leadin'
  const isDone = s.phase === 'solved' || s.phase === 'failed'
  const isEmpty = s.phase === 'empty' || s.phase === 'error'
  const hintsEnabled = settings.hintsEnabled

  // Lifetime solve counts, read once. This session's own attempts are added
  // locally below rather than re-read, so the number can never lag the board.
  useEffect(() => {
    let cancelled = false
    void window.api?.progress
      ?.summary()
      .then((r) => {
        if (!cancelled) setSummary(r)
      })
      .catch(() => {
        /* the solved fact simply stays out */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // One mark per recorded attempt. attemptCount rises in the same commit that
  // sets the phase, so the phase at that commit IS the outcome: 'solved' only
  // for a clean finish, everything else (wrong move, skip, reveal) is a miss.
  useEffect(() => {
    if (s.attemptCount === countedRef.current) return
    countedRef.current = s.attemptCount
    if (s.attemptCount === 0) return
    setLiveRun((r) => [...r, s.phase === 'solved'])
  }, [s.attemptCount, s.phase])

  // Keyboard: n next, r retry, h hint, s show solution.
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

  const run = useMemo(() => [...priorRun, ...liveRun], [priorRun, liveRun])
  const solvedToday = run.filter(Boolean).length
  const attemptNo = isLive ? run.length + 1 : run.length

  const taskState: TaskState = s.keepTrying
    ? 'keepTrying'
    : s.phase === 'solved'
      ? 'solved'
      : s.phase === 'failed'
        ? s.lateSolve
          ? 'lateSolve'
          : 'failed'
        : s.phase === 'loading'
          ? 'loading'
          : 'solving'

  const provisional = s.puzzleRd >= PROVISIONAL_RD
  const lo = Math.round(s.puzzleRating - s.puzzleRd)
  const hi = Math.round(s.puzzleRating + s.puzzleRd)
  // The band is drawn on an 800..2400 scale, clipped to it.
  const left = Math.min(100, Math.max(0, ((lo - 800) / 1600) * 100))
  const right = Math.min(100, Math.max(0, ((hi - 800) / 1600) * 100))

  const liveSolved = liveRun.filter(Boolean).length
  const solvedTotal = summary ? summary.puzzlesSolved + liveSolved : null
  const triedTotal = summary ? summary.puzzlesTried + liveRun.length : null

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
            {isSolving ? (
              <>
                {hintsEnabled && (
                  <HintButton
                    stage={s.hintStage}
                    disabled={!isSolving}
                    onHint={s.bumpHint}
                    revealSan={s.revealSan}
                  />
                )}
                {/* Both of these put the fail on the books before they show you
                    anything, which is why they are worded as they are. */}
                <button className="btn is-quiet" type="button" onClick={s.showSolution}>
                  Show solution
                </button>
                <button className="btn is-quiet" type="button" onClick={s.skip}>
                  Skip
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn is-quiet"
                  type="button"
                  onClick={s.retry}
                  disabled={!s.puzzle}
                >
                  Retry
                </button>
                <button className="btn is-primary" type="button" onClick={s.next}>
                  Next
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <aside className="side">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">This puzzle</h2>
            {s.puzzle && <span className="sec-count">{s.puzzle.id}</span>}
          </div>

          {isEmpty ? (
            <div className="well">
              <div className="empty">
                <p className="empty-line">
                  {s.phase === 'error' ? 'That puzzle would not load.' : 'Nothing matched.'}
                </p>
                <p className="empty-line">
                  {s.theme
                    ? 'Clear the theme below and the whole set is back.'
                    : 'Try again in a moment.'}
                </p>
              </div>
            </div>
          ) : (
            <>
              <PuzzleTask
                state={taskState}
                userColor={s.orientation}
                correctSan={s.correctSan ?? s.revealSan}
              />

              <div className="panel">
                <div className="facts">
                  <div className="fact">
                    <span className="lbl">Band</span>
                    <span className="fact-value">
                      {s.queryBand ? `${s.queryBand.lo} to ${s.queryBand.hi}` : 'picking one'}
                    </span>
                  </div>
                  <div className="fact">
                    <span className="lbl">Themes</span>
                    <span className="fact-value">
                      {isDone && s.puzzle?.themes.length
                        ? s.puzzle.themes.join(', ')
                        : 'shown after you solve it'}
                    </span>
                  </div>
                  {/* v1 named a time control and the two players' strength. The
                      puzzle set carries neither, so this says the one thing it
                      does carry: the game it was cut from. */}
                  <div className="fact">
                    <span className="lbl">From</span>
                    <span className="fact-value">
                      Lichess
                      {s.puzzle?.openingTags.length ? (
                        <span className="fact-note">{s.puzzle.openingTags[0]}</span>
                      ) : null}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Your puzzle rating</h2>
          </div>
          <div className="panel">
            {/* The band is a reading of the stored rating, so it waits for one.
                Glicko's 1500/350 defaults are what the hook starts at, and
                drawing those would be reporting a number nobody measured. */}
            {!s.ratingKnown ? (
              <div className="empty">
                <p className="empty-line">Your puzzle rating has not been read yet.</p>
                <p className="empty-line">Solve one here and it appears.</p>
              </div>
            ) : (
              <div className="facts">
                <div className="fact">
                  <span className="lbl">Rating</span>
                  <span className="fact-value">
                    {provisional ? 'provisional' : Math.round(s.puzzleRating)}
                    <span className="fact-note">
                      {provisional
                        ? `somewhere in ${lo} to ${hi}`
                        : `give or take ${Math.round(s.puzzleRd)}`}
                    </span>
                  </span>
                </div>
                {/* No tick, because there is no number: the reading is a width. */}
                <div className="puz-bandwrap">
                  <div className="puz-band">
                    <span
                      className={`puz-band-fill${provisional ? '' : ' is-set'}`}
                      style={{ left: `${left}%`, width: `${Math.max(1, right - left)}%` }}
                    />
                  </div>
                  <div className="puz-scale">
                    <span>800</span>
                    <span>2400</span>
                  </div>
                </div>
                <div className="fact">
                  <span className="lbl">Solved</span>
                  <span className="fact-value">
                    {solvedTotal === null
                      ? 'counting'
                      : triedTotal === 0
                        ? 'none yet'
                        : `${solvedTotal} of ${triedTotal}`}
                    <span className="fact-note">
                      {triedTotal === 0
                        ? 'the one on the board would be the first'
                        : 'every mode counts here, only Train and Daily rate'}
                    </span>
                  </span>
                </div>
                {/* The attempt just recorded moved the ladder, and the band
                    above quietly slid when it did. This is by how much. It is
                    the number the store sent back, and it clears when the next
                    puzzle is dealt. */}
                {s.delta !== null && (
                  <div className="fact">
                    <span className="lbl">Last attempt</span>
                    <span className="fact-value">
                      {s.delta > 0 ? `+${s.delta}` : String(s.delta)}
                      <span className="fact-note">
                        {s.delta === 0 ? 'no change' : 'points, from the one just played'}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Today</h2>
            {attemptNo > 0 && <span className="sec-count">{ordinal(attemptNo)} attempt</span>}
          </div>
          <div className="panel">
            {run.length === 0 && !isLive ? (
              <div className="empty">
                <p className="empty-line">No attempt today yet.</p>
                <p className="empty-line">The one on the board will be the first.</p>
              </div>
            ) : (
              <div className="puz-run" aria-label="Today's attempts">
                {run.map((solved, i) => (
                  <span
                    key={i}
                    className={`puz-mark ${solved ? 'is-solved' : 'is-missed'}`}
                    title={solved ? 'Solved' : 'Missed'}
                  />
                ))}
                {isLive && <span className="puz-mark is-now" title="On the board now" />}
              </div>
            )}
            <div className="facts">
              <div className="fact">
                <span className="lbl">Solved</span>
                <span className="fact-value">{solvedToday}</span>
              </div>
              <div className="fact">
                <span className="lbl">Missed</span>
                <span className="fact-value">{run.length - solvedToday}</span>
              </div>
              <div className="fact">
                <span className="lbl">Best run</span>
                <span className="fact-value">
                  {longestRun(run)}
                  {/* The trainer keeps an all time best across sittings. It is
                      only worth saying when it beats today. */}
                  {s.best > longestRun(run) && (
                    <span className="fact-note">{s.best} all time</span>
                  )}
                </span>
              </div>
              {/* The run you are on right now. Solving keeps it, one miss ends
                  it: the same counter Rush and Custom show. */}
              <div className="fact">
                <span className="lbl">On the trot</span>
                <span className="fact-value">{currentRun(run)}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Train serves a band around your rating. It can also be pinned to one
            theme, which v1 only drew on Custom. */}
        {s.themes.length > 0 && (
          <section className="sec">
            <div className="sec-head">
              <h2 className="lbl">Theme</h2>
              <span className="sec-count">{s.theme ?? 'any'}</span>
            </div>
            <div className="chips">
              <button
                className="chip"
                type="button"
                aria-pressed={s.theme === null}
                onClick={() => s.setTheme(null)}
              >
                any
              </button>
              {s.themes.slice(0, 12).map((t) => (
                <button
                  key={t.key}
                  className="chip"
                  type="button"
                  aria-pressed={s.theme === t.key}
                  onClick={() => s.setTheme(s.theme === t.key ? null : t.key)}
                >
                  {t.key}
                </button>
              ))}
            </div>
          </section>
        )}

        {s.puzzle && <CoachSection fen={s.fen} />}

        {!s.apiReady && (
          <section className="sec">
            <div className="well">
              <div className="empty">
                <p className="empty-line">This is a preview.</p>
                <p className="empty-line">The desktop app is where the puzzles and ratings live.</p>
              </div>
            </div>
          </section>
        )}
      </aside>
    </div>
  )
}
