// Finished-game → archive envelope glue (src/shared/gameArchive.ts contract).
//
// Every non-chess play surface (KernelOtb/KernelBot, VariantOtb/VariantBot,
// PlayCustom, onlineStore's non-chess path) funnels its finished game through
// archiveFinishedGame(): wire-codec moves verbatim + per-move notation
// (kernel notateGame replay from the recorded START state) + the init options
// that reproduce the start position. Best-effort by design: callers fire
// window.api.games.save with the returned text and never block the banner.

import {
  encodeGameArchive,
  type GameArchive,
  type GameArchiveMeta
} from '@shared/gameArchive'
import { notateGame, type GameResult, type GameSpec } from './kernel'

/** Structural slice of the spec states replayOptionsOf understands. */
interface StartStateShape {
  startFen?: string
  size?: number
  komi?: number
  scoring?: string
  handicap?: number
}

/**
 * The init-options value that reproduces `start` via spec.init(options)
 * (stored as meta.options; undefined = default start, omitted):
 *   - chess family (chessops/ffish/custom states): { fen: startFen }. Covers
 *     chess960 shuffles and custom-FEN starts;
 *   - go: size/komi/scoring/handicap (all live on the state);
 *   - gomoku: size;
 *   - everything else: default start (their options exist for tests only).
 */
export function replayOptionsOf<S>(spec: GameSpec<S>, start: S): unknown {
  const st = start as StartStateShape
  if (spec.family === 'chess' && typeof st.startFen === 'string') return { fen: st.startFen }
  if (spec.kind === 'go') {
    return { size: st.size, komi: st.komi, scoring: st.scoring, handicap: st.handicap }
  }
  if (spec.kind === 'gomoku') return { size: st.size }
  return undefined
}

export interface ArchiveInput<S> {
  spec: GameSpec<S>
  /** The immutable state the game STARTED from (spec.init output). */
  start: S
  /** Wire-codec history, play order (state.moves of the final state). */
  moves: readonly string[]
  result: GameResult
  /** Display names in kernel color space. */
  white: string
  black: string
  /** Display context, e.g. 'Over the board' | 'Play vs Bot'. */
  event: string
}

function yyyymmdd(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}.${m}.${day}`
}

/** Envelope text for the game table's `pgn` column (non-chess kinds). */
export function archiveFinishedGame<S>(input: ArchiveInput<S>): string {
  const { spec, start, moves, result } = input
  const options = replayOptionsOf(spec, start)
  // Notation is best-effort: a throwing rules engine (ffish teardown race)
  // must never cost us the archive itself. The codec moves still replay.
  let notated: string[] | undefined
  try {
    notated = notateGame(spec, start, moves)
  } catch {
    notated = undefined
  }
  const meta: GameArchiveMeta = {
    ...(notated !== undefined ? { notated } : {}),
    reason: result.reason,
    white: input.white,
    black: input.black,
    ...(options !== undefined ? { options } : {}),
    event: input.event,
    date: yyyymmdd()
  }
  const archive: GameArchive = {
    v: 1,
    kind: spec.kind,
    moves: [...moves],
    result: result.score,
    meta
  }
  return encodeGameArchive(archive)
}
