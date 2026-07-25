// Connect Four: hand-rolled 7x6 bitboard GameSpec (docs/GAMES-PLATFORM-SPEC.md).
//
// Codec 'col4': a move is a single column digit '1'..'7' ('1' = leftmost
// column). Gravity is implicit. The disc lands on the lowest empty row.
//
// Bitboard layout (the classic 7-rows-per-column trick): bit = col * 7 + row,
// row 0 = bottom. Each column has a 7th (always empty) sentinel bit so the
// shift-based 4-in-a-row test never wraps across columns:
//   vertical +1, horizontal +7, diagonal / +8, diagonal \ +6.

import type { GameResult, GameSpec, MoveMeta } from '../kernel'

export interface Connect4State {
  /** One bitboard per player: [white (moves first), black]. */
  readonly bb: readonly [bigint, bigint]
  /** Discs per column, 0..6. */
  readonly heights: readonly number[]
  /** 0 = white to move, 1 = black. */
  readonly turn: 0 | 1
  readonly moves: readonly string[]
}

export interface Connect4InitOptions {
  /**
   * Start position as 6 strings of 7 chars, TOP row first. '.' empty,
   * 'w' white, 'b' black. Must be gravity-packed (no floating discs).
   * Side to move = white when disc counts are equal, else black.
   */
  grid?: string[]
}

const WIN_DIRS = [1n, 7n, 6n, 8n] as const

/** True if `b` contains four in a row (any direction). */
export function c4Wins(b: bigint): boolean {
  for (const d of WIN_DIRS) {
    const m = b & (b >> d)
    if ((m & (m >> (2n * d))) !== 0n) return true
  }
  return false
}

export function c4Bit(col: number, row: number): bigint {
  return 1n << BigInt(col * 7 + row)
}

function fromGrid(grid: string[]): Pick<Connect4State, 'bb' | 'heights' | 'turn'> {
  if (grid.length !== 6 || grid.some((r) => !/^[.wb]{7}$/.test(r))) {
    throw new Error('connect4 grid must be 6 rows of 7 chars from [.wb] (top row first)')
  }
  let white = 0n
  let black = 0n
  const heights = new Array<number>(7).fill(0)
  let discs = 0
  for (let col = 0; col < 7; col++) {
    for (let row = 0; row < 6; row++) {
      const ch = grid[5 - row][col] // grid[0] is the top row
      if (ch === '.') continue
      if (row !== heights[col]) throw new Error(`connect4 grid: floating disc in column ${col + 1}`)
      if (ch === 'w') white |= c4Bit(col, row)
      else black |= c4Bit(col, row)
      heights[col] = row + 1
      discs++
    }
  }
  return { bb: [white, black], heights, turn: discs % 2 === 0 ? 0 : 1 }
}

function resultOf(s: Connect4State): GameResult | null {
  if (c4Wins(s.bb[0])) return { winner: 'white', score: '1-0', reason: 'connect4' }
  if (c4Wins(s.bb[1])) return { winner: 'black', score: '0-1', reason: 'connect4' }
  if (s.heights.every((h) => h >= 6)) return { winner: null, score: '1/2-1/2', reason: 'draw' }
  return null
}

export const CONNECT4_SPEC: GameSpec<Connect4State> = {
  kind: 'connect4',
  family: 'grid',
  title: 'Connect Four',
  tagline: 'Drop discs, stack threats, land four in a row.',
  players: ['white', 'black'],
  board: { layout: 'cells', files: 7, ranks: 6 },
  flipPolicy: 'none',
  clock: { supported: true },
  init(options?: unknown): Connect4State {
    const opts = (options ?? {}) as Connect4InitOptions
    if (opts.grid) return { ...fromGrid(opts.grid), moves: [] }
    return { bb: [0n, 0n], heights: new Array<number>(7).fill(0), turn: 0, moves: [] }
  },
  legalMoves(s: Connect4State): string[] {
    if (resultOf(s) !== null) return []
    const out: string[] = []
    for (let col = 0; col < 7; col++) if (s.heights[col] < 6) out.push(String(col + 1))
    return out
  },
  play(s: Connect4State, move: string): Connect4State | null {
    if (!/^[1-7]$/.test(move)) return null
    if (resultOf(s) !== null) return null
    const col = Number(move) - 1
    if (s.heights[col] >= 6) return null
    const bb: [bigint, bigint] = [s.bb[0], s.bb[1]]
    bb[s.turn] |= c4Bit(col, s.heights[col])
    const heights = s.heights.slice()
    heights[col]++
    return { bb, heights, turn: s.turn === 0 ? 1 : 0, moves: [...s.moves, move] }
  },
  result: resultOf,
  moveMeta(): MoveMeta {
    return { capture: false, sound: 'move' }
  },
  /** Notation = the LANDING SQUARE 'd4' (column letter a–g + landing rank 1–6,
   *  rank 1 at the bottom). The codec's bare column digit tells a reader
   *  nothing about height. Documented kernel-wide in GameSpec.notate. */
  notate(s: Connect4State, move: string): string {
    if (!/^[1-7]$/.test(move)) return move
    const col = Number(move) - 1
    if (s.heights[col] >= 6) return move
    return `${String.fromCharCode(97 + col)}${s.heights[col] + 1}`
  },
  serializeOptions: (o: unknown): string => JSON.stringify(o ?? null)
}
