#!/usr/bin/env node
// A5 J3 suite: the judge-config estElo refit artifacts. CHEAP: no engine, no
// network; pure JSON/TS checks, safe for default CI runs.
//
//   node scripts/test-judge-fit.mjs
//
// Asserts:
//  1. scripts/data/judge-elo-fit.json exists and is schema-valid.
//  2. The judge corpus it names exists, rows carry a UNIFORM judge config
//     stamp (judgeNodes/judgeMultiPv/judgeParams) matching PARAMS_A5 tier 1.
//  3. Monotone calibration curves: accuracy→Elo nondecreasing, acpl→Elo
//     nonincreasing (knot-level AND a piecewise-linear evaluation sweep).
//  4. src/shared/accounts/judge/anchors.ts loads (esbuild, test-judge-node
//     pattern) and ROUND-TRIPS the fit JSON exactly: integer knots/coefs/MAE
//     metadata, inverted elo→acplMicro anchor knots, and sigmaAcplMicro
//     recomputed from the corpus through the REAL tier1.expectedAcplMicro.
//  5. Anchors pass J2's checkAnchors (via expectedAcplMicro) and interpolate
//     sanely; the fitted params digest equals the CURRENT PARAMS_A5_DIGEST
//     (loud drift detection: a params change must trigger a J3 re-fit).
//  6. Holdout MAE recorded in the file is under the sanity ceiling:
//     with-opp ≤ 400, no-opp ≤ 450 Elo. Rationale: measured 296.4 / 331.8 on
//     this fit and ≈275 / ≈325 on the shipped depth-12 baseline; a fit that
//     breaches 400/450 is in the "completely inaccurate" regressed regime the
//     fit header documents (plain-OLS failure mode ≈450+) and must not ship.
//
// Style: failures counter, section banners, per-assert one-line, exit(failures?1:0).

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const FIT_PATH = resolve(ROOT, 'scripts/data/judge-elo-fit.json')

let passed = 0
let failures = 0
function ok(cond, msg) {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.log(`  ✗ ${msg}`)
  }
}
function eq(a, b, msg) {
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}
function section(t) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`)
}

// ── 1. fit JSON exists + schema ─────────────────────────────────────────────
section('judge-elo-fit.json: exists + schema')
ok(existsSync(FIT_PATH), 'scripts/data/judge-elo-fit.json exists')
const fit = JSON.parse(readFileSync(FIT_PATH, 'utf8'))
ok(typeof fit.fitDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fit.fitDate), `fitDate is a date (${fit.fitDate})`)
eq(fit.corpus, 'scripts/data/judge-elo-corpus.jsonl', 'fit names the judge corpus')
ok(Number.isInteger(fit.corpusRows) && fit.corpusRows > 0, `corpusRows > 0 (${fit.corpusRows})`)
ok(Number.isInteger(fit.trainRows) && Number.isInteger(fit.holdoutRows), 'train/holdout row counts are integers')
eq(fit.trainRows + fit.holdoutRows, fit.corpusRows, 'train + holdout == corpus rows')
const knotShape = (ks) =>
  Array.isArray(ks) && ks.length >= 2 && ks.every((k) => Number.isFinite(k.feat) && Number.isInteger(k.elo))
ok(knotShape(fit.accKnots), `accKnots well-formed (${fit.accKnots?.length} knots)`)
ok(knotShape(fit.acplKnots), `acplKnots well-formed (${fit.acplKnots?.length} knots)`)
for (const c of ['a0', 'a1', 'c0', 'bShrink', 'gOpp']) ok(Number.isFinite(fit.coef?.[c]), `coef.${c} is finite (${fit.coef?.[c]})`)
ok(fit.coef.a1 >= 0 && fit.coef.a1 <= 1, 'blend weight a1 in [0,1]')
ok(fit.coef.bShrink <= 0 && fit.coef.bShrink >= -0.32, 'bShrink in the bounded shrink-only range')
ok(fit.clamp?.floor === 250 && fit.clamp?.ceil === 3000, 'clamp [250, 3000]')
ok(fit.shrink?.center === 1500 && fit.shrink?.fullMoves === 30 && fit.shrink?.minMoves === 6, 'shrink constants unchanged')
for (const v of ['no opp (estimateElo)', 'with opp (Ex+oppElo)', 'acc only (no acpl)'])
  ok(Number.isFinite(fit.mae?.[v]?.holdout), `mae["${v}"].holdout recorded (${fit.mae?.[v]?.holdout})`)

// ── 2. corpus rows: uniform judge-config stamp ──────────────────────────────
section('judge corpus: uniform judge-config stamp')
const CORPUS_PATH = resolve(ROOT, fit.corpus)
ok(existsSync(CORPUS_PATH), 'judge corpus exists')
const rows = readFileSync(CORPUS_PATH, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
const fitRows = rows.filter((r) => Number.isFinite(r.accuracy) && r.nMoves >= 4)
eq(fitRows.length, fit.corpusRows, 'fit corpusRows == filtered corpus row count')
ok(
  rows.every(
    (r) =>
      Number.isInteger(r.trueElo) &&
      Number.isInteger(r.oppElo) &&
      Number.isFinite(r.accuracy) &&
      Number.isFinite(r.acpl) &&
      Number.isInteger(r.nMoves) &&
      typeof r.gameKey === 'string'
  ),
  'every row carries trueElo/oppElo/accuracy/acpl/nMoves/gameKey'
)
const uniq = (f) => new Set(rows.map(f))
eq(uniq((r) => r.judgeNodes).size, 1, 'judgeNodes uniform across the corpus')
eq(uniq((r) => r.judgeMultiPv).size, 1, 'judgeMultiPv uniform across the corpus')
eq(uniq((r) => r.judgeParams).size, 1, 'judgeParams digest uniform across the corpus')

// ── 3. monotone calibration curves ──────────────────────────────────────────
section('monotone eloAcc / eloAcpl curves')
{
  const a = fit.accKnots
  ok(a.every((k, i) => i === 0 || k.feat > a[i - 1].feat), 'accKnots: feature strictly ascending')
  ok(a.every((k, i) => i === 0 || k.elo >= a[i - 1].elo), 'accKnots: Elo nondecreasing (PAV held)')
  const c = fit.acplKnots
  ok(c.every((k, i) => i === 0 || k.feat < c[i - 1].feat), 'acplKnots: feature strictly descending along the ladder')
  ok(c.every((k, i) => i === 0 || k.elo >= c[i - 1].elo), 'acplKnots: Elo nondecreasing (PAV held)')
}
// Piecewise-linear evaluation mirror of fit-elo-model.mjs knotElo().
function knotElo(knots, v) {
  const asc = knots.length < 2 || knots[1].feat >= knots[0].feat
  const ks = asc ? knots : [...knots].reverse()
  if (v <= ks[0].feat) return ks[0].elo
  const last = ks[ks.length - 1]
  if (v >= last.feat) return last.elo
  for (let i = 1; i < ks.length; i++) {
    if (v <= ks[i].feat) {
      const lo = ks[i - 1]
      const hi = ks[i]
      const t = (v - lo.feat) / (hi.feat - lo.feat)
      return lo.elo + t * (hi.elo - lo.elo)
    }
  }
  return last.elo
}
{
  let mono = true
  let prev = -Infinity
  for (let acc = 0; acc <= 100; acc += 0.25) {
    const e = knotElo(fit.accKnots, acc)
    if (e < prev - 1e-9) mono = false
    prev = e
  }
  ok(mono, 'eloAcc(accuracy) nondecreasing over accuracy 0..100 sweep')
  mono = true
  prev = Infinity
  for (let acpl = 0; acpl <= 300; acpl += 1) {
    const e = knotElo(fit.acplKnots, Math.log(1 + acpl))
    if (e > prev + 1e-9) mono = false
    prev = e
  }
  ok(mono, 'eloAcpl(acpl) nonincreasing over acpl 0..300 sweep')
}

// ── 4+5. anchors module: loads + round-trips the JSON ───────────────────────
section('anchors module: loads (esbuild) + round-trips the fit JSON')
const cacheRoot = resolve(ROOT, 'node_modules/.cache/judge-fit-test')
mkdirSync(cacheRoot, { recursive: true })
const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
let M
try {
  const SHARED_JUDGE = resolve(ROOT, 'src/shared/accounts/judge').replace(/\\/g, '/')
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export * as anchors from '${SHARED_JUDGE}/anchors.ts'`,
      `export * as tier1 from '${SHARED_JUDGE}/tier1.ts'`,
      `export * as params from '${SHARED_JUDGE}/params.ts'`,
    ].join('\n')
  )
  const outfile = resolve(outdir, 'anchors.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    absWorkingDir: ROOT,
    logLevel: 'warning',
  })
  M = await import(pathToFileURL(outfile).href)
} finally {
  rmSync(outdir, { recursive: true, force: true })
}
const { anchors, tier1, params } = M
const F = anchors.JUDGE_ELO_FIT
const T = anchors.TIER1_ANCHORS_JUDGE
ok(F && F.v === 1, 'JUDGE_ELO_FIT loads (v1)')
ok(T && T.v === 1, 'TIER1_ANCHORS_JUDGE loads (v1)')

// config + digest pins
eq(F.nodes, params.PARAMS_A5.t1Nodes, 'fit nodes == PARAMS_A5.t1Nodes')
eq(F.multiPv, params.PARAMS_A5.t1MultiPv, 'fit multiPv == PARAMS_A5.t1MultiPv')
eq(F.hashMb, params.PARAMS_A5.hashMb, 'fit hashMb == PARAMS_A5.hashMb')
eq(T.nodes, params.PARAMS_A5.t1Nodes, 'anchors nodes == PARAMS_A5.t1Nodes')
eq(T.multiPv, params.PARAMS_A5.t1MultiPv, 'anchors multiPv == PARAMS_A5.t1MultiPv')
// Digest-drift rule (lead decision, J7 aftermath): JUDGE_ANCHORS_PARAMS_DIGEST
// is the FIT-TIME pin. A historical fact about the corpus's provenance, never
// rewritten. A PARAMS_A5 digest drift alone (e.g. an aggregation-rule row like
// lifetimeScheme) does NOT invalidate the fit: the invariant that keeps
// anchors valid is ENGINE-CONFIG IDENTITY (nodes/multiPv/hashMb/wasm hash):
// nodes/multiPv/hashMb asserted field-by-field above, wasm hash via the
// fit-time golden freeze below (A5-10). A drift that touches any of
// those fields fails those assertions ⇒ re-fit J3. Drift stays visible:
if (anchors.JUDGE_ANCHORS_PARAMS_DIGEST !== params.PARAMS_A5_DIGEST)
  console.log(
    `  · note: PARAMS_A5 digest drifted since fit (${anchors.JUDGE_ANCHORS_PARAMS_DIGEST} → ${params.PARAMS_A5_DIGEST}); engine-config identity asserted instead`
  )
// ── Judge-engine identity: the J3 fit's wasm, asserted still-live (A5-10) ────
// The corpus was judged under the pinned judge WASM, whose sha256 is folded into
// the fit-time JUDGE_ANCHORS_PARAMS_DIGEST (kkHG…); the fit artifact persists NO
// standalone wasmSha256 field, and adding one is an anchors.ts/judge-elo-fit.json
// re-fit surface outside this suite. So this suite FREEZES the fit-time wasm as
// an independent golden literal (as test-judge-node freezes GOLDEN_WASM_SHA256)
// and asserts the LIVE PARAMS_A5.judgeWasmSha256 still equals it. The drift
// rule's engine-identity leg, now genuinely binding. A judge-engine re-pin (new
// build → new judgeWasmSha256 → PARAMS_A5_DIGEST drift) moves the live pin off
// this freeze and FAILS here, forcing a J3 re-fit; pre-fix (A5-10) the leg read
// the wasm from live PARAMS_A5 on BOTH sides (F.wasmSha256 undefined ⇒ the ??
// fallback made it X===X), so any wasm passed and a swap slipped past under the
// benign-drift note. Unlike test-judge-node's blob freeze (re-frozen on ANY
// re-pin), THIS provenance freeze re-freezes ONLY with a J3 corpus re-fit, so a
// re-pin-without-re-fit trips it. [A5-CALIBRATED] re-freeze only with a J3 re-fit.
const FIT_WASM_SHA256 = 'a8fbc05ec6920b56d7485826dcb02c5ffd2826bcbf751cf973046f237a9096f1'
const wasmMatchesFit = (liveSha) => liveSha === FIT_WASM_SHA256
ok(
  wasmMatchesFit(params.PARAMS_A5.judgeWasmSha256),
  `live PARAMS_A5.judgeWasmSha256 == J3 fit-time wasm freeze (engine identity; a re-pin without a J3 re-fit fails here; got ${params.PARAMS_A5.judgeWasmSha256})`
)
// A5-10 non-vacuity regression: the SAME comparator must REJECT a re-pinned
// engine's sha256: pre-fix this leg compared PARAMS_A5 to itself (always green).
ok(
  !wasmMatchesFit('deadbeef'.repeat(8)),
  'A5-10 regression: a re-pinned judge wasm sha256 is REJECTED by the engine-identity guard (non-vacuous)'
)
// Forward-compat: once a J3 re-fit persists a wasmSha256 field on the artifact,
// cross-check it too (must equal the live pin, which equals the freeze above).
if (F.wasmSha256 !== undefined)
  eq(F.wasmSha256, params.PARAMS_A5.judgeWasmSha256, 'persisted fit wasmSha256 == PARAMS_A5.judgeWasmSha256 (config identity)')
eq([...uniq((r) => r.judgeParams)][0], anchors.JUDGE_ANCHORS_PARAMS_DIGEST, 'corpus judgeParams == anchors fit-time pin')
eq([...uniq((r) => r.judgeNodes)][0], F.nodes, 'corpus judgeNodes == fit nodes')
eq([...uniq((r) => r.judgeMultiPv)][0], F.multiPv, 'corpus judgeMultiPv == fit multiPv')

// integer round-trip of knots + coefs + metadata
eq(F.fitDate, fit.fitDate, 'fitDate round-trips')
eq(F.corpusRows, fit.corpusRows, 'corpusRows round-trips')
eq(F.trainRows, fit.trainRows, 'trainRows round-trips')
eq(F.holdoutRows, fit.holdoutRows, 'holdoutRows round-trips')
eq(F.maeHoldoutWithOppDeci, Math.round(fit.mae['with opp (Ex+oppElo)'].holdout * 10), 'with-opp holdout MAE round-trips (deci)')
eq(F.maeHoldoutNoOppDeci, Math.round(fit.mae['no opp (estimateElo)'].holdout * 10), 'no-opp holdout MAE round-trips (deci)')
eq(F.maeHoldoutAccOnlyDeci, Math.round(fit.mae['acc only (no acpl)'].holdout * 10), 'acc-only holdout MAE round-trips (deci)')
const knotsMatch = (intKs, jsonKs) =>
  intKs.length === jsonKs.length &&
  intKs.every((k, i) => k.featMilli === Math.round(jsonKs[i].feat * 1000) && k.elo === jsonKs[i].elo)
ok(knotsMatch(F.accKnots, fit.accKnots), 'accKnots round-trip (featMilli = feat×1000, elo exact)')
ok(knotsMatch(F.acplKnots, fit.acplKnots), 'acplKnots round-trip (featMilli = feat×1000, elo exact)')
eq(F.coef.a0Micro, Math.round(fit.coef.a0 * 1e6), 'a0Micro round-trips')
eq(F.coef.a1Micro, Math.round(fit.coef.a1 * 1e6), 'a1Micro round-trips')
eq(F.coef.c0Micro, Math.round(fit.coef.c0 * 1e6), 'c0Micro round-trips')
eq(F.coef.bShrinkMicro, Math.round(fit.coef.bShrink * 1e6), 'bShrinkMicro round-trips')
eq(F.coef.gOppMicro, Math.round(fit.coef.gOpp * 1e6), 'gOppMicro round-trips')
ok(F.shrink.center === fit.shrink.center && F.shrink.fullMoves === fit.shrink.fullMoves && F.shrink.minMoves === fit.shrink.minMoves, 'shrink constants round-trip')
ok(F.clamp.floor === fit.clamp.floor && F.clamp.ceil === fit.clamp.ceil, 'clamp round-trips')

// Tier1Anchors: inverted acpl curve + measured sigma
ok(
  T.acplByElo.length === fit.acplKnots.length &&
    T.acplByElo.every(
      (k, i) => k.elo === fit.acplKnots[i].elo && k.acplMicro === Math.round((Math.exp(fit.acplKnots[i].feat) - 1) * 1e6)
    ),
  'acplByElo == inverted fit acplKnots (acplMicro = round((e^feat − 1)×1e6))'
)
{
  // sigma: residual std of per-game ACPL about the anchor curve over ALL fit
  // rows, through the REAL J2 interpolation (tier1.expectedAcplMicro).
  const resid = fitRows.map((r) => r.acpl * 1e6 - tier1.expectedAcplMicro(T, r.trueElo))
  const mean = resid.reduce((a, b) => a + b, 0) / resid.length
  const sigma = Math.round(Math.sqrt(resid.reduce((a, x) => a + (x - mean) * (x - mean), 0) / resid.length))
  eq(T.sigmaAcplMicro, sigma, `sigmaAcplMicro == recomputed corpus residual std (${sigma})`)
}
ok(typeof T.fit === 'string' && T.fit.includes(anchors.JUDGE_ANCHORS_PARAMS_DIGEST), 'anchors fit tag names the params digest')
ok(!T.fit.includes('J3-REFIT-PENDING'), 'anchors are the REAL refit (not the provisional tag)')
{
  // expectedAcplMicro sanity through the fitted set: monotone nonincreasing in elo.
  let prev = Infinity
  let mono = true
  for (let elo = 300; elo <= 2800; elo += 25) {
    const v = tier1.expectedAcplMicro(T, elo)
    if (v > prev) mono = false
    prev = v
  }
  ok(mono, 'expectedAcplMicro(TIER1_ANCHORS_JUDGE, ·) nonincreasing in Elo (300..2800)')
  ok(
    tier1.expectedAcplMicro(T, 400) > tier1.expectedAcplMicro(T, 2700),
    'weak bands expect materially higher ACPL than strong bands'
  )
}

// ── 6. holdout MAE sanity ceiling ───────────────────────────────────────────
section('holdout MAE sanity ceiling (with-opp ≤ 400, no-opp ≤ 450)')
ok(
  fit.mae['with opp (Ex+oppElo)'].holdout <= 400,
  `with-opp holdout MAE ${fit.mae['with opp (Ex+oppElo)'].holdout} ≤ 400`
)
ok(
  fit.mae['no opp (estimateElo)'].holdout <= 450,
  `no-opp holdout MAE ${fit.mae['no opp (estimateElo)'].holdout} ≤ 450`
)

console.log(
  `\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`
)
process.exit(failures ? 1 : 0)
