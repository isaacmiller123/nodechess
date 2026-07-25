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

// ============================================================================
// SLICE C: Daily solver hook.  ★ OWNED BY THE DAILY BUILDER ★
//
// A focused, single-puzzle solver for the Daily mode board. Mirrors the proven
// lead-in -> solving -> auto-reply idiom of usePuzzleSession, but stripped to one
// fixed puzzle (no rating walk, no theme picker, no fetching): the caller hands
// in the day's puzzle, and the hook drives the board + reports the outcome once
// (solved or failed) via onComplete. The caller owns persistence (recordDaily +
// attempt) so this hook stays purely about board play.
// ============================================================================

const ROLE_FROM_CHAR: Record<string, Role> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }
const LEADIN_MS = 420
const AUTO_REPLY_MS = 360

export type DailyPhase = 'idle' | 'leadin' | 'solving' | 'solved' | 'failed'

export interface DailyOutcome {
  solved: boolean
  /** Whether the puzzle was solved with no wrong move and no hint/retry used. */
  firstTry: boolean
  ms: number
}

export interface DailySolver {
  phase: DailyPhase
  fen: string
  orientation: Color
  turn: Color
  check: Color | undefined
  dests: Map<Key, Key[]>
  lastMove: [Key, Key] | undefined
  nonce: number
  /** The SAN of the move the user should have played, after a miss. */
  correctSan: string | null
  /** Hint plumbing (0 = none, 1 = from-square, 2 = from+to, 3 = reveal SAN). */
  hintStage: 0 | 1 | 2 | 3
  hintFrom: Key | undefined
  hintTo: Key | undefined
  revealSan: string | null
  /** True once the user has taken any assist (hint/retry) this run. Clears firstTry. */
  assisted: boolean
  onUserMove: (orig: Key, dest: Key) => void
  /** Restart the same puzzle for practice (does NOT re-report the outcome). */
  retry: () => void
  bumpHint: () => void
}

function promoRole(uci: string): Role | undefined {
  return uci.length > 4 ? ROLE_FROM_CHAR[uci[4]] : undefined
}

/**
 * Drive the board for a single daily puzzle. `onComplete` fires exactly once per
 * load: the FIRST time the puzzle is finished (solved or failed). Carrying the
 * outcome the caller should persist. Subsequent retries replay locally without
 * firing it again.
 */
export function useDailySolver(
  puzzle: Puzzle | null,
  onComplete: (o: DailyOutcome) => void
): DailySolver {
  const { play, playMove } = useSound()

  const [phase, setPhase] = useState<DailyPhase>('idle')
  const [fen, setFen] = useState<string>(puzzle?.fen ?? INITIAL_FEN)
  const [orientation, setOrientation] = useState<Color>('white')
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const [correctSan, setCorrectSan] = useState<string | null>(null)
  const [hintStage, setHintStage] = useState<0 | 1 | 2 | 3>(0)
  const [assisted, setAssisted] = useState(false)

  const solutionIdxRef = useRef(1)
  const startMsRef = useRef(0)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const tokenRef = useRef(0)
  // Guards the "report once per load" contract; reset on (re)load, set on finish.
  const reportedRef = useRef(false)
  const assistedRef = useRef(false)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

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

  // ---- Lead-in: animate moves[0], then hand control to the solver ----
  const startLeadIn = useCallback(
    (p: Puzzle, token: number) => {
      clearTimers()
      setCorrectSan(null)
      setHintStage(0)
      solutionIdxRef.current = 1

      const m0 = p.moves[0]
      const shown = m0 && m0.length >= 4 ? applyMove(p.fen, m0.slice(0, 2), m0.slice(2, 4), promoRole(m0)) : null
      if (!shown) {
        // Corrupt puzzle: present the raw position and let the user try anyway.
        setFen(p.fen)
        setOrientation(turnColor(p.fen))
        setLastMove(undefined)
        startMsRef.current = performance.now()
        setPhase('solving')
        return
      }

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
    },
    [clearTimers, schedule, playMove]
  )
  const startLeadInRef = useRef(startLeadIn)
  startLeadInRef.current = startLeadIn

  // ---- (Re)load whenever the puzzle identity changes ----
  useEffect(() => {
    const token = ++tokenRef.current
    reportedRef.current = false
    assistedRef.current = false
    setAssisted(false)
    if (!puzzle) {
      clearTimers()
      setPhase('idle')
      setFen(INITIAL_FEN)
      setOrientation('white')
      setLastMove(undefined)
      return
    }
    startLeadInRef.current(puzzle, token)
    return () => {
      clearTimers()
    }
    // Re-run only when the day's puzzle changes (id), not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puzzle?.id, clearTimers])

  const finish = useCallback((solved: boolean) => {
    if (reportedRef.current) return
    reportedRef.current = true
    const ms = Math.round(performance.now() - startMsRef.current)
    onCompleteRef.current({ solved, firstTry: solved && !assistedRef.current, ms })
  }, [])

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
        const played = applyMove(fen, orig, dest)
        if (!played) {
          setNonce((n) => n + 1) // illegal own-move: snap back, not a fail
          return
        }
        // Legal but wrong -> the daily is failed for today.
        const right = applyMove(fen, expected.slice(0, 2), expected.slice(2, 4), promoRole(expected))
        setCorrectSan(right?.san ?? null)
        setLastMove(uciToLastMove(expected))
        setHintStage(0)
        setNonce((n) => n + 1)
        setPhase('failed')
        play('puzzleFailed')
        finish(false)
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
      setHintStage(0)
      const nextIdx = idx + 1
      solutionIdxRef.current = nextIdx

      if (nextIdx >= puzzle.moves.length) {
        setPhase('solved')
        play('puzzleSolved')
        finish(true)
        return
      }

      // Auto-reply (opponent move), then it's the user's turn again.
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
          // Corrupt reply: treat as solved (user did their part).
          setPhase('solved')
          finish(true)
          return
        }
        setFen(reply.fen)
        setLastMove(uciToLastMove(reply.uci))
        playMove(reply)
        solutionIdxRef.current = nextIdx + 1
      }, AUTO_REPLY_MS)
    },
    [phase, puzzle, fen, schedule, play, playMove, finish]
  )

  // ---- Retry (same puzzle, local practice does NOT re-report) ----
  const retry = useCallback(() => {
    if (!puzzle) return
    assistedRef.current = true
    setAssisted(true)
    const token = ++tokenRef.current
    startLeadInRef.current(puzzle, token)
  }, [puzzle])

  const bumpHint = useCallback(() => {
    if (phase !== 'solving') return
    assistedRef.current = true
    setAssisted(true)
    setHintStage((s) => (s < 3 ? ((s + 1) as 0 | 1 | 2 | 3) : s))
  }, [phase])

  return {
    phase,
    fen,
    orientation,
    turn,
    check,
    dests,
    lastMove,
    nonce,
    correctSan,
    hintStage,
    hintFrom,
    hintTo,
    revealSan,
    assisted,
    onUserMove,
    retry,
    bumpHint
  }
}
