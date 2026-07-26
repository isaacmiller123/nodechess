import { getAppDb, getPuzzlesDb } from './database'

export interface Puzzle {
  id: string
  fen: string
  moves: string[]
  rating: number
  popularity?: number
  themes: string[]
  gameUrl?: string
  openingTags: string[]
}

interface Row {
  PuzzleId: string
  FEN: string
  Moves: string
  Rating: number
  RatingDeviation: number | null
  Popularity: number | null
  NbPlays: number | null
  Themes: string | null
  GameUrl: string | null
  OpeningTags: string | null
}

function toPuzzle(r: Row): Puzzle {
  return {
    id: r.PuzzleId,
    fen: r.FEN,
    moves: r.Moves.split(' ').filter(Boolean),
    rating: r.Rating,
    popularity: r.Popularity ?? undefined,
    themes: (r.Themes ?? '').split(' ').filter(Boolean),
    gameUrl: r.GameUrl ?? undefined,
    openingTags: (r.OpeningTags ?? '').split(' ').filter(Boolean)
  }
}

export function getPuzzle(id: string): Puzzle | null {
  const r = getPuzzlesDb().prepare('SELECT * FROM puzzles WHERE PuzzleId=?').get(id) as Row | undefined
  return r ? toPuzzle(r) : null
}

let themesCache: { key: string; count: number }[] | null = null

export function listThemes(): { key: string; count: number }[] {
  // The bundled puzzle DB is read-only/static, so this GROUP BY over ~21M
  // junction rows is computed once per process and cached.
  if (!themesCache) {
    themesCache = getPuzzlesDb()
      .prepare('SELECT Theme AS key, COUNT(*) AS count FROM puzzle_themes GROUP BY Theme ORDER BY count DESC')
      .all() as { key: string; count: number }[]
  }
  return themesCache
}

let countCache: number | null = null

/** How many positions the installed set actually holds. Same reasoning as the
 *  theme cache: the DB is read-only, so the scan happens once per process. */
export function countPuzzles(): number {
  if (countCache === null) {
    const r = getPuzzlesDb().prepare('SELECT COUNT(*) AS n FROM puzzles').get() as { n: number }
    countCache = r?.n ?? 0
  }
  return countCache
}

// Fast, indexed, randomized selection (no ORDER BY RANDOM): seek a small window
// near a random target rating and pick one, skipping recently-seen ids.
export function nextPuzzle(opts: {
  theme?: string
  ratingLo: number
  ratingHi: number
  exclude?: string[]
}): Puzzle | null {
  const db = getPuzzlesDb()
  const { theme, ratingLo, ratingHi } = opts
  const exclude = new Set(opts.exclude ?? [])
  const target = ratingLo + Math.floor(Math.random() * Math.max(1, ratingHi - ratingLo))

  const pickId = (ids: string[]): string | null => {
    const f = ids.filter((i) => !exclude.has(i))
    const pool = f.length ? f : ids
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
  }

  if (theme) {
    let ids = (
      db
        .prepare('SELECT PuzzleId FROM puzzle_themes WHERE Theme=? AND Rating>=? AND Rating<=? ORDER BY Rating LIMIT 24')
        .all(theme, target, ratingHi) as { PuzzleId: string }[]
    ).map((r) => r.PuzzleId)
    if (ids.length === 0) {
      ids = (
        db
          .prepare('SELECT PuzzleId FROM puzzle_themes WHERE Theme=? AND Rating<=? AND Rating>=? ORDER BY Rating DESC LIMIT 24')
          .all(theme, target, ratingLo) as { PuzzleId: string }[]
      ).map((r) => r.PuzzleId)
    }
    const id = pickId(ids)
    return id ? getPuzzle(id) : null
  }

  let rows = db
    .prepare('SELECT * FROM puzzles WHERE Rating>=? AND Rating<=? ORDER BY Rating LIMIT 24')
    .all(target, ratingHi) as unknown as Row[]
  if (rows.length === 0) {
    rows = db
      .prepare('SELECT * FROM puzzles WHERE Rating<=? AND Rating>=? ORDER BY Rating DESC LIMIT 24')
      .all(target, ratingLo) as unknown as Row[]
  }
  const id = pickId(rows.map((r) => r.PuzzleId))
  const row = rows.find((r) => r.PuzzleId === id)
  return row ? toPuzzle(row) : null
}

const BATCH_MAX = 200

export type LengthBucket = 'short' | 'medium' | 'long' | 'any'

// Solution length is bucketed by the LEARNER's own moves. A puzzle's `Moves` is
// space-separated UCI: moves[0] is the opponent's lead-in, then plies alternate
// learner/opponent, so with N total plies the learner makes ceil((N-1)/2) moves.
//   short  = 1–2 learner moves → N in 2..5
//   medium = 3–4 learner moves → N in 6..9
//   long   = 5+  learner moves → N >= 10
// In SQL, N = (#spaces in Moves) + 1, i.e. length(Moves)-length(replace(Moves,' ',''))+1.
// Expressed as a bound on that space count S = N-1:
//   short  → S in 1..4 ; medium → S in 5..8 ; long → S >= 9.
const MOVES_SPACE_EXPR = "(length(Moves) - length(replace(Moves,' ','')))"

/** Build an extra WHERE fragment (with '' prefix so it can be concatenated) plus
 *  its positional params for the length + popularity filters. Applied to a table
 *  aliased so `Moves`/`Popularity` resolve (the `puzzles` table on both paths;
 *  the themed path joins puzzle_themes -> puzzles for these columns). */
function lengthPopClause(
  length: LengthBucket | undefined,
  minPopularity: number | undefined,
  col = ''
): { sql: string; params: number[] } {
  const parts: string[] = []
  const params: number[] = []
  const spaces = col ? `${MOVES_SPACE_EXPR.replace(/Moves/g, `${col}Moves`)}` : MOVES_SPACE_EXPR
  if (length === 'short') parts.push(`${spaces} BETWEEN 1 AND 4`)
  else if (length === 'medium') parts.push(`${spaces} BETWEEN 5 AND 8`)
  else if (length === 'long') parts.push(`${spaces} >= 9`)
  if (typeof minPopularity === 'number') {
    parts.push(`${col}Popularity >= ?`)
    params.push(minPopularity)
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params }
}

// Bulk fetch for Custom training (a fixed focused set) and Rush/Storm (which
// streams many puzzles without a per-puzzle, rating-blocked round-trip). Returns
// up to `count` DISTINCT puzzles in the [ratingLo, ratingHi] band, OR-matching
// any of `themes` (empty = any theme). `ascending` keeps them rating-sorted (Rush
// ramps difficulty); otherwise the window is shuffled. Recently-seen `exclude`
// ids are skipped. Custom training also filters by solution `length`, minimum
// `minPopularity`, and (via the IPC layer folding solved ids into `exclude`)
// already-solved puzzles. Over-fetches a window then trims so we don't ORDER BY
// RANDOM over the whole 4M-row table.
export function batchPuzzles(opts: {
  themes?: string[]
  ratingLo: number
  ratingHi: number
  count: number
  exclude?: string[]
  ascending?: boolean
  length?: LengthBucket
  minPopularity?: number
}): Puzzle[] {
  const db = getPuzzlesDb()
  const want = Math.max(1, Math.min(BATCH_MAX, Math.floor(opts.count)))
  const lo = Math.min(opts.ratingLo, opts.ratingHi)
  const hi = Math.max(opts.ratingLo, opts.ratingHi)
  const exclude = new Set(opts.exclude ?? [])
  // Over-fetch headroom so exclude-filtering + de-dup still leaves enough. The
  // length/popularity filters can be selective, so widen the window when set.
  const filtered = opts.length && opts.length !== 'any' ? true : typeof opts.minPopularity === 'number'
  const window = Math.min(BATCH_MAX * 8, want * (filtered ? 8 : 4) + 32)
  const themes = (opts.themes ?? []).filter(Boolean)
  const lp = lengthPopClause(opts.length, opts.minPopularity)

  let rows: Row[]
  if (themes.length > 0) {
    // Join puzzle_themes -> puzzles for the OR-set; randomized seek by Rating.
    // The length/popularity filters live on `puzzles`, so we join to read Moves
    // and Popularity (aliased 'p') and add the fragment against that alias.
    const placeholders = themes.map(() => '?').join(',')
    const lpJoin = lengthPopClause(opts.length, opts.minPopularity, 'p.')
    const needJoin = lpJoin.sql !== ''
    const target = lo + Math.floor(Math.random() * Math.max(1, hi - lo))
    const seek = (from: number): string[] =>
      (
        needJoin
          ? (db
              .prepare(
                `SELECT DISTINCT pt.PuzzleId AS PuzzleId FROM puzzle_themes pt
                 JOIN puzzles p ON p.PuzzleId = pt.PuzzleId
                 WHERE pt.Theme IN (${placeholders}) AND pt.Rating>=? AND pt.Rating<=?${lpJoin.sql}
                 ORDER BY pt.Rating LIMIT ?`
              )
              .all(...themes, from, hi, ...lpJoin.params, window) as { PuzzleId: string }[])
          : (db
              .prepare(
                `SELECT DISTINCT PuzzleId FROM puzzle_themes
                 WHERE Theme IN (${placeholders}) AND Rating>=? AND Rating<=?
                 ORDER BY Rating LIMIT ?`
              )
              .all(...themes, from, hi, window) as { PuzzleId: string }[])
      ).map((r) => r.PuzzleId)
    let ids = seek(target)
    let distinct = [...new Set(ids)].filter((id) => !exclude.has(id))
    if (distinct.length < want) {
      // Random target landed too high in the band: re-seek from the bottom and
      // merge (lo-window first so `ascending` stays rating-sorted), mirroring the
      // non-themed fallback below.
      ids = [...seek(lo), ...ids]
      distinct = [...new Set(ids)].filter((id) => !exclude.has(id))
    }
    if (!opts.ascending) {
      // Fisher–Yates shuffle the window before trimming (contract: only
      // `ascending` keeps the set rating-sorted).
      for (let i = distinct.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[distinct[i], distinct[j]] = [distinct[j], distinct[i]]
      }
    }
    const picked = distinct.slice(0, want)
    return picked.map((id) => getPuzzle(id)).filter((p): p is Puzzle => p !== null)
  } else {
    const target = lo + Math.floor(Math.random() * Math.max(1, hi - lo))
    rows = db
      .prepare(
        `SELECT * FROM puzzles WHERE Rating>=? AND Rating<=?${lp.sql} ORDER BY Rating LIMIT ?`
      )
      .all(target, hi, ...lp.params, window) as unknown as Row[]
    if (rows.length < want) {
      rows = db
        .prepare(
          `SELECT * FROM puzzles WHERE Rating>=? AND Rating<=?${lp.sql} ORDER BY Rating LIMIT ?`
        )
        .all(lo, hi, ...lp.params, window) as unknown as Row[]
    }
  }

  let pool = rows.filter((r) => !exclude.has(r.PuzzleId))
  if (!opts.ascending) {
    // Fisher–Yates shuffle the window before trimming.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
  }
  return pool.slice(0, want).map(toPuzzle)
}

/** Puzzle ids the user has already solved (any solved=1 attempt). Read from the
 *  writable app DB (puzzle_attempt), separate from the read-only puzzles DB, so
 *  the "exclude solved" Custom filter merges these into batchPuzzles' `exclude`.
 *  Capped so a huge solve history can't blow up the IN(...) / exclude set. */
export function solvedPuzzleIds(cap = 20000): string[] {
  const rows = getAppDb()
    .prepare(
      'SELECT DISTINCT puzzle_id FROM puzzle_attempt WHERE solved=1 ORDER BY created_at DESC LIMIT ?'
    )
    .all(cap) as { puzzle_id: string }[]
  return rows.map((r) => r.puzzle_id)
}
