// Board-level move sounds, shared by every non-chess board component.
//
// The boards are presentation-only and never OWN state transitions, so the one
// place that reliably sees "a move just happened" in every mode (local OTB,
// vs bot, online) is the board itself: this hook watches the spec state's
// `moves` history and, when it grows by exactly one ply, plays the
// kind-idiomatic sample (goStone / discFlip / discDrop / pieceSlideCapture /
// penStroke: synthesized into assets/sounds/games/, see SoundManager).
//
// The generic MoveMeta ('move' | 'capture' | 'promote') from the spec is
// remapped per kind; 'pass' and 'swap' plies stay silent. Resets/history jumps
// (length not +1, or diverging history) play nothing.

import { useEffect, useRef } from 'react'
import { useSound, type SoundName } from '../../sound/useSound'
import type { GameKind } from '../kernel'
import { getGame } from '../registry'

const PLACE_SOUND: Partial<Record<GameKind, SoundName>> = {
  go: 'goStone',
  gomoku: 'goStone',
  checkers: 'discPlace',
  'checkers-intl': 'discPlace',
  othello: 'discFlip',
  connect4: 'discDrop',
  hex: 'penStroke',
  tictactoe: 'penStroke',
  morris: 'discPlace'
}

const CAPTURE_SOUND: Partial<Record<GameKind, SoundName>> = {
  go: 'capture',
  checkers: 'pieceSlideCapture',
  'checkers-intl': 'pieceSlideCapture',
  othello: 'discFlip',
  morris: 'capture'
}

interface StateWithMoves {
  moves: readonly string[]
}

function movesOf(state: unknown): readonly string[] | null {
  const m = (state as StateWithMoves | null)?.moves
  return Array.isArray(m) ? (m as readonly string[]) : null
}

export function useBoardSound(kind: GameKind, state: unknown): void {
  const { play } = useSound()
  const prevRef = useRef<unknown>(null)
  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = state
    const moves = movesOf(state)
    const prevMoves = movesOf(prev)
    if (!moves || !prevMoves) return
    // Exactly one new ply on the same game (shared history unchanged).
    if (moves.length !== prevMoves.length + 1) return
    if (prevMoves.length > 0 && moves[prevMoves.length - 1] !== prevMoves[prevMoves.length - 1]) return
    const move = moves[moves.length - 1]
    if (move === 'pass' || move === 'swap') return
    const spec = getGame(kind)?.spec
    let meta: ReturnType<NonNullable<typeof spec>['moveMeta']> = {}
    try {
      meta = spec ? spec.moveMeta(prev, move) : {}
    } catch {
      /* ffish preload race: stay silent over guessing */
    }
    // Chess family: the spec's sound IS the chess vocabulary (move/capture/
    // castle/check/promote). Play it verbatim. Other families remap to their
    // material-idiomatic samples.
    const name: SoundName =
      spec?.family === 'chess'
        ? (meta.sound ?? 'move')
        : meta.sound === 'promote'
          ? 'promote'
          : meta.capture
            ? (CAPTURE_SOUND[kind] ?? 'capture')
            : (PLACE_SOUND[kind] ?? 'move')
    play(name)
  }, [kind, state, play])
}
