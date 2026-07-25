// Othello (Reversi): hand-rolled 8x8 BigInt-bitboard GameSpec
// (docs/GAMES-PLATFORM-SPEC.md, small games). No code from external repos.
//
// Codec: a move is the placement square 'a1'..'h8' (bit = rank * 8 + file,
// a1 = bit 0, bottom-left), or the literal string 'pass': legal ONLY when the
// side to move has no placement (and the opponent still has one). When neither
// side can place, the game ends and is scored by disc count.
//
// Black moves first. Start position (a1 bottom-left): black on d5+e4,
// white on d4+e5.

import type { GameResult, GameSpec, MoveMeta } from '../kernel'

export interface OthelloState {
  readonly black: bigint
  readonly white: bigint
  /** 0 = black to move, 1 = white. */
  readonly turn: 0 | 1
  readonly moves: readonly string[]
}

export interface OthelloInitOptions {
  /**
   * Custom start board: 64 chars from [.bw], index = rank * 8 + file
   * (a1, b1, ..., h8). For tests/dev tooling.
   */
  board?: string
  turn?: 'black' | 'white'
}

const FULL = 0xffffffffffffffffn
const NOT_A = 0xfefefefefefefefen // squares not on the a-file (safe to shift toward a)
const NOT_H = 0x7f7f7f7f7f7f7f7fn

type Shift = (b: bigint) => bigint
const SHIFTS: readonly Shift[] = [
  (b) => (b << 8n) & FULL, // N
  (b) => b >> 8n, // S
  (b) => ((b & NOT_H) << 1n) & FULL, // E
  (b) => (b & NOT_A) >> 1n, // W
  (b) => ((b & NOT_H) << 9n) & FULL, // NE
  (b) => ((b & NOT_A) << 7n) & FULL, // NW
  (b) => (b & NOT_H) >> 7n, // SE
  (b) => (b & NOT_A) >> 9n // SW
]

/** Bitboard of all legal placement squares for `own` against `opp`. */
export function othelloMoveMask(own: bigint, opp: bigint): bigint {
  const empty = ~(own | opp) & FULL
  let moves = 0n
  for (const sh of SHIFTS) {
    let t = sh(own) & opp
    t |= sh(t) & opp
    t |= sh(t) & opp
    t |= sh(t) & opp
    t |= sh(t) & opp
    t |= sh(t) & opp
    moves |= sh(t) & empty
  }
  return moves
}

/** Discs flipped by `own` placing on the single-bit square `sq` (0n = illegal). */
export function othelloFlips(own: bigint, opp: bigint, sq: bigint): bigint {
  let flips = 0n
  for (const sh of SHIFTS) {
    let x = sh(sq)
    let run = 0n
    while ((x & opp) !== 0n) {
      run |= x
      x = sh(x)
    }
    if ((x & own) !== 0n) flips |= run
  }
  return flips
}

export function popcount(b: bigint): number {
  let n = 0
  while (b !== 0n) {
    b &= b - 1n
    n++
  }
  return n
}

export function othelloSquare(move: string): bigint | null {
  if (!/^[a-h][1-8]$/.test(move)) return null
  return 1n << BigInt((move.charCodeAt(1) - 49) * 8 + (move.charCodeAt(0) - 97))
}

export function othelloName(bitIndex: number): string {
  return String.fromCharCode(97 + (bitIndex % 8)) + String(Math.floor(bitIndex / 8) + 1)
}

function ownOpp(s: OthelloState): [bigint, bigint] {
  return s.turn === 0 ? [s.black, s.white] : [s.white, s.black]
}

function resultOf(s: OthelloState): GameResult | null {
  const [own, opp] = ownOpp(s)
  if (othelloMoveMask(own, opp) !== 0n || othelloMoveMask(opp, own) !== 0n) return null
  const b = popcount(s.black)
  const w = popcount(s.white)
  if (b === w) return { winner: null, score: '1/2-1/2', reason: 'draw' }
  const winner = b > w ? 'black' : 'white'
  return { winner, score: winner === 'white' ? '1-0' : '0-1', reason: 'disc-count' }
}

function fromBoard(board: string): { black: bigint; white: bigint } {
  if (!/^[.bw]{64}$/.test(board)) {
    throw new Error('othello board must be 64 chars from [.bw] (index = rank*8+file, a1 first)')
  }
  let black = 0n
  let white = 0n
  for (let i = 0; i < 64; i++) {
    if (board[i] === 'b') black |= 1n << BigInt(i)
    else if (board[i] === 'w') white |= 1n << BigInt(i)
  }
  return { black, white }
}

export const OTHELLO_SPEC: GameSpec<OthelloState> = {
  kind: 'othello',
  family: 'grid',
  title: 'Othello',
  tagline: 'Flip the board in a single move. It ain’t over till it’s over.',
  players: ['black', 'white'],
  board: { layout: 'cells', files: 8, ranks: 8 },
  flipPolicy: 'none',
  clock: { supported: true },
  init(options?: unknown): OthelloState {
    const opts = (options ?? {}) as OthelloInitOptions
    if (opts.board !== undefined) {
      const { black, white } = fromBoard(opts.board)
      return { black, white, turn: opts.turn === 'white' ? 1 : 0, moves: [] }
    }
    // black d5 (35) + e4 (28), white d4 (27) + e5 (36)
    return {
      black: (1n << 35n) | (1n << 28n),
      white: (1n << 27n) | (1n << 36n),
      turn: 0,
      moves: []
    }
  },
  legalMoves(s: OthelloState): string[] {
    const [own, opp] = ownOpp(s)
    const mask = othelloMoveMask(own, opp)
    if (mask === 0n) {
      return othelloMoveMask(opp, own) !== 0n ? ['pass'] : []
    }
    const out: string[] = []
    for (let i = 0; i < 64; i++) if ((mask & (1n << BigInt(i))) !== 0n) out.push(othelloName(i))
    return out
  },
  play(s: OthelloState, move: string): OthelloState | null {
    const [own, opp] = ownOpp(s)
    const mask = othelloMoveMask(own, opp)
    const nextTurn: 0 | 1 = s.turn === 0 ? 1 : 0
    if (move === 'pass') {
      if (mask !== 0n) return null // placements exist → pass illegal
      if (othelloMoveMask(opp, own) === 0n) return null // game over → no moves at all
      return { black: s.black, white: s.white, turn: nextTurn, moves: [...s.moves, 'pass'] }
    }
    const sq = othelloSquare(move)
    if (sq === null || (mask & sq) === 0n) return null
    const flips = othelloFlips(own, opp, sq)
    const newOwn = own | sq | flips
    const newOpp = opp & ~flips
    return {
      black: s.turn === 0 ? newOwn : newOpp,
      white: s.turn === 0 ? newOpp : newOwn,
      turn: nextTurn,
      moves: [...s.moves, move]
    }
  },
  result: resultOf,
  moveMeta(_s: OthelloState, move: string): MoveMeta {
    if (move === 'pass') return { capture: false, sound: 'move' }
    // any legal placement flips at least one disc
    return { capture: true, sound: 'capture' }
  },
  serializeOptions: (o: unknown): string => JSON.stringify(o ?? null)
}
