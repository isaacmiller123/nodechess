#!/usr/bin/env node
// Settings persistence suite: proves settings:set survives a fresh getAppDb().
//
//   node scripts/test-settings-persist.mjs
//
// Bundles the REAL src/main/ipc/settings.ipc.ts + db/database.ts with esbuild
// (verify-classification.mjs pattern), aliasing `electron` to a stub whose
// app.getPath('userData') points at a temp dir and whose ipcMain.handle just
// captures the handlers. The registered settings:get/set handlers then run
// end-to-end against a real app.sqlite (full migrate() chain included):
//   1. set -> get round-trips an object value through the JSON encoding.
//   2. closeDbs() (simulated app restart) -> a FRESH getAppDb() still reads it.
//   3. Overwrite updates in place (key stays PRIMARY-KEY unique).
//   4. Missing key -> { value: null } (the old in-memory contract).
//   5. Primitives (string/number/boolean/null) survive the restart too.
//   6. Direct readSetting on a corrupt (non-JSON) row -> null, no throw.
// Exit 1 on any failure; prints an ALL GREEN line when everything passes.

import { execSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(path.join(tmpdir(), 'settings-persist-'))
const userData = path.join(dir, 'userData')
mkdirSync(userData, { recursive: true })

// ---- electron stub: userData -> temp dir; ipcMain.handle -> capture map ----
const stubPath = path.join(dir, 'electron-stub.mjs')
writeFileSync(
  stubPath,
  `export const app = { getPath: () => ${JSON.stringify(userData)} }
export const ipcMain = {
  handle: (channel, fn) => { globalThis.__handlers ??= {}; globalThis.__handlers[channel] = fn }
}
`
)

// ---- bundle entry: real settings ipc + the db lifecycle helpers ----
const entryPath = path.join(dir, 'entry.mjs')
writeFileSync(
  entryPath,
  `export * from ${JSON.stringify(path.join(repoRoot, 'src/main/ipc/settings.ipc.ts'))}
export { configureDb, getAppDb, closeDbs } from ${JSON.stringify(path.join(repoRoot, 'src/main/db/database.ts'))}
`
)
const out = path.join(dir, 'settings.bundle.mjs')
execSync(
  `npx esbuild ${entryPath} --bundle --platform=node --format=esm --alias:electron=${stubPath} --outfile=${out}`,
  { stdio: 'pipe', cwd: repoRoot }
)
const M = await import(pathToFileURL(out).href)

// DB seam (WEB-PORT-SPEC W1): database.ts takes an injected dir, not app.getPath.
M.configureDb({ appDbDir: userData })

let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL  ${name}`)
    console.error(`      ${err.message}`)
  }
}

// The handlers registered by the real registerSettings(), invoked like ipcMain
// would (with an allowed sender frame).
M.registerSettings()
const handlers = globalThis.__handlers
const ev = { senderFrame: { url: 'file:///index.html' } }
const set = (key, value) => handlers['settings:set'](ev, { key, value })
const get = (key) => handlers['settings:get'](ev, { key })

const board = { theme: 'wood', coords: true, size: 3 }
const prims = { s: 'dark', n: 42.5, b: false, z: null }

// 1) set -> get round-trip of a structured value (creates a real app.sqlite via
//    the full migrate() chain).
await check('object value round-trips through settings:set/get', async () => {
  assert.deepEqual(await set('boardTheme', board), { ok: true })
  assert.deepEqual(await get('boardTheme'), { value: board })
})

// 5-prep) primitives written BEFORE the restart so they must survive it too.
for (const [k, v] of Object.entries(prims)) await set(`prim.${k}`, v)

// 2) simulated restart: close the db; the next handler call opens a FRESH
//    getAppDb() on the same app.sqlite file.
M.closeDbs()
await check('set survives a fresh getAppDb() (restart)', async () => {
  assert.deepEqual(await get('boardTheme'), { value: board })
})

// 5) primitives after the restart.
await check('primitives survive the restart', async () => {
  for (const [k, v] of Object.entries(prims)) {
    assert.deepEqual(await get(`prim.${k}`), { value: v })
  }
})

// 3) overwrite (upsert, not duplicate-insert).
await check('overwrite updates in place (single row per key)', async () => {
  await set('boardTheme', { theme: 'marble' })
  assert.deepEqual(await get('boardTheme'), { value: { theme: 'marble' } })
  const probe = new DatabaseSync(path.join(userData, 'app.sqlite'), { readOnly: true })
  const row = probe.prepare("SELECT COUNT(*) AS n FROM setting WHERE key='boardTheme'").get()
  probe.close()
  assert.equal(row.n, 1)
})

// 4) missing key -> null (old in-memory contract preserved).
await check('missing key reads as null', async () => {
  assert.deepEqual(await get('never.set'), { value: null })
})

// 6) corrupt row behaves like unset (no throw).
await check('corrupt (non-JSON) row reads as null', () => {
  const db = M.getAppDb()
  db.prepare('INSERT INTO setting(key, value) VALUES (?,?)').run('corrupt.key', '{not json')
  assert.equal(M.readSetting(db, 'corrupt.key'), null)
})

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nALL GREEN: settings persist across a fresh getAppDb()')
