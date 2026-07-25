// cgKeys: the ONE translation boundary between kernel/UCI square names and
// chessgroundx keys.
//
// chessgroundx Key ranks are SINGLE characters (types.d.ts `ranks`): '1'..'9'
// then ':' ';' '<' '=' '>' '?' '@' for ranks 10..16, i.e. rank 10 is ':' and
// the key for xiangqi's a10 is 'a:'. Kernel canonical moves (ffish /
// Fairy-Stockfish UCI, customVariants codec) spell the same square 'a10'.
// Casting 'a10' to cg.Key silently breaks every chessground lookup on rank 10
// (movable.dests, lastMove, fen-read piece lookups…): that was the
// xiangqi/janggi "black can't move back-rank pieces" bug. EVERY square that
// crosses the chessground boundary must go through these two helpers; never
// cast a UCI square string to cg.Key directly.
//
// Implementation reuses chessgroundx's own pos2key/key2pos so the mapping can
// never drift from the library's `ranks` table.

import type * as cg from 'chessgroundx/types'
import { key2pos, pos2key } from 'chessgroundx/util'

/** files a–p, ranks 1–16. Chessgroundx's hard limits (fairy-sf largeboard
 *  uses at most a–l / 1–10, comfortably inside). */
const UCI_SQUARE_RE = /^([a-p])(1[0-6]|[1-9])$/

/** UCI square name ('a10') → chessgroundx key ('a:'). Null when out of range. */
export function uciSquareToKey(square: string): cg.Key | null {
  const m = UCI_SQUARE_RE.exec(square)
  if (!m) return null
  return pos2key([m[1].charCodeAt(0) - 97, Number(m[2]) - 1])
}

/** chessgroundx key ('a:') → UCI square name ('a10'). */
export function keyToUciSquare(key: cg.Key): string {
  const [file, rank] = key2pos(key)
  return `${String.fromCharCode(97 + file)}${rank + 1}`
}
