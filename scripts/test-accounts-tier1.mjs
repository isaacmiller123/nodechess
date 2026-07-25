// Headless test for src/shared/accounts/judge/tier1.ts (phase A5 brick J2,
// Tier-1 forensic signals).
//
//   node scripts/test-accounts-tier1.mjs
//
// Bundles the TS module on the fly with esbuild (alias @shared → src/shared,
// same pattern as scripts/test-accounts-detmath.mjs). NO live engine: every
// JudgeOutput here is a golden fixture. Hand-constructed small MultiPV
// outputs plus recorded-shape fixtures frozen as literals. Covers:
//  (a) ACPL: mover-POV derivation, in-list same-snapshot scoring, the
//      not-in-list ground-truth path, mate mapping/caps, POV for both colors,
//      the micro average (accuracy.ts acpl port),
//  (b) the ±scoreEquivCp score-equivalence window: in-list membership at any
//      rank, the not-in-list path BOTH directions (within-window matched,
//      outside-window not), exact boundary, mate-band conservatism,
//  (b2) A5-14 [DEFERRED]: the CONFIRMED any-line degeneration pinned exactly
//      (rank-4 self-match, unlisted-blunder any-line certification,
//      low-branching auto-match) AND the corrected BEST-relative criterion
//      (isEngineMatchedBest / matchedBest): window live for listed moves,
//      never exact-move, matchedBest ≤ matched, record shape untouched,
//  (c) complexityMicro: golden cases for every factor of the ported
//      complexityMultiplier fold (gap bands, boundary bump, autopilot, probe
//      cp map incl. mate→±1000, clamp),
//  (d) clockForensicMicro: golden statistic values. Proportional
//      (human-like) passes, uniform-fast-on-hard flagged, inversion flagged
//      hardest, min-sample neutral, all-zero-think zero,
//  (d2) A5-15: increment-aware think-time. Honest sub-increment 3+2 play
//      pre-fix bit-aliases to an instant bot at clockFitMicro=0; crediting the
//      witness-signed incMs back recovers the true think, rescues the human to
//      1e6 while the bot stays 0, default incMs byte-identical, incMs matrix,
//  (d3) A5-16: clock inputs sourced from the accused's OWN prior snapshot
//      (ply−2), never the opponent's ply−1 echo: an opponent zeroing its echo
//      of the accused's clock can no longer drive clockFitMicro to the maximal-
//      suspicion 0 (framing defeated, record byte-identical); the second
//      mover's opening reply is the single bounded ply−0-echo residual,
//  (e) trajectoryMicro: exact OLS slopes, degenerate windows; A5-36:
//      Tier1Record OPTIONALLY persists the slope per side when the caller
//      supplies that account's prior acpl window (this game appended as newest);
//      byte-identical when absent, per-side opt-in, fail-closed, no-window digest
//      still frozen, and the persisted value equals the J4 window→slope map
//      (VERDICT weight into z/T DEFERRED to calibration),
//  (f) Tier1Record: end-to-end goldens on a 20-ply recorded-shape fixture
//      (bot-paced white vs human-paced black), determinism (build twice ⇒
//      identical digest; identical across two separate esbuild bundles),
//  (g) Tier1Anchors: provisional-set shape, expectedAcplMicro interpolation,
//  (h) the fail-closed malformed-input matrix (Tier1InputError on every
//      entry, nothing coerced),
//  (i) A5-01: transcriptToJudgePositions (the canonical bare-fenBefore
//      no-tail all-plies verdict surface; builder agreement across callers)
//      and the tier1Record full-coverage rule: subset/gap/moves-path
//      JudgeOutputs rejected, full-coverage digest frozen byte-identical.
//  (j) A5-37: the canonical fixed-node config gate. A Tier-2 (t2Nodes/
//      t2MultiPv) or degenerate JudgeOutput carrying the SAME params digest is
//      refused, each config field isolated, canonical-config record still
//      ACCEPTED with a byte-identical digest (gate perturbs no accepted bit).
//  (k) A5-06: the wrong-config record class is unmintable AND unverifiable
//      end-to-end: the finding's literal nodes=1 output (multiPv/hashMb
//      canonical) is refused, the record COMMITS to config via `judge` (a
//      nodes=1 output digests differently), so a verifier's own recompute
//      re-runs the A5-37 gate; the record carries no config field, so the
//      contract lives at the mint/recompute boundary (mkRec note subsumed).
//
// Style: failures counter, per-assert one-line output, exit(failures ? 1 : 0).

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SRC = resolve(ROOT, 'src/shared/accounts').replace(/\\/g, '/')

// ---- tiny check kit ---------------------------------------------------------
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
function throwsT1(fn, msg, T1) {
  try {
    fn()
    ok(false, `${msg} (did not throw)`)
  } catch (e) {
    ok(e instanceof T1 || e?.name === 'Tier1InputError', `${msg} (${e?.name}: ${String(e?.message).slice(0, 80)})`)
  }
}

async function bundleOnce(outdir, tag) {
  const entry = resolve(outdir, `entry-${tag}.ts`)
  // Import through the judge barrel so the index.ts export line is covered.
  writeFileSync(entry, `export * from '${SRC}/judge/index.ts'`)
  const outfile = resolve(outdir, `tier1-${tag}.mjs`)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    absWorkingDir: ROOT,
    logLevel: 'warning',
  })
  return import(pathToFileURL(outfile).href)
}

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/accounts-tier1-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
  try {
    await run(outdir)
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(
    `\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`
  )
  process.exit(failures ? 1 : 0)
}

async function run(outdir) {
  console.log('· bundling src/shared/accounts/judge (barrel incl. tier1) …')
  const m = await bundleOnce(outdir, 'a')
  const {
    Tier1InputError,
    PARAMS_A5,
    PARAMS_A5_DIGEST,
    mateToCp,
    acplLineCp,
    probeLineCp,
    acplMicro,
    engineMatchMicro,
    isEngineMatched,
    isEngineMatchedBest,
    complexityMicro,
    clockForensicMicro,
    trajectoryMicro,
    sideMoveScores,
    clockSamplesForSide,
    transcriptToJudgePositions,
    tier1Record,
    tier1Digest,
    judgeOutputDigest,
    TIER1_ANCHORS_PROVISIONAL,
    expectedAcplMicro,
    CLOCK_NEUTRAL_MICRO,
    CLOCK_MIN_SAMPLE,
  } = m

  const CFG = { nodes: 200_000, multiPv: 4, hashMb: 16, params: PARAMS_A5_DIGEST }

  // ---- GOLDEN FIXTURE A: 6-ply hand game (both POVs, mate plies) -----------
  // ply 0 (w): played d2d4 (in-list rank 2)         → loss 10, matched
  // ply 1 (b): played g8f6 (NOT in list; ground truth ply2 rank1 cp 60 →
  //            mover POV −60)                        → loss 35, NOT matched
  // ply 2 (w): played e2e4 (in-list rank 4, cp 30; same-snapshot, NOT the
  //            ply-3 ground truth)                   → loss 30, matched
  // ply 3 (b): played d7d6 (in-list rank 2)         → loss 80, matched
  // ply 4 (w): best mate 2 (1900); played h2h3 → ground truth ply5 mate 1
  //            (black) → mover POV mate −1 → −2000   → loss 3900 → cap 1000
  // ply 5 (b): played the mate (in-list, mate 1)     → loss 0, matched
  const FIX_A = {
    v: 1,
    config: CFG,
    positions: [
      { ply: 0, lines: [{ move: 'e2e4', cp: 30 }, { move: 'd2d4', cp: 20 }, { move: 'g1f3', cp: 12 }, { move: 'b1c3', cp: -5 }] },
      { ply: 1, lines: [{ move: 'e7e5', cp: -25 }, { move: 'c7c5', cp: -35 }] },
      { ply: 2, lines: [{ move: 'd4d5', cp: 60 }, { move: 'c2c4', cp: 55 }, { move: 'b1c3', cp: 48 }, { move: 'e2e4', cp: 30 }] },
      { ply: 3, lines: [{ move: 'b8c6', cp: -320 }, { move: 'd7d6', cp: -400 }] },
      { ply: 4, lines: [{ move: 'f3g5', mate: 2 }, { move: 'd1h5', cp: 800 }] },
      { ply: 5, lines: [{ move: 'd8h4', mate: 1 }] },
    ],
  }
  const MOVES_A = [
    { ply: 0, move: 'd2d4', clockMs: { w: 179000, b: 180000 } },
    { ply: 1, move: 'g8f6', clockMs: { w: 179000, b: 176000 } },
    { ply: 2, move: 'e2e4', clockMs: { w: 174000, b: 176000 } },
    { ply: 3, move: 'd7d6', clockMs: { w: 174000, b: 170000 } },
    { ply: 4, move: 'h2h3', clockMs: { w: 165000, b: 170000 } },
    { ply: 5, move: 'd8h4', clockMs: { w: 165000, b: 168000 } },
  ]

  // ---- score maps ----------------------------------------------------------
  console.log('\n· mate map + line cp maps (accuracy.ts / botTime ports)')
  eq(mateToCp(0), -2100, 'mateToCp(0) → −2100 (already mated, ported branch)')
  eq(mateToCp(1), 2000, 'mateToCp(1) → 2000')
  eq(mateToCp(-1), -2000, 'mateToCp(−1) → −2000')
  eq(mateToCp(3), 1800, 'mateToCp(3) → 1800')
  eq(mateToCp(10), 1100, 'mateToCp(10) → 1100')
  eq(mateToCp(15), 1100, 'mateToCp(15) saturates at 1100')
  eq(mateToCp(-12), -1100, 'mateToCp(−12) → −1100')
  eq(acplLineCp({ move: 'e2e4', cp: 42 }), 42, 'acplLineCp passes cp through unclamped')
  eq(acplLineCp({ move: 'e2e4', cp: 1500 }), 1500, 'acplLineCp does NOT clamp cp (acpl caps per-move loss instead)')
  eq(acplLineCp({ move: 'e2e4', mate: 2 }), 1900, 'acplLineCp maps mate through mateToCp')
  eq(probeLineCp({ move: 'e2e4', mate: 2 }), 1000, 'probeLineCp: mate>0 → +1000 (botTime lineCpOf port)')
  eq(probeLineCp({ move: 'e2e4', mate: -4 }), -1000, 'probeLineCp: mate<0 → −1000')
  eq(probeLineCp({ move: 'e2e4', cp: 1500 }), 1000, 'probeLineCp clamps cp to +1000')
  eq(probeLineCp({ move: 'e2e4', cp: -2500 }), -1000, 'probeLineCp clamps cp to −1000')
  eq(probeLineCp({ move: 'e2e4', cp: -300 }), -300, 'probeLineCp passes in-band cp through')

  // ---- (a) ACPL derivation -------------------------------------------------
  console.log('\n· ACPL: POV, in-list snapshot, ground truth, mate caps')
  {
    const w = sideMoveScores(FIX_A, MOVES_A, 'w', 'w')
    const b = sideMoveScores(FIX_A, MOVES_A, 'b', 'w')
    eq(JSON.stringify(w.losses), JSON.stringify([10, 30, 1000]), 'white losses [10, 30, 1000] (in-list, rank-4 same-snapshot, mate-blunder capped)')
    eq(JSON.stringify(b.losses), JSON.stringify([35, 80, 0]), 'black losses [35, 80, 0] (ground-truth POV negation, in-list, played mate)')
    eq(w.scored, 3, 'white scored 3')
    eq(b.scored, 3, 'black scored 3')
    eq(w.unscored, 0, 'white unscored 0')
    eq(b.unscored, 0, 'black unscored 0')
    eq(w.matched, 2, 'white matched 2 (ply-4 mate blunder unmatched)')
    eq(b.matched, 2, 'black matched 2 (ply-1 ground-truth −60 outside every window)')
    eq(acplMicro(w.losses), 346_666_666, 'white acplMicro = floor(1040e6/3) = 346666666')
    eq(acplMicro(b.losses), 38_333_333, 'black acplMicro = floor(115e6/3) = 38333333')
    // The same-snapshot convention is load-bearing: ply-2 e2e4 scores its OWN
    // line's cp 30 (loss 30), not the ply-3 ground truth (which would be
    // −(−320) = 320 → loss 0).
    ok(w.losses[1] === 30, 'ply-2 in-list move scored from its OWN line (computeIsBest S2 same-snapshot port)')
  }
  eq(acplMicro([]), 0, 'acplMicro([]) = 0 (accuracy.ts acpl([]) port: consumers weight by scored)')
  eq(acplMicro([1500]), 1_000_000_000, 'acplMicro re-applies the per-move 1000 cap')
  eq(acplMicro([0, 0, 7]), 2_333_333, 'acplMicro floor division')

  // ---- (b) score-equivalence window ---------------------------------------
  console.log('\n· engine match: the ±scoreEquivCp equivalence window')
  eq(PARAMS_A5.scoreEquivCp, 15, 'PARAMS_A5.scoreEquivCp = 15')
  eq(isEngineMatched(100, [{ move: 'a2a3', cp: 100 }]), true, 'distance 0 matches')
  eq(isEngineMatched(85, [{ move: 'a2a3', cp: 100 }]), true, 'distance 15 (low side) matches: inclusive boundary')
  eq(isEngineMatched(115, [{ move: 'a2a3', cp: 100 }]), true, 'distance 15 (high side) matches')
  eq(isEngineMatched(84, [{ move: 'a2a3', cp: 100 }]), false, 'distance 16 does not match')
  eq(isEngineMatched(116, [{ move: 'a2a3', cp: 100 }]), false, 'distance 16 (high) does not match')
  eq(
    isEngineMatched(-10, [{ move: 'a2a3', cp: 300 }, { move: 'b2b3', cp: 40 }, { move: 'c2c3', cp: 0 }]),
    true,
    'ANY line: matches the rank-3 line inside the window'
  )
  eq(isEngineMatched(1900, [{ move: 'a2a3', mate: 2 }]), true, 'mate line: same mate band matches')
  eq(isEngineMatched(2000, [{ move: 'a2a3', mate: 2 }]), false, 'mate bands are 100cp apart, adjacent band conservatively unmatched')
  {
    // Not-in-list, WITHIN window (the matched direction of the ground-truth
    // path): played g1f3 ∉ list; ply-1 rank1 cp −25 (opp POV) → mover 25;
    // |25 − 30| = 5 ≤ 15 ⇒ matched, loss 5.
    const FIX_D = {
      v: 1,
      config: CFG,
      positions: [
        { ply: 0, lines: [{ move: 'e2e4', cp: 30 }, { move: 'd2d4', cp: 10 }] },
        { ply: 1, lines: [{ move: 'e7e5', cp: -25 }, { move: 'c7c5', cp: -40 }] },
      ],
    }
    const mv = [
      { ply: 0, move: 'g1f3', clockMs: { w: 60000, b: 60000 } },
      { ply: 1, move: 'e7e5', clockMs: { w: 60000, b: 58000 } },
    ]
    const w = sideMoveScores(FIX_D, mv, 'w', 'w')
    eq(w.scored, 1, 'not-in-list ground-truth move is scored')
    eq(JSON.stringify(w.losses), JSON.stringify([5]), 'ground-truth loss 5 (POV-negated next rank-1)')
    eq(w.matched, 1, 'not-in-list move WITHIN the window ⇒ matched (never string equality)')
  }
  // Not-in-list OUTSIDE the window (the unmatched direction) is fixture A
  // ply 1 (asserted above: black matched 2 of 3).
  eq(engineMatchMicro(2, 3), 666_666, 'engineMatchMicro floor(2e6/3)')
  eq(engineMatchMicro(0, 0), 0, 'engineMatchMicro 0/0 → 0 (fail-safe low)')
  eq(engineMatchMicro(10, 10), 1_000_000, 'engineMatchMicro saturates at 1e6')

  // ---- (b2) A5-14: any-line degeneration pinned + BEST-relative criterion --
  console.log('\n· A5-14 [DEFERRED]: any-line degeneration + best-relative matchedBest')
  // isEngineMatchedBest unit semantics: same ±15 window, rank-1 only.
  eq(isEngineMatchedBest(100, [{ move: 'a2a3', cp: 100 }]), true, 'best-window: distance 0 matches')
  eq(isEngineMatchedBest(85, [{ move: 'a2a3', cp: 100 }]), true, 'best-window: distance 15 (low) matches. Inclusive boundary')
  eq(isEngineMatchedBest(115, [{ move: 'a2a3', cp: 100 }]), true, 'best-window: distance 15 (high) matches. Live in BOTH directions')
  eq(isEngineMatchedBest(84, [{ move: 'a2a3', cp: 100 }]), false, 'best-window: distance 16 does not match')
  eq(
    isEngineMatchedBest(-10, [{ move: 'a2a3', cp: 300 }, { move: 'b2b3', cp: 40 }, { move: 'c2c3', cp: 0 }]),
    false,
    'rank-≥2 lines never widen the best criterion (same input isEngineMatched certifies via rank 3)'
  )
  eq(isEngineMatchedBest(1900, [{ move: 'a2a3', mate: 2 }]), true, 'best-window: same mate band matches')
  eq(isEngineMatchedBest(2000, [{ move: 'a2a3', mate: 2 }]), false, 'best-window: adjacent mate band conservatively unmatched')
  {
    // THE FINDING'S EXACT FAILURE SCENARIO {r1 a2a3 +200, r2 b2b3 +120,
    // r3 c2c3 +40, r4 d2d4 −150}.
    const LINES_14 = [
      { move: 'a2a3', cp: 200 },
      { move: 'b2b3', cp: 120 },
      { move: 'c2c3', cp: 40 },
      { move: 'd2d4', cp: -150 },
    ]
    const clk = (i) => ({ ply: i, move: i === 0 ? 'd2d4' : 'e7e5', clockMs: { w: 60000, b: 60000 } })
    // (i) played the rank-4 move, 350cp below best.
    const wI = sideMoveScores({ v: 1, config: CFG, positions: [{ ply: 0, lines: LINES_14 }] }, [clk(0)], 'w', 'w')
    eq(JSON.stringify(wI.losses), JSON.stringify([350]), 'scenario (i): rank-4 d2d4 loses 350cp')
    eq(wI.matched, 1, 'scenario (i) CALIBRATED criterion unchanged: 350cp rank-4 move self-matches at distance 0 (the confirmed defect)')
    eq(wI.matchedBest, 0, 'scenario (i) CORRECTED criterion: |−150 − 200| = 350 > 15 ⇒ NOT best-matched')
    // (ii) played g2g4 (not listed); ground truth = next rank-1 +140 (opp
    // POV) → mover −140, within 10cp of the rank-4 line.
    const OUT_II = {
      v: 1,
      config: CFG,
      positions: [
        { ply: 0, lines: LINES_14 },
        { ply: 1, lines: [{ move: 'e7e5', cp: 140 }] },
      ],
    }
    const wII = sideMoveScores(OUT_II, [{ ...clk(0), move: 'g2g4' }, clk(1)], 'w', 'w')
    eq(JSON.stringify(wII.losses), JSON.stringify([340]), 'scenario (ii): unlisted g2g4 loses 340cp')
    eq(wII.matched, 1, 'scenario (ii) CALIBRATED criterion unchanged: 340cp blunder certified via the rank-4 line (|−140 − (−150)| = 10)')
    eq(wII.matchedBest, 0, 'scenario (ii) CORRECTED criterion: |−140 − 200| = 340 > 15 ⇒ NOT best-matched')
    // (iii) low-branching auto-match regime: 3 legal moves ⇒ judge lists all
    // (judge.ts K < multiPv); the WORST move, 950cp below best.
    const wIII = sideMoveScores(
      {
        v: 1,
        config: CFG,
        positions: [{ ply: 0, lines: [{ move: 'a2a3', cp: -50 }, { move: 'b2b3', cp: -700 }, { move: 'c2c3', cp: -1000 }] }],
      },
      [{ ply: 0, move: 'c2c3', clockMs: { w: 60000, b: 60000 } }],
      'w',
      'w'
    )
    eq(wIII.matched, 1, 'scenario (iii) CALIBRATED: fully-listed 3-legal position auto-matches even the worst move (950cp loss)')
    eq(wIII.matchedBest, 0, 'scenario (iii) CORRECTED: the worst move is not best-matched, composition no longer forces matches')
    // The window is LIVE for listed moves under the best criterion, and it
    // is still never exact-move matching.
    const oneMove = (mv) => [{ ply: 0, move: mv, clockMs: { w: 60000, b: 60000 } }]
    const wIn = sideMoveScores(
      { v: 1, config: CFG, positions: [{ ply: 0, lines: [{ move: 'a2a3', cp: 100 }, { move: 'b2b3', cp: 90 }] }] },
      oneMove('b2b3'),
      'w',
      'w'
    )
    eq(wIn.matchedBest, 1, 'in-list rank-2 within 15cp of best IS best-matched (score equivalence, not move identity)')
    const wOut = sideMoveScores(
      { v: 1, config: CFG, positions: [{ ply: 0, lines: [{ move: 'a2a3', cp: 100 }, { move: 'b2b3', cp: 84 }] }] },
      oneMove('b2b3'),
      'w',
      'w'
    )
    eq(wOut.matched, 1, 'in-list rank-2 at 16cp: any-line still certifies (self-match)')
    eq(wOut.matchedBest, 0, 'in-list rank-2 at 16cp is NOT best-matched. The window now excludes listed moves (inert pre-A5-14)')
    // Not-in-list co-best through the ground-truth path, ABOVE best: the
    // corrected criterion still absorbs engine variance both directions.
    const wCo = sideMoveScores(
      {
        v: 1,
        config: CFG,
        positions: [
          { ply: 0, lines: [{ move: 'a2a3', cp: 200 }, { move: 'b2b3', cp: 100 }] },
          { ply: 1, lines: [{ move: 'e7e5', cp: -205 }] },
        ],
      },
      [{ ply: 0, move: 'g1f3', clockMs: { w: 60000, b: 60000 } }, { ply: 1, move: 'e7e5', clockMs: { w: 60000, b: 58000 } }],
      'w',
      'w'
    )
    eq(wCo.matchedBest, 1, 'unlisted move with ground truth +205 vs best +200 IS best-matched (never exact-move; above-best side live)')
    eq(JSON.stringify(wCo.losses), JSON.stringify([0]), 'above-best ground truth clamps loss to 0 (unchanged)')
  }
  {
    // FIX_A under both criteria: matchedBest strips exactly the pure
    // self-matches (w ply-2 e2e4 30cp below best; b ply-3 d7d6 80cp below).
    const w = sideMoveScores(FIX_A, MOVES_A, 'w', 'w')
    const b = sideMoveScores(FIX_A, MOVES_A, 'b', 'w')
    eq(w.matchedBest, 1, 'FIX_A white matchedBest 1 (ply-0 d2d4 within 10cp of best; ply-2 self-match stripped)')
    eq(b.matchedBest, 1, 'FIX_A black matchedBest 1 (ply-5 mate; ply-3 self-match stripped)')
    ok(w.matchedBest <= w.matched && b.matchedBest <= b.matched, 'invariant: matchedBest ≤ matched (best line ∈ lines)')
  }

  // ---- unscored rule (c) ----------------------------------------------------
  console.log('\n· unscored rule (c): no list hit, no ply+1 ground truth')
  {
    const FIX_B = { ...FIX_A, positions: FIX_A.positions.slice(0, 5) } // plies 0..4
    const w = sideMoveScores(FIX_B, MOVES_A, 'w', 'w')
    const b = sideMoveScores(FIX_B, MOVES_A, 'b', 'w')
    eq(w.scored, 2, 'white scored drops to 2 without ply-5 ground truth')
    eq(w.unscored, 1, 'white ply-4 move counted unscored')
    eq(JSON.stringify(w.losses), JSON.stringify([10, 30]), 'unscored move excluded from losses')
    eq(acplMicro(w.losses), 20_000_000, 'white acplMicro over scored moves only')
    eq(w.matched, 2, 'white matched 2/2')
    eq(engineMatchMicro(w.matched, w.scored), 1_000_000, 'match fraction over scored only')
    eq(b.scored, 2, 'black ply-5 (no judged position under this fixture) simply not judged, scored 2')
    eq(b.unscored, 0, 'black unscored 0 (ply 3 is in-list)')
  }

  // ---- (c) complexityMicro goldens -----------------------------------------
  console.log('\n· complexityMicro: ported fold goldens')
  const L = (cp1, cp2) => (cp2 === undefined ? [{ move: 'a2a3', cp: cp1 }] : [{ move: 'a2a3', cp: cp1 }, { move: 'b2b3', cp: cp2 }])
  eq(complexityMicro(L(30, 20)), 1_800_000, 'gap 10 (<15) → ×1.8')
  eq(complexityMicro(L(100, 80)), 1_885_000, 'gap 20 (<40) → ×1.45, |best|=100 boundary → ×1.3')
  eq(complexityMicro(L(200, 150)), 1_150_000, 'gap 50 (<90) → ×1.15, no boundary bump')
  eq(complexityMicro(L(30, -70)), 1_000_000, 'gap 100 (90..249) → neutral')
  eq(complexityMicro(L(500, 200)), 360_000, 'gap 300 (≥250) → ×0.8, |best|≥400 autopilot → ×0.45')
  eq(complexityMicro(L(0)), 1_000_000, 'single line (forced-ish): no gap factor, neutral')
  eq(complexityMicro(L(-100)), 1_300_000, 'single line at −100: boundary bump only (|best| POV-symmetric)')
  eq(complexityMicro([{ move: 'a2a3', mate: 2 }, { move: 'b2b3', cp: 400 }]), 360_000, 'mate → +1000 (probe map): gap 600, autopilot')
  eq(complexityMicro([{ move: 'a2a3', mate: -1 }, { move: 'b2b3', mate: -2 }]), 810_000, 'both losing mates → −1000 each: gap 0 → ×1.8, autopilot ×0.45')
  eq(complexityMicro(L(1500, 1500)), 810_000, 'cp clamped to 1000: gap 0 → ×1.8, autopilot ×0.45')
  eq(complexityMicro(L(100, 95)), 2_340_000, 'max reachable stack: ×1.8 then ×1.3 = 2.34e6 (≤ ceiling 4e6)')
  eq(complexityMicro(L(-40, -50)), 1_800_000, 'negative-side gap uses max(0, top1−top2), signalsFromProbe port')
  eq(complexityMicro(L(-50, -40)), 2_340_000, 'inverted ranks floor gap at 0 (<15) and |−50| boundary bumps')

  // ---- (d) clockForensicMicro goldens --------------------------------------
  console.log('\n· clockForensicMicro: think-time/complexity fit goldens')
  const HARD = 1_800_000
  const EASY = 600_000
  const cAlt = [HARD, EASY, HARD, EASY, HARD, EASY, HARD, EASY, HARD, EASY]
  const mkSamples = (ts, cs) => ts.map((t, i) => ({ thinkMs: t, complexityMicro: cs[i] }))
  eq(
    clockForensicMicro(mkSamples([1800, 600, 1800, 600, 1800, 600, 1800, 600, 1800, 600], cAlt)),
    1_000_000,
    'perfectly proportional spending → fit 1e6'
  )
  eq(
    clockForensicMicro(mkSamples([2100, 450, 1600, 800, 1900, 500, 2600, 700, 1500, 600], cAlt)),
    913_726,
    'human-like noisy-proportional spending → 913726 (passes)'
  )
  eq(
    clockForensicMicro(mkSamples([300, 300, 300, 300, 300, 300, 300, 300, 300, 300], cAlt)),
    750_000,
    'uniform-fast on hard positions → 750000 (flagged below human-like)'
  )
  eq(
    clockForensicMicro(mkSamples([200, 1000, 200, 1000, 200, 1000, 200, 1000, 200, 1000], cAlt)),
    416_668,
    'inverted (fast on hard, slow on easy) → 416668 (worst)'
  )
  eq(
    clockForensicMicro(mkSamples([300, 300, 300, 300, 300, 300, 300], cAlt.slice(0, 7))),
    CLOCK_NEUTRAL_MICRO,
    `n < CLOCK_MIN_SAMPLE (${CLOCK_MIN_SAMPLE}) → neutral 500000`
  )
  eq(
    clockForensicMicro(mkSamples([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], cAlt)),
    0,
    'a full sample at 0ms total think → 0 (machine pacing)'
  )
  eq(clockForensicMicro([]), CLOCK_NEUTRAL_MICRO, 'empty sample → neutral')
  eq(
    clockForensicMicro(mkSamples([500, 500, 500, 500, 500, 500, 500, 500], [EASY, EASY, EASY, EASY, EASY, EASY, EASY, EASY])),
    1_000_000,
    'uniform time on uniform complexity → fit 1e6 (easy games never flag)'
  )

  // ---- (d2) A5-15: Fischer-increment-aware think-time derivation -----------
  // The signed clock snapshot is taken AFTER the increment is credited
  // (mpSession afterMoveCredit), so the raw delta before−after = elapsed − incMs.
  // Pre-fix, honest sub-increment play (every elapsed ≤ incMs) clamped every
  // think to 0 → T=0 → clockFitMicro=0, the hardcoded maximal-suspicion value,
  // BIT-ALIASED to an actual instant bot. Crediting the witness-signed incMs
  // back recovers the true think and breaks the aliasing: the human scores high,
  // the bot stays 0. Default incMs 0 ⇒ byte-identical to the pre-A5-15 record.
  console.log('\n· A5-15: increment-aware clock forensics (honest fast play not flagged)')
  {
    const hard = (ply) => ({ ply, lines: [{ move: 'a2a3', cp: 20 }, { move: 'b2b3', cp: 10 }] }) // complexity 1.8e6
    const easy = (ply) => ({ ply, lines: [{ move: 'c2c3', cp: 500 }, { move: 'd2d3', cp: 200 }] }) // complexity 360k
    const isH = (ply) => ply % 4 === 0 || ply % 4 === 1
    const N = 18
    const INC = 2000 // 3+2 blitz
    const FIX_INC = { v: 1, config: CFG, positions: Array.from({ length: N }, (_, ply) => (isH(ply) ? hard(ply) : easy(ply))) }
    // Signed clocks are post-increment: on each mover ply (≥ 1) clock' = clock −
    // elapsed + INC; the opening ply 0 gets neither (isOpeningMove) and is never
    // sampled, so the credit-back is exact for every sampled ply.
    const mkMoves = (thinkOf) => {
      let w = 180000
      let b = 180000
      const mv = []
      for (let ply = 0; ply < N; ply++) {
        const white = ply % 2 === 0
        if (ply !== 0) {
          const e = thinkOf(ply)
          if (white) w = w - e + INC
          else b = b - e + INC
        }
        mv.push({ ply, move: isH(ply) ? 'a2a3' : 'c2c3', clockMs: { w, b } })
      }
      return mv
    }
    const honest = mkMoves((ply) => (isH(ply) ? 1800 : 360)) // think ∝ complexity, all < INC
    const bot = mkMoves(() => 0) // instant bot: 0ms every move (clock GROWS by INC)

    // clockSamplesForSide: pre-fix every honest think clamps to 0; the credit
    // recovers the true proportional think exactly (elapsed, not elapsed−INC).
    eq(
      JSON.stringify(clockSamplesForSide(FIX_INC, honest, 'w', 'w').map((s) => s.thinkMs)),
      JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0]),
      'pre-fix (incMs 0): honest sub-increment thinks all clamp to 0, the defect'
    )
    eq(
      JSON.stringify(clockSamplesForSide(FIX_INC, honest, 'w', 'w', INC).map((s) => s.thinkMs)),
      JSON.stringify([360, 1800, 360, 1800, 360, 1800, 360, 1800]),
      'incMs credited back: true think times recovered exactly'
    )

    // End-to-end aliasing proof. Pre-fix: honest 3+2 human and instant bot mint
    // the BIT-IDENTICAL record: the value no later calibration can separate.
    const honestLegacy = tier1Record('g', 'blitz', FIX_INC, honest, 'w')
    const botLegacy = tier1Record('g', 'blitz', FIX_INC, bot, 'w')
    eq(honestLegacy.w.clockFitMicro, 0, 'pre-fix HONEST white → clockFitMicro 0 (maximal suspicion: false-fraud)')
    eq(honestLegacy.b.clockFitMicro, 0, 'pre-fix HONEST black → clockFitMicro 0')
    eq(honestLegacy.w.clockN, 8, 'white clockN 8 (≥ CLOCK_MIN_SAMPLE, so the statistic speaks)')
    eq(
      tier1Digest(honestLegacy),
      tier1Digest(botLegacy),
      'pre-fix ALIASING: honest human and instant bot mint the bit-identical Tier1Record'
    )
    // Post-fix (incMs = INC): the human is rescued to a proportional high fit;
    // the bot (true think 0) stays pinned at 0, aliasing broken.
    const honestFix = tier1Record('g', 'blitz', FIX_INC, honest, 'w', INC)
    const botFix = tier1Record('g', 'blitz', FIX_INC, bot, 'w', INC)
    eq(honestFix.w.clockFitMicro, 1_000_000, 'fix HONEST white → clockFitMicro 1e6 (proportional, NOT flagged)')
    eq(honestFix.b.clockFitMicro, 1_000_000, 'fix HONEST black → clockFitMicro 1e6')
    eq(honestFix.w.clockN, 8, 'clockN unchanged by the credit-back (still 8)')
    eq(botFix.w.clockFitMicro, 0, 'fix INSTANT BOT white → still 0 (a true 0ms think is NOT whitewashed)')
    ok(tier1Digest(honestFix) !== tier1Digest(botFix), 'fix breaks the aliasing: honest and bot now mint DISTINCT records')

    // Byte-identical guard: incMs is a derivation INPUT, never stored. Absent ≡
    // explicit 0, so every frozen record/digest stays untouched.
    eq(
      tier1Digest(tier1Record('g', 'blitz', FIX_INC, honest, 'w')),
      tier1Digest(tier1Record('g', 'blitz', FIX_INC, honest, 'w', 0)),
      'incMs absent ≡ explicit incMs 0: record bytes unchanged'
    )
  }

  // ---- (d3) A5-16: own-clock sourcing defeats opponent-echo framing --------
  // Think-time `before` is s's OWN previous self-signed clock (ply−2), never the
  // opponent's ply−1 echo. Pre-fix, the opponent signed clockMs[accused] and
  // could zero every `before` → all thinks 0 → T=0 → clockFitMicro=0 (maximal
  // suspicion) against an HONEST accused (§0 no-adversary-asserted-input). The
  // own-snapshot sourcing makes the opponent's echo inert: byte-identical for
  // honest play, framing defeated. The whitewash direction (a mover faking its
  // OWN complexity-proportional snapshots) needs the witness's wclk/wts elapsed
  // stream and is the documented out-of-lane residual.
  console.log('\n· A5-16: own-clock sourcing defeats opponent-echo framing')
  {
    const hard = (ply) => ({ ply, lines: [{ move: 'a2a3', cp: 20 }, { move: 'b2b3', cp: 10 }] }) // complexity 1.8e6
    const easy = (ply) => ({ ply, lines: [{ move: 'c2c3', cp: 500 }, { move: 'd2d3', cp: 200 }] }) // complexity 360k
    const isH = (ply) => ply % 4 === 0 || ply % 4 === 1
    const N = 20
    const FIX_F = { v: 1, config: CFG, positions: Array.from({ length: N }, (_, ply) => (isH(ply) ? hard(ply) : easy(ply))) }
    // Honest: White (first mover) spends think ∝ complexity (1800 hard / 360 easy);
    // Black spends a uniform 500. Plain decrement, no increment.
    const build = () => {
      let w = 600000
      let b = 600000
      const mv = []
      for (let ply = 0; ply < N; ply++) {
        const white = ply % 2 === 0
        if (white) w -= isH(ply) ? 1800 : 360
        else b -= 500
        mv.push({ ply, move: isH(ply) ? 'a2a3' : 'c2c3', clockMs: { w, b } })
      }
      return mv
    }
    const honest = build()
    // FRAMING: the OPPONENT (Black, odd plies) signs clockMs.w = 1. The echo of
    // White's clock it controls but does not OWN.
    const framed = honest.map((m) => (m.ply % 2 === 1 ? { ...m, clockMs: { w: 1, b: m.clockMs.b } } : m))

    // White's samples come from its own even-ply snapshots, so the tamper is
    // inert: identical think times honest vs framed.
    const wThink = JSON.stringify([360, 1800, 360, 1800, 360, 1800, 360, 1800, 360])
    eq(JSON.stringify(clockSamplesForSide(FIX_F, honest, 'w', 'w').map((s) => s.thinkMs)), wThink, 'honest White think times (own ply−2 delta)')
    eq(
      JSON.stringify(clockSamplesForSide(FIX_F, framed, 'w', 'w').map((s) => s.thinkMs)),
      wThink,
      'FRAMED White think times UNCHANGED, opponent echo tamper inert'
    )
    // The tamper IS present and would have collapsed the pre-fix ply−1 derivation:
    eq(framed[1].clockMs.w, 1, 'framing present: Black zeroed its echo of White clock at ply 1')
    ok(framed[1].clockMs.w - framed[2].clockMs.w <= 0, 'pre-fix (opponent-echo) delta at White ply 2 would clamp to 0 → T=0 → clockFitMicro 0')

    const honestRec = tier1Record('g', 'blitz', FIX_F, honest, 'w')
    const framedRec = tier1Record('g', 'blitz', FIX_F, framed, 'w')
    eq(honestRec.w.clockFitMicro, 1_000_000, 'honest White clockFitMicro 1e6 (proportional)')
    eq(framedRec.w.clockFitMicro, 1_000_000, 'FRAMED White clockFitMicro STILL 1e6: NOT driven to the maximal-suspicion 0')
    eq(honestRec.w.clockN, 9, 'White clockN 9 (sampling geometry unchanged by the fix)')
    eq(tier1Digest(honestRec), tier1Digest(framedRec), 'framing the opponent echo cannot change the accused Tier1Record (byte-identical)')

    // BOUNDED RESIDUAL: the second mover's opening reply (ply 1) has no own prior
    // snapshot and alone reads the ply−0 echo. An opponent tampering ONLY that
    // echo changes at most that ONE sample and cannot force the T=0 extreme.
    const b0Tampered = honest.map((m) => (m.ply === 0 ? { ...m, clockMs: { w: m.clockMs.w, b: 1 } } : m))
    const honestB = clockSamplesForSide(FIX_F, honest, 'b', 'w').map((s) => s.thinkMs)
    const tamperB = clockSamplesForSide(FIX_F, b0Tampered, 'b', 'w').map((s) => s.thinkMs)
    eq(JSON.stringify(honestB), JSON.stringify([500, 500, 500, 500, 500, 500, 500, 500, 500, 500]), 'honest Black think times (uniform 500)')
    eq(tamperB[0], 0, 'ply−0 echo tamper zeroes the Black ply-1 sample only')
    eq(JSON.stringify(tamperB.slice(1)), JSON.stringify(honestB.slice(1)), 'every Black sample after ply 1 uses own snapshots, unaffected by the echo tamper')
    ok(
      clockForensicMicro(clockSamplesForSide(FIX_F, b0Tampered, 'b', 'w')) > 0,
      'a single tampered opening sample cannot drive clockFitMicro to the maximal-suspicion 0'
    )
  }

  // ---- (e) trajectoryMicro --------------------------------------------------
  console.log('\n· trajectoryMicro: OLS slope goldens')
  eq(trajectoryMicro([100_000_000, 90_000_000, 80_000_000]), -10_000_000, 'falling ACPL → slope −10e6 (strengthening)')
  eq(trajectoryMicro([10_000_000, 20_000_000, 40_000_000]), 15_000_000, 'rising ACPL → slope +15e6')
  eq(trajectoryMicro([50_000_000, 50_000_000, 50_000_000, 50_000_000]), 0, 'flat window → 0')
  eq(trajectoryMicro([100_000_000, 89_000_000]), -11_000_000, 'two-game window: plain difference')
  eq(trajectoryMicro([42_000_000]), 0, 'n=1 → 0 (no slope evidence)')
  eq(trajectoryMicro([]), 0, 'n=0 → 0')
  {
    // floor rounding on a non-exact negative slope: [10, 0, 0] micro-cp
    // num = 3·0 − 3·10 = −30, den = 6 → exactly −5
    eq(trajectoryMicro([10, 0, 0]), -5, 'integer slope, floor division')
    // [0,0,10]: num = 3·20 − 3·10 = 30, den 6 → 5
    eq(trajectoryMicro([0, 0, 10]), 5, 'symmetric positive case')
    // [0, 1]: slope 1
    eq(trajectoryMicro([0, 1]), 1, 'unit slope')
    // [1, 0]: slope −1
    eq(trajectoryMicro([1, 0]), -1, 'unit negative slope')
  }

  // ---- (f) Tier1Record end-to-end + determinism ----------------------------
  console.log('\n· Tier1Record: recorded-shape 20-ply fixture (bot white, human black)')
  // Fixture C: 20 plies, all judged. Hard plies (gap<15 ⇒ complexity 1.8e6):
  // 0,1,4,5,8,9,12,13,16,17. Easy plies (gap 300, |best| 500 ⇒ 360000):
  // 2,3,6,7,10,11,14,15,18,19. White spends a uniform 400ms (bot pacing);
  // black spends 5000ms hard / 1000ms easy (proportional). White plays the
  // rank-2 move on its easy plies (loss 300 each), rank-1 elsewhere; black
  // always rank-1.
  const hardPos = (ply) => ({ ply, lines: [{ move: 'a2a3', cp: 20 }, { move: 'b2b3', cp: 10 }] })
  const easyPos = (ply) => ({ ply, lines: [{ move: 'c2c3', cp: 500 }, { move: 'd2d3', cp: 200 }] })
  const isHard = (ply) => ply % 4 === 0 || ply % 4 === 1
  const FIX_C = {
    v: 1,
    config: CFG,
    positions: Array.from({ length: 20 }, (_, ply) => (isHard(ply) ? hardPos(ply) : easyPos(ply))),
  }
  const MOVES_C = []
  {
    let w = 600000
    let b = 600000
    for (let ply = 0; ply < 20; ply++) {
      const white = ply % 2 === 0
      const spend = white ? 400 : isHard(ply) ? 5000 : 1000
      if (white) w -= spend
      else b -= spend
      const rank2 = white && !isHard(ply)
      const move = rank2 ? 'd2d3' : isHard(ply) ? 'a2a3' : 'c2c3'
      MOVES_C.push({ ply, move, clockMs: { w, b } })
    }
  }
  const recC = tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w')
  eq(recC.v, 1, 'record v = 1')
  eq(recC.game, 'game-c', 'gameKey echoed')
  eq(recC.ladder, 'blitz', 'ladderId echoed')
  eq(recC.params, PARAMS_A5_DIGEST, 'record embeds PARAMS_A5_DIGEST')
  eq(recC.judge, judgeOutputDigest(FIX_C), 'record embeds the judgeOutputDigest of the consumed output')
  eq(recC.w.scored, 10, 'white scored 10')
  eq(recC.w.unscored, 0, 'white unscored 0')
  eq(recC.w.acplMicro, 150_000_000, 'white acplMicro 150e6 (5 rank-2 moves × loss 300)')
  eq(recC.w.matched, 10, 'white matched 10 (in-list at any rank)')
  eq(recC.w.matchMicro, 1_000_000, 'white matchMicro 1e6')
  eq(recC.w.clockN, 9, 'white clock samples: judged mover plies ≥ 1 → 9')
  eq(recC.w.clockFitMicro, 644_445, 'BOT white: uniform-fast-on-hard → clockFit 644445 (flagged)')
  eq(recC.b.scored, 10, 'black scored 10')
  eq(recC.b.acplMicro, 0, 'black acplMicro 0 (always rank-1)')
  eq(recC.b.matchMicro, 1_000_000, 'black matchMicro 1e6')
  eq(recC.b.clockN, 10, 'black clock samples 10')
  eq(recC.b.clockFitMicro, 1_000_000, 'HUMAN black: proportional spending → clockFit 1e6 (passes)')
  {
    // A5-14: the matched=10 "in-list at any rank" golden above is the
    // confirmed degeneration (5 of white's 10 matches are 300cp rank-2
    // moves); the corrected diagnostics-level statistic discriminates …
    const wC = sideMoveScores(FIX_C, MOVES_C, 'w', 'w')
    const bC = sideMoveScores(FIX_C, MOVES_C, 'b', 'w')
    eq(wC.matchedBest, 5, 'FIX_C white matchedBest 5 of 10 (the five 300cp rank-2 self-matches stripped)')
    eq(bC.matchedBest, 10, 'FIX_C black matchedBest 10 of 10 (always rank-1)')
    // … while the digest-bound record surface is UNTOUCHED until the J6
    // refit event: exact frozen key set, no matchedBest leak. (The frozen
    // tier1Digest golden below is the byte-level proof.)
    eq(
      JSON.stringify(Object.keys(recC.w)),
      JSON.stringify(['scored', 'unscored', 'acplMicro', 'matched', 'matchMicro', 'clockFitMicro', 'clockN']),
      'Tier1Side key set frozen: matchedBest stays sideMoveScores-level (A5-14 deferral, record shape unchanged)'
    )
    ok(!('matchedBest' in recC.w) && !('matchedBest' in recC.b), 'matchedBest not in the digest-bound record')
  }
  {
    const again = tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w')
    eq(tier1Digest(recC), tier1Digest(again), 'building the record twice yields the identical tier1Digest')
    eq(JSON.stringify(recC), JSON.stringify(again), 'record bytes identical across builds')
  }
  {
    const recA = tier1Record('game-a', 'rapid', FIX_A, MOVES_A, 'w')
    eq(recA.w.clockFitMicro, CLOCK_NEUTRAL_MICRO, 'short game: white clock stat neutral under min sample')
    eq(recA.w.clockN, 2, 'white clockN 2 (plies 2, 4: ply 0 has no prior snapshot)')
    eq(recA.b.clockN, 3, 'black clockN 3 (plies 1, 3, 5)')
    ok(tier1Digest(recA) !== tier1Digest(recC), 'different games → different digests')
  }
  {
    // Cross-bundle determinism: a SECOND independent esbuild bundle must
    // reproduce the same record bytes and digest.
    const m2 = await bundleOnce(outdir, 'b')
    const rec2 = m2.tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w')
    eq(m2.tier1Digest(rec2), tier1Digest(recC), 'tier1Digest identical across two separate esbuild bundles')
    eq(JSON.stringify(rec2), JSON.stringify(recC), 'record JSON identical across bundles')
  }

  // ---- (f2) A5-36: strength-trajectory persistence in Tier1Record ----------
  // Pre-fix the §8 strength-trajectory slope was computed + unit-tested (§(e)
  // above) but persisted in NO record and read by NO consumer. The smurf /
  // rapid-improvement channel was absent from every verdict. tier1Record now
  // OPTIONALLY persists it per side when the caller supplies that account's
  // prior acpl window; this game's acplMicro is appended as the newest point.
  // Absent ⇒ the field is omitted (codec skips undefined) ⇒ byte-identical
  // record, so NO frozen tier1Digest moved. VERDICT consumption (a σ-per-slope
  // weight into the Tier-2 z / trust T) is DEFERRED to J4/J6 calibration.
  console.log('\n· A5-36: trajectory persisted per side (byte-safe, per-side opt-in, DEFERRED weight)')
  {
    const FROZEN_NOWIN = 'chzY1umBfAfE9M6Ce6u_73xtvCaMEIwOK7dw_mKVm-8'
    // No window ⇒ no field, and the pre-A5-36 digest is untouched.
    const recNoWin = tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w')
    ok(
      !('trajectoryMicro' in recNoWin.w) && !('trajectoryMicro' in recNoWin.b),
      'no window supplied → neither side carries a trajectoryMicro field'
    )
    eq(tier1Digest(recNoWin), FROZEN_NOWIN, 'A5-36 byte-invariance: no-window record still the frozen tier1Digest')
    eq(
      tier1Digest(tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w', 0, undefined)),
      FROZEN_NOWIN,
      'priorAcplMicros absent ≡ explicit undefined: bytes unchanged'
    )
    eq(
      tier1Digest(tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w', 0, {})),
      FROZEN_NOWIN,
      'empty priorAcplMicros object (no sides) ≡ no field either side, bytes unchanged'
    )

    // The finding's exact failure scenario: an account whose per-game ACPL
    // trends sharply DOWNWARD. recC white acpl = 150e6 (asserted above); prior
    // window [200e6, 180e6, 160e6] ⇒ full window [200,180,160,150]e6, OLS slope
    // = floor(−340e6 / 20) = −17e6 (strongly negative = strengthening/smurf).
    const PRIOR_W = [200_000_000, 180_000_000, 160_000_000]
    const recW = tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w', 0, { w: PRIOR_W })
    ok('trajectoryMicro' in recW.w, 'w side (window supplied) persists the trajectory slope')
    ok(!('trajectoryMicro' in recW.b), 'b side (no window) omits it: per-side opt-in is independent')
    eq(recW.w.trajectoryMicro, -17_000_000, 'persisted slope −17e6 (falling ACPL → strengthening: the finding scenario, now visible in the record)')
    eq(recW.w.acplMicro, 150_000_000, 'this game acpl still 150e6 (core fields untouched by the append)')
    ok(tier1Digest(recW) !== FROZEN_NOWIN, 'window record digest DIFFERS from the no-window digest (the field changed the bytes)')
    eq(tier1Digest(recW), 'GQCr2JGq_ScZAHyBcRLw17zd0kiQYLQMKeLu6ka7h30', 'A5-36 window-record tier1Digest frozen (NEW golden, this file only)')

    // Consumption equivalence: the persisted slope IS exactly the deterministic
    // window→slope map a J4 consumer computes from the per-game acplMicro every
    // record already carries (prior window ++ this game's persisted acpl).
    eq(
      recW.w.trajectoryMicro,
      trajectoryMicro([...PRIOR_W, recC.w.acplMicro]),
      'persisted slope === trajectoryMicro(window ++ this-game acpl), the deterministic J4 consumption map'
    )

    // Sign both ways: a RISING window (weakening) persists a positive slope.
    const recRise = tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w', 0, { w: [100_000_000, 120_000_000, 140_000_000] })
    eq(recRise.w.trajectoryMicro, 17_000_000, 'rising ACPL window → +17e6 (weakening: sign is live both directions)')

    // A 1-game prior window (⇒ 2-point slope) and an empty prior window (⇒ n=1)
    // both persist a defined field (the caller opted in), the latter as 0.
    eq(tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w', 0, { w: [] }).w.trajectoryMicro, 0, 'empty window (n=1 with this game) persists 0, opting in still emits the field')
    eq(tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w', 0, { w: [170_000_000] }).w.trajectoryMicro, -20_000_000, 'single prior 170e6 vs this 150e6 → slope −20e6 (two-point difference)')

    // Fail-closed matrix for the new input (nothing silently coerced).
    throwsT1(() => tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w', 0, 'nope'), 'priorAcplMicros non-object rejected', Tier1InputError)
    throwsT1(() => tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w', 0, []), 'priorAcplMicros array (not w/b object) rejected', Tier1InputError)
    throwsT1(() => tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w', 0, { w: 'x' }), 'side window not an array rejected', Tier1InputError)
    throwsT1(() => tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w', 0, { w: [-5] }), 'negative acpl in window rejected (trajectoryMicro guard)', Tier1InputError)
    throwsT1(() => tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w', 0, { w: [2_000_000_001] }), 'window acpl above MAX_CPL_MICRO rejected', Tier1InputError)
    throwsT1(() => tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w', 0, { w: new Array(64).fill(0) }), 'window + this game > TRAJ_MAX_WINDOW rejected', Tier1InputError)
  }

  // ---- (g) Tier1Anchors -----------------------------------------------------
  console.log('\n· Tier1Anchors: provisional shape + expectation interp')
  eq(TIER1_ANCHORS_PROVISIONAL.v, 1, 'provisional anchors v1')
  eq(TIER1_ANCHORS_PROVISIONAL.nodes, PARAMS_A5.t1Nodes, 'anchors target the t1 node count')
  eq(TIER1_ANCHORS_PROVISIONAL.multiPv, PARAMS_A5.t1MultiPv, 'anchors target the t1 MultiPV')
  ok(TIER1_ANCHORS_PROVISIONAL.fit.includes('[J3-REFIT-PENDING]'), 'provisional set is marked [J3-REFIT-PENDING]')
  ok(
    TIER1_ANCHORS_PROVISIONAL.acplByElo.every((k, i, a) => i === 0 || (k.elo > a[i - 1].elo && k.acplMicro < a[i - 1].acplMicro)),
    'knots strictly ascending in elo, strictly descending in acpl'
  )
  eq(expectedAcplMicro(TIER1_ANCHORS_PROVISIONAL, 400), 116_331_117, 'knot hit: elo 400')
  eq(expectedAcplMicro(TIER1_ANCHORS_PROVISIONAL, 2700), 19_968_053, 'knot hit: elo 2700')
  eq(expectedAcplMicro(TIER1_ANCHORS_PROVISIONAL, 500), 111_067_805, 'midpoint interp with floor division')
  eq(expectedAcplMicro(TIER1_ANCHORS_PROVISIONAL, 100), 116_331_117, 'below range clamps to the first knot')
  eq(expectedAcplMicro(TIER1_ANCHORS_PROVISIONAL, 3200), 19_968_053, 'above range clamps to the last knot')
  eq(expectedAcplMicro(TIER1_ANCHORS_PROVISIONAL, 1500), 50_779_794, 'knot hit: elo 1500')
  ok(TIER1_ANCHORS_PROVISIONAL.sigmaAcplMicro > 0, 'sigmaAcplMicro positive')

  // ---- (h) fail-closed malformed-input matrix ------------------------------
  console.log('\n· fail-closed matrix (Tier1InputError on every entry)')
  const T1 = Tier1InputError
  const rec = () => tier1Record('g', 'l', FIX_A, MOVES_A, 'w')
  ok(!!rec(), 'sanity: the well-formed baseline builds')
  throwsT1(() => tier1Record('', 'l', FIX_A, MOVES_A), 'empty gameKey', T1)
  throwsT1(() => tier1Record('g', '', FIX_A, MOVES_A), 'empty ladderId', T1)
  throwsT1(() => tier1Record('g', 'l', FIX_A, MOVES_A, 'x'), "firstMover 'x'", T1)
  throwsT1(() => tier1Record('g', 'l', { ...FIX_A, v: 2 }, MOVES_A), 'JudgeOutput.v ≠ 1', T1)
  throwsT1(
    () => tier1Record('g', 'l', { ...FIX_A, config: { ...CFG, params: 'not-the-digest' } }, MOVES_A),
    'params echo ≠ PARAMS_A5_DIGEST (foreign rule set refused)',
    T1
  )
  throwsT1(() => tier1Record('g', 'l', { ...FIX_A, positions: [] }, MOVES_A), 'empty positions', T1)
  throwsT1(
    () => tier1Record('g', 'l', { ...FIX_A, positions: [FIX_A.positions[1], FIX_A.positions[0]] }, MOVES_A),
    'judged plies not strictly increasing',
    T1
  )
  throwsT1(
    () => tier1Record('g', 'l', { ...FIX_A, positions: [{ ply: 0, lines: [] }] }, MOVES_A),
    'empty lines at a judged ply',
    T1
  )
  throwsT1(
    () =>
      tier1Record('g', 'l', { ...FIX_A, positions: [{ ply: 0, lines: [{ move: 'e2e4', cp: 10, mate: 2 }] }] }, MOVES_A),
    'line with BOTH cp and mate',
    T1
  )
  throwsT1(
    () => tier1Record('g', 'l', { ...FIX_A, positions: [{ ply: 0, lines: [{ move: 'e2e4' }] }] }, MOVES_A),
    'line with NEITHER cp nor mate',
    T1
  )
  throwsT1(
    () => tier1Record('g', 'l', { ...FIX_A, positions: [{ ply: 0, lines: [{ move: 'e2e4', mate: 0 }] }] }, MOVES_A),
    'line with mate 0 (impossible from J1)',
    T1
  )
  throwsT1(
    () => tier1Record('g', 'l', { ...FIX_A, positions: [{ ply: 0, lines: [{ move: 'e9e9', cp: 10 }] }] }, MOVES_A),
    'non-UCI line move',
    T1
  )
  throwsT1(
    () => tier1Record('g', 'l', { ...FIX_A, positions: [{ ply: 0, lines: [{ move: 'e2e4', cp: 10.5 }] }] }, MOVES_A),
    'float cp',
    T1
  )
  throwsT1(
    () =>
      tier1Record(
        'g',
        'l',
        {
          ...FIX_A,
          positions: [
            {
              ply: 0,
              lines: [
                { move: 'a2a3', cp: 1 },
                { move: 'b2b3', cp: 1 },
                { move: 'c2c3', cp: 1 },
                { move: 'd2d3', cp: 1 },
                { move: 'e2e3', cp: 1 },
              ],
            },
          ],
        },
        MOVES_A
      ),
    'more lines than multiPv',
    T1
  )
  throwsT1(
    () => tier1Record('g', 'l', { ...FIX_A, positions: [{ ply: 6, lines: [{ move: 'e2e4', cp: 10 }] }] }, MOVES_A),
    'judged ply beyond the transcript',
    T1
  )
  throwsT1(() => tier1Record('g', 'l', FIX_A, []), 'empty transcript', T1)
  throwsT1(
    () => tier1Record('g', 'l', FIX_A, [...MOVES_A.slice(0, 5), { ...MOVES_A[5], ply: 7 }]),
    'transcript plies not contiguous',
    T1
  )
  throwsT1(
    () => tier1Record('g', 'l', FIX_A, [{ ...MOVES_A[0], move: '' }, ...MOVES_A.slice(1)]),
    'empty transcript move string',
    T1
  )
  throwsT1(
    () => tier1Record('g', 'l', FIX_A, [{ ...MOVES_A[0], move: 'x'.repeat(65) }, ...MOVES_A.slice(1)]),
    'transcript move over 64 chars',
    T1
  )
  throwsT1(
    () => tier1Record('g', 'l', FIX_A, [{ ...MOVES_A[0], clockMs: { w: 0.5, b: 1000 } }, ...MOVES_A.slice(1)]),
    'float clockMs',
    T1
  )
  throwsT1(
    () => tier1Record('g', 'l', FIX_A, [{ ...MOVES_A[0], clockMs: { w: -1, b: 1000 } }, ...MOVES_A.slice(1)]),
    'negative clockMs',
    T1
  )
  throwsT1(
    () => tier1Record('g', 'l', FIX_A, [{ ...MOVES_A[0], clockMs: { w: NaN, b: 1000 } }, ...MOVES_A.slice(1)]),
    'NaN clockMs',
    T1
  )
  throwsT1(() => acplMicro([1.5]), 'acplMicro: float loss', T1)
  throwsT1(() => acplMicro([-1]), 'acplMicro: negative loss', T1)
  throwsT1(() => acplMicro('nope'), 'acplMicro: non-array', T1)
  throwsT1(() => engineMatchMicro(3, 2), 'engineMatchMicro: matched > scored', T1)
  throwsT1(() => engineMatchMicro(-1, 2), 'engineMatchMicro: negative matched', T1)
  throwsT1(() => isEngineMatched(10.5, [{ move: 'a2a3', cp: 0 }]), 'isEngineMatched: float playedCp', T1)
  throwsT1(() => isEngineMatched(0, []), 'isEngineMatched: empty lines', T1)
  throwsT1(() => isEngineMatchedBest(10.5, [{ move: 'a2a3', cp: 0 }]), 'isEngineMatchedBest: float playedCp', T1)
  throwsT1(() => isEngineMatchedBest(0, []), 'isEngineMatchedBest: empty lines', T1)
  throwsT1(
    () => isEngineMatchedBest(0, [{ move: 'a2a3', cp: 0 }, { move: 'zz', cp: 1 }]),
    'isEngineMatchedBest: malformed non-best line refused (fail-closed on ALL lines)',
    T1
  )
  throwsT1(() => complexityMicro([]), 'complexityMicro: empty lines', T1)
  throwsT1(() => complexityMicro([{ move: 'a2a3', mate: 0 }]), 'complexityMicro: mate 0 line', T1)
  throwsT1(() => clockForensicMicro([{ thinkMs: 0.5, complexityMicro: 1_000_000 }]), 'clockForensicMicro: float thinkMs', T1)
  throwsT1(
    () => clockForensicMicro([{ thinkMs: 100, complexityMicro: 299_999 }]),
    'clockForensicMicro: complexity below the fold floor',
    T1
  )
  throwsT1(
    () => clockForensicMicro([{ thinkMs: 100, complexityMicro: 4_000_001 }]),
    'clockForensicMicro: complexity above the fold ceiling',
    T1
  )
  throwsT1(
    () => clockForensicMicro([{ thinkMs: 1_000_000_001, complexityMicro: 1_000_000 }]),
    'clockForensicMicro: thinkMs above CLOCK_THINK_CAP_MS',
    T1
  )
  throwsT1(() => trajectoryMicro(new Array(65).fill(0)), 'trajectoryMicro: window > TRAJ_MAX_WINDOW', T1)
  throwsT1(() => trajectoryMicro([-5]), 'trajectoryMicro: negative acplMicro', T1)
  throwsT1(() => trajectoryMicro([2_000_000_001]), 'trajectoryMicro: acplMicro above MAX_CPL_MICRO', T1)
  throwsT1(() => expectedAcplMicro(TIER1_ANCHORS_PROVISIONAL, 1500.5), 'expectedAcplMicro: float elo', T1)
  throwsT1(
    () => expectedAcplMicro({ ...TIER1_ANCHORS_PROVISIONAL, acplByElo: [{ elo: 400, acplMicro: 1 }] }, 1500),
    'anchors with a single knot',
    T1
  )
  throwsT1(
    () =>
      expectedAcplMicro(
        {
          ...TIER1_ANCHORS_PROVISIONAL,
          acplByElo: [
            { elo: 600, acplMicro: 10 },
            { elo: 400, acplMicro: 20 },
          ],
        },
        500
      ),
    'anchors with descending elo knots',
    T1
  )
  throwsT1(() => expectedAcplMicro({ ...TIER1_ANCHORS_PROVISIONAL, sigmaAcplMicro: 0 }, 1500), 'anchors with zero sigma', T1)
  throwsT1(() => sideMoveScores(FIX_A, MOVES_A, 'white'), "sideMoveScores: side 'white'", T1)
  throwsT1(() => clockSamplesForSide(FIX_A, MOVES_A, 'w', 'W'), "clockSamplesForSide: firstMover 'W'", T1)
  // A5-15: the credited incMs must stay inside the witness-signed tc envelope.
  throwsT1(() => clockSamplesForSide(FIX_A, MOVES_A, 'w', 'w', -1), 'clockSamplesForSide: negative incMs', T1)
  throwsT1(() => clockSamplesForSide(FIX_A, MOVES_A, 'w', 'w', 2.5), 'clockSamplesForSide: float incMs', T1)
  throwsT1(() => clockSamplesForSide(FIX_A, MOVES_A, 'w', 'w', 3_600_001), 'clockSamplesForSide: incMs above CLOCK_INC_MAX_MS', T1)
  throwsT1(() => tier1Record('g', 'l', FIX_A, MOVES_A, 'w', -1), 'tier1Record: negative incMs rejected fail-closed', T1)

  // ---- (i) A5-01: canonical judging surface + full-coverage record rule ----
  console.log('\n· A5-01: transcriptToJudgePositions + tier1Record coverage rule')
  {
    // The normative builder: every ply 0..n−1, bare fenBefore, no tail, no
    // moves-path. Two independent callers over the same (moves, fenBeforeOf)
    // must produce identical positions.
    const fens = MOVES_A.map((_, i) => `p${i}/8/8/8/8/8/8/8 w - - 0 1`)
    const posA = transcriptToJudgePositions(MOVES_A, (i) => fens[i])
    const posB = transcriptToJudgePositions(MOVES_A.map((m) => ({ ...m })), (i) => fens[i])
    eq(
      JSON.stringify(posA),
      JSON.stringify(MOVES_A.map((_, i) => ({ ply: i, fen: fens[i] }))),
      'builder: EXACTLY [{ply:i, fen:fenBeforeOf(i)}] for every transcript ply (no tail)'
    )
    eq(JSON.stringify(posA), JSON.stringify(posB), 'builder agreement: two independent callers → identical positions')
    ok(posA.every((p) => !('moves' in p)), 'builder output never carries a moves/path field')
    let name = null
    try {
      transcriptToJudgePositions([], () => 'x')
    } catch (e) {
      name = e?.name
    }
    eq(name, 'JudgeConfigError', 'builder: empty transcript fails closed (JudgeConfigError)')
  }
  // Coverage enforcement at the record trust boundary (closes the
  // cherry-picked-subset escalation evasion):
  throwsT1(
    () => tier1Record('g', 'l', { ...FIX_A, positions: [FIX_A.positions[0], FIX_A.positions[2]] }, MOVES_A),
    'cherry-picked subset (plies {0,2} of 6) REJECTED: was accepted pre-fix with empty signals',
    T1
  )
  throwsT1(
    () => tier1Record('g', 'l', { ...FIX_A, positions: FIX_A.positions.filter((p) => p.ply !== 3) }, MOVES_A),
    'interior gap (ply 3 missing) REJECTED',
    T1
  )
  throwsT1(
    () => tier1Record('g', 'l', { ...FIX_A, positions: FIX_A.positions.slice(0, 5) }, MOVES_A),
    'prefix subset (plies 0..4 of 6) REJECTED (partial views stay sideMoveScores-level diagnostics)',
    T1
  )
  throwsT1(
    () =>
      tier1Record(
        'g',
        'l',
        { ...FIX_A, positions: [{ ...FIX_A.positions[0], moves: ['e2e4'] }, ...FIX_A.positions.slice(1)] },
        MOVES_A
      ),
    'judged position carrying a moves/path field REJECTED (bare-FEN encoding pinned)',
    T1
  )
  eq(
    tier1Digest(tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w')),
    'chzY1umBfAfE9M6Ce6u_73xtvCaMEIwOK7dw_mKVm-8',
    'full-coverage record still ACCEPTED: tier1Digest byte-identical to the pre-fix frozen value'
  )

  // ---- (j) A5-37: canonical fixed-node config gate -------------------------
  // PARAMS_A5_DIGEST pins BOTH tiers' rule set at once, so a Tier-2
  // (t2Nodes/t2MultiPv) or degenerate JudgeOutput carries the SAME params echo
  // and slipped through tier1Record's old sole config gate, minting a
  // well-formed "Tier-1" record whose matchMicro/acpl are computed at the wrong
  // search width and then z-scored against the 200k/MPV4-fit anchors. The gate
  // now requires config === judgeConfigForTier(1) (nodes/multiPv/hashMb) and
  // rejects every mismatch fail-closed. (The record commits to the whole
  // JudgeOutput via `judge`, so a verifier's own recompute re-runs this gate.)
  console.log('\n· A5-37: canonical fixed-node config gate')
  {
    const CFG_NEEDLE = 'not the Tier-1 config' // gate message: proves THIS gate fired
    // FIX_A re-stamped with a non-canonical config; params echo untouched (the
    // exact params-digest indistinguishability the finding cites). multiPv/hashMb
    // overrides stay ≥ FIX_A's 4 lines so checkJudgeOutput's line-count check
    // passes and the CONFIG gate (not another check) is the rejecter.
    const withCfg = (over) => ({ ...FIX_A, config: { ...CFG, ...over } })
    const throwsCfg = (over, label) => {
      let err = null
      try {
        tier1Record('g', 'l', withCfg(over), MOVES_A, 'w')
      } catch (e) {
        err = e
      }
      ok(
        (err instanceof Tier1InputError || err?.name === 'Tier1InputError') &&
          String(err?.message).includes(CFG_NEEDLE),
        `${label} REJECTED by the config gate (${err?.name}: ${String(err?.message).slice(0, 64)})`
      )
    }
    // Positive-control preconditions: the fixture CFG really IS the Tier-1 config,
    // so acceptance below is a genuine control (not a vacuous pass).
    eq(CFG.nodes, PARAMS_A5.t1Nodes, 'precondition: fixture CFG.nodes === t1Nodes')
    eq(CFG.multiPv, PARAMS_A5.t1MultiPv, 'precondition: fixture CFG.multiPv === t1MultiPv')
    eq(CFG.hashMb, PARAMS_A5.hashMb, 'precondition: fixture CFG.hashMb === hashMb')
    ok(!!tier1Record('g', 'l', FIX_A, MOVES_A, 'w'), 'canonical Tier-1 config still ACCEPTED')
    eq(
      tier1Digest(tier1Record('game-c', 'blitz', FIX_C, MOVES_C, 'w')),
      'chzY1umBfAfE9M6Ce6u_73xtvCaMEIwOK7dw_mKVm-8',
      'A5-37 digest-invariance: canonical-config record byte-identical (gate added no field, changed no accepted-path bit)'
    )
    // The finding's exact failure scenario: a Tier-2 output (t2Nodes=2M,
    // t2MultiPv=6) with the SAME params digest is no longer minted as Tier-1.
    throwsCfg(
      { nodes: PARAMS_A5.t2Nodes, multiPv: PARAMS_A5.t2MultiPv },
      'Tier-2 config output (2M nodes / MPV6, identical params echo)'
    )
    // The degenerate output the finding names (nodes=1 / MPV6 / Hash1).
    throwsCfg({ nodes: 1, multiPv: 6, hashMb: 1 }, 'degenerate config (nodes=1 / MPV6 / Hash1)')
    // Each config field isolated:
    throwsCfg({ nodes: 199_999 }, 'nodes off by one (199999)')
    throwsCfg({ nodes: 100_000 }, 'nodes too low (100000)')
    throwsCfg({ multiPv: 6 }, 'multiPv wider than Tier-1 (6)')
    throwsCfg({ hashMb: 8 }, 'hashMb below the pinned 16')
    throwsCfg({ hashMb: 32 }, 'hashMb above the pinned 16')
  }

  // ---- (k) A5-06: wrong-config record class unmintable AND unverifiable -----
  // A5-37 (§(j)) closed the code hole and pinned the Tier-2 / degenerate output
  // at MINT; A5-06 is the test-coverage residual. The two regressions §(j)
  // does not carry. (1) The finding's LITERAL scenario: judged at nodes=1
  // ("near-random lines") with multiPv/hashMb left CANONICAL to look compliant
  // (§(j)'s nodes=1 case bundles MPV6/Hash1), isolating the nodes gate at the
  // named value. (2) The END-TO-END consequence the finding names ("the record
  // drops the config … no suite contains an assertion that could ever flag this
  // record class"): the Tier1Record body carries no raw nodes/multiPv, but it
  // COMMITS to the whole JudgeOutput (config included) via `judge` =
  // judgeOutputDigest(out), so config is never erased from the verdict trail.
  // A nodes=1 output digests DIFFERENTLY, and because a producer's mint and a
  // verifier's recompute are the SAME tier1Record(out) call, that recompute
  // re-runs the A5-37 gate and throws. The class is thus both unmintable and
  // unreproducible; the record carries no config field, so the Tier-2 layer has
  // nothing to (and nothing it could) re-check, the mkRec "no config" note is
  // subsumed by this mint/recompute boundary, not a live gap.
  console.log('\n· A5-06: wrong-config record class unmintable + unverifiable (end-to-end)')
  {
    const OUT_N1 = { ...FIX_A, config: { ...CFG, nodes: 1 } }
    // (1) The finding's literal failure scenario, mintable pre-A5-37.
    throwsT1(
      () => tier1Record('g', 'l', OUT_N1, MOVES_A, 'w'),
      'nodes=1 near-random output (multiPv/hashMb canonical) REJECTED, the finding scenario, mintable pre-A5-37',
      Tier1InputError
    )
    // (2) End-to-end: the record COMMITS to config through `judge`.
    const recCanon = tier1Record('g', 'l', FIX_A, MOVES_A, 'w')
    eq(
      recCanon.judge,
      judgeOutputDigest(FIX_A),
      'canonical record `judge` === judgeOutputDigest(output): the record commits to the exact JudgeOutput config'
    )
    ok(
      judgeOutputDigest(OUT_N1) !== judgeOutputDigest(FIX_A),
      'config is covered by the judge digest. The nodes=1 output digests DIFFERENTLY (config recoverable/enforceable at recompute, never silently erased)'
    )
    // The recompute over OUT_N1 (asserted throwing above) IS the flag the
    // finding says no suite has; the record itself carries no config field, so
    // the (nodes,multiPv) contract lives at THIS mint/recompute boundary. There
    // is nothing for the Tier-2 layer / mkRec to (or that could) re-check.
    ok(
      !('config' in recCanon),
      'Tier1Record carries no config field. The (nodes,multiPv) contract lives at the tier1 mint/recompute boundary, not the record body (mkRec end-to-end note subsumed)'
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
