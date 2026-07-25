// LIVE proof for the bots-UI wave: real engine moves through the EXACT
// main-process pool classes the ipc handlers use.
//   1. KataGo: KatagoPool.play() (src/main/engine/KatagoPool.ts; the
//      engine:playGo backend), standard ladder AND, when the Human-SL net is
//      installed, the human rank ladder;
//   2. Maia:   MaiaPool.get() + UciEngine.bestMove nodes=1 (the engine:play
//      level.maia backend).
//
//   node scripts/verify-bots-live.mjs
//
// esbuild-bundles the TypeScript pools with 'electron' aliased to a stub whose
// app.getPath('userData') → <repo>/.devdata, exactly where dev datasets live
// (same redirection the app itself does in dev). Requires the katago dataset
// (.devdata/datasets/katago) and maia weights (+ lc0 via datasets or Homebrew).
// Prints the moves; exits non-zero on any failure.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DEVDATA = resolve(ROOT, '.devdata')

const tmp = mkdtempSync(resolve(tmpdir(), 'bots-live-'))
const stub = resolve(tmp, 'electron-stub.mjs')
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')

writeFileSync(
  stub,
  `export const app = {
    isPackaged: false,
    getPath: (k) => { if (k !== 'userData') throw new Error('stub: ' + k); return ${JSON.stringify(DEVDATA)} }
  }
  export default { app }`
)
writeFileSync(
  entry,
  [
    `export { KatagoPool } from ${JSON.stringify(resolve(ROOT, 'src/main/engine/KatagoPool.ts'))}`,
    `export { MaiaPool } from ${JSON.stringify(resolve(ROOT, 'src/main/engine/MaiaPool.ts'))}`,
    `export { katagoNetInstalled } from ${JSON.stringify(resolve(ROOT, 'src/main/datasets/katago.ts'))}`
  ].join('\n')
)
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { electron: stub },
  logLevel: 'silent'
})
const { KatagoPool, MaiaPool, katagoNetInstalled } = await import(pathToFileURL(outfile).href)

const VERTEX = /^(?:pass|[a-hj-t](?:1[0-9]|[1-9]))$/
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/
let failed = false
const humanNet = resolve(DEVDATA, 'datasets/katago/nets/kata-b18-humanv0.bin.gz')
const humanAside = `${humanNet}.aside`

try {
  // ---- 1a. KataGo standard ladder (hide the human net so humanStyle=false) ---
  const hadHuman = existsSync(humanNet)
  if (hadHuman) renameSync(humanNet, humanAside)
  try {
    const pool = new KatagoPool()
    const t0 = Date.now()
    const req = { size: 9, komi: 7, moves: ['e5', 'c3'], level: 2 }
    const mv = await pool.play(req)
    pool.killAll()
    if (!VERTEX.test(mv)) throw new Error(`standard ladder returned '${mv}'`)
    console.log(
      `katago standard L2 (b6c96, 9x9 after e5 c3): ${mv}  [${Date.now() - t0}ms]`
    )
  } finally {
    if (hadHuman) renameSync(humanAside, humanNet)
  }

  // ---- 1b. KataGo Human-SL ladder (when the optional net is installed) -------
  if (katagoNetInstalled('b18-human')) {
    const pool = new KatagoPool()
    if (!pool.humanStyle()) throw new Error('human net installed but humanStyle() is false')
    const t0 = Date.now()
    const mv = await pool.play({ size: 9, komi: 7, moves: ['e5'], level: 3 })
    pool.killAll()
    if (!VERTEX.test(mv)) throw new Error(`human ladder returned '${mv}'`)
    console.log(`katago human L3 (rank_4k, 9x9 after e5): ${mv}  [${Date.now() - t0}ms]`)
  } else {
    console.log('katago human ladder: SKIPPED (Human-SL net not installed)')
  }

  // ---- 2. Maia via MaiaPool + UciEngine (nodes=1) -----------------------------
  {
    const pool = new MaiaPool()
    const levels = pool.availableLevels()
    if (!levels.includes(1500)) throw new Error(`maia 1500 not available (have: ${levels})`)
    const t0 = Date.now()
    const eng = await pool.get(1500)
    // After 1.e4: the human-move model answers from the raw policy head.
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
    const { bestmove } = await eng.bestMove(fen, { kind: 'nodes', value: 1 })
    pool.killAll()
    if (!UCI.test(bestmove)) throw new Error(`maia returned '${bestmove}'`)
    console.log(`maia-1500 (lc0 nodes=1, after 1.e4): ${bestmove}  [${Date.now() - t0}ms]`)
  }

  console.log('verify-bots-live: OK')
} catch (err) {
  failed = true
  console.error(`verify-bots-live: FAILED, ${err?.stack ?? err}`)
  // Never leave the human net renamed aside on a crash.
  if (existsSync(humanAside) && !existsSync(humanNet)) renameSync(humanAside, humanNet)
} finally {
  rmSync(tmp, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
