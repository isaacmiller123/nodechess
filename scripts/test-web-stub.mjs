#!/usr/bin/env node
// Web `Api` stub suite (web port W1, docs/WEB-PORT-SPEC.md).
//
//   node scripts/test-web-stub.mjs
//
// 1. SHAPE PARITY: the web implementation (src/web/webApi.ts) must expose the
//    exact namespace.method surface the desktop preload (src/preload/api.ts)
//    exposes: nothing missing, nothing extra. tsc guarantees each against the
//    `Api` type; this guards the RUNTIME objects against drift (e.g. a method
//    left off the literal that a loose cast would let through).
// 2. BEHAVIOR CONTRACT: reads resolve their honest empty shapes, unavailable
//    actions reject with the coming-online copy, event subscriptions return
//    working unsubscribers, and the localStorage-backed namespaces
//    (settings, customVariants) round-trip.
//
// W3 note: this suite runs LOGGED OUT with no fetch mock (bare node: every
// bridge call fails and degrades). Public content reads (puzzles.next,
// school.chapters, …) therefore still resolve their empty shapes, and the two
// legitimately-changed logged-out behaviors are asserted below: puzzles.attempt
// and games.reportResult now apply the REAL local Glicko-2 ratings instead of
// rejecting. Logged-IN routing is scripts/test-web-client.mjs's job.
// Exit 1 on any failure.

import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'webstub-'))

// The preload module needs an electron shim (invoke/on/removeListener no-ops).
const electronShim = path.join(dir, 'electron-shim.mjs')
writeFileSync(
  electronShim,
  `export const ipcRenderer = {
     invoke: async () => ({}),
     on: () => {},
     removeListener: () => {}
   }\n`
)

// Vite resolves `…?url` to an emitted asset path; nothing here does. The two
// sql.js-httpvfs `?url` imports (src/web/data/chunkedDb.ts) are BARE package
// specifiers, so leaving them external makes node resolve them relative to the
// bundle (which lives in a temp dir with no node_modules) and the import
// throws before a single assertion runs. Every other `?url` is a relative asset
// node can at least locate. Stub the two to empty strings: this suite never
// spawns the SQLite worker, and an empty URL is what an unconfigured host would
// hand it anyway.
const urlStub = path.join(dir, 'url-stub.mjs')
writeFileSync(urlStub, `export default ''\n`)

function bundle(entry, name, extra) {
  const out = path.join(dir, name)
  execSync(
    `npx esbuild ${entry} --bundle --format=esm --outfile=${out} ${extra}`,
    { stdio: 'pipe' }
  )
  return out
}

const preloadOut = bundle(
  'src/preload/api.ts',
  'preload.mjs',
  `--platform=node --alias:electron=${electronShim} --alias:@shared=./src/shared`
)
// platform=node (not browser) so the lazily-imported games tree resolves the
// same way scripts/test-bots.mjs bundles it; '*?url' assets stay external and
// CSS loads empty (never touched: the test only exercises webApi itself).
const webOut = bundle(
  'src/web/webApi.ts',
  'webApi.mjs',
  `--platform=node --jsx=automatic --external:*?url --loader:.css=empty ` +
    `--alias:@shared=./src/shared --alias:@=./src/renderer/src ` +
    `"--alias:sql.js-httpvfs/dist/sqlite.worker.js?url=${urlStub}" ` +
    `"--alias:sql.js-httpvfs/dist/sql-wasm.wasm?url=${urlStub}" ` +
    `--define:__WEB_APP_VERSION__='"0.0.0-test"'`
)

// Browser-ish globals the stub touches lazily (module import touches none).
globalThis.window = globalThis

const { api: desktopApi } = await import(pathToFileURL(preloadOut).href)
const { webApi } = await import(pathToFileURL(webOut).href)

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}`)
  }
}

// ---- 1. Shape parity ----------------------------------------------------------

const desktopNs = Object.keys(desktopApi).sort()
const webNs = Object.keys(webApi).sort()
check(
  `namespace sets match (${desktopNs.length})`,
  JSON.stringify(desktopNs) === JSON.stringify(webNs)
)

let methodCount = 0
for (const ns of desktopNs) {
  const d = Object.keys(desktopApi[ns] ?? {}).sort()
  const w = Object.keys(webApi[ns] ?? {}).sort()
  methodCount += d.length
  check(`  ${ns}: methods match (${d.join(', ')})`, JSON.stringify(d) === JSON.stringify(w))
  for (const m of w) {
    if (typeof webApi[ns][m] !== 'function') {
      failures++
      console.error(`FAIL  web ${ns}.${m} is not a function`)
    }
  }
}
console.log(`  --  ${methodCount} methods across ${desktopNs.length} namespaces`)

// ---- 2. Behavior contract -------------------------------------------------------

const rejects = async (p, name) => {
  try {
    await p
    check(`${name} rejects with coming-online copy`, false)
  } catch (err) {
    check(`${name} rejects with coming-online copy`, /coming online/.test(String(err)))
  }
}

// Honest empty reads.
check('puzzles.next → null puzzle', (await webApi.puzzles.next({})).puzzle === null)
check('games.listAll → empty archive', (await webApi.games.listAll()).games.length === 0)
check('school.chapters → empty', (await webApi.school.chapters()).chapters.length === 0)
check('ratings.get → provisional 1200/350', (await webApi.ratings.get('puzzle')).rating === 1200)
check('openings.lookup → null', (await webApi.openings.lookup('fen')).opening === null)
const datasets = await webApi.datasets.status()
check(
  'datasets.status → nothing present (routes surfaces into their required-notices)',
  Object.values(datasets).every((v) => v === false)
)
const imp = await webApi.datasets.import()
check('datasets.import declines honestly', imp.ok === false && /web/.test(imp.error ?? ''))
const engineStatus = await webApi.engine.status()
check(
  'engine.status → nothing ready before W2',
  Object.values(engineStatus).every((v) => v === false)
)
const updates = await webApi.updates.check()
check('updates.check → up-to-date', updates.state === 'up-to-date')

// Unavailable actions reject with the standard copy.
await rejects(webApi.engine.analyze({ fen: 'x', limit: { kind: 'infinite' } }), 'engine.analyze')
await rejects(webApi.engine.newGame('play'), 'engine.newGame')
await rejects(webApi.review.run({ pgn: 'x' }), 'review.run')

// W3: logged out, ratings are REAL local Glicko-2 (desktop math/seeds).
// Solving a 1000-rated puzzle from the 1200/350 seed must move the rating up;
// a 'rush' attempt must NOT touch the ladder (desktop puzzles:attempt rules).
const att = await webApi.puzzles.attempt({ puzzleId: 'x', puzzleRating: 1000, solved: true })
check(
  'puzzles.attempt (logged out) applies the local glicko rating',
  att.ratingAfter > 1200 && att.delta > 0 && att.rd < 350
)
const afterAttempt = (await webApi.ratings.get('puzzle')).rating
check('ratings.get reflects the local puzzle rating', afterAttempt === att.ratingAfter)
const rush = await webApi.puzzles.attempt({
  puzzleId: 'y',
  puzzleRating: 900,
  solved: true,
  mode: 'rush'
})
check('rush attempts leave the ladder untouched', rush.delta === 0 && rush.rd === 0)
check(
  'rush attempts do not move ratings.get',
  (await webApi.ratings.get('puzzle')).rating === afterAttempt
)
const rep = await webApi.games.reportResult({ botElo: 1500, score: 1 })
check(
  'games.reportResult (logged out) applies the local vs-bot rating',
  rep.ratingAfter > 1200 && rep.delta > 0
)
const summary = await webApi.progress.summary()
check(
  'progress.summary reports the local counters',
  summary.puzzlesTried === 2 && summary.puzzlesSolved === 2 && summary.puzzleRating === afterAttempt
)

// Local game archive round-trip (localStorage-backed; desktop table semantics).
const savedGame = await webApi.games.save({
  pgn: '1. e4 e5',
  whiteName: 'You',
  blackName: 'Guest',
  result: '1-0',
  source: 'play'
})
check('games.save returns a gameId', savedGame.gameId > 0)
await webApi.games.save({ pgn: 'B[pd]', source: 'online', gameKind: 'go', result: '0-1' })
const chessOnly = await webApi.games.list()
check('games.list returns only chess rows', chessOnly.games.length === 1 && chessOnly.games[0].game_kind === 'chess')
const archive = await webApi.games.listAll()
check('games.listAll returns every kind, newest first', archive.games.length === 2 && archive.games[0].game_kind === 'go')
check(
  'games.listAll aggregates kinds + sources',
  archive.kinds.length === 2 && archive.sources.join(',') === 'online,play'
)
const goOnly = await webApi.games.listAll({ kind: 'go' })
check('games.listAll kind filter', goOnly.games.length === 1 && goOnly.kinds.length === 2)
const fetched = await webApi.games.get(savedGame.gameId)
check('games.get round-trips the row', fetched.game?.pgn === '1. e4 e5' && fetched.game?.reviewed === 0)

// Openings lookup must fail SOFT in bare node (the table chunk is a Vite
// asset; in the browser it resolves the real desktop table).
const badFen = await webApi.openings.lookup('not a fen')
check('openings.lookup invalid FEN → null', badFen.opening === null)
const startpos = await webApi.openings.lookup(
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
)
check('openings.lookup resolves (soft-fails to null off-Vite)', startpos.opening === null)

// Subscriptions hand back callable unsubscribers.
for (const [name, unsub] of [
  ['engine.onLine', webApi.engine.onLine(() => {})],
  ['engine.onBestmove', webApi.engine.onBestmove(() => {})],
  ['review.onProgress', webApi.review.onProgress(() => {})],
  ['datasets.onProgress', webApi.datasets.onProgress(() => {})],
  ['updates.onStatus', webApi.updates.onStatus(() => {})]
]) {
  check(`${name} returns an unsubscribe`, typeof unsub === 'function' && unsub() === undefined)
}

// localStorage-backed namespaces round-trip (memory fallback in bare node).
await webApi.settings.set('boardTheme', { name: 'walnut', threeD: true })
const setting = await webApi.settings.get('boardTheme')
check('settings round-trip', setting.value?.name === 'walnut' && setting.value?.threeD === true)
check('settings.get unknown → null', (await webApi.settings.get('nope')).value === null)

const variantReq = {
  id: 'test-var',
  name: 'Test',
  description: '',
  iniText: '[test:chess]',
  boardFiles: 8,
  boardRanks: 8
}
const saved = await webApi.customVariants.save(variantReq)
check('customVariants.save returns row', saved.variant.id === 'test-var' && saved.variant.createdAt > 0)
check('customVariants.list has it', (await webApi.customVariants.list()).variants.length === 1)
const resaved = await webApi.customVariants.save(variantReq)
check('customVariants upsert keeps createdAt', resaved.variant.createdAt === saved.variant.createdAt)
await webApi.customVariants.delete('test-var')
check('customVariants.delete removes', (await webApi.customVariants.get('test-var')).variant === null)

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nWeb Api stub: all green')
