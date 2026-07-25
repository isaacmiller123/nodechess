import { z } from 'zod'
import { handle } from './util'
import { explainMove, positional } from '../coach'

/**
 * LOCAL coaching IPC (architecture §4: coach domain). No engine call, no LLM,
 * no network: pure functions over a FEN + the engine eval/PV supplied by the
 * caller. Registered via the shared handle() helper (origin + zod gated).
 *
 * Channels:
 *   coach:explainMove  {fenBefore, played, best, pv, evalBefore, evalAfter, ply?}
 *                      -> {verdict, motifs:string[], text}
 *   coach:positional   {fen} -> {terms:string[], text}
 */

const engineEvalSchema = z
  .object({
    cp: z.number().nullable().optional(),
    mate: z.number().int().nullable().optional()
  })
  .strict()

export function registerCoach(): void {
  handle(
    'coach:explainMove',
    // Wire bounds (mirroring server/review.ts): the web bridge serves this
    // channel to anonymous callers, so strings and the PV are capped. The
    // caps sit far above legit use (FEN ≤~90 chars, UCI ≤5). CoachHint
    // forwards the RAW engine principal variation, which can run deep, so pv
    // is bounded well above any real search depth rather than at a tight
    // guess. Any low-thousands cap already defeats the mutex-stall DoS.
    z
      .object({
        fenBefore: z.string().min(1).max(128),
        played: z.string().min(1).max(8),
        best: z.string().min(1).max(8),
        pv: z.array(z.string().max(8)).max(256).default([]),
        evalBefore: engineEvalSchema,
        evalAfter: engineEvalSchema,
        ply: z.number().int().optional()
      })
      .strict(),
    (args) =>
      explainMove({
        fenBefore: args.fenBefore,
        played: args.played,
        best: args.best,
        pv: args.pv,
        evalBefore: args.evalBefore,
        evalAfter: args.evalAfter,
        ply: args.ply
      })
  )

  handle('coach:positional', z.object({ fen: z.string().min(1).max(128) }).strict(), ({ fen }) =>
    positional({ fen })
  )
}
