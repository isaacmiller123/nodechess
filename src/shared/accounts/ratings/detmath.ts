// detmath: deterministic dexp/dln for the ratings folds (ACCOUNTS-SPEC §6,
// §14 quality gates: same inputs → same BITS on node, every browser engine,
// and workers).
//
// Determinism argument: ECMA-262 pins Number arithmetic to IEEE 754 binary64
// with round-to-nearest-even, no extended intermediate precision and no FMA
// contraction, and fixes expression evaluation order, so + − × ÷ (and
// Math.sqrt) are correctly rounded and bit-identical on every conforming
// engine. Math.exp / Math.log / Math.pow are "implementation-approximated"
// (ECMA-262 Math object notes) and may differ across engines: BANNED in fold
// code; this module is the one sanctioned source of exp/ln. Everything below
// is built from the basic ops in a fixed order, plus Math.floor (exact; it
// introduces no rounding) and integer bit ops. Pure functions, platform-
// neutral: no node:/DOM imports, no Date.now, no Math.random.
//
// Scheme + provenance: FDLIBM 5.3 (Sun Microsystems' reference libm, the
// ancestor of musl's exp/log and of the fdlibm ports inside V8 / JSC /
// SpiderMonkey): e_exp.c and e_log.c. Constants and evaluation order are
// preserved verbatim so the published sub-ulp error analyses carry over:
//   dexp: Cody–Waite reduction x = k·ln2 + r (ln2 split hi/lo, k by
//         truncation of x/ln2 ± 0.5), degree-5 minimax polynomial for
//         r·(exp(r)+1)/(exp(r)−1) on |r| ≤ 0.5·ln2, reconstruction
//         exp(r) = 1 + 2r/(R(r)−r), then exact scaling by 2^k.
//   dln:  multiplicative normalization x = 2^k · m with m ∈ [√2/2, √2)
//         (each ×2 / ×0.5 step is exact), then with f = m−1, s = f/(2+f):
//         ln(m) = f − hfsq + s·(hfsq + R(s²)), degree-7 (odd) minimax
//         polynomial, k·ln2 added via the same hi/lo split.
// Both are < 1 ulp by fdlibm's analysis; measured against Math.exp/Math.log
// the relative error is < 1e-15 over the Glicko-relevant ranges. Far inside
// the ≤ 1e-12 budget (scripts/test-accounts-detmath.mjs asserts the bound and
// freezes exact output bit patterns as golden vectors).
//
// Special values (deterministic propagation rule: mirrors IEEE 754 exp/log;
// asserted in the suite):
//   dexp: NaN→NaN · +∞→+∞ · −∞→+0 · x > 709.782712893383973096 → +∞
//         (overflow) · x < −745.13321910194110842 → +0 (underflow; the
//         subnormal strip in between rounds deterministically via the
//         two-step scale below)
//   dln:  NaN→NaN · x<0→NaN · ±0→−∞ · +∞→+∞
//
// Glicko-2 (src/main/rating/glicko2.ts → ratings/glicko.ts) needs nothing
// else from here: sqrt is a basic correctly-rounded op, Math.min/max/abs/
// floor are exact, Math.PI is a fixed constant, and Math.pow(x, 2) is
// written x*x in fold code.
//
// FDLIBM notice (e_exp.c / e_log.c):
//   Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//   Developed at SunSoft, a Sun Microsystems, Inc. business.
//   Permission to use, copy, modify, and distribute this software is freely
//   granted, provided that this notice is preserved.

// ---- shared constants (fdlibm, verbatim) -----------------------------------
const LN2_HI = 6.93147180369123816490e-1 // high 33 bits of ln2 (low bits zero)
const LN2_LO = 1.90821492927058770002e-10 // ln2 − LN2_HI
const INV_LN2 = 1.44269504088896338700e0 // 1/ln2

// ---- exact power-of-two scaling --------------------------------------------
// 2^k for integer k ∈ [−1074, 1023] by binary exponentiation. Every
// intermediate is an exact power of two (powers of two down to 2^−1074 are
// exactly representable, and a product of two of them in range is exact), so
// no rounding ever occurs. Deterministic by construction.
function pow2(k: number): number {
  let r = 1.0
  let b = k < 0 ? 0.5 : 2.0
  let n = k < 0 ? -k : k
  while (n > 0) {
    if ((n & 1) === 1) r = r * b
    n >>>= 1
    if (n === 0) break
    b = b * b
  }
  return r
}

// ---- dexp ------------------------------------------------------------------
const EXP_P1 = 1.66666666666666019037e-1
const EXP_P2 = -2.77777777770155933842e-3
const EXP_P3 = 6.61375632143793436117e-5
const EXP_P4 = -1.65339022054652515390e-6
const EXP_P5 = 4.13813679705723846039e-8
const EXP_OVERFLOW = 7.09782712893383973096e2 // ln(DBL_MAX), last x that fits
const EXP_UNDERFLOW = -7.45133219101941108420e2 // below: even 2^−1075 rounds to 0
const TWO_M28 = 3.7252902984619140625e-9 // 2^−28

/**
 * Deterministic e^x. Relative error < 1 ulp vs true exp over all finite x
 * (fdlibm analysis); bit-identical on every conforming JS engine. Domain:
 * all of float64: overflow to +∞ above 709.78…, graceful underflow through
 * the subnormals to +0 below −745.13… . Specials per the header rule.
 */
export function dexp(x: number): number {
  if (x !== x) return NaN // NaN in → NaN out
  if (x === Infinity) return Infinity
  if (x === -Infinity) return 0
  if (x > EXP_OVERFLOW) return Infinity
  if (x < EXP_UNDERFLOW) return 0

  const ax = x < 0 ? -x : x
  if (ax < TWO_M28) return 1 + x // exp(x) = 1+x to > double precision

  // Cody–Waite: k = trunc(x/ln2 ± 0.5) (fdlibm casts to int, i.e. truncation
  // toward zero: Math.floor on the negated value reproduces that exactly),
  // r = (x − k·LN2_HI) − k·LN2_LO. k·LN2_HI is exact (|k| ≤ 1025 and LN2_HI
  // has ≥ 20 trailing zero bits), so r carries ~double-extended accuracy.
  const t = INV_LN2 * x + (x > 0 ? 0.5 : -0.5)
  const k = t >= 0 ? Math.floor(t) : -Math.floor(-t)
  const hi = x - k * LN2_HI
  const lo = k * LN2_LO
  const r = hi - lo

  // exp(r) = 1 + 2r/(R−r) with R = r − r²·P(r²) (fdlibm's rational form).
  const rr = r * r
  const c = r - rr * (EXP_P1 + rr * (EXP_P2 + rr * (EXP_P3 + rr * (EXP_P4 + rr * EXP_P5))))
  if (k === 0) return 1 - ((r * c) / (c - 2) - r)
  const y = 1 - (lo - (r * c) / (2 - c) - hi)

  // Scale by 2^k. y ∈ (0.7, 1.42), so for −1021 ≤ k ≤ 1023 the product stays
  // normal and the multiply is EXACT. k = 1024 (only near the overflow
  // threshold) splits off one doubling; k < −1021 (subnormal results) scales
  // in two steps so the single rounding into the subnormal range is the last
  // op: correctly rounded, deterministic.
  if (k >= -1021) {
    if (k > 1023) return y * pow2(k - 1) * 2
    return y * pow2(k)
  }
  return y * pow2(k + 1000) * pow2(-1000)
}

// ---- dln -------------------------------------------------------------------
const LOG_LG1 = 6.666666666666735130e-1
const LOG_LG2 = 3.999999999940941908e-1
const LOG_LG3 = 2.857142874366239149e-1
const LOG_LG4 = 2.222219843214978396e-1
const LOG_LG5 = 1.818357216161805012e-1
const LOG_LG6 = 1.531383769920937332e-1
const LOG_LG7 = 1.479819860511658591e-1
const SQRT1_2 = 0.7071067811865476 // nearest double to √2/2
const SQRT2 = 1.4142135623730951 // nearest double to √2

/**
 * Deterministic natural log. Relative error < 1 ulp vs true ln over all
 * positive finite x (fdlibm analysis): covers the required (0, 1e12] and
 * the whole float64 range including subnormals; bit-identical on every
 * conforming JS engine. Specials per the header rule.
 */
export function dln(x: number): number {
  if (x !== x) return NaN // NaN in → NaN out
  if (x < 0) return NaN
  if (x === 0) return -Infinity // covers ±0
  if (x === Infinity) return Infinity

  // Normalize x = 2^k · m, m ∈ [√2/2, √2). Each ×2 / ×0.5 is exact (pure
  // exponent shift; doubling a subnormal is exact too), so (k, m) is the
  // same on every engine. ≤ ~1074 iterations for the deepest subnormal.
  let k = 0
  let m = x
  while (m < SQRT1_2) {
    m = m * 2
    k = k - 1
  }
  while (m >= SQRT2) {
    m = m * 0.5
    k = k + 1
  }

  // fdlibm e_log core on f = m−1 ∈ [−0.2929, 0.4143]: with s = f/(2+f),
  // ln(1+f) = f − f²/2 + s·(f²/2 + R(s²)); k·ln2 folded in hi/lo.
  const f = m - 1
  const hfsq = 0.5 * f * f
  const s = f / (2 + f)
  const z = s * s
  const w = z * z
  const t1 = w * (LOG_LG2 + w * (LOG_LG4 + w * LOG_LG6))
  const t2 = z * (LOG_LG1 + w * (LOG_LG3 + w * (LOG_LG5 + w * LOG_LG7)))
  const R = t2 + t1
  // Fixed left-to-right evaluation (musl's proven ordering):
  return s * (hfsq + R) + k * LN2_LO - hfsq + f + k * LN2_HI
}
