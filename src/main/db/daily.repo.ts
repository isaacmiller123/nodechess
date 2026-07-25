import { getAppDb, getPuzzlesDb, hasPuzzlesDb } from './database'
import { getPuzzle, type Puzzle } from './puzzles.repo'
import type {
  DailyPuzzle,
  DailyResult,
  DailyStreak,
  PuzzleStats,
  ThemeStat,
  PuzzleHistoryRow,
  PuzzleMode
} from '../../shared/types'

// ============================================================================
// SLICE C: Daily puzzle + streaks + stats/history.  ★ OWNED BY THE DAILY BUILDER ★
//
// All read/write logic for the daily puzzle, the daily-streak calendar, and the
// aggregate stats / paginated history views. Reads the writable app DB
// (daily_result + puzzle_attempt, both present after migration user_version=5)
// and the read-only bundled puzzle DB (for the deterministic daily selection).
// IPC handlers in puzzles.daily.ipc.ts call straight into these functions.
// ============================================================================

// ---- LOCAL day key ----------------------------------------------------------
//
// The daily is keyed to the user's LOCAL calendar day, Wordle-style: the puzzle
// is still deterministic per 'YYYY-MM-DD' string (everyone on the same local
// date gets the same puzzle), but "today" flips at the user's own midnight and
// the streak counts consecutive LOCAL days. Matching the School streak
// (src/main/util/day.ts). Keying on UTC broke streaks west of UTC: solving Mon
// 3pm + Tue 5pm PST wrote UTC-Mon and UTC-Wed rows, resetting the streak.

/** 'YYYY-MM-DD' for a given epoch-ms in the user's LOCAL timezone. */
export function ymdFromMs(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Today's LOCAL day key. */
export function todayYmd(): string {
  return ymdFromMs(Date.now())
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/** Validate + normalise a caller-supplied ymd; falls back to today when absent
 *  or malformed (the zod schema only guarantees it's a string). */
function normalizeYmd(ymd?: string): string {
  if (ymd && YMD_RE.test(ymd)) {
    // Round-trip through Date so e.g. '2026-02-31' can't address a bogus day.
    const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10))
    const dt = new Date(y, m - 1, d)
    if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) return ymd
  }
  return todayYmd()
}

/** The LOCAL day immediately before `ymd` (both 'YYYY-MM-DD'). Parsed as local
 *  midnight so the walk-back respects the user's calendar (incl. DST shifts). */
function prevYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() - 1)
  return ymdFromMs(dt.getTime())
}

// ---- Deterministic daily selection -----------------------------------------

/** FNV-1a 32-bit hash of a string: small, fast, dependency-free, and stable
 *  across runs/machines so the day's puzzle is identical for everyone. */
function hashYmd(ymd: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < ymd.length; i++) {
    h ^= ymd.charCodeAt(i)
    // h *= 16777619, kept in 32-bit unsigned via Math.imul.
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// The daily is drawn from an "approachable but interesting" rating band so the
// global puzzle of the day is fair for a broad audience (not a 2800 grind, not a
// trivial mate-in-1). Deterministic OFFSET into this band keyed off the day hash.
const DAILY_RATING_LO = 1200
const DAILY_RATING_HI = 1800

interface DailyRow {
  PuzzleId: string
}

// In-process memo of ymd -> puzzle id: dailyPuzzleFor is hit by several
// always-mounted surfaces and the band COUNT + ORDER BY ... OFFSET scan isn't
// free. The mapping is deterministic over the read-only puzzle DB, so caching
// is safe; only successful lookups are cached (a lean install that later
// imports the DB won't see stale nulls). Tiny cap: only today ± a few days
// are ever requested.
const dailyIdCache = new Map<string, string>()
const DAILY_ID_CACHE_MAX = 8

function rememberDailyId(ymd: string, id: string): void {
  if (dailyIdCache.size >= DAILY_ID_CACHE_MAX) {
    const oldest = dailyIdCache.keys().next().value
    if (oldest !== undefined) dailyIdCache.delete(oldest)
  }
  dailyIdCache.set(ymd, id)
}

/** The deterministic daily puzzle for a calendar day. Same for everyone on that
 *  local date: we hash the ymd to a stable offset and select that row from a
 *  rating-ordered window of the read-only puzzle DB. Returns null only when no
 *  puzzle DB is installed (lean install) or the band is somehow empty. */
export function dailyPuzzleFor(ymd: string): Puzzle | null {
  if (!hasPuzzlesDb()) return null
  const cached = dailyIdCache.get(ymd)
  if (cached) return getPuzzle(cached)
  const db = getPuzzlesDb()

  const countRow = db
    .prepare('SELECT COUNT(*) AS n FROM puzzles WHERE Rating>=? AND Rating<=?')
    .get(DAILY_RATING_LO, DAILY_RATING_HI) as { n: number } | undefined
  const n = countRow?.n ?? 0
  if (n <= 0) {
    // Band empty (unexpected for the real DB): fall back to the whole table.
    const total = (db.prepare('SELECT COUNT(*) AS n FROM puzzles').get() as { n: number }).n
    if (total <= 0) return null
    const off = hashYmd(ymd) % total
    const r = db
      .prepare('SELECT PuzzleId FROM puzzles ORDER BY PuzzleId LIMIT 1 OFFSET ?')
      .get(off) as DailyRow | undefined
    if (!r) return null
    rememberDailyId(ymd, r.PuzzleId)
    return getPuzzle(r.PuzzleId)
  }

  const offset = hashYmd(ymd) % n
  // ORDER BY (Rating, PuzzleId) gives a stable total order over the band so the
  // same offset always resolves to the same puzzle. idx_rating covers the WHERE +
  // leading sort key; PuzzleId is the PK tiebreak.
  const r = db
    .prepare(
      'SELECT PuzzleId FROM puzzles WHERE Rating>=? AND Rating<=? ORDER BY Rating, PuzzleId LIMIT 1 OFFSET ?'
    )
    .get(DAILY_RATING_LO, DAILY_RATING_HI, offset) as DailyRow | undefined
  if (!r) return null
  rememberDailyId(ymd, r.PuzzleId)
  return getPuzzle(r.PuzzleId)
}

// ---- daily_result reads/writes ---------------------------------------------

interface DailyResultRow {
  ymd: string
  puzzle_id: string
  solved: number
  first_try: number
  ms: number | null
}

function toDailyResult(r: DailyResultRow): DailyResult {
  return {
    ymd: r.ymd,
    puzzleId: r.puzzle_id,
    solved: r.solved === 1,
    firstTry: r.first_try === 1,
    ms: r.ms ?? null
  }
}

function readResult(ymd: string): DailyResult | null {
  const r = getAppDb()
    .prepare('SELECT ymd,puzzle_id,solved,first_try,ms FROM daily_result WHERE ymd=?')
    .get(ymd) as DailyResultRow | undefined
  return r ? toDailyResult(r) : null
}

/** The daily puzzle for a day (default today) plus this user's result on it. */
export function dailyPuzzle(ymd?: string): DailyPuzzle {
  const day = normalizeYmd(ymd)
  return {
    ymd: day,
    puzzle: dailyPuzzleFor(day),
    result: readResult(day)
  }
}

/** Record (or update) the user's outcome on a day's daily puzzle, then return the
 *  recomputed streak. The first write for a day wins the `first_try` flag; a later
 *  re-attempt can flip `solved`/`ms` but never downgrades an earned first-try. */
export function recordDaily(input: {
  ymd: string
  puzzleId: string
  solved: boolean
  firstTry: boolean
  ms?: number
}): { streak: DailyStreak } {
  const day = normalizeYmd(input.ymd)
  const db = getAppDb()
  const existing = readResult(day)
  const now = Date.now()

  if (!existing) {
    db.prepare(
      'INSERT INTO daily_result(ymd,puzzle_id,solved,first_try,ms,created_at) VALUES (?,?,?,?,?,?)'
    ).run(
      day,
      input.puzzleId,
      input.solved ? 1 : 0,
      input.firstTry && input.solved ? 1 : 0,
      input.ms ?? null,
      now
    )
  } else {
    // Keep the original created_at + first_try; allow a later solve to upgrade a
    // miss. Once solved, don't let a subsequent attempt un-solve the day.
    const solved = existing.solved || input.solved
    const firstTry = existing.firstTry // earned (or not) on the first recorded attempt
    const ms = input.ms ?? existing.ms ?? null
    db.prepare('UPDATE daily_result SET puzzle_id=?,solved=?,first_try=?,ms=? WHERE ymd=?').run(
      input.puzzleId,
      solved ? 1 : 0,
      firstTry ? 1 : 0,
      ms,
      day
    )
  }

  return { streak: dailyStreak() }
}

// ---- Streak ----------------------------------------------------------------

interface SolvedDayRow {
  ymd: string
}

/** Daily-streak summary computed from daily_result:
 *   - current: consecutive solved days ending today (or yesterday, so the streak
 *     doesn't read as broken before you've played today).
 *   - best: the longest consecutive-solved run ever.
 *   - todaySolved: whether today's daily is solved.
 *   - recent: the last N days' outcomes, most-recent first, for a calendar strip. */
export function dailyStreak(recentDays = 35): DailyStreak {
  const db = getAppDb()
  // Every consumer below (walk-back, best-run scan, calendar strip) only cares
  // about SOLVED days, so filter in SQL instead of materializing the whole
  // table; the ymd PK provides the ASC order without a sort.
  const rows = db
    .prepare('SELECT ymd FROM daily_result WHERE solved=1 ORDER BY ymd ASC')
    .all() as unknown as SolvedDayRow[]

  // Set of solved day keys for O(1) walk-back.
  const solvedSet = new Set<string>()
  for (const r of rows) solvedSet.add(r.ymd)

  const today = todayYmd()
  const yesterday = prevYmd(today)
  const todaySolved = solvedSet.has(today)

  // Current streak: start from today if solved, else yesterday (a streak stays
  // "alive" the day after until you miss). Walk backwards while days are solved.
  let current = 0
  let cursor = todaySolved ? today : yesterday
  while (solvedSet.has(cursor)) {
    current++
    cursor = prevYmd(cursor)
  }

  // Best streak: longest run of consecutive calendar days that are all solved.
  // Walk the solved days in ascending order, resetting when there's a gap.
  const solvedAsc = rows.map((r) => r.ymd)
  let best = 0
  let run = 0
  let prev: string | null = null
  for (const ymd of solvedAsc) {
    if (prev !== null && prevYmd(ymd) === prev) {
      run++
    } else {
      run = 1
    }
    if (run > best) best = run
    prev = ymd
  }
  best = Math.max(best, current)

  // Recent calendar strip: the last `recentDays` LOCAL days ending today, each
  // with its outcome. Days with no row are absent from the set -> solved:false
  // (an unattempted/blank cell). Most-recent first.
  const recent: { ymd: string; solved: boolean }[] = []
  let day = today
  for (let i = 0; i < recentDays; i++) {
    recent.push({ ymd: day, solved: solvedSet.has(day) })
    day = prevYmd(day)
  }

  return { current, best, todaySolved, recent }
}

// ---- Stats (aggregate + per-theme + daily buckets) -------------------------

interface AttemptScalarRow {
  total: number
  solved: number
}

interface ThemeAggRow {
  theme: string | null
  attempts: number
  solved: number
  avg_ms: number | null
}

interface DailyBucketRow {
  ymd: string
  attempts: number
  solved: number
}

const STATS_THEME_LIMIT = 16
const STATS_DAILY_DAYS = 30

/** Aggregate trainer stats over ALL puzzle_attempt rows (every mode), plus a
 *  per-theme accuracy breakdown and a per-day solved/attempted sparkline. */
export function puzzleStats(): PuzzleStats {
  const db = getAppDb()

  const totals = db
    .prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(solved),0) AS solved FROM puzzle_attempt"
    )
    .get() as unknown as AttemptScalarRow
  const totalAttempts = totals.total
  const totalSolved = totals.solved
  const accuracy = totalAttempts > 0 ? totalSolved / totalAttempts : 0

  // Best solving streak across the whole attempt history, computed IN SQL
  // (gaps-and-islands: consecutive solved rows share `rn_all - rn_solved`) so
  // the scan never materializes the table into JS and needs no sort pass:
  // `id` is AUTOINCREMENT and attempts are append-only with created_at=now, so
  // id order IS the old (created_at ASC, id ASC) chronological order. The exact
  // all-time answer inherently reads every row, but this keeps it O(1) memory.
  const streakRow = db
    .prepare(
      `SELECT COALESCE(MAX(len), 0) AS best
         FROM (SELECT COUNT(*) AS len
                 FROM (SELECT (solved=1) AS ok,
                              ROW_NUMBER() OVER (ORDER BY id)
                            - ROW_NUMBER() OVER (PARTITION BY (solved=1) ORDER BY id) AS grp
                         FROM puzzle_attempt)
                WHERE ok=1
                GROUP BY grp)`
    )
    .get() as unknown as { best: number }
  const bestStreak = streakRow.best

  // Per-theme accuracy. Attempts tagged with a theme (slice A/C). NULL/empty
  // themes are skipped (an untagged adaptive-train attempt has no single theme).
  const themeRows = db
    .prepare(
      `SELECT theme,
              COUNT(*)                                            AS attempts,
              COALESCE(SUM(solved),0)                             AS solved,
              AVG(CASE WHEN solved=1 THEN ms END)                 AS avg_ms
         FROM puzzle_attempt
        WHERE theme IS NOT NULL AND theme <> ''
        GROUP BY theme
        ORDER BY attempts DESC, theme ASC
        LIMIT ?`
    )
    .all(STATS_THEME_LIMIT) as unknown as ThemeAggRow[]
  const byTheme: ThemeStat[] = themeRows.map((r) => ({
    theme: r.theme ?? '',
    attempts: r.attempts,
    solved: r.solved,
    accuracy: r.attempts > 0 ? r.solved / r.attempts : 0,
    avgMs: r.avg_ms != null ? Math.round(r.avg_ms) : null
  }))

  // Per-day buckets for the last STATS_DAILY_DAYS days (LOCAL), oldest -> newest
  // so the sparkline reads left-to-right in time. Bucketed in SQL by local date
  // ('localtime') so the keys line up with the todayYmd/prevYmd dense series.
  const since = Date.now() - STATS_DAILY_DAYS * 86_400_000
  const bucketRows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch', 'localtime') AS ymd,
              COUNT(*)                AS attempts,
              COALESCE(SUM(solved),0) AS solved
         FROM puzzle_attempt
        WHERE created_at >= ?
        GROUP BY ymd`
    )
    .all(since) as unknown as DailyBucketRow[]
  const bucketByYmd = new Map<string, DailyBucketRow>()
  for (const b of bucketRows) bucketByYmd.set(b.ymd, b)

  // Emit a dense series (one entry per day, zero-filled) for a clean sparkline.
  const daily: { ymd: string; attempts: number; solved: number }[] = []
  const days: string[] = []
  let d = todayYmd()
  for (let i = 0; i < STATS_DAILY_DAYS; i++) {
    days.push(d)
    d = prevYmd(d)
  }
  days.reverse() // oldest first
  for (const ymd of days) {
    const b = bucketByYmd.get(ymd)
    daily.push({ ymd, attempts: b?.attempts ?? 0, solved: b?.solved ?? 0 })
  }

  return { totalAttempts, totalSolved, accuracy, bestStreak, byTheme, daily }
}

// ---- History (paginated, newest first) -------------------------------------

interface HistoryRow {
  id: number
  puzzle_id: string
  solved: number
  ms: number | null
  rating_before: number | null
  rating_after: number | null
  theme: string | null
  mode: string
  created_at: number
}

const HISTORY_DEFAULT_LIMIT = 25
const HISTORY_MAX_LIMIT = 200

const VALID_MODES: ReadonlySet<PuzzleMode> = new Set(['train', 'custom', 'rush', 'daily'])

function toHistoryRow(r: HistoryRow): PuzzleHistoryRow {
  const mode: PuzzleMode = VALID_MODES.has(r.mode as PuzzleMode) ? (r.mode as PuzzleMode) : 'train'
  return {
    id: r.id,
    puzzleId: r.puzzle_id,
    solved: r.solved === 1,
    ms: r.ms ?? null,
    ratingBefore: r.rating_before != null ? Math.round(r.rating_before) : null,
    ratingAfter: r.rating_after != null ? Math.round(r.rating_after) : null,
    theme: r.theme ?? null,
    mode,
    createdAt: r.created_at
  }
}

/** Paginated solve history, newest first, optionally filtered to one mode. */
export function puzzleHistory(opts?: {
  limit?: number
  offset?: number
  mode?: PuzzleMode
}): PuzzleHistoryRow[] {
  const db = getAppDb()
  const limit = Math.max(1, Math.min(HISTORY_MAX_LIMIT, Math.floor(opts?.limit ?? HISTORY_DEFAULT_LIMIT)))
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0))
  const mode = opts?.mode

  const cols =
    'id,puzzle_id,solved,ms,rating_before,rating_after,theme,mode,created_at'
  const rows = mode
    ? (db
        .prepare(
          `SELECT ${cols} FROM puzzle_attempt WHERE mode=? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(mode, limit, offset) as unknown as HistoryRow[])
    : (db
        .prepare(
          `SELECT ${cols} FROM puzzle_attempt ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(limit, offset) as unknown as HistoryRow[])

  return rows.map(toHistoryRow)
}
