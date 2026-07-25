// Game archive envelope. The storage contract for NON-chess finished games
// (platform foundation: every game from every mode becomes reviewable).
//
// The game table's `pgn` column holds exactly one of two formats:
//   - kind 'chess'  → real PGN (headers + numbered SAN movetext), written by
//     the chess PlayView / onlineStore chess path: byte-for-byte the historic
//     output, parsed by the chess Analysis/review pipeline (game_kind filter);
//   - every other kind (chess variants, ffish family, custom-<id>, go,
//     checkers, small games) → ONE compact JSON envelope (GameArchive below):
//     the verbatim wire-codec move list. Replayable 1:1 through the kernel
//     spec.play, plus per-move human notation (GameSpec.notate) and display
//     metadata. An envelope never collides with PGN: PGN text begins with '['
//     or a movetext token, never '{'.
//
// Replay = getGame(kind).spec.init(meta.options) then play() over `moves`.
//
// This module is PURE and dependency-free: main, preload, renderer and bare
// node test bundles all import it (like shared/types.ts).

export const GAME_ARCHIVE_VERSION = 1 as const

/** Envelope metadata. Everything a replay viewer needs beyond the raw move
 *  list; each field individually optional so a minimal save stays valid. */
export interface GameArchiveMeta {
  /** Per-move human notation (GameSpec.notate), aligned index-for-index with
   *  `moves`. Absent = the codec strings are already the notation. */
  notated?: string[]
  /** Machine-readable end reason (kernel GameResult.reason: 'checkmate',
   *  'score', 'five-in-a-row', …). */
  reason?: string
  /** Display names in kernel color space (the spec's players order maps
   *  white/black onto per-game side names. Shogi sente, go black, …). */
  white?: string
  black?: string
  /** The GameSpec.init options value that reproduces the START position
   *  (JSON-round-tripped: go size/komi/handicap, chess960 start FEN, …).
   *  Absent = spec.init() default start. */
  options?: unknown
  /** Display context, e.g. 'Over the board' | 'Play vs Bot' | 'Online game'. */
  event?: string
  /** yyyy.mm.dd (PGN date convention). */
  date?: string
}

/** v1 envelope stored in the game table's `pgn` column for non-chess kinds. */
export interface GameArchive {
  /** Format version discriminator. */
  v: typeof GAME_ARCHIVE_VERSION
  /** Registry game kind ('go' | 'crazyhouse' | … | 'custom-<id>'). */
  kind: string
  /** Wire-codec moves VERBATIM, play order (GameSpec.play strings). */
  moves: string[]
  result: '1-0' | '0-1' | '1/2-1/2'
  meta?: GameArchiveMeta
}

const RESULTS: readonly string[] = ['1-0', '0-1', '1/2-1/2']

/** Serialize an envelope for the game table's `pgn` column (stable field
 *  order, v first. Greppable and diff-friendly). */
export function encodeGameArchive(a: GameArchive): string {
  return JSON.stringify({
    v: a.v,
    kind: a.kind,
    moves: a.moves,
    result: a.result,
    ...(a.meta !== undefined ? { meta: a.meta } : {})
  })
}

/** Cheap sniff: does this `pgn` column value hold a JSON envelope (any
 *  version) rather than PGN / legacy tag text? Those never begin with '{'. */
export function isArchiveJson(pgn: string): boolean {
  const t = pgn.trimStart()
  return t.startsWith('{') && t.includes('"v"')
}

const isStringArray = (x: unknown): x is string[] =>
  Array.isArray(x) && x.every((m) => typeof m === 'string')

/** Strict parse of a v1 envelope. Null = not an envelope this build can
 *  replay (PGN text, corrupt JSON, wrong shape, or a FUTURE version; callers
 *  degrade to a raw view rather than guessing). */
export function parseGameArchive(pgn: string): GameArchive | null {
  if (!isArchiveJson(pgn)) return null
  let raw: unknown
  try {
    raw = JSON.parse(pgn)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.v !== GAME_ARCHIVE_VERSION) return null
  if (typeof o.kind !== 'string' || o.kind.length === 0) return null
  if (!isStringArray(o.moves)) return null
  if (typeof o.result !== 'string' || !RESULTS.includes(o.result)) return null
  const out: GameArchive = {
    v: GAME_ARCHIVE_VERSION,
    kind: o.kind,
    moves: o.moves,
    result: o.result as GameArchive['result']
  }
  if (o.meta !== undefined) {
    if (typeof o.meta !== 'object' || o.meta === null || Array.isArray(o.meta)) return null
    const m = o.meta as Record<string, unknown>
    const meta: GameArchiveMeta = {}
    if (m.notated !== undefined) {
      if (!isStringArray(m.notated)) return null
      meta.notated = m.notated
    }
    for (const key of ['reason', 'white', 'black', 'event', 'date'] as const) {
      if (m[key] !== undefined) {
        if (typeof m[key] !== 'string') return null
        meta[key] = m[key] as string
      }
    }
    if (m.options !== undefined) meta.options = m.options
    out.meta = meta
  }
  return out
}
