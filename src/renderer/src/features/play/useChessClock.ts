// useChessClock: a single requestAnimationFrame timer driving both sides' clocks.
//
// Design:
//   * One rAF loop, never two intervals. It computes elapsed time from a
//     high-resolution timestamp so it stays accurate even if frames are dropped
//     or the tab is throttled.
//   * The hook owns no chess logic. The caller tells it whose turn it is and when
//     the game is over; the hook only counts down and reports events.
//   * Side effects (flag fall, low-time cue) are surfaced via stable callbacks
//     given through a ref so the rAF loop never goes stale.
//   * Cleans the rAF up on unmount and whenever the clock is not live (Unlimited,
//     game not running, or game over): no idle timer is left spinning.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Color } from '../../chess/chess'
import { LOW_TIME_MS, isTimed, type ClockTimes, type TimeControl } from './timeControl'

export interface UseChessClockArgs {
  timeControl: TimeControl
  /**
   * Monotonic key identifying the current game. Changing it resets both clocks
   * to `timeControl`'s base time: even when the control is unchanged between
   * games (same id ⇒ same reference would otherwise skip a reset).
   */
  gameKey: number
  /** Side currently on the move (clock counting down). */
  turn: Color
  /** True while the clock should be running (game live and not over). */
  running: boolean
  /** True when the game has ended. Clocks freeze immediately. */
  over: boolean
  /** Fired exactly once for the side whose clock reaches zero. */
  onFlag: (loser: Color) => void
  /** Fired once when the active side first drops below ~10s (per game). */
  onLowTime: () => void
}

export interface ChessClock {
  /** Live remaining milliseconds per side (re-rendered as it ticks). */
  times: ClockTimes
  /** Whether this control actually runs a clock. */
  active: boolean
  /** Add the configured increment to a side (call after that side moves). */
  addIncrement: (side: Color) => void
}

function baseTimes(tc: TimeControl): ClockTimes {
  return { white: tc.baseMs, black: tc.baseMs }
}

export function useChessClock({
  timeControl,
  gameKey,
  turn,
  running,
  over,
  onFlag,
  onLowTime
}: UseChessClockArgs): ChessClock {
  const active = isTimed(timeControl)

  const [times, setTimes] = useState<ClockTimes>(() => baseTimes(timeControl))

  // Authoritative remaining time lives in a ref; `times` mirrors it for render.
  // This keeps the rAF loop free of React state-closure staleness.
  const remainingRef = useRef<ClockTimes>(baseTimes(timeControl))
  const rafRef = useRef<number | null>(null)
  const lastTsRef = useRef<number | null>(null)
  const flaggedRef = useRef(false)
  const lowFiredRef = useRef(false)

  // Latest turn/callbacks, read inside the loop without re-subscribing it on
  // every move. (running/over gate the loop via its `live` dependency instead.)
  const turnRef = useRef(turn)
  turnRef.current = turn
  const onFlagRef = useRef(onFlag)
  onFlagRef.current = onFlag
  const onLowTimeRef = useRef(onLowTime)
  onLowTimeRef.current = onLowTime

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    lastTsRef.current = null
  }, [])

  const addIncrement = useCallback(
    (side: Color) => {
      if (!active || timeControl.incMs <= 0) return
      if (flaggedRef.current) return
      const next: ClockTimes = {
        ...remainingRef.current,
        [side]: remainingRef.current[side] + timeControl.incMs
      }
      remainingRef.current = next
      setTimes(next)
    },
    [active, timeControl.incMs]
  )

  // Reset to base time at the start of each game (gameKey bump) and whenever the
  // active control changes. Clears the per-game flag/low-time latches too.
  // Unlimited still parks the rAF loop via the `active` guard below.
  useEffect(() => {
    const fresh = baseTimes(timeControl)
    remainingRef.current = fresh
    flaggedRef.current = false
    lowFiredRef.current = false
    lastTsRef.current = null
    setTimes(fresh)
  }, [timeControl, gameKey])

  // The rAF loop. It runs only while the clock is live (timed control, game
  // running, not over). It is torn down (not merely parked) when the game ends
  // or pauses, and on unmount, honoring "clean up on unmount/game end".
  const live = active && running && !over
  useEffect(() => {
    if (!live) {
      stopRaf()
      return
    }

    const tick = (ts: number): void => {
      // Guard against a flag that fell mid-frame; otherwise count down.
      if (flaggedRef.current) {
        lastTsRef.current = ts
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      if (lastTsRef.current === null) lastTsRef.current = ts
      const dt = ts - lastTsRef.current
      lastTsRef.current = ts

      if (dt > 0) {
        const side = turnRef.current
        const prev = remainingRef.current[side]
        const nextVal = Math.max(0, prev - dt)
        if (nextVal !== prev) {
          const next: ClockTimes = { ...remainingRef.current, [side]: nextVal }
          remainingRef.current = next
          setTimes(next)
        }

        // Low-time cue: fire once when the active side first crosses below 10s.
        if (!lowFiredRef.current && nextVal < LOW_TIME_MS) {
          lowFiredRef.current = true
          onLowTimeRef.current()
        }

        // Flag fall: fire once, then freeze.
        if (nextVal <= 0 && !flaggedRef.current) {
          flaggedRef.current = true
          onFlagRef.current(side)
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return stopRaf
  }, [live, stopRaf])

  // Belt-and-suspenders cleanup on unmount.
  useEffect(() => stopRaf, [stopRaf])

  return { times, active, addIncrement }
}
