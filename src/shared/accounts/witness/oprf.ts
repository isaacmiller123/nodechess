// Threshold OPRF for the PIN committee (spec §1): a thin, CORRECT wrapper over
// @noble/curves ristretto255_oprf (RFC 9497 OPRF(ristretto255, SHA-512)).
//
// The committee holds Shamir shares k_i of the OPRF key k. The client blinds
// its PIN once; each member evaluates the blinded element under its share; the
// client Lagrange-combines the partial evaluations IN THE GROUP to obtain the
// exact same element a single-key holder of k would return, then finalizes with
// the stock RFC 9497 finalize, so the derived PIN key is spec-compatible and
// deriving it REQUIRES a committee round (offline brute force is impossible;
// the rate limit lives with the committee counter).
//
// Correctness invariant (proven in scripts/test-accounts-pin.mjs):
//   finalize(pin, blind, combinePartials([k_i·B], idx))
//     === finalize(pin, blind, blindEvaluate(k, B))
// for k split T-of-N into {k_i}. combine = Σ λ_i(0)·(k_i·B) = (Σ λ_i k_i)·B = k·B.
//
// Platform-neutral: no `node:` imports, no DOM globals.

import { ristretto255_oprf } from '@noble/curves/ed25519.js'
import { ed25519, hmacSha512, sha512, toB64u, fromB64u, utf8, concatBytes } from '../hash'
import type { B64u } from '../types'
import {
  G,
  ZERO,
  lagrangeCoeff,
  modL,
  randScalar,
  scalarToBytes,
  scalarFromBytes,
  pointFromBytes,
  pointToBytes,
  type RPoint,
  type Rng,
} from './shamir'

const OPRF = ristretto255_oprf.oprf

/** RFC 9497 OPRF output length for the ristretto255-SHA512 suite. */
export const OPRF_OUTPUT_BYTES = 64

/** PIN is encoded as its UTF-8 digit bytes for the OPRF input. */
function pinInput(pin: string): Uint8Array {
  if (!/^[0-9]{4,8}$/.test(pin)) throw new Error('oprf: PIN must be 4–8 digits')
  return utf8(pin)
}

// ---------------------------------------------------------------------------
// Client blind / member evaluate / combine / finalize
// ---------------------------------------------------------------------------

export interface BlindResult {
  /** Blinded group element sent to every committee member (B = r·H(pin)). */
  blinded: B64u
  /** Secret blind scalar r, kept locally until finalize. Never sent. */
  blindState: B64u
}

/** Client step 1: blind the PIN. `rng` is injected so tests are reproducible. */
export function clientBlind(pin: string, rng?: Rng): BlindResult {
  const input = pinInput(pin)
  // @noble's blind takes an optional (bytesLength?)=>bytes RNG; adapt our Rng.
  const b = rng ? OPRF.blind(input, (len?: number) => rng(len ?? 32)) : OPRF.blind(input)
  return { blinded: toB64u(b.blinded), blindState: toB64u(b.blind) }
}

/**
 * Committee member step: partial evaluation P_i = k_i · B, where B is the
 * blinded element and k_i the member's Shamir share. Returns the point bytes.
 * A member returning a wrong partial is detectable via dleqProve/dleqVerify
 * against the member's published shareCommitment (k_i·G).
 */
export function memberBlindEvaluate(shareScalar: bigint, blinded: B64u): B64u {
  const B = pointFromBytes(fromB64u(blinded))
  const k = modL(shareScalar)
  const partial = k === 0n ? ZERO : B.multiply(k)
  return toB64u(pointToBytes(partial))
}

export interface Partial {
  /** Committee member index (1-based x-coordinate, == its Shamir share index). */
  i: number
  /** Partial evaluation bytes (k_i·B). */
  partial: B64u
}

/**
 * Client step 2: Lagrange-combine ≥ t partial evaluations in the GROUP into the
 * element k·B. Uses exactly the first `t` supplied partials; their indices must
 * be distinct. Pure and deterministic.
 */
export function combinePartials(partials: readonly Partial[], t: number): B64u {
  if (partials.length < t) throw new Error(`oprf.combinePartials: need ≥ ${t} partials, got ${partials.length}`)
  const use = partials.slice(0, t)
  const idxs = use.map((p) => p.i)
  if (new Set(idxs).size !== idxs.length) throw new Error('oprf.combinePartials: duplicate member indices')
  let acc: RPoint = ZERO
  for (const p of use) {
    const point = pointFromBytes(fromB64u(p.partial))
    const lambda = lagrangeCoeff(idxs, p.i)
    acc = acc.add(lambda === 0n ? ZERO : point.multiply(lambda))
  }
  return toB64u(pointToBytes(acc))
}

/**
 * Client step 3: finalize. `combined` must be k·B (from combinePartials or a
 * single-key blindEvaluate). Returns the 64-byte RFC 9497 OPRF output. Pure.
 */
export function clientFinalize(pin: string, blindState: B64u, combined: B64u): Uint8Array {
  const input = pinInput(pin)
  return OPRF.finalize(input, fromB64u(blindState), fromB64u(combined))
}

// ---------------------------------------------------------------------------
// Single-key reference path (for the correctness test + the dealer's self-check)
// ---------------------------------------------------------------------------

/** Non-threshold blindEvaluate under the full key k: the reference the
 * threshold path must reproduce bit-for-bit. */
export function singleKeyBlindEvaluate(k: bigint, blinded: B64u): B64u {
  return toB64u(OPRF.blindEvaluate(scalarToBytes(k), fromB64u(blinded)))
}

/** End-to-end single-key OPRF output for a PIN under key k (no committee). */
export function singleKeyOutput(pin: string, k: bigint, rng?: Rng): Uint8Array {
  const bl = clientBlind(pin, rng)
  const evald = singleKeyBlindEvaluate(k, bl.blinded)
  return clientFinalize(pin, bl.blindState, evald)
}

// ---------------------------------------------------------------------------
// PIN key stretch (spec §1: OPRF output → ed25519 keypair)
// ---------------------------------------------------------------------------

// Domain-separation tags below keep their pre-rebrand spelling on purpose. They
// are hashed into key material and into the Fiat–Shamir transcript, so editing
// one is not a rename. It derives a different keypair from the same PIN
// (locking every existing account out of recovery) and makes new proofs
// unverifiable against peers still running the old tag.
const PIN_KEY_DST = utf8('chess-sharp-pin')

export interface PinKeyPair {
  /** 32-byte ed25519 seed (private). Never leaves the client. */
  priv: Uint8Array
  /** ed25519 public key. Published in the PIN record as pinPub. */
  pub: Uint8Array
}

/**
 * Stretch a 64-byte OPRF output into an ed25519 keypair:
 *   seed = HMAC-SHA512('chess-sharp-pin', output)[0..32]
 *   (priv, pub) = ed25519 from seed
 * Deterministic: same output → same keypair on every platform.
 */
export function pinKeyFromOutput(output: Uint8Array): PinKeyPair {
  if (output.length !== OPRF_OUTPUT_BYTES) throw new Error('oprf.pinKeyFromOutput: output must be 64 bytes')
  // HMAC-SHA512 keyed by the domain tag over the OPRF output; first 32 bytes seed ed25519.
  const stretched = hmacSha512(PIN_KEY_DST, output)
  const priv = stretched.slice(0, 32)
  const pub = ed25519.getPublicKey(priv)
  return { priv, pub }
}

// ---------------------------------------------------------------------------
// DLEQ (Chaum–Pedersen): prove log_G(C_i) == log_B(P_i) without revealing k_i.
// Lets a client/verifier reject a member that returns a partial inconsistent
// with its published shareCommitment (spec §1 "a member returning a wrong
// partial is detectable"). Proof is Fiat–Shamir over SHA-512.
// ---------------------------------------------------------------------------

/** Hash a transcript of points to a scalar mod L (Fiat–Shamir challenge). */
function challenge(points: readonly RPoint[]): bigint {
  const h = sha512(concatBytes(utf8('chess-sharp-dleq-v1'), ...points.map((p) => pointToBytes(p))))
  let acc = 0n
  for (let i = 0; i < h.length; i++) acc = (acc << 8n) | BigInt(h[i])
  return modL(acc)
}

export interface DleqProof {
  c: B64u // challenge scalar bytes
  z: B64u // response scalar bytes
}

/**
 * Core Chaum–Pedersen assembly for a caller-supplied nonce `r`: proves
 * partial = k_i·B is consistent with commitment = k_i·G. The nonce MUST be
 * secret and unique per (share, transcript): reuse across distinct transcripts
 * leaks k_i. `dleqProve` (RNG) and `dleqProveDeterministic` (RFC-6979-style)
 * both funnel through here so the two paths can never disagree on the math.
 */
function dleqProveWithNonce(
  k: bigint,
  B: RPoint,
  Ci: RPoint,
  Pi: RPoint,
  r: bigint,
): DleqProof {
  const A1 = r === 0n ? ZERO : G.multiply(r) // r·G
  const A2 = r === 0n ? ZERO : B.multiply(r) // r·B
  const c = challenge([G, B, Ci, Pi, A1, A2])
  const z = modL(r + modL(c * k)) // z = r + c·k_i
  return { c: toB64u(scalarToBytes(c)), z: toB64u(scalarToBytes(z)) }
}

/**
 * Prove partial = k_i·B is consistent with commitment = k_i·G. `rng` supplies
 * the nonce (injected for reproducible tests).
 */
export function dleqProve(
  shareScalar: bigint,
  blinded: B64u,
  partial: B64u,
  commitment: B64u,
  rng: Rng,
): DleqProof {
  return dleqProveWithNonce(
    modL(shareScalar),
    pointFromBytes(fromB64u(blinded)),
    pointFromBytes(fromB64u(commitment)),
    pointFromBytes(fromB64u(partial)),
    randScalar(rng),
  )
}

/** Domain-separated key for the deterministic DLEQ nonce (RFC-6979 spirit). */
const DLEQ_NONCE_DST = utf8('chess-sharp-dleq-nonce-v1')

/**
 * Derive the DLEQ nonce deterministically from the SECRET share and the public
 * transcript: r = HMAC-SHA512(k_i, DST ‖ B ‖ P_i ‖ C_i) reduced mod L. HMAC is
 * keyed by the secret share, so r is unpredictable to anyone without k_i;
 * distinct blinded elements give distinct transcripts and therefore distinct r,
 * so a nonce is never reused across evaluations (reuse would leak k_i). Proving
 * the exact same (share, transcript) twice reproduces the same proof. Safe.
 */
function dleqNonce(shareScalar: bigint, blinded: B64u, partial: B64u, commitment: B64u): bigint {
  const key = scalarToBytes(modL(shareScalar))
  const h = hmacSha512(
    key,
    concatBytes(DLEQ_NONCE_DST, fromB64u(blinded), fromB64u(partial), fromB64u(commitment)),
  )
  let acc = 0n
  for (let i = 0; i < h.length; i++) acc = (acc << 8n) | BigInt(h[i])
  return modL(acc)
}

/**
 * Deterministic DLEQ prover: same math as `dleqProve` but with a safe,
 * RNG-free nonce (see `dleqNonce`). This is what committee members use so they
 * can ALWAYS emit a verifiable proof of an honest partial without any injected
 * randomness (spec §1: "a member returning a wrong partial is detectable").
 * Deterministic: same inputs → same proof on node and in the browser bundle.
 */
export function dleqProveDeterministic(
  shareScalar: bigint,
  blinded: B64u,
  partial: B64u,
  commitment: B64u,
): DleqProof {
  return dleqProveWithNonce(
    modL(shareScalar),
    pointFromBytes(fromB64u(blinded)),
    pointFromBytes(fromB64u(commitment)),
    pointFromBytes(fromB64u(partial)),
    dleqNonce(shareScalar, blinded, partial, commitment),
  )
}

/**
 * Verify a DLEQ proof: recompute A1' = z·G − c·C_i, A2' = z·B − c·P_i, accept
 * iff the challenge rederived over the transcript matches. Pure.
 */
export function dleqVerify(blinded: B64u, partial: B64u, commitment: B64u, proof: DleqProof): boolean {
  try {
    const B = pointFromBytes(fromB64u(blinded))
    const Pi = pointFromBytes(fromB64u(partial))
    const Ci = pointFromBytes(fromB64u(commitment))
    const c = scalarFromBytes(fromB64u(proof.c))
    const z = scalarFromBytes(fromB64u(proof.z))
    const A1 = subMul(G, z, Ci, c) // z·G − c·C_i
    const A2 = subMul(B, z, Pi, c) // z·B − c·P_i
    const expected = challenge([G, B, Ci, Pi, A1, A2])
    return modL(expected) === modL(c)
  } catch {
    return false
  }
}

// base·s − point·c
function subMul(base: RPoint, s: bigint, point: RPoint, c: bigint): RPoint {
  const a = modL(s) === 0n ? ZERO : base.multiply(modL(s))
  const b = modL(c) === 0n ? ZERO : point.multiply(modL(c))
  return a.add(b.negate())
}
