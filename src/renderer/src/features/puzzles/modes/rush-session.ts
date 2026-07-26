import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Role } from 'chessops/types'
import type { Key } from 'chessground/types'
import type { Puzzle, RushMode, RushEndReason, RushRunInput } from '@shared/types'
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

// ============================================================================
// SLICE B: Puzzle Rush / Storm solve engine.  ★ OWNED BY THE RUSH BUILDER ★
//
// A self-contained, clock-driven solve loop for the four timed variants. It
// mirrors usePuzzleSession's lead-in -> solve -> auto-reply rhythm but is built
// for speed: puzzles are PREFETCHED into a queue (puzzles:batch, one round-trip)
// and the queue is REFILLED in the background before it drains, walking the
// rating band UP as the score climbs. The clock never blocks on IPC.
//
// Per-puzzle attempts log via puzzles:attempt({ mode:'rush' }): that path does
// NOT move the Glicko ladder. The finished run persists via puzzles:saveRush.
// ============================================================================

const ROLE_FROM_CHAR: Record<string, Role> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }
function promoRole(uci: string): Role | undefined {
  return uci.length > 4 ? ROLE_FROM_CHAR[uci[4]] : undefined
}

// --- Timing of the board animation (kept snappy for a rush). ---
const LEADIN_MS = 280
const AUTO_REPLY_MS = 260
const ADVANCE_MS = 220 // pause on the solved/missed board before the next puzzle

// --- Queue / prefetch tuning. ---
const QUEUE_BATCH = 40 // puzzles per IPC fetch
const REFILL_AT = 12 // refill once the queue dips to this many
const EXCLUDE_CAP = 400 // recently-seen ids we keep to avoid repeats
const EMPTY_RETRY_CAP = 20 // consecutive 140ms empty-queue waits before the run ends

// --- Difficulty ramp. The band center climbs with the solved count; width is a
//     fixed window around it. Tuned to start very gentle and reach hard puzzles
//     only after a long streak (chess.com Rush feel). ---
const RATING_BASE = 800
const RATING_STEP = 28 // center += STEP per solve
const RATING_HALF = 120 // half-window around the center
const RATING_FLOOR = 400
const RATING_CEIL = 2900

/** The rating window a run serves at `solved` solves. Exported so the lobby can
 *  state the starting band instead of naming a number of its own. */
export function band(solved: number): { lo: number; hi: number } {
  const center = Math.min(RATING_CEIL, RATING_BASE + solved * RATING_STEP)
  return {
    lo: Math.max(RATING_FLOOR, Math.round(center - RATING_HALF)),
    hi: Math.min(RATING_CEIL, Math.round(center + RATING_HALF))
  }
}

// --- Per-variant config. ---
export interface RushVariant {
  mode: RushMode
  label: string
  blurb: string
  /** Lives (Infinity = clock-only, e.g. storm). */
  lives: number
  /** Whether a clock is shown / runs. */
  clock: boolean
  /** Starting clock seconds (clock modes only). */
  startSec: number
  /** Seconds added per solve (storm bonus). */
  bonusSec: number
  /** Seconds removed per miss (storm penalty). */
  penaltySec: number
}

export const RUSH_VARIANTS: Record<RushMode, RushVariant> = {
  rush3: {
    mode: 'rush3',
    label: 'Rush 3',
    blurb: 'Three lives. Solve as many as you can, three misses and it ends.',
    lives: 3,
    clock: false,
    startSec: 0,
    bonusSec: 0,
    penaltySec: 0
  },
  rush5: {
    mode: 'rush5',
    label: 'Rush 5',
    blurb: 'Five lives. A longer run for a bigger score, five misses ends it.',
    lives: 5,
    clock: false,
    startSec: 0,
    bonusSec: 0,
    penaltySec: 0
  },
  storm: {
    mode: 'storm',
    label: 'Storm',
    blurb: 'Beat the clock. Every solve buys a little more time; misses cost time. Difficulty ramps.',
    lives: Infinity,
    clock: true,
    startSec: 180,
    bonusSec: 4,
    penaltySec: 8
  },
  survival: {
    mode: 'survival',
    label: 'Survival',
    blurb: 'One life and a clock that keeps shrinking. How far can you go?',
    lives: 1,
    clock: true,
    startSec: 60,
    bonusSec: 0,
    penaltySec: 0
  }
}

// Survival: the clock is refilled per puzzle, but the budget shrinks as you climb.
const SURVIVAL_MIN_SEC = 8
export function survivalBudgetSec(solved: number): number {
  return Math.max(SURVIVAL_MIN_SEC, RUSH_VARIANTS.survival.startSec - solved * 2)
}

export type RushPhase = 'idle' | 'loading' | 'leadin' | 'solving' | 'feedback' | 'over'

/** A flash on the score for the most recent solve/miss (drives the HUD pulse). */
export type RushFlash = 'solve' | 'miss' | null

export interface RushResult {
  id: number
  best: number
  isBest: boolean
}

export interface RushSession {
  apiReady: boolean
  variant: RushVariant
  phase: RushPhase
  // Board
  puzzle: Puzzle | null
  fen: string
  orientation: Color
  turn: Color
  check: Color | undefined
  dests: Map<Key, Key[]>
  lastMove: [Key, Key] | undefined
  nonce: number
  // HUD
  score: number
  solved: number
  missed: number
  livesLeft: number
  maxLives: number
  streak: number
  bestStreak: number
  clockMs: number
  clockOn: boolean
  flash: RushFlash
  comboMult: number
  // Result
  result: RushResult | null
  endedReason: RushEndReason | null
  saving: boolean
  /** Hardest puzzle rating solved this run (0 if none). Frozen at run end. */
  topRating: number
  /** Wall-clock run length in ms. Frozen at run end. */
  durationMs: number
  // Actions
  start: () => void
  onUserMove: (orig: Key, dest: Key) => void
  quit: () => void
  reset: () => void
}

export function useRushSession(mode: RushMode): RushSession {
  const apiReady = typeof window !== 'undefined' && !!window.api
  const variant = RUSH_VARIANTS[mode]
  const { play, playMove } = useSound()

  const [phase, setPhase] = useState<RushPhase>('idle')
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null)
  const [fen, setFen] = useState<string>(INITIAL_FEN)
  const [orientation, setOrientation] = useState<Color>('white')
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>(undefined)
  const [nonce, setNonce] = useState(0)

  const [score, setScore] = useState(0)
  const [solved, setSolved] = useState(0)
  const [missed, setMissed] = useState(0)
  const [livesLeft, setLivesLeft] = useState(variant.lives)
  const [streak, setStreak] = useState(0)
  const [bestStreak, setBestStreak] = useState(0)
  const [clockMs, setClockMs] = useState(variant.startSec * 1000)
  const [flash, setFlash] = useState<RushFlash>(null)
  const [comboMult, setComboMult] = useState(1)

  const [result, setResult] = useState<RushResult | null>(null)
  const [endedReason, setEndedReason] = useState<RushEndReason | null>(null)
  const [saving, setSaving] = useState(false)
  // Run-summary snapshots, frozen at end-of-run for the results card.
  const [topRating, setTopRating] = useState(0)
  const [durationMs, setDurationMs] = useState(0)

  // --- Refs for values read inside async/interval callbacks. ---
  const queueRef = useRef<Puzzle[]>([])
  const excludeRef = useRef<string[]>([])
  const fetchingRef = useRef(false)
  // Whether the last COMPLETED refill actually added puzzles (false = band exhausted).
  const lastRefillGainedRef = useRef(true)
  // Consecutive empty-queue waits in advance(). Backstop cap for persistent IPC errors.
  const emptyRetriesRef = useRef(0)
  const solutionIdxRef = useRef(1)
  const puzzleRef = useRef<Puzzle | null>(null)
  const startMsRef = useRef(0) // current puzzle start (for per-attempt ms)
  const runStartRef = useRef(0) // whole-run start (for durationMs)
  const solvedRef = useRef(0)
  const missedRef = useRef(0)
  const livesRef = useRef(variant.lives)
  const scoreRef = useRef(0)
  const streakRef = useRef(0)
  const bestStreakRef = useRef(0)
  const topRatingRef = useRef(0)
  const comboRef = useRef(1)
  const endedRef = useRef(false)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const clockRafRef = useRef<number | null>(null)
  const clockDeadlineRef = useRef(0) // performance.now() ms at which the clock hits 0
  const runTokenRef = useRef(0) // invalidates stale async work across runs

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
  const stopClock = useCallback(() => {
    if (clockRafRef.current !== null) {
      cancelAnimationFrame(clockRafRef.current)
      clockRafRef.current = null
    }
  }, [])

  // --- Derived board state. ---
  const dests = useMemo(() => {
    if (phase !== 'solving') return new Map<Key, Key[]>()
    return destsFor(fen)
  }, [fen, phase])
  const turn = useMemo(() => turnColor(fen), [fen])
  const check = useMemo(() => checkColor(fen), [fen])

  const pushExclude = useCallback((id: string) => {
    excludeRef.current.push(id)
    if (excludeRef.current.length > EXCLUDE_CAP) {
      excludeRef.current.splice(0, excludeRef.current.length - EXCLUDE_CAP)
    }
  }, [])

  // --- Queue prefetch / background refill (walks the band UP with solved count). ---
  const refillQueue = useCallback(
    async (token: number): Promise<void> => {
      if (fetchingRef.current) return
      const api = window.api?.puzzles
      if (!api) return
      fetchingRef.current = true
      try {
        const { lo, hi } = band(solvedRef.current + queueRef.current.length)
        const { puzzles } = await api.batch({
          ratingLo: lo,
          ratingHi: hi,
          count: QUEUE_BATCH,
          exclude: excludeRef.current,
          ascending: true
        })
        if (runTokenRef.current !== token) return
        let gained = false
        for (const p of puzzles) {
          // Guard against malformed rows (need a lead-in + at least one solution move).
          if (p.moves.length >= 2) {
            queueRef.current.push(p)
            pushExclude(p.id)
            gained = true
          }
        }
        lastRefillGainedRef.current = gained
      } catch {
        /* transient IPC failure: try again on the next drain check */
      } finally {
        fetchingRef.current = false
      }
    },
    [pushExclude]
  )

  const maybeRefill = useCallback(
    (token: number) => {
      if (queueRef.current.length <= REFILL_AT && !fetchingRef.current) {
        void refillQueue(token)
      }
    },
    [refillQueue]
  )

  // --- Flash pulse on the HUD score. ---
  const pulse = useCallback((kind: RushFlash) => {
    setFlash(kind)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setFlash(null), 520)
  }, [])

  // --- End the run: stop everything, persist, show the results card. ---
  const endRun = useCallback(
    (reason: RushEndReason) => {
      if (endedRef.current) return
      endedRef.current = true
      const token = runTokenRef.current
      clearTimers()
      stopClock()
      setEndedReason(reason)
      setPhase('over')
      setPuzzle(null)
      puzzleRef.current = null
      play(reason === 'cleared' ? 'puzzleSolved' : 'gameEnd')

      const dur = Math.max(0, Math.round(performance.now() - runStartRef.current))
      setTopRating(topRatingRef.current)
      setDurationMs(dur)
      const input: RushRunInput = {
        mode,
        score: scoreRef.current,
        solved: solvedRef.current,
        missed: missedRef.current,
        bestStreak: bestStreakRef.current,
        topRating: topRatingRef.current > 0 ? topRatingRef.current : undefined,
        durationMs: dur,
        endedReason: reason
      }
      const api = window.api?.puzzles
      if (!api) return
      setSaving(true)
      void api
        .saveRush(input)
        .then((res) => {
          if (runTokenRef.current !== token) return
          setResult(res)
        })
        .catch(() => {
          /* persistence failed: leave the results card without a saved best */
        })
        .finally(() => {
          if (runTokenRef.current === token) setSaving(false)
        })
    },
    [clearTimers, stopClock, play, mode]
  )
  const endRunRef = useRef(endRun)
  endRunRef.current = endRun

  // --- Lead-in for one puzzle: animate moves[0], then hand to the solver. ---
  const presentPuzzle = useCallback(
    (p: Puzzle, token: number) => {
      const m0 = p.moves[0]
      const shown = m0 && m0.length >= 4
        ? applyMove(p.fen, m0.slice(0, 2), m0.slice(2, 4), promoRole(m0))
        : null
      if (!shown) {
        // Corrupt puzzle: skip to the next without penalty.
        advanceRef.current(token)
        return
      }
      solutionIdxRef.current = 1
      puzzleRef.current = p
      setPuzzle(p)
      setFen(p.fen)
      setLastMove(undefined)
      setOrientation(turnColor(shown.fen))
      setPhase('leadin')
      schedule(() => {
        if (runTokenRef.current !== token || endedRef.current) return
        setFen(shown.fen)
        setLastMove(uciToLastMove(shown.uci))
        playMove(shown)
        startMsRef.current = performance.now()
        setPhase('solving')
        // Survival: each puzzle gets a fresh, ever-shrinking budget.
        if (mode === 'survival') {
          setClock(survivalBudgetSec(solvedRef.current) * 1000)
        }
      }, LEADIN_MS)
    },
    [schedule, playMove, mode]
  )
  const presentPuzzleRef = useRef(presentPuzzle)
  presentPuzzleRef.current = presentPuzzle

  // --- Pull the next puzzle from the queue (refilling in the background). ---
  const advance = useCallback(
    (token: number) => {
      if (runTokenRef.current !== token || endedRef.current) return
      // Band exhausted: queue dry, nothing in flight, and the last COMPLETED
      // refill gained nothing. Checked BEFORE maybeRefill, which would otherwise
      // synchronously flip fetchingRef back on and mask this state forever.
      if (
        queueRef.current.length === 0 &&
        !fetchingRef.current &&
        !lastRefillGainedRef.current
      ) {
        endRunRef.current('cleared')
        return
      }
      maybeRefill(token)
      const next = queueRef.current.shift()
      if (!next) {
        // Queue empty mid-run. If a fetch is in flight, wait a beat and retry.
        // Capped so persistently failing IPC ends the run instead of spinning;
        // otherwise (no puzzles API at all) the run is cleared.
        if (fetchingRef.current) {
          emptyRetriesRef.current += 1
          if (emptyRetriesRef.current > EMPTY_RETRY_CAP) {
            endRunRef.current('cleared')
            return
          }
          setPhase('loading')
          schedule(() => advanceRef.current(token), 140)
        } else {
          endRunRef.current('cleared')
        }
        return
      }
      emptyRetriesRef.current = 0
      presentPuzzleRef.current(next, token)
    },
    [maybeRefill, schedule]
  )
  const advanceRef = useRef(advance)
  advanceRef.current = advance

  // --- Clock control (clock variants only) via rAF for smooth ms countdown. ---
  const setClock = useCallback(
    (ms: number) => {
      if (!variant.clock) return
      const clamped = Math.max(0, ms)
      clockDeadlineRef.current = performance.now() + clamped
      setClockMs(clamped)
      stopClock()
      // Already at/below 10s when set (e.g. survival's shrunken budgets): treat
      // the cue as played so it doesn't blast instantly; otherwise arm it so it
      // fires once when the countdown crosses 10s.
      let lowTimePlayed = clamped <= 10_000
      const tick = (): void => {
        if (endedRef.current) return
        const remaining = Math.max(0, clockDeadlineRef.current - performance.now())
        setClockMs(remaining)
        if (!lowTimePlayed && remaining <= 10_000) {
          lowTimePlayed = true
          play('lowTime')
        }
        if (remaining <= 0) {
          stopClock()
          endRunRef.current('time')
          return
        }
        clockRafRef.current = requestAnimationFrame(tick)
      }
      clockRafRef.current = requestAnimationFrame(tick)
    },
    [variant.clock, stopClock, play]
  )

  const adjustClock = useCallback(
    (deltaMs: number) => {
      if (!variant.clock) return
      const remaining = Math.max(0, clockDeadlineRef.current - performance.now())
      setClock(remaining + deltaMs)
    },
    [variant.clock, setClock]
  )

  // --- Record one attempt (rush mode does NOT move the Glicko ladder). ---
  const recordAttempt = useCallback((p: Puzzle, ok: boolean, ms: number) => {
    const api = window.api?.puzzles
    if (!api) return
    void api.attempt({ puzzleId: p.id, puzzleRating: p.rating, solved: ok, ms, mode: 'rush' }).catch(() => {
      /* attempt logging is best-effort during a rush */
    })
  }, [])

  // --- Handle a solved puzzle. ---
  const onSolved = useCallback(
    (p: Puzzle, token: number) => {
      const ms = Math.round(performance.now() - startMsRef.current)
      recordAttempt(p, true, ms)

      solvedRef.current += 1
      setSolved(solvedRef.current)
      scoreRef.current += 1
      setScore(scoreRef.current)
      if (p.rating > topRatingRef.current) topRatingRef.current = p.rating

      streakRef.current += 1
      setStreak(streakRef.current)
      if (streakRef.current > bestStreakRef.current) {
        bestStreakRef.current = streakRef.current
        setBestStreak(bestStreakRef.current)
      }
      // Storm combo: every 3rd consecutive solve bumps the bonus multiplier.
      const combo = mode === 'storm' ? Math.min(4, 1 + Math.floor(streakRef.current / 3)) : 1
      comboRef.current = combo
      setComboMult(combo)

      play('puzzleSolved')
      pulse('solve')

      if (mode === 'storm') adjustClock(variant.bonusSec * combo * 1000)

      schedule(() => advanceRef.current(token), ADVANCE_MS)
    },
    [recordAttempt, mode, play, pulse, adjustClock, variant.bonusSec, schedule]
  )

  // --- Handle a missed puzzle (a wrong legal move). ---
  const onMissed = useCallback(
    (p: Puzzle, token: number, expectedUci: string) => {
      const ms = Math.round(performance.now() - startMsRef.current)
      recordAttempt(p, false, ms)

      missedRef.current += 1
      setMissed(missedRef.current)
      streakRef.current = 0
      setStreak(0)
      comboRef.current = 1
      setComboMult(1)

      // Show the correct move briefly so a rush still teaches.
      const right = applyMove(fen, expectedUci.slice(0, 2), expectedUci.slice(2, 4), promoRole(expectedUci))
      setLastMove(uciToLastMove(expectedUci))
      if (right) setFen(right.fen)
      setNonce((n) => n + 1)
      setPhase('feedback')
      play('puzzleFailed')
      pulse('miss')

      if (mode === 'storm') adjustClock(-variant.penaltySec * 1000)

      if (Number.isFinite(variant.lives)) {
        livesRef.current -= 1
        setLivesLeft(livesRef.current)
        if (livesRef.current <= 0) {
          schedule(() => endRunRef.current('lives'), ADVANCE_MS + 220)
          return
        }
      }
      schedule(() => advanceRef.current(token), ADVANCE_MS + 220)
    },
    [recordAttempt, fen, mode, play, pulse, adjustClock, variant.penaltySec, variant.lives, schedule]
  )

  // --- User move on the board. ---
  const onUserMove = useCallback(
    (orig: Key, dest: Key) => {
      if (phase !== 'solving') return
      const p = puzzleRef.current
      if (!p) return
      const token = runTokenRef.current
      const idx = solutionIdxRef.current
      const expected = p.moves[idx]
      if (!expected) return

      const candidate = `${orig}${dest}`
      const isPromo = expected.length === 5
      const matches = expected === candidate || (isPromo && expected.slice(0, 4) === candidate)

      if (!matches) {
        // Illegal own-move = no-op (snap back); legal-but-wrong = a miss.
        const played = applyMove(fen, orig, dest)
        if (!played) {
          setNonce((n) => n + 1)
          return
        }
        onMissed(p, token, expected)
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
      const nextIdx = idx + 1
      solutionIdxRef.current = nextIdx

      if (nextIdx >= p.moves.length) {
        onSolved(p, token)
        return
      }

      // Auto-reply (opponent move), then keep solving.
      const replyUci = p.moves[nextIdx]
      const replyFromFen = userMove.fen
      schedule(() => {
        if (runTokenRef.current !== token || endedRef.current) return
        const reply = applyMove(replyFromFen, replyUci.slice(0, 2), replyUci.slice(2, 4), promoRole(replyUci))
        if (!reply) {
          // Corrupt reply: treat the puzzle as solved (we got this far legitimately).
          onSolved(p, token)
          return
        }
        setFen(reply.fen)
        setLastMove(uciToLastMove(reply.uci))
        playMove(reply)
        solutionIdxRef.current = nextIdx + 1
      }, AUTO_REPLY_MS)
    },
    [phase, fen, playMove, schedule, onSolved, onMissed]
  )

  // --- Start a fresh run. ---
  const start = useCallback(() => {
    const token = ++runTokenRef.current
    clearTimers()
    stopClock()
    // Reset all run state (refs + UI).
    queueRef.current = []
    excludeRef.current = []
    fetchingRef.current = false
    lastRefillGainedRef.current = true
    emptyRetriesRef.current = 0
    endedRef.current = false
    solvedRef.current = 0
    missedRef.current = 0
    livesRef.current = variant.lives
    scoreRef.current = 0
    streakRef.current = 0
    bestStreakRef.current = 0
    topRatingRef.current = 0
    comboRef.current = 1
    runStartRef.current = performance.now()

    setScore(0)
    setSolved(0)
    setMissed(0)
    setLivesLeft(variant.lives)
    setStreak(0)
    setBestStreak(0)
    setComboMult(1)
    setResult(null)
    setEndedReason(null)
    setSaving(false)
    setTopRating(0)
    setDurationMs(0)
    setPuzzle(null)
    setFen(INITIAL_FEN)
    setLastMove(undefined)
    setClockMs(variant.startSec * 1000)
    setPhase('loading')

    // Prime the queue, then start the clock (clock modes) and serve the first puzzle.
    void refillQueue(token).then(() => {
      if (runTokenRef.current !== token || endedRef.current) return
      if (variant.clock && mode !== 'survival') {
        setClock(variant.startSec * 1000)
      }
      advanceRef.current(token)
    })
  }, [clearTimers, stopClock, variant.lives, variant.startSec, variant.clock, mode, refillQueue, setClock])

  const quit = useCallback(() => {
    if (phase === 'over' || phase === 'idle') return
    endRunRef.current('quit')
  }, [phase])

  const reset = useCallback(() => {
    runTokenRef.current++
    clearTimers()
    stopClock()
    endedRef.current = true
    setPhase('idle')
    setResult(null)
    setEndedReason(null)
    setPuzzle(null)
    setFen(INITIAL_FEN)
    setLastMove(undefined)
  }, [clearTimers, stopClock])

  // --- Cleanup on unmount / mode change. ---
  useEffect(() => {
    return () => {
      runTokenRef.current++
      endedRef.current = true
      clearTimers()
      stopClock()
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    }
  }, [clearTimers, stopClock])

  return {
    apiReady,
    variant,
    phase,
    puzzle,
    fen,
    orientation,
    turn,
    check,
    dests,
    lastMove,
    nonce,
    score,
    solved,
    missed,
    livesLeft,
    maxLives: Number.isFinite(variant.lives) ? variant.lives : 0,
    streak,
    bestStreak,
    clockMs,
    clockOn: variant.clock,
    flash,
    comboMult,
    result,
    endedReason,
    saving,
    topRating,
    durationMs,
    start,
    onUserMove,
    quit,
    reset
  }
}
