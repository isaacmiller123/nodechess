// Pure orientation / coordinate mapping helpers for the 2D game boards.
//
// Kept free of React and DOM so the OTB flip math is headless-testable
// (scripts/test-flip.mjs). Two invariants matter for flipPolicy 'rotate':
//   1. flipping is a 180° rotation (an involution: flipping twice is identity);
//   2. the SAME mapping is used for square rendering, piece placement and
//      click handling, so interaction stays consistent after a flip.

import { MORRIS_POINTS } from '../small/morris'

// ---- checkers (8x8 American / 10x10 international, dark squares only) ------

/** 1-based codec square → board row/col (row 0 = top as numbered). */
export function squareToRC(square: number, n: number): { row: number; col: number } {
  const half = n / 2
  const p = square - 1
  const row = Math.floor(p / half)
  const col = 2 * (p % half) + (row % 2 === 0 ? 1 : 0)
  return { row, col }
}

/** Board row/col → 1-based codec square, or null on a light square. */
export function rcToSquare(row: number, col: number, n: number): number | null {
  if ((row + col) % 2 !== 1) return null
  return row * (n / 2) + (col - (row % 2 === 0 ? 1 : 0)) / 2 + 1
}

/**
 * Board row/col → view row/col under an orientation flip (and back: the
 * mapping is its own inverse). `flipped` = the board is rotated 180°.
 */
export function viewRC(row: number, col: number, n: number, flipped: boolean): { row: number; col: number } {
  return flipped ? { row: n - 1 - row, col: n - 1 - col } : { row, col }
}

// ---- nine men's morris (24 points on a 7x7 lattice, SVG coordinates) --------

export const MOR_S = 340
export const MOR_PAD = 34
export const MOR_STEP = (MOR_S - MOR_PAD * 2) / 6

export interface MorPt {
  x: number
  y: number
}

/** Morris point index → SVG x/y; `rotated` = 180° board rotation. */
export function morXY(index: number, rotated: boolean): MorPt {
  const name = MORRIS_POINTS[index]
  const file = name.charCodeAt(0) - 97
  const rank = Number(name[1]) - 1
  const x = MOR_PAD + file * MOR_STEP
  const y = MOR_PAD + (6 - rank) * MOR_STEP
  return rotated ? { x: MOR_S - x, y: MOR_S - y } : { x, y }
}
