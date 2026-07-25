// Hex: hand-rolled 11x11 GameSpec with union-find connection detection
// (docs/GAMES-PLATFORM-SPEC.md, small games).
//
// Codec: a move is the target cell 'a1'..'k11' (file a–k = column left→right,
// rank 1–11 = row; a1 bottom-left as drawn), or the literal 'swap'. Legal
// ONLY as the second player's first move when init({ swap: true }).
//
// White moves first and connects the LEFT edge (a-file) to the RIGHT edge
// (k-file); black connects rank 1 to rank 11. Cells are hexagons: neighbors of
// (row, col) are (row, col±1), (row±1, col), (row-1, col+1), (row+1, col-1).
// Hex cannot end in a draw (Hex theorem); result stays null until an edge-to-
// edge chain exists.
//
// Swap (pie) rule: 'swap' steals the opening move by TRANSPOSING it. The
// first stone at (row, col) is removed and the second player gets a stone at
// (col, row) (the mirror across the short diagonal, so its strength is
// preserved relative to black's edges); the first player is to move again.
//
// Union-find: 121 cells + 4 virtual edge nodes; parent array is copied on
// play (immutable states), unions happen only for the placed stone.

import type { GameResult, GameSpec, MoveMeta } from '../kernel'

export const HEX_N = 11
const CELLS = HEX_N * HEX_N
const LEFT = CELLS
const RIGHT = CELLS + 1
const TOP = CELLS + 2
const BOTTOM = CELLS + 3
const NODES = CELLS + 4

export interface HexState {
  /** 121 cells, index = row * 11 + col. 0 empty, 1 white, 2 black. */
  readonly cells: readonly number[]
  /** 1 = white to move, 2 = black. */
  readonly turn: 1 | 2
  readonly moves: readonly string[]
  /** Union-find parents over cells + 4 virtual edge nodes. */
  readonly parent: readonly number[]
  readonly allowSwap: boolean
  readonly swapped: boolean
}

export interface HexInitOptions {
  /** Enable the pie rule: second player may answer the first move with 'swap'. */
  swap?: boolean
}

const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
  [-1, 1],
  [1, -1]
]

export function hexIndex(move: string): number | null {
  const m = /^([a-k])(1[01]|[1-9])$/.exec(move)
  if (!m) return null
  const col = m[1].charCodeAt(0) - 97
  const row = Number(m[2]) - 1
  return row * HEX_N + col
}

export function hexName(index: number): string {
  return String.fromCharCode(97 + (index % HEX_N)) + String(Math.floor(index / HEX_N) + 1)
}

function find(parent: number[], x: number): number {
  let root = x
  while (parent[root] !== root) root = parent[root]
  while (parent[x] !== root) {
    const next = parent[x]
    parent[x] = root
    x = next
  }
  return root
}

function union(parent: number[], a: number, b: number): void {
  parent[find(parent, a)] = find(parent, b)
}

/** Union a just-placed stone of `player` at `idx` with same-color neighbors + its edges. */
function connectStone(parent: number[], cells: readonly number[], idx: number, player: number): void {
  const row = Math.floor(idx / HEX_N)
  const col = idx % HEX_N
  for (const [dr, dc] of NEIGHBOR_OFFSETS) {
    const r = row + dr
    const c = col + dc
    if (r < 0 || r >= HEX_N || c < 0 || c >= HEX_N) continue
    const n = r * HEX_N + c
    if (cells[n] === player) union(parent, idx, n)
  }
  if (player === 1) {
    if (col === 0) union(parent, idx, LEFT)
    if (col === HEX_N - 1) union(parent, idx, RIGHT)
  } else {
    if (row === 0) union(parent, idx, TOP)
    if (row === HEX_N - 1) union(parent, idx, BOTTOM)
  }
}

function freshParent(): number[] {
  return Array.from({ length: NODES }, (_, i) => i)
}

function resultOf(s: HexState): GameResult | null {
  const parent = s.parent.slice()
  if (find(parent, LEFT) === find(parent, RIGHT)) {
    return { winner: 'white', score: '1-0', reason: 'connection' }
  }
  if (find(parent, TOP) === find(parent, BOTTOM)) {
    return { winner: 'black', score: '0-1', reason: 'connection' }
  }
  return null
}

function swapEligible(s: HexState): boolean {
  return s.allowSwap && !s.swapped && s.moves.length === 1 && s.moves[0] !== 'swap'
}

export const HEX_SPEC: GameSpec<HexState> = {
  kind: 'hex',
  family: 'grid',
  title: 'Hex',
  tagline: 'Connect your two edges. Someone always does. Draws are impossible.',
  players: ['white', 'black'],
  board: { layout: 'cells', files: HEX_N, ranks: HEX_N },
  flipPolicy: 'none',
  clock: { supported: true },
  init(options?: unknown): HexState {
    const opts = (options ?? {}) as HexInitOptions
    return {
      cells: new Array<number>(CELLS).fill(0),
      turn: 1,
      moves: [],
      parent: freshParent(),
      allowSwap: opts.swap === true,
      swapped: false
    }
  },
  legalMoves(s: HexState): string[] {
    if (resultOf(s) !== null) return []
    const out: string[] = []
    for (let i = 0; i < CELLS; i++) if (s.cells[i] === 0) out.push(hexName(i))
    if (swapEligible(s)) out.push('swap')
    return out
  },
  play(s: HexState, move: string): HexState | null {
    if (resultOf(s) !== null) return null
    if (move === 'swap') {
      if (!swapEligible(s)) return null
      const firstIdx = hexIndex(s.moves[0])
      if (firstIdx === null) return null
      const row = Math.floor(firstIdx / HEX_N)
      const col = firstIdx % HEX_N
      const mirrored = col * HEX_N + row // transpose
      const cells = new Array<number>(CELLS).fill(0)
      cells[mirrored] = 2
      const parent = freshParent()
      connectStone(parent, cells, mirrored, 2)
      return { cells, turn: 1, moves: [...s.moves, 'swap'], parent, allowSwap: s.allowSwap, swapped: true }
    }
    const idx = hexIndex(move)
    if (idx === null || s.cells[idx] !== 0) return null
    const cells = s.cells.slice()
    cells[idx] = s.turn
    const parent = s.parent.slice()
    connectStone(parent, cells, idx, s.turn)
    return {
      cells,
      turn: s.turn === 1 ? 2 : 1,
      moves: [...s.moves, move],
      parent,
      allowSwap: s.allowSwap,
      swapped: s.swapped
    }
  },
  result: resultOf,
  moveMeta(): MoveMeta {
    return { capture: false, sound: 'move' }
  },
  serializeOptions: (o: unknown): string => JSON.stringify(o ?? null)
}
