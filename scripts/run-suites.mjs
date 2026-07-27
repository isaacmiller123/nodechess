#!/usr/bin/env node
// Aggregate suite runner: runs every scripts/test-*.mjs that is not on the
// deny-list below, one at a time, in plain node.
//
//   node scripts/run-suites.mjs                    the whole wall (this is `npm test`)
//   node scripts/run-suites.mjs --only=judge       only suites whose filename contains "judge"
//   node scripts/run-suites.mjs --only=go,flip     comma-separated: any substring matches
//   node scripts/run-suites.mjs --list             print the plan and exit, run nothing
//
// Why this exists: the wall used to be a hardcoded list of stems inside
// .github/workflows/build.yml, so a new suite was covered only when someone
// remembered to edit a YAML string. Globbing means a suite is covered the day
// it lands, and the deny-list makes every exclusion visible with its reason.
//
// A suite passes iff it EXITS 0. Nothing here parses suite output. Suites keep
// their own stdout (stdio is inherited) so a red leg still prints its failure.
// One failure does not abort the wall (the bash loop this replaced did, under
// `set -e`): every suite runs and the failures are listed together at the end.

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = path.join(ROOT, 'scripts')

// ---- deny-list ----------------------------------------------------------------
// Named suites this runner never runs, each with the reason it cannot.
const DENIED = new Map([
  [
    'test-bot-legality.mjs',
    'Part B spawns resources/engine/mac/fairy-stockfish, a local mac-only binary CI does not carry (it exits 1 when the file is absent)'
  ],
  [
    'test-bots-ui.mjs',
    'the bots-UI engine-provider probe build.yml has always kept local, paired with scripts/verify-bots-live.mjs against real KataGo/lc0'
  ]
])

// .github/workflows/web.yml owns the web target end to end: it builds the SPA +
// server bundles and provisions headless chromium first, then runs the whole
// scripts/test-web-*.mjs glob itself. Running them here would fail on inputs
// this wall never produces.
const DENIED_PREFIX = 'test-web-'
const DENIED_PREFIX_WHY = 'owned by .github/workflows/web.yml (needs the SPA/server bundles and chromium)'

const denyReason = (file) =>
  DENIED.get(file) ?? (file.startsWith(DENIED_PREFIX) ? DENIED_PREFIX_WHY : null)

// ---- args ---------------------------------------------------------------------

const ONLY_FLAG = '--only='
let only = []
let listOnly = false
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith(ONLY_FLAG))
    only = arg
      .slice(ONLY_FLAG.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  else if (arg === '--list') listOnly = true
  else {
    console.error(`run-suites: unknown argument "${arg}"`)
    console.error('usage: node scripts/run-suites.mjs [--only=<substring>[,<substring>]] [--list]')
    process.exit(1)
  }
}

// ---- plan ---------------------------------------------------------------------

const all = readdirSync(SCRIPTS)
  .filter((f) => f.startsWith('test-') && f.endsWith('.mjs'))
  .sort()

const skipped = []
const plan = []
for (const file of all) {
  const why = denyReason(file)
  if (why) skipped.push([file, why])
  else if (only.length === 0 || only.some((s) => file.includes(s))) plan.push(file)
}

for (const [file, why] of skipped) console.log(`skip  ${file}  (${why})`)
if (only.length > 0)
  console.log(
    `only  ${only.join(', ')} matches ${plan.length} of ${all.length - skipped.length} runnable suites`
  )

if (plan.length === 0) {
  console.error(
    only.length > 0
      ? `\nrun-suites: --only=${only.join(',')} matched no suite. Nothing ran.`
      : '\nrun-suites: found no scripts/test-*.mjs to run.'
  )
  process.exit(1)
}

if (listOnly) {
  for (const file of plan) console.log(file)
  process.exit(0)
}

// ---- run ----------------------------------------------------------------------

const failed = []
const wallStart = Date.now()

for (const file of plan) {
  console.log(`\n== ${file} ==`)
  const started = Date.now()
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, file)], {
    cwd: ROOT,
    stdio: 'inherit'
  })
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  if (res.error) {
    failed.push(file)
    console.log(`FAIL  ${file} (${secs}s, could not spawn: ${res.error.message})`)
  } else if (res.status === 0) {
    console.log(`ok    ${file} (${secs}s)`)
  } else {
    failed.push(file)
    console.log(`FAIL  ${file} (${secs}s, ${res.signal ? `killed by ${res.signal}` : `exit ${res.status}`})`)
  }
}

// ---- verdict ------------------------------------------------------------------

const wallSecs = ((Date.now() - wallStart) / 1000).toFixed(1)
console.log(
  `\n${plan.length} suite(s) run in ${wallSecs}s, ${failed.length} failed, ${skipped.length} skipped`
)
if (failed.length > 0) {
  for (const file of failed) console.log(`  FAILED  ${file}`)
  process.exit(1)
}
console.log('ALL GREEN')
