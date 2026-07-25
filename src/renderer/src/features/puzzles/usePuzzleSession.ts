import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Role } from 'chessops/types'
import type { Key } from 'chessground/types'
import type { Puzzle, ThemeCount } from '../../../../shared/types'
import {
  applyMove,
  checkColor,
  destsFor,
  turnColor,
  uciToLastMove,
  INITIAL_FEN,
  type Color
} from '../../chess/chess'
import { useSound } from '../../sound'

const ROLE_FROM_CHAR: Record<string, Role> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }

const STREAK_KEY = 'oct.puzzles.streak.v1'
const EXCLUDE_CAP = 50
const LEADIN_MS = 380
const AUTO_REPLY_MS = 360
const RATING_BAND_LO = 300
const RATING_BAND_HI = 200
const RATING_FLOOR = 400
const WIDE_BAND = 600

export type Phase = 'loading' | 'leadin' | 'solving' | 'solved' | 'failed' | 'empty' | 'error'

export type HintStage = 0 | 1 | 2 | 3

export interface PuzzleSession {
  phase: Phase
  puzzle: Puzzle | null
  apiReady: boolean
  // Board state
  fen: string
  orientation: Color
  turn: Color
  check: Color | undefined
  dests: Map<Key, Key[]>
  lastMove: [Key, Key] | undefined
  nonce: number
  // Prompt / feedback
  correctSan: string | null
  // Rating
  puzzleRating: number
  puzzleRd: number
  delta: number | null
  ratingAfter: number | null
  attemptCount: number
  // Streak
  streak: number
  best: number
  // Hints
  hintStage: HintStage
  hintFrom: Key | undefined
  hintTo: Key | undefined
  revealSan: string | null
  // Retry-on-wrong
  /** A wrong move was recorded as a fail but the learner is still solving
   *  (board snapped back, answer not revealed). Drives the keep-trying chip. */
  keepTrying: boolean
  /** The line was completed AFTER the fail was recorded: the finish reads as
   *  failed ("solved, but the first try counted"). */
  lateSolve: boolean
  // Themes
  themes: ThemeCount[]
  theme: string | null
  // Actions
  onUserMove: (orig: Key, dest: Key) => void
  next: () => void
  retry: () => void
  bumpHint: () => void
  /** Give up and move on: records a fail (once) and loads the next puzzle. */
  skip: () => void
  /** Reveal the answer: records a fail (once) and shows the classic failed
   *  state (correct move highlighted + SAN), leaving Retry/Next. */
  showSolution: () => void
  setTheme: (key: string | null) => void
}

function loadBestStreak(): number {
  try {
    const raw = localStorage.getItem(STREAK_KEY)
    if (raw) {
      const n = Number.parseInt(raw, 10)
      if (Number.isFinite(n) && n >= 0) return n
    }
  } catch {
    /* storage may be unavailable */
  }
  return 0
}

function saveBestStreak(n: number): void {
  try {
    localStorage.setItem(STREAK_KEY, String(n))
  } catch {
    /* storage may be unavailable */
  }
}

function promoRole(uci: string): Role | undefined {
  return uci.length > 4 ? ROLE_FROM_CHAR[uci[4]] : undefined
}

export function usePuzzleSession(): PuzzleSession {
  const apiReady = typeof window !== 'undefined' && !!window.api
  const { play, playMove } = useSound()

  const [phase, setPhase] = useState<Phase>('loading')
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null)
  const [fen, setFen] = useState<string>(INITIAL_FEN)
  const [orientation, setOrientation] = useState<Color>('white')
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const [correctSan, setCorrectSan] = useState<string | null>(null)

  const [puzzleRating, setPuzzleRating] = useState(1500)
  const [puzzleRd, setPuzzleRd] = useState(350)
  const [delta, setDelta] = useState<number | null>(null)
  const [ratingAfter, setRatingAfter] = useState<number | null>(null)
  const [attemptCount, setAttemptCount] = useState(0)

  const [streak, setStreak] = useState(0)
  const [best, setBest] = useState<number>(loadBestStreak)

  const [hintStage, setHintStage] = useState<HintStage>(0)
  // Retry-on-wrong: a wrong move records the fail once but leaves the learner
  // solving (board snapped back, no reveal). keepTrying drives the prompt chip;
  // lateSolve marks a finish that completed the line after the fail landed.
  const [keepTrying, setKeepTrying] = useState(false)
  const [lateSolve, setLateSolve] = useState(false)
  const [themes, setThemes] = useState<ThemeCount[]>([])
  const [theme, setThemeState] = useState<string | null>(null)

  // solutionIdx points at the NEXT expected move in puzzle.moves (user's move).
  const solutionIdxRef = useRef(1)
  const excludeRef = useRef<string[]>([])
  const startMsRef = useRef(0)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const loadTokenRef = useRef(0)
  // One rated attempt per presented puzzle: set on the first finish (solve or
  // fail), cleared only when a NEW puzzle loads. retry() intentionally leaves it
  // set. A retried run replays the solve/fail UX without recording or moving
  // the streak (mirrors daily-session's reportedRef).
  const attemptedRef = useRef(false)
  // True once THIS presentation was recorded as failed (first wrong move, skip
  // or reveal). A later solve of the same run must still read as failed. The
  // solved flash/count is gated on it. Reset with attemptedRef on a new puzzle
  // and on retry() (a fresh practice replay shows the normal solve UX).
  const failedRef = useRef(false)
  // Latest rating, readable inside async callbacks without re-subscribing.
  const ratingRef = useRef(1500)
  const themeRef = useRef<string | null>(null)

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

  // ---- Derived board state ----
  const dests = useMemo(() => {
    if (phase !== 'solving') return new Map<Key, Key[]>()
    return destsFor(fen)
  }, [fen, phase])
  const turn = useMemo(() => turnColor(fen), [fen])
  const check = useMemo(() => checkColor(fen), [fen])

  const expectedUci = puzzle && phase === 'solving' ? puzzle.moves[solutionIdxRef.current] : undefined
  const hintFrom = hintStage >= 1 && expectedUci ? (expectedUci.slice(0, 2) as Key) : undefined
  const hintTo = hintStage >= 2 && expectedUci ? (expectedUci.slice(2, 4) as Key) : undefined
  const revealSan = useMemo(() => {
    if (hintStage < 3 || !expectedUci) return null
    const m = applyMove(fen, expectedUci.slice(0, 2), expectedUci.slice(2, 4), promoRole(expectedUci))
    return m?.san ?? null
  }, [hintStage, expectedUci, fen])

  // ---- Attempt recording ----
  const recordAttempt = useCallback(
    (solved: boolean, p: Puzzle, ms: number) => {
      setAttemptCount((c) => c + 1)
      const api = window.api?.puzzles
      if (!api) return
      void api
        .attempt({ puzzleId: p.id, puzzleRating: p.rating, solved, ms })
        .then((res) => {
          if (!res) return
          setDelta(res.delta)
          setRatingAfter(res.ratingAfter)
          setPuzzleRating(res.ratingAfter)
          setPuzzleRd(res.rd)
          ratingRef.current = res.ratingAfter
        })
        .catch(() => {
          /* attempt failed; leave rating untouched */
        })
    },
    []
  )

  // ---- Lead-in: animate puzzle.moves[0], then hand control to the solver ----
  const startLeadIn = useCallback(
    (p: Puzzle, token: number) => {
      clearTimers()
      setCorrectSan(null)
      setDelta(null)
      setRatingAfter(null)
      setHintStage(0)
      setKeepTrying(false)
      setLateSolve(false)
      failedRef.current = false
      solutionIdxRef.current = 1

      const m0 = p.moves[0]
      if (!m0 || m0.length < 4) {
        // Corrupt puzzle: skip.
        loadNextRef.current()
        return
      }
      const shown = applyMove(p.fen, m0.slice(0, 2), m0.slice(2, 4), promoRole(m0))
      if (!shown) {
        loadNextRef.current()
        return
      }

      // Show the pre-leadin position first so chessground animates moves[0].
      setFen(p.fen)
      setLastMove(undefined)
      setOrientation(turnColor(shown.fen))
      setPhase('leadin')

      schedule(() => {
        if (loadTokenRef.current !== token) return
        setFen(shown.fen)
        setLastMove(uciToLastMove(shown.uci))
        playMove(shown) // lead-in move audible as it animates
        startMsRef.current = performance.now()
        setPhase('solving')
      }, LEADIN_MS)
    },
    [clearTimers, schedule, playMove]
  )
  const startLeadInRef = useRef(startLeadIn)
  startLeadInRef.current = startLeadIn

  // ---- Load next puzzle ----
  const loadNext = useCallback(() => {
    clearTimers()
    const token = ++loadTokenRef.current
    setPhase('loading')
    setCorrectSan(null)
    setDelta(null)
    setRatingAfter(null)
    setHintStage(0)
    setKeepTrying(false)
    setLateSolve(false)
    failedRef.current = false

    const api = window.api?.puzzles
    if (!api) {
      setPuzzle(null)
      setFen(INITIAL_FEN)
      setOrientation('white')
      setLastMove(undefined)
      setPhase('empty')
      return
    }

    const base = ratingRef.current
    const query = (lo: number, hi: number): Promise<{ puzzle: Puzzle | null }> =>
      api.next({
        theme: themeRef.current ?? undefined,
        ratingLo: Math.max(RATING_FLOOR, Math.round(lo)),
        ratingHi: Math.round(hi),
        exclude: excludeRef.current
      })

    void query(base - RATING_BAND_LO, base + RATING_BAND_HI)
      .then((r) => {
        if (r.puzzle) return r
        // Widen the band once before declaring empty (themed filters can be sparse).
        return query(base - WIDE_BAND, base + WIDE_BAND)
      })
      .then((r) => {
        if (loadTokenRef.current !== token) return
        const next = r.puzzle
        if (!next) {
          setPuzzle(null)
          setFen(INITIAL_FEN)
          setOrientation('white')
          setLastMove(undefined)
          setPhase('empty')
          return
        }
        excludeRef.current.push(next.id)
        if (excludeRef.current.length > EXCLUDE_CAP) excludeRef.current.shift()
        attemptedRef.current = false // new puzzle: its next finish is the rated one
        setPuzzle(next)
        startLeadInRef.current(next, token)
      })
      .catch(() => {
        if (loadTokenRef.current !== token) return
        setPhase('error')
      })
  }, [clearTimers])
  const loadNextRef = useRef(loadNext)
  loadNextRef.current = loadNext

  // ---- Initial load: themes + rating, then first puzzle ----
  useEffect(() => {
    let cancelled = false
    const pz = window.api?.puzzles
    const rt = window.api?.ratings

    if (pz) {
      void pz
        .themes()
        .then((r) => {
          if (!cancelled && r?.themes) setThemes(r.themes)
        })
        .catch(() => {
          /* themes optional */
        })
    }

    if (rt) {
      void rt
        .get('puzzle')
        .then((r) => {
          if (cancelled || !r) return
          setPuzzleRating(r.rating)
          setPuzzleRd(r.rd)
          ratingRef.current = r.rating
        })
        .catch(() => {
          /* keep fallback rating */
        })
        .finally(() => {
          if (!cancelled) loadNextRef.current()
        })
    } else {
      loadNextRef.current()
    }

    return () => {
      cancelled = true
      clearTimers()
    }
  }, [clearTimers])

  // ---- User move ----
  const onUserMove = useCallback(
    (orig: Key, dest: Key) => {
      if (phase !== 'solving' || !puzzle) return
      const idx = solutionIdxRef.current
      const expected = puzzle.moves[idx]
      if (!expected) return

      const candidate = `${orig}${dest}`
      const isPromo = expected.length === 5
      const matches = expected === candidate || (isPromo && expected.slice(0, 4) === candidate)

      if (!matches) {
        // Distinguish illegal own-move (no-op) from a legal-but-wrong solution move.
        const played = applyMove(fen, orig, dest)
        if (!played) {
          setNonce((n) => n + 1) // snap board back; not a fail
          return
        }
        // Legal but wrong -> retry-on-wrong: the FIRST wrong move records the
        // fail (rating + streak, exactly as before) but the answer is NOT
        // revealed and the phase stays 'solving': the board snaps back and the
        // learner keeps trying (a late solve still reads as failed), or bails
        // out via skip()/showSolution(). Further wrong tries just snap back.
        setHintStage(0)
        setNonce((n) => n + 1)
        setKeepTrying(true)
        play('puzzleFailed') // soft, non-punishing error cue
        if (!attemptedRef.current) {
          // First outcome for this puzzle counts; a retried run is practice only.
          attemptedRef.current = true
          failedRef.current = true
          recordAttempt(false, puzzle, Math.round(performance.now() - startMsRef.current))
          setStreak(0)
        }
        return
      }

      // Correct user move.
      const userMove = applyMove(fen, expected.slice(0, 2), expected.slice(2, 4), promoRole(expected))
      if (!userMove) {
        // Corrupt data: expected move illegal from current fen.
        setNonce((n) => n + 1)
        return
      }
      setFen(userMove.fen)
      setLastMove(uciToLastMove(userMove.uci))
      playMove(userMove)
      setHintStage(0)
      const nextIdx = idx + 1
      solutionIdxRef.current = nextIdx

      if (nextIdx >= puzzle.moves.length) {
        // Line complete. If a fail was already recorded (retry-on-wrong), the
        // finish still READS as failed: it ends the puzzle, it does not un-fail.
        const late = failedRef.current
        setKeepTrying(false)
        setLateSolve(late)
        setPhase(late ? 'failed' : 'solved')
        play(late ? 'puzzleFailed' : 'puzzleSolved')
        if (!attemptedRef.current) {
          // First outcome for this puzzle counts; a retried run (e.g. replaying
          // the shown line after a fail) must not re-rate or grow the streak.
          attemptedRef.current = true
          recordAttempt(true, puzzle, Math.round(performance.now() - startMsRef.current))
          setStreak((s) => {
            const ns = s + 1
            setBest((b) => {
              const nb = Math.max(b, ns)
              if (nb !== b) saveBestStreak(nb)
              return nb
            })
            return ns
          })
        }
        return
      }

      // Auto-reply (opponent move).
      const replyUci = puzzle.moves[nextIdx]
      const replyFromFen = userMove.fen
      schedule(() => {
        const reply = applyMove(
          replyFromFen,
          replyUci.slice(0, 2),
          replyUci.slice(2, 4),
          promoRole(replyUci)
        )
        if (!reply) {
          // Corrupt reply: bail to next puzzle.
          loadNextRef.current()
          return
        }
        setFen(reply.fen)
        setLastMove(uciToLastMove(reply.uci))
        playMove(reply)
        solutionIdxRef.current = nextIdx + 1
      }, AUTO_REPLY_MS)
    },
    [phase, puzzle, fen, recordAttempt, schedule, play, playMove]
  )

  // ---- Retry (same puzzle, practice only: no new attempt) ----
  const retry = useCallback(() => {
    if (!puzzle) return
    const token = ++loadTokenRef.current
    startLeadInRef.current(puzzle, token)
  }, [puzzle])

  // ---- Give up: skip records a fail (once) and moves straight on ----
  const skip = useCallback(() => {
    if (!puzzle || phase !== 'solving') return
    clearTimers()
    if (!attemptedRef.current) {
      attemptedRef.current = true
      failedRef.current = true
      recordAttempt(false, puzzle, Math.round(performance.now() - startMsRef.current))
      setStreak(0)
    }
    loadNextRef.current()
  }, [puzzle, phase, clearTimers, recordAttempt])

  // ---- Reveal the answer: records the fail (once) and lands in the classic
  // failed state (expected move highlighted + its SAN), leaving Retry/Next. ----
  const showSolution = useCallback(() => {
    if (!puzzle || phase !== 'solving') return
    clearTimers()
    const expected = puzzle.moves[solutionIdxRef.current]
    if (!attemptedRef.current) {
      attemptedRef.current = true
      failedRef.current = true
      recordAttempt(false, puzzle, Math.round(performance.now() - startMsRef.current))
      setStreak(0)
    }
    if (expected) {
      const right = applyMove(fen, expected.slice(0, 2), expected.slice(2, 4), promoRole(expected))
      setCorrectSan(right?.san ?? null)
      setLastMove(uciToLastMove(expected))
    }
    setKeepTrying(false)
    setLateSolve(false)
    setHintStage(0)
    setPhase('failed')
    play('puzzleFailed')
  }, [puzzle, phase, fen, clearTimers, recordAttempt, play])

  const next = useCallback(() => {
    loadNextRef.current()
  }, [])

  const bumpHint = useCallback(() => {
    if (phase !== 'solving') return
    setHintStage((s) => (s < 3 ? ((s + 1) as HintStage) : s))
  }, [phase])

  const setTheme = useCallback((key: string | null) => {
    themeRef.current = key
    setThemeState(key)
    loadNextRef.current()
  }, [])

  return {
    phase,
    puzzle,
    apiReady,
    fen,
    orientation,
    turn,
    check,
    dests,
    lastMove,
    nonce,
    correctSan,
    puzzleRating,
    puzzleRd,
    delta,
    ratingAfter,
    attemptCount,
    streak,
    best,
    hintStage,
    hintFrom,
    hintTo,
    revealSan,
    keepTrying,
    lateSolve,
    themes,
    theme,
    onUserMove,
    next,
    retry,
    bumpHint,
    skip,
    showSolution,
    setTheme
  }
}
