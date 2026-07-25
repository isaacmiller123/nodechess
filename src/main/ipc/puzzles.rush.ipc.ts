import { z } from 'zod'
import { handle } from './util'
import type { RushRunRow, RushBest } from '../../shared/types'
import { saveRushRun, listRushRuns, rushBests } from '../db/rush.repo'

// ============================================================================
// SLICE B: Puzzle Rush / Storm persistence.  ★ OWNED BY THE RUSH BUILDER ★
//
// Channels (already mirrored in preload + Api.puzzles):
//   puzzles:saveRush   RushRunInput              -> { id, best, isBest }
//   puzzles:rushRuns   { mode?, limit? }         -> { runs: RushRunRow[] }
//   puzzles:rushBests  {}                        -> { bests: RushBest[] }
//
// All SQL lives in ../db/rush.repo.ts (saveRushRun / listRushRuns / rushBests).
// Per-puzzle attempts during a run are logged via puzzles:attempt with
// mode:'rush' (that path intentionally does NOT move the Glicko rating). saveRush
// computes isBest by comparing `score` to the prior MAX(score) for that mode.
// ============================================================================

const RUSH_MODES = ['rush3', 'rush5', 'storm', 'survival'] as const

export function registerPuzzlesRush(): void {
  handle(
    'puzzles:saveRush',
    z
      .object({
        mode: z.enum(RUSH_MODES),
        score: z.number().int().min(0),
        solved: z.number().int().min(0),
        missed: z.number().int().min(0),
        bestStreak: z.number().int().min(0),
        topRating: z.number().int().optional(),
        durationMs: z.number().int().min(0),
        endedReason: z.enum(['time', 'lives', 'quit', 'cleared'])
      })
      .strict(),
    (req): { id: number; best: number; isBest: boolean } => saveRushRun(req)
  )

  handle(
    'puzzles:rushRuns',
    z
      .object({
        mode: z.enum(RUSH_MODES).optional(),
        limit: z.number().int().min(1).max(100).optional()
      })
      .strict(),
    (req): { runs: RushRunRow[] } => ({ runs: listRushRuns(req) })
  )

  handle('puzzles:rushBests', z.object({}).strict(), (): { bests: RushBest[] } => ({
    bests: rushBests()
  }))
}
