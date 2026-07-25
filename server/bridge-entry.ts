// Entry point for scripts/build-ipc-bridge.mjs → dist-server/ipc-bridge.cjs.
//
// Bundles the REAL desktop ipc modules (esbuild aliases `electron` →
// server/electron-shim.ts) so the web server serves the exact same
// zod-validated handlers over POST /api/ipc/<channel>. server/index.cjs
// require()s this bundle lazily at runtime (server/bridge.ts). It is NOT
// compiled into the server bundle, so the two build independently.
//
// EXCLUDED on purpose (never bundled server-side, per the build contract):
//   engine.ipc, review.ipc, datasets.ipc, updates.ipc, dialog.ipc
// Those are desktop-only surfaces (native engine pools, dataset import, native
// dialogs, auto-updates); the web client runs engines + review in-browser (W2)
// and persists reviews via POST /api/review/* instead.

import { registerApp } from '../src/main/ipc/app.ipc'
import { registerMaintenance } from '../src/main/ipc/maintenance.ipc'
import { registerSettings } from '../src/main/ipc/settings.ipc'
import { registerPuzzles } from '../src/main/ipc/puzzles.ipc'
import { registerPuzzlesRush } from '../src/main/ipc/puzzles.rush.ipc'
import { registerPuzzlesDaily } from '../src/main/ipc/puzzles.daily.ipc'
import { registerRatings } from '../src/main/ipc/ratings.ipc'
import { registerGames } from '../src/main/ipc/games.ipc'
import { registerOpenings } from '../src/main/ipc/openings.ipc'
import { registerCoach } from '../src/main/ipc/coach.ipc'
import { registerFamous } from '../src/main/ipc/famous.ipc'
import { registerSchool } from '../src/main/ipc/school.ipc'
import { registerPersonas } from '../src/main/ipc/personas.ipc'
import { registerCustomVariants } from '../src/main/ipc/customVariants.ipc'

/** Register every web-served IPC domain into the shim's handler map. */
export function registerBridgeIpc(): void {
  registerApp()
  registerMaintenance()
  registerSettings()
  registerPuzzles()
  registerPuzzlesRush()
  registerPuzzlesDaily()
  registerRatings()
  registerGames()
  registerOpenings()
  registerCoach()
  registerFamous()
  registerSchool()
  registerPersonas()
  registerCustomVariants()
}

// The shim's collection/injection surface. Imported by path here AND aliased as
// 'electron' by the build. Esbuild resolves both to the same file, so this is
// the same module instance the ipc modules registered into.
export { getRegisteredHandlers, setShimUserDataDir } from './electron-shim'
export type { BridgeIpcEvent, BridgeIpcHandler } from './electron-shim'

// DB lifecycle: the server opens one migrated app.sqlite per user
// (DATA_DIR/users/<id>) via openAppDb and reroutes every repo through
// setDbOverride for the duration of one FIFO-serialized bridge call.
export {
  configureDb,
  openAppDb,
  setDbOverride,
  closeDbs,
  hasPuzzlesDb
} from '../src/main/db/database'

// Review persistence (POST /api/review/save, GET /api/review/:gameId): the
// review module's OWN save/load helpers, so the web rows are byte-identical to
// what the desktop writes.
export {
  ensureReviewTables,
  saveReviewCache,
  getCachedReview,
  type GameReview
} from '../src/main/review/review'

// Game-row helpers for the review endpoints (existence check + accuracy mark).
export { getGame, setGameAccuracy } from '../src/main/db/games.repo'
