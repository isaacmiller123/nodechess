// Shamir T-of-N secret sharing over the ristretto255 SCALAR field (order L),
// with Feldman verifiable-secret-sharing commitments (spec §1; the tOPRF PIN
// committee holds Shamir shares k_i of the OPRF key k).
//
// Platform-neutral: no `node:` imports, no DOM globals. Typechecks under both
// tsconfig.node.json and tsconfig.web.json.
//
// Determinism: recovery / Lagrange / commitment VERIFICATION are pure functions
// (same inputs → same bytes on node and in the browser bundle). GENERATION
// (splitScalar) draws its polynomial coefficients from an injected RNG so tests
// are reproducible; recovery of a fixed share set is bit-identical everywhere.

import { ristretto255 } from '@noble/curves/ed25519.js'
import type { CurvePoint } from '@noble/curves/abstract/curve.js'

const P = ristretto255.Point
const Fn = P.Fn

/**
 * A ristretto255 group element (share·G commitments, partial evaluations).
 * Typed via the public CurvePoint interface rather than the concrete class so
 * the exported type carries no private members (declaration-emit safe).
 */
export type RPoint = CurvePoint<bigint, RPoint>

/** The ristretto255 scalar-field order L (prime). All scalars live mod L. */
export const L: bigint = Fn.ORDER
/** Base point G of the prime-order ristretto255 group. */
export const G: RPoint = P.BASE
/** Identity element. */
export const ZERO: RPoint = P.ZERO

/** Injected randomness: n → n uniformly-random bytes (crypto RNG in prod, seeded in tests). */
export type Rng = (n: number) => Uint8Array

/** One share: x-coordinate `i` (1-based) and the polynomial value `share = f(i) mod L`. */
export interface Share {
  i: number
  share: bigint
}

/** Reduce any bigint into the canonical field range [0, L). */
export function modL(x: bigint): bigint {
  const r = x % L
  return r < 0n ? r + L : r
}

/** Uniformly-random non-zero-or-zero scalar in [0, L) from the injected RNG. */
export function randScalar(rng: Rng): bigint {
  // Reduce 64 random bytes mod L: the bias is < 2^-256, negligible.
  const b = rng(64)
  if (b.length < 64) throw new Error('shamir.randScalar: rng returned too few bytes')
  let acc = 0n
  for (let i = 0; i < b.length; i++) acc = (acc << 8n) | BigInt(b[i])
  return modL(acc)
}

/** Horner evaluation of a polynomial (coeffs low→high) at x, mod L. */
function evalPoly(coeffs: readonly bigint[], x: bigint): bigint {
  let acc = 0n
  const xm = modL(x)
  // Horner from the highest coefficient down keeps the loop mult-count minimal.
  for (let j = coeffs.length - 1; j >= 0; j--) acc = modL(modL(acc * xm) + modL(coeffs[j]))
  return acc
}

/**
 * The full verifiable deal: a degree-(t-1) polynomial with `secret` as its
 * constant term, its coefficients, the n shares f(1)..f(n), and the Feldman
 * commitments C_j = coeff_j·G. Callers that only need shares use splitScalar;
 * callers that publish per-share commitments (the PIN record) use
 * shareCommitment on each share.
 */
export interface Deal {
  shares: Share[]
  coeffs: bigint[]
  /** Feldman commitments C_j = coeff_j·G, index-aligned with `coeffs`. */
  commitments: RPoint[]
}

/**
 * Deal a secret T-of-N with Feldman commitments. The x-coordinates are the
 * 1-based member indices 1..n (0 is reserved for the secret).
 */
export function dealScalar(secret: bigint, t: number, n: number, rng: Rng): Deal {
  if (!Number.isInteger(t) || !Number.isInteger(n)) throw new Error('shamir.dealScalar: t,n must be integers')
  if (t < 1) throw new Error('shamir.dealScalar: t must be ≥ 1')
  if (n < t) throw new Error('shamir.dealScalar: n must be ≥ t')
  if (n > 255) throw new Error('shamir.dealScalar: n must be ≤ 255 (byte index space)')
  const coeffs: bigint[] = [modL(secret)]
  for (let j = 1; j < t; j++) coeffs.push(randScalar(rng))
  const shares: Share[] = []
  for (let i = 1; i <= n; i++) shares.push({ i, share: evalPoly(coeffs, BigInt(i)) })
  return { shares, coeffs, commitments: commitments(coeffs) }
}

/**
 * Lagrange basis coefficient λ_i(0) = Π_{j∈S, j≠i} j/(j−i) mod L, for the
 * index set S (the x-coordinates of the shares being combined). Pure.
 */
export function lagrangeCoeff(indices: readonly number[], i: number): bigint {
  let num = 1n
  let den = 1n
  const bi = BigInt(i)
  let seen = false
  for (const j of indices) {
    if (j === i) {
      seen = true
      continue
    }
    const bj = BigInt(j)
    num = modL(num * modL(bj))
    den = modL(den * modL(bj - bi))
  }
  if (!seen) throw new Error(`shamir.lagrangeCoeff: index ${i} not in the set`)
  if (den === 0n) throw new Error('shamir.lagrangeCoeff: duplicate x-coordinate in the set')
  return modL(num * Fn.inv(den))
}

/**
 * Recover the secret (polynomial value at 0) by Lagrange interpolation over
 * the FIRST `t` supplied shares. Pure and deterministic. With ≥ t honest
 * on-curve shares this returns the exact secret; with fewer than t, or with a
 * corrupted share, it returns a different scalar (the field gives no error;
 * that is why commitments exist).
 */
export function recoverScalar(shares: readonly Share[], t: number): bigint {
  if (shares.length < t) throw new Error(`shamir.recoverScalar: need ≥ ${t} shares, got ${shares.length}`)
  const use = shares.slice(0, t)
  const idxs = use.map((s) => s.i)
  if (new Set(idxs).size !== idxs.length) throw new Error('shamir.recoverScalar: duplicate share indices')
  let acc = 0n
  for (const s of use) acc = modL(acc + modL(modL(s.share) * lagrangeCoeff(idxs, s.i)))
  return acc
}

/**
 * Feldman commitments C_j = coeff_j·G for a coefficient vector. Anyone holding
 * these can verify a share is on the polynomial without learning other shares.
 */
export function commitments(coeffs: readonly bigint[]): RPoint[] {
  return coeffs.map((c) => {
    const m = modL(c)
    return m === 0n ? ZERO : G.multiply(m) // 0·G = identity (multiply(0) throws)
  })
}

/** Per-share commitment share·G: what the PIN record publishes per member. */
export function shareCommitment(share: bigint): RPoint {
  const s = modL(share)
  return s === 0n ? ZERO : G.multiply(s)
}

/**
 * Verify share (i, share) lies on the committed polynomial:
 *   share·G  ==  Σ_j C_j · i^j
 * Pure; catches a member silently swapping its share (spec §1) and any dealer
 * who hands out an off-polynomial share.
 */
export function verifyShare(i: number, share: bigint, commits: readonly RPoint[]): boolean {
  try {
    let acc: RPoint = ZERO
    let ip = 1n
    const bi = BigInt(i)
    for (const Cj of commits) {
      acc = acc.add(ip === 0n ? ZERO : Cj.multiply(ip))
      ip = modL(ip * bi)
    }
    return shareCommitment(share).equals(acc)
  } catch {
    return false
  }
}

/** ristretto point ↔ base64url-no-pad bytes (canonical RFC 9496 encoding). */
export function pointToBytes(p: RPoint): Uint8Array {
  return p.toBytes()
}
export function pointFromBytes(b: Uint8Array): RPoint {
  return P.fromBytes(b)
}
/** Scalar ↔ canonical field bytes (matches @noble ristretto255_oprf wire encoding). */
export function scalarToBytes(s: bigint): Uint8Array {
  return Fn.toBytes(modL(s))
}
export function scalarFromBytes(b: Uint8Array): bigint {
  return Fn.fromBytes(b)
}
