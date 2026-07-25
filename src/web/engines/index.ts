// Web engine layer: the W2 implementation of the `Api` engine/review/perf
// surfaces over browser WASM (docs/WEB-PORT-SPEC.md §Engines).
//
// CONTRACT FILE: src/web/webApi.ts consumes exactly these exports; the engine
// implementation lives behind them (workers, UCI shims, pools). Assets are
// served same-origin under /engines/ (vite.web.config.ts static copy) so COEP
// require-corp is satisfied; SharedArrayBuffer is available (COOP/COEP set by
// both the dev server and server/index.ts).
//
// Implementation map (see each module's header for the desktop file it ports):
//   engineApi.ts   engine.*: analyze/stop/play (incl. the calibrated sub-1320
//                  weak model in weakPlay.ts), playVariant/evalVariant on
//                  Fairy-Stockfish, honest desktop-only go/maia rejections.
//   review.ts      client-side game review + perf.estimate (accuracy.ts and
//                  estElo.ts imported directly from src/main: electron-free).
//   personaMove.ts style-weighted persona selection on the play instance.
//   pools.ts       the two logical Stockfish instances + fairy pool + the
//                  FIFO chains every consumer shares.

import type { Api, GameReview, ReviewMoveEval } from '@shared/types'
import { buildDebriefEnrich, type SchoolDebriefReq } from './debrief'
import { buildEngineApi } from './engineApi'
import { buildPersonaMove } from './personaMove'
import { buildPerfApi, buildReviewApi } from './review'

/** What the engine layer needs from the surrounding webApi. */
export interface WebEngineDeps {
  /** Resolve a saved custom variant's variants.ini text ('custom-<id>' kinds). */
  getCustomVariantIni(id: string): Promise<string | null>
}

/** Where finished reviews persist (localStorage logged-out, HTTP logged-in). */
export interface ReviewStore {
  save(
    gameId: number | null,
    review: GameReview
  ): Promise<{ reviewId: number | null }>
  load(gameId: number): Promise<{ review: GameReview | null; moveEvals: ReviewMoveEval[] }>
  /** Optional: mirror desktop's setGameAccuracy after a gameId review. */
  markAccuracy?(gameId: number, white: number, black: number): Promise<void>
}

/** The full engine namespace (analyze/play/playVariant/evalVariant/status/
 *  newGame/stop/onLine/onBestmove + the desktop-only go rejections). */
export function createEngineApi(deps: WebEngineDeps): Api['engine'] {
  return buildEngineApi(deps)
}

/** Client-side game review over the WASM analysis pool + the pure
 *  accuracy.ts classifier, persisting through the injected store. */
export function createReviewApi(store: ReviewStore): Api['review'] {
  return buildReviewApi(store)
}

/** perf.estimate: pure estElo over review accuracy (no engine needed). */
export function createPerfApi(store: ReviewStore): Api['perf'] {
  return buildPerfApi(store)
}

/** personas.move. Style-weighted MultiPV selection client-side. */
export function createPersonaMove(): Api['personas']['move'] {
  return buildPersonaMove()
}

/** School debrief eval enrichment: viktor.ts's engine pass run client-side
 *  on the WASM analysis instance before the request crosses the bridge
 *  (the web server has no engine; audit fix W-01). */
export function createDebriefEnricher(): (req: SchoolDebriefReq) => Promise<SchoolDebriefReq> {
  return buildDebriefEnrich()
}

/** A5 canonical judge (spec §8): a judge-DEDICATED, hash-verified,
 *  single-thread engine instance: never the pools above, never the assets.ts
 *  context-sensitive selection. Additive to the webApi contract. */
export { newWebJudgeEngine } from './judge'
