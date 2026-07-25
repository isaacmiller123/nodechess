import { z } from 'zod'
import { handle } from './util'
import { batchPuzzles, getPuzzle, listThemes, nextPuzzle, solvedPuzzleIds } from '../db/puzzles.repo'
import { applyPuzzleResult } from '../db/ratings.repo'
import { getAppDb, hasPuzzlesDb } from '../db/database'

export function registerPuzzles(): void {
  // Wire bounds on the public puzzle channels (the web bridge serves them to
  // anonymous callers): `exclude` feeds a placeholder-expanded SQL IN clause,
  // so it is capped far above the renderer's own session cap (≤400 ids) but
  // far below anything that could balloon the query. Lichess puzzle ids are
  // 5-6 chars; theme keys a couple dozen.
  handle(
    'puzzles:next',
    z
      .object({
        theme: z.string().max(64).optional(),
        ratingLo: z.number().int().optional(),
        ratingHi: z.number().int().optional(),
        exclude: z.array(z.string().max(32)).max(2048).optional()
      })
      .strict(),
    ({ theme, ratingLo, ratingHi, exclude }) => {
      // No puzzle DB yet (lean install before import): degrade to empty so the UI
      // shows its "import datasets" state instead of erroring.
      if (!hasPuzzlesDb()) return { puzzle: null }
      return {
        puzzle: nextPuzzle({ theme, ratingLo: ratingLo ?? 600, ratingHi: ratingHi ?? 2200, exclude })
      }
    }
  )

  handle('puzzles:get', z.object({ puzzleId: z.string() }).strict(), ({ puzzleId }) =>
    hasPuzzlesDb() ? { puzzle: getPuzzle(puzzleId) } : { puzzle: null }
  )

  handle('puzzles:themes', z.object({}).strict(), () =>
    hasPuzzlesDb() ? { themes: listThemes() } : { themes: [] }
  )

  // Bulk fetch (slice A custom sets + slice B Rush/Storm streaming). Degrades to
  // an empty list when the puzzle DB is not yet imported.
  handle(
    'puzzles:batch',
    z
      .object({
        // Cap ABOVE the full theme catalog (73 today): the desktop Custom
        // trainer lets a user toggle every theme individually with no cap of
        // its own, so this must never reject a full selection.
        themes: z.array(z.string().max(64)).max(256).optional(),
        ratingLo: z.number().int().optional(),
        ratingHi: z.number().int().optional(),
        count: z.number().int().min(1).max(200),
        exclude: z.array(z.string().max(32)).max(2048).optional(),
        ascending: z.boolean().optional(),
        // Custom-training filters (slice A).
        length: z.enum(['short', 'medium', 'long', 'any']).optional(),
        minPopularity: z.number().int().optional(),
        excludeSolved: z.boolean().optional()
      })
      .strict(),
    ({ themes, ratingLo, ratingHi, count, exclude, ascending, length, minPopularity, excludeSolved }) => {
      if (!hasPuzzlesDb()) return { puzzles: [] }
      // "Exclude solved" is a cross-database filter: solved ids live in the
      // writable app DB (puzzle_attempt), the puzzles live in the read-only
      // puzzles DB. Merge the solved ids into `exclude` so the single batch query
      // skips them without a join across the two connections.
      const merged = excludeSolved
        ? Array.from(new Set([...(exclude ?? []), ...solvedPuzzleIds()]))
        : exclude
      return {
        puzzles: batchPuzzles({
          themes,
          ratingLo: ratingLo ?? 600,
          ratingHi: ratingHi ?? 2200,
          count,
          exclude: merged,
          ascending,
          // 'any' means "no length filter". Pass through undefined so the repo
          // skips the clause rather than building an impossible bound.
          length: length === 'any' ? undefined : length,
          minPopularity
        })
      }
    }
  )

  handle(
    'puzzles:attempt',
    z
      .object({
        puzzleId: z.string(),
        puzzleRating: z.number().int(),
        solved: z.boolean(),
        ms: z.number().int().optional(),
        // Slice A/C: tag the attempt for per-theme stats + mode-scoped history.
        theme: z.string().optional(),
        mode: z.enum(['train', 'custom', 'rush', 'daily']).optional()
      })
      .strict(),
    ({ puzzleId, puzzleRating, solved, ms, theme, mode }) => {
      const m = mode ?? 'train'
      // PuzzleMode contract (shared/types.ts): only 'train'/'daily' move the
      // Glicko ladder. 'rush' keeps a separate high-score record and 'custom'
      // drilling must not tank the real rating, so both leave it untouched.
      const affectsRating = m === 'train' || m === 'daily'
      const res = affectsRating
        ? applyPuzzleResult(puzzleRating, solved)
        : null
      const before = res ? res.before.rating : null
      const after = res ? res.after.rating : null
      getAppDb()
        .prepare(
          'INSERT INTO puzzle_attempt(puzzle_id,solved,ms,rating_before,rating_after,created_at,theme,mode) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run(puzzleId, solved ? 1 : 0, ms ?? null, before, after, Date.now(), theme ?? null, m)
      if (res) {
        return {
          ratingAfter: Math.round(res.after.rating),
          rd: Math.round(res.after.rd),
          delta: res.delta
        }
      }
      // Rush/custom: no rating change. Echo the puzzle rating so callers stay typed.
      return { ratingAfter: puzzleRating, rd: 0, delta: 0 }
    }
  )
}
