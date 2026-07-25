import { parsePgn, startingPosition } from 'chessops/pgn'
import { parseSan, makeSan } from 'chessops/san'
import { makeFen } from 'chessops/fen'
import { makeUci } from 'chessops/util'
import type { AppliedMove } from '../../chess/chess'

export interface LoadedGame {
  /** FEN of the starting position (custom [FEN] tag or standard initial). */
  startFen: string
  /** Mainline moves, ready to feed into the game tree in order. */
  moves: AppliedMove[]
  /** Optional headers worth surfacing (players / result). */
  white?: string
  black?: string
  result?: string
}

/**
 * Parse a PGN string and extract the mainline as a sequence of AppliedMove,
 * walking with chessops so each move is legality-checked and gets a normalized
 * SAN + resulting FEN. Returns null when nothing playable could be parsed.
 *
 * Variations are dropped (v0 tree is mainline-only); illegal/garbled moves stop
 * the walk and we keep whatever parsed cleanly up to that point.
 */
export function parsePgnToGame(pgn: string): LoadedGame | null {
  const text = pgn.trim()
  if (!text) return null

  let games
  try {
    games = parsePgn(text)
  } catch {
    return null
  }
  const game = games.find((g) => g.moves.children.length > 0) ?? games[0]
  if (!game) return null

  const posResult = startingPosition(game.headers)
  if (posResult.isErr) return null
  const pos = posResult.unwrap()

  const startFen = makeFen(pos.toSetup())
  const moves: AppliedMove[] = []

  for (const node of game.moves.mainline()) {
    const move = parseSan(pos, node.san)
    if (!move) break // illegal / unparseable: stop cleanly
    const san = makeSan(pos, move)
    pos.play(move)
    moves.push({
      san,
      uci: makeUci(move),
      fen: makeFen(pos.toSetup()),
      capture: san.includes('x'),
      check: pos.isCheck()
    })
  }

  if (moves.length === 0) return null

  const header = (k: string): string | undefined => {
    const v = game.headers.get(k)
    return v && v !== '?' ? v : undefined
  }

  return {
    startFen,
    moves,
    white: header('White'),
    black: header('Black'),
    result: header('Result')
  }
}
