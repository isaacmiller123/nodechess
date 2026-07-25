// Shared lesson-segment renderers used by both the legacy single-`segments`
// chapter flow (ChapterPlayer) and the new lesson player (LessonPlayer).
//
// Every renderer takes a normalized prop shape so it doesn't care whether it was
// fed a legacy SchoolSegment or a new LessonSegment. The five kinds:
//   teach:    Viktor narrates a position; "Next" walks the steps.
//   guided:   interactive; the learner plays one of step.solutionUci.
//   model:    walk through a commented line move-by-move.
//   puzzle:   solve query.count puzzles pulled from the bundled DB (skippable).
//   boss:     beat a rating-capped engine, then a Viktor debrief.
//
// IMPORTANT (React #300): in every component, ALL hooks run before any early
// return. We never short-circuit above a hook.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { Key } from 'chessground/types'
import type { Role } from 'chessops/types'
import {
  ChevronRight,
  RotateCcw,
  Flag,
  Trophy,
  SkipForward,
  CheckCircle2,
  Lightbulb
} from 'lucide-react'
import type {
  CoachLine,
  Puzzle,
  PuzzleQuery,
  SchoolDebrief,
  SchoolDebriefMove,
  SchoolStep
} from '@shared/types'
import { Board } from '../../board/Board'
import { PromotionPicker } from '../../board/PromotionPicker'
import {
  applyMove,
  checkColor,
  destsFor,
  outcome,
  turnColor,
  uciToLastMove,
  type Color
} from '../../chess/chess'
import { chooseBotMove } from '../../chess/botStrength'
import { useSettings } from '../../state/settings'
import { usePuzzlesReady } from '../../hooks/useEngineReady'
import { PuzzlesRequiredNotice } from '../../components/EngineRequiredNotice'
import {
  annotationLabels,
  annotationsToShapes,
  hintShapes,
  SCHOOL_BRUSHES,
  type AnnotationLabel,
  type SchoolHintStage
} from './annotations'
import { ViktorPanel } from './ViktorPanel'
import './school-play.css'

export const ROLE_FROM_CHAR: Record<string, Role> = {
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight'
}

export const EMPTY_DESTS = new Map<Key, Key[]>()

/** Board-display settings threaded into every segment. */
export interface BoardEnv {
  boardClass: string
  coordinates: boolean
  animation: boolean
  showDests: boolean
}

/** Deterministic pick keyed off a stable id, so Viktor's phrasing varies across
 *  puzzles/steps but never flickers between renders of the same one. */
export function hashPick<T>(arr: T[], key: string): T {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return arr[(h >>> 0) % arr.length]
}

/** Labels for the shared 3-stage hint ladder (School puzzles + guided steps). */
const HINT_LABEL: Record<SchoolHintStage, string> = {
  0: 'Hint',
  1: 'Hint: which square it leaves',
  2: 'Hint: show the move',
  3: 'No more help'
}

/** Viktor's aside for each hint stage (shown in the panel as the stage bumps). */
const HINT_LINE: Record<Exclude<SchoolHintStage, 0>, string> = {
  1: 'Watch the glowing piece. It is the one that matters.',
  2: 'It moves from the circled square. Now find where to.',
  3: 'There is the move. Play it, and understand why.'
}

// ===========================================================================
// MOVE STRIP: compact SAN history shown under School boards (boss games,
// placement games, model lines, debriefs). Numbered pairs, current move
// highlighted, auto-scrolls to keep the current move in view.
// ===========================================================================

interface StripCell {
  san: string
  idx: number
}
interface StripPair {
  no: number
  white?: StripCell
  black?: StripCell
}

export function MoveStrip({
  startFen,
  sans,
  current,
  className
}: {
  /** Position the game/line starts from (numbering + side-to-move derive from it). */
  startFen: string
  /** SAN moves in play order. */
  sans: string[]
  /** Index into `sans` to highlight; defaults to the last move. Negative = none. */
  current?: number
  className?: string
}): JSX.Element | null {
  const cur = current ?? sans.length - 1
  const activeRef = useRef<HTMLSpanElement | null>(null)

  // Keep the current move visible as the game grows / the debrief walks.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [cur, sans.length])

  // Hooks above: safe to bail now (#300).
  if (sans.length === 0) return null

  const parts = startFen.split(' ')
  const blackFirst = parts[1] === 'b'
  let no = Number.parseInt(parts[5] ?? '1', 10)
  if (!Number.isFinite(no) || no < 1) no = 1

  const pairs: StripPair[] = []
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

  const cell = (m: StripCell): JSX.Element => (
    <span
      ref={m.idx === cur ? activeRef : undefined}
      className={`school-moves-move${m.idx === cur ? ' is-current' : ''}`}
    >
      {m.san}
    </span>
  )

  return (
    <div className={`school-moves${className ? ` ${className}` : ''}`} aria-label="Moves played">
      {pairs.map((p) => (
        <span className="school-moves-pair" key={p.no}>
          <span className="school-moves-num num">{p.no}.</span>
          {p.white ? cell(p.white) : <span className="school-moves-move is-gap">…</span>}
          {p.black && cell(p.black)}
        </span>
      ))}
    </div>
  )
}

// ===========================================================================
// TEACH: Viktor narrates a position; annotations painted; "Next" advances.
// ===========================================================================

export function TeachSegment({
  steps,
  title,
  env,
  onDone
}: {
  steps: SchoolStep[]
  title: string
  env: BoardEnv
  onDone: () => void
}): JSX.Element {
  const [stepIdx, setStepIdx] = useState(0)

  const step: SchoolStep | undefined = steps[stepIdx]
  const isLast = stepIdx >= steps.length - 1
  // The STEP fen is the board (a coach line may pin its own via CoachLine.fen;
  // same contract the debrief uses; fall back to the step's position).
  const fen = step?.coach.fen ?? step?.fen ?? ''
  const orientation: Color = useMemo(() => (fen ? turnColor(fen) : 'white'), [fen])
  const check = useMemo(() => (fen ? checkColor(fen) : undefined), [fen])
  const shapes = useMemo(() => annotationsToShapes(step?.coach.annotations), [step])
  const labels = useMemo(
    () => annotationLabels(step?.coach.annotations, orientation),
    [step, orientation]
  )

  // Empty teach segment: advance once on mount.
  useEffect(() => {
    if (!step) onDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  if (!step) return <div className="school-stage" aria-hidden />

  return (
    <div className="school-stage">
      <BoardFrame env={env} labels={labels}>
        <Board
          fen={fen}
          orientation={orientation}
          turnColor={orientation}
          dests={EMPTY_DESTS}
          viewOnly
          check={check}
          shapes={shapes}
          brushes={SCHOOL_BRUSHES}
          coordinates={env.coordinates}
          animation={env.animation}
          // Steps can share a fen while their square-cues change; the nonce
          // forces the shape re-sync (Board only hashes orig/dest/brush).
          syncNonce={stepIdx}
        />
      </BoardFrame>

      <ViktorPanel text={step.coach.text} eyebrow={title}>
        <div className="school-step-meta">
          <span className="school-step-count">
            {stepIdx + 1} / {steps.length}
          </span>
        </div>
        <button
          className="btn school-primary"
          onClick={() => {
            if (isLast) onDone()
            else setStepIdx((i) => i + 1)
          }}
        >
          {isLast ? 'Continue' : 'Next'} <ChevronRight size={16} />
        </button>
      </ViktorPanel>
    </div>
  )
}

// ===========================================================================
// GUIDED: board interactive; user must play one of step.solutionUci.
// ===========================================================================

type GuidedPhase = 'solving' | 'solved'

export function GuidedSegment({
  steps,
  title,
  env,
  onDone
}: {
  steps: SchoolStep[]
  title: string
  env: BoardEnv
  onDone: () => void
}): JSX.Element {
  const { settings } = useSettings()
  const [stepIdx, setStepIdx] = useState(0)
  const step: SchoolStep | undefined = steps[stepIdx]
  const isLast = stepIdx >= steps.length - 1

  const [phase, setPhase] = useState<GuidedPhase>('solving')
  const [boardFen, setBoardFen] = useState(step?.fen ?? '')
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>(undefined)
  const [line, setLine] = useState<CoachLine | null>(step?.coach ?? null)
  const [wrong, setWrong] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [hintStage, setHintStage] = useState<SchoolHintStage>(0)

  // Reset interaction state when the step changes.
  useEffect(() => {
    setPhase('solving')
    setBoardFen(step?.fen ?? '')
    setLastMove(undefined)
    setLine(step?.coach ?? null)
    setWrong(false)
    setHintStage(0)
    setNonce((n) => n + 1)
  }, [step])

  useEffect(() => {
    if (!step) onDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  const baseFen = step?.fen ?? ''
  // While solving the INTERACTIVE fen is the board; once resolved, a coach line
  // may pin its own position via CoachLine.fen (same contract as the debrief).
  const displayFen = phase !== 'solving' && line?.fen ? line.fen : boardFen
  const orientation: Color = useMemo(() => (baseFen ? turnColor(baseFen) : 'white'), [baseFen])
  const dests = useMemo(
    () => (phase === 'solving' && baseFen ? destsFor(boardFen) : EMPTY_DESTS),
    [phase, baseFen, boardFen]
  )
  const turn = useMemo(() => (displayFen ? turnColor(displayFen) : 'white'), [displayFen])
  const check = useMemo(
    () => (displayFen ? checkColor(displayFen) : undefined),
    [displayFen]
  )

  const solutions = step?.solutionUci ?? []
  const hintUci = solutions[0] ?? ''
  const shapes = useMemo(() => {
    const out = annotationsToShapes(line?.annotations)
    if (phase === 'solving' && hintStage > 0 && hintUci && settings.hintsEnabled) {
      out.push(...hintShapes(hintUci, hintStage))
    }
    return out
  }, [line, phase, hintStage, hintUci, settings.hintsEnabled])
  const labels = useMemo(
    () => annotationLabels(line?.annotations, orientation),
    [line, orientation]
  )

  // A gentle nudge, three stages deep (glow -> circle -> arrow). The nonce bump
  // forces the board's shape re-sync (customSvg shapes hash by square only).
  const bumpHint = useCallback(() => {
    if (!settings.hintsEnabled) return
    if (phase !== 'solving' || hintStage >= 3) return
    const next = (hintStage + 1) as SchoolHintStage
    setHintStage(next)
    setNonce((n) => n + 1)
    if (next !== 0) setLine((l) => ({ ...(l ?? { text: '' }), text: HINT_LINE[next] }))
  }, [phase, hintStage, settings.hintsEnabled])

  const onUserMove = useCallback(
    (orig: Key, dest: Key) => {
      if (!step || phase !== 'solving') return
      const plain = `${orig}${dest}`
      // Match on from/to only: the board has no promotion picker, so the solution
      // itself supplies the promotion piece (underpromotions like 'f2g1n' included).
      const matched = solutions.find((sol) => sol.slice(0, 4) === plain)

      if (matched) {
        const promo = matched.length > 4 ? ROLE_FROM_CHAR[matched[4]] : undefined
        const applied = applyMove(boardFen, orig, dest, promo)
        if (applied) {
          setBoardFen(applied.fen)
          setLastMove(uciToLastMove(applied.uci))
        }
        setPhase('solved')
        setWrong(false)
        setLine(step.successLine ?? { text: 'Correct.' })
        if (step.conceptId) {
          void window.api?.school?.recordConcept({ conceptId: step.conceptId, correct: true })
        }
        return
      }

      setWrong(true)
      setLine(step.retryLine ?? { text: 'No. Look again.' })
      setBoardFen(step.fen)
      setLastMove(undefined)
      setNonce((n) => n + 1)
    },
    [step, phase, boardFen, solutions]
  )

  const reset = useCallback(() => {
    if (!step) return
    setPhase('solving')
    setBoardFen(step.fen)
    setLastMove(undefined)
    setLine(step.coach)
    setWrong(false)
    setHintStage(0)
    setNonce((n) => n + 1)
  }, [step])

  const advance = useCallback(() => {
    if (isLast) onDone()
    else setStepIdx((i) => i + 1)
  }, [isLast, onDone])

  if (!step) return <div className="school-stage" aria-hidden />

  return (
    <div className="school-stage">
      <BoardFrame env={env} labels={labels}>
        <Board
          fen={displayFen}
          orientation={orientation}
          turnColor={turn}
          dests={dests}
          movableColor={orientation}
          viewOnly={phase !== 'solving'}
          lastMove={lastMove}
          check={check}
          shapes={shapes}
          brushes={SCHOOL_BRUSHES}
          showDests={env.showDests}
          coordinates={env.coordinates}
          animation={env.animation}
          onMove={onUserMove}
          syncNonce={nonce}
        />
      </BoardFrame>

      <ViktorPanel
        text={line?.text ?? step.coach.text}
        eyebrow={title}
        tone={phase === 'solved' ? 'pleased' : wrong ? 'stern' : undefined}
      >
        <div className="school-step-meta">
          <span className="school-step-count">
            {stepIdx + 1} / {steps.length}
          </span>
          {phase === 'solving' && (
            <span className={`school-tag ${wrong ? 'is-wrong' : 'is-task'}`}>
              {wrong ? 'Try again' : 'Your move'}
            </span>
          )}
          {phase === 'solved' && <span className="school-tag is-good">Solved</span>}
        </div>

        {phase === 'solving' && (
          <div className="school-play-row">
            {settings.hintsEnabled && (
              <button
                className="btn ghost school-hint-btn"
                onClick={bumpHint}
                disabled={hintStage >= 3 || !hintUci}
                title="A gentle hint"
              >
                <Lightbulb size={15} /> {HINT_LABEL[hintStage]}
              </button>
            )}
            <button className="btn ghost school-secondary" onClick={reset}>
              <RotateCcw size={16} /> Reset
            </button>
          </div>
        )}
        {phase === 'solved' && (
          <button className="btn school-primary" onClick={advance}>
            {isLast ? 'Continue' : 'Next'} <ChevronRight size={16} />
          </button>
        )}
      </ViktorPanel>
    </div>
  )
}

// ===========================================================================
// MODEL: walk through a commented line move-by-move with "Next".
// ===========================================================================

interface ModelFrame {
  fen: string
  lastMove?: [Key, Key]
  coach?: CoachLine
  /** SAN of the move that produced this frame (absent on frame 0). */
  san?: string
}

export function ModelSegment({
  startFen,
  line,
  title,
  intro,
  env,
  onDone
}: {
  /** Position the line starts from. */
  startFen: string
  line: { uci: string; coach?: CoachLine }[]
  title: string
  intro?: CoachLine
  env: BoardEnv
  onDone: () => void
}): JSX.Element {
  // Pre-roll the whole line into a list of frames once (frame 0 = intro position).
  const frames = useMemo<ModelFrame[]>(() => {
    const out: ModelFrame[] = [{ fen: startFen, coach: intro }]
    let fen = startFen
    for (const mv of line) {
      const applied = applyMove(fen, mv.uci.slice(0, 2), mv.uci.slice(2, 4), promoOf(mv.uci))
      if (!applied) break
      fen = applied.fen
      out.push({ fen, lastMove: uciToLastMove(applied.uci), coach: mv.coach, san: applied.san })
    }
    return out
  }, [startFen, line, intro])

  const [idx, setIdx] = useState(0)
  const frame = frames[idx] ?? frames[0]
  const isLast = idx >= frames.length - 1

  // A frame's coach line may pin a different position (CoachLine.fen contract);
  // otherwise the walked line's own frame fen is shown. Drop the lastMove
  // highlight when the pinned board isn't the frame's position.
  const shownFen = frame?.coach?.fen ?? frame?.fen ?? ''
  const shownLastMove =
    frame?.coach?.fen && frame.coach.fen !== frame.fen ? undefined : frame?.lastMove

  const sans = useMemo(() => frames.slice(1).map((f) => f.san ?? '·'), [frames])

  const orientation: Color = useMemo(
    () => (startFen ? turnColor(startFen) : 'white'),
    [startFen]
  )
  const turn = useMemo(() => (shownFen ? turnColor(shownFen) : 'white'), [shownFen])
  const check = useMemo(() => (shownFen ? checkColor(shownFen) : undefined), [shownFen])
  const shapes = useMemo(() => annotationsToShapes(frame?.coach?.annotations), [frame])
  const labels = useMemo(
    () => annotationLabels(frame?.coach?.annotations, orientation),
    [frame, orientation]
  )

  if (!frame) {
    return <div className="school-stage" aria-hidden />
  }

  return (
    <div className="school-stage">
      <BoardFrame
        env={env}
        labels={labels}
        below={<MoveStrip startFen={startFen} sans={sans} current={idx - 1} />}
      >
        <Board
          fen={shownFen}
          orientation={orientation}
          turnColor={turn}
          dests={EMPTY_DESTS}
          viewOnly
          lastMove={shownLastMove}
          check={check}
          shapes={shapes}
          brushes={SCHOOL_BRUSHES}
          coordinates={env.coordinates}
          animation={env.animation}
          syncNonce={idx}
        />
      </BoardFrame>

      <ViktorPanel
        text={frame.coach?.text ?? 'Watch the line.'}
        eyebrow={title}
      >
        <div className="school-step-meta">
          <span className="school-step-count">
            Move {idx} / {frames.length - 1}
          </span>
          <span className="school-tag is-task">Model line</span>
        </div>
        {idx > 0 && (
          <button className="btn ghost school-secondary" onClick={() => setIdx((i) => i - 1)}>
            <RotateCcw size={16} /> Back
          </button>
        )}
        <button
          className="btn school-primary"
          onClick={() => {
            if (isLast) onDone()
            else setIdx((i) => i + 1)
          }}
        >
          {isLast ? 'Continue' : 'Next move'} <ChevronRight size={16} />
        </button>
      </ViktorPanel>
    </div>
  )
}

// ===========================================================================
// PUZZLE: solve query.count puzzles from the bundled DB (skippable).
// ===========================================================================

type PzPhase = 'loading' | 'solving' | 'solved' | 'failed' | 'empty'

export function PuzzleSegment({
  query,
  title,
  intro,
  env,
  onDone,
  onOpenSettings
}: {
  query: PuzzleQuery
  title: string
  intro?: CoachLine
  env: BoardEnv
  onDone: () => void
  /** Deep link to Settings → Datasets for the puzzle-DB install notice. */
  onOpenSettings?: () => void
}): JSX.Element {
  const { settings } = useSettings()
  const count = Math.max(1, query.count)
  // Hand-authored boards need no DB; everything else pulls from the imported
  // puzzles.sqlite. Probe its presence so a fresh install renders the honest
  // "download it in Settings" notice instead of a fake puzzle (the empty-fen
  // board reads as the START POSITION under the segment's 'mate in one' intro).
  const authoredCount = query.boards?.length ?? 0
  const { ready: puzzlesReady } = usePuzzlesReady(authoredCount === 0)

  const [solvedCount, setSolvedCount] = useState(0)
  const [phase, setPhase] = useState<PzPhase>('loading')
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null)
  const [fen, setFen] = useState('')
  const [orientation, setOrientation] = useState<Color>('white')
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const [hintStage, setHintStage] = useState<SchoolHintStage>(0)
  const [feedback, setFeedback] = useState<CoachLine>(
    intro ?? { text: 'Warm up. Solve a few before we continue.' }
  )

  const solIdxRef = useRef(1)
  const excludeRef = useRef<string[]>([])
  const tokenRef = useRef(0)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  // Read inside loadPuzzle via a ref so loadPuzzle's identity stays stable across
  // advances: otherwise bumping solvedCount would recreate it and re-fire the mount
  // effect, double-loading a puzzle on every "Next puzzle".
  const solvedCountRef = useRef(0)

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t)
    timersRef.current = []
  }, [])

  // ---- Load one puzzle: hand-authored boards if provided, else the DB. ----
  const loadPuzzle = useCallback(() => {
    clearTimers()
    const token = ++tokenRef.current
    setPhase('loading')
    setPuzzle(null)
    setLastMove(undefined)
    setHintStage(0)
    solIdxRef.current = 1

    const api = window.api?.puzzles
    const authored = query.boards
    if (!api && !(authored && authored.length)) {
      setPhase('empty')
      return
    }
    const themes = query.themes.length > 0 ? query.themes : [undefined]

    // Authored boards (foundation chapters): the DB floor is mate-dominated, so these
    // chapters ship clean single-capture positions. Serve them in order, skipping any
    // already shown this session; convert to the Puzzle shape the solve loop expects.
    const pickAuthored = (): Puzzle | null => {
      if (!authored || authored.length === 0) return null
      const seen = new Set(excludeRef.current)
      const board =
        authored.find((b) => !seen.has(b.id)) ?? authored[solvedCountRef.current % authored.length]
      return {
        id: board.id,
        fen: board.fen,
        moves: board.moves,
        rating: board.rating ?? query.ratingLo,
        themes: query.themes,
        openingTags: []
      }
    }

    // Try each theme in the OR-set until one yields an unseen puzzle.
    const tryThemes = async (): Promise<Puzzle | null> => {
      const fromAuthored = pickAuthored()
      if (fromAuthored) return fromAuthored
      if (!api) return null
      for (const theme of themes) {
        const r = await api
          .next({
            theme: theme as string | undefined,
            ratingLo: query.ratingLo,
            ratingHi: query.ratingHi,
            exclude: excludeRef.current
          })
          .catch(() => ({ puzzle: null }))
        if (r?.puzzle) return r.puzzle
      }
      return null
    }

    void tryThemes().then((next) => {
      if (tokenRef.current !== token) return
      if (!next) {
        setPhase('empty')
        return
      }
      excludeRef.current.push(next.id)
      if (excludeRef.current.length > 60) excludeRef.current.shift()

      // Lead-in: show the position, then animate the opponent's first move.
      const m0 = next.moves[0]
      const shown = m0
        ? applyMove(next.fen, m0.slice(0, 2), m0.slice(2, 4), promoOf(m0))
        : null
      if (!shown) {
        setPhase('empty')
        return
      }
      setPuzzle(next)
      setFen(next.fen)
      setOrientation(turnColor(shown.fen))
      setLastMove(undefined)
      setNonce((n) => n + 1)
      setPhase('loading')
      const t = setTimeout(() => {
        if (tokenRef.current !== token) return
        setFen(shown.fen)
        setLastMove(uciToLastMove(shown.uci))
        solIdxRef.current = 1
        setPhase('solving')
        setFeedback({
          text: hashPick(
            [
              'Your move. Find the idea.',
              'Your move. Look for what is undefended.',
              'Your move. Something in his camp is loose. Find it.'
            ],
            next.id
          )
        })
      }, 360)
      timersRef.current.push(t)
    })
  }, [clearTimers, query.themes, query.ratingLo, query.ratingHi, query.boards])

  // Load the first puzzle on mount; clean up timers on unmount.
  useEffect(() => {
    loadPuzzle()
    return clearTimers
  }, [loadPuzzle, clearTimers])

  const dests = useMemo(
    () => (phase === 'solving' && fen ? destsFor(fen) : EMPTY_DESTS),
    [phase, fen]
  )
  const turn = useMemo(() => (fen ? turnColor(fen) : 'white'), [fen])
  const check = useMemo(() => (fen ? checkColor(fen) : undefined), [fen])

  // Hint ladder shapes against the NEXT expected solution move. `fen` is in the
  // deps because solIdxRef advances together with every fen change.
  const puzzleShapes = useMemo(() => {
    if (phase !== 'solving' || hintStage === 0 || !puzzle || !settings.hintsEnabled) return []
    const expected = puzzle.moves[solIdxRef.current]
    return expected ? hintShapes(expected, hintStage) : []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, hintStage, puzzle, fen, settings.hintsEnabled])

  const bumpHint = useCallback(() => {
    if (!settings.hintsEnabled) return
    if (phase !== 'solving' || hintStage >= 3) return
    const next = (hintStage + 1) as SchoolHintStage
    setHintStage(next)
    setNonce((n) => n + 1)
    if (next !== 0) setFeedback({ text: HINT_LINE[next] })
  }, [phase, hintStage, settings.hintsEnabled])

  const recordAttempt = useCallback(
    (p: Puzzle, solved: boolean) => {
      // Hand-authored teaching boards aren't real DB puzzles. Don't log them to
      // the puzzle-rating system (their ids don't exist there).
      if (query.boards && query.boards.some((b) => b.id === p.id)) return
      void window.api?.puzzles
        ?.attempt({ puzzleId: p.id, puzzleRating: p.rating, solved })
        .catch(() => {})
    },
    [query.boards]
  )

  const advanceCount = useCallback(() => {
    const n = solvedCount + 1
    solvedCountRef.current = n
    setSolvedCount(n)
    if (n >= count) {
      onDone()
    } else {
      loadPuzzle()
    }
  }, [solvedCount, count, onDone, loadPuzzle])

  const onUserMove = useCallback(
    (orig: Key, dest: Key) => {
      if (phase !== 'solving' || !puzzle) return
      const idx = solIdxRef.current
      const expected = puzzle.moves[idx]
      if (!expected) return

      const candidate = `${orig}${dest}`
      const isPromo = expected.length === 5
      const matches = expected === candidate || (isPromo && expected.slice(0, 4) === candidate)

      if (!matches) {
        const played = applyMove(fen, orig, dest)
        if (!played) {
          setNonce((n) => n + 1)
          return
        }
        // Legal but wrong: count as failed, reveal the right move, allow moving on.
        const right = applyMove(fen, expected.slice(0, 2), expected.slice(2, 4), promoOf(expected))
        setLastMove(uciToLastMove(expected))
        setNonce((n) => n + 1)
        setPhase('failed')
        setFeedback({
          text: right?.san
            ? `Not quite. The move was ${right.san}. Reset and try, or move on.`
            : 'Not quite. Reset and try again, or move on.'
        })
        recordAttempt(puzzle, false)
        return
      }

      // Correct user move.
      const userMove = applyMove(fen, expected.slice(0, 2), expected.slice(2, 4), promoOf(expected))
      if (!userMove) {
        setNonce((n) => n + 1)
        return
      }
      setFen(userMove.fen)
      setLastMove(uciToLastMove(userMove.uci))
      setHintStage(0) // each ply earns its own hints
      const nextIdx = idx + 1
      solIdxRef.current = nextIdx

      if (nextIdx >= puzzle.moves.length) {
        setPhase('solved')
        setFeedback({
          text: hashPick(
            ['Correct. Good eye.', 'Yes. Clean.', 'Good. You are seeing it faster now.'],
            puzzle.id
          )
        })
        recordAttempt(puzzle, true)
        return
      }

      // Auto-reply.
      const replyUci = puzzle.moves[nextIdx]
      const t = setTimeout(() => {
        const reply = applyMove(
          userMove.fen,
          replyUci.slice(0, 2),
          replyUci.slice(2, 4),
          promoOf(replyUci)
        )
        if (!reply) return
        setFen(reply.fen)
        setLastMove(uciToLastMove(reply.uci))
        solIdxRef.current = nextIdx + 1
      }, 340)
      timersRef.current.push(t)
    },
    [phase, puzzle, fen, recordAttempt]
  )

  const retry = useCallback(() => {
    if (!puzzle) return
    clearTimers()
    const m0 = puzzle.moves[0]
    const shown = m0 ? applyMove(puzzle.fen, m0.slice(0, 2), m0.slice(2, 4), promoOf(m0)) : null
    if (!shown) return
    setFen(shown.fen)
    setLastMove(uciToLastMove(shown.uci))
    solIdxRef.current = 1
    setPhase('solving')
    setHintStage(0)
    setNonce((n) => n + 1)
    setFeedback({ text: 'Again. Your move.' })
  }, [puzzle, clearTimers])

  const isLastPuzzle = solvedCount + 1 >= count

  // Nothing to solve. All hooks above have run, safe to branch (#300). Two
  // honest states, NEITHER of which renders a board (an empty-fen board shows
  // the standard START POSITION, which under a "mate in one" intro reads as a
  // fake puzzle, spec: never fake content):
  //   • fresh install, puzzle DB absent → the Settings → Datasets install card;
  //   • DB present but the query matched nothing → skip with plain copy.
  if (phase === 'empty') {
    const dbMissing = authoredCount === 0 && puzzlesReady === false
    return (
      <div className="school-stage school-stage-single">
        <ViktorPanel
          text={
            dbMissing
              ? 'No drills today. The puzzle database is not installed on this machine. Fetch it in Settings, or we move on.'
              : 'No puzzles matched this drill. We move on. You lose nothing.'
          }
          eyebrow={title}
          thinking={authoredCount === 0 && puzzlesReady === null}
        >
          {dbMissing && <PuzzlesRequiredNotice onOpenSettings={onOpenSettings} />}
          <button className="btn school-primary" onClick={onDone}>
            Continue <ChevronRight size={16} />
          </button>
        </ViktorPanel>
      </div>
    )
  }

  return (
    <div className="school-stage">
      <BoardFrame env={env}>
        <Board
          fen={fen}
          orientation={orientation}
          turnColor={turn}
          dests={dests}
          movableColor={orientation}
          viewOnly={phase !== 'solving'}
          lastMove={lastMove}
          check={check}
          shapes={puzzleShapes}
          brushes={SCHOOL_BRUSHES}
          showDests={env.showDests}
          coordinates={env.coordinates}
          animation={env.animation}
          onMove={onUserMove}
          syncNonce={nonce}
        />
        {phase === 'loading' && <div className="school-board-skeleton" aria-hidden />}
      </BoardFrame>

      <ViktorPanel
        text={feedback.text}
        eyebrow={title}
        thinking={phase === 'loading'}
        tone={phase === 'solved' ? 'pleased' : phase === 'failed' ? 'stern' : undefined}
      >
        <div className="school-step-meta">
          <span className="school-step-count">
            Puzzle {Math.min(solvedCount + 1, count)} / {count}
          </span>
          {phase === 'solving' && <span className="school-tag is-task">Your move</span>}
          {phase === 'solved' && <span className="school-tag is-good">Solved</span>}
          {phase === 'failed' && <span className="school-tag is-wrong">Missed</span>}
        </div>

        {phase === 'solving' && settings.hintsEnabled && (
          <button
            className="btn ghost school-hint-btn"
            onClick={bumpHint}
            disabled={hintStage >= 3 || !puzzle}
            title="Hint"
          >
            <Lightbulb size={15} /> {HINT_LABEL[hintStage]}
          </button>
        )}
        {(phase === 'solved' || phase === 'failed') && (
          <button className="btn school-primary" onClick={advanceCount}>
            {isLastPuzzle ? 'Continue' : 'Next puzzle'} <ChevronRight size={16} />
          </button>
        )}
        {(phase === 'solving' || phase === 'failed') && (
          <button className="btn ghost school-secondary" onClick={retry} disabled={!puzzle}>
            <RotateCcw size={16} /> Reset
          </button>
        )}
        <button className="btn ghost school-skip" onClick={onDone}>
          <SkipForward size={15} /> Skip warm-up
        </button>
      </ViktorPanel>
    </div>
  )
}

// ===========================================================================
// BOSS: full game vs a rating-capped engine, then a Viktor debrief walk.
// ===========================================================================

type BossPhase = 'intro' | 'playing' | 'over' | 'debrief'

interface BossMoveLog {
  ply: number
  fenBefore: string
  played: string
  san: string
  byUser: boolean
}

export interface BossConfig {
  bossFen?: string
  bossEngineElo?: number
  bossUserColor?: 'white' | 'black'
  bossIntro?: CoachLine
}

export function BossSegment({
  chapterId,
  boss,
  title,
  env,
  onDone
}: {
  chapterId: string
  boss: BossConfig
  title: string
  env: BoardEnv
  /** Called after the debrief (or skip). Completion is recorded by the caller. */
  onDone: (won: boolean) => void
}): JSX.Element {
  const { settings } = useSettings()
  const userColor: Color = boss.bossUserColor ?? 'white'
  const startFen = boss.bossFen ?? ''
  const elo = boss.bossEngineElo ?? 1500

  const [phase, setPhase] = useState<BossPhase>('intro')
  const [fen, setFen] = useState(startFen)
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>(undefined)
  const [thinking, setThinking] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [result, setResult] = useState<{ won: boolean; reason: string } | null>(null)
  // Underpromotion picker for the boss game (only shown when autoQueen is off).
  const [pendingPromo, setPendingPromo] = useState<{ orig: Key; dest: Key } | null>(null)

  const movesRef = useRef<BossMoveLog[]>([])
  const plyRef = useRef(0)
  const finishedRef = useRef(false)

  const [debrief, setDebrief] = useState<SchoolDebrief | null>(null)
  const [debriefIdx, setDebriefIdx] = useState(0)
  const [debriefLoading, setDebriefLoading] = useState(false)

  const orientation = userColor
  const dests = useMemo(
    () => (phase === 'playing' && fen ? destsFor(fen) : EMPTY_DESTS),
    [phase, fen]
  )
  const turn = useMemo(() => (fen ? turnColor(fen) : 'white'), [fen])
  const check = useMemo(() => (fen ? checkColor(fen) : undefined), [fen])

  const finishGame = useCallback(
    async (won: boolean, reason: string) => {
      if (finishedRef.current) return
      finishedRef.current = true
      setResult({ won, reason })
      setPhase('over')

      const debriefMoves: SchoolDebriefMove[] = movesRef.current.map((m) => ({
        ply: m.ply,
        fenBefore: m.fenBefore,
        played: m.played,
        best: '',
        pv: [],
        evalBefore: { cp: null, mate: null },
        evalAfter: { cp: null, mate: null },
        byUser: m.byUser
      }))

      const api = window.api?.school
      if (api?.debrief) {
        setDebriefLoading(true)
        try {
          const d = await api.debrief({ chapterId, userColor, moves: debriefMoves })
          setDebrief(d ?? null)
          setDebriefIdx(0)
        } catch {
          setDebrief(null)
        } finally {
          setDebriefLoading(false)
        }
      }
    },
    [chapterId, userColor]
  )

  const pushMove = useCallback(
    (fenBefore: string, uci: string, san: string, byUser: boolean) => {
      plyRef.current += 1
      movesRef.current.push({ ply: plyRef.current, fenBefore, played: uci, san, byUser })
    },
    []
  )

  const commitUser = useCallback(
    (orig: string, dest: string, promo?: Role) => {
      const before = fen
      const applied = applyMove(before, orig, dest, promo)
      if (!applied) {
        setNonce((n) => n + 1)
        return
      }
      pushMove(before, applied.uci, applied.san, true)
      setFen(applied.fen)
      setLastMove(uciToLastMove(applied.uci))
      const out = outcome(applied.fen)
      if (out.over) {
        const won = out.result !== '1/2-1/2' && winnerIsUser(out.result, userColor)
        void finishGame(won, out.reason ?? 'draw')
      }
    },
    [fen, pushMove, finishGame, userColor]
  )

  const onUserMove = useCallback(
    (orig: Key, dest: Key) => {
      if (phase !== 'playing' || turn !== userColor) return
      if (isPromoMove(fen, orig, dest)) {
        // Respect the app-wide promotion preference: auto-queen goes straight
        // through; otherwise the picker offers the underpromotions too.
        if (settings.autoQueen) commitUser(orig, dest, 'queen')
        else setPendingPromo({ orig, dest })
        return
      }
      commitUser(orig, dest)
    },
    [phase, turn, userColor, fen, commitUser, settings.autoQueen]
  )

  const onPromoPick = useCallback(
    (role: Role) => {
      if (pendingPromo) commitUser(pendingPromo.orig, pendingPromo.dest, role)
      setPendingPromo(null)
    },
    [pendingPromo, commitUser]
  )

  const onPromoCancel = useCallback(() => {
    setPendingPromo(null)
    setNonce((n) => n + 1) // snap the dragged pawn back to its square
  }, [])

  // Engine reply loop: runs when it's the bot's turn.
  useEffect(() => {
    if (phase !== 'playing') return
    if (turn === userColor) return
    if (finishedRef.current) return
    const out = outcome(fen)
    if (out.over) {
      const won = out.result !== '1/2-1/2' && winnerIsUser(out.result, userColor)
      void finishGame(won, out.reason ?? 'draw')
      return
    }

    const engine = window.api?.engine
    if (!engine) return

    let cancelled = false
    setThinking(true)
    ;(async () => {
      const before = fen
      const uci = await chooseBotMove(before, elo, (req) => engine.play(req).catch(() => null))
      if (cancelled) return
      setThinking(false)
      if (finishedRef.current) return
      if (!uci) return
      const promo = uci.length > 4 ? ROLE_FROM_CHAR[uci[4]] : undefined
      const applied = applyMove(before, uci.slice(0, 2), uci.slice(2, 4), promo)
      if (!applied) return
      pushMove(before, applied.uci, applied.san, false)
      setFen(applied.fen)
      setLastMove(uciToLastMove(applied.uci))
      const after = outcome(applied.fen)
      if (after.over) {
        const won = after.result !== '1/2-1/2' && winnerIsUser(after.result, userColor)
        void finishGame(won, after.reason ?? 'draw')
      }
    })()

    return () => {
      cancelled = true
      // The cancelled path above skips setThinking(false): clear it here so
      // "thinking…" can't outlive the game (e.g. resign mid-think → Play again).
      setThinking(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, phase, userColor, elo])

  const startGame = useCallback(() => {
    movesRef.current = []
    plyRef.current = 0
    finishedRef.current = false
    setResult(null)
    setDebrief(null)
    setDebriefIdx(0)
    setFen(startFen)
    setLastMove(undefined)
    setPendingPromo(null)
    setNonce((n) => n + 1)
    void window.api?.engine?.newGame('play')
    setPhase('playing')
  }, [startFen])

  const resign = useCallback(() => {
    if (phase !== 'playing') return
    void finishGame(false, 'resignation')
  }, [phase, finishGame])

  // -------- INTRO --------
  if (phase === 'intro') {
    const introCheck = startFen ? checkColor(startFen) : undefined
    const introTurn: Color = startFen ? turnColor(startFen) : 'white'
    return (
      <div className="school-stage">
        <BoardFrame env={env}>
          <Board
            fen={startFen}
            orientation={orientation}
            turnColor={introTurn}
            dests={EMPTY_DESTS}
            viewOnly
            check={introCheck}
            coordinates={env.coordinates}
            animation={env.animation}
          />
        </BoardFrame>
        <ViktorPanel
          text={boss.bossIntro?.text ?? 'Now the test. Show me what you have learned.'}
          eyebrow={title}
        >
          <div className="school-boss-facts">
            <span className="school-tag is-boss">
              <Trophy size={14} /> Boss
            </span>
            <span className="muted small">
              You play {userColor} · opponent ≈ {elo} Elo
            </span>
          </div>
          <button className="btn school-primary" onClick={startGame}>
            Begin the test <ChevronRight size={16} />
          </button>
        </ViktorPanel>
      </div>
    )
  }

  // -------- DEBRIEF --------
  if (phase === 'debrief') {
    const lines = debrief?.lines ?? []
    const cur = lines[debriefIdx]
    const debriefShapes = annotationsToShapes(cur?.annotations)
    const isLastLine = debriefIdx >= lines.length - 1

    // THE BLANK-SQUARE FIX: each debrief line pins the position it discusses
    // (CoachLine.fen = fenBefore of that move). Show THAT board. Not the final
    // position, so Viktor's highlights/arrows land on occupied squares. Lines
    // without a fen (e.g. the closing verdict) fall back to the final board.
    const shownFen = cur?.fen ?? fen
    const log = movesRef.current
    const discussedIdx = cur?.fen ? log.findIndex((m) => m.fenBefore === cur.fen) : -1
    const discussed = discussedIdx >= 0 ? log[discussedIdx] : undefined
    // Highlight the move under discussion as the board's lastMove (it has not
    // been played on shownFen yet. The squares are the point, and Viktor's own
    // verdict-colored cues draw on top).
    const shownLastMove = cur?.fen
      ? discussed
        ? uciToLastMove(discussed.played)
        : undefined
      : lastMove
    const shownTurn: Color = shownFen ? turnColor(shownFen) : 'white'
    const shownCheck = shownFen ? checkColor(shownFen) : undefined
    const sans = log.map((m) => m.san)
    const stripCurrent = cur?.fen ? discussedIdx : sans.length - 1
    const debriefLabels = annotationLabels(cur?.annotations, orientation)

    return (
      <div className="school-stage">
        <BoardFrame
          env={env}
          labels={debriefLabels}
          below={<MoveStrip startFen={startFen} sans={sans} current={stripCurrent} />}
        >
          <Board
            fen={shownFen}
            orientation={orientation}
            turnColor={shownTurn}
            dests={EMPTY_DESTS}
            viewOnly
            lastMove={shownLastMove}
            check={shownCheck}
            shapes={debriefShapes}
            brushes={SCHOOL_BRUSHES}
            coordinates={env.coordinates}
            animation={env.animation}
            // Lines can annotate the same position twice; Board's shape hash
            // ignores customSvg, so the line index forces the re-sync.
            syncNonce={debriefIdx}
          />
        </BoardFrame>
        <ViktorPanel
          text={cur?.text ?? debrief?.verdict ?? 'That is the lesson.'}
          eyebrow={debrief?.verdict ? `Debrief: ${debrief.verdict}` : 'Debrief'}
        >
          {lines.length > 0 && (
            <div className="school-step-meta">
              <span className="school-step-count">
                {Math.min(debriefIdx + 1, lines.length)} / {lines.length}
              </span>
            </div>
          )}
          {!isLastLine && lines.length > 0 ? (
            <button className="btn school-primary" onClick={() => setDebriefIdx((i) => i + 1)}>
              Next <ChevronRight size={16} />
            </button>
          ) : (
            <button className="btn school-primary" onClick={() => onDone(result?.won ?? false)}>
              Finish lesson <ChevronRight size={16} />
            </button>
          )}
        </ViktorPanel>
      </div>
    )
  }

  // -------- PLAYING / OVER --------
  const over = phase === 'over'
  const gameSans = movesRef.current.map((m) => m.san)
  return (
    <div className="school-stage">
      <div className="school-board-col">
        <div className={env.boardClass}>
          <Board
            fen={fen}
            orientation={orientation}
            turnColor={turn}
            dests={dests}
            movableColor={userColor}
            viewOnly={phase !== 'playing'}
            lastMove={lastMove}
            check={check}
            showDests={env.showDests}
            coordinates={env.coordinates}
            animation={env.animation}
            onMove={onUserMove}
            syncNonce={nonce}
          />
          {phase === 'playing' && pendingPromo && (
            <PromotionPicker color={userColor} onSelect={onPromoPick} onCancel={onPromoCancel} />
          )}
        </div>
        <MoveStrip startFen={startFen} sans={gameSans} />
        {!over && (
          <div className="school-board-controls">
            <button className="btn ghost" onClick={resign} disabled={phase !== 'playing'}>
              <Flag size={16} /> Resign
            </button>
            {thinking && <span className="muted small">Viktor's champion is thinking…</span>}
          </div>
        )}
      </div>

      <ViktorPanel
        text={
          over
            ? result?.won
              ? 'Well played. You passed the test.'
              : 'The test is over. Now let us see what happened.'
            : ''
        }
        eyebrow={title}
        silent={!over}
        thinking={over && debriefLoading}
        tone={over ? (result?.won ? 'pleased' : 'neutral') : undefined}
      >
        {over && (
          <>
            <div className="school-boss-result">
              <span className={`school-tag ${result?.won ? 'is-good' : 'is-wrong'}`}>
                {result?.won ? 'Passed' : 'Not yet'}
              </span>
              <span className="muted small">{reasonLabel(result?.reason)}</span>
            </div>
            <button
              className="btn school-primary"
              disabled={debriefLoading}
              onClick={() => setPhase('debrief')}
            >
              {debriefLoading ? 'Viktor is reviewing…' : 'Hear Viktor’s debrief'}{' '}
              <ChevronRight size={16} />
            </button>
            <button className="btn ghost school-secondary" onClick={startGame}>
              <RotateCcw size={16} /> Play again
            </button>
            <button
              className="btn ghost school-skip"
              onClick={() => onDone(result?.won ?? false)}
            >
              <CheckCircle2 size={15} /> Skip debrief
            </button>
          </>
        )}
      </ViktorPanel>
    </div>
  )
}

// ===========================================================================
// Shared frame + helpers
// ===========================================================================

/** Large board column wrapper used by every static (non-control) segment.
 *  `below` renders under the board inside the column (e.g. a MoveStrip).
 *  `labels` render as readable pills positioned over the board: chessground's
 *  own shape labels shrink multi-word text to an unreadable dot. */
export function BoardFrame({
  env,
  children,
  below,
  labels
}: {
  env: BoardEnv
  children: React.ReactNode
  below?: React.ReactNode
  labels?: AnnotationLabel[]
}): JSX.Element {
  return (
    <div className="school-board-col">
      <div className={env.boardClass}>
        {children}
        {labels && labels.length > 0 && (
          <div className="school-ann-labels" aria-hidden>
            {labels.map((l, i) => (
              <span
                key={`${l.text}-${i}`}
                className={`school-ann-label is-${l.color}`}
                style={{ left: `${l.leftPct}%`, top: `${l.topPct}%` }}
              >
                {l.text}
              </span>
            ))}
          </div>
        )}
      </div>
      {below}
    </div>
  )
}

function promoOf(uci: string): Role | undefined {
  return uci.length > 4 ? ROLE_FROM_CHAR[uci[4]] : undefined
}


function reasonLabel(reason?: string): string {
  switch (reason) {
    case 'checkmate':
      return 'Checkmate'
    case 'resignation':
      return 'Resigned'
    case 'stalemate':
      return 'Stalemate'
    default:
      return 'Game over'
  }
}

export function winnerIsUser(result: string | undefined, userColor: Color): boolean {
  if (result === '1-0') return userColor === 'white'
  if (result === '0-1') return userColor === 'black'
  return false
}

export function isPromoMove(fen: string, orig: Key, dest: Key): boolean {
  try {
    const board = fen.split(' ')[0]
    const fromFile = orig.charCodeAt(0) - 97
    const fromRank = Number(orig[1])
    const toRank = Number(dest[1])
    if (toRank !== 8 && toRank !== 1) return false
    const ranks = board.split('/')
    const rowIdx = 8 - fromRank
    const row = ranks[rowIdx]
    if (!row) return false
    let file = 0
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch)
      } else {
        if (file === fromFile) return ch === 'P' || ch === 'p'
        file += 1
      }
    }
    return false
  } catch {
    return false
  }
}
