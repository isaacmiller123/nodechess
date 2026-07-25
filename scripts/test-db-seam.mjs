#!/usr/bin/env node
// DB-seam suite (web port W1, docs/WEB-PORT-SPEC.md).
//
//   node scripts/test-db-seam.mjs
//
// Proves src/main/db/database.ts is electron-free and path-injected:
//   1. It bundles + imports in PLAIN NODE (no electron resolution at all,
//      a stray `import { app } from 'electron'` fails the bundle step).
//   2. getAppDb() before configureDb() throws (no silent default path).
//   3. configureDb({appDbDir}) → getAppDb() creates app.sqlite at the injected
//      dir and runs the full migration chain (user_version 10, seeded ratings).
//   4. Reopen over the same dir is idempotent (migrations don't re-run/corrupt).
//   5. Puzzle-DB callbacks: hasPuzzlesDb() false with no puzzles source,
//      getPuzzlesDb() throws a clear error; with callbacks injected, resolution
//      is LAZY (a puzzle DB appearing mid-session is picked up).
// Exit 1 on any failure.

import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dir = mkdtempSync(path.join(tmpdir(), 'dbseam-'))
const out = path.join(dir, 'database.mjs')
execSync(
  `npx esbuild src/main/db/database.ts --bundle --platform=node --format=esm --outfile=${out}`,
  { stdio: 'pipe' }
)

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}`)
  }
}

const db = await import(pathToFileURL(out).href)

// 2. Unconfigured access throws. Never a silent default location.
let threwUnconfigured = false
try {
  db.getAppDb()
} catch (err) {
  threwUnconfigured = /configureDb/.test(String(err))
}
check('getAppDb() before configureDb() throws (mentions configureDb)', threwUnconfigured)

let threwNoPuzzles = false
try {
  db.getPuzzlesDb()
} catch {
  threwNoPuzzles = true
}
check('getPuzzlesDb() without a puzzles source throws', threwNoPuzzles)
check('hasPuzzlesDb() is false when unconfigured', db.hasPuzzlesDb() === false)

// 3. Injected dir: DB created there, full migration chain runs.
const dataDir = path.join(dir, 'nested', 'userData')
db.configureDb({ appDbDir: dataDir })
const appDb = db.getAppDb()
check('app.sqlite created under the injected dir', existsSync(path.join(dataDir, 'app.sqlite')))

const version = appDb.prepare('PRAGMA user_version').get().user_version
check(`migration chain complete (user_version=${version}, want 10)`, version === 10)

const tables = appDb
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((r) => r.name)
for (const t of [
  'game',
  'puzzle_attempt',
  'rating',
  'srs_card',
  'progress_event',
  'setting',
  'concept_mastery',
  'chapter_progress',
  'lesson_progress',
  'chapter_test',
  'school_placement',
  'placement_game',
  'puzzle_rush_run',
  'daily_result',
  'concept_srs',
  'school_day',
  'custom_variant'
]) {
  check(`table ${t} exists`, tables.includes(t))
}

const ratings = appDb.prepare('SELECT kind, rating FROM rating ORDER BY kind').all()
check(
  'ratings seeded (puzzle + vs-bot @ 1200)',
  ratings.length === 2 && ratings.every((r) => r.rating === 1200)
)

const gameKind = appDb.prepare("SELECT * FROM pragma_table_info('game') WHERE name='game_kind'").get()
check('v10 column game.game_kind present', gameKind !== undefined)

// 4. Reopen idempotence: close, reopen the same dir, nothing re-runs/corrupts.
appDb.prepare('INSERT INTO setting(key, value) VALUES (?, ?)').run('seam-test', '1')
db.closeDbs()
const again = db.getAppDb()
check(
  'reopen keeps user_version=10',
  again.prepare('PRAGMA user_version').get().user_version === 10
)
check(
  'reopen keeps written rows',
  again.prepare("SELECT value FROM setting WHERE key='seam-test'").get()?.value === '1'
)
db.closeDbs()

// 5. Puzzle callbacks are lazy: installed() answers change at runtime.
const puzzlePath = path.join(dir, 'puzzles.sqlite')
db.configureDb({
  appDbDir: dataDir,
  puzzles: { resolvePath: () => puzzlePath, installed: () => existsSync(puzzlePath) }
})
check('hasPuzzlesDb() false before the file exists', db.hasPuzzlesDb() === false)
// Create a real (empty) sqlite file the way an import would.
new DatabaseSync(puzzlePath).close()
check('hasPuzzlesDb() flips true after mid-session import', db.hasPuzzlesDb() === true)
check('getPuzzlesDb() opens the injected path', db.getPuzzlesDb() instanceof Object)
db.closeDbs()

// Sanity: bundle output must not mention electron at all.
const bundled = execSync(`grep -c "require('electron')\\|from 'electron'" ${out} || true`, {
  encoding: 'utf8'
}).trim()
check('bundle has zero electron references', bundled === '0')

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nDB seam: all green')
