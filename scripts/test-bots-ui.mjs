// Headless test for the bots-UI wave: the KataGo provider wiring (games/bots.ts
// → engine:playGo request shape, unavailable paths, standard vs Human-SL
// describe strings) and the Maia rating contract (shared/botStrength 'maia'
// kind). Complements scripts/test-bots.mjs (all in-process providers) and the
// LIVE proofs in scripts/verify-bots-live.mjs (real KataGo + lc0 moves through
// the main-process pool classes).
//
//   node scripts/test-bots-ui.mjs
//
// esbuild-bundles the renderer games tree with a MOCK window.api installed
// BEFORE import, so the engine-backed provider paths run without Electron.
// Final line: 'ALL GREEN: N assertions'. Exit 0 = all green.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

let passed = 0
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  passed++
  console.log(`  ✓ ${msg}`)
}

const tick = () => new Promise((r) => setTimeout(r, 0))

// ---- mock window.api ---------------------------------------------------------
// Installed before the bundle imports so module-scope `window` checks see it.
let statusResult = {
  analysisReady: true,
  playReady: true,
  lc0Ready: true,
  fairyReady: true,
  katagoReady: true,
  katagoHumanReady: false
}
let playGoImpl = async () => ({ move: 'd4' })
const playGoCalls = []
globalThis.window = {
  api: {
    engine: {
      status: async () => statusResult,
      playGo: async (req) => {
        playGoCalls.push(req)
        return playGoImpl(req)
      },
      // The chess providers aren't exercised here (test-bots.mjs owns them).
      play: async () => ({ bestmove: '0000' }),
      playVariant: async () => ({ bestmove: '0000' })
    }
  }
}

// ---- bundle -----------------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'bots-ui-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
const GAMES = resolve(ROOT, 'src/renderer/src/games')
const SHARED = resolve(ROOT, 'src/shared')
writeFileSync(
  entry,
  [
    `export { resolveBotProvider, BotUnavailableError } from ${JSON.stringify(resolve(GAMES, 'bots.ts'))}`,
    `export { getGame } from ${JSON.stringify(resolve(GAMES, 'registry.ts'))}`,
    `export { measuredElo, isApproxElo, botEloLabel } from ${JSON.stringify(resolve(SHARED, 'botStrength.ts'))}`,
    `export { MAIA_LEVELS } from ${JSON.stringify(resolve(SHARED, 'types.ts'))}`
  ].join('\n')
)
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  external: ['*?url'],
  loader: { '.css': 'empty' },
  alias: { '@shared': SHARED, '@': resolve(ROOT, 'src/renderer/src') },
  logLevel: 'silent'
})
const mod = await import(pathToFileURL(outfile).href)
const { resolveBotProvider, BotUnavailableError, getGame, measuredElo, isApproxElo, botEloLabel, MAIA_LEVELS } = mod

try {
  // ---- 1. katago provider: request shape through engine:playGo ---------------
  console.log('katago provider: playGo request shape')
  const goSpec = getGame('go').spec
  const provider = resolveBotProvider('go')
  await tick() // let the availability refresh settle
  {
    let s = goSpec.init({ size: 9, komi: 7 })
    for (const mv of ['e5', 'c3', 'g5']) s = goSpec.play(s, mv)
    playGoImpl = async () => ({ move: 'e3' })
    const mv = await provider.move(s, 3)
    ok(mv === 'e3', `provider returns the ipc move verbatim ('${mv}')`)
    const req = playGoCalls.at(-1)
    ok(req.size === 9 && req.komi === 7, `request carries the state's size+komi (${req.size}, ${req.komi})`)
    ok(
      Array.isArray(req.moves) && req.moves.join(',') === 'e5,c3,g5',
      `request carries the full move list (${req.moves.join(' ')})`
    )
    ok(req.level === 3, `request carries the clamped level (${req.level})`)
    // Level clamping
    await provider.move(s, 99)
    ok(playGoCalls.at(-1).level === 5, 'level 99 clamps to 5')
    await provider.move(s, -2)
    ok(playGoCalls.at(-1).level === 1, 'level -2 clamps to 1')
    // pass passthrough
    playGoImpl = async () => ({ move: 'pass' })
    ok((await provider.move(s, 2)) === 'pass', "a 'pass' reply passes through untouched")
  }

  // ---- 2. unavailable paths ---------------------------------------------------
  console.log('katago provider: unavailable paths')
  {
    const s = goSpec.init({ size: 9, komi: 7 })
    // main's not-installed rejection → actionable BotUnavailableError
    playGoImpl = async () => {
      throw new Error('KataGo is not installed. Download the Go engine in Settings → Datasets.')
    }
    let err = null
    try {
      await provider.move(s, 3)
    } catch (e) {
      err = e
    }
    ok(
      err instanceof BotUnavailableError && /Settings → Datasets/.test(err.message),
      `not-installed → BotUnavailableError with the Settings → Datasets action ('${err?.message}')`
    )
    // other engine errors surface as plain errors (NOT swallowed into unavailable)
    playGoImpl = async () => {
      throw new Error('gtp: engine process exited')
    }
    err = null
    try {
      await provider.move(s, 3)
    } catch (e) {
      err = e
    }
    ok(
      err instanceof Error && !(err instanceof BotUnavailableError),
      `a crashed engine is a real error, not an install prompt ('${err?.message}')`
    )
    // no bridge at all (browser / headless): unavailable, message names KataGo
    const savedApi = globalThis.window.api
    globalThis.window.api = undefined
    err = null
    try {
      await provider.move(s, 3)
    } catch (e) {
      err = e
    }
    globalThis.window.api = savedApi
    ok(
      err instanceof BotUnavailableError && /KataGo/.test(err.message),
      `no bridge → BotUnavailableError mentioning KataGo ('${err?.message}')`
    )
  }

  // ---- 3. describe(): standard vs Human-SL ladders ----------------------------
  console.log('katago describe strings')
  {
    // status said katagoHumanReady:false at resolve time → standard hints
    ok(/KataGo/.test(provider.describe(1)), `standard L1 hint mentions KataGo ('${provider.describe(1)}')`)
    ok(!/human/i.test(provider.describe(5)), 'standard hints do not claim to be human')
    // flip the status and re-resolve: describe switches to the human ranks
    statusResult = { ...statusResult, katagoHumanReady: true }
    resolveBotProvider('go') // re-resolve fires the availability refresh
    await tick()
    ok(
      provider.describe(1) === 'plays like a ~15-kyu human',
      `human L1 = '~15-kyu human' ('${provider.describe(1)}')`
    )
    ok(
      provider.describe(5) === 'plays like a ~3-dan human',
      `human L5 = '~3-dan human' ('${provider.describe(5)}')`
    )
  }

  // ---- 4. maia rating contract (shared/botStrength 'maia' kind) ---------------
  console.log('maia measuredElo contract')
  {
    ok(
      MAIA_LEVELS.join(',') === '1100,1300,1500,1700,1900',
      `MAIA_LEVELS are the five nets (${MAIA_LEVELS.join(' ')})`
    )
    for (const l of MAIA_LEVELS) {
      ok(
        measuredElo({ kind: 'maia', elo: l }) === l,
        `maia ${l} rates at its nominal band (${measuredElo({ kind: 'maia', elo: l })})`
      )
    }
    ok(isApproxElo({ kind: 'maia', elo: 1500 }) === true, 'maia strength displays as an estimate (~)')
    ok(botEloLabel({ kind: 'maia', elo: 1500 }) === '~1500', `label is '~1500'`)
    // the sub-floor ENGINE curve is untouched: 800 still measures 930
    ok(
      measuredElo({ kind: 'engine', elo: 800 }) === 930,
      `sub-floor engine 800 still measures 930 (${measuredElo({ kind: 'engine', elo: 800 })})`
    )
    ok(
      measuredElo({ kind: 'engine', elo: 1500 }) === 1500,
      'native engine levels still pass through'
    )
  }

  console.log(`\nALL GREEN: ${passed} assertions`)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
} catch (err) {
  console.error(`\n${err?.stack ?? err}`)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}
