// The base-plus-increment clock for the games-platform surfaces.
//
// design-lab/v1/games.html puts a Time row on every game and fills it from the
// twelve controls in features/play/timeControl.ts, so every surface behind that
// row has to be able to run one. This is the one place that mounts it.
//
// Go is the exception and keeps goClock.tsx: a go clock is main time plus
// byo-yomi periods, and a Fischer increment is not a thing there.
//
// The counting is features/play/useChessClock (one rAF loop for both sides,
// torn down when the game is not live). Everything below is the seam: when the
// clock arms, who gets the increment, and the two rows that show it.

import { useCallback, useEffect, useRef, type JSX } from 'react'
import { ClockGroup, ClockRow } from './clockFace'
import { useChessClock } from '../play/useChessClock'
import { timeControlById } from '../play/timeControl'
import type { PlayerColor } from '../../games/kernel'

export interface SurfaceClock {
  /** False for Unlimited: nothing to run and nothing to draw. */
  active: boolean
  ms(side: PlayerColor): number
  /** The control the player picked, e.g. '5+3'. Captions the pair. */
  label: string
}

export interface SurfaceClockArgs {
  /** A features/play/timeControl.ts id, or undefined for no clock at all. */
  tcId: string | undefined
  /** Bumped on every fresh game so both clocks go back to the base time. */
  gameKey: number
  /** Side on the move. */
  turn: PlayerColor
  /** How many moves have been committed this game. */
  moves: number
  /** The game is live: not finished, not paused on a scoring phase. */
  live: boolean
  /** The game has ended, on the board or on the clock. Freezes the display. */
  over: boolean
  /** The side whose clock reached zero. Fires once. */
  onFlag: (loser: PlayerColor) => void
}

/**
 * A running clock for one local game.
 *
 * The opener thinks free: the clock arms on the first committed move, the same
 * grace the go clock and the online first move already give.
 */
export function useSurfaceClock({
  tcId,
  gameKey,
  turn,
  moves,
  live,
  over,
  onFlag
}: SurfaceClockArgs): SurfaceClock {
  const timeControl = timeControlById(tcId ?? 'unlimited')
  const silent = useCallback(() => {
    /* The low-time cue belongs to Play's sound settings, not to this surface. */
  }, [])

  const clock = useChessClock({
    timeControl,
    gameKey,
    turn,
    running: live && moves > 0,
    over,
    onFlag,
    onLowTime: silent
  })

  /* The increment belongs to the side that just moved, which is the side that
     is NOT on the move now. Counting moves rather than watching the state is
     what keeps this correct across a restart: `moves` drops back to zero and
     the run below simply has nothing to pay. */
  const counted = useRef(0)
  const addIncrement = clock.addIncrement
  useEffect(() => {
    const prev = counted.current
    if (moves === prev) return
    counted.current = moves
    if (moves > prev) addIncrement(turn === 'white' ? 'black' : 'white')
    // `turn` is read at the moment a move lands, so it is not a dependency of
    // its own: only a change in the move count may pay an increment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moves, addIncrement])

  return {
    active: clock.active,
    ms: (side) => clock.times[side],
    label: timeControl.label
  }
}

/** The two clock rows, in play order, on the surfaces' own clock furniture. */
export function SurfaceClockPair({
  clock,
  turn,
  labels,
  order = ['white', 'black'],
  over
}: {
  clock: SurfaceClock
  turn: PlayerColor
  labels: { white: string; black: string }
  /** Play order, opener first: black opens go, gomoku, othello and morris. */
  order?: readonly PlayerColor[]
  over: boolean
}): JSX.Element | null {
  if (!clock.active) return null
  return (
    <ClockGroup caption={clock.label}>
      {order.map((side) => (
        <ClockRow
          key={side}
          side={side}
          name={labels[side]}
          ms={clock.ms(side)}
          active={turn === side}
          over={over}
        />
      ))}
    </ClockGroup>
  )
}
