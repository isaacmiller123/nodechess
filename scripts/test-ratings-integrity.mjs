#!/usr/bin/env node
// Ratings-integrity suite (vs-bot Glicko chain).
//
//   node scripts/test-ratings-integrity.mjs
//
// Bundles the pure ratings modules with esbuild (same pattern as
// scripts/verify-classification.mjs) and asserts:
//   1. botStrength mapping goldens: measuredElo per band matches the
//      2026-07-06 calibration record, native levels are identity, personas
//      pass through, the curve is monotone, labels carry the '~' marker.
//   2. Migration idempotence, migrateRatingsIntegrityV8 on a temp node:sqlite
//      DB (game + rating tables seeded with a synthetic history) writes the
//      exact same rating row when run twice.
//   3. Glicko recompute sanity: rating moves DOWN when opponents were weaker
//      than labeled (wins deserve less), UP when they were stronger (the real
//      sub-floor case), and the recompute replays applyGameResult exactly
//      (same per-opponent RD + tau).
// Exit 1 on any failure.

import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dir = mkdtempSync(path.join(tmpdir(), 'ratint-'))
function bundle(entry, name) {
  const out = path.join(dir, name)
  execSync(
    `npx esbuild ${entry} --bundle --platform=node --format=esm --outfile=${out}`,
    { stdio: 'pipe' }
  )
  return out
}

const B = await import(pathToFileURL(bundle('src/shared/botStrength.ts', 'botStrength.mjs')).href)
const R = await import(pathToFileURL(bundle('src/main/ratings/recompute.ts', 'recompute.mjs')).href)
const G = await import(pathToFileURL(bundle('src/main/rating/glicko2.ts', 'glicko2.mjs')).href)

let failures = 0
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name}${detail ? `, ${detail}` : ''}`)
  }
}

// ---- 1. botStrength mapping goldens ------------------------------------------------

console.log('botStrength mapping')
const eng = (elo) => ({ kind: 'engine', elo })
// Calibration-record anchors (see src/shared/botStrength.ts).
const GOLDENS = [
  [100, 250],
  [400, 450],
  [600, 600],
  [800, 930],
  [1000, 1210],
  [1200, 1470],
  [1319, 1620]
]
for (const [nominal, measured] of GOLDENS) {
  const got = B.measuredElo(eng(nominal))
  check(`engine ${nominal} -> ${measured}`, got === measured, `got ${got}`)
}
// Interpolation between anchors (1100 midway between 1210 and 1470 => 1340).
check('engine 1100 interpolates to 1340', B.measuredElo(eng(1100)) === 1340, `got ${B.measuredElo(eng(1100))}`)
// Native levels are their own labels.
for (const elo of [1320, 1500, 2200, 3190]) {
  check(`engine ${elo} native identity`, B.measuredElo(eng(elo)) === elo)
}
// Personas pass through (modernElo is already the honest estimate).
check('persona passthrough', B.measuredElo({ kind: 'persona', elo: 2551 }) === 2551)
// Monotone over the whole sub-floor domain.
let mono = true
let prev = -Infinity
for (let e = 100; e <= 1319; e += 1) {
  const m = B.measuredElo(eng(e))
  if (m < prev) mono = false
  prev = m
}
check('sub-floor curve is monotone', mono)
// Labels: '~' for estimates, bare for native.
check("label sub-floor '~1470'", B.botEloLabel(eng(1200)) === '~1470', B.botEloLabel(eng(1200)))
check("label native '1500'", B.botEloLabel(eng(1500)) === '1500', B.botEloLabel(eng(1500)))
check("label persona '~2551'", B.botEloLabel({ kind: 'persona', elo: 2551 }) === '~2551')

// ---- Temp-DB helpers ---------------------------------------------------------------

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE game(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      user_color TEXT, result TEXT,
      opponent_kind TEXT, opponent_label TEXT, opponent_elo INTEGER,
      source TEXT, pgn TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE rating(
      kind TEXT PRIMARY KEY,
      rating REAL NOT NULL, rd REAL NOT NULL, vol REAL NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO rating(kind,rating,rd,vol,updated_at) VALUES ('vs-bot',1200,350,0.06,0);
  `)
  return db
}

let t = 1000
function addGame(db, { result, userColor = 'white', kind = 'engine', elo, source = 'play' }) {
  db.prepare(
    `INSERT INTO game(created_at,user_color,result,opponent_kind,opponent_elo,source)
     VALUES (?,?,?,?,?,?)`
  ).run(t++, userColor, result, kind, elo, source)
}
const ratingRow = (db) =>
  db.prepare("SELECT rating, rd, vol FROM rating WHERE kind='vs-bot'").get()

// ---- 2. Migration idempotence ------------------------------------------------------

console.log('migration idempotence')
{
  const db = makeDb()
  // Mixed synthetic history: sub-floor engine games, a native-level game, a
  // persona game, plus rows the replay must SKIP (unfinished, import, human).
  addGame(db, { result: '1-0', elo: 1200 })
  addGame(db, { result: '0-1', elo: 800, userColor: 'black' })
  addGame(db, { result: '1/2-1/2', elo: 1500 })
  addGame(db, { result: '0-1', userColor: 'black', kind: 'persona', elo: 2551 })
  addGame(db, { result: '1-0', kind: 'maia', elo: 1500 }) // Maia game MUST be counted (was dropped)
  addGame(db, { result: '*', elo: 1000 }) // unfinished. Skipped
  addGame(db, { result: '1-0', elo: 1000, source: 'import' }) // not a play game. Skipped
  const r1 = R.migrateRatingsIntegrityV8(db)
  const row1 = ratingRow(db)
  const r2 = R.migrateRatingsIntegrityV8(db)
  const row2 = ratingRow(db)
  check('replay counts rateable play games incl. maia', r1.games === 5, `got ${r1.games}`)
  // Regression guard for the v8 bug: dropping the maia game would give 4.
  check('maia game is not silently dropped', r1.games !== 4)
  check(
    'second run writes the identical rating row',
    row1.rating === row2.rating && row1.rd === row2.rd && row1.vol === row2.vol,
    JSON.stringify({ row1, row2 })
  )
  check('recompute return matches persisted row', Math.abs(r2.rating - row2.rating) < 1e-9)
}

// ---- 3. Glicko recompute sanity ----------------------------------------------------

console.log('glicko recompute sanity')
{
  // 3a. Opponents WEAKER than labeled => wins deserve less => rating moves DOWN.
  const db = makeDb()
  for (let i = 0; i < 10; i++) addGame(db, { result: '1-0', elo: 1000 })
  const nominal = R.recomputeVsBotGlicko(db, (c) => c.elo)
  const weaker = R.recomputeVsBotGlicko(db, (c) => c.elo - 300)
  check(
    `weaker-than-labeled opponents => lower rating (${Math.round(weaker.rating)} < ${Math.round(nominal.rating)})`,
    weaker.rating < nominal.rating
  )

  // 3b. The REAL mapping: sub-floor bots played stronger than labeled, so the
  // corrected replay of the same wins lands HIGHER than the nominal one.
  const measured = R.recomputeVsBotGlicko(db) // default = measuredElo
  check(
    `measured sub-floor labels => higher rating (${Math.round(measured.rating)} > ${Math.round(nominal.rating)})`,
    measured.rating > nominal.rating
  )
}
{
  // 3c. The replay must agree EXACTLY with the live updater's sequential
  // updates (same per-opponent RD and tau as ratings.repo.applyGameResult),
  // for EVERY opponent kind. Maia + persona rows are included on purpose: the
  // live path is measuredElo({ kind, elo: nominal }) (games.ipc reportResult,
  // where nominal = the maia net's band / the persona's modernElo. Exactly
  // what PlayView saves as opponent_elo), so the replay must map the stored
  // row through the identical call. A kind coercion (the old maia→'engine'
  // bug) would send maia-1100 through the sub-floor curve and diverge here.
  const db = makeDb()
  const games = [
    { result: '1-0', elo: 1200, kind: 'engine' },
    { result: '0-1', elo: 1500, kind: 'engine' },
    { result: '1-0', elo: 1500, kind: 'maia' },
    { result: '1/2-1/2', elo: 1100, kind: 'maia' }, // engine-coerced 1100 would remap to 1340
    { result: '0-1', elo: 2551, kind: 'persona' },
    { result: '1/2-1/2', elo: 800, kind: 'engine' }
  ]
  for (const g of games) addGame(db, g)
  const replayed = R.recomputeVsBotGlicko(db)
  let manual = { ...R.VS_BOT_SEED }
  for (const g of games) {
    const score = g.result === '1-0' ? 1 : g.result === '0-1' ? 0 : 0.5
    manual = G.glicko2Update(
      manual,
      [{ rating: B.measuredElo({ kind: g.kind, elo: g.elo }), rd: R.VS_BOT_OPPONENT_RD, score }],
      R.VS_BOT_TAU
    )
  }
  check(
    'replay identical to sequential applyGameResult math (engine + maia + persona)',
    Math.abs(replayed.rating - manual.rating) < 1e-9 &&
      Math.abs(replayed.rd - manual.rd) < 1e-9 &&
      Math.abs(replayed.vol - manual.vol) < 1e-12,
    JSON.stringify({ replayed, manual })
  )
  // The maia mapping itself: passthrough of the nominal band, NEVER the
  // sub-floor weak-engine curve (an 1100 ENGINE measures 1340).
  check('maia 1100 rates at its nominal band', B.measuredElo({ kind: 'maia', elo: 1100 }) === 1100)
  check(
    'maia 1100 is NOT remapped by the sub-floor engine curve',
    B.measuredElo({ kind: 'engine', elo: 1100 }) !== B.measuredElo({ kind: 'maia', elo: 1100 })
  )
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll ratings-integrity checks passed.')
