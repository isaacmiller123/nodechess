#!/usr/bin/env node
// School re-place chain-unlock suite (audit backlog #school-replace).
//
//   node scripts/test-school-replace.mjs
//
// Proves the v1.1.5 fix pair end-to-end against the REAL curriculum + the REAL
// IPC handlers:
//   - school.repo.chapterMetas: the progression chain only links from a cleared
//     chapter WITHIN the current estimate, so a re-placement that lands LOWER
//     never leaves chapters above the fresh estimate unlocked through the old
//     epoch's surviving earned completions.
//   - placement.repo.resetPlacement: retracts ONLY the placement's own
//     auto_completed rows: earned chapter/lesson progress and chapter_test
//     history (best_pct) always survive.
//
// Bundling (settings-persist pattern): esbuild bundles ipc/school.ipc.ts +
// db/database.ts + analysis/estElo.ts with `electron` aliased to a stub whose
// app.getPath('userData') is a temp dir and app.isPackaged=true, so
// school.repo's chaptersDir() reads the SHIPPED 40 chapters (real eloFloors)
// via process.resourcesPath -> <repo>/resources. school.repo references
// __dirname in its dev path, so the bundle is CJS (loaded via createRequire).
// The app.sqlite is created through the full migrate() chain, no schema stubs.
//
// Scenario (the audit's exact one):
//   0. Unplaced: every chapter locked (lockReason 'placement'); metas never
//      leak eloFloor.
//   1. Place HIGH -> unlocked == the floor<=est prefix; everything below the
//      top unlocked chapter is auto-completed, the top itself is not.
//   2. Positive case: EARN the top in-estimate chapter (test pass + a lesson)
//      -> EXACTLY ONE chapter above the estimate unlocks (the chain link).
//   3. Re-place LOWER (reset + one weak game) -> NO chapter above the fresh
//      estimate is unlocked. The old epoch's earned completion must NOT chain
//      its successor open, while best_pct / earned completion rows survive.
//   4. The documented climb path still works in the low epoch: pass the top
//      in-estimate chapter's test -> one above unlocks; pass THAT one's test
//      -> the estimate bumps to its band and the chain extends one further.
// Exit 1 on any failure; prints an ALL GREEN line when everything passes.

import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(path.join(tmpdir(), 'school-replace-'))
const userData = path.join(dir, 'userData')
mkdirSync(userData, { recursive: true })

// school.repo reads the packaged curriculum from process.resourcesPath when
// app.isPackaged: point it at the repo's resources BEFORE the bundle loads.
process.resourcesPath = path.join(repoRoot, 'resources')

// ---- electron stub: packaged app in a temp userData; ipcMain captures ----
const stubPath = path.join(dir, 'electron-stub.mjs')
writeFileSync(
  stubPath,
  `export const app = { isPackaged: true, getPath: () => ${JSON.stringify(userData)} }
export const ipcMain = {
  handle: (channel, fn) => { globalThis.__handlers ??= {}; globalThis.__handlers[channel] = fn }
}
`
)

// ---- bundle entry: the real school IPC + db lifecycle + the Elo estimator ----
const entryPath = path.join(dir, 'entry.mjs')
writeFileSync(
  entryPath,
  `export { registerSchool } from ${JSON.stringify(path.join(repoRoot, 'src/main/ipc/school.ipc.ts'))}
export { configureDb, getAppDb, closeDbs } from ${JSON.stringify(path.join(repoRoot, 'src/main/db/database.ts'))}
export { estimateElo } from ${JSON.stringify(path.join(repoRoot, 'src/main/analysis/estElo.ts'))}
`
)
const out = path.join(dir, 'school.bundle.cjs')
execSync(
  `npx esbuild ${entryPath} --bundle --platform=node --format=cjs --alias:electron=${stubPath} --outfile=${out}`,
  { stdio: 'pipe', cwd: repoRoot }
)
const M = createRequire(import.meta.url)(out)

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

// DB seam (docs/WEB-PORT-SPEC.md W1): database.ts no longer reads electron.
// Inject the temp userData directly, like src/main/index.ts does at boot.
M.configureDb({ appDbDir: userData })

M.registerSchool()
const handlers = globalThis.__handlers
const ev = { senderFrame: { url: 'file:///index.html' } }
const call = (channel, payload = {}) => handlers[channel](ev, payload)

// The curriculum in canonical order, floors included (the SERVER-side view; the
// metas the client sees never carry them. Asserted below).
const db = M.getAppDb()
const chaptersResp = await call('school:chapters')
const metas0 = chaptersResp.chapters
assert.ok(metas0.length >= 40, `expected the shipped 40-chapter curriculum, got ${metas0.length}`)

// Rebuild id -> eloFloor from the chapter JSON directly (same files the bundle
// reads) so the test can compute expected unlock prefixes.
const chDir = path.join(repoRoot, 'resources/curriculum/chapters')
const floors = new Map()
for (const f of readdirSync(chDir).filter((f) => f.endsWith('.json'))) {
  const c = JSON.parse(readFileSync(path.join(chDir, f), 'utf-8'))
  floors.set(c.id, c.eloFloor ?? 0)
}
const orderIds = metas0.map((m) => m.id) // chapterMetas is already canonical order
const floorOf = (id) => floors.get(id) ?? 0

// Pick calibration accuracies from the REAL estimator so the scenario is
// deterministic yet stays valid if the model is refit: a HIGH game landing in
// [1700,1840] (top ~ch31-37; >=2 chapters above for "exactly one" asserts) and
// a LOW one in [600,1000].
function accFor(lo, hi) {
  for (let acc = 40; acc <= 99.75; acc += 0.25) {
    const est = M.estimateElo(acc, 40).est
    if (est >= lo && est <= hi) return acc
  }
  throw new Error(`no accuracy maps into est [${lo},${hi}], recalibrate the test bands`)
}
const ACC_HIGH = accFor(1700, 1840)
const ACC_LOW = accFor(600, 1000)

const chapterList = async () => (await call('school:chapters')).chapters
const unlockedIds = (metas) => metas.filter((m) => !m.locked).map((m) => m.id)
const prefixIds = (est) => orderIds.filter((id) => floorOf(id) <= est)

// ---------------------------------------------------------------------------
// 0) Unplaced: everything locked; the metas never leak the internal Elo.
// ---------------------------------------------------------------------------
await check('unplaced: all chapters locked with lockReason=placement', async () => {
  for (const m of metas0) {
    assert.equal(m.locked, true, `${m.id} unlocked before placement`)
    assert.equal(m.lockReason, 'placement')
  }
})
await check('metas never expose eloFloor (spec §2.2a)', async () => {
  for (const m of metas0) assert.ok(!('eloFloor' in m), `${m.id} leaks eloFloor`)
})

// ---------------------------------------------------------------------------
// 1) Place HIGH: the floor<=est prefix unlocks; below-top auto-completes.
// ---------------------------------------------------------------------------
const stateHigh = await call('school:recordPlacementGame', {
  engineElo: 1500,
  accuracy: ACC_HIGH,
  moveCount: 40
})
const estHigh = stateHigh.estimatedElo
const highPrefix = prefixIds(estHigh)
const topHighId = highPrefix[highPrefix.length - 1]
const topHighIdx = orderIds.indexOf(topHighId)
const oneAboveHighId = orderIds[topHighIdx + 1]
const twoAboveHighId = orderIds[topHighIdx + 2]

await check(`high placement (est=${estHigh}) unlocks exactly the within-estimate prefix`, async () => {
  assert.ok(estHigh >= 1700 && estHigh <= 1840, `estHigh ${estHigh} outside the scenario band`)
  assert.deepEqual(unlockedIds(await chapterList()), highPrefix)
})

await check('placement auto-completes everything below the top unlocked chapter', async () => {
  const mastery = await call('school:mastery')
  const completed = new Set(mastery.chapters.filter((c) => c.completed).map((c) => c.chapterId))
  for (const id of highPrefix.slice(0, -1)) assert.ok(completed.has(id), `${id} not pre-completed`)
  assert.ok(!completed.has(topHighId), 'top (current) chapter must NOT be pre-completed')
  const autos = db
    .prepare('SELECT COUNT(*) n FROM chapter_progress WHERE auto_completed=1')
    .get()
  assert.equal(autos.n, highPrefix.length - 1)
})

// ---------------------------------------------------------------------------
// 2) Positive case in the high epoch: EARN the top chapter -> exactly ONE
//    chapter above the estimate unlocks.
// ---------------------------------------------------------------------------
const topHighChapter = (await call('school:chapter', { id: topHighId })).chapter
const earnedLessonId = topHighChapter.lessons[0].id

await check('earning the top in-estimate chapter unlocks exactly one above', async () => {
  // Earn a lesson (auto_completed=0 row) + pass the test (earned completion).
  await call('school:recordLesson', { chapterId: topHighId, lessonId: earnedLessonId })
  const res = await call('school:recordTest', { chapterId: topHighId, scorePct: 0.9, attemptNo: 1 })
  assert.equal(res.passed, true)
  assert.equal(res.bestPct, 0.9)
  const unlocked = unlockedIds(await chapterList())
  assert.deepEqual(unlocked, [...highPrefix, oneAboveHighId], 'chain must add ONE chapter')
  assert.ok(!unlocked.includes(twoAboveHighId), 'two-above must stay locked')
})

// ---------------------------------------------------------------------------
// 3) Re-place LOWER: reset (earned rows survive) + one weak game. THE audit
//    regression: the surviving earned completion of topHigh must NOT chain
//    oneAboveHigh open.
// ---------------------------------------------------------------------------
await check('resetPlacement relocks all, prunes ONLY auto rows, keeps earned history', async () => {
  await call('school:resetPlacement')
  for (const m of await chapterList()) {
    assert.equal(m.locked, true, `${m.id} unlocked after reset`)
    assert.equal(m.lockReason, 'placement')
  }
  const placed = db.prepare('SELECT placed FROM school_placement WHERE id=1').get()
  assert.equal(placed.placed, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM placement_game').get().n, 0)
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM chapter_progress WHERE auto_completed=1').get().n,
    0,
    'auto chapter rows must be pruned'
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM lesson_progress WHERE auto_completed=1').get().n,
    0,
    'auto lesson rows must be pruned'
  )
  // Earned rows survive the reset.
  const top = db
    .prepare('SELECT completed, auto_completed FROM chapter_progress WHERE chapter_id=?')
    .get(topHighId)
  assert.equal(top?.completed, 1, 'earned completion must survive')
  assert.equal(top?.auto_completed, 0)
  const lesson = db
    .prepare('SELECT done FROM lesson_progress WHERE chapter_id=? AND lesson_id=?')
    .get(topHighId, earnedLessonId)
  assert.equal(lesson?.done, 1, 'earned lesson must survive')
})

const stateLow = await call('school:recordPlacementGame', {
  engineElo: 1500,
  accuracy: ACC_LOW,
  moveCount: 40
})
const estLow = stateLow.estimatedElo
const lowPrefix = prefixIds(estLow)
const topLowId = lowPrefix[lowPrefix.length - 1]
const topLowIdx = orderIds.indexOf(topLowId)
const oneAboveLowId = orderIds[topLowIdx + 1]
const twoAboveLowId = orderIds[topLowIdx + 2]
const threeAboveLowId = orderIds[topLowIdx + 3]

await check(`re-place LOWER (est=${estLow}): nothing above the fresh estimate is unlocked`, async () => {
  assert.ok(estLow >= 600 && estLow <= 1000, `estLow ${estLow} outside the scenario band`)
  assert.ok(estLow < estHigh - 400, 'scenario needs a genuinely lower re-placement')
  const metas = await chapterList()
  // The audit's exact regression: topHigh is cleared (earned completion + test
  // pass survived the reset) but sits ABOVE the fresh estimate. Its successor
  // must NOT be chain-unlocked, and neither may anything else above estLow.
  assert.deepEqual(unlockedIds(metas), lowPrefix, 'unlocked must be exactly the low prefix')
  const byId = new Map(metas.map((m) => [m.id, m]))
  assert.equal(byId.get(topHighId)?.locked, true, 'the earned high chapter re-locks (history only)')
  assert.equal(
    byId.get(oneAboveHighId)?.locked,
    true,
    'REGRESSION: cleared-above-estimate chapter must not chain-unlock its successor'
  )
  for (const m of metas) if (m.locked) assert.equal(m.lockReason, 'elo')
})

await check('earned best_pct/pass and completion history survive the lower re-place', async () => {
  const ts = await call('school:testState', { chapterId: topHighId })
  assert.equal(ts.bestPct, 0.9, 'best_pct must survive')
  assert.equal(ts.passed, true, 'pass history must survive')
  const mastery = await call('school:mastery')
  assert.ok(
    mastery.chapters.some((c) => c.chapterId === topHighId && c.completed),
    'earned completion must still read as history'
  )
  assert.ok(
    mastery.lessons.some((l) => l.chapterId === topHighId && l.lessonId === earnedLessonId),
    'earned lesson must still read as history'
  )
})

// ---------------------------------------------------------------------------
// 4) The climb path still works in the low epoch: pass the top, one unlocks;
//    pass THAT one, the estimate bumps to its band and the chain extends.
// ---------------------------------------------------------------------------
await check('low epoch: completing the top in-estimate chapter unlocks exactly one above', async () => {
  const res = await call('school:recordTest', { chapterId: topLowId, scorePct: 0.85, attemptNo: 1 })
  assert.equal(res.passed, true)
  const unlocked = unlockedIds(await chapterList())
  assert.deepEqual(unlocked, [...lowPrefix, oneAboveLowId])
  assert.ok(!unlocked.includes(twoAboveLowId), 'two-above must stay locked')
})

await check('passing the one-above chapter bumps the estimate and extends the chain by one', async () => {
  const res = await call('school:recordTest', { chapterId: oneAboveLowId, scorePct: 0.85, attemptNo: 1 })
  assert.equal(res.passed, true)
  // bumpPlacementFloor raised the estimate to oneAboveLow's floor, so the
  // prefix now includes it AND its cleared state chains the next one open.
  const est = (await call('school:placementState')).estimatedElo
  assert.equal(est, floorOf(oneAboveLowId), 'estimate must bump to the passed band')
  const unlocked = unlockedIds(await chapterList())
  const expected = [...orderIds.filter((id) => floorOf(id) <= est)]
  if (!expected.includes(twoAboveLowId)) expected.push(twoAboveLowId)
  assert.deepEqual(unlocked, expected)
  if (threeAboveLowId && floorOf(threeAboveLowId) > est) {
    assert.ok(!unlocked.includes(threeAboveLowId), 'chain extends by ONE, not more')
  }
})

M.closeDbs()

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nALL GREEN: re-place-lower keeps above-estimate chapters locked; earned history survives')
