// The puzzle query surface, served straight out of the static chunked database.
//
// Mirrors the desktop repositories the puzzle IPC channels call:
// src/main/db/puzzles.repo.ts (next/get/themes/batch) and src/main/db/daily.repo.ts
// (daily): with the same defaults, the same clamps and the same randomisation,
// so a caller cannot tell which side it is talking to. Two things ARE different,
// both forced by reading a database over HTTP:
//
//   - Every query has a bounded byte cost. A desktop plan that scans until it
//     has enough rows is unbounded here; each scan is capped by
//     `scanRowBudget`, and a query that runs out of budget returns fewer
//     puzzles rather than downloading the band.
//   - Plans are chosen for round-trips, not for CPU. Rating windows are
//     contiguous rowid ranges (see manifest.ts) instead of index seeks, and a
//     themed batch picks between one clustered scan and a covering index seek
//     plus point lookups depending on how common the requested themes are.
//
// Results are read-only puzzle data. Anything user-scoped, attempts, ratings,
// daily results, rush runs, is NOT here and never can be: it does not exist in
// the static artifact. `daily()` therefore always reports `result: null` and the
// caller must merge the local outcome.

import type { DailyPuzzle, Puzzle, PuzzleBatchRequest, ThemeCount } from '@shared/types'
import { ChunkedSqlite, type SqlParam } from './chunkedDb'
import { firstRowidAtLeast, lastRowidAtMost, loadManifest, type PuzzleChunkManifest } from './manifest'

// Columns that make up a `Puzzle`. RatingDeviation/NbPlays exist in the table
// but nothing reads them, and every column costs bytes across the worker.
const PUZZLE_COLS = 'PuzzleId,FEN,Moves,Rating,Popularity,Themes,GameUrl,OpeningTags'

// Contract constants, all copied from the desktop side.
const NEXT_WINDOW = 24
const BATCH_MAX = 200
const DEFAULT_RATING_LO = 600
const DEFAULT_RATING_HI = 2200

/** Bytes one scan may read before it gives up and returns what it has. ~4 MiB
 *  is a few hundred ms on a warm CDN connection and roughly 9,000 puzzle rows.
 *  Far more than any batch asks for unless the filters are very selective. */
const SCAN_BUDGET_BYTES = 4 * 1024 * 1024
/** Puzzles fetched by id in one themed batch. Each one is a random page read,
 *  i.e. its own round-trip, so this is the latency ceiling for the rare-theme
 *  path: a caller wanting more should page with `exclude`. */
const MAX_POINT_LOOKUPS = 128

interface Row {
  PuzzleId: string
  FEN: string
  Moves: string
  Rating: number
  Popularity: number | null
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

export interface PuzzleDatasetInfo {
  puzzleCount: number
  themeCount: number
  ratingMin: number
  ratingMax: number
  builtAt: string
  bytes: number
  chunkCount: number
}

/** Read-only half of `window.api.puzzles`: everything the puzzle IPC channels
 *  answer from the puzzles database alone. */
export interface StaticPuzzleReader {
  info(): Promise<PuzzleDatasetInfo>
  next(req: {
    theme?: string
    ratingLo?: number
    ratingHi?: number
    exclude?: string[]
  }): Promise<{ puzzle: Puzzle | null }>
  get(puzzleId: string): Promise<{ puzzle: Puzzle | null }>
  themes(): Promise<{ themes: ThemeCount[] }>
  batch(req: PuzzleBatchRequest): Promise<{ puzzles: Puzzle[] }>
  /** `result` is always null. This artifact holds no user state. */
  daily(req?: { ymd?: string }): Promise<DailyPuzzle>
  transferred(): Promise<{ bytes: number; requests: number } | null>
  close(): Promise<void>
}

export interface StaticPuzzleReaderOptions {
  /** Directory holding the chunks + manifest. Default `<base>puzzles/`. */
  baseUrl?: string
  manifestName?: string
  workerUrl?: string
  wasmUrl?: string
  fetchImpl?: typeof fetch
}

/** Vite base URL; guarded so non-Vite bundlers (the esbuild test harnesses)
 *  can evaluate this module. Mirrors src/web/engines/assets.ts. */
function viteBase(): string {
  const env = (import.meta as { env?: { BASE_URL?: string } }).env
  return env?.BASE_URL ?? '/'
}

export function createStaticPuzzleReader(opts: StaticPuzzleReaderOptions = {}): StaticPuzzleReader {
  const baseUrl = opts.baseUrl ?? `${viteBase()}puzzles/`
  const manifestUrl = `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}${opts.manifestName ?? 'puzzles.manifest.json'}`

  interface Conn {
    db: ChunkedSqlite
    m: PuzzleChunkManifest
    /** Rows a single scan may read, from the measured average row size. */
    scanRowBudget: number
    themeCounts: Map<string, number>
  }
  let conn: Promise<Conn> | null = null

  const connect = (): Promise<Conn> => {
    if (!conn) {
      conn = (async () => {
        const m = await loadManifest(manifestUrl, opts.fetchImpl)
        return {
          m,
          db: new ChunkedSqlite({
            baseUrl,
            manifest: m,
            ...(opts.workerUrl ? { workerUrl: opts.workerUrl } : {}),
            ...(opts.wasmUrl ? { wasmUrl: opts.wasmUrl } : {})
          }),
          scanRowBudget: Math.max(256, Math.floor(SCAN_BUDGET_BYTES / Math.max(1, m.puzzleRowBytes))),
          themeCounts: new Map(m.themes.map((t) => [t.key, t.count]))
        }
      })().catch((err) => {
        // A failed manifest fetch must not poison the reader for the session.
        conn = null
        throw err
      })
    }
    return conn
  }

  /** Rows of a contiguous rowid range: the cheapest read this database
   *  supports, since rowid is the rank in (Rating, PuzzleId) order. `extraSql`
   *  filters rows the scan already had to read; it never widens the range. */
  const scanRange = async (
    c: Conn,
    from: number,
    to: number,
    limit: number,
    extra: { sql: string; params: SqlParam[] } = { sql: '', params: [] }
  ): Promise<Row[]> => {
    // Bounded on BOTH ends: `limit` stops a cheap scan early, the row budget
    // stops a selective filter from walking the whole band.
    const end = Math.min(to, from + c.scanRowBudget - 1)
    if (end < from || from < 1) return []
    return c.db.query<Row>(
      `SELECT ${PUZZLE_COLS} FROM puzzles WHERE rowid>=? AND rowid<=?${extra.sql} LIMIT ?`,
      [from, end, ...extra.params, limit]
    )
  }

  const byId = async (c: Conn, ids: string[], extra: { sql: string; params: SqlParam[] }): Promise<Row[]> => {
    if (!ids.length) return []
    const placeholders = ids.map(() => '?').join(',')
    return c.db.query<Row>(
      `SELECT ${PUZZLE_COLS} FROM puzzles WHERE PuzzleId IN (${placeholders})${extra.sql}`,
      [...ids, ...extra.params]
    )
  }

  /** Covering read of the theme junction: (Theme, Rating, PuzzleId) is the
   *  table's primary key, so this touches only index pages in one rating-ordered
   *  run. No puzzle rows at all. */
  const themeIds = async (
    c: Conn,
    theme: string,
    from: number,
    to: number,
    limit: number,
    descending: boolean
  ): Promise<{ PuzzleId: string; Rating: number }[]> =>
    c.db.query<{ PuzzleId: string; Rating: number }>(
      `SELECT PuzzleId,Rating FROM puzzle_themes WHERE Theme=? AND Rating>=? AND Rating<=?
       ORDER BY Rating ${descending ? 'DESC' : 'ASC'} LIMIT ?`,
      [theme, from, to, limit]
    )

  /** Themed batch, planned by how much of the table the requested themes cover.
   *
   *  Broad sets (the Custom trainer's "most themes selected", or any common
   *  theme) match often enough that ONE contiguous scan with a theme test finds
   *  the whole set. No index, no point lookups, a handful of round-trips.
   *  Narrow sets would have that scan read the band to find a match, so they go
   *  through the covering index instead and pay one page read per puzzle. */
  const themedBatch = async (
    c: Conn,
    q: {
      themes: string[]
      lo: number
      hi: number
      target: number
      want: number
      window: number
      lp: { sql: string; params: SqlParam[] }
    }
  ): Promise<Row[]> => {
    // Summing the per-theme counts double-counts puzzles carrying several of
    // them, so this reads the union as commoner than it is and can pick the
    // scan when the scan is longer than estimated. That direction is the safe
    // one: scanRange is hard-capped, so an over-eager scan returns a short
    // batch, never an unbounded download.
    const covered = q.themes.reduce((n, t) => n + (c.themeCounts.get(t) ?? 0), 0)
    const hitRate = Math.min(1, covered / Math.max(1, c.m.puzzleCount))
    const estScanRows = hitRate > 0 ? Math.ceil(q.window / hitRate) : Infinity

    if (estScanRows <= c.scanRowBudget) {
      // instr() over the space-padded column, not LIKE: no wildcard escaping,
      // and it matches whole theme keys only ('mate' must not hit 'mateIn2').
      const themeSql = q.themes.map(() => `instr(' '||Themes||' ', ?)>0`).join(' OR ')
      const extra = {
        sql: ` AND (${themeSql})${q.lp.sql}`,
        params: [...q.themes.map((t) => ` ${t} `), ...q.lp.params]
      }
      let rows = await scanRange(c, firstRowidAtLeast(c.m, q.target), lastRowidAtMost(c.m, q.hi), q.window, extra)
      if (rows.length < q.want) {
        rows = await scanRange(c, firstRowidAtLeast(c.m, q.lo), lastRowidAtMost(c.m, q.hi), q.window, extra)
      }
      return rows
    }

    // Rare themes: seek the index most-populated-theme first and stop as soon as
    // there are enough candidates, so one common theme in the set answers the
    // whole request and the rest cost nothing.
    const ordered = [...q.themes].sort((a, b) => (c.themeCounts.get(b) ?? 0) - (c.themeCounts.get(a) ?? 0))
    const seen = new Map<string, number>()
    for (const from of [q.target, q.lo]) {
      for (const theme of ordered) {
        if (seen.size >= q.window) break
        for (const r of await themeIds(c, theme, from, q.hi, q.window, false)) {
          if (!seen.has(r.PuzzleId)) seen.set(r.PuzzleId, r.Rating)
        }
      }
      if (seen.size >= q.want) break
    }
    // Rating order first, so an `ascending` batch stays ramped after the cap.
    const ids = [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)
    // Each of these is its own round-trip, so take only what the request can
    // actually use: extra headroom for exclude/dedup, more when the length and
    // popularity filters (applied in the same statement) can reject rows.
    const take = Math.min(MAX_POINT_LOOKUPS, q.lp.sql ? q.window : q.want + 32)
    return byId(c, ids.slice(0, take), q.lp)
  }

  return {
    async info(): Promise<PuzzleDatasetInfo> {
      const { m } = await connect()
      return {
        puzzleCount: m.puzzleCount,
        themeCount: m.themes.length,
        ratingMin: m.ratingMin,
        ratingMax: m.ratingMax,
        builtAt: m.builtAt,
        bytes: m.db.bytes,
        chunkCount: m.db.chunkCount
      }
    },

    async themes() {
      // Precomputed at build time: the desktop's GROUP BY reads 21M junction
      // rows, which is not a thing you do over HTTP.
      const { m } = await connect()
      return { themes: m.themes.map((t) => ({ ...t })) }
    },

    async get(puzzleId: string) {
      const c = await connect()
      const rows = await c.db.query<Row>(`SELECT ${PUZZLE_COLS} FROM puzzles WHERE PuzzleId=?`, [puzzleId])
      return { puzzle: rows[0] ? toPuzzle(rows[0]) : null }
    },

    async next(req) {
      const c = await connect()
      const lo = req.ratingLo ?? DEFAULT_RATING_LO
      const hi = req.ratingHi ?? DEFAULT_RATING_HI
      const exclude = new Set(req.exclude ?? [])
      // Same randomised seek as the desktop: aim at a point in the band and
      // take the first window at or above it, falling back downwards.
      const target = lo + Math.floor(Math.random() * Math.max(1, hi - lo))

      if (req.theme) {
        let ids = await themeIds(c, req.theme, target, hi, NEXT_WINDOW, false)
        if (!ids.length) ids = await themeIds(c, req.theme, lo, target, NEXT_WINDOW, true)
        const id = pickOne(ids.map((r) => r.PuzzleId), exclude)
        if (!id) return { puzzle: null }
        const rows = await c.db.query<Row>(`SELECT ${PUZZLE_COLS} FROM puzzles WHERE PuzzleId=?`, [id])
        return { puzzle: rows[0] ? toPuzzle(rows[0]) : null }
      }

      let rows = await scanRange(c, firstRowidAtLeast(c.m, target), lastRowidAtMost(c.m, hi), NEXT_WINDOW)
      if (!rows.length) {
        // Nothing above the target: take the window ENDING at it, which is what
        // the desktop's `ORDER BY Rating DESC` fallback returns.
        const end = lastRowidAtMost(c.m, target)
        const start = Math.max(firstRowidAtLeast(c.m, lo), end - NEXT_WINDOW + 1)
        rows = await scanRange(c, start, end, NEXT_WINDOW)
      }
      const id = pickOne(rows.map((r) => r.PuzzleId), exclude)
      const row = rows.find((r) => r.PuzzleId === id)
      return { puzzle: row ? toPuzzle(row) : null }
    },

    async batch(req) {
      const c = await connect()
      const want = Math.max(1, Math.min(BATCH_MAX, Math.floor(req.count)))
      const rawLo = req.ratingLo ?? DEFAULT_RATING_LO
      const rawHi = req.ratingHi ?? DEFAULT_RATING_HI
      const lo = Math.min(rawLo, rawHi)
      const hi = Math.max(rawLo, rawHi)
      const exclude = new Set(req.exclude ?? [])
      const length = req.length === 'any' ? undefined : req.length
      const filtered = length !== undefined || typeof req.minPopularity === 'number'
      // Over-fetch headroom for exclude-filtering and de-dup, widened when the
      // extra filters can reject rows (identical to the desktop's arithmetic).
      const window = Math.min(BATCH_MAX * 8, want * (filtered ? 8 : 4) + 32)
      const lp = lengthPopClause(length, req.minPopularity)
      const themes = (req.themes ?? []).filter(Boolean)
      const target = lo + Math.floor(Math.random() * Math.max(1, hi - lo))

      let rows: Row[]
      if (themes.length === 0) {
        rows = await scanRange(c, firstRowidAtLeast(c.m, target), lastRowidAtMost(c.m, hi), window, lp)
        if (rows.length < want) {
          // The random target landed too high in the band. Re-seek from the
          // bottom, as the desktop does.
          rows = await scanRange(c, firstRowidAtLeast(c.m, lo), lastRowidAtMost(c.m, hi), window, lp)
        }
      } else {
        rows = await themedBatch(c, { themes, lo, hi, target, want, window, lp })
      }

      const pool = rows.filter((r) => !exclude.has(r.PuzzleId))
      // A contiguous scan already comes back rating-ordered, but the themed
      // point-lookup path returns rows in id order, sort so `ascending` means
      // the same thing on both.
      if (req.ascending) pool.sort((a, b) => a.Rating - b.Rating)
      else shuffle(pool)
      return { puzzles: pool.slice(0, want).map(toPuzzle) }
    },

    async daily(req) {
      const c = await connect()
      const day = normalizeYmd(req?.ymd)
      const first = firstRowidAtLeast(c.m, c.m.daily.ratingLo)
      const band = lastRowidAtMost(c.m, c.m.daily.ratingHi) - first + 1
      // Identical to dailyPuzzleFor(): hash the day to an offset into the band
      // ordered by (Rating, PuzzleId). Because rowid IS that rank, the offset
      // resolves to a single rowid: one page read instead of the desktop's
      // OFFSET scan, and the same puzzle everyone else sees today.
      // Empty band means a database the build script would have rejected; fall
      // back to the whole table so there is still a puzzle of the day.
      const n = band > 0 ? band : c.m.puzzleCount
      const base = band > 0 ? first : 1
      if (n <= 0) return { ymd: day, puzzle: null, result: null }
      const rowid = base + (hashYmd(day) % n)
      const rows = await c.db.query<Row>(`SELECT ${PUZZLE_COLS} FROM puzzles WHERE rowid=?`, [rowid])
      return { ymd: day, puzzle: rows[0] ? toPuzzle(rows[0]) : null, result: null }
    },

    async transferred() {
      const c = await connect()
      const s = await c.db.stats()
      return s ? { bytes: s.totalFetchedBytes, requests: s.totalRequests } : null
    },

    async close() {
      if (!conn) return
      const c = await conn.catch(() => null)
      conn = null
      await c?.db.close()
    }
  }
}

// ---- shared query fragments -------------------------------------------------

/** Solution-length + popularity filters, verbatim from puzzles.repo.ts: a
 *  puzzle's `Moves` holds N space-separated plies of which the learner plays
 *  ceil((N-1)/2), so the bucket is expressed as a bound on the space count. */
const MOVES_SPACE_EXPR = "(length(Moves) - length(replace(Moves,' ','')))"

function lengthPopClause(
  length: 'short' | 'medium' | 'long' | undefined,
  minPopularity: number | undefined
): { sql: string; params: SqlParam[] } {
  const parts: string[] = []
  const params: SqlParam[] = []
  if (length === 'short') parts.push(`${MOVES_SPACE_EXPR} BETWEEN 1 AND 4`)
  else if (length === 'medium') parts.push(`${MOVES_SPACE_EXPR} BETWEEN 5 AND 8`)
  else if (length === 'long') parts.push(`${MOVES_SPACE_EXPR} >= 9`)
  if (typeof minPopularity === 'number') {
    parts.push('Popularity >= ?')
    params.push(minPopularity)
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params }
}

/** Prefer an unseen id, but never return nothing just because the whole window
 *  is excluded (desktop behaviour). */
function pickOne(ids: string[], exclude: Set<string>): string | null {
  const fresh = ids.filter((i) => !exclude.has(i))
  const pool = fresh.length ? fresh : ids
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
}

/** Fisher–Yates, in place. */
function shuffle<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
}

// ---- daily day keys ---------------------------------------------------------
// Copied from src/main/db/daily.repo.ts, which is the contract: the daily is
// keyed to the user's LOCAL calendar day and hashed with FNV-1a so every client
// (desktop or web) resolves the same day to the same puzzle. Keep in step.

function ymdFromMs(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

function normalizeYmd(ymd?: string): string {
  if (ymd && YMD_RE.test(ymd)) {
    const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10))
    const dt = new Date(y, m - 1, d)
    // Round-trip so '2026-02-31' cannot address a day that does not exist.
    if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) return ymd
  }
  return ymdFromMs(Date.now())
}

function hashYmd(ymd: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < ymd.length; i++) {
    h ^= ymd.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
