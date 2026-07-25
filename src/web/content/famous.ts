// Famous games, read from the static library instead of famous:list/famous:get.
//
// Mirrors src/main/famous/famous.repo.ts: same merge (curated shard wins an id
// collision: done at emit time), same SAN tokenizer, same year-then-id order,
// same per-ply expansion into before/after FENs. The movetext ships as SAN
// because expanding it is chessops work the browser already carries, and the
// expanded form is an order of magnitude bigger than the source.

import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { makeSan, parseSan } from 'chessops/san'
import { makeUci } from 'chessops/util'
import type {
  FamousGameDetail,
  FamousGameMeta,
  FamousGroup,
  FamousMove,
  FamousResult
} from '@shared/types'
import { loadContent } from './fetchContent'

/** One row as it sits in resources/famous/*.json (emitted verbatim). */
interface RawGame {
  id: string
  white: string
  black: string
  event: string
  year: number
  result: string
  eco?: string
  group: string
  pgnMoves: string | string[]
  significance?: string
}

const VALID_GROUPS: ReadonlySet<string> = new Set<FamousGroup>(['romantic', 'classical', 'modern'])
const VALID_RESULTS: ReadonlySet<string> = new Set<FamousResult>(['1-0', '0-1', '1/2-1/2', '*'])

function load(): Promise<RawGame[]> {
  return loadContent<{ games?: RawGame[] }>('famous.json').then((f) =>
    Array.isArray(f.games) ? f.games : []
  )
}

/** Split a SAN movetext string into bare SAN tokens (numbers/results stripped). */
function tokenizeMoves(pgnMoves: string | string[]): string[] {
  if (Array.isArray(pgnMoves)) return pgnMoves.filter(Boolean)
  return pgnMoves
    .replace(/\d+\.(\.\.)?/g, ' ')
    .replace(/\b(?:1-0|0-1|1\/2-1\/2|\*)\b/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function toMeta(g: RawGame): FamousGameMeta {
  return {
    id: g.id,
    white: g.white,
    black: g.black,
    event: g.event,
    year: g.year,
    result: (VALID_RESULTS.has(g.result) ? g.result : '*') as FamousResult,
    eco: g.eco,
    group: (VALID_GROUPS.has(g.group) ? g.group : 'classical') as FamousGroup,
    plies: tokenizeMoves(g.pgnMoves).length,
    significance: typeof g.significance === 'string' ? g.significance : undefined
  }
}

export async function listFamous(opts?: { group?: string }): Promise<FamousGameMeta[]> {
  const wanted = opts?.group
  return (await load())
    .filter((g) => !wanted || g.group === wanted)
    .map(toMeta)
    .sort((a, b) => a.year - b.year || a.id.localeCompare(b.id))
}

export async function getFamous(id: string): Promise<FamousGameDetail | null> {
  const raw = (await load()).find((g) => g.id === id)
  if (!raw) return null

  const sans = tokenizeMoves(raw.pgnMoves)
  const pos = Chess.default()
  const moves: FamousMove[] = []

  for (let i = 0; i < sans.length; i++) {
    const move = parseSan(pos, sans[i])
    if (!move) return null // illegal/ambiguous SAN: bail rather than emit garbage

    const fenBefore = makeFen(pos.toSetup())
    const color: 'white' | 'black' = pos.turn
    const san = makeSan(pos, move) // canonical (+/#, disambiguation)
    const uci = makeUci(move)
    pos.play(move)

    moves.push({ ply: i + 1, color, san, uci, fenBefore, fenAfter: makeFen(pos.toSetup()) })
  }

  return { game: toMeta(raw), moves }
}
