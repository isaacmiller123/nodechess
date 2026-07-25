import { getAppDb } from './database'

export interface GameRow {
  id: number
  created_at: number
  white_name: string | null
  black_name: string | null
  user_color: string | null
  result: string | null
  opponent_kind: string | null
  opponent_label: string | null
  opponent_elo: number | null
  source: string | null
  pgn: string
  accuracy_white: number | null
  accuracy_black: number | null
  est_elo_low: number | null
  est_elo_high: number | null
  reviewed: number
  /** Registry game kind ('chess' | 'go' | 'gomoku' | … | 'custom-<id>'). Column
   *  added in migration v10 with DEFAULT 'chess': SELECT * has returned it since
   *  v10, so this type must carry it (mirrors shared/types.ts GameRow). */
  game_kind: string
}

export interface SaveGameInput {
  pgn: string
  whiteName?: string
  blackName?: string
  userColor?: 'white' | 'black'
  result?: string
  opponentKind?: string
  opponentLabel?: string
  opponentElo?: number
  source?: string
  /** The game family (game_kind column). Defaults to 'chess'. Non-chess games
   *  (go/othello/…) are stored but hidden from the chess Analysis/Progress/Home
   *  lists, whose PGN parser + review engine only understand standard chess. */
  gameKind?: string
}

export function saveGame(g: SaveGameInput): number {
  const r = getAppDb()
    .prepare(
      `INSERT INTO game
        (created_at,white_name,black_name,user_color,result,opponent_kind,opponent_label,opponent_elo,source,pgn,game_kind)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      Date.now(),
      g.whiteName ?? null,
      g.blackName ?? null,
      g.userColor ?? null,
      g.result ?? '*',
      g.opponentKind ?? null,
      g.opponentLabel ?? null,
      g.opponentElo ?? null,
      g.source ?? 'play',
      g.pgn,
      g.gameKind ?? 'chess'
    )
  return Number(r.lastInsertRowid)
}

export function listGames(limit = 25, offset = 0): GameRow[] {
  // Only standard-chess games: the Home/Progress/Analysis consumers all parse the
  // PGN and run the chess review engine, so a stored go/othello/checkers game
  // would render as a broken or blank board. Non-chess games stay in the table
  // (for stats/export) but never surface in these chess-only lists.
  //
  // Deliberate: chess VARIANTS (chess960/crazyhouse/…) are hidden too, not just
  // foreign games. Online variant games archive the generic wire codec
  // (onlineStore.genericArchive: UCI moves joined by spaces, not SAN PGN), so
  // the chess PGN parser cannot load them either; and even a SAN transcript
  // would mis-review (drops, variant win conditions). Only plain online chess
  // (adapter.kind === 'chess') archives real PGN, and it saves gameKind
  // 'chess', so it appears here as intended.
  return getAppDb()
    .prepare(
      "SELECT * FROM game WHERE game_kind = 'chess' ORDER BY created_at DESC LIMIT ? OFFSET ?"
    )
    .all(limit, offset) as unknown as GameRow[]
}

export interface ListAllGamesFilter {
  /** Exact game_kind ('chess' | 'go' | … | 'custom-<id>'). Omit = every kind. */
  kind?: string
  /** Exact source ('play' | 'online' | …). Omit = every source. */
  source?: string
  /** Exact result string ('1-0' | '0-1' | '1/2-1/2'). Omit = every result. */
  result?: string
  limit?: number
  offset?: number
}

/**
 * The full cross-mode archive (Library view): every kind, newest first, with
 * optional exact-match filters. Unlike listGames above this deliberately does
 * NOT hide non-chess rows: the Library routes chess rows to Analysis and
 * everything else to the game replay viewer, so nothing here can mis-render.
 */
export function listAllGames(f: ListAllGamesFilter = {}): GameRow[] {
  const where: string[] = []
  const args: (string | number)[] = []
  if (f.kind) {
    where.push('game_kind = ?')
    args.push(f.kind)
  }
  if (f.source) {
    where.push('source = ?')
    args.push(f.source)
  }
  if (f.result) {
    where.push('result = ?')
    args.push(f.result)
  }
  const sql =
    'SELECT * FROM game' +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  return getAppDb()
    .prepare(sql)
    .all(...args, f.limit ?? 60, f.offset ?? 0) as unknown as GameRow[]
}

/** Distinct game_kind values with row counts (Library filter chips). */
export function countGameKinds(): { kind: string; count: number }[] {
  return getAppDb()
    .prepare(
      'SELECT game_kind AS kind, COUNT(*) AS count FROM game GROUP BY game_kind ORDER BY count DESC, kind ASC'
    )
    .all() as unknown as { kind: string; count: number }[]
}

/** Distinct source values (Library mode filter). Nulls are skipped. */
export function listGameSources(): string[] {
  const rows = getAppDb()
    .prepare(
      'SELECT DISTINCT source FROM game WHERE source IS NOT NULL ORDER BY source ASC'
    )
    .all() as unknown as { source: string }[]
  return rows.map((r) => r.source)
}

export function getGame(id: number): GameRow | null {
  return (getAppDb().prepare('SELECT * FROM game WHERE id=?').get(id) as GameRow | undefined) ?? null
}

/**
 * Persist the computed per-side accuracies onto a game row (so the Progress
 * "accuracy" column populates). Called after a review:run that carried a gameId.
 */
export function setGameAccuracy(gameId: number, white: number, black: number): void {
  getAppDb()
    .prepare('UPDATE game SET accuracy_white=?, accuracy_black=? WHERE id=?')
    .run(white, black, gameId)
}
