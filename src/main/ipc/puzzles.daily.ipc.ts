import { z } from 'zod'
import { handle } from './util'
import {
  dailyPuzzle,
  recordDaily,
  dailyStreak,
  puzzleStats,
  puzzleHistory
} from '../db/daily.repo'
import type {
  DailyPuzzle,
  DailyStreak,
  PuzzleStats,
  PuzzleHistoryRow
} from '../../shared/types'

// ============================================================================
// SLICE C: Daily puzzle + streaks + stats/history.  ★ OWNED BY THE DAILY BUILDER ★
//
// Thin IPC layer: validate the payload (handle() already origin-checks +
// zod-validates) and delegate to src/main/db/daily.repo.ts, which owns all SQL
// and the deterministic-daily / streak / stats derivation.
//
// Tables (all exist after migration user_version=5):
//   - daily_result(ymd PK, puzzle_id, solved, first_try, ms, created_at)
//   - puzzle_attempt(..., theme, mode)   ← source for stats + history
//
// Channels (already mirrored in preload + Api.puzzles):
//   puzzles:daily        { ymd? }                  -> DailyPuzzle
//   puzzles:recordDaily  { ymd, puzzleId, solved, firstTry, ms? } -> { streak }
//   puzzles:dailyStreak  {}                        -> { streak }
//   puzzles:stats        {}                        -> PuzzleStats
//   puzzles:history      { limit?, offset?, mode? }-> { rows: PuzzleHistoryRow[] }
// ============================================================================

export function registerPuzzlesDaily(): void {
  handle(
    'puzzles:daily',
    z.object({ ymd: z.string().optional() }).strict(),
    (req): DailyPuzzle => dailyPuzzle(req.ymd)
  )

  handle(
    'puzzles:recordDaily',
    z
      .object({
        ymd: z.string(),
        puzzleId: z.string(),
        solved: z.boolean(),
        firstTry: z.boolean(),
        ms: z.number().int().optional()
      })
      .strict(),
    (req): { streak: DailyStreak } => recordDaily(req)
  )

  handle('puzzles:dailyStreak', z.object({}).strict(), (): { streak: DailyStreak } => ({
    streak: dailyStreak()
  }))

  handle('puzzles:stats', z.object({}).strict(), (): PuzzleStats => puzzleStats())

  handle(
    'puzzles:history',
    z
      .object({
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
        mode: z.enum(['train', 'custom', 'rush', 'daily']).optional()
      })
      .strict(),
    (req): { rows: PuzzleHistoryRow[] } => ({ rows: puzzleHistory(req) })
  )
}
