import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Role } from 'chessops/types'
import type { Key } from 'chessground/types'
import type { Puzzle } from '@shared/types'
import {
  applyMove,
  checkColor,
  destsFor,
  turnColor,
  uciToLastMove,
  INITIAL_FEN,
  type Color
} from '../../../chess/chess'
import { useSound } from '../../../sound'
// Type-only import: keeps our hint stage identical to the classic trainer's
// (and to what the shared <HintLadder> expects) without touching that file.
import type { HintStage } from '../usePuzzleSession'

// ============================================================================
// SLICE A: useCustomSession.  ★ OWNED BY THE CUSTOM-TRAINING BUILDER ★
//
// Drives a *fixed* training set: fetch the whole set once via
// window.api.puzzles.batch(), then walk it puzzle-by-puzzle with the same
// lead-in → solve → auto-reply convention usePuzzleSession uses for the
// adaptive trainer. Unlike Train mode there is no rating walk and no per-puzzle
// round-trip: the set is decided up front and we record each outcome with
// mode:'custom' (which feeds slice C's per-theme stats but does NOT move the
// Glicko ladder).
// ============================================================================

const ROLE_FROM_CHAR: Record<string, Role> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }

const LEADIN_MS = 380
const AUTO_REPLY_MS = 360
/** How long the solved/failed flash holds before we auto-advance to the next. */
const ADVANCE_MS = 850

function promoRole(uci: string): Role | undefined {
  return uci.length > 4 ? ROLE_FROM_CHAR[uci[4]] : undefined
}

/** A difficulty band -> rating window. Kept here so the setup UI and the fetch
 *  agree on one mapping. 'any' needs explicit wide bounds: an omitted window is
 *  defaulted to 600–2200 by the puzzles:batch handler (a train-mode default),
 *  which would cap "Any" below Hard's 2600. */
export type Band = 'easy' | 'medium' | 'hard' | 'any'

export const BANDS: { key: Band; label: string; sub: string; lo?: number; hi?: number }[] = [
  { key: 'easy', label: 'Easy', sub: '800–1400', lo: 800, hi: 1400 },
  { key: 'medium', label: 'Medium', sub: '1400–1900', lo: 1400, hi: 1900 },
  { key: 'hard', label: 'Hard', sub: '1900–2600', lo: 1900, hi: 2600 },
  { key: 'any', label: 'Any', sub: 'Full range', lo: 0, hi: 4000 }
]

export const SET_LENGTHS = [10, 20, 30] as const
export type SetLength = (typeof SET_LENGTHS)[number]

/** Solution-length filter, bucketed by the LEARNER's own moves (see the repo's
 *  batchPuzzles): 'short' 1–2, 'medium' 3–4, 'long' 5+, 'any' = no filter. */
export type SolutionLength = 'any' | 'short' | 'medium' | 'long'

export const SOLUTION_LENGTHS: { key: SolutionLength; label: string; sub: string }[] = [
  { key: 'any', label: 'Any', sub: 'All' },
  { key: 'short', label: 'Short', sub: '1–2 moves' },
  { key: 'medium', label: 'Medium', sub: '3–4 moves' },
  { key: 'long', label: 'Long', sub: '5+ moves' }
]

/** Minimum-popularity presets. The DB `Popularity` column is an up/down-vote
 *  balance (roughly -100..100); most puzzles sit high, so a modest floor mainly
 *  trims the disliked/ambiguous ones. */
export const POPULARITY_LEVELS: { key: string; label: string; value: number }[] = [
  { key: 'off', label: 'Any', value: -100 },
  { key: 'liked', label: 'Well-liked', value: 80 },
  { key: 'top', label: 'Top-rated', value: 90 }
]

export interface CustomConfig {
  themes: string[]
  band: Band
  count: SetLength
  /** Solution-length bucket ('any' = no filter). */
  length: SolutionLength
  /** Minimum popularity floor (matches a POPULARITY_LEVELS value; -100 = off). */
  minPopularity: number
  /** Skip puzzles the learner has already solved. */
  excludeSolved: boolean
}

/** Per-puzzle outcome captured as the user walks the set (drives the summary). */
export interface SolveRecord {
  id: string
  rating: number
  theme: string | null
  solved: boolean
  ms: number
}

/** Phase of the whole session. 'setup' = configuring; 'loading' = fetching the
 *  set; 'solving' = a puzzle is in play (board live); 'leadin' = animating the
 *  opponent's setup move; 'review' = the current puzzle is finished (solved or
 *  failed) and we're flashing feedback before advancing; 'summary' = the whole
 *  set is done; 'empty' = the batch came back with nothing to solve. */
export type CustomPhase =
  | 'setup'
  | 'loading'
  | 'leadin'
  | 'solving'
  | 'review'
  | 'summary'
  | 'empty'
  | 'error'

export interface CustomSummary {
  total: number
  solved: number
  /** 0..1 over attempted puzzles. */
  accuracy: number
  /** Total time spent solving, ms. */
  totalMs: number
  /** Longest run of solved puzzles within the set. */
  bestStreak: number
  /** The theme the user did worst on (lowest accuracy, ties broken by attempts),
   *  humanized-key + counts, or null when the set had no theme tags. */
  weakest: { theme: string; solved: number; attempts: number } | null
  /** The theme the user did best on, for a positive note. */
  strongest: { theme: string; solved: number; attempts: number } | null
}

export interface CustomSession {
  phase: CustomPhase
  apiReady: boolean
  config: CustomConfig
  setConfig: (patch: Partial<CustomConfig>) => void

  // Board state (mirrors usePuzzleSession's board contract for <Board>).
  fen: string
  orientation: Color
  turn: Color
  check: Color | undefined
  dests: Map<Key, Key[]>
  lastMove: [Key, Key] | undefined
  nonce: number

  // The puzzle currently in play and where we are in the set.
  puzzle: Puzzle | null
  index: number // 0-based index of the current puzzle
  total: number // set length actually fetched
  solvedCount: number
  streak: number
  bestStreak: number

  /** After a puzzle finishes: was it solved, and what was the right move (on fail)? */
  lastSolved: boolean | null
  correctSan: string | null

  /** Retry-on-wrong: true after the learner's first wrong move on this puzzle has
   *  been recorded as a fail while they keep trying (board reset, still solving).
   *  Drives the "Recorded as failed: keep trying" chip. */
  keepTrying: boolean

  /** 3-stage hint ladder (same contract as the classic trainer: 1 = show the
   *  piece, 2 = show the destination, 3 = reveal the SAN). Using a hint never
   *  changes attempt/streak accounting. Train-mode parity. */
  hintStage: HintStage
  hintFrom: Key | undefined
  hintTo: Key | undefined
  revealSan: string | null

  summary: CustomSummary | null

  // Actions
  start: () => void
  onUserMove: (orig: Key, dest: Key) => void
  /** Advance the hint ladder one stage (no-op unless solving). */
  bumpHint: () => void
  /** Skip the auto-advance delay and go to the next puzzle / summary now. */
  advance: () => void
  /** Retry the current puzzle from the top (no new attempt recorded). */
  retry: () => void
  /** Give up on the current puzzle and move on. If it wasn't already recorded
   *  (a clean skip with no prior wrong move), it's recorded as a fail first. */
  skip: () => void
  /** Reveal the full solution line, then advance. Records a fail if not already. */
  showSolution: () => void
  /** Abandon the in-progress set and return to the setup screen. */
  quit: () => void
  /** From the summary: replay the very same set of puzzles. */
  playAgain: () => void
  /** From the summary: go back to the setup screen to pick a new set. */
  newSet: () => void
}

/** camelCase / kebab theme key -> human label (mirrors ThemePicker.humanize). */
export function humanizeTheme(key: string): string {
  return key
    .replace(/[-_]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Credit an outcome to the drilled theme that matched this puzzle. Lichess
 *  tags list several themes and the drilled one is rarely first (a fork puzzle
 *  is often ['crushing','fork','short']), so prefer the configured theme and
 *  fall back to the puzzle's primary tag on mixed sets. */
function themeTagFor(configThemes: string[], p: Puzzle): string | null {
  return configThemes.find((t) => p.themes.includes(t)) ?? p.themes[0] ?? null
}

function computeSummary(records: SolveRecord[]): CustomSummary {
  const total = records.length
  const solved = records.reduce((n, r) => n + (r.solved ? 1 : 0), 0)
  const totalMs = records.reduce((n, r) => n + r.ms, 0)

  // Longest solved run.
  let best = 0
  let run = 0
  for (const r of records) {
    if (r.solved) {
      run += 1
      if (run > best) best = run
    } else {
      run = 0
    }
  }

  // Per-theme tallies (a puzzle is credited to one theme: the drilled theme
  // that matched it, else its primary tag. See themeTagFor).
  const byTheme = new Map<string, { solved: number; attempts: number }>()
  for (const r of records) {
    if (!r.theme) continue
    const t = byTheme.get(r.theme) ?? { solved: 0, attempts: 0 }
    t.attempts += 1
    if (r.solved) t.solved += 1
    byTheme.set(r.theme, t)
  }

  let weakest: CustomSummary['weakest'] = null
  let strongest: CustomSummary['strongest'] = null
  for (const [theme, t] of byTheme) {
    const acc = t.solved / t.attempts
    if (
      !weakest ||
      acc < weakest.solved / weakest.attempts ||
      (acc === weakest.solved / weakest.attempts && t.attempts > weakest.attempts)
    ) {
      weakest = { theme, solved: t.solved, attempts: t.attempts }
    }
    if (
      !strongest ||
      acc > strongest.solved / strongest.attempts ||
      (acc === strongest.solved / strongest.attempts && t.attempts > strongest.attempts)
    ) {
      strongest = { theme, solved: t.solved, attempts: t.attempts }
    }
  }
  // If every theme is tied (e.g. all solved), don't show a misleading "weakest".
  if (weakest && strongest && weakest.theme === strongest.theme) weakest = null
  // An all-failed theme is nothing to celebrate: never show "Strongest: X 0/5".
  if (strongest && strongest.solved === 0) strongest = null

  return {
    total,
    solved,
    accuracy: total > 0 ? solved / total : 0,
    totalMs,
    bestStreak: best,
    weakest,
    strongest
  }
}

export function useCustomSession(): CustomSession {
  const apiReady = typeof window !== 'undefined' && !!window.api
  const { play, playMove } = useSound()

  const [phase, setPhase] = useState<CustomPhase>('setup')
  const [config, setConfigState] = useState<CustomConfig>({
    themes: [],
    band: 'medium',
    count: 10,
    length: 'any',
    minPopularity: -100,
    excludeSolved: false
  })

  const [fen, setFen] = useState<string>(INITIAL_FEN)
  const [orientation, setOrientation] = useState<Color>('white')
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>(undefined)
  const [nonce, setNonce] = useState(0)

  const [puzzle, setPuzzle] = useState<Puzzle | null>(null)
  const [index, setIndex] = useState(0)
  const [total, setTotal] = useState(0)
  const [solvedCount, setSolvedCount] = useState(0)
  const [streak, setStreak] = useState(0)
  const [bestStreak, setBestStreak] = useState(0)
  const [lastSolved, setLastSolved] = useState<boolean | null>(null)
  const [correctSan, setCorrectSan] = useState<string | null>(null)
  const [hintStage, setHintStage] = useState<HintStage>(0)
  const [summary, setSummary] = useState<CustomSummary | null>(null)
  // Retry-on-wrong: once the learner's first wrong move is recorded as a fail we
  // stay in 'solving' and let them keep trying. This flags the "Recorded as
  // failed: keep trying" chip; it clears on the next puzzle / a full retry.
  const [keepTrying, setKeepTrying] = useState(false)

  // ---- Refs that async callbacks read without re-subscribing ----
  const setRef = useRef<Puzzle[]>([]) // the fixed set, in play order
  const indexRef = useRef(0)
  const solutionIdxRef = useRef(1) // next expected move in puzzle.moves
  // Retry-on-wrong: true once THIS index has been recorded as failed. Guards
  // against a second DB attempt / streak hit on further wrong tries, and marks a
  // later solve as "solved but already counted failed" (it advances, not counts).
  const failedRef = useRef(false)
  const startMsRef = useRef(0)
  const recordsRef = useRef<SolveRecord[]>([])
  const streakRef = useRef(0)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const tokenRef = useRef(0) // invalidates stale async work on quit/restart
  // Latest configured themes, readable inside stable callbacks without churning
  // their identity (recordAttempt tags outcomes with the drilled theme).
  const configThemesRef = useRef<string[]>(config.themes)
  configThemesRef.current = config.themes

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t)
    timersRef.current = []
  }, [])

  const schedule = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timersRef.current = timersRef.current.filter((x) => x !== t)
      fn()
    }, ms)
    timersRef.current.push(t)
  }, [])

  // Unmount cleanup: invalidate the token and drop pending timers so a queued
  // lead-in/auto-advance can't fire (and play sounds) into a dead session, e.g.
  // when switching tabs during the review flash.
  useEffect(
    () => () => {
      tokenRef.current += 1
      clearTimers()
    },
    [clearTimers]
  )

  // ---- Derived board state ----
  const dests = useMemo(() => {
    if (phase !== 'solving') return new Map<Key, Key[]>()
    return destsFor(fen)
  }, [fen, phase])
  const turn = useMemo(() => turnColor(fen), [fen])
  const check = useMemo(() => checkColor(fen), [fen])

  // ---- Hint ladder (mirrors usePuzzleSession's wiring exactly) ----
  const expectedUci =
    puzzle && phase === 'solving' ? puzzle.moves[solutionIdxRef.current] : undefined
  const hintFrom = hintStage >= 1 && expectedUci ? (expectedUci.slice(0, 2) as Key) : undefined
  const hintTo = hintStage >= 2 && expectedUci ? (expectedUci.slice(2, 4) as Key) : undefined
  const revealSan = useMemo(() => {
    if (hintStage < 3 || !expectedUci) return null
    const m = applyMove(fen, expectedUci.slice(0, 2), expectedUci.slice(2, 4), promoRole(expectedUci))
    return m?.san ?? null
  }, [hintStage, expectedUci, fen])

  const bumpHint = useCallback(() => {
    if (phase !== 'solving') return
    // Hints are free coaching, exactly like Train mode: the stage climbs, but
    // the eventual solve/fail is recorded (and streaked) the same either way.
    setHintStage((s) => (s < 3 ? ((s + 1) as HintStage) : s))
  }, [phase])

  const setConfig = useCallback((patch: Partial<CustomConfig>) => {
    setConfigState((c) => ({ ...c, ...patch }))
  }, [])

  // ---- Present puzzle at setRef.current[i]: animate the lead-in, then solve ----
  const presentRef = useRef<(i: number, token: number) => void>(() => {})
  presentRef.current = (i: number, token: number) => {
    clearTimers()
    const set = setRef.current
    if (i >= set.length) {
      // Set complete.
      setSummary(computeSummary(recordsRef.current))
      setPhase('summary')
      play('gameEnd')
      return
    }

    const p = set[i]
    indexRef.current = i
    setIndex(i)
    setPuzzle(p)
    setLastSolved(null)
    setCorrectSan(null)
    setHintStage(0)
    setKeepTrying(false)
    failedRef.current = false
    solutionIdxRef.current = 1

    const m0 = p.moves[0]
    const shown = m0 && m0.length >= 4 ? applyMove(p.fen, m0.slice(0, 2), m0.slice(2, 4), promoRole(m0)) : null
    if (!shown) {
      // Corrupt puzzle: count it as failed-without-time and skip on.
      recordsRef.current.push({
        id: p.id,
        rating: p.rating,
        theme: themeTagFor(configThemesRef.current, p),
        solved: false,
        ms: 0
      })
      presentRef.current(i + 1, token)
      return
    }

    // Show the pre-leadin position so chessground animates moves[0].
    setFen(p.fen)
    setLastMove(undefined)
    setOrientation(turnColor(shown.fen))
    setPhase('leadin')

    schedule(() => {
      if (tokenRef.current !== token) return
      setFen(shown.fen)
      setLastMove(uciToLastMove(shown.uci))
      playMove(shown)
      startMsRef.current = performance.now()
      setPhase('solving')
    }, LEADIN_MS)
  }

  // ---- Record an attempt to the DB (mode:'custom') + locally for the summary ----
  const recordAttempt = useCallback((p: Puzzle, solved: boolean, ms: number) => {
    const theme = themeTagFor(configThemesRef.current, p)
    recordsRef.current.push({ id: p.id, rating: p.rating, theme, solved, ms })
    const api = window.api?.puzzles
    if (!api) return
    void api
      .attempt({
        puzzleId: p.id,
        puzzleRating: p.rating,
        solved,
        ms,
        theme: theme ?? undefined,
        mode: 'custom'
      })
      .catch(() => {
        /* attempt logging is best-effort; never block the set */
      })
  }, [])

  // ---- Record the outcome for the CURRENT index exactly once (stats + streak) ----
  // Shared by the retry-on-wrong flow (first wrong move) and finishPuzzle. The
  // per-index guard is the same as before: a record exists for this index once
  // it's been counted (retry()/replays and further wrong tries must not re-count).
  const recordOutcomeOnce = useCallback(
    (p: Puzzle, solved: boolean) => {
      const alreadyCounted = recordsRef.current.length > indexRef.current
      if (alreadyCounted) return
      const ms = Math.round(performance.now() - startMsRef.current)
      recordAttempt(p, solved, ms)
      if (solved) {
        setSolvedCount((n) => n + 1)
        const ns = streakRef.current + 1
        streakRef.current = ns
        setStreak(ns)
        setBestStreak((b) => Math.max(b, ns))
      } else {
        failedRef.current = true
        streakRef.current = 0
        setStreak(0)
      }
    },
    [recordAttempt]
  )

  // ---- Finish the current puzzle → review flash → advance ----
  // `solved` is the raw outcome of the move that ended the puzzle; the flash
  // shows the RECORDED result: if this index was already recorded as failed (a
  // wrong move earlier in the retry-on-wrong flow), a late solve still reads as
  // failed. It advances, it does not un-fail.
  const finishPuzzle = useCallback(
    (p: Puzzle, solved: boolean, token: number) => {
      recordOutcomeOnce(p, solved)
      const recordedSolved = solved && !failedRef.current
      play(recordedSolved ? 'puzzleSolved' : 'puzzleFailed')
      setLastSolved(recordedSolved)
      setKeepTrying(false)
      setPhase('review')

      schedule(() => {
        if (tokenRef.current !== token) return
        presentRef.current(indexRef.current + 1, token)
      }, ADVANCE_MS)
    },
    [recordOutcomeOnce, play, schedule]
  )

  // ---- User move (same matching logic as usePuzzleSession) ----
  const onUserMove = useCallback(
    (orig: Key, dest: Key) => {
      if (phase !== 'solving' || !puzzle) return
      const token = tokenRef.current
      const idx = solutionIdxRef.current
      const expected = puzzle.moves[idx]
      if (!expected) return

      const candidate = `${orig}${dest}`
      const isPromo = expected.length === 5
      const matches = expected === candidate || (isPromo && expected.slice(0, 4) === candidate)

      if (!matches) {
        // Illegal own-move = snap back (not a fail); legal-but-wrong = fail.
        const played = applyMove(fen, orig, dest)
        if (!played) {
          setNonce((n) => n + 1)
          return
        }
        // Retry-on-wrong: the FIRST wrong move records the fail once (stats +
        // streak, exactly as before) but we DON'T reveal the answer or advance.
        // The board snaps back to the position to move and the learner keeps
        // trying until they solve it (a late solve stays counted as failed) or
        // uses Skip / Show solution. Further wrong tries just snap back (the
        // per-index guard in recordOutcomeOnce keeps them from re-counting).
        recordOutcomeOnce(puzzle, false)
        play('puzzleFailed') // soft, non-punishing cue
        setKeepTrying(true)
        setHintStage(0)
        setNonce((n) => n + 1) // snap the wrong move back; board is unchanged
        return
      }

      // Correct user move.
      const userMove = applyMove(fen, expected.slice(0, 2), expected.slice(2, 4), promoRole(expected))
      if (!userMove) {
        setNonce((n) => n + 1)
        return
      }
      setFen(userMove.fen)
      setLastMove(uciToLastMove(userMove.uci))
      playMove(userMove)
      setHintStage(0) // each ply earns its own hints, as in Train mode
      const nextIdx = idx + 1
      solutionIdxRef.current = nextIdx

      if (nextIdx >= puzzle.moves.length) {
        finishPuzzle(puzzle, true, token)
        return
      }

      // Auto-reply (opponent move), then it's the user's turn again.
      const replyUci = puzzle.moves[nextIdx]
      const replyFromFen = userMove.fen
      schedule(() => {
        if (tokenRef.current !== token) return
        const reply = applyMove(replyFromFen, replyUci.slice(0, 2), replyUci.slice(2, 4), promoRole(replyUci))
        if (!reply) {
          // Corrupt reply: treat the puzzle as solved-so-far and move on.
          finishPuzzle(puzzle, true, token)
          return
        }
        setFen(reply.fen)
        setLastMove(uciToLastMove(reply.uci))
        playMove(reply)
        solutionIdxRef.current = nextIdx + 1
      }, AUTO_REPLY_MS)
    },
    [phase, puzzle, fen, finishPuzzle, recordOutcomeOnce, play, schedule, playMove]
  )

  // ---- Give up on the current puzzle (Skip). Records a fail if not already,
  // then advances (via finishPuzzle's guard-safe path). ----
  const skip = useCallback(() => {
    if (!puzzle || (phase !== 'solving' && phase !== 'leadin')) return
    const token = tokenRef.current
    finishPuzzle(puzzle, false, token)
  }, [puzzle, phase, finishPuzzle])

  // ---- Reveal the full solution line, then advance. Records a fail if not
  // already (seeing the answer = not a solve). We animate the remaining solution
  // plies from the current position, then go to the review flash. ----
  const showSolution = useCallback(() => {
    if (!puzzle || phase !== 'solving') return
    const token = tokenRef.current
    clearTimers()
    // Ensure the outcome is recorded as a fail before revealing.
    recordOutcomeOnce(puzzle, false)
    setKeepTrying(false)
    // 'leadin' makes the board view-only while the solution animates (onUserMove
    // early-returns unless phase==='solving'), so a stray click can't interfere.
    setPhase('leadin')
    // Surface the immediate expected move's SAN in the prompt (parity with the
    // classic "the move was …" hint), then walk the rest of the line on the board.
    const idx = solutionIdxRef.current
    const nextExpected = puzzle.moves[idx]
    if (nextExpected) {
      const right = applyMove(fen, nextExpected.slice(0, 2), nextExpected.slice(2, 4), promoRole(nextExpected))
      setCorrectSan(right?.san ?? null)
    }
    // Play out the remaining plies with a small stagger so the learner sees it.
    let curFen = fen
    let delay = 0
    for (let i = idx; i < puzzle.moves.length; i++) {
      const uci = puzzle.moves[i]
      const step = applyMove(curFen, uci.slice(0, 2), uci.slice(2, 4), promoRole(uci))
      if (!step) break
      curFen = step.fen
      const fenAt = step.fen
      const uciAt = step.uci
      const moveAt = step
      delay += AUTO_REPLY_MS
      schedule(() => {
        if (tokenRef.current !== token) return
        setFen(fenAt)
        setLastMove(uciToLastMove(uciAt))
        playMove(moveAt)
      }, delay)
    }
    // After the line finishes, run the review flash (recorded as failed) + advance.
    schedule(() => {
      if (tokenRef.current !== token) return
      finishPuzzle(puzzle, false, token)
    }, delay + ADVANCE_MS)
  }, [puzzle, phase, fen, clearTimers, recordOutcomeOnce, schedule, playMove, finishPuzzle])

  // ---- Fetch the fixed set and begin ----
  const beginSet = useCallback(
    (set: Puzzle[]) => {
      const token = ++tokenRef.current
      setRef.current = set
      recordsRef.current = []
      indexRef.current = 0
      streakRef.current = 0
      setTotal(set.length)
      setSolvedCount(0)
      setStreak(0)
      setBestStreak(0)
      setSummary(null)
      if (set.length === 0) {
        setPhase('empty')
        return
      }
      presentRef.current(0, token)
    },
    []
  )

  const start = useCallback(() => {
    clearTimers()
    const token = ++tokenRef.current
    setPhase('loading')
    setSummary(null)

    const api = window.api?.puzzles
    if (!api) {
      setPhase('empty')
      return
    }
    const band = BANDS.find((b) => b.key === config.band)
    void api
      .batch({
        themes: config.themes.length ? config.themes : undefined,
        ratingLo: band?.lo,
        ratingHi: band?.hi,
        count: config.count,
        // New Custom filters: solution length, popularity floor, skip-solved.
        // Omit when at their "off" values so the batch query stays unconstrained.
        length: config.length !== 'any' ? config.length : undefined,
        minPopularity: config.minPopularity > -100 ? config.minPopularity : undefined,
        excludeSolved: config.excludeSolved || undefined
      })
      .then((r) => {
        if (tokenRef.current !== token) return
        beginSet(r?.puzzles ?? [])
      })
      .catch(() => {
        if (tokenRef.current !== token) return
        setPhase('error')
      })
  }, [clearTimers, config, beginSet])

  const advance = useCallback(() => {
    if (phase !== 'review') return
    clearTimers()
    const token = tokenRef.current
    presentRef.current(indexRef.current + 1, token)
  }, [phase, clearTimers])

  const retry = useCallback(() => {
    if (!puzzle) return
    clearTimers()
    // Re-present the current puzzle as practice. If this index already finished
    // (retry pressed during the review flash), finishPuzzle's first-outcome
    // guard keeps the replay from recording a second attempt or moving the
    // solved/streak counts (mirrors the trainer: retry is practice only).
    const token = ++tokenRef.current
    presentRef.current(indexRef.current, token)
  }, [puzzle, clearTimers])

  const quit = useCallback(() => {
    clearTimers()
    tokenRef.current += 1 // invalidate any pending timers/fetch
    setPhase('setup')
    setPuzzle(null)
    setSummary(null)
    setFen(INITIAL_FEN)
    setLastMove(undefined)
  }, [clearTimers])

  const playAgain = useCallback(() => {
    clearTimers()
    beginSet(setRef.current)
  }, [clearTimers, beginSet])

  const newSet = useCallback(() => {
    clearTimers()
    tokenRef.current += 1
    setPhase('setup')
    setPuzzle(null)
    setSummary(null)
    setFen(INITIAL_FEN)
    setLastMove(undefined)
  }, [clearTimers])

  return {
    phase,
    apiReady,
    config,
    setConfig,
    fen,
    orientation,
    turn,
    check,
    dests,
    lastMove,
    nonce,
    puzzle,
    index,
    total,
    solvedCount,
    streak,
    bestStreak,
    lastSolved,
    correctSan,
    keepTrying,
    hintStage,
    hintFrom,
    hintTo,
    revealSan,
    summary,
    start,
    onUserMove,
    bumpHint,
    advance,
    retry,
    skip,
    showSolution,
    quit,
    playAgain,
    newSet
  }
}
