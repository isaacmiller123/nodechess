// Pure UCI wire helpers for the web engine layer. A byte-faithful port of the
// parsing/serialization half of src/main/engine/UciEngine.ts, kept separate so
// the headless suite (scripts/test-web-engines.mjs) can golden-test it without
// any Worker/WASM machinery.

import type { GoLimit } from '@shared/types'

/** One `info ...` line, parsed. Field-identical to desktop UciEngine InfoLine. */
export interface InfoLine {
  depth?: number
  seldepth?: number
  multipv?: number
  scoreCp?: number
  mate?: number
  nodes?: number
  nps?: number
  timeMs?: number
  pv?: string[]
}

export interface BestMove {
  bestmove: string
  ponder?: string
}

export type { GoLimit }

/** `go <args>` serialization. Mirrors desktop goArgs exactly. */
export function goArgs(l: GoLimit): string {
  switch (l.kind) {
    case 'depth':
      return `depth ${l.value}`
    case 'movetime':
      return `movetime ${l.value}`
    case 'nodes':
      return `nodes ${l.value}`
    case 'infinite':
      return 'infinite'
  }
}

/** Parse an `info ...` line: mirrors desktop parseInfo exactly (returns null
 *  for lines carrying neither a depth nor a pv, e.g. `info string ...`). */
export function parseInfo(line: string): InfoLine | null {
  const t = line.split(/\s+/)
  const info: InfoLine = {}
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth':
        info.depth = Number(t[++i])
        break
      case 'seldepth':
        info.seldepth = Number(t[++i])
        break
      case 'multipv':
        info.multipv = Number(t[++i])
        break
      case 'nodes':
        info.nodes = Number(t[++i])
        break
      case 'nps':
        info.nps = Number(t[++i])
        break
      case 'time':
        info.timeMs = Number(t[++i])
        break
      case 'score':
        if (t[i + 1] === 'cp') {
          info.scoreCp = Number(t[i + 2])
          i += 2
        } else if (t[i + 1] === 'mate') {
          info.mate = Number(t[i + 2])
          i += 2
        }
        break
      case 'pv':
        info.pv = t.slice(i + 1)
        i = t.length
        break
      default:
        break
    }
  }
  return info.depth !== undefined || info.pv ? info : null
}

/** Parse a `bestmove <move> [ponder <move>]` line. Mirrors desktop onLine. */
export function parseBestmove(line: string): BestMove {
  const p = line.split(/\s+/)
  return { bestmove: p[1], ponder: p[3] }
}
