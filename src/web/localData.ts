// The local data layer — the browser's copy of the desktop's writable app DB.
//
// The web build has no server and no account database, so EVERYTHING the user
// accumulates lives here, in localStorage with an in-memory fallback
// (private-mode / quota failures must degrade to session-lifetime storage,
// never crash):
//   - the game archive        (desktop `game` table)
//   - custom variants         (desktop `custom_variant` table)
//   - settings                (key prefix only; logic stays in webApi.ts)
//   - Glicko-2 ratings        puzzle + vs-bot, seeded 1200/350/0.06 and updated
//     with the SAME pure math as the desktop (src/main/db/ratings.repo.ts →
//     src/main/rating/glicko2.ts)
//   - puzzle attempt history, daily-puzzle results and Rush runs (the
//     puzzle_attempt / daily_result / puzzle_rush_run tables), each capped so a
//     long-lived browser profile cannot outgrow its storage quota
//
// The rows are capped where the desktop's are unbounded; every read below says
// which cap it lives under. Nothing here is synthesised: an empty store reads
// as an empty store.

import type {
  CustomVariantRow,
  DailyResult,
  DailyStreak,
  GameRow,
  PuzzleHistoryRow,
  PuzzleMode,
  PuzzleStats,
  RushBest,
  RushMode,
  RushRunInput,
  RushRunRow,
  ThemeStat
} from '@shared/types'
import { glicko2Update, type Glicko } from '../main/rating/glicko2'

// ---- storage primitives ---------------------------------------------------------

const memoryFallback = new Map<string, string>()

export function storageGet(key: string): string | null {
  try {
    const v = window.localStorage.getItem(key)
    // A value written to memoryFallback (setItem threw on quota) still reads
    // back as null from localStorage — fall through to memory so those writes
    // are never invisible (the signup import enumerates memory keys too).
    if (v !== null) return v
    return memoryFallback.get(key) ?? null
  } catch {
    return memoryFallback.get(key) ?? null
  }
}

export function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    memoryFallback.set(key, value)
  }
}

export function storageRemove(key: string): void {
  memoryFallback.delete(key)
  try {
    window.localStorage.removeItem(key)
  } catch {
    // memory copy already gone
  }
}

// These localStorage keys keep their pre-rebrand prefix. They address data
// already sitting in browsers that have used the web app; renaming the prefix
// does not migrate that data, it orphans it — settings, saved games, ratings and
// puzzle history would all come back empty on the next visit. A rename has to
// ship as a read-old/write-new migration, not as a string edit.
export const SETTING_PREFIX = 'chess-sharp.setting.'
const VARIANTS_KEY = 'chess-sharp.customVariants'
const GAMES_KEY = 'chess-sharp.games'
const RATING_PREFIX = 'chess-sharp.rating.'
const ATTEMPTS_KEY = 'chess-sharp.puzzleAttempts'
const DAILY_KEY = 'chess-sharp.puzzleDaily'
const RUSH_KEY = 'chess-sharp.puzzleRush'

/** Setting keys (without the prefix) present in local storage — the signup
 *  import (migrate.ts) enumerates these to copy them into a fresh account. */
export function listLocalSettingKeys(): string[] {
  const keys = new Set<string>()
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (k && k.startsWith(SETTING_PREFIX)) keys.add(k.slice(SETTING_PREFIX.length))
    }
  } catch {
    // storage unavailable — the memory fallback below still answers
  }
  for (const k of memoryFallback.keys()) {
    if (k.startsWith(SETTING_PREFIX)) keys.add(k.slice(SETTING_PREFIX.length))
  }
  return [...keys]
}

// ---- Local game archive (W1, unchanged semantics) --------------------------------
// Browser-resident stand-in for the desktop `game` table: finished OTB/online
// games land in the Library/Home lists instead of silently vanishing.
// Newest-first, capped so localStorage quota can't overflow (~2 KB/game).

export const GAMES_CAP = 500

export interface StoredGames {
  seq: number
  rows: GameRow[]
}

export function readGames(): StoredGames {
  const raw = storageGet(GAMES_KEY)
  if (!raw) return { seq: 0, rows: [] }
  try {
    const parsed = JSON.parse(raw) as StoredGames
    return { seq: parsed.seq ?? 0, rows: Array.isArray(parsed.rows) ? parsed.rows : [] }
  } catch {
    return { seq: 0, rows: [] }
  }
}

export function writeGames(store: StoredGames): void {
  storageSet(GAMES_KEY, JSON.stringify(store))
}

/** Mirror of desktop games.repo.setGameAccuracy: persist per-side review
 *  accuracy onto the archived row (Progress "accuracy" column). No-op when the
 *  row is gone (evicted past the cap). */
export function setLocalGameAccuracy(gameId: number, white: number, black: number): void {
  const store = readGames()
  const row = store.rows.find((g) => g.id === gameId)
  if (!row) return
  row.accuracy_white = white
  row.accuracy_black = black
  writeGames(store)
}

export function clearLocalGames(): void {
  storageRemove(GAMES_KEY)
}

// ---- Custom variants (W1, unchanged semantics) ------------------------------------

export function readVariants(): Record<string, CustomVariantRow> {
  const raw = storageGet(VARIANTS_KEY)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, CustomVariantRow>
  } catch {
    return {}
  }
}

export function writeVariants(map: Record<string, CustomVariantRow>): void {
  storageSet(VARIANTS_KEY, JSON.stringify(map))
}

// ---- Local Glicko-2 ratings (new in W3) --------------------------------------------
// Byte-for-byte the desktop math: db/ratings.repo.ts applies glicko2Update with
// opponent rd 50 / tau 0.3 for puzzles and rd 60 / tau 0.5 for vs-bot games,
// from the migration seed 1200/350/0.06. Attempt/solve counters ride along so
// the logged-out progress summary reports real local numbers.

export type LocalRatingKind = 'puzzle' | 'vs-bot'

export interface LocalRatingRecord extends Glicko {
  attempts: number
  solved: number
  lastAt: number | null
}

/** Desktop parity: getRating's unseeded default (db/ratings.repo.ts). */
export const RATING_SEED: Glicko = { rating: 1200, rd: 350, vol: 0.06 }

const num = (v: unknown, dflt: number): number => (typeof v === 'number' ? v : dflt)

export function readLocalRating(kind: LocalRatingKind): LocalRatingRecord {
  const raw = storageGet(RATING_PREFIX + kind)
  const seed: LocalRatingRecord = { ...RATING_SEED, attempts: 0, solved: 0, lastAt: null }
  if (!raw) return seed
  try {
    const p = JSON.parse(raw) as Partial<LocalRatingRecord>
    return {
      rating: num(p.rating, seed.rating),
      rd: num(p.rd, seed.rd),
      vol: num(p.vol, seed.vol),
      attempts: num(p.attempts, 0),
      solved: num(p.solved, 0),
      lastAt: typeof p.lastAt === 'number' ? p.lastAt : null
    }
  } catch {
    return seed
  }
}

function writeLocalRating(kind: LocalRatingKind, rec: LocalRatingRecord): void {
  storageSet(RATING_PREFIX + kind, JSON.stringify(rec))
}

export function resetLocalRating(kind: LocalRatingKind): void {
  storageRemove(RATING_PREFIX + kind)
}

/** Mirror of the desktop puzzles:attempt handler (ipc/puzzles.ipc.ts): only
 *  'train'/'daily' move the Glicko ladder; 'rush'/'custom' record the attempt
 *  but echo the puzzle rating with rd/delta 0. Returns the exact
 *  PuzzleAttemptResult shape (rounded like the desktop), and files the attempt
 *  in the history the stats/history views read. */
export function recordLocalPuzzleAttempt(req: {
  puzzleId: string
  puzzleRating: number
  solved: boolean
  ms?: number
  theme?: string
  mode?: PuzzleMode
}): { ratingAfter: number; rd: number; delta: number } {
  const mode = req.mode ?? 'train'
  const rec = readLocalRating('puzzle')
  const affectsRating = mode === 'train' || mode === 'daily'
  const after = affectsRating
    ? glicko2Update(rec, [{ rating: req.puzzleRating, rd: 50, score: req.solved ? 1 : 0 }], 0.3)
    : null
  writeLocalRating('puzzle', {
    rating: after?.rating ?? rec.rating,
    rd: after?.rd ?? rec.rd,
    vol: after?.vol ?? rec.vol,
    attempts: rec.attempts + 1,
    solved: rec.solved + (req.solved ? 1 : 0),
    lastAt: Date.now()
  })

  appendAttempt({
    puzzleId: req.puzzleId,
    solved: req.solved,
    ms: req.ms ?? null,
    // Desktop stores the rating on both sides of a rated attempt and leaves
    // them null for the unrated modes.
    ratingBefore: after ? Math.round(rec.rating) : null,
    ratingAfter: after ? Math.round(after.rating) : null,
    theme: req.theme ?? null,
    mode,
    createdAt: Date.now()
  })

  if (after) {
    return {
      ratingAfter: Math.round(after.rating),
      rd: Math.round(after.rd),
      delta: Math.round(after.rating - rec.rating)
    }
  }
  return { ratingAfter: req.puzzleRating, rd: 0, delta: 0 }
}

/** Mirror of desktop ratings.repo.applyGameResult (called by games:reportResult
 *  AFTER the nominal→measured Elo mapping, which the caller performs). */
export function recordLocalGameResult(
  ratedElo: number,
  score: number
): { ratingAfter: number; delta: number } {
  const rec = readLocalRating('vs-bot')
  const after = glicko2Update(rec, [{ rating: ratedElo, rd: 60, score }], 0.5)
  writeLocalRating('vs-bot', {
    rating: after.rating,
    rd: after.rd,
    vol: after.vol,
    attempts: rec.attempts + 1,
    solved: rec.solved,
    lastAt: Date.now()
  })
  return { ratingAfter: Math.round(after.rating), delta: Math.round(after.rating - rec.rating) }
}

// ---- LOCAL day keys ----------------------------------------------------------
// Copied from src/main/db/daily.repo.ts, which is the contract: the daily and
// every streak are keyed to the user's LOCAL calendar day, so "today" flips at
// the user's own midnight (a UTC key breaks streaks west of UTC). Keep in step.

function ymdFromMs(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Today's LOCAL day key. */
export function todayYmd(): string {
  return ymdFromMs(Date.now())
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/** Validate + normalise a caller-supplied ymd; falls back to today when absent
 *  or malformed. */
export function normalizeYmd(ymd?: string): string {
  if (ymd && YMD_RE.test(ymd)) {
    const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10))
    const dt = new Date(y, m - 1, d)
    // Round-trip so '2026-02-31' cannot address a day that does not exist.
    if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) return ymd
  }
  return todayYmd()
}

/** The LOCAL day before `ymd`, parsed as local midnight so the walk-back
 *  respects the user's calendar (incl. DST shifts). */
function prevYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() - 1)
  return ymdFromMs(dt.getTime())
}

// ---- Puzzle attempt history (desktop `puzzle_attempt`) ----------------------
// The desktop table is unbounded and its stats are exact over all time. Here the
// newest ATTEMPT_CAP attempts are kept — enough for the 30-day sparkline, the
// per-theme bars and several pages of history, at roughly 60 KB of storage.
// `bestStreak` and the totals are therefore over the retained window; the
// all-time solved/attempted counters ride on the rating record instead and stay
// exact.

const ATTEMPT_CAP = 600
const STATS_THEME_LIMIT = 16
const STATS_DAILY_DAYS = 30

interface StoredAttempts {
  seq: number
  /** Newest first. */
  rows: PuzzleHistoryRow[]
}

function readAttempts(): StoredAttempts {
  const raw = storageGet(ATTEMPTS_KEY)
  if (!raw) return { seq: 0, rows: [] }
  try {
    const p = JSON.parse(raw) as StoredAttempts
    return { seq: p.seq ?? 0, rows: Array.isArray(p.rows) ? p.rows : [] }
  } catch {
    return { seq: 0, rows: [] }
  }
}

function appendAttempt(row: Omit<PuzzleHistoryRow, 'id'>): void {
  const store = readAttempts()
  const id = ++store.seq
  store.rows.unshift({ id, ...row })
  store.rows = store.rows.slice(0, ATTEMPT_CAP)
  storageSet(ATTEMPTS_KEY, JSON.stringify(store))
}

/** Paginated solve history, newest first (desktop daily.repo.puzzleHistory). */
export function localPuzzleHistory(opts?: {
  limit?: number
  offset?: number
  mode?: PuzzleMode
}): PuzzleHistoryRow[] {
  const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 50)))
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0))
  const rows = opts?.mode ? readAttempts().rows.filter((r) => r.mode === opts.mode) : readAttempts().rows
  return rows.slice(offset, offset + limit)
}

/** Aggregate + per-theme + per-day stats over the retained attempts, shaped
 *  exactly like daily.repo.puzzleStats (accuracy is a 0..1 fraction). */
export function localPuzzleStats(): PuzzleStats {
  const rows = readAttempts().rows
  const rec = readLocalRating('puzzle')
  // All-time counters from the rating record; everything below is over the
  // retained window, which is what the browser still has.
  const totalAttempts = rec.attempts
  const totalSolved = rec.solved

  // Best solved run. Rows are newest-first, so walk them in either direction —
  // the longest run is orientation-independent.
  let bestStreak = 0
  let run = 0
  for (const r of rows) {
    run = r.solved ? run + 1 : 0
    if (run > bestStreak) bestStreak = run
  }

  const themeAgg = new Map<string, { attempts: number; solved: number; msTotal: number; msCount: number }>()
  for (const r of rows) {
    if (!r.theme) continue // an untagged adaptive-train attempt has no single theme
    const agg = themeAgg.get(r.theme) ?? { attempts: 0, solved: 0, msTotal: 0, msCount: 0 }
    agg.attempts++
    if (r.solved) {
      agg.solved++
      if (r.ms != null) {
        agg.msTotal += r.ms
        agg.msCount++
      }
    }
    themeAgg.set(r.theme, agg)
  }
  const byTheme: ThemeStat[] = [...themeAgg.entries()]
    .map(([theme, a]) => ({
      theme,
      attempts: a.attempts,
      solved: a.solved,
      accuracy: a.attempts > 0 ? a.solved / a.attempts : 0,
      avgMs: a.msCount > 0 ? Math.round(a.msTotal / a.msCount) : null
    }))
    .sort((a, b) => b.attempts - a.attempts || a.theme.localeCompare(b.theme))
    .slice(0, STATS_THEME_LIMIT)

  // Dense per-day series, oldest first, so the sparkline reads left to right.
  const buckets = new Map<string, { attempts: number; solved: number }>()
  for (const r of rows) {
    const key = ymdFromMs(r.createdAt)
    const b = buckets.get(key) ?? { attempts: 0, solved: 0 }
    b.attempts++
    if (r.solved) b.solved++
    buckets.set(key, b)
  }
  const days: string[] = []
  let day = todayYmd()
  for (let i = 0; i < STATS_DAILY_DAYS; i++) {
    days.push(day)
    day = prevYmd(day)
  }
  days.reverse()
  const daily = days.map((ymd) => ({
    ymd,
    attempts: buckets.get(ymd)?.attempts ?? 0,
    solved: buckets.get(ymd)?.solved ?? 0
  }))

  return {
    totalAttempts,
    totalSolved,
    accuracy: totalAttempts > 0 ? totalSolved / totalAttempts : 0,
    bestStreak,
    byTheme,
    daily
  }
}

// ---- Daily-puzzle results + streak (desktop `daily_result`) -----------------

const DAILY_RECENT_DAYS = 35

function readDailyMap(): Record<string, DailyResult> {
  const raw = storageGet(DAILY_KEY)
  if (!raw) return {}
  try {
    const p = JSON.parse(raw) as Record<string, DailyResult>
    return p && typeof p === 'object' ? p : {}
  } catch {
    return {}
  }
}

/** This browser's outcome on a given day's daily puzzle, or null. */
export function readDailyResult(ymd: string): DailyResult | null {
  return readDailyMap()[ymd] ?? null
}

/** Record (or upgrade) a daily outcome, then report the recomputed streak.
 *  Desktop rules (daily.repo.recordDaily): the first write for a day wins the
 *  first_try flag, a later solve can upgrade a miss, and a solved day is never
 *  un-solved by a later attempt. */
export function recordLocalDaily(input: {
  ymd: string
  puzzleId: string
  solved: boolean
  firstTry: boolean
  ms?: number
}): { streak: DailyStreak } {
  const day = normalizeYmd(input.ymd)
  const map = readDailyMap()
  const existing = map[day]
  map[day] = existing
    ? {
        ymd: day,
        puzzleId: input.puzzleId,
        solved: existing.solved || input.solved,
        firstTry: existing.firstTry,
        ms: input.ms ?? existing.ms ?? null
      }
    : {
        ymd: day,
        puzzleId: input.puzzleId,
        solved: input.solved,
        firstTry: input.firstTry && input.solved,
        ms: input.ms ?? null
      }
  storageSet(DAILY_KEY, JSON.stringify(map))
  return { streak: localDailyStreak() }
}

/** Daily-streak summary (daily.repo.dailyStreak): current run ending today or
 *  yesterday, the best run ever, today's state, and a calendar strip. */
export function localDailyStreak(recentDays = DAILY_RECENT_DAYS): DailyStreak {
  const map = readDailyMap()
  const solvedSet = new Set(Object.values(map).filter((r) => r?.solved).map((r) => r.ymd))

  const today = todayYmd()
  const todaySolved = solvedSet.has(today)

  // A streak stays alive the day after until you miss: start from today when
  // it's solved, else from yesterday.
  let current = 0
  let cursor = todaySolved ? today : prevYmd(today)
  while (solvedSet.has(cursor)) {
    current++
    cursor = prevYmd(cursor)
  }

  let best = 0
  let run = 0
  let prev: string | null = null
  for (const ymd of [...solvedSet].sort()) {
    run = prev !== null && prevYmd(ymd) === prev ? run + 1 : 1
    if (run > best) best = run
    prev = ymd
  }
  best = Math.max(best, current)

  const recent: { ymd: string; solved: boolean }[] = []
  let day = today
  for (let i = 0; i < recentDays; i++) {
    recent.push({ ymd: day, solved: solvedSet.has(day) })
    day = prevYmd(day)
  }

  return { current, best, todaySolved, recent }
}

// ---- Rush / Storm runs (desktop `puzzle_rush_run`) --------------------------

const RUSH_MODES: readonly RushMode[] = ['rush3', 'rush5', 'storm', 'survival']
const RUSH_CAP = 200

interface StoredRush {
  seq: number
  /** Newest first. */
  runs: RushRunRow[]
}

function readRush(): StoredRush {
  const raw = storageGet(RUSH_KEY)
  if (!raw) return { seq: 0, runs: [] }
  try {
    const p = JSON.parse(raw) as StoredRush
    return { seq: p.seq ?? 0, runs: Array.isArray(p.runs) ? p.runs : [] }
  } catch {
    return { seq: 0, runs: [] }
  }
}

/** Persist a finished run and report the personal best for its mode. `isBest`
 *  is measured against the PRIOR best, so a tie is not a new best (rush.repo). */
export function saveLocalRushRun(input: RushRunInput): { id: number; best: number; isBest: boolean } {
  const store = readRush()
  const prior = store.runs
    .filter((r) => r.mode === input.mode)
    .reduce((max, r) => Math.max(max, r.score), 0)

  const id = ++store.seq
  store.runs.unshift({
    id,
    mode: input.mode,
    score: input.score,
    solved: input.solved,
    missed: input.missed,
    bestStreak: input.bestStreak,
    topRating: input.topRating ?? null,
    durationMs: input.durationMs,
    endedReason: input.endedReason,
    createdAt: Date.now()
  })
  store.runs = store.runs.slice(0, RUSH_CAP)
  storageSet(RUSH_KEY, JSON.stringify(store))

  return { id, best: Math.max(prior, input.score), isBest: input.score > prior }
}

/** Recent runs, newest first, optionally filtered to one mode. */
export function listLocalRushRuns(opts?: { mode?: RushMode; limit?: number }): RushRunRow[] {
  const limit = Math.max(1, Math.min(100, Math.floor(opts?.limit ?? 20)))
  const runs = readRush().runs
  return (opts?.mode ? runs.filter((r) => r.mode === opts.mode) : runs).slice(0, limit)
}

/** One row per known mode, zeroed when never played, so the leaderboard grid
 *  always renders complete (rush.repo.rushBests). */
export function localRushBests(): RushBest[] {
  const runs = readRush().runs
  return RUSH_MODES.map((mode) => {
    const mine = runs.filter((r) => r.mode === mode)
    return {
      mode,
      best: mine.reduce((max, r) => Math.max(max, r.score), 0),
      runs: mine.length,
      // runs are newest-first, so the head is the most recent run of the mode.
      lastScore: mine.length > 0 ? mine[0].score : null
    }
  })
}

/** app:resetProgress, 'puzzles' scope: the browser-side equivalent of wiping
 *  puzzle_attempt + daily_result + puzzle_rush_run. */
export function clearLocalPuzzleState(): void {
  storageRemove(ATTEMPTS_KEY)
  storageRemove(DAILY_KEY)
  storageRemove(RUSH_KEY)
}
