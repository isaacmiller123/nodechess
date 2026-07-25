#!/usr/bin/env node
// Golden tests for src/main/analysis/estElo.ts against the fitted model
// (scripts/data/elo-fit.json) and the HELD-OUT corpus rows (the ~20% of
// scripts/data/elo-corpus.jsonl never seen by scripts/fit-elo-model.mjs).
//
// Asserts:
//  1. Holdout MAE (with and without oppElo) within the fit's reported bound.
//  2. Monotonicity: est is nondecreasing in accuracy (other inputs fixed).
//  3. Bands WIDEN for short games (nMoves 10 vs 45).
//  4. Opponent-delta direction matches the fitted slope's sign.
//  5. estimateElo(acc, n, acpl) === estimateEloEx equivalent (back-compat).
//  6. Band sanity: floor <= low <= est <= high <= ceil, kind === 'estimate'.
//
//   node scripts/test-est-elo.mjs
//
// Bundles estElo.ts with esbuild (verify-classification.mjs pattern). Exit 1
// on any failure; prints an ALL GREEN line when everything passes.

import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(path.join(tmpdir(), 'estelo-'))
const out = path.join(dir, 'estElo.mjs')
execSync(
  `npx esbuild src/main/analysis/estElo.ts --bundle --platform=node --format=esm --outfile=${out}`,
  { stdio: 'pipe', cwd: repoRoot }
)
const E = await import(pathToFileURL(out).href)

const fit = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/data/elo-fit.json'), 'utf8'))

// Holdout split: FNV-1a mirror of fit-elo-model.mjs.
function hashKey(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
const corpus = readFileSync(path.join(repoRoot, fit.corpus), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => Number.isFinite(r.accuracy) && r.nMoves >= 4)
const holdout = corpus.filter((r) => hashKey(r.gameKey) % 5 === 0)

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

// ---- 1. Holdout MAE within the fit's reported bound --------------------------------

// Small slack for the rounded constants inlined into estElo.ts.
const SLACK = 10

const maeWith =
  holdout.reduce(
    (a, r) =>
      a +
      Math.abs(
        E.estimateEloEx({ accuracy: r.accuracy, acpl: r.acpl, nMoves: r.nMoves, oppElo: r.oppElo })
          .est - r.trueElo
      ),
    0
  ) / holdout.length
check(
  `holdout MAE with oppElo <= reported ${fit.mae['with opp (Ex+oppElo)'].holdout} + ${SLACK}`,
  maeWith <= fit.mae['with opp (Ex+oppElo)'].holdout + SLACK,
  `measured ${maeWith.toFixed(1)} over ${holdout.length} rows`
)

const maeNo =
  holdout.reduce(
    (a, r) =>
      a +
      Math.abs(
        E.estimateEloEx({ accuracy: r.accuracy, acpl: r.acpl, nMoves: r.nMoves }).est - r.trueElo
      ),
    0
  ) / holdout.length
check(
  `holdout MAE without oppElo <= reported ${fit.mae['no opp (estimateElo)'].holdout} + ${SLACK}`,
  maeNo <= fit.mae['no opp (estimateElo)'].holdout + SLACK,
  `measured ${maeNo.toFixed(1)}`
)

// ---- 2. Monotonicity in accuracy -----------------------------------------------------

for (const cfg of [
  { name: 'acpl 60, n 40', acpl: 60, nMoves: 40 },
  { name: 'acpl 25, n 12', acpl: 25, nMoves: 12 },
  { name: 'no acpl, n 30', acpl: undefined, nMoves: 30 },
  { name: 'acpl 60, n 40, opp 1500', acpl: 60, nMoves: 40, oppElo: 1500 }
]) {
  let prev = -Infinity
  let mono = true
  let badAt = null
  for (let a = 5; a <= 99.5; a += 0.25) {
    const est = E.estimateEloEx({ accuracy: a, ...cfg }).est
    if (est < prev - 1e-9) {
      mono = false
      badAt = a
      break
    }
    prev = est
  }
  check(`monotone in accuracy (${cfg.name})`, mono, badAt != null ? `drops at acc ${badAt}` : '')
}

// ---- 3. Bands widen for short games ---------------------------------------------------

for (const acc of [70, 85, 93]) {
  const short = E.estimateEloEx({ accuracy: acc, acpl: 60, nMoves: 10 })
  const long = E.estimateEloEx({ accuracy: acc, acpl: 60, nMoves: 45 })
  check(
    `band widens for short games @acc ${acc}`,
    short.high - short.low > long.high - long.low,
    `±${(short.high - short.low) / 2} @10 moves vs ±${(long.high - long.low) / 2} @45`
  )
}
{
  const short = E.estimateElo(85, 10, 60)
  const long = E.estimateElo(85, 45, 60)
  check(
    'band widens for short games via legacy estimateElo',
    short.high - short.low > long.high - long.low
  )
}

// ---- 4. Opponent-delta direction -------------------------------------------------------

{
  // Fitted structural slope g: est = (estNoOpp - g*opp)/(1-g), so
  // d(est)/d(opp) = -g/(1-g); direction must match the fit.
  const dir = Math.sign(-fit.coef.gOpp / (1 - fit.coef.gOpp))
  const lo = E.estimateEloEx({ accuracy: 85, acpl: 60, nMoves: 40, oppElo: 1200 }).est
  const hi = E.estimateEloEx({ accuracy: 85, acpl: 60, nMoves: 40, oppElo: 2000 }).est
  const ok = dir === 0 ? hi === lo : Math.sign(hi - lo) === dir || hi === lo
  check(
    `opponent delta direction matches fit (g=${fit.coef.gOpp} => ${dir >= 0 ? 'stronger opp raises est' : 'stronger opp lowers est'})`,
    ok,
    `est vs 1200 = ${lo}, vs 2000 = ${hi}`
  )
}

// ---- 5. Back-compat: estimateElo delegates to estimateEloEx ----------------------------

{
  const a = E.estimateElo(83.4, 27, 55)
  const b = E.estimateEloEx({ accuracy: 83.4, nMoves: 27, acpl: 55 })
  check('estimateElo(acc, n, acpl) === estimateEloEx equivalent', a.est === b.est && a.low === b.low && a.high === b.high)
  const c = E.estimateElo(72.1)
  const d = E.estimateEloEx({ accuracy: 72.1 })
  check('estimateElo(acc) === estimateEloEx({accuracy}) (defaults)', c.est === d.est && c.low === d.low && c.high === d.high)
}

// ---- 6. Band shape sanity ----------------------------------------------------------------

{
  let ok = true
  let bad = ''
  for (const r of holdout.slice(0, 200)) {
    const b = E.estimateEloEx({ accuracy: r.accuracy, acpl: r.acpl, nMoves: r.nMoves, oppElo: r.oppElo })
    if (
      !(b.low <= b.est && b.est <= b.high) ||
      b.low < fit.clamp.floor ||
      b.high > fit.clamp.ceil ||
      b.kind !== 'estimate'
    ) {
      ok = false
      bad = JSON.stringify(b)
      break
    }
  }
  check('band shape: floor <= low <= est <= high <= ceil, kind estimate', ok, bad)
}

console.log(
  failures === 0
    ? `\nALL GREEN: ${holdout.length} holdout rows, MAE ${maeWith.toFixed(1)} (with opp) / ${maeNo.toFixed(1)} (without)`
    : `\n${failures} FAILED`
)
process.exit(failures ? 1 : 0)
