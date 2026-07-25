#!/usr/bin/env node
// Web client LOCAL-LAYER suite (web port W3).
//
//   node scripts/test-web-client.mjs
//
// This suite was the webApi ROUTING suite: it drove an `authStore` singleton
// through logged-out → logged-in → 401 and asserted which of three backends
// each call landed on (public bridge, authenticated bridge, local fallback).
// The web target has no server any more. Content is read from the static
// artifact (src/web/data for puzzles, src/web/content for the catalogs) and
// every user-scoped call is localStorage, so `authStore.ts`, `http.ts` and
// `migrate.ts` were deleted along with the three-way routing they existed for.
//
// The assertions are RE-POINTED at that surface rather than dropped:
//   - "puzzle content POSTs to /api/ipc/puzzles:next"  → content is read from
//     the artifact and NOTHING anywhere asks for a /api/ path (§1, §2)
//   - "an unreachable bridge degrades to the empty shape" → an unreachable
//     static host degrades to the same empty shape (§1, §2)
//   - "logged-in user data POSTs to the auth bridge" and "a 401 falls back to
//     local" → user data has no remote path to route to or fall back from: it
//     survives a fetch that throws on every call (§5)
//   - "signup import copies local progress into a fresh account" → there is no
//     account to import into; the Rush and daily state that import carried is
//     asserted against the local store that now keeps it (§7)
// §3, §4, §6 and §8 (local games, the Glicko-2 chain, the review LRU, debrief
// enrichment) describe behavior the port did not change and are unchanged.
//
// global fetch is MOCKED and every call through it is recorded — the mock is
// itself an assertion, since a `/api/` URL appearing in the log means the app
// has grown a server dependency again.
// Exit 1 on any failure.

import { execSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(path.join(tmpdir(), 'webclient-'))

// ONE bundle for webApi + reviewStore + the debrief enricher so they share the
// localData module state the assertions read back. The glicko oracle is a
// separate pure bundle — no shared state, used only to compute expected values.
const entry = path.join(dir, 'entry.ts')
writeFileSync(
  entry,
  [
    `export { webApi } from '${repoRoot}/src/web/webApi'`,
    `export { localReviewStore, LOCAL_REVIEWS_CAP } from '${repoRoot}/src/web/reviewStore'`,
    `export { enrichDebriefMoves } from '${repoRoot}/src/web/engines/debrief'`,
    ''
  ].join('\n')
)
const glickoEntry = path.join(dir, 'glicko.ts')
writeFileSync(glickoEntry, `export { glicko2Update } from '${repoRoot}/src/main/rating/glicko2'\n`)

// The puzzle reader's two sql.js-httpvfs `?url` imports are BARE package
// specifiers; left external they resolve against the bundle's temp dir, which
// has no node_modules, and the import throws before the first assertion. Stub
// them — no SQLite worker is ever spawned here (see §2).
const urlStub = path.join(dir, 'url-stub.mjs')
writeFileSync(urlStub, `export default ''\n`)

function bundle(entryFile, name) {
  const out = path.join(dir, name)
  execSync(
    `npx esbuild ${entryFile} --bundle --format=esm --outfile=${out} ` +
      `--platform=node --jsx=automatic --external:*?url --loader:.css=empty ` +
      `--alias:@shared=${repoRoot}/src/shared --alias:@=${repoRoot}/src/renderer/src ` +
      `"--alias:sql.js-httpvfs/dist/sqlite.worker.js?url=${urlStub}" ` +
      `"--alias:sql.js-httpvfs/dist/sql-wasm.wasm?url=${urlStub}" ` +
      `--define:__WEB_APP_VERSION__='"0.0.0-test"'`,
    { stdio: 'pipe', cwd: repoRoot }
  )
  return out
}

const webOut = bundle(entry, 'web.mjs')
const glickoOut = bundle(glickoEntry, 'glicko.mjs')

// Browser-ish globals BEFORE the bundle loads. localStorage is absent in bare
// node → the localData memory fallback carries all local state.
globalThis.window = globalThis

// ---- fetch mock -----------------------------------------------------------------

const calls = []
/** Set per test step: (call) => ({ status, body }) | null. null ⇒ network error. */
let responder = null

globalThis.fetch = async (url, init = {}) => {
  const call = {
    url: String(url),
    method: init.method ?? 'GET',
    credentials: init.credentials,
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  }
  calls.push(call)
  const r = responder ? responder(call) : null
  if (!r) throw new TypeError('fetch failed (unmocked)')
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: async () => r.body,
    text: async () => JSON.stringify(r.body)
  }
}

const { webApi, localReviewStore, LOCAL_REVIEWS_CAP, enrichDebriefMoves } = await import(
  pathToFileURL(webOut).href
)
const { glicko2Update } = await import(pathToFileURL(glickoOut).href)

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}`)
  }
}
const last = () => calls[calls.length - 1]

// The static build's own console.error on a degraded read would drown the
// assertion log; it fires once per process and is the behavior §1/§2 assert.
const realError = console.error.bind(console)
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('nodechess static read failed')) return
  realError(...args)
}

// ---- 0. boot -----------------------------------------------------------------------
// The old suite booted authStore against GET /api/auth/me here. Nothing is
// eager now: importing the module graph must not touch the network at all.

check('module import makes no request', calls.length === 0)

// ---- 1. catalog content → the static content tree ------------------------------------

const CH_01 = {
  id: 'ch-01',
  band: 'foundations',
  order: 1,
  title: 'Opening principles',
  subtitle: 'Centre, development, king safety',
  estMinutes: 25,
  conceptCount: 4,
  lessonCount: 3,
  eloFloor: 600
}
responder = (c) =>
  c.url.endsWith('content/school/chapters.json') ? { status: 200, body: { chapters: [CH_01] } } : null
const chapters = await webApi.school.chapters()
check('school.chapters fetches the static content tree', /content\/school\/chapters\.json$/.test(last().url))
check('content reads are plain GETs', last().method === 'GET')
check('content reads send no credentials', last().credentials === undefined)
check('content reads carry no request body', last().body === undefined)
check('the fetched catalog reaches the caller', chapters.chapters[0]?.id === 'ch-01')
// SCHOOL-SPEC §2.2a: eloFloor has to reach the browser now that the unlock rule
// runs there, but it must not survive into anything renderable.
check('eloFloor is stripped from the rendered chapter card', !('eloFloor' in chapters.chapters[0]))
check(
  'nothing is unlocked without a placement',
  chapters.chapters[0].locked === true && chapters.chapters[0].lockReason === 'placement'
)

responder = null // the content tree is not hosted
check(
  'unreachable content host → honest empty famous list',
  (await webApi.famous.list({})).games.length === 0
)
check(
  'unreachable content host → honest empty persona catalog',
  (await webApi.personas.list()).personas.length === 0
)

// ---- 2. puzzle content → the chunked artifact ------------------------------------------

const preArtifact = calls.length
const next = await webApi.puzzles.next({ theme: 'fork', ratingLo: 800 })
check('unhosted artifact → honest null puzzle', next.puzzle === null)
check('unhosted artifact → honest empty themes', (await webApi.puzzles.themes()).themes.length === 0)
check('unhosted artifact → honest empty batch', (await webApi.puzzles.batch({ ids: ['p1'] })).puzzles.length === 0)
check(
  'no puzzle read ever asks for an /api/ path',
  calls.slice(preArtifact).every((c) => !c.url.includes('/api/'))
)

// ---- 3. games stay local ----------------------------------------------------------

let fetchCount = calls.length
const saved1 = await webApi.games.save({ pgn: '1. e4 e5', source: 'play', result: '1-0' })
check('games.save makes NO fetch call', calls.length === fetchCount)
check('games.save returns local id 1', saved1.gameId === 1)
const listed = await webApi.games.list()
check('games.list serves the local archive', listed.games[0]?.pgn === '1. e4 e5')
check('games.list made no fetch call', calls.length === fetchCount)

// ---- 4. deterministic local glicko ------------------------------------------------

const SEED = { rating: 1200, rd: 350, vol: 0.06 }
const exp1 = glicko2Update(SEED, [{ rating: 1400, rd: 50, score: 1 }], 0.3)
const a1 = await webApi.puzzles.attempt({ puzzleId: 'p1', puzzleRating: 1400, solved: true })
check('attempt #1 ratingAfter matches desktop math', a1.ratingAfter === Math.round(exp1.rating))
check('attempt #1 rd matches', a1.rd === Math.round(exp1.rd))
check('attempt #1 delta matches', a1.delta === Math.round(exp1.rating - SEED.rating))
check('attempt #1 made no fetch call', calls.length === fetchCount)

const exp2 = glicko2Update(exp1, [{ rating: 1400, rd: 50, score: 0 }], 0.3)
const a2 = await webApi.puzzles.attempt({ puzzleId: 'p2', puzzleRating: 1400, solved: false })
check('attempt #2 chains from stored full precision', a2.ratingAfter === Math.round(exp2.rating))
check('attempt #2 delta matches', a2.delta === Math.round(exp2.rating - exp1.rating))

const r1 = await webApi.ratings.get('puzzle')
check('ratings.get serves the local rating (rounded)', r1.rating === Math.round(exp2.rating))

const rush = await webApi.puzzles.attempt({
  puzzleId: 'p3',
  puzzleRating: 900,
  solved: true,
  mode: 'rush'
})
check('rush attempt echoes rating, rd 0, delta 0', rush.ratingAfter === 900 && rush.rd === 0 && rush.delta === 0)
check(
  'rush attempt leaves the ladder untouched',
  (await webApi.ratings.get('puzzle')).rating === Math.round(exp2.rating)
)

// ---- 5. user data has no remote path ------------------------------------------------
// Replaces the old "logged-in calls hit the auth bridge" and "a 401 drops back
// to local" sections. There is no bridge to hit and no session to lose, so the
// property that matters is the inverse: a fetch that fails on EVERY call must
// be invisible to user-scoped reads and writes.

const hostileFrom = calls.length
responder = null
await webApi.settings.set('boardTheme', { name: 'walnut' })
const setting = await webApi.settings.get('boardTheme')
check('settings round-trip through this browser', setting.value?.name === 'walnut')
check('ratings.get is unaffected by a dead network', (await webApi.ratings.get('puzzle')).rating === Math.round(exp2.rating))
const saved2 = await webApi.games.save({ pgn: '1. d4' })
check('games.save keeps its local sequence', saved2.gameId === 2)
const progress = await webApi.progress.summary()
check('progress.summary counts the local archive', progress.gamesPlayed >= 2)
check('not one user-data call touched the network', calls.length === hostileFrom)

// ---- 6. ReviewStore: LRU cap + accuracy mirror ---------------------------------------

const side = (acc) => ({
  accuracy: acc,
  acpl: 20,
  moves: 10,
  inaccuracies: 1,
  mistakes: 0,
  blunders: 0,
  best: 5
})
const band = { est: 1500, low: 1400, high: 1600, accuracy: 90, kind: 'estimate' }
const mkReview = (id) => ({
  gameId: id,
  depth: 16,
  totalPlies: 20,
  white: side(90),
  black: side(85),
  whiteElo: band,
  blackElo: band,
  moveEvals: [{ ply: 1 }]
})

check('pgn-only review save keeps reviewId null', (await localReviewStore.save(null, mkReview(null))).reviewId === null)
for (let i = 1; i <= LOCAL_REVIEWS_CAP + 5; i++) await localReviewStore.save(i, mkReview(i))
check('newest review survives the cap', (await localReviewStore.load(45)).review !== null)
check('oldest reviews are LRU-evicted', (await localReviewStore.load(1)).review === null)
check('eviction stops at the cap boundary', (await localReviewStore.load(6)).review !== null)
const loaded = await localReviewStore.load(44)
check('load returns the review moveEvals', loaded.moveEvals.length === 1 && loaded.moveEvals[0].ply === 1)
const gameRow = await webApi.games.get(2)
check(
  'review save mirrors accuracy onto the archived game row',
  gameRow.game?.accuracy_white === 90 && gameRow.game?.accuracy_black === 85
)

// ---- 7. Rush + daily live in this browser ----------------------------------------------
// The section this replaces imported local Rush runs and daily results into a
// fresh server account. Both calls used to be sign-in-gated rejections on the
// web; they are now writes to the local store, so assert the store.

const rushFrom = calls.length
const run1 = await webApi.puzzles.saveRush({ mode: 'rush3', score: 5, best: 5 })
check('saveRush persists locally instead of rejecting', run1.id === 1 && run1.isBest)
const run2 = await webApi.puzzles.saveRush({ mode: 'rush3', score: 9, best: 9 })
check('a higher score takes the best', run2.best === 9 && run2.isBest)
const run3 = await webApi.puzzles.saveRush({ mode: 'rush3', score: 2, best: 9 })
check('a lower score keeps the standing best', run3.best === 9 && !run3.isBest)
check('rushRuns lists them newest-first', (await webApi.puzzles.rushRuns({ mode: 'rush3' })).runs[0].score === 2)
const bests = await webApi.puzzles.rushBests()
check('rushBests reports one row per mode', bests.bests.length >= 1)
check(
  'rushBests carries the mode best',
  bests.bests.find((b) => b.mode === 'rush3')?.best === 9
)

const today = new Date().toISOString().slice(0, 10)
const daily = await webApi.puzzles.recordDaily({
  ymd: today,
  puzzleId: 'd1',
  solved: true,
  firstTry: true
})
check('recordDaily returns the recomputed streak', daily.streak.current >= 1)
check('dailyStreak reads the same record back', (await webApi.puzzles.dailyStreak()).streak.current === daily.streak.current)
const stats = await webApi.puzzles.stats()
check('puzzle stats accuracy is a 0..1 fraction, not a percent', stats.accuracy >= 0 && stats.accuracy <= 1)
check('puzzle history serves the attempt rows', (await webApi.puzzles.history({ limit: 10 })).rows.length >= 2)
check('none of the Rush/daily state touched the network', calls.length === rushFrom)

// ---- 8. school debrief enrichment (audit W-01) --------------------------------------
// There is no server engine, so the move evals Viktor's debrief needs must be
// computed CLIENT-side. enrichDebriefMoves takes an injectable analyze fn —
// the canned one below stands in for the WASM engine.

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const NO_EVAL = { cp: null, mate: null }
const dbMove = (over = {}) => ({
  ply: 1,
  fenBefore: START_FEN,
  played: 'e2e4',
  best: '',
  pv: [],
  evalBefore: NO_EVAL,
  evalAfter: NO_EVAL,
  byUser: true,
  ...over
})

let analyzeCalls = 0
const cannedAnalyze = async (fen, depth, multipv) => {
  analyzeCalls++
  return { lines: new Map([[1, { multipv: 1, depth, pv: ['d2d4', 'd7d5'], scoreCp: 42 }]]) }
}

let enriched = await enrichDebriefMoves(
  {
    chapterId: 'ch-01',
    userColor: 'white',
    moves: [dbMove(), dbMove({ ply: 2, byUser: false })]
  },
  cannedAnalyze
)
const um = enriched.moves[0]
check('enrich fills evalBefore from the engine (mover POV)', um.evalBefore.cp === 42)
check('enrich adopts the engine best + pv', um.best === 'd2d4' && um.pv.length === 2)
check(
  'enrich negates the after-eval (played != best pays a second search)',
  um.evalAfter.cp === -42
)
check('enrich leaves opponent moves untouched', enriched.moves[1].evalBefore.cp === null)
check('two searches for one enriched user move', analyzeCalls === 2)

// Mate detection needs no second search: Ra8# from a back-rank position.
const mateFen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'
enriched = await enrichDebriefMoves(
  {
    chapterId: 'ch-01',
    userColor: 'white',
    moves: [
      dbMove({ fenBefore: mateFen, played: 'a1a8', best: 'a1a8', pv: ['a1a8'], evalBefore: { cp: 500, mate: null } })
    ]
  },
  cannedAnalyze
)
check('a mating user move gets mate:1 with no extra search', enriched.moves[0].evalAfter.mate === 1)

// The engine budget mirrors viktor.ts MAX_POSITIONS (24 searches).
analyzeCalls = 0
await enrichDebriefMoves(
  {
    chapterId: 'ch-01',
    userColor: 'white',
    moves: Array.from({ length: 30 }, (_, i) => dbMove({ ply: i + 1 }))
  },
  cannedAnalyze
)
check('enrichment stops at the 24-search budget (viktor parity)', analyzeCalls === 24)

// A totally dead engine must reject (an honest error beats all-moves-"fine"
// coaching), while a single hiccup degrades per-move like desktop.
let deadRejected = false
await enrichDebriefMoves(
  { chapterId: 'ch-01', userColor: 'white', moves: [dbMove()] },
  async () => {
    analyzeCalls++
    throw new Error('engine crashed')
  }
).catch(() => {
  deadRejected = true
})
check('a dead engine rejects the debrief instead of faking evals', deadRejected)

// webApi.school.debrief is inert on web: viktor.ts builds a node StockfishPool
// at module scope and cannot enter the browser graph, so the enricher above is
// built but unwired. What the suite pins is that the call says so and writes
// nothing — the old assertion was the same shape against the engine-copy
// rejection the bridge path used to produce.
fetchCount = calls.length
let debriefErr = null
await webApi.school
  .debrief({ chapterId: 'ch-01', userColor: 'white', moves: [dbMove()] })
  .catch((err) => {
    debriefErr = err
  })
check(
  'school.debrief rejects with honest unavailable copy',
  debriefErr instanceof Error && /isn’t available/.test(debriefErr.message)
)
check('school.debrief sends nothing anywhere', calls.length === fetchCount)

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nWeb client local layer: all green')
