/**
 * Board-diff primitives for the local coaching engine (docs/content-coaching.md §3.3).
 *
 * Built on chessops (GPL-3.0, accepted as the project's rules library). The spec
 * names chess.js `attackers()`/`isAttacked()`, but this project ships chessops;
 * the equivalent primitive is `Position.kingAttackers(sq, color, occupied)`,
 * which returns the pseudo-legal attackers of a square by a colour given an
 * occupancy set. Varying the occupancy set lets us model ray-defence reveals and
 * x-ray relations exactly as the spec describes.
 *
 * All logic here is re-implemented from documented behaviour. No AGPL/GPL text
 * is copied.
 */

import { Chess } from 'chessops/chess'
import { parseFen } from 'chessops/fen'
import { makeSquare, opposite, squareFile, squareRank, roleToChar } from 'chessops/util'
import { between, ray } from 'chessops/attacks'
import { SquareSet } from 'chessops/squareSet'
import type { Color, Piece, Role, Square } from 'chessops/types'

/** Material values (pawn..queen). King is given a sentinel for comparisons. */
export const VAL: Record<Role, number> = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
  king: 99
}

const RAY_ROLES: ReadonlySet<Role> = new Set<Role>(['queen', 'rook', 'bishop'])

export function isRayRole(role: Role): boolean {
  return RAY_ROLES.has(role)
}

export const PIECE_NAME: Record<Role, string> = {
  pawn: 'pawn',
  knight: 'knight',
  bishop: 'bishop',
  rook: 'rook',
  queen: 'queen',
  king: 'king'
}

/** Parse a FEN into a chessops Chess position, or null when invalid. */
export function positionFromFen(fen: string): Chess | null {
  const setup = parseFen(fen)
  if (setup.isErr) return null
  const pos = Chess.fromSetup(setup.unwrap())
  if (pos.isErr) return null
  return pos.unwrap()
}

export function squareName(sq: Square): string {
  return makeSquare(sq)
}

export function pieceName(piece: Piece): string {
  return PIECE_NAME[piece.role]
}

/**
 * isDefended: a same-colour (relative to the piece on `sq`) attacker exists, OR
 * a ray-defence reveal: removing a same-colour ray attacker on the line reveals
 * a same-colour ray defender behind it. We approximate the reveal by recomputing
 * defenders against an occupancy with the nearest same-colour defender removed.
 */
export function isDefended(pos: Chess, sq: Square): boolean {
  const piece = pos.board.get(sq)
  if (!piece) return false
  const own = piece.color
  const direct = pos.kingAttackers(sq, own, pos.board.occupied)
  if (direct.nonEmpty()) return true
  // Ray-defence reveal: try removing each own ray piece that lies on a line with
  // `sq` and see whether a deeper own ray defender appears.
  for (const defSq of pos.board[own]) {
    const dp = pos.board.get(defSq)
    if (!dp || !isRayRole(dp.role)) continue
    if (ray(defSq, sq).isEmpty()) continue
    const occ = pos.board.occupied.without(defSq)
    if (pos.kingAttackers(sq, own, occ).without(defSq).nonEmpty()) return true
  }
  return false
}

/** A non-king enemy attacker exists for the piece on `sq`. */
export function hasEnemyAttacker(pos: Chess, sq: Square): boolean {
  const piece = pos.board.get(sq)
  if (!piece) return false
  const enemy = opposite(piece.color)
  return pos.kingAttackers(sq, enemy, pos.board.occupied).nonEmpty()
}

/** isHanging = undefended AND attacked by an enemy. */
export function isHanging(pos: Chess, sq: Square): boolean {
  if (!hasEnemyAttacker(pos, sq)) return false
  return !isDefended(pos, sq)
}

/** An enemy non-king attacker of strictly lower value exists. */
export function canBeTakenByLowerPiece(pos: Chess, sq: Square): boolean {
  const piece = pos.board.get(sq)
  if (!piece) return false
  const enemy = opposite(piece.color)
  const val = VAL[piece.role]
  for (const aSq of pos.kingAttackers(sq, enemy, pos.board.occupied)) {
    const ap = pos.board.get(aSq)
    if (!ap || ap.role === 'king') continue
    if (VAL[ap.role] < val) return true
  }
  return false
}

/** isInBadSpot = attacked AND (hanging OR can be taken by a lower piece). */
export function isInBadSpot(pos: Chess, sq: Square): boolean {
  if (!hasEnemyAttacker(pos, sq)) return false
  return isHanging(pos, sq) || canBeTakenByLowerPiece(pos, sq)
}

/**
 * isTrapped: a non-pawn/non-king piece in a bad spot, with no legal escape to a
 * non-bad square, and no equal-or-better capture available.
 */
export function isTrapped(pos: Chess, sq: Square): boolean {
  const piece = pos.board.get(sq)
  if (!piece || piece.role === 'pawn' || piece.role === 'king') return false
  if (!isInBadSpot(pos, sq)) return false
  if (pos.turn !== piece.color) return false // only the side to move can flee/capture
  for (const to of pos.dests(sq)) {
    const target = pos.board.get(to)
    if (target) {
      // an equal-or-better capture is an out
      if (VAL[target.role] >= VAL[piece.role]) return false
    }
    const after = pos.clone()
    after.play({ from: sq, to })
    // after the escape, is the piece (now on `to`) still in a bad spot?
    if (!isInBadSpot(after, to)) return false
  }
  return true
}

export interface MaterialCount {
  white: number
  black: number
}

/** Total non-king material on the board per colour (pawn=1..queen=9). */
export function materialCount(pos: Chess): MaterialCount {
  let white = 0
  let black = 0
  for (const [, piece] of pos.board) {
    if (piece.role === 'king') continue
    if (piece.color === 'white') white += VAL[piece.role]
    else black += VAL[piece.role]
  }
  return { white, black }
}

/** Signed material balance from `pov`'s perspective. */
export function materialFor(pos: Chess, pov: Color): number {
  const m = materialCount(pos)
  return pov === 'white' ? m.white - m.black : m.black - m.white
}

/** Squares adjacent to a square (the king ring). */
export function ringOf(sq: Square): SquareSet {
  const f = squareFile(sq)
  const r = squareRank(sq)
  let set = SquareSet.empty()
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue
      const nf = f + df
      const nr = r + dr
      if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue
      set = set.with(nr * 8 + nf)
    }
  }
  return set
}


/** The set of enemy non-king pieces attacked by the piece standing on `sq`. */
export function attackedEnemyPieces(pos: Chess, sq: Square): { sq: Square; piece: Piece }[] {
  const piece = pos.board.get(sq)
  if (!piece) return []
  const enemy = opposite(piece.color)
  const out: { sq: Square; piece: Piece }[] = []
  for (const tSq of pos.board[enemy]) {
    const tp = pos.board.get(tSq)
    if (!tp || tp.role === 'king') continue
    // does our piece attack tSq?
    if (pos.kingAttackers(tSq, piece.color, pos.board.occupied).has(sq)) {
      out.push({ sq: tSq, piece: tp })
    }
  }
  return out
}

export { between, ray, opposite, squareFile, squareRank, roleToChar }
export type { Square, Piece, Role, Color }
