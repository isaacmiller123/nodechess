// Review persistence (build contract, shared decision 5): the web client
// computes full-game reviews in the browser (W2 engines) and stores them here;
// the server reuses src/main/review/review.ts's own save/load helpers (via the
// bridge bundle) so the cached rows are identical to the desktop's.
//
//   POST /api/review/save {gameId, review}  -> {ok:true}   (auth-only; 404 when
//                                              the game row does not exist in
//                                              the caller's DB)
//   GET  /api/review/:gameId                -> {review: GameReview | null}
//
// Saving also stamps the per-side accuracies onto the game row
// (games.repo.setGameAccuracy) so archive lists populate their accuracy column.

import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { Api } from './bridge'
import { requireUser, type AuthStore } from './auth'

// ---- GameReview wire schema (mirrors src/main/review/review.ts shapes) ------
// Unknown extra keys are stripped (not rejected): the client's review object may
// grow display-only fields; the persisted columns are exactly these.

const povEvalSchema = z.object({
  cp: z.number().nullable(),
  mate: z.number().nullable()
})

const sideSummarySchema = z.object({
  accuracy: z.number().min(0).max(100),
  acpl: z.number().min(0),
  moves: z.number().int().min(0),
  inaccuracies: z.number().int().min(0),
  mistakes: z.number().int().min(0),
  blunders: z.number().int().min(0),
  best: z.number().int().min(0)
})

const eloBandSchema = z.object({
  est: z.number(),
  low: z.number(),
  high: z.number(),
  accuracy: z.number(),
  kind: z.literal('estimate')
})

const moveEvalSchema = z.object({
  ply: z.number().int().min(1),
  color: z.enum(['white', 'black']),
  san: z.string().max(16),
  uci: z.string().max(8),
  fenBefore: z.string().max(128),
  fenAfter: z.string().max(128),
  bestUci: z.string().max(8),
  bestSan: z.string().max(16),
  bestPv: z.array(z.string().max(8)).max(64),
  secondUci: z.string().max(8).nullable(),
  bestEval: povEvalSchema,
  playedEval: povEvalSchema,
  winBefore: z.number(),
  winAfter: z.number(),
  accuracy: z.number(),
  cpLoss: z.number(),
  winChancesDrop: z.number(),
  verdict: z.enum(['blunder', 'mistake', 'inaccuracy', 'ok']),
  badge: z.enum([
    'Best',
    'Brilliant',
    'Great',
    'Excellent',
    'Good',
    'Book',
    'Forced',
    'Inaccuracy',
    'Mistake',
    'Miss',
    'Blunder'
  ]),
  comment: z.string().max(2000).optional(),
  isBest: z.boolean(),
  critical: z.boolean()
})

const gameReviewSchema = z.object({
  gameId: z.number().int().nullable(),
  depth: z.number().int().min(1).max(40),
  totalPlies: z.number().int().min(0),
  white: sideSummarySchema,
  black: sideSummarySchema,
  whiteElo: eloBandSchema,
  blackElo: eloBandSchema,
  moveEvals: z.array(moveEvalSchema).max(1024)
})

const saveSchema = z.object({
  gameId: z.number().int().min(1),
  review: gameReviewSchema
})

export function registerReviewRoutes(app: FastifyInstance, api: Api, auth: AuthStore): void {
  // Long games carry ~1 KB per ply of PV/comment data. Allow more than the
  // 1 MiB default for this one route.
  app.post('/api/review/save', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const user = requireUser(auth, req, reply)
    if (!user) return reply.code(401).send({ error: 'auth-required' })

    const parsed = saveSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid-payload' })
    const { gameId, review } = parsed.data

    const saved = await api.pool.withUserDb(api.pool.dirFor(user.id), () => {
      if (!api.bridge.getGame(gameId)) return false
      api.bridge.saveReviewCache(gameId, { ...review, gameId })
      api.bridge.setGameAccuracy(gameId, review.white.accuracy, review.black.accuracy)
      return true
    })
    if (!saved) return reply.code(404).send({ error: 'game-not-found' })
    return { ok: true }
  })

  app.get<{ Params: { gameId: string } }>('/api/review/:gameId', async (req, reply) => {
    const user = requireUser(auth, req, reply)
    if (!user) return reply.code(401).send({ error: 'auth-required' })

    const gameId = Number(req.params.gameId)
    if (!Number.isInteger(gameId) || gameId < 1) {
      return reply.code(400).send({ error: 'invalid-payload' })
    }

    const cached = await api.pool.withUserDb(api.pool.dirFor(user.id), () => {
      // Per-user DBs: make sure THIS user's cache tables exist before reading
      // (getCachedReview's internal init flag is process-wide, not per-DB).
      api.bridge.ensureReviewTables()
      return api.bridge.getCachedReview(gameId)
    })
    return { review: cached?.review ?? null }
  })
}
