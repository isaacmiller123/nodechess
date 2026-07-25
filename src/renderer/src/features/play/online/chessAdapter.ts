// The DEFAULT OnlineGameAdapter: standard chess via the existing chessops
// helpers. State S = FEN string; move codec = UCI. Extracting the store's
// previous inline chessops usage behind the adapter seam keeps online chess
// byte-for-byte behavioral; every other game registers through the kernel
// registry via gameAdapter.adapterFromSpec (see onlineStore's init). This file
// stays dedicated (rather than wrapping the chess GameSpec) so the chess path
// keeps its SAN-producing moveMeta. The store's PGN archive depends on it.
// Must stay bare-node clean (scripts/test-mp-store.mjs bundles it).

import type { MpColor } from '@shared/types'
import {
  applyMove,
  hasInsufficientMaterial,
  outcome,
  turnColor,
  INITIAL_FEN
} from '../../../chess/chess'
import type { OnlineGameAdapter, OnlineMoveMeta } from './gameAdapter'

function uciPromo(uci: string): 'queen' | 'rook' | 'bishop' | 'knight' | undefined {
  switch (uci[4]) {
    case 'q':
      return 'queen'
    case 'r':
      return 'rook'
    case 'b':
      return 'bishop'
    case 'n':
      return 'knight'
    default:
      return undefined
  }
}

export const chessOnlineAdapter: OnlineGameAdapter<string> = {
  kind: 'chess',

  // Chess has no start options (TODO(P2): chess960 seed etc. would land here).
  init(): string {
    return INITIAL_FEN
  },

  play(fen: string, move: string): string | null {
    const m = applyMove(fen, move.slice(0, 2), move.slice(2, 4), uciPromo(move))
    return m ? m.fen : null
  },

  result(fen: string): { result: '1-0' | '0-1' | '1/2-1/2'; reason: string } | null {
    const out = outcome(fen)
    if (!out.over || !out.result) return null
    return { result: out.result, reason: out.reason ?? 'checkmate' }
  },

  turn(fen: string): MpColor {
    return turnColor(fen)
  },

  positionKey(fen: string): string {
    return fen
  },

  moveMeta(fen: string, move: string): OnlineMoveMeta | null {
    const m = applyMove(fen, move.slice(0, 2), move.slice(2, 4), uciPromo(move))
    return m ? { san: m.san, capture: m.capture, check: m.check } : null
  },

  /** Lichess timeout rule: if the side that did NOT flag can never mate, the
   *  flag is a draw. Otherwise a plain win on time. */
  flagResult(fen: string, by: MpColor): { result: '1-0' | '0-1' | '1/2-1/2'; reason: string } {
    const winner: MpColor = by === 'white' ? 'black' : 'white'
    if (hasInsufficientMaterial(fen, winner)) {
      return { result: '1/2-1/2', reason: 'time out: insufficient material' }
    }
    return { result: winner === 'white' ? '1-0' : '0-1', reason: 'on time' }
  }
}
