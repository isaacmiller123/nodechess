// One hook, five surfaces: archive every finished games-tab game
// (KernelOtb/KernelBot, VariantOtb/VariantBot, editor PlayCustom) to the game
// table: the platform foundation that makes every mode reviewable. The
// online/chess paths keep their own richer save flows (onlineStore.saveFinished,
// PlayView.finishGame); this hook covers the LOCAL surfaces that used to drop
// finished games on the floor.
//
// Mechanics: every kernel state carries its full move history, and states are
// immutable, so the hook watches the live state, captures each fresh game's
// START state (moves.length === 0 ⇒ new game, also re-arming the save latch),
// and on the first non-null result encodes the archive envelope
// (games/archive.ts: verbatim codec moves + notateGame notation + replay
// options) and fires games.save. Best-effort by contract: a failed IPC never
// blocks the result banner, and a save is attempted at most once per game.

import { useEffect, useRef } from 'react'
import { archiveFinishedGame } from '../../games/archive'
import type { GameResult, GameSpec } from '../../games/kernel'

export interface SaveNaming {
  /** Display names in kernel color space ('You' / 'Bot L3' / side labels). */
  white: string
  black: string
  /** Display context, e.g. 'Over the board' | 'Play vs Bot' | 'Variant Lab'. */
  event: string
  source: 'play-otb' | 'play-bot' | 'custom'
  /** The human's seat in bot games; omit for two-human (OTB) games. */
  userColor?: 'white' | 'black'
  opponentKind: 'human' | 'engine'
  opponentLabel?: string
}

interface StateWithMoves {
  moves?: readonly string[]
}

/** `spec` may be null while a surface is still loading its rules engine
 *  (PlayCustom registers dynamically): the hook is then inert, keeping the
 *  call unconditional above early returns (hooks-before-returns, CLAUDE.md). */
export function useSaveFinishedGame<S>(
  spec: GameSpec<S> | null,
  state: S | null,
  result: GameResult | null,
  naming: SaveNaming
): void {
  const startRef = useRef<S | null>(null)
  const savedRef = useRef(false)
  // Naming is a per-render literal at every call site; the ref keeps the save
  // effect's dependencies to the things that MEAN "the game finished".
  const namingRef = useRef(naming)
  namingRef.current = naming

  // Capture each fresh game's start state (and re-arm the latch): every
  // surface funnels new games through spec.init, whose state has no moves.
  useEffect(() => {
    if (state !== null && ((state as StateWithMoves).moves?.length ?? 0) === 0) {
      startRef.current = state
      savedRef.current = false
    }
  }, [state])

  useEffect(() => {
    if (!spec || !result || savedRef.current || state === null || startRef.current === null) return
    const moves = (state as StateWithMoves).moves ?? []
    if (moves.length === 0) return // a start position that is already terminal
    savedRef.current = true // latched even on failure: never re-fire per game
    const n = namingRef.current
    const pgn = archiveFinishedGame({
      spec,
      start: startRef.current,
      moves,
      result,
      white: n.white,
      black: n.black,
      event: n.event
    })
    void window.api?.games
      .save({
        pgn,
        whiteName: n.white,
        blackName: n.black,
        ...(n.userColor ? { userColor: n.userColor } : {}),
        result: result.score,
        opponentKind: n.opponentKind,
        ...(n.opponentLabel ? { opponentLabel: n.opponentLabel } : {}),
        source: n.source,
        gameKind: spec.kind
      })
      .catch(() => {})
  }, [result, state, spec])
}
