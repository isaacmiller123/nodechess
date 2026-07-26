import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { RushMode as RushModeId, RushRunRow, RushBest, RushEndReason } from '@shared/types'
import { Board } from '../../../board/Board'
import { pieceSetClass } from '../../../board/pieceSets'
import { useSettings } from '../../../state/settings'
import { PuzzleTask } from '../PuzzleTask'
import { formatAgo, formatClock, formatDuration, formatSeconds } from '../format'
import {
  RUSH_VARIANTS,
  band,
  survivalBudgetSec,
  useRushSession,
  type RushSession,
  type RushVariant
} from './rush-session'

// ============================================================================
// RUSH. v1 drew two clocks, "3 minutes" and "5 minutes". The app has four
// variants and neither of those is one of them: Storm is a 3:00 clock that
// buys and loses time, Survival is a per-puzzle budget that keeps shrinking,
// and Rush 3 / Rush 5 are lives with no clock at all. So the clock section
// holds the two real clocks, and the two lives variants get their own section
// rather than being dropped or renamed into a length they do not have.
//
// Every number in "The run" is read off the variant, not typed in.
// ============================================================================

const MODE_PREF_KEY = 'oct.puzzles.rush.mode.v1'

const CLOCKS: RushModeId[] = ['storm', 'survival']
const LIVES: RushModeId[] = ['rush3', 'rush5']

const REASON_LABEL: Record<RushEndReason, string> = {
  time: "Time's up",
  lives: 'Out of lives',
  quit: 'Run ended',
  cleared: 'Band cleared'
}

const LOW_TIME_MS = 10_000

function loadModePref(): RushModeId {
  try {
    const raw = localStorage.getItem(MODE_PREF_KEY)
    if (raw === 'rush3' || raw === 'rush5' || raw === 'storm' || raw === 'survival') return raw
  } catch {
    /* storage may be unavailable */
  }
  return 'storm'
}

export default function RushMode(): JSX.Element {
  const [mode, setMode] = useState<RushModeId>(loadModePref)
  const s = useRushSession(mode)

  // Starting a variant is also choosing it: the rules panel then describes the
  // run you last asked for rather than one you never picked. The solve loop is
  // keyed to the variant, so a switch starts on the NEXT render, once the hook
  // is running the variant that was asked for.
  const [pending, setPending] = useState<RushModeId | null>(null)

  const choose = useCallback(
    (m: RushModeId) => {
      if (m === mode) {
        s.start()
        return
      }
      setMode(m)
      setPending(m)
      try {
        localStorage.setItem(MODE_PREF_KEY, m)
      } catch {
        /* ignore */
      }
    },
    [mode, s]
  )

  useEffect(() => {
    if (pending === null || pending !== mode) return
    setPending(null)
    s.start()
  }, [pending, mode, s])

  if (s.phase === 'over') return <RunOver s={s} onAgain={() => s.start()} onBack={s.reset} />
  if (s.phase !== 'idle') return <RushPlaying s={s} />
  return <RushLobby s={s} mode={mode} onStart={choose} />
}

// ---------------------------------------------------------------- lobby ----

function RushLobby({
  s,
  mode,
  onStart
}: {
  s: RushSession
  mode: RushModeId
  onStart: (m: RushModeId) => void
}): JSX.Element {
  const [runs, setRuns] = useState<RushRunRow[]>([])
  const [bests, setBests] = useState<RushBest[]>([])

  useEffect(() => {
    let cancelled = false
    const api = window.api?.puzzles
    if (!api) return
    void api
      .rushRuns({ limit: 12 })
      .then((r) => {
        if (!cancelled) setRuns(r?.runs ?? [])
      })
      .catch(() => {
        /* the well stays empty then */
      })
    void api
      .rushBests()
      .then((r) => {
        // A variant you have never run has no best, and a zero is not one.
        if (!cancelled) setBests((r?.bests ?? []).filter((b) => b.runs > 0))
      })
      .catch(() => {
        /* no bests panel then */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // v1 promises "best first" and the store hands them over newest first.
  const bestFirst = useMemo(() => [...runs].sort((a, b) => b.score - a.score), [runs])
  const last = runs[0] ?? null
  const variant = RUSH_VARIANTS[mode]

  return (
    <div className="lesson">
      <div className="lesson-main">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Pick a clock</h2>
            {/* v1's word, and the count is the rows below it, not a constant. */}
            <span className="sec-count">{CLOCKS.length} lengths</span>
          </div>
          {CLOCKS.map((m, i) => (
            <StartRow
              key={m}
              variant={RUSH_VARIANTS[m]}
              first={i === 0}
              usual={m === 'storm'}
              onStart={() => onStart(m)}
            />
          ))}
        </section>

        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Lives instead</h2>
            <span className="sec-count">{LIVES.length} runs</span>
          </div>
          {LIVES.map((m) => (
            <StartRow
              key={m}
              variant={RUSH_VARIANTS[m]}
              first={false}
              usual={false}
              onStart={() => onStart(m)}
            />
          ))}
        </section>

        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Your runs</h2>
            {runs.length > 0 && <span className="sec-count">{runs.length} kept</span>}
          </div>
          <div className="well">
            <div className="empty-head">
              <span className="lbl">Clock</span>
              <span className="lbl">Score</span>
              <span className="lbl">Streak</span>
              <span className="lbl">When</span>
            </div>
            {bestFirst.length === 0 ? (
              <div className="empty">
                <p className="empty-line">No run yet.</p>
                <p className="empty-line">Finished runs land here, best first.</p>
              </div>
            ) : (
              bestFirst.map((r) => (
                <div className="puz-runrow" key={r.id}>
                  <span>
                    {RUSH_VARIANTS[r.mode].label}
                    {r.endedReason && <span className="go-sub">{REASON_LABEL[r.endedReason]}</span>}
                  </span>
                  <span>{r.score}</span>
                  <span>{r.bestStreak}</span>
                  <span className="puz-runrow-when">{formatAgo(r.createdAt)}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <aside className="side">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">The run</h2>
            <span className="sec-count">{variant.label}</span>
          </div>
          <div className="panel">
            <div className="facts">
              <RunRules variant={variant} />
            </div>
          </div>
        </section>

        {bests.length > 0 && (
          <section className="sec">
            <div className="sec-head">
              <h2 className="lbl">Your best</h2>
            </div>
            <div className="panel">
              <div className="facts">
                {bests.map((b) => (
                  <div className="fact" key={b.mode}>
                    <span className="lbl">{RUSH_VARIANTS[b.mode].label}</span>
                    <span className="fact-value">
                      {b.best}
                      <span className="fact-note">
                        {b.runs} {b.runs === 1 ? 'run' : 'runs'}
                        {b.lastScore !== null ? `, last ${b.lastScore}` : ''}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {last && (
          <section className="sec">
            <div className="sec-head">
              <h2 className="lbl">Last run</h2>
              <span className="sec-count">{formatAgo(last.createdAt)}</span>
            </div>
            <div className="panel">
              <div className="facts">
                <RunDetail
                  score={last.score}
                  solved={last.solved}
                  missed={last.missed}
                  bestStreak={last.bestStreak}
                  topRating={last.topRating}
                  durationMs={last.durationMs}
                  reason={last.endedReason}
                />
              </div>
            </div>
          </section>
        )}

        {!s.apiReady && (
          <section className="sec">
            <div className="well">
              <div className="empty">
                <p className="empty-line">This is a preview.</p>
                <p className="empty-line">The desktop app is where a run can be played and kept.</p>
              </div>
            </div>
          </section>
        )}
      </aside>
    </div>
  )
}

function StartRow({
  variant,
  first,
  usual,
  onStart
}: {
  variant: RushVariant
  first: boolean
  usual: boolean
  onStart: () => void
}): JSX.Element {
  return (
    <div className={`startrow${first ? ' is-first' : ''}`}>
      <div>
        <div className="startrow-name">
          {variant.label} {usual && <span className="tag">usual</span>}
        </div>
        <div className="startrow-spec">{variant.blurb}</div>
      </div>
      <button className={`btn${first ? ' is-primary' : ''}`} type="button" onClick={onStart}>
        {variant.clock ? `Start ${formatSeconds(variant.startSec)}` : 'Start'}
      </button>
    </div>
  )
}

/** The rules of one variant, every number read off RUSH_VARIANTS and band(). */
function RunRules({ variant }: { variant: RushVariant }): JSX.Element {
  const start = band(0)
  return (
    <>
      {variant.clock ? (
        <div className="fact">
          <span className="lbl">Clock hits zero</span>
          <span className="fact-value">run over</span>
        </div>
      ) : (
        <div className="fact">
          <span className="lbl">Clock</span>
          <span className="fact-value">none</span>
        </div>
      )}

      {variant.mode === 'survival' ? (
        <div className="fact">
          <span className="lbl">Each puzzle gets</span>
          <span className="fact-value">
            {survivalBudgetSec(0)} seconds
            <span className="fact-note">less every time you solve one</span>
          </span>
        </div>
      ) : null}

      <div className="fact">
        <span className="lbl">A miss costs</span>
        <span className="fact-value">
          {variant.penaltySec > 0
            ? `${variant.penaltySec} seconds`
            : variant.lives === 1
              ? 'the run'
              : 'a life'}
        </span>
      </div>

      {variant.bonusSec > 0 && (
        <div className="fact">
          <span className="lbl">A solve adds</span>
          <span className="fact-value">
            {variant.bonusSec} seconds
            <span className="fact-note">more once you are on a streak</span>
          </span>
        </div>
      )}

      {Number.isFinite(variant.lives) && variant.lives > 1 && (
        <div className="fact">
          <span className="lbl">Lives</span>
          <span className="fact-value">{variant.lives}</span>
        </div>
      )}

      <div className="fact">
        <span className="lbl">Starting band</span>
        <span className="fact-value">
          {start.lo} to {start.hi}
          <span className="fact-note">rises with every solve</span>
        </span>
      </div>

      <div className="fact">
        <span className="lbl">Your rating</span>
        <span className="fact-value">
          untouched
          <span className="fact-note">a run is scored, not rated</span>
        </span>
      </div>
    </>
  )
}

function RunDetail(props: {
  score: number
  solved: number
  missed: number
  bestStreak: number
  topRating: number | null
  durationMs: number
  reason: RushEndReason | null
}): JSX.Element {
  return (
    <>
      <div className="fact">
        <span className="lbl">Score</span>
        <span className="fact-value">{props.score}</span>
      </div>
      <div className="fact">
        <span className="lbl">Solved</span>
        <span className="fact-value">{props.solved}</span>
      </div>
      <div className="fact">
        <span className="lbl">Missed</span>
        <span className="fact-value">{props.missed}</span>
      </div>
      <div className="fact">
        <span className="lbl">Best run</span>
        <span className="fact-value">{props.bestStreak}</span>
      </div>
      {props.topRating !== null && props.topRating > 0 && (
        <div className="fact">
          <span className="lbl">Hardest solved</span>
          <span className="fact-value">{props.topRating}</span>
        </div>
      )}
      <div className="fact">
        <span className="lbl">Time</span>
        <span className="fact-value">{formatDuration(props.durationMs)}</span>
      </div>
      {props.reason && (
        <div className="fact">
          <span className="lbl">Ended</span>
          <span className="fact-value">{REASON_LABEL[props.reason]}</span>
        </div>
      )}
    </>
  )
}

// -------------------------------------------------------------- playing ----

function RushPlaying({ s }: { s: RushSession }): JSX.Element {
  const { settings } = useSettings()
  const isSolving = s.phase === 'solving'

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') s.quit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s])

  const low = s.clockOn && s.clockMs <= LOW_TIME_MS

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
            </div>
          </div>

          <div className="boardbar">
            <div className="turn">
              <span className={`turn-chip${s.turn === 'black' ? ' is-black' : ''}`} />
              {s.turn === 'white' ? 'White to move' : 'Black to move'}
            </div>
            {s.clockOn && (
              <span className={`tag${low ? ' puz-low' : ''}`}>{formatClock(s.clockMs)}</span>
            )}
            <button className="btn is-quiet" type="button" onClick={s.quit}>
              End the run
            </button>
          </div>
        </div>
      </div>

      <aside className="side">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">This run</h2>
            <span className="sec-count">{s.variant.label}</span>
          </div>

          {/* A run gives one line of feedback per puzzle and then moves on. A
              miss holds the right move on the board for a beat; a solve has no
              phase of its own, so the flash the session raises is what says it
              landed. */}
          {s.phase === 'feedback' ? (
            <PuzzleTask state="failed" userColor={s.orientation} />
          ) : s.flash === 'solve' ? (
            <PuzzleTask state="solved" userColor={s.orientation} />
          ) : null}

          <div className="panel">
            <div className="facts">
              <div className="fact">
                <span className="lbl">Score</span>
                <span
                  className={`fact-value${s.flash ? ` puz-flash is-${s.flash}` : ''}`}
                >
                  {s.score}
                </span>
              </div>
              {s.maxLives > 0 && (
                <div className="fact">
                  <span className="lbl">Lives left</span>
                  <span className="fact-value">
                    {s.livesLeft} of {s.maxLives}
                  </span>
                </div>
              )}
              <div className="fact">
                <span className="lbl">On the trot</span>
                <span className="fact-value">
                  {s.streak}
                  {s.comboMult > 1 && (
                    <span className="fact-note">{s.comboMult}x time back per solve</span>
                  )}
                </span>
              </div>
              <div className="fact">
                <span className="lbl">Solved</span>
                <span className="fact-value">{s.solved}</span>
              </div>
              <div className="fact">
                <span className="lbl">Missed</span>
                <span className="fact-value">{s.missed}</span>
              </div>
              <div className="fact">
                <span className="lbl">Best run</span>
                <span className="fact-value">{s.bestStreak}</span>
              </div>
              {/* The band climbs with every solve, so the one in front of you
                  says how far the run has got. Read off the puzzle, not the
                  nominal window. */}
              {s.puzzle && (
                <div className="fact">
                  <span className="lbl">This one</span>
                  <span className="fact-value">
                    {s.puzzle.rating}
                    <span className="fact-note">harder with every solve</span>
                  </span>
                </div>
              )}
            </div>
          </div>
        </section>
      </aside>
    </div>
  )
}

// ------------------------------------------------------------------ over ----

function RunOver({
  s,
  onAgain,
  onBack
}: {
  s: RushSession
  onAgain: () => void
  onBack: () => void
}): JSX.Element {
  return (
    <div className="lesson">
      <div className="lesson-main">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Run over</h2>
            <span className="sec-count">
              {s.endedReason ? REASON_LABEL[s.endedReason] : s.variant.label}
            </span>
          </div>
          <div className="panel">
            <div className="facts">
              <RunDetail
                score={s.score}
                solved={s.solved}
                missed={s.missed}
                bestStreak={s.bestStreak}
                topRating={s.topRating}
                durationMs={s.durationMs}
                reason={s.endedReason}
              />
              {s.result && (
                <div className="fact">
                  <span className="lbl">Your best</span>
                  <span className="fact-value">
                    {s.result.best}
                    {s.result.isBest && <span className="fact-note">this run set it</span>}
                  </span>
                </div>
              )}
            </div>
            <div className="panel-foot">
              <button className="btn is-primary" type="button" onClick={onAgain} disabled={s.saving}>
                {s.saving ? 'Saving the run' : `Another ${s.variant.label}`}
              </button>
            </div>
          </div>
        </section>
      </div>

      <aside className="side">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Another way</h2>
          </div>
          <div className="panel">
            <div className="panel-foot">
              <button className="btn" type="button" onClick={onBack}>
                Back to the clocks
              </button>
            </div>
          </div>
        </section>
      </aside>
    </div>
  )
}
