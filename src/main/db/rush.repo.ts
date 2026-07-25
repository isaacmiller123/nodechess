import { getAppDb } from './database'
import type { RushRunInput, RushRunRow, RushBest, RushMode, RushEndReason } from '../../shared/types'

// ============================================================================
// SLICE B: Puzzle Rush / Storm persistence.  ★ OWNED BY THE RUSH BUILDER ★
//
// All SQL for the timed modes lives here, against `puzzle_rush_run` (added in
// migration user_version=5). One row = one finished run. The renderer logs the
// per-puzzle attempts separately via puzzles:attempt (mode:'rush'), which keeps
// those off the Glicko ladder; this table is the run-level high-score record.
//
//   puzzle_rush_run(id, mode, score, solved, missed, best_streak, top_rating,
//                   duration_ms, ended_reason, created_at)
//   idx_rush_score   (mode, score DESC):    leaderboard / personal-best reads
//   idx_rush_created (created_at DESC):      history reads
// ============================================================================

const RUSH_MODES: readonly RushMode[] = ['rush3', 'rush5', 'storm', 'survival']

/** A raw DB row (snake_case, integers). Mapped to the camelCase RushRunRow. */
interface RushRow {
  id: number
  mode: string
  score: number
  solved: number
  missed: number
  best_streak: number
  top_rating: number | null
  duration_ms: number
  ended_reason: string | null
  created_at: number
}

function toRushRunRow(r: RushRow): RushRunRow {
  return {
    id: r.id,
    mode: r.mode as RushMode,
    score: r.score,
    solved: r.solved,
    missed: r.missed,
    bestStreak: r.best_streak,
    topRating: r.top_rating ?? null,
    durationMs: r.duration_ms,
    endedReason: (r.ended_reason as RushEndReason | null) ?? null,
    createdAt: r.created_at
  }
}

/**
 * Persist one finished Rush/Storm run and report the personal best for its mode.
 * `isBest` is computed against the PRIOR best (before this row is inserted), so a
 * tie with the existing best is not a new best. The returned `best` is the best
 * across all runs of that mode including the one just saved.
 */
export function saveRushRun(input: RushRunInput): { id: number; best: number; isBest: boolean } {
  const db = getAppDb()

  // Prior best for this mode (NULL -> 0) BEFORE inserting the new run.
  const priorRow = db
    .prepare('SELECT MAX(score) AS best FROM puzzle_rush_run WHERE mode=?')
    .get(input.mode) as { best: number | null } | undefined
  const prior = priorRow?.best ?? 0

  const res = db
    .prepare(
      `INSERT INTO puzzle_rush_run
        (mode, score, solved, missed, best_streak, top_rating, duration_ms, ended_reason, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.mode,
      input.score,
      input.solved,
      input.missed,
      input.bestStreak,
      input.topRating ?? null,
      input.durationMs,
      input.endedReason,
      Date.now()
    )

  const isBest = input.score > prior
  const best = Math.max(prior, input.score)
  return { id: Number(res.lastInsertRowid), best, isBest }
}

/**
 * Recent runs, newest first. Optionally filtered to one mode. `limit` is clamped
 * to a sane range so a bad payload can't pull the whole table.
 */
export function listRushRuns(opts?: { mode?: RushMode; limit?: number }): RushRunRow[] {
  const db = getAppDb()
  const limit = Math.max(1, Math.min(100, Math.floor(opts?.limit ?? 20)))
  const rows = opts?.mode
    ? (db
        .prepare('SELECT * FROM puzzle_rush_run WHERE mode=? ORDER BY created_at DESC LIMIT ?')
        .all(opts.mode, limit) as unknown as RushRow[])
    : (db
        .prepare('SELECT * FROM puzzle_rush_run ORDER BY created_at DESC LIMIT ?')
        .all(limit) as unknown as RushRow[])
  return rows.map(toRushRunRow)
}

/**
 * Personal-best summary per mode: MAX(score), run COUNT, and the most recent
 * run's score. Always returns one row per known mode (zeroed when never played)
 * so the leaderboard renders a complete, stable grid.
 */
export function rushBests(): RushBest[] {
  const db = getAppDb()
  const agg = db
    .prepare(
      `SELECT mode,
              MAX(score) AS best,
              COUNT(*)   AS runs
         FROM puzzle_rush_run
        GROUP BY mode`
    )
    .all() as { mode: string; best: number | null; runs: number }[]

  // Most-recent score per mode (the row with the greatest created_at).
  const lastRows = db
    .prepare(
      `SELECT r.mode AS mode, r.score AS score
         FROM puzzle_rush_run r
         JOIN (SELECT mode, MAX(created_at) AS mx FROM puzzle_rush_run GROUP BY mode) m
           ON m.mode = r.mode AND m.mx = r.created_at
        GROUP BY r.mode`
    )
    .all() as { mode: string; score: number }[]

  const byMode = new Map(agg.map((a) => [a.mode, a]))
  const lastByMode = new Map(lastRows.map((l) => [l.mode, l.score]))

  return RUSH_MODES.map((mode) => {
    const a = byMode.get(mode)
    return {
      mode,
      best: a?.best ?? 0,
      runs: a?.runs ?? 0,
      lastScore: lastByMode.has(mode) ? (lastByMode.get(mode) as number) : null
    }
  })
}
