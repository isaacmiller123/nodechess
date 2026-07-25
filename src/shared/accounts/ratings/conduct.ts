// A4 conduct + commendation primitives (spec §6b), PURE data + verification.
// No fabric, no network, no ambient time: builders return payloads the caller
// signs and appends via events.ts signBody / chain.ts appendWitnessed; the
// verifiers here prove everything a commend / rematch-accept can prove ABOUT
// ITSELF with no recursion into the counterparty's chain.
//
// Trust model of a commend (types.ts CommendPayload): the event lives in the
// RECIPIENT's chain, appended and event-signed by the recipient, so the
// recipient's own event signature proves nothing about the opponent. What
// makes it a countersigned peer commendation is the INNER material:
//   sig.     The commender's ed25519 over commendBytes({v:1, t:'commend',
//            game, from: opp, to: recipient-root}) under `key`, and
//   certs:   inline, recursion-bounded (events.ts zCertEvent) root-signed
//            cert events of the COMMENDER proving `key` belongs to `opp`
//            (absent exactly when `key` IS the commender root).
// Inline certs are the whole proof surface: a revocation cannot be carried by
// the zCommendPayload schema, so "unrevoked as far as the inline material
// shows" is satisfied by construction. The fold's silent-ignore rule (see
// ratings/reputation.ts) is the only consumer, and it fails closed here on ANY
// malformation. Rate limits (≤1 per (opp, game), segment-in-chain) are fold
// rules, not payload rules.
//
// ── A4-21 [CLOSED: A7 small-closures, 2026-07-23] ──
// verifyCommend/verifyRematchAccept remain REVOCATION-BLIND BY DESIGN for
// the counterparty's certified child keys: a revoke of `key` lives in the
// COMMENDER's chain, and no consumer here may read it,
//  · in-FOLD is structurally impossible: consulting the commender's chain
//    recurses into other chains (breaking §5/§6 bounded verification), and
//    folding any datum from outside the subject's chain breaks checkpoint
//    determinism (the A4-04 slashable-divergence class);
//  · a naive read-time hack ("revoked at ANY time ⇒ discount") is WRONG on
//    honest data: device rotation revokes keys routinely, and commends
//    signed while the key was valid must keep counting. Correctness needs
//    the revocation's witnessed time COMPARED across chains (§4 witnessed-
//    time layer) plus the commender's reconstructed chain.
// THE CLOSURE, exactly at the hook designated here: ratings/reputation.ts
// repEvidenceOf (the seam that already re-walks every counted commend at
// read time) now takes an optional CommendRevocationView ((opp root, key) →
// revocation wts | undefined, built by the caller from reconstructed
// counterparty chains) and DISCOUNTS a commend unless its witnessed time
// provably precedes the revocation wts (equal/malformed times discount;
// fail toward no-forgery, §0): no est-tier bonus, and the folded floor
// twentieths are flagged in RepEvidence.commendTwRevoked for repScore to
// subtract (clamped ≥ 0). Read-time ONLY: repStep and the checkpoint-
// embedded RepState stay byte-identical (digest-pinned in the suite), and
// verifyCommend HERE still passes on a revoked-but-certified key (inline
// material cannot carry the revoke; that boundary is also still PINNED in
// scripts/test-accounts-reputation.mjs). Residual, deliberately bounded:
// rematch-accepts have no read-time evidence path, so verifyRematchAccept's
// revocation blindness stands. Exposure needs a STOLEN certified child key
// and yields only the capped rematch ramp, and any future closure should
// mirror this same read-time-view pattern, never the fold.
//
// Trust model of a rematch-accept (A4 review fix A4-13) is the SAME pattern:
// the conduct event lives in the SUBJECT's chain, so the sportsmanship claim
// is countersigned by the COUNTERPARTY's inner material, sig by `key` over
// rematchBytes({v:1, t:'rematch', prior, game, from: opp, to: subject-root}),
// key proven the counterparty's (key === opp, or an inline root-signed cert).
// A unilateral self-claim (no verifiable countersignature) never counts in
// the fold. The fold additionally requires the PRIOR segment in-window AND
// the rematch game's own segment to appear (reputation.ts pending rule).
// Neither is verifiable here.
//
// PAIRING RECORDS (A5 brick J5: the A4-12 machinery; spec §3/§8, types.ts
// PairingPayload). THE ANCHORING CONTRACT, stated once, here:
//
//   At match time: after pairingLegal, BEFORE the first move is signed.
//   BOTH players append a witnessed 'pairing' event for the SAME game key to
//   their OWN chains: {game, opp: counterparty-root, kind, tc, atWts}. The
//   witness serves a rated game ONLY once it has seen both pairing events
//   countersigned (witnessed-lane appends under each player's live lease;
//   the witnessCore pairing gate poisons a rated session whose anchors are
//   absent or contradict the session's gameKey/kind/tc/players).
//
//   The pairing is a SELF-EXECUTING obligation (the §8 self-ban deadline
//   pattern applied to game outcomes): once it is in your chain, your next
//   witnessed record for that (game, opp) must exist. A bound segment (any
//   result) or an abort/noshow conduct event, or the reputation fold counts
//   the open obligation as abandonment-class misconduct (reputation.ts
//   `unsettled`). "Forgetting" the abort/no-show/loss is no longer possible:
//   the obligation is already on-chain before the game starts, and the
//   OPPONENT's chain carries the matching pairing, so deleting your own is
//   the same suppression class as deleting a shared segment (§3).
//
//   The builder below assembles the payload the caller appends via
//   chain.ts appendWitnessed(chain, priv, key, 'pairing', payload, ts).
//   `atWts` is the witnessed match time (the pairing-legality timestamp,
//   §7/A4-16: the same instant both sides evaluate pairingLegal at).
//
// Platform-neutral: no `node:` imports, no DOM globals.

import { isRootSignedCert } from '../certs'
import { canonicalBytes, type CanonicalObject } from '../codec'
import { zCommendPayload, zConductPayload, zPairingPayload } from '../events'
import { ed25519, toB64u, verifySigB64u } from '../hash'
import type { B64u, CommendPayload, ConductPayload, PairingPayload, SignedEvent } from '../types'

// ---------------------------------------------------------------------------
// Commend bytes + signature
// ---------------------------------------------------------------------------

/** What a commendation asserts: `from` (commender root) says "good game
 * `game`" to `to` (recipient root). */
export interface CommendRef {
  game: B64u
  from: B64u
  to: B64u
}

/** The exact canonical bytes a commender signs, {v:1, t:'commend', game,
 * from, to} under cjson-v1. Binding BOTH roots + the game key makes the
 * signature unreplayable into any other game or any other recipient. */
export function commendBytes(ref: CommendRef): Uint8Array {
  return canonicalBytes({ v: 1, t: 'commend', game: ref.game, from: ref.from, to: ref.to })
}

/** Sign commendBytes with the commender's key (root or a certified child).
 * Throws on programmer misuse (unencodable ref); pure otherwise. */
export function makeCommendSig(priv: Uint8Array, ref: CommendRef): B64u {
  return toB64u(ed25519.sign(commendBytes(ref), priv))
}

// ---------------------------------------------------------------------------
// Rematch-accept bytes + signature (A4-13)
// ---------------------------------------------------------------------------

/** What a rematch acceptance asserts: `from` (counterparty root) says "I am
 * playing you (`to`) again: game `game` is our rematch of `prior`". */
export interface RematchRef {
  /** The finished game the rematch follows. */
  prior: B64u
  /** The NEW game's key. */
  game: B64u
  /** Counterparty root. */
  from: B64u
  /** Subject (recipient) root. */
  to: B64u
}

/** The exact canonical bytes the counterparty signs, {v:1, t:'rematch',
 * prior, game, from, to} under cjson-v1. Binding BOTH roots + BOTH game keys
 * makes the signature unreplayable into any other prior, rematch, or
 * recipient. */
export function rematchBytes(ref: RematchRef): Uint8Array {
  return canonicalBytes({ v: 1, t: 'rematch', prior: ref.prior, game: ref.game, from: ref.from, to: ref.to })
}

/** Sign rematchBytes with the counterparty's key (root or a certified child).
 * Throws on programmer misuse (unencodable ref); pure otherwise. */
export function makeRematchSig(priv: Uint8Array, ref: RematchRef): B64u {
  return toB64u(ed25519.sign(rematchBytes(ref), priv))
}

// ---------------------------------------------------------------------------
// Payload builders (caller appends via chain.ts appendWitnessed)
// ---------------------------------------------------------------------------

export interface MakeCommendOpts {
  game: B64u
  /** Commender root. */
  opp: B64u
  /** Commender signing key. The root itself or a certified child. */
  key: B64u
  /** makeCommendSig output under `key` for {game, from: opp, to: recipient}. */
  sig: B64u
  /** Root-signed cert events proving `key`. REQUIRED iff key !== opp. */
  certs?: SignedEvent[]
}

/**
 * Assemble the CommendPayload the RECIPIENT appends to its own chain.
 * Throws on structural misuse (missing/extraneous certs, bad shapes). This
 * is the trusted build path; untrusted material goes through verifyCommend.
 */
export function makeCommendPayload(o: MakeCommendOpts): CommendPayload {
  if ((o.key === o.opp) !== (o.certs === undefined))
    throw new Error('makeCommendPayload: certs are required iff key is not the commender root')
  const payload: CommendPayload = {
    game: o.game,
    opp: o.opp,
    key: o.key,
    sig: o.sig,
    ...(o.certs !== undefined
      ? { certs: o.certs.map((c) => c as unknown as CanonicalObject) }
      : {}),
  }
  const res = zCommendPayload.safeParse(payload)
  if (!res.success) throw new Error('makeCommendPayload: payload does not satisfy zCommendPayload')
  return payload
}

export interface MakeConductOpts {
  kind: 'abort' | 'noshow' | 'rematch-accept'
  /** 'abort'/'rematch-accept': the new game's key; 'noshow': the pairing key. */
  game: B64u
  /** Counterparty root. */
  opp: B64u
  /** The finished game a rematch-accept follows. Required iff rematch-accept. */
  prior?: B64u
  /** 'rematch-accept' only (A4-13, REQUIRED there): makeRematchSig output
   * under `key` for {prior, game, from: opp, to: subject-root}. */
  sig?: B64u
  /** 'rematch-accept' only: counterparty signing key (root or certified child). */
  key?: B64u
  /** Root-signed cert events proving `key`. REQUIRED iff key !== opp
   * ('rematch-accept' only, same rule as commends). */
  certs?: SignedEvent[]
}

/**
 * Build a ConductPayload for the subject's own chain (appended by the
 * subject's compliant client under witness attestation). Throws on misuse.
 * A 'rematch-accept' REQUIRES the counterparty countersignature material
 * (A4-13: the fold ignores unilateral claims, so building one would be a
 * programmer error, not a weaker payload).
 */
export function makeConductPayload(o: MakeConductOpts): ConductPayload {
  if (o.kind === 'rematch-accept') {
    if (o.sig === undefined || o.key === undefined)
      throw new Error('makeConductPayload: rematch-accept requires the counterparty sig + key')
    if ((o.key === o.opp) !== (o.certs === undefined))
      throw new Error('makeConductPayload: certs are required iff key is not the counterparty root')
  } else if (o.sig !== undefined || o.key !== undefined || o.certs !== undefined) {
    throw new Error("makeConductPayload: sig/key/certs only accompany 'rematch-accept'")
  }
  const payload: ConductPayload = {
    kind: o.kind,
    game: o.game,
    opp: o.opp,
    ...(o.prior !== undefined ? { prior: o.prior } : {}),
    ...(o.sig !== undefined ? { sig: o.sig } : {}),
    ...(o.key !== undefined ? { key: o.key } : {}),
    ...(o.certs !== undefined
      ? { certs: o.certs.map((c) => c as unknown as CanonicalObject) }
      : {}),
  }
  const res = zConductPayload.safeParse(payload)
  if (!res.success) throw new Error('makeConductPayload: payload does not satisfy zConductPayload')
  return payload
}

export interface MakePairingOpts {
  /** The game key the pairing commits to (segment.ts gameKey; host-minted,
   * verified identical by both players before anything is signed). */
  game: B64u
  /** Counterparty root. */
  opp: B64u
  /** Ladder binding, mirroring the segment's (§6), e.g. 'chess'. */
  kind: string
  tc: { baseMs: number; incMs: number }
  /** Witnessed match time (the pairing-legality atWts, §7/A4-16). */
  atWts: number
}

/**
 * A5 J5 (A4-12): build the PairingPayload BOTH players append to their own
 * chains at match time, BEFORE the first move. See the anchoring contract in
 * the module header. Validated against the lead-authored zPairingPayload;
 * throws on structural misuse (this is the trusted build path, the fold's
 * silent-ignore rule handles untrusted material). Pure: no clock, no network;
 * the caller supplies `atWts` from the pairing-legality evaluation.
 */
export function makePairingPayload(o: MakePairingOpts): PairingPayload {
  const payload: PairingPayload = {
    game: o.game,
    opp: o.opp,
    kind: o.kind,
    tc: { baseMs: o.tc.baseMs, incMs: o.tc.incMs },
    atWts: o.atWts,
  }
  const res = zPairingPayload.safeParse(payload)
  if (!res.success) throw new Error('makePairingPayload: payload does not satisfy zPairingPayload')
  return payload
}

// ---------------------------------------------------------------------------
// Commend verification (fail-closed, context-free)
// ---------------------------------------------------------------------------

/**
 * Verify everything a commend payload can prove about itself, with no chain
 * context beyond `to` (the recipient root the event is bound to):
 *
 *  1. the payload parses under zCommendPayload (strict shapes, certs are
 *     recursion-bounded zCertEvent events, ≤8);
 *  2. opp ≠ to: nobody commends themself;
 *  3. key provenance: key === opp (commender-root-signed, certs MUST be
 *     absent), or an inline cert verifies as a ROOT-signed certificate of
 *     `opp` for exactly `key` (certs.ts isRootSignedCert: full body schema,
 *     root-signed, valid event signature). Inline material cannot carry a
 *     revocation, so the key is unrevoked as far as this payload can show.
 *     A key revoked in the COMMENDER's chain still passes here BY DESIGN
 *     (A4-21, CLOSED in A7: the read-time repEvidenceOf revocation view is
 *     where such commends are discounted; module header);
 *  4. `sig` verifies under `key` over commendBytes({game, from: opp, to}).
 *
 * Never throws; any malformation (including values that would crash the
 * canonical codec) returns false. The (opp, game)-uniqueness and
 * segment-in-chain rules are the reputation fold's, not verifiable here.
 */
export function verifyCommend(payload: unknown, to: B64u): boolean {
  try {
    const res = zCommendPayload.safeParse(payload)
    if (!res.success) return false
    const p = res.data
    if (p.opp === to) return false
    if (p.key === p.opp) {
      // Root-signed: the doc contract says certs are ABSENT. Carrying
      // pointless material is a malformation, and we fail closed on those.
      if (p.certs !== undefined) return false
    } else {
      if (p.certs === undefined || p.certs.length === 0) return false
      let proven = false
      for (const c of p.certs) {
        const info = isRootSignedCert(p.opp, c as unknown as SignedEvent)
        if (info !== null && info.pub === p.key) {
          proven = true
          break
        }
      }
      if (!proven) return false
    }
    return verifySigB64u(p.sig, commendBytes({ game: p.game, from: p.opp, to }), p.key)
  } catch {
    return false
  }
}

/**
 * A4-13: verify everything a rematch-accept payload can prove about itself,
 * mirroring verifyCommend exactly, with no chain context beyond `to` (the
 * subject root whose chain carries the conduct event):
 *
 *  1. the payload parses under zConductPayload with kind 'rematch-accept'
 *     (the schema forces prior + sig + key present there);
 *  2. opp ≠ to: nobody accepts a rematch with themself;
 *  3. key provenance: key === opp (counterparty-root-signed, certs MUST be
 *     absent), or an inline cert verifies as a ROOT-signed certificate of
 *     `opp` for exactly `key`. Same revocation boundary as commends: inline
 *     material cannot carry a revoke;
 *  4. `sig` verifies under `key` over rematchBytes({prior, game, from: opp,
 *     to}): the countersignature binds BOTH game keys and BOTH roots.
 *
 * Never throws; any malformation returns false. The in-window prior-segment
 * rule and the rematch-game-must-appear (pending) rule are the reputation
 * fold's, not verifiable here.
 */
export function verifyRematchAccept(payload: unknown, to: B64u): boolean {
  try {
    const res = zConductPayload.safeParse(payload)
    if (!res.success) return false
    const p = res.data
    if (p.kind !== 'rematch-accept') return false
    if (p.opp === to) return false
    // Schema-guaranteed present for 'rematch-accept'; narrowed here for TS.
    const key = p.key as B64u
    const sig = p.sig as B64u
    const prior = p.prior as B64u
    if (key === p.opp) {
      if (p.certs !== undefined) return false // pointless material: fail closed
    } else {
      if (p.certs === undefined || p.certs.length === 0) return false
      let proven = false
      for (const c of p.certs) {
        const info = isRootSignedCert(p.opp, c as unknown as SignedEvent)
        if (info !== null && info.pub === key) {
          proven = true
          break
        }
      }
      if (!proven) return false
    }
    return verifySigB64u(sig, rematchBytes({ prior, game: p.game, from: p.opp, to }), key)
  } catch {
    return false
  }
}
