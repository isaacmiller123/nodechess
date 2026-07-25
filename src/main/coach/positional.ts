/**
 * Static positional heuristics (docs/content-coaching.md, positional() surface,
 * §3.5 "only emit a positional comment when notable"). Space / development /
 * pawn-structure / open-file / outpost terms over a single FEN, with a short
 * natural-language summary. No engine call, no LLM.
 *
 * All strings authored fresh for this project.
 */

import { Chess } from 'chessops/chess'
import { opposite, squareFile, squareRank } from 'chessops/util'
import type { Color, Square } from 'chessops/types'
import { positionFromFen, ringOf, squareName } from './board'

export interface PositionalResult {
  terms: string[]
  text: string
}

const FILE_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

function pawnsOnFile(pos: Chess, color: Color, file: number): number {
  let n = 0
  for (const sq of pos.board.pawn.intersect(pos.board[color])) {
    if (squareFile(sq) === file) n++
  }
  return n
}

/** Count developed minor pieces (off the back rank). */
function developedMinors(pos: Chess, color: Color): number {
  const backRank = color === 'white' ? 0 : 7
  let n = 0
  const minors = pos.board.knight.union(pos.board.bishop).intersect(pos.board[color])
  for (const sq of minors) {
    if (squareRank(sq) !== backRank) n++
  }
  return n
}

/** Has the king moved off its start square toward a castled position? */
function castledLike(pos: Chess, color: Color): boolean {
  const king = pos.board.kingOf(color)
  if (king === undefined) return false
  const f = squareFile(king)
  const r = squareRank(king)
  const homeRank = color === 'white' ? 0 : 7
  return r === homeRank && (f >= 6 || f <= 2)
}

/** Space: pawns advanced past the middle into the opponent's half. */
function spaceCount(pos: Chess, color: Color): number {
  let n = 0
  for (const sq of pos.board.pawn.intersect(pos.board[color])) {
    const r = squareRank(sq)
    if (color === 'white' && r >= 3) n++
    if (color === 'black' && r <= 4) n++
  }
  return n
}

/** Open files (no pawns of either colour) and half-open files (only enemy pawns). */
function fileStructure(pos: Chess): { open: number[]; halfOpenFor: Record<Color, number[]> } {
  const open: number[] = []
  const halfOpenFor: Record<Color, number[]> = { white: [], black: [] }
  for (let f = 0; f < 8; f++) {
    const w = pawnsOnFile(pos, 'white', f)
    const b = pawnsOnFile(pos, 'black', f)
    if (w === 0 && b === 0) open.push(f)
    else if (w === 0 && b > 0) halfOpenFor.white.push(f)
    else if (b === 0 && w > 0) halfOpenFor.black.push(f)
  }
  return { open, halfOpenFor }
}

/** Doubled pawns per colour (files with >=2 own pawns). */
function doubledFiles(pos: Chess, color: Color): number[] {
  const files: number[] = []
  for (let f = 0; f < 8; f++) {
    if (pawnsOnFile(pos, color, f) >= 2) files.push(f)
  }
  return files
}

/** Isolated pawns: own pawn whose adjacent files have no own pawn. */
function isolatedFiles(pos: Chess, color: Color): number[] {
  const files: number[] = []
  for (let f = 0; f < 8; f++) {
    if (pawnsOnFile(pos, color, f) === 0) continue
    const left = f > 0 ? pawnsOnFile(pos, color, f - 1) : 0
    const right = f < 7 ? pawnsOnFile(pos, color, f + 1) : 0
    if (left === 0 && right === 0) files.push(f)
  }
  return files
}

/** Passed pawns: no enemy pawn ahead on its file or adjacent files. */
function passedPawns(pos: Chess, color: Color): Square[] {
  const out: Square[] = []
  const enemy = opposite(color)
  for (const sq of pos.board.pawn.intersect(pos.board[color])) {
    const f = squareFile(sq)
    const r = squareRank(sq)
    let blocked = false
    for (const eSq of pos.board.pawn.intersect(pos.board[enemy])) {
      const ef = squareFile(eSq)
      const er = squareRank(eSq)
      if (Math.abs(ef - f) > 1) continue
      if (color === 'white' && er > r) blocked = true
      if (color === 'black' && er < r) blocked = true
    }
    if (!blocked) out.push(sq)
  }
  return out
}

/**
 * Outposts: a knight on a square in/near enemy territory, defended by an own
 * pawn, and not attackable by an enemy pawn.
 */
function outposts(pos: Chess, color: Color): Square[] {
  const out: Square[] = []
  const enemy = opposite(color)
  const knights = pos.board.knight.intersect(pos.board[color])
  for (const sq of knights) {
    const r = squareRank(sq)
    const advanced = color === 'white' ? r >= 3 && r <= 5 : r <= 4 && r >= 2
    if (!advanced) continue
    // defended by an own pawn?
    let pawnDefended = false
    const backDir = color === 'white' ? -1 : 1
    for (const df of [-1, 1]) {
      const nf = squareFile(sq) + df
      const nr = r + backDir
      if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue
      const p = pos.board.get(nr * 8 + nf)
      if (p && p.role === 'pawn' && p.color === color) pawnDefended = true
    }
    if (!pawnDefended) continue
    // can an enemy pawn ever attack it? (enemy pawn on adjacent file able to advance)
    let attackable = false
    const fwd = color === 'white' ? 1 : -1
    for (const eSq of pos.board.pawn.intersect(pos.board[enemy])) {
      const ef = squareFile(eSq)
      const er = squareRank(eSq)
      if (Math.abs(ef - squareFile(sq)) !== 1) continue
      // enemy pawn is "behind" the outpost (can still march up to attack it)
      if (color === 'white' && er > r) attackable = true
      if (color === 'black' && er < r) attackable = true
      void fwd
    }
    if (!attackable) out.push(sq)
  }
  return out
}

/** Rooks/queens sitting on an open or half-open file for their side. */
function rooksOnOpenFiles(pos: Chess, color: Color, open: number[], halfOpen: number[]): Square[] {
  const out: Square[] = []
  const heavy = pos.board.rook.union(pos.board.queen).intersect(pos.board[color])
  const files = new Set([...open, ...halfOpen])
  for (const sq of heavy) {
    if (files.has(squareFile(sq))) out.push(sq)
  }
  return out
}

/**
 * Compute positional terms and a short summary for the side to move's POV.
 * Returns a neutral "balanced" note when nothing notable stands out.
 */
export function positionalReport(fen: string): PositionalResult {
  const pos = positionFromFen(fen)
  if (!pos) {
    return { terms: [], text: 'Position could not be parsed.' }
  }
  const mover = pos.turn
  const enemy = opposite(mover)
  const terms: string[] = []
  const phrases: string[] = []

  // Development (most relevant out of the opening).
  const devMe = developedMinors(pos, mover)
  const devThem = developedMinors(pos, enemy)
  if (devMe - devThem >= 2) {
    terms.push('development')
    phrases.push('you are ahead in development')
  } else if (devThem - devMe >= 2) {
    terms.push('development')
    phrases.push('you are behind in development')
  }

  // King safety / castling.
  if (castledLike(pos, mover) && !castledLike(pos, enemy)) {
    terms.push('kingSafety')
    phrases.push('your king is the safer of the two')
  } else if (!castledLike(pos, mover) && castledLike(pos, enemy)) {
    terms.push('kingSafety')
    phrases.push('your king is still in the centre: consider castling')
  }

  // Space.
  const spaceMe = spaceCount(pos, mover)
  const spaceThem = spaceCount(pos, enemy)
  if (spaceMe - spaceThem >= 2) {
    terms.push('space')
    phrases.push('you hold more space')
  } else if (spaceThem - spaceMe >= 2) {
    terms.push('space')
    phrases.push('the opponent has more space')
  }

  // Files. Only actionable when the mover has a rook/queen to use them.
  const { open, halfOpenFor } = fileStructure(pos)
  const moverHasHeavy = pos.board.rook.union(pos.board.queen).intersect(pos.board[mover]).nonEmpty()
  if (open.length && moverHasHeavy) {
    const myRooks = rooksOnOpenFiles(pos, mover, open, [])
    if (myRooks.length) {
      terms.push('openFile')
      phrases.push(`a rook controls the open ${FILE_LETTERS[squareFile(myRooks[0])]}-file`)
    } else {
      terms.push('openFile')
      phrases.push(`the ${FILE_LETTERS[open[0]]}-file is open to fight for`)
    }
  }
  const myHalfOpen = rooksOnOpenFiles(pos, mover, [], halfOpenFor[mover])
  if (myHalfOpen.length) {
    terms.push('halfOpenFile')
    phrases.push(`pressure down the half-open ${FILE_LETTERS[squareFile(myHalfOpen[0])]}-file`)
  }

  // Outposts.
  const myOutposts = outposts(pos, mover)
  if (myOutposts.length) {
    terms.push('outpost')
    phrases.push(`a knight outpost on ${squareName(myOutposts[0])}`)
  }
  const theirOutposts = outposts(pos, enemy)
  if (theirOutposts.length) {
    terms.push('outpost')
    phrases.push(`watch the enemy knight outpost on ${squareName(theirOutposts[0])}`)
  }

  // Pawn structure.
  const myPassed = passedPawns(pos, mover)
  if (myPassed.length) {
    terms.push('passedPawn')
    phrases.push(`a passed pawn on ${squareName(myPassed[0])}`)
  }
  const myDoubled = doubledFiles(pos, mover)
  if (myDoubled.length) {
    terms.push('doubledPawns')
    phrases.push(`doubled pawns on the ${FILE_LETTERS[myDoubled[0]]}-file`)
  }
  const myIsolated = isolatedFiles(pos, mover)
  if (myIsolated.length) {
    terms.push('isolatedPawn')
    phrases.push(`an isolated pawn on the ${FILE_LETTERS[myIsolated[0]]}-file`)
  }

  // King attack pressure (cheap static count near the enemy king).
  const enemyKing = pos.board.kingOf(enemy)
  if (enemyKing !== undefined) {
    let near = 0
    for (const sq of ringOf(enemyKing).with(enemyKing)) {
      near += pos.kingAttackers(sq, mover, pos.board.occupied).size()
    }
    if (near >= 3) {
      terms.push('attack')
      phrases.push('you have attacking chances around the enemy king')
    }
  }

  const uniqueTerms = Array.from(new Set(terms))
  if (phrases.length === 0) {
    return {
      text: 'The position is roughly balanced. No single static feature stands out.',
      terms: uniqueTerms
    }
  }
  const text = capitalize(joinPhrases(phrases)) + '.'
  return { terms: uniqueTerms, text }
}

function joinPhrases(phrases: string[]): string {
  const top = phrases.slice(0, 3)
  if (top.length === 1) return top[0]
  if (top.length === 2) return `${top[0]} and ${top[1]}`
  return `${top[0]}, ${top[1]}, and ${top[2]}`
}

function capitalize(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s
}
