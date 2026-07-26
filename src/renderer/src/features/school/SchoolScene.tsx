import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useRef,
  type JSX,
  type ReactNode
} from 'react'
import { useReadoutSlot } from '../../components/Layout'
import type { AnnotationLabel } from './annotations'

/**
 * design-lab/v1/school.html, as a component.
 *
 * The page is one shape and every School screen that shows a board is that
 * shape: a .lesson grid, the board column on the left carrying the lesson head
 * above the board and the boardbar below it, and the aside on the right
 * carrying Viktor, the moves and the chapter. A segment does not lay any of
 * that out. It hands this component a board, a line, a task and its buttons,
 * and the layout is identical from the first teach step to the boss debrief.
 *
 * The two pieces that belong to the LESSON rather than to the segment (the head
 * over the board, and the chapter list + foot under the aside) arrive through
 * LessonChrome, because the lesson player owns them and the segment inside it
 * must not know they exist.
 */

/** Sprite reference. Layout mounts v1's sixteen symbols once; School uses four
 *  of them (check, lock, arrow, chev) and never draws a glyph of its own. */
export function Icon({ id, className = 'icon' }: { id: string; className?: string }): JSX.Element {
  return (
    <svg className={className} aria-hidden focusable="false">
      <use href={`#${id}`} />
    </svg>
  )
}

/** Two-digit chapter and lesson numbers, as v1 writes them ("01", "07"). */
export function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Board-display settings threaded into every School board. */
export interface BoardEnv {
  boardClass: string
  coordinates: boolean
  animation: boolean
  showDests: boolean
}

// ===========================================================================
// LESSON CHROME: what the lesson player contributes to the screen its segments
// draw. Empty outside a lesson (the chapter test and the placement game use the
// same frame with no chapter list under it).
// ===========================================================================

export interface LessonChrome {
  /** .sch-head: the chapter line, the lesson name, the lesson's question. */
  head?: ReactNode
  /** Sections pinned under the aside: "This chapter" and .lesson-foot. */
  side?: ReactNode
  /** The readout's trace, 0..1, or null when nothing true can be reported. */
  trace?: number | null
}

const ChromeCtx = createContext<LessonChrome>({})

export function LessonChromeProvider({
  chrome,
  children
}: {
  chrome: LessonChrome
  children: ReactNode
}): JSX.Element {
  return <ChromeCtx.Provider value={chrome}>{children}</ChromeCtx.Provider>
}

// ===========================================================================
// THE COACH. v1's .coach: a name, a role, one paragraph per thing Viktor
// actually said, and the task box under them when the learner has been given
// something to do.
// ===========================================================================

export interface CoachProps {
  /** One paragraph per real coach line. Never one line split into three. */
  said: string[]
  /** The single imperative in force right now, or nothing. */
  task?: string
  /** Viktor is working (engine reply, debrief loading). */
  thinking?: boolean
  /** Viktor is deliberately quiet (the boss game). */
  silent?: boolean
  /** Buttons or notices under the paragraphs, inside the panel. */
  children?: ReactNode
}

export function CoachBody({ said, task, thinking, silent, children }: CoachProps): JSX.Element {
  const lines = thinking
    ? ['Viktor studies the position.']
    : silent
      ? ['Viktor watches in silence. Play your game. We talk after.']
      : said.filter((s) => s.trim().length > 0)

  return (
    <div className="coach">
      <div className="coach-head">
        <span className="coach-name">Viktor</span>
        <span className="coach-role">Coach</span>
      </div>
      {lines.map((line, i) => (
        <p className="coach-said" key={i}>
          {line}
        </p>
      ))}
      {task && (
        <div className="task">
          <p className="task-text">{task}</p>
        </div>
      )}
      {children}
    </div>
  )
}

/** Viktor in his own panel, which is how the lesson page always shows him. */
export function Coach(props: CoachProps): JSX.Element {
  return (
    <div className="panel">
      <CoachBody {...props} />
    </div>
  )
}

/** The coach standing alone, centred, for the screens that have no board:
 *  a finished lesson, a missing chapter, a drill with nothing in it. */
export function CoachCard({
  title,
  count,
  foot,
  ...coach
}: CoachProps & { title?: string; count?: string; foot?: ReactNode }): JSX.Element {
  return (
    <div className="col-single">
      <section className="sec">
        {title && (
          <div className="sec-head">
            <h2 className="lbl">{title}</h2>
            {count && <span className="sec-count">{count}</span>}
          </div>
        )}
        <Coach {...coach} />
      </section>
      {foot}
    </div>
  )
}

// ===========================================================================
// THE MOVES. v1's .moves grid: a number, White's move, Black's move. Only ever
// rendered from a real move list (a model line, a boss game, the placement
// game, a debrief). A teach or guided step is one FEN and a FEN has no history,
// so those screens show no move list rather than a reconstructed one.
// ===========================================================================

interface Pair {
  no: number
  white?: { san: string; idx: number }
  black?: { san: string; idx: number }
}

export function MoveSection({
  startFen,
  sans,
  current
}: {
  /** Position the line starts from: numbering and side-to-move come from it. */
  startFen: string
  sans: string[]
  /** Index into `sans` to mark as the move in hand. Defaults to the last. */
  current?: number
}): JSX.Element | null {
  const cur = current ?? sans.length - 1
  const activeRef = useRef<HTMLSpanElement | null>(null)

  // Keep the move in hand visible as the game grows and the debrief walks.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [cur, sans.length])

  // Hooks above, so it is safe to bail here (React #300).
  if (sans.length === 0) return null

  const parts = startFen.split(' ')
  const blackFirst = parts[1] === 'b'
  let no = Number.parseInt(parts[5] ?? '1', 10)
  if (!Number.isFinite(no) || no < 1) no = 1

  const pairs: Pair[] = []
  let i = 0
  if (blackFirst) {
    pairs.push({ no, black: { san: sans[0], idx: 0 } })
    no += 1
    i = 1
  }
  for (; i < sans.length; i += 2, no += 1) {
    pairs.push({
      no,
      white: { san: sans[i], idx: i },
      black: sans[i + 1] !== undefined ? { san: sans[i + 1], idx: i + 1 } : undefined
    })
  }

  const cell = (m?: { san: string; idx: number }): JSX.Element =>
    m ? (
      <span
        ref={m.idx === cur ? activeRef : undefined}
        className={`mv${m.idx === cur ? ' is-next' : ''}`}
      >
        {m.san}
      </span>
    ) : (
      <span className="mv" />
    )

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Moves</h2>
        <span className="sec-count">{pairs.length}</span>
      </div>
      {/* .sch-moves caps the panel and scrolls INSIDE it: a boss game or a
          placement game can run a hundred moves, and the aside must not grow
          the page under the board. */}
      <div className="panel sch-moves">
        {/* A flat run of spans: .moves is a three column grid and every cell in
            it is a direct child, exactly as v1 writes it. */}
        <div className="moves">
          {pairs.map((p) => (
            <Fragment key={p.no}>
              <span className="mv-no">{p.no}</span>
              {cell(p.white)}
              {cell(p.black)}
            </Fragment>
          ))}
        </div>
      </div>
    </section>
  )
}

// ===========================================================================
// THE SCENE. v1's whole .lesson block.
// ===========================================================================

export interface SceneProps {
  env: BoardEnv
  /** The board, and anything that sits on top of it (the promotion picker). */
  board: ReactNode
  /** What the position is, for a screen reader. Only for a board you cannot
   *  move on: a role of img over a live board would hide the pieces. */
  boardLabel?: string
  /** Viktor's square cues, as readable pills over the board. */
  labels?: AnnotationLabel[]
  /** Whose move it is. The boardbar's left half. */
  turn?: ReactNode
  /** The boardbar's controls, quiet ones first and the primary one last. */
  actions?: ReactNode
  /** The head over the coach panel: which segment this is, and how far in. */
  title?: string
  count?: string
  said: string[]
  task?: string
  thinking?: boolean
  silent?: boolean
  /** Anything that belongs inside the coach panel (an install notice). */
  coachFoot?: ReactNode
  /** A real move list, or nothing at all. */
  moves?: { startFen: string; sans: string[]; current?: number }
  /** Extra sections between the coach and the chapter list. */
  extras?: ReactNode
}

export function Scene({
  env,
  board,
  boardLabel,
  labels,
  turn,
  actions,
  title,
  count,
  said,
  task,
  thinking,
  silent,
  coachFoot,
  moves,
  extras
}: SceneProps): JSX.Element {
  const chrome = useContext(ChromeCtx)
  // The readout's NEXT is the task the learner has actually been given, and its
  // trace is whatever proportion the screen around this one can stand behind.
  useReadoutSlot(task ?? null, chrome.trace ?? null)

  return (
    <div className="lesson">
      <div className="lesson-main">
        <div className="board-area">
          {chrome.head}

          <div className="board-stage">
            <div
              className={env.boardClass}
              role={boardLabel ? 'img' : undefined}
              aria-label={boardLabel}
            >
              {board}
              {labels && labels.length > 0 && (
                <div className="sch-labels" aria-hidden>
                  {labels.map((l, i) => (
                    <span
                      key={`${l.text}-${i}`}
                      className={`sch-label is-${l.color}`}
                      style={{ left: `${l.leftPct}%`, top: `${l.topPct}%` }}
                    >
                      {l.text}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {(turn || actions) && (
            <div className="boardbar">
              {turn}
              {actions}
            </div>
          )}
        </div>
      </div>

      <aside className="side">
        <section className="sec">
          {title && (
            <div className="sec-head">
              <h2 className="lbl">{title}</h2>
              {count && <span className="sec-count">{count}</span>}
            </div>
          )}
          <Coach said={said} task={task} thinking={thinking} silent={silent}>
            {coachFoot}
          </Coach>
        </section>

        {moves && <MoveSection {...moves} />}
        {extras}
        {chrome.side}
      </aside>
    </div>
  )
}

/** The boardbar's left half: a chip in the colour to move, then the words. */
export function Turn({ color, note }: { color: 'white' | 'black'; note?: string }): JSX.Element {
  return (
    <div className="turn">
      <span className={`turn-chip${color === 'black' ? ' sch-turn-b' : ''}`} />
      {`${color === 'white' ? 'White to move' : 'Black to move'}${note ? ` · ${note}` : ''}`}
    </div>
  )
}
