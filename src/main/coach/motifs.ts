/**
 * Motif detectors (docs/content-coaching.md §3.4) over an engine PV or the
 * played continuation. Each detector is a pure-ish boolean/struct over board
 * states. The caller (index.ts) GATES every claim on the engine eval swing.
 * A static scan alone can be fooled by pins/in-between moves.
 *
 * All detector logic is re-implemented from documented behaviour
 * (lichess-puzzler cook.py/util.py, Lichess Advice.scala). The upstream
 * `overloading()` is a stub returning false; it is implemented here per spec.
 */

import { Chess } from 'chessops/chess'
import { opposite, squareFile, squareRank } from 'chessops/util'
import { between } from 'chessops/attacks'
import type { Color, Piece, Square } from 'chessops/types'
import {
  VAL,
  isRayRole,
  isHanging,
  isInBadSpot,
  isDefended,
  attackedEnemyPieces,
  pieceName,
  squareName
} from './board'

export type MotifKey =
  | 'fork'
  | 'pin'
  | 'skewer'
  | 'discoveredAttack'
  | 'discoveredCheck'
  | 'doubleCheck'
  | 'hangingPiece'
  | 'backRankMate'
  | 'mate'
  | 'deflection'
  | 'interference'
  | 'overloaded'
  | 'capturingDefender'
  | 'xRay'
  | 'trappedPiece'

export interface MotifHit {
  key: MotifKey
  /** Human-facing fragment, e.g. "leaves the rook undefended" / "checkmate". */
  detail?: string
  /** The piece doing the work (e.g. the forking knight) for {pieceName}. */
  pieceName?: string
  /** The piece(s) being targeted/won for {targetName}. */
  targetName?: string
  /** Optional square for template slots. */
  square?: string
}

/** A single ply in a replayed line. */
export interface Ply {
  /** Position BEFORE the move was played. */
  before: Chess
  /** The move that was played. */
  move: { from: Square; to: Square; promotion?: string }
  /** Position AFTER the move (already played). */
  after: Chess
  /** Piece that moved (from `before`). */
  moved: Piece
  /** Piece captured by this move, if any (from `before`). */
  captured: Piece | null
}

/** Replay a sequence of moves from a start position into Ply records. */
export function buildLine(start: Chess, moves: { from: Square; to: Square; promotion?: string }[]): Ply[] {
  const plies: Ply[] = []
  let cur = start
  for (const move of moves) {
    const before = cur
    const moved = before.board.get(move.from)
    if (!moved) break
    const captured = before.board.get(move.to) ?? null
    const after = before.clone()
    const m: { from: Square; to: Square; promotion?: import('chessops/types').Role } = {
      from: move.from,
      to: move.to
    }
    if (move.promotion) m.promotion = move.promotion as import('chessops/types').Role
    if (!before.isLegal(m)) break
    after.play(m)
    plies.push({ before, move, after, moved, captured })
    cur = after
  }
  return plies
}

/**
 * fork: the moving piece (not the king) lands on a square attacking >1 enemy
 * piece. Each target is either the enemy king (a check, which must be answered
 * first), a more valuable enemy non-pawn, or a hanging enemy non-pawn. When the
 * move delivers check, the moving piece's own "bad spot" status is ignored. The
 * opponent must respond to the check before capturing the forking piece, so the
 * second target falls. Otherwise the forking square must not be in a bad spot.
 */
export function detectFork(ply: Ply): MotifHit | null {
  const { moved, move, after } = ply
  if (moved.role === 'king') return null
  const givesCheck = after.isCheck()
  if (!givesCheck && isInBadSpot(after, move.to)) return null
  const targets = attackedEnemyPieces(after, move.to).filter((t) => {
    if (t.piece.role === 'pawn') return false
    if (VAL[t.piece.role] > VAL[moved.role]) return true
    // hanging target (the moving piece is its only/extra attacker)
    return isHanging(after, t.sq)
  })
  // Count a delivered check on the enemy king as one fork prong.
  const targetNames = targets.map((t) => pieceName(t.piece))
  const prongs = targets.length + (givesCheck ? 1 : 0)
  if (prongs > 1) {
    const allNames = givesCheck ? ['king', ...targetNames] : targetNames
    return {
      key: 'fork',
      detail: allNames.join(' and '),
      pieceName: pieceName(moved),
      // the joined target list drives the {targetName} slot ("king and queen").
      targetName: joinTargets(allNames),
      square: squareName(move.to)
    }
  }
  return null
}

/** Join target names with leading articles, e.g. "king and queen". */
function joinTargets(names: string[]): string {
  return names.join(' and ')
}

/**
 * pin. Derived via ray scan: an enemy piece on the line between one of `color`'s
 * ray pieces and (a) the enemy king => absolute pin; (b) a more valuable enemy
 * piece => relative pin. `color` is the side doing the pinning.
 */
export function detectPin(pos: Chess, color: Color): MotifHit | null {
  const enemy = opposite(color)
  const enemyKing = pos.board.kingOf(enemy)
  for (const fromSq of pos.board[color]) {
    const piece = pos.board.get(fromSq)
    if (!piece || !isRayRole(piece.role)) continue
    // candidate "behind" pieces: enemy king or any more valuable enemy piece.
    for (const behindSq of pos.board[enemy]) {
      const behind = pos.board.get(behindSq)
      if (!behind) continue
      const isKing = behindSq === enemyKing
      // line of sight: ray piece and behind must be aligned and reachable by role
      const lineSquares = between(fromSq, behindSq)
      if (lineSquares.isEmpty() && fromSq !== behindSq) {
        // not aligned (between returns empty for non-aligned OR adjacent)
        continue
      }
      // role must be able to travel that line type
      if (!rayCovers(piece.role, fromSq, behindSq)) continue
      // exactly one enemy piece sits on the line, and the path is otherwise clear
      const blockers: Square[] = []
      let blocked = false
      for (const mid of lineSquares) {
        const mp = pos.board.get(mid)
        if (!mp) continue
        if (mp.color === color) {
          blocked = true
          break
        }
        blockers.push(mid)
      }
      if (blocked || blockers.length !== 1) continue
      const pinnedSq = blockers[0]
      const pinned = pos.board.get(pinnedSq)!
      if (pinned.role === 'king') continue
      const valuableBehind = !isKing && VAL[behind.role] > VAL[pinned.role]
      if (isKing) {
        return {
          key: 'pin',
          detail: `the ${pieceName(pinned)} is pinned to the king`,
          targetName: pieceName(pinned),
          square: squareName(pinnedSq)
        }
      }
      if (valuableBehind) {
        return {
          key: 'pin',
          detail: `the ${pieceName(pinned)} is pinned to the ${pieceName(behind)}`,
          targetName: pieceName(pinned),
          square: squareName(pinnedSq)
        }
      }
    }
  }
  return null
}

function rayCovers(role: Piece['role'], a: Square, b: Square): boolean {
  const sameFile = squareFile(a) === squareFile(b)
  const sameRank = squareRank(a) === squareRank(b)
  const sameDiag = Math.abs(squareFile(a) - squareFile(b)) === Math.abs(squareRank(a) - squareRank(b))
  if (role === 'rook') return sameFile || sameRank
  if (role === 'bishop') return sameDiag
  if (role === 'queen') return sameFile || sameRank || sameDiag
  return false
}

/**
 * skewer: after an opponent ray-piece move, the player captures on the same
 * line with a ray piece; the more valuable enemy piece was in front, exposing a
 * lesser one behind; the capture lands in a bad spot for the capturer.
 */
export function detectSkewer(prev: Ply, ply: Ply): MotifHit | null {
  const { moved, move, captured, before } = ply
  if (!captured || !isRayRole(moved.role)) return null
  // the captured (front) piece must be more valuable than what sits behind on the line
  if (!isRayRole(prev.moved.role)) {
    // opponent's previously-moved piece is the one we are now capturing
  }
  // the previous opponent move must have placed the captured piece in our line
  if (prev.move.to !== move.to) return null
  // find what stands behind the capture square along the capture line
  const behindSq = behindOnLine(before, move.from, move.to)
  if (behindSq === null) return null
  const behind = before.board.get(behindSq)
  if (!behind || behind.color === moved.color) return null
  if (VAL[captured.role] <= VAL[behind.role]) return null
  return {
    key: 'skewer',
    detail: `${pieceName(captured)} skewered to the ${pieceName(behind)}`,
    targetName: pieceName(behind),
    square: squareName(behindSq)
  }
}

/** First piece behind `to` looking from `from` through `to` along their line. */
function behindOnLine(pos: Chess, from: Square, to: Square): Square | null {
  const df = Math.sign(squareFile(to) - squareFile(from))
  const dr = Math.sign(squareRank(to) - squareRank(from))
  if (df === 0 && dr === 0) return null
  let f = squareFile(to) + df
  let r = squareRank(to) + dr
  while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
    const sq = r * 8 + f
    if (pos.board.get(sq)) return sq
    f += df
    r += dr
  }
  return null
}

/** double_check: more than one checker in the resulting position. */
export function detectDoubleCheck(ply: Ply): MotifHit | null {
  const ctx = ply.after.ctx()
  if (ctx.checkers.moreThanOne()) {
    return { key: 'doubleCheck', detail: 'double check' }
  }
  return null
}

/**
 * discovered_check: a checker exists that is NOT the square the player just
 * moved to. discovered_attack: discovered_check OR a capture whose
 * from->to between-squares contain the previous move's `from` (the vacated line).
 */
export function detectDiscovered(prev: Ply | null, ply: Ply): MotifHit | null {
  const ctx = ply.after.ctx()
  // discovered check: a checker that isn't the moved piece's destination.
  for (const checker of ctx.checkers) {
    if (checker !== ply.move.to) {
      return { key: 'discoveredCheck', detail: 'discovered check' }
    }
  }
  // discovered attack via a vacated line from the previous move.
  if (prev) {
    const lineSquares = between(ply.move.from, ply.move.to)
    if (lineSquares.has(prev.move.from)) {
      return { key: 'discoveredAttack', detail: 'discovered attack' }
    }
  }
  return null
}

/**
 * hanging piece: the piece captured on this player move was a non-pawn that was
 * hanging in the position before the capture.
 */
export function detectHangingCapture(ply: Ply): MotifHit | null {
  const { captured, move, before } = ply
  if (!captured || captured.role === 'pawn') return null
  if (isHanging(before, move.to)) {
    return {
      key: 'hangingPiece',
      detail: `the undefended ${pieceName(captured)} on ${squareName(move.to)}`,
      targetName: pieceName(captured),
      square: squareName(move.to)
    }
  }
  return null
}

/**
 * back-rank mate: final position is checkmate, the mated king is on its back
 * rank, its forward escape squares are blocked/attacked, and >=1 checker sits on
 * the back rank.
 */
export function detectBackRankMate(pos: Chess): MotifHit | null {
  if (!pos.isCheckmate()) return null
  const mated = pos.turn // side to move is the mated side
  const king = pos.board.kingOf(mated)
  if (king === undefined) return null
  const backRank = mated === 'white' ? 0 : 7
  if (squareRank(king) !== backRank) return null
  const ctx = pos.ctx()
  let checkerOnBack = false
  for (const c of ctx.checkers) {
    if (squareRank(c) === backRank) checkerOnBack = true
  }
  if (!checkerOnBack) return null
  // forward escape squares blocked by own pieces (the classic pattern)
  const dir = mated === 'white' ? 1 : -1
  const f = squareFile(king)
  let ownBlocker = false
  for (let df = -1; df <= 1; df++) {
    const nf = f + df
    const nr = squareRank(king) + dir
    if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue
    const p = pos.board.get(nr * 8 + nf)
    if (p && p.color === mated) ownBlocker = true
  }
  if (!ownBlocker) return null
  return { key: 'backRankMate', detail: 'back-rank mate' }
}

/** general mate-net: final position is checkmate; report mate distance. */
export function detectMate(pos: Chess, mateInPlies: number | null): MotifHit | null {
  if (!pos.isCheckmate()) {
    if (mateInPlies != null && mateInPlies > 0) {
      const moves = Math.ceil(mateInPlies / 2)
      return { key: 'mate', detail: `forced mate in ${moves}` }
    }
    return null
  }
  return { key: 'mate', detail: 'checkmate' }
}

/**
 * deflection: capture a piece that is hanging ONLY because a defending ray piece
 * was distracted from its line on the previous player move (the defender no
 * longer covers the capture square).
 */
export function detectDeflection(prev: Ply | null, ply: Ply): MotifHit | null {
  if (!prev) return null
  const { captured, move, before } = ply
  if (!captured) return null
  if (!isHanging(before, move.to)) return null
  // Was the captured square defended before the deflecting move was made?
  // prev.before is the position before the deflecting move; check the target then.
  const prevTargetPiece = prev.before.board.get(move.to)
  if (!prevTargetPiece) return null
  // It was defended before prev's move but is hanging now => the prev move removed/distracted a defender.
  if (isDefended(prev.before, move.to) && !isDefended(before, move.to)) {
    return {
      key: 'deflection',
      detail: `leaves the ${pieceName(captured)} on ${squareName(move.to)} undefended`,
      targetName: pieceName(captured),
      square: squareName(move.to)
    }
  }
  return null
}

/**
 * interference: capture a piece hanging only because an interfering piece landed
 * on a between-square of (target, its defender) on the previous player move,
 * severing the defence.
 */
export function detectInterference(prev: Ply | null, ply: Ply): MotifHit | null {
  if (!prev) return null
  const { captured, move, before } = ply
  if (!captured) return null
  if (!isHanging(before, move.to)) return null
  // The previous move's destination is the interfering square; it must sit
  // between the captured piece and a (former) ray defender.
  const interSq = prev.move.to
  // find an enemy ray defender (relative to captured) that previously defended.
  const defColor = captured.color
  for (const defSq of prev.before.board[defColor]) {
    const dp = prev.before.board.get(defSq)
    if (!dp || !isRayRole(dp.role)) continue
    const line = between(defSq, move.to)
    if (line.isEmpty()) continue
    if (!line.has(interSq)) continue
    // defender covered the target before, interfering piece now sits on the line.
    if (prev.before.kingAttackers(move.to, defColor, prev.before.board.occupied).has(defSq)) {
      return {
        key: 'interference',
        detail: `the defence of the ${pieceName(captured)} was cut off`,
        targetName: pieceName(captured),
        square: squareName(move.to)
      }
    }
  }
  return null
}

/**
 * overloaded: a single enemy piece is the SOLE defender of two or more player
 * targets (implemented per spec; upstream lichess `overloading()` is a stub).
 * `color` is the side exploiting the overload (i.e. the enemy piece belongs to
 * `opposite(color)` and defends `opposite(color)`'s own pieces).
 */
export function detectOverloaded(pos: Chess, color: Color): MotifHit | null {
  const defenderColor = opposite(color)
  // For each enemy piece D, collect that side's pieces whose ONLY defender is D.
  for (const dSq of pos.board[defenderColor]) {
    const dp = pos.board.get(dSq)
    if (!dp || dp.role === 'king') continue
    const guarded: Square[] = []
    for (const tSq of pos.board[defenderColor]) {
      if (tSq === dSq) continue
      const tp = pos.board.get(tSq)
      if (!tp) continue
      // tSq must be attacked by `color` (a real target) ...
      if (pos.kingAttackers(tSq, color, pos.board.occupied).isEmpty()) continue
      // ... and defended ONLY by D among same-colour defenders.
      const defenders = pos.kingAttackers(tSq, defenderColor, pos.board.occupied)
      if (defenders.size() === 1 && defenders.has(dSq)) {
        guarded.push(tSq)
      }
    }
    if (guarded.length >= 2) {
      const names = guarded.map((s) => `${pieceName(pos.board.get(s)!)} on ${squareName(s)}`)
      return {
        key: 'overloaded',
        detail: `the ${pieceName(dp)} is overloaded defending the ${names.join(' and ')}`,
        targetName: pieceName(dp),
        square: squareName(dSq)
      }
    }
  }
  return null
}

/**
 * capturing the defender: this player move captures a piece that was the sole
 * defender of another enemy piece, which then becomes hanging.
 */
export function detectCapturingDefender(ply: Ply): MotifHit | null {
  const { captured, move, before, after, moved } = ply
  if (!captured) return null
  const enemy = captured.color
  // Which enemy pieces did the captured piece defend (before)?
  for (const tSq of before.board[enemy]) {
    if (tSq === move.to) continue
    const tp = before.board.get(tSq)
    if (!tp || tp.role === 'king') continue
    const defendersBefore = before.kingAttackers(tSq, enemy, before.board.occupied)
    if (!defendersBefore.has(move.to)) continue
    // After the capture, that piece becomes hanging (and isn't the square we now occupy).
    if (tSq === move.to) continue
    if (moved.role === 'king') continue
    if (isHanging(after, tSq)) {
      const tName = pieceName(tp)
      return {
        key: 'capturingDefender',
        detail: `removing the defender of the ${tName}`,
        targetName: tName,
        square: squareName(tSq)
      }
    }
  }
  return null
}

/**
 * x-ray: a ray piece of `color` attacks or defends THROUGH an intervening piece
 * along the same line (a battery / x-ray relation in the resulting position).
 */
export function detectXRay(pos: Chess, color: Color): MotifHit | null {
  for (const fromSq of pos.board[color]) {
    const piece = pos.board.get(fromSq)
    if (!piece || !isRayRole(piece.role)) continue
    // scan each of the 8 ray directions for an [intervening piece, then target].
    for (const [df, dr] of DIRECTIONS) {
      if (!rayDirMatchesRole(piece.role, df, dr)) continue
      let f = squareFile(fromSq) + df
      let r = squareRank(fromSq) + dr
      let first: Square | null = null
      while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
        const sq = r * 8 + f
        const occ = pos.board.get(sq)
        if (occ) {
          if (first === null) {
            first = sq
          } else {
            // second piece on the line: an x-ray relation through `first`.
            const firstPiece = pos.board.get(first)!
            const secondPiece = occ
            // report when the rear target is an enemy of higher-or-equal value.
            if (secondPiece.color === opposite(color) && VAL[secondPiece.role] >= VAL[piece.role]) {
              return {
                key: 'xRay',
                detail: `x-ray on the ${pieceName(secondPiece)} through the ${pieceName(firstPiece)}`,
                targetName: pieceName(secondPiece),
                square: squareName(sq)
              }
            }
            break
          }
        }
        f += df
        r += dr
      }
    }
  }
  return null
}

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1]
]

function rayDirMatchesRole(role: Piece['role'], df: number, dr: number): boolean {
  const diagonal = df !== 0 && dr !== 0
  if (role === 'rook') return !diagonal
  if (role === 'bishop') return diagonal
  if (role === 'queen') return true
  return false
}
