// A7 pairing attest (closes A4-02 fidelity + A4-10 freshness: the A5 hooks in
// ratings/fold.ts header and segment.ts verifyEmbeddedOppCkpt doc). The
// roster-aware SERVING WITNESS attests, at match time, the counterparty's
// (a) current vouched rating and (b) §4 head-cache height. Witness-signed ⇒
// chain-authoritative: ratingEvidenceOf upgrades the vouched pin from the
// embedded floor to (a), and bounds the embedded oppCkpt.through by (b).
// Read-time material only: NEVER an input to any fold (A4-04 discipline).
//
// LEAF module by construction: imports codec/hash/types ONLY. ratings/fold.ts
// consumes verifyPairingAttest, and fold is (transitively) imported by
// checkpoint.ts: routing this through witness/attest.ts (which imports
// checkpoint) would close a fold↔checkpoint import cycle. Keeping the pairing
// crypto here, dependency-free, is what breaks that cycle. witness/attest.ts
// re-exports these for callers that reach for the fabric surface.

import { canonicalBytes } from '../codec'
import { ed25519, toB64u, verifySigB64u } from '../hash'
import type { B64u } from '../types'

const PAIR_ATTEST_DOMAIN = 'cs:a7:pairattest:v1'

/** The pairing witness-attest carried on PairingPayload.witAttest. */
export interface PairingWitAttest {
  /** Witness-attested opponent vouched rating, micro units. */
  ratingMicro: number
  /** Witness-attested opponent §4 head height at match time (A4-10 bound). */
  headHeight: number
  /** Witness signing key. */
  w: B64u
  /** Witnessed time of the attest. */
  wts: number
  sig: B64u
}

function pairAttestBytes(game: B64u, opp: B64u, a: Omit<PairingWitAttest, 'sig'>): Uint8Array {
  return canonicalBytes({
    d: PAIR_ATTEST_DOMAIN,
    game,
    opp,
    r: a.ratingMicro,
    h: a.headHeight,
    w: a.w,
    wts: a.wts,
  })
}

/** Mint the serving witness's pairing attest (ed25519 over the domain-separated
 * canonical tuple: unreplayable across games/opponents by construction). */
export function makePairingAttest(
  game: B64u,
  opp: B64u,
  ratingMicro: number,
  headHeight: number,
  witnessKey: B64u,
  witnessPriv: Uint8Array,
  wts: number,
): PairingWitAttest {
  const body = { ratingMicro, headHeight, w: witnessKey, wts }
  const sig = toB64u(ed25519.sign(pairAttestBytes(game, opp, body), witnessPriv))
  return { ...body, sig }
}

/** Verify a pairing attest binds to (game, opp) and was signed by att.w.
 * Fail-closed on any malformation. Never throws. */
export function verifyPairingAttest(att: PairingWitAttest, game: B64u, opp: B64u): boolean {
  if (
    !Number.isSafeInteger(att.ratingMicro) || att.ratingMicro < 0 ||
    !Number.isSafeInteger(att.headHeight) || att.headHeight < 0 ||
    !Number.isSafeInteger(att.wts) || att.wts < 0
  )
    return false
  let msg: Uint8Array
  try {
    msg = pairAttestBytes(game, opp, att)
  } catch {
    return false
  }
  return verifySigB64u(att.sig, msg, att.w)
}
