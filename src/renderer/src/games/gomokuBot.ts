// Gomoku bot: threat evaluation over games/gomoku.ts (docs/GAMES-PLATFORM-
// SPEC.md §Bots, 'worker:gomoku'; hand-rolled like the other small games).
//
// The classic dual-threat heuristic: a cell is worth what it BUILDS for the
// mover plus most of what it DENIES the opponent, scored per direction from
// run length + open ends (five ≫ open four ≫ four ≫ open three ≫ ...). Level
// shaping follows games/small/bots.ts: low levels add root noise, top levels
// add a depth-2 best-reply lookahead over the strongest candidates. First
// move is always the center point (GOMOKU_CENTER on the standard board).
//
// Headless like every rules module, exercised by scripts/test-bots.mjs.

import { pointToVertex } from './go'
import { turnOfGomoku, type GomokuState } from './gomoku'
import type { PlayerColor } from './kernel'
import { clampLevel, noisyArgmax } from './small/bots'

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1]
]

/** Threat value of one direction line: run length + number of open ends. */
function lineScore(run: number, open: number): number {
  if (run >= 5) return 10_000_000 // five (or overline): a win
  if (run === 4) return open === 2 ? 1_000_000 : open === 1 ? 50_000 : 0
  if (run === 3) return open === 2 ? 30_000 : open === 1 ? 1_500 : 0
  if (run === 2) return open === 2 ? 600 : open === 1 ? 80 : 0
  if (run === 1) return open === 2 ? 40 : open === 1 ? 8 : 0
  return 0
}

/** Sum of the 4 direction-line threat values if `color` stones held (y, x). */
function placeScore(
  cells: readonly (PlayerColor | null)[],
  size: number,
  y: number,
  x: number,
  color: PlayerColor
): number {
  let total = 0
  for (const [dy, dx] of DIRECTIONS) {
    let run = 1
    let open = 0
    for (const sign of [1, -1]) {
      let ny = y + dy * sign
      let nx = x + dx * sign
      while (ny >= 0 && ny < size && nx >= 0 && nx < size && cells[ny * size + nx] === color) {
        run++
        ny += dy * sign
        nx += dx * sign
      }
      if (ny >= 0 && ny < size && nx >= 0 && nx < size && cells[ny * size + nx] === null) open++
    }
    total += lineScore(run, open)
  }
  return total
}

/** Build-plus-deny value of playing (y, x) as `me`. */
function cellValue(
  cells: readonly (PlayerColor | null)[],
  size: number,
  y: number,
  x: number,
  me: PlayerColor
): number {
  const opp: PlayerColor = me === 'black' ? 'white' : 'black'
  return placeScore(cells, size, y, x, me) + 0.85 * placeScore(cells, size, y, x, opp)
}

/** Empty cells within Chebyshev distance 2 of any stone (the useful frontier). */
function candidateCells(s: GomokuState): number[] {
  const { size, cells } = s
  const near = new Uint8Array(size * size)
  let anyStone = false
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (cells[y * size + x] === null) continue
      anyStone = true
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ny = y + dy
          const nx = x + dx
          if (ny >= 0 && ny < size && nx >= 0 && nx < size) near[ny * size + nx] = 1
        }
      }
    }
  }
  const out: number[] = []
  if (!anyStone) return out
  for (let i = 0; i < near.length; i++) if (near[i] === 1 && cells[i] === null) out.push(i)
  return out
}

interface GomokuLevelCfg {
  /** 1 = threat eval only; 2 = + opponent best-reply lookahead over topK. */
  depth: 1 | 2
  noise: number
  topK: number
}

const GOMOKU_LEVELS: readonly GomokuLevelCfg[] = [
  { depth: 1, noise: 20_000, topK: 0 }, // misses even open threes at times
  { depth: 1, noise: 2_000, topK: 0 },
  { depth: 1, noise: 0, topK: 0 },
  { depth: 2, noise: 0, topK: 8 },
  { depth: 2, noise: 0, topK: 14 }
]

const GOMOKU_LEVEL_HINTS: readonly string[] = [
  'plays loosely, misses threats',
  'spots most open threes',
  'sharp threat evaluation',
  'reads the best reply',
  'reads replies, wider net'
]

export interface GomokuBot {
  readonly levels: 5
  describe(level: number): string
  /** A legal vertex ('h8') for `state`; state must not be terminal. */
  move(state: unknown, level: number): string
}

export const GOMOKU_BOT: GomokuBot = {
  levels: 5,
  describe(level: number): string {
    return GOMOKU_LEVEL_HINTS[clampLevel(level) - 1]
  },
  move(state: unknown, level: number): string {
    const s = state as GomokuState
    const cfg = GOMOKU_LEVELS[clampLevel(level) - 1]
    const me = turnOfGomoku(s)
    const opp: PlayerColor = me === 'black' ? 'white' : 'black'
    const candidates = candidateCells(s)
    if (candidates.length === 0) {
      // Empty board (or a full ring of stones; impossible): open in the center.
      const mid = Math.floor(s.size / 2)
      if (s.cells[mid * s.size + mid] === null) return pointToVertex(mid, mid, s.size)
      const anyEmpty = s.cells.findIndex((c) => c === null)
      if (anyEmpty < 0) throw new Error('gomoku bot: no legal moves')
      return pointToVertex(Math.floor(anyEmpty / s.size), anyEmpty % s.size, s.size)
    }

    const shallow = candidates.map((i) =>
      cellValue(s.cells, s.size, Math.floor(i / s.size), i % s.size, me)
    )
    let scores = shallow
    if (cfg.depth === 2) {
      const cells = s.cells.slice()
      const ranked = candidates
        .map((cell, k) => ({ cell, k, e: shallow[k] }))
        .sort((a, b) => b.e - a.e)
        .slice(0, cfg.topK)
      scores = shallow.map((e) => e - 5_000_000) // unranked: heavily discounted
      for (const { cell, k, e } of ranked) {
        if (e >= 10_000_000) {
          scores[k] = e // immediate five: nothing to read
          continue
        }
        cells[cell] = me
        // Opponent's strongest answer anywhere on the (updated) frontier.
        let best = 0
        for (const r of candidateCells({ ...s, cells })) {
          const v = cellValue(cells, s.size, Math.floor(r / s.size), r % s.size, opp)
          if (v > best) best = v
        }
        cells[cell] = null
        scores[k] = e - 0.9 * best
      }
    }
    const idx = Number(noisyArgmax(candidates.map(String), scores, cfg.noise))
    return pointToVertex(Math.floor(idx / s.size), idx % s.size, s.size)
  }
}
