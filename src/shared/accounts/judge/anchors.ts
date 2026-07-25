// A5 J3, estElo anchors REFIT AT THE JUDGE'S OWN CONFIG (spec §8 Tier-1: the
// shipped depth-12 MultiPV-2 fit does not transfer; the judge path needs
// anchors fitted at its fixed-node config). Consumed ONLY by the judge path:
// analysis/play keeps the shipped depth-12 fit (src/main/analysis/estElo.ts).
//
// Provenance (fully reproducible):
//   corpus  scripts/data/judge-elo-corpus.jsonl: 176 games / 352 rows, played
//           at known strengths by scripts/gen-judge-corpus.mjs (shared
//           game-generation machinery with the shipped corpus) and analyzed
//           through the REAL judge core: judgeGame() over the pinned-WASM Node
//           adapter at judgeConfigForTier(1) = 200_000 nodes, MultiPV 4,
//           Hash 16, ucinewgame + TT clear per judged game.
//   fit     scripts/fit-elo-model.mjs --corpus scripts/data/judge-elo-corpus.jsonl
//           --out scripts/data/judge-elo-fit.json   (2026-07-21; 282 train /
//           70 holdout rows). Holdout MAE 296.4 Elo with-opponent / 331.8
//           without (shipped depth-12 baseline: ≈275 / ≈325).
//   suite   scripts/test-judge-fit.mjs asserts this module round-trips
//           scripts/data/judge-elo-fit.json exactly.
//
// Every value is an INTEGER (milli-/micro-units) per the accounts
// integers-only convention. The params digest below is the PARAMS_A5_DIGEST
// the corpus was judged under. A LITERAL, not a live import, so a later
// params change can never silently re-tag this fitted artifact (the suite
// compares it against the current digest and fails loudly on drift).
//
// [A5-CALIBRATED] provisional-until-J6: the J6 calibration run re-pins these
// from a larger corpus; this set is the first REAL judge-config fit.

import type { Tier1Anchors } from './tier1'
import type { Tier2Anchors } from './tier2'

/** PARAMS_A5_DIGEST at fit time (rule set the whole corpus was judged under). */
export const JUDGE_ANCHORS_PARAMS_DIGEST = 'kkHGACUeDBJMna7_bCYZS3FD9TuRU5vv8GW4KCM4shU'

/** One calibration knot: feature in milli-units → Elo (both integers). */
export type JudgeFitKnot = {
  /** feature × 1000 (accuracy percent, or log(1+acpl)). */
  featMilli: number
  elo: number
}

/**
 * The full judge-config estElo fit (scripts/data/judge-elo-fit.json) in
 * integer form: the judge-path equivalent of the constants estElo.ts inlines
 * from the shipped depth-12 fit. Model shape is fit-elo-model.mjs's:
 * PAV-monotonized per-band calibration curves inverted to feature→Elo, blend
 * slopes summing to 1, bounded short-game shrink, structural opponent slope.
 */
export type JudgeEloFit = {
  v: 1
  /** judge config the corpus was analyzed at. */
  nodes: number
  multiPv: number
  hashMb: number
  /** PARAMS_A5_DIGEST at fit time. */
  params: string
  /** fit metadata: date + corpus/split sizes. */
  fitDate: string
  corpusRows: number
  trainRows: number
  holdoutRows: number
  /** holdout MAE × 10 (integer deci-Elo): with-opp / no-opp / acc-only. */
  maeHoldoutWithOppDeci: number
  maeHoldoutNoOppDeci: number
  maeHoldoutAccOnlyDeci: number
  /** accuracy(percent)×1000 → Elo, ascending (increasing curve). */
  accKnots: readonly JudgeFitKnot[]
  /** log(1+acpl)×1000 → Elo, band-ascending = featMilli descending. */
  acplKnots: readonly JudgeFitKnot[]
  /** blend/shrink/opponent coefficients, micro-units (×1_000_000). */
  coef: {
    a0Micro: number
    a1Micro: number
    c0Micro: number
    bShrinkMicro: number
    gOppMicro: number
  }
  shrink: { center: number; fullMoves: number; minMoves: number }
  clamp: { floor: number; ceil: number }
}

export const JUDGE_ELO_FIT: JudgeEloFit = {
  v: 1,
  nodes: 200_000,
  multiPv: 4,
  hashMb: 16,
  params: JUDGE_ANCHORS_PARAMS_DIGEST,
  fitDate: '2026-07-21',
  corpusRows: 352,
  trainRows: 282,
  holdoutRows: 70,
  maeHoldoutWithOppDeci: 2964,
  maeHoldoutNoOppDeci: 3318,
  maeHoldoutAccOnlyDeci: 4542,
  accKnots: [
    { featMilli: 65_524, elo: 400 },
    { featMilli: 75_717, elo: 600 },
    { featMilli: 80_287, elo: 903 },
    { featMilli: 82_300, elo: 1259 },
    { featMilli: 85_550, elo: 1691 },
    { featMilli: 88_374, elo: 2100 },
    { featMilli: 89_913, elo: 2300 },
    { featMilli: 90_867, elo: 2500 },
    { featMilli: 93_190, elo: 2700 },
  ],
  acplKnots: [
    { featMilli: 4960, elo: 400 },
    { featMilli: 4588, elo: 600 },
    { featMilli: 4354, elo: 903 },
    { featMilli: 4099, elo: 1259 },
    { featMilli: 3931, elo: 1500 },
    { featMilli: 3759, elo: 1783 },
    { featMilli: 3608, elo: 2100 },
    { featMilli: 3312, elo: 2395 },
    { featMilli: 2939, elo: 2700 },
  ],
  coef: {
    a0Micro: 11_400_000,
    a1Micro: 100_000,
    c0Micro: -86_200_000,
    bShrinkMicro: -320_000,
    gOppMicro: -125_700,
  },
  shrink: { center: 1500, fullMoves: 30, minMoves: 6 },
  clamp: { floor: 250, ceil: 3000 },
}

/**
 * J6. The MEASURED Tier-2 anchor bundle (replaces J4's provisional
 * placeholder): per-elo engine-match expectation + σ_match, and an ACPL
 * expectation curve + σ_acpl measured on the EXACT statistic the Tier-2
 * z-estimator consumes (tier1.ts Tier1Record acplMicro/matchMicro; integer
 * floors, tier1 mate map, unscored final move), which differs measurably from
 * the review-math acpl the J3 estElo fit was built on (that curve shows a
 * +15.9cp mean bias on this statistic; TIER1_ANCHORS_JUDGE stays the estElo
 * anchor set, THIS bundle feeds Tier-2 windows and T).
 *
 * Provenance (fully reproducible: test-judge-calibration.mjs recomputes
 * every integer in the bundle below from the corpus and fails on any drift):
 *   corpus  scripts/data/judge-calib-corpus.jsonl family=honest: 176 games /
 *           352 scored sides at known strengths (bands 400..2700, self/cross
 *           schedule, scripts/gen-cheater-corpus.mjs --family honest,
 *           2026-07-21), judged via judgeGame() over the pinned-WASM Node
 *           adapter at judgeConfigForTier(1) = 200_000 nodes MultiPV 4
 *           Hash 16, positions = every fenBefore (no terminal tail: the
 *           production Tier-1 surface).
 *   fit     per-band mean acplMicro/matchMicro, weighted-PAV monotonized
 *           (acpl nonincreasing, match nondecreasing in elo), residual σ over
 *           all 352 sides through the EXACT tier1/tier2 floor-division
 *           interpolation (expectedAcplMicro / expectedMatchMicro).
 *   honest  max trailing-30 z over the corpus = 1.482σ (split-half held-out
 *           2.123σ; exact micro 1_482_160 / 2_123_366): margin to the 3.0
 *           escalation trigger ≥ 1.51σ in-sample, ≥ 0.87σ held-out (the
 *           binding figure: 876_634 micro-σ). Re-measured 2026-07-22 from
 *           the committed corpus via the committed suite, identical across
 *           runs (A5-34; the prior 1.884σ / 1.932σ / ≥ 1.07σ figures did
 *           not reproduce). CAUTION: the suite PRINTS these z stats but
 *           asserts only z < 3.0σ: it does not pin them; re-run
 *           test-judge-calibration.mjs rather than citing this comment when
 *           tightening zEscalateMicro or signing off the honest-FPR margin.
 */
export const TIER2_ANCHORS_JUDGE: Tier2Anchors = {
  v: 1,
  acpl: {
    v: 1,
    nodes: 200_000,
    multiPv: 4,
    acplByElo: [
      { elo: 400, acplMicro: 169_414_921 },
      { elo: 600, acplMicro: 119_728_004 },
      { elo: 800, acplMicro: 118_677_628 },
      { elo: 1000, acplMicro: 90_800_703 },
      { elo: 1200, acplMicro: 81_547_906 },
      { elo: 1320, acplMicro: 81_547_906 },
      { elo: 1500, acplMicro: 61_257_319 },
      { elo: 1700, acplMicro: 52_454_268 },
      { elo: 1900, acplMicro: 45_654_995 },
      { elo: 2100, acplMicro: 45_654_995 },
      { elo: 2300, acplMicro: 40_486_944 },
      { elo: 2500, acplMicro: 28_326_545 },
      { elo: 2700, acplMicro: 25_222_111 },
    ],
    sigmaAcplMicro: 28_807_746,
    fit:
      'J6 measured 2026-07-21: corpus scripts/data/judge-calib-corpus.jsonl (honest, ' +
      '176 games / 352 sides, judged at 200000 nodes MultiPV 4 Hash 16, params ' +
      'kkHGACUeDBJMna7_bCYZS3FD9TuRU5vv8GW4KCM4shU), Tier1Record-statistic ACPL curve',
  },
  matchByElo: [
    { elo: 400, matchMicro: 598_918 },
    { elo: 600, matchMicro: 648_342 },
    { elo: 800, matchMicro: 652_231 },
    { elo: 1000, matchMicro: 723_127 },
    { elo: 1200, matchMicro: 772_914 },
    { elo: 1320, matchMicro: 786_640 },
    { elo: 1500, matchMicro: 842_770 },
    { elo: 1700, matchMicro: 864_253 },
    { elo: 1900, matchMicro: 885_736 },
    { elo: 2100, matchMicro: 885_736 },
    { elo: 2300, matchMicro: 893_316 },
    { elo: 2500, matchMicro: 924_137 },
    { elo: 2700, matchMicro: 938_809 },
  ],
  sigmaMatchMicro: 62_335,
  fit:
    'J6 measured 2026-07-21: corpus scripts/data/judge-calib-corpus.jsonl (honest, ' +
    '176 games / 352 sides, gen-cheater-corpus --family honest), judged at 200000 nodes ' +
    'MultiPV 4 Hash 16 under params kkHGACUeDBJMna7_bCYZS3FD9TuRU5vv8GW4KCM4shU; ' +
    'per-band weighted-PAV means + residual σ via the exact floor interpolation ' +
    '(suite: scripts/test-judge-calibration.mjs)',
}

/**
 * The J2 Tier1Anchors set fitted at the judge config (supersedes
 * TIER1_ANCHORS_PROVISIONAL on the judge path): the elo→expected-ACPL curve
 * is the judge fit's PAV-monotonized log(1+acpl)→Elo calibration knots
 * inverted via acpl = e^la − 1 (the same construction tier1.ts documents for
 * its provisional set, now from judge-config data). sigmaAcplMicro is the
 * measured residual std of per-game ACPL (micro-cp) about this curve over all
 * 352 corpus rows, evaluated with tier1.ts expectedAcplMicro's floor-division
 * interpolation.
 *
 * ROLE (A5-33): the estElo anchor set ONLY, spec §8 Tier-1's judge-config
 * estElo refit. It must NEVER be injected as a Tier-2 ACPL anchor
 * (Tier2Anchors.acpl): it was fit on the review-math ACPL of the estElo
 * corpus, and J6 measured it at +15.9cp mean bias on the Tier1Record
 * statistic the Tier-2 z-estimator consumes (the calibration suite's J3
 * cross-check recomputes this): as Tier2Anchors.acpl it deflates honest
 * devAcpl below zero, blunting detection and desyncing any evaluator from
 * the canonical escalation/T trigger. Tier-2 windows and T feed ONLY from
 * TIER2_ANCHORS_JUDGE above (tier2.ts header contract). checkTier2Anchors is
 * shape-only BY DESIGN (receipts re-verify historic verdicts under the
 * digest-pinned bundle they carry), so this role rule is the binding guard. It
 * is also carried in the `fit` tag below, so it travels with the value.
 */
export const TIER1_ANCHORS_JUDGE: Tier1Anchors = {
  v: 1,
  nodes: 200_000,
  multiPv: 4,
  acplByElo: [
    { elo: 400, acplMicro: 141_593_796 },
    { elo: 600, acplMicro: 97_297_638 },
    { elo: 903, acplMicro: 76_788_997 },
    { elo: 1259, acplMicro: 59_279_977 },
    { elo: 1500, acplMicro: 49_957_910 },
    { elo: 1783, acplMicro: 41_905_499 },
    { elo: 2100, acplMicro: 35_892_195 },
    { elo: 2395, acplMicro: 26_439_951 },
    { elo: 2700, acplMicro: 17_896_940 },
  ],
  sigmaAcplMicro: 21_902_355,
  fit:
    'J3 judge-config refit 2026-07-21: corpus scripts/data/judge-elo-corpus.jsonl ' +
    '(176 games / 352 rows, judged at 200000 nodes MultiPV 4 Hash 16, params ' +
    'kkHGACUeDBJMna7_bCYZS3FD9TuRU5vv8GW4KCM4shU), fit scripts/data/judge-elo-fit.json ' +
    '(holdout MAE 296.4 with-opp / 331.8 no-opp); estElo-only: must not feed Tier-2/T ' +
    '(J6: +15.9cp bias on the Tier1Record statistic; the only Tier-2/T bundle is TIER2_ANCHORS_JUDGE)',
}
