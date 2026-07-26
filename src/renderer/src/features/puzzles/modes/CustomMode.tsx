import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { ThemeCount } from '@shared/types'
import { Board } from '../../../board/Board'
import { pieceSetClass } from '../../../board/pieceSets'
import { useSettings } from '../../../state/settings'
import { HintArrow } from '../HintArrow'
import { HintButton } from '../HintButton'
import { PuzzleTask, type TaskState } from '../PuzzleTask'
import { formatCount, formatDuration } from '../format'
import { groupThemes } from '../themes'
import {
  BANDS,
  POPULARITY_LEVELS,
  SET_LENGTHS,
  SOLUTION_LENGTHS,
  useCustomSession,
  type CustomSession
} from './custom-session'

// ============================================================================
// CUSTOM. v1's .puz-build: 73 themes, and the answer to picking among them is
// three doors of different width. A search box, twelve one tap chips covering
// what almost everybody wants, and nine drawers holding the rest by kind.
// Nothing is a checkbox and nothing is a wall.
//
// The board, the walk through the set and the end of it are surfaces v1 never
// drew, so they are built from the same parts Train uses: .lesson, .sec,
// .panel, .facts.
// ============================================================================

const MOST_USED = 12

export default function CustomMode({ themes }: { themes: ThemeCount[] }): JSX.Element {
  const s = useCustomSession()

  if (s.phase === 'setup') return <SetupScreen s={s} themes={themes} />
  if (s.phase === 'summary') return <SummaryScreen s={s} />
  if (s.phase === 'empty' || s.phase === 'error') return <NothingScreen s={s} />
  return <SolveScreen s={s} />
}

// ---------------------------------------------------------------- setup ----

function SetupScreen({ s, themes }: { s: CustomSession; themes: ThemeCount[] }): JSX.Element {
  const [query, setQuery] = useState('')

  const sorted = useMemo(() => [...themes].sort((a, b) => b.count - a.count), [themes])
  const q = query.trim().toLowerCase()
  const matches = useMemo(
    () => (q ? sorted.filter((t) => t.key.toLowerCase().includes(q)) : sorted),
    [sorted, q]
  )
  const mostUsed = matches.slice(0, MOST_USED)
  const groups = useMemo(() => groupThemes(matches), [matches])

  const picked = s.config.themes
  const toggle = (key: string): void => {
    s.setConfig({
      themes: picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key]
    })
  }

  const band = BANDS.find((b) => b.key === s.config.band) ?? BANDS[1]
  const lo = band.lo ?? 0
  const hi = band.hi ?? 4000
  const whole = band.key === 'any'

  return (
    <div className="puz-build">
      <div>
        <div className="filterbar">
          <input
            className="filter-input"
            type="search"
            placeholder={themes.length > 0 ? `Filter ${themes.length} themes` : 'Filter themes'}
            aria-label="Filter themes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* v1 offered Easier / My level / Harder. A custom set is served from a
              FIXED rating window, the same one for everybody, so these are the
              windows the app really queries rather than three words about a
              rating that has no part in it. */}
          <div className="segmented" role="group" aria-label="Difficulty">
            {BANDS.map((b) => (
              <button
                key={b.key}
                className="seg"
                type="button"
                aria-pressed={s.config.band === b.key}
                onClick={() => s.setConfig({ band: b.key })}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>

        {sorted.length === 0 ? (
          <section className="sec">
            <div className="sec-head">
              <h2 className="lbl">Most used</h2>
            </div>
            <div className="well">
              <div className="empty">
                <p className="empty-line">No themes to pick from.</p>
                <p className="empty-line">The puzzle set is what supplies them.</p>
              </div>
            </div>
          </section>
        ) : (
          <>
            <section className="sec">
              <div className="sec-head">
                <h2 className="lbl">Most used</h2>
                <span className="sec-count">
                  {mostUsed.length} of {themes.length}
                </span>
              </div>
              <div className="puz-extremes">
                <span>
                  <span className="lbl">Largest</span> {sorted[0].key} {formatCount(sorted[0].count)}
                </span>
                <span>
                  <span className="lbl">Smallest</span> {sorted[sorted.length - 1].key}{' '}
                  {formatCount(sorted[sorted.length - 1].count)}
                </span>
              </div>
              <div className="chips">
                {mostUsed.map((t) => (
                  <button
                    key={t.key}
                    className="chip"
                    type="button"
                    aria-pressed={picked.includes(t.key)}
                    onClick={() => toggle(t.key)}
                  >
                    {t.key} <span className="chip-n">{formatCount(t.count)}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="sec">
              <div className="sec-head">
                <h2 className="lbl">All themes</h2>
                <span className="sec-count">{groups.length} groups</span>
              </div>

              {groups.map((g) => (
                <details className="puz-group" key={g.name} open={q.length > 0}>
                  <summary>
                    <span className="lbl puz-gname">{g.name}</span>
                    <span className="puz-gprev">{g.preview.join(', ')}</span>
                    <svg className="icon puz-caret" aria-hidden focusable="false">
                      <use href="#i-chev" />
                    </svg>
                  </summary>
                  <div className="puz-gbody">
                    <div className="chips">
                      {g.themes.map((t) => (
                        <button
                          key={t.key}
                          className="chip"
                          type="button"
                          aria-pressed={picked.includes(t.key)}
                          onClick={() => toggle(t.key)}
                        >
                          {t.key} <span className="chip-n">{formatCount(t.count)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </details>
              ))}
            </section>
          </>
        )}
      </div>

      <aside className="side">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Picked</h2>
            <span className="sec-count">{picked.length}</span>
          </div>
          <div className="panel">
            <div className="puz-selected">
              {picked.map((name) => (
                <div className="puz-selrow" key={name}>
                  <span>{name}</span>
                  <button className="puz-selrow-drop" type="button" onClick={() => toggle(name)}>
                    drop
                  </button>
                </div>
              ))}
            </div>
            {picked.length === 0 && (
              <div className="empty">
                <p className="empty-line">No theme picked.</p>
                <p className="empty-line">Start anyway and you get the whole set.</p>
              </div>
            )}
            <div className="panel-foot">
              <button className="btn is-primary" type="button" onClick={s.start}>
                Start custom run
              </button>
            </div>
          </div>
        </section>

        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Difficulty</h2>
          </div>
          <div className="panel">
            <div className="facts">
              <div className="fact">
                <span className="lbl">Serving</span>
                <span className="fact-value">{whole ? 'the whole set' : `${lo} to ${hi}`}</span>
              </div>
              <div className="fact">
                <span className="lbl">Width</span>
                <span className="fact-value">
                  {whole ? 'everything' : `${hi - lo} points`}
                  <span className="fact-note">
                    {whole ? 'no window at all' : 'a fixed window, not your rating'}
                  </span>
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* A custom run is a fixed set, and these are the other three cuts it
            can be made with. v1 drew none of them. */}
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">The set</h2>
            <span className="sec-count">{s.config.count} puzzles</span>
          </div>
          <div className="panel">
            <div className="puz-pick">
              <span className="lbl">How many</span>
              <div className="chips">
                {SET_LENGTHS.map((n) => (
                  <button
                    key={n}
                    className="chip"
                    type="button"
                    aria-pressed={s.config.count === n}
                    onClick={() => s.setConfig({ count: n })}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="puz-pick">
              <span className="lbl">Solution length</span>
              <div className="chips">
                {SOLUTION_LENGTHS.map((l) => (
                  <button
                    key={l.key}
                    className="chip"
                    type="button"
                    aria-pressed={s.config.length === l.key}
                    onClick={() => s.setConfig({ length: l.key })}
                  >
                    {l.label} <span className="chip-n">{l.sub}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="puz-pick">
              <span className="lbl">Liked by solvers</span>
              <div className="chips">
                {POPULARITY_LEVELS.map((p) => (
                  <button
                    key={p.key}
                    className="chip"
                    type="button"
                    aria-pressed={s.config.minPopularity === p.value}
                    onClick={() => s.setConfig({ minPopularity: p.value })}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="puz-pick">
              <span className="lbl">Ones you have solved</span>
              <div className="chips">
                <button
                  className="chip"
                  type="button"
                  aria-pressed={!s.config.excludeSolved}
                  onClick={() => s.setConfig({ excludeSolved: false })}
                >
                  keep them
                </button>
                <button
                  className="chip"
                  type="button"
                  aria-pressed={s.config.excludeSolved}
                  onClick={() => s.setConfig({ excludeSolved: true })}
                >
                  skip them
                </button>
              </div>
            </div>
          </div>
        </section>

        {!s.apiReady && (
          <section className="sec">
            <div className="well">
              <div className="empty">
                <p className="empty-line">This is a preview.</p>
                <p className="empty-line">The desktop app is where the puzzle set lives.</p>
              </div>
            </div>
          </section>
        )}
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------- solve ----

function SolveScreen({ s }: { s: CustomSession }): JSX.Element {
  const { settings } = useSettings()
  const isSolving = s.phase === 'solving'
  const hintsEnabled = settings.hintsEnabled

  // Enter takes the review flash off the screen, Escape leaves the set.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'Enter') s.advance()
      else if (e.key === 'Escape') s.quit()
      else if (e.key === 'h' && isSolving && hintsEnabled) s.bumpHint()
      else if (e.key === 's' && isSolving) s.showSolution()
      else if (e.key === 'r') s.retry()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s, isSolving, hintsEnabled])

  const taskState: TaskState = s.keepTrying
    ? 'keepTrying'
    : s.phase === 'review'
      ? s.lastSolved
        ? 'solved'
        : 'failed'
      : s.phase === 'loading'
        ? 'loading'
        : 'solving'

  // Puzzles finished so far. The review flash completes the one just played,
  // so it counts from that moment rather than at the next deal.
  const finished = s.index + (s.phase === 'review' ? 1 : 0)

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
            {isSolving && (
              <>
                <button className="btn is-quiet" type="button" onClick={s.showSolution}>
                  Show solution
                </button>
                <button className="btn is-quiet" type="button" onClick={s.skip}>
                  Skip
                </button>
              </>
            )}
            {/* Set the position back and play it again. The outcome is already
                on the books, so this changes the score of nothing. */}
            <button className="btn is-quiet" type="button" onClick={s.retry} disabled={!s.puzzle}>
              Retry
            </button>
            <button className="btn is-quiet" type="button" onClick={s.quit}>
              Leave the set
            </button>
          </div>
        </div>
      </div>

      <aside className="side">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">This puzzle</h2>
            {s.puzzle && <span className="sec-count">{s.puzzle.id}</span>}
          </div>

          <PuzzleTask state={taskState} userColor={s.orientation} correctSan={s.correctSan} />

          <div className="panel">
            <div className="facts">
              <div className="fact">
                <span className="lbl">Number</span>
                <span className="fact-value">
                  {s.index + 1} of {s.total}
                </span>
              </div>
              <div className="fact">
                <span className="lbl">Rating</span>
                <span className="fact-value">{s.puzzle ? s.puzzle.rating : ''}</span>
              </div>
              <div className="fact">
                <span className="lbl">Themes</span>
                <span className="fact-value">
                  {s.phase === 'review' && s.puzzle?.themes.length
                    ? s.puzzle.themes.join(', ')
                    : 'shown after you solve it'}
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">This run</h2>
          </div>
          <div className="panel">
            <div className="facts">
              <div className="fact">
                <span className="lbl">Solved</span>
                <span className="fact-value">{s.solvedCount}</span>
              </div>
              {/* Running accuracy over the ones already finished. Before the
                  first one is finished there is nothing to divide by, so it
                  says so instead of printing a zero. */}
              <div className="fact">
                <span className="lbl">Accuracy</span>
                <span className="fact-value">
                  {finished > 0 ? `${Math.round((s.solvedCount / finished) * 100)}%` : 'nothing yet'}
                  {finished > 0 && (
                    <span className="fact-note">
                      over {finished} {finished === 1 ? 'puzzle' : 'puzzles'}
                    </span>
                  )}
                </span>
              </div>
              <div className="fact">
                <span className="lbl">On the trot</span>
                <span className="fact-value">{s.streak}</span>
              </div>
              <div className="fact">
                <span className="lbl">Best run</span>
                <span className="fact-value">{s.bestStreak}</span>
              </div>
              <div className="fact">
                <span className="lbl">Your rating</span>
                <span className="fact-value">
                  untouched
                  <span className="fact-note">a custom set is drilled, not rated</span>
                </span>
              </div>
            </div>
          </div>
        </section>
      </aside>
    </div>
  )
}

// -------------------------------------------------------------- the end ----

function SummaryScreen({ s }: { s: CustomSession }): JSX.Element {
  const sum = s.summary
  if (!sum) return <NothingScreen s={s} />

  return (
    <div className="lesson">
      <div className="lesson-main">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Set complete</h2>
            <span className="sec-count">
              {sum.solved} of {sum.total}
            </span>
          </div>
          <div className="panel">
            <div className="facts">
              <div className="fact">
                <span className="lbl">Accuracy</span>
                <span className="fact-value">{Math.round(sum.accuracy * 100)}%</span>
              </div>
              <div className="fact">
                <span className="lbl">Time</span>
                <span className="fact-value">{formatDuration(sum.totalMs)}</span>
              </div>
              <div className="fact">
                <span className="lbl">Best run</span>
                <span className="fact-value">{sum.bestStreak}</span>
              </div>
              {sum.weakest && (
                <div className="fact">
                  <span className="lbl">Hardest for you</span>
                  <span className="fact-value">
                    {sum.weakest.theme}
                    <span className="fact-note">
                      {sum.weakest.solved} of {sum.weakest.attempts}
                    </span>
                  </span>
                </div>
              )}
              {sum.strongest && (
                <div className="fact">
                  <span className="lbl">Best for you</span>
                  <span className="fact-value">
                    {sum.strongest.theme}
                    <span className="fact-note">
                      {sum.strongest.solved} of {sum.strongest.attempts}
                    </span>
                  </span>
                </div>
              )}
            </div>
            <div className="panel-foot">
              <button className="btn is-primary" type="button" onClick={s.playAgain}>
                Run the same set again
              </button>
            </div>
          </div>
        </section>
      </div>

      <aside className="side">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Another set</h2>
          </div>
          <div className="panel">
            <div className="panel-foot">
              <button className="btn" type="button" onClick={s.newSet}>
                Pick a new set
              </button>
            </div>
          </div>
        </section>
      </aside>
    </div>
  )
}

function NothingScreen({ s }: { s: CustomSession }): JSX.Element {
  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Custom set</h2>
      </div>
      <div className="well">
        <div className="empty">
          <p className="empty-line">
            {s.phase === 'error' ? 'That set would not load.' : 'Nothing matched those themes.'}
          </p>
          <p className="empty-line">Drop a theme or widen the difficulty and try again.</p>
        </div>
      </div>
      <div className="startrow">
        <div>
          <div className="startrow-name">Back to the picker</div>
          <div className="startrow-spec">Your picks are still there.</div>
        </div>
        <button className="btn is-primary" type="button" onClick={s.newSet}>
          Pick again
        </button>
      </div>
    </section>
  )
}
