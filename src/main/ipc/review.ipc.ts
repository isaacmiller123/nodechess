import { type WebContents } from 'electron'
import { z } from 'zod'
import { handle } from './util'
import { getGame, setGameAccuracy } from '../db/games.repo'
import { runReview, getCachedReview, movesFromPgn } from '../review/review'
import { estimateElo } from '../analysis/estElo'

// review:run accepts either a stored gameId (PGN pulled from the game row) or a raw
// pgn. It streams review:progress {gameId|null, ply, total} to the calling sender,
// then resolves with the full review. review:get returns the cached review.
// perf:estimate maps a gameId (cached accuracy) or a raw accuracy to an Elo band.

const runSchema = z
  .object({
    gameId: z.number().int().optional(),
    pgn: z.string().min(1).optional(),
    depth: z.number().int().min(6).max(30).optional()
  })
  .strict()
  .refine((v) => v.gameId !== undefined || v.pgn !== undefined, {
    message: 'review:run requires gameId or pgn'
  })

// Only one review at a time (single shared review engine, heavy CPU).
let reviewing = false
// Abort handle for the in-flight review, so review:cancel can actually stop it.
let reviewAbort: AbortController | null = null

export function registerReview(): void {
  handle('review:run', runSchema, async ({ gameId, pgn, depth }, e) => {
    if (reviewing) throw new Error('review:run: a review is already in progress')

    // Resolve the PGN source.
    let pgnText = pgn
    let resolvedGameId: number | null = gameId ?? null
    if (pgnText === undefined && gameId !== undefined) {
      const game = getGame(gameId)
      if (!game) throw new Error(`review:run: game ${gameId} not found`)
      // getGame is unfiltered (unlike listGames). A non-chess row's archive is
      // the generic wire codec, not PGN. Reject with a clear error instead of
      // the misleading "PGN has no mainline moves" the parser would produce.
      if (game.game_kind !== 'chess') {
        throw new Error(
          `review:run: game ${gameId} is a '${game.game_kind}' game: the chess review engine only reviews standard chess`
        )
      }
      pgnText = game.pgn
    }
    if (pgnText === undefined) throw new Error('review:run: no PGN to review')

    const moves = movesFromPgn(pgnText)
    if (moves.length === 0) throw new Error('review:run: PGN has no mainline moves')

    const sender: WebContents = e.sender
    reviewing = true
    const abort = new AbortController()
    reviewAbort = abort
    try {
      const review = await runReview({
        moves,
        depth,
        gameId: resolvedGameId ?? undefined,
        signal: abort.signal,
        onProgress: (ply, total) => {
          if (!sender.isDestroyed()) {
            sender.send('review:progress', { gameId: resolvedGameId, ply, total })
          }
        }
      })
      // Persist per-side accuracy onto the game row so the Progress "accuracy"
      // column populates (only meaningful when reviewing a stored game).
      if (resolvedGameId != null) {
        setGameAccuracy(resolvedGameId, review.white.accuracy, review.black.accuracy)
      }
      return { reviewId: resolvedGameId, review }
    } finally {
      // The single-flight flag clears ONLY when the run settles (including an
      // aborted one): never out-of-band, so two reviews can never overlap on
      // the shared engine.
      reviewing = false
      if (reviewAbort === abort) reviewAbort = null
    }
  })

  handle('review:get', z.object({ gameId: z.number().int() }).strict(), ({ gameId }) => {
    const cached = getCachedReview(gameId)
    if (!cached) return { review: null, moveEvals: [] }
    return { review: cached.review, moveEvals: cached.moveEvals }
  })

  handle(
    'perf:estimate',
    z
      .object({
        gameId: z.number().int().optional(),
        accuracy: z.number().min(0).max(100).optional()
      })
      .strict()
      .refine((v) => v.gameId !== undefined || v.accuracy !== undefined, {
        message: 'perf:estimate requires gameId or accuracy'
      }),
    ({ gameId, accuracy }) => {
      // Direct accuracy estimate.
      if (accuracy !== undefined) {
        const band = estimateElo(accuracy)
        return { est: band.est, low: band.low, high: band.high, accuracy: band.accuracy }
      }
      // Cached-game estimate: the user only played ONE side, so averaging both
      // accuracies is meaningless for a lopsided game (e.g. 2200 vs 900). Derive
      // the user's color from the game row and estimate from THAT side alone.
      const cached = getCachedReview(gameId as number)
      if (!cached) throw new Error(`perf:estimate: no cached review for game ${gameId}`)
      const { white, black } = cached.review
      const userColor = getGame(gameId as number)?.user_color
      // Prefer the user's side; fall back to whichever side actually has moves.
      const side =
        userColor === 'black'
          ? black
          : userColor === 'white'
            ? white
            : white.moves > 0
              ? white
              : black
      // Blend the side's ACPL in: accuracy anchors alone overrate short games.
      const band = estimateElo(side.accuracy, Math.max(1, side.moves), side.acpl)
      return { est: band.est, low: band.low, high: band.high, accuracy: band.accuracy }
    }
  )

  // Cancel the in-flight review, if any: aborts the run (runReview checks the
  // signal between searches and stops the current one). The `reviewing` flag is
  // released by the run's own finally when it settles. Clearing it here would
  // let a second review race the aborted one on the same engine. A dead/stuck
  // engine can't wedge the flag either: analyzeFen's hard timeout settles it.
  handle('review:cancel', z.object({}).strict(), () => {
    reviewAbort?.abort()
    return { ok: true }
  })
}
