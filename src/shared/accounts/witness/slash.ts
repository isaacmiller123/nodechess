// A2 fabric: slashing adjudication (spec §4). Verdicts are DETERMINISTIC and
// mechanical: same evidence → same {guilty, slashed, reason} on node and in the
// browser bundle. Two shapes of fraud:
//
//  (1) Witnessed-lane fork: two distinct witnessed successors of one prev.
//      Self-authenticating (A1 fraud.detectFork over the two SIGNED events +
//      the account's certified keys); the USER is permanently slashed. This is
//      the ONLY sound path to a user-fork verdict: see adjudicateFork.
//
//  (2) Same-epoch double-grant: two validly-granted leases for one root at the
//      SAME epoch to DIFFERENT devices → the INTERSECTION grantors double-signed
//      and are the faulty set, attributed by keyOf (each grantor bound to its
//      advertised key so a fabricated grant set can't frame an honest witness).
//
// DIFFERENT-epoch lease pairs are NOT a double-grant: a later epoch legitimately
// supersedes an earlier one (a same-device re-fence or a PIN-gated takeover).
// Assigning fault to a different-epoch pair from the leases (or from unverified
// events) is unsound (it let a fabricated event pair slash honest grantors) so
// adjudicate returns guilty:'none' for it; a real fork under such leases is
// caught by the self-authenticating adjudicateFork path instead. (This is why
// DoubleGrantEvidence.events is unused by adjudicate; see its note.)
//
// Grant validity in slash is CONTEXT-FREE (≥ tLease distinct grant signatures
// verifying over the lease body AND bound to the grantor's key via keyOf). NOT
// eligibility (a liveness judgment; a slash stands on cryptographic evidence).
//
// Platform-neutral: no `node:` imports, no DOM globals.

import { detectFork, verifyForkProof } from '../fraud'
import type { B64u, ForkProof, SignedEvent } from '../types'
import { leaseBodyHash, verifyGrantSig } from './lease'
import type { DoubleGrantEvidence, Lease, NodeId, SlashVerdict } from './types'

/**
 * Detect a same-epoch witnessed-lane fork: two distinct witnessed events by one
 * root sharing one prev. Thin wrapper over A1 fraud.detectFork (the "same epoch"
 * qualifier is structural. A single linear witnessed lane advances one event
 * per prev, so any two successors of one prev were written under one lease).
 * Returns the self-authenticating ForkProof or null.
 */
export function detectSameEpochFork(
  a: SignedEvent,
  b: SignedEvent,
  certs: readonly SignedEvent[],
): ForkProof | null {
  return detectFork(a, b, certs)
}

/**
 * Adjudicate a same-epoch fork: the user forked its own single-writer lane, so
 * the USER (root) is permanently slashed. The proof must re-verify context-free.
 */
export function adjudicateFork(proof: ForkProof): SlashVerdict {
  if (!verifyForkProof(proof))
    return { guilty: 'none', slashed: [], reason: 'fork proof does not verify' }
  return {
    guilty: 'user',
    slashed: [proof.root],
    reason: 'same-epoch witnessed-lane fork: two successors of one prev under one lease',
  }
}

export interface AdjudicateOpts {
  /** Lease grant threshold: a lease is "validly granted" with ≥ this many
   * distinct verifying grant signatures per §4. */
  tLease: number
  /** nodeId → each grantor's advertised/certified signing key (presence/certs).
   * REQUIRED and load-bearing: a grant's `w` is self-declared, so without binding
   * it to a real key a fabricated grant set (attacker's key, honest members' w's)
   * could frame honest witnesses for a double-grant. Only grants whose key matches
   * the bound key are attributed. */
  keyOf: ReadonlyMap<NodeId, B64u>
}

/** Distinct grantors whose signature verifies over `lease` AND whose self-declared
 * `w` is bound to the key that signed (keyOf). A grant with an unbound or
 * mismatched key is NOT attributed. Closes fabricated-grant framing. */
function validGrantorSet(lease: Lease, keyOf: ReadonlyMap<NodeId, B64u>): Set<NodeId> {
  const hash = leaseBodyHash(lease.body)
  const set = new Set<NodeId>()
  for (const g of lease.grants) {
    if (set.has(g.w)) continue
    const bound = keyOf.get(g.w)
    if (bound === undefined || bound !== g.key) continue
    if (verifyGrantSig(g, hash)) set.add(g.w)
  }
  return set
}


/**
 * Adjudicate a double-grant appeal. Deterministic verdict per §4. Both leases
 * must be for the same root and each validly granted (≥ tLease distinct verifying
 * grants) for a fault to be assignable; otherwise the evidence is inconclusive.
 */
export function adjudicate(ev: DoubleGrantEvidence, opts: AdjudicateOpts): SlashVerdict {
  const { a, b } = ev
  if (a.body.root !== ev.root || b.body.root !== ev.root)
    return { guilty: 'none', slashed: [], reason: 'lease root mismatch' }

  const grantsA = validGrantorSet(a, opts.keyOf)
  const grantsB = validGrantorSet(b, opts.keyOf)
  if (grantsA.size < opts.tLease || grantsB.size < opts.tLease)
    return { guilty: 'none', slashed: [], reason: 'a lease is not validly granted (below tLease)' }

  // --- same epoch: two valid leases can only coexist if witnesses double-signed.
  if (a.body.epoch === b.body.epoch) {
    if (leaseBodyHash(a.body) === leaseBodyHash(b.body))
      return { guilty: 'none', slashed: [], reason: 'the two leases are identical (no conflict)' }
    // Same epoch + SAME device is a legitimate heartbeat / crash-recovery renewal
    // (the epoch holds; only grantedWts advances, so the body hash differs). The
    // single-writer invariant is intact. Nothing to slash. Without this, honest
    // grantors of a routine renewal would be slashed on sight.
    if (a.body.device === b.body.device)
      return { guilty: 'none', slashed: [], reason: 'same-epoch same-device renewal (crash recovery, not a double-grant)' }
    // Same epoch + DIFFERENT devices: witnesses granted two conflicting leases at
    // one epoch: the intersection grantors double-signed and are at fault.
    const intersection = [...grantsA].filter((w) => grantsB.has(w)).sort()
    return {
      guilty: 'witnesses',
      slashed: intersection,
      reason: 'same-epoch double-grant to different devices: grantors who signed both leases are slashed',
    }
  }

  // --- different epochs: NOT a double-grant. Leases at different epochs do not
  // conflict: a later epoch legitimately supersedes an earlier one (heartbeat
  // re-fence for the same device, or a PIN-gated takeover for a new device). A
  // witnessed-lane FORK actually written under such leases IS fraud, but it is
  // self-authenticating and adjudicated by detectSameEpochFork/adjudicateFork,
  // which cryptographically verify the two signed successors + the account's
  // certified keys. It is NOT assignable from the lease pair (or from unverified
  // events): doing so let a fabricated event pair slash honest grantors. The
  // double-grant path therefore returns no verdict for a different-epoch pair.
  return {
    guilty: 'none',
    slashed: [],
    reason: 'different-epoch leases are a legitimate supersession, not a double-grant; a real fork is adjudicated via adjudicateFork on the signed events',
  }
}
