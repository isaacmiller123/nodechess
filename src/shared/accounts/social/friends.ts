// A6 social core: friend edges (spec §3 "friendships are witnessed-lane
// entanglements", §10). PURE data + verification + fold: builders return
// payloads the caller signs and appends via chain.ts appendWitnessed; the
// verifier proves everything an edge can prove ABOUT ITSELF with no recursion
// into the peer's chain (the commend pattern, ratings/conduct.ts); the fold
// derives the viewer-side friend set from one chain's events.
//
// Trust model of an edge (types.ts FriendPayload): a 'friend' event lives in
// the SUBJECT's own chain, so the subject's event signature proves only the
// subject's OWN standing consent. What makes an 'add' a countersigned edge is
// the INNER material:
//   sig.     The peer's ed25519 over friendBytes({v:1, t:'friend', a, b}),
//            a/b = the two roots in compareKeys order (BOTH parties sign the
//            identical bytes, so one signature per party serves both chains,
//            and a signature can never be replayed into another pair), and
//   certs:   inline, recursion-bounded (events.ts zCertEvent) root-signed
//            cert events of the PEER proving key ∈ peer (absent exactly when
//            key IS the peer root).
// A 'remove' is unilateral by design (§3): the subject's own event signature
// is the entire authorization; no counterparty material exists or is checked.
//
// THE MUTUAL-READ RULE (the §0 load-bearing decision): the relationship is
//   friends(A, B) ⇔ A's latest edge state for B is a VERIFIED add
//                 AND B's latest edge state for A is a VERIFIED add.
// Each chain answers only "does this owner currently assert the edge, with
// consent proven at assertion time?". Removal by EITHER side flips the mutual
// read false via that side's own chain, so a stale countersignature replayed
// into an 'add' can never resurrect an edge the peer removed, and nobody can
// be shown as someone's friend without both a signature they minted AND their
// own chain still asserting it. One verifiable list, not different lists for
// different audiences (§3).
//
// FOLD RULE (fail closed, the documented ignore semantics): walking the
// witnessed lane in (height, ts, id) order, an 'add' whose countersignature
// material does not FULLY verify (verifyFriendAdd) is IGNORED. It neither
// establishes nor removes anything, exactly like an unverifiable commend in
// the reputation fold. A malformed payload of either action is ignored the
// same way. Event-level authenticity (signature, cert/revocation standing,
// linkage) is verifyChain's business. The authenticated read side is
// friendsOfChain, which refuses unverifiable chains outright; friendsOf run
// standalone still never accepts a bad countersig.
//
// Platform-neutral: no `node:` imports, no DOM, no ambient time or randomness.

import { isRootSignedCert } from '../certs'
import { canonicalBytes, compareKeys, type CanonicalObject } from '../codec'
import { eventId, zFriendPayload } from '../events'
import { ed25519, toB64u, verifySigB64u } from '../hash'
import { verifyChain } from '../chain'
import type { B64u, Chain, FriendPayload, SignedEvent } from '../types'

// ---------------------------------------------------------------------------
// Edge bytes + countersignature
// ---------------------------------------------------------------------------

/**
 * The exact canonical bytes BOTH parties sign for the edge between the two
 * roots, {v:1, t:'friend', a, b} under cjson-v1 with a/b the roots in
 * compareKeys order (order of the arguments is immaterial). Binding both
 * roots makes a countersignature unreplayable into any other pair; the sorted
 * form makes the two parties' signatures cover identical bytes. Throws on
 * programmer misuse (equal roots: no self-edges); pure otherwise.
 */
export function friendBytes(rootA: B64u, rootB: B64u): Uint8Array {
  if (rootA === rootB) throw new Error('friendBytes: an edge needs two distinct roots')
  const [a, b] = compareKeys(rootA, rootB) <= 0 ? [rootA, rootB] : [rootB, rootA]
  return canonicalBytes({ v: 1, t: 'friend', a, b })
}

/** Sign friendBytes with one party's key (its root or a certified child).
 * Throws on programmer misuse (equal roots); pure otherwise. */
export function makeFriendSig(priv: Uint8Array, rootA: B64u, rootB: B64u): B64u {
  return toB64u(ed25519.sign(friendBytes(rootA, rootB), priv))
}

// ---------------------------------------------------------------------------
// Payload builders (caller appends via chain.ts appendWitnessed)
// ---------------------------------------------------------------------------

export interface MakeFriendAddOpts {
  /** Counterparty root. */
  peer: B64u
  /** Peer signing key. The peer root itself or a certified child. */
  key: B64u
  /** makeFriendSig output under `key` for the (subject, peer) pair. */
  sig: B64u
  /** Peer root-signed cert events proving `key`. REQUIRED iff key !== peer. */
  certs?: SignedEvent[]
}

/**
 * Assemble the FriendPayload the SUBJECT appends to its own chain for a
 * countersigned add. Throws on structural misuse (missing/extraneous certs,
 * bad shapes): this is the trusted build path; untrusted material goes
 * through verifyFriendAdd.
 */
export function makeFriendAddPayload(o: MakeFriendAddOpts): FriendPayload {
  if ((o.key === o.peer) !== (o.certs === undefined))
    throw new Error('makeFriendAddPayload: certs are required iff key is not the peer root')
  // A6 review friends-2: an EMPTY certs array is not "certs supplied". A
  // device-key add with certs:[] would mint a schema-shaped payload the fold
  // permanently ignores (no provable key provenance). Refuse at build time.
  if (o.certs !== undefined && o.certs.length === 0)
    throw new Error('makeFriendAddPayload: certs must be non-empty for a device-key add (empty certs can never prove provenance)')
  const payload: FriendPayload = {
    action: 'add',
    peer: o.peer,
    key: o.key,
    sig: o.sig,
    ...(o.certs !== undefined
      ? { certs: o.certs.map((c) => c as unknown as CanonicalObject) }
      : {}),
  }
  const res = zFriendPayload.safeParse(payload)
  if (!res.success) throw new Error('makeFriendAddPayload: payload does not satisfy zFriendPayload')
  return payload
}

/** Assemble the unilateral remove payload (§3). Throws on structural misuse. */
export function makeFriendRemovePayload(peer: B64u): FriendPayload {
  const payload: FriendPayload = { action: 'remove', peer }
  const res = zFriendPayload.safeParse(payload)
  if (!res.success) throw new Error('makeFriendRemovePayload: payload does not satisfy zFriendPayload')
  return payload
}

// ---------------------------------------------------------------------------
// Add verification (fail-closed, context-free)
// ---------------------------------------------------------------------------

/**
 * Verify everything a friend 'add' payload can prove about itself, with no
 * chain context beyond `to` (the subject root whose chain carries the event):
 *
 *  1. the payload parses under zFriendPayload with action 'add' (strict
 *     shapes; the schema already forces key+sig present and certs present
 *     iff key !== peer);
 *  2. peer ≠ to: no self-edges;
 *  3. key provenance: key === peer (peer-root-signed), or an inline cert
 *     verifies as a ROOT-signed certificate of `peer` for exactly `key`
 *     (certs.ts isRootSignedCert: full body schema, root-signed, valid event
 *     signature). Inline material cannot carry a revocation, so the key is
 *     unrevoked as far as this payload can show: the same boundary as
 *     commends;
 *  4. `sig` verifies under `key` over friendBytes(to, peer): the sorted
 *     two-root binding, unreplayable into any other pair.
 *
 * Never throws; any malformation (including values that would crash the
 * canonical codec) returns false. This proves CONSENT AT ASSERTION TIME
 * only: the live relationship additionally needs the peer's own chain
 * still asserting the edge (areFriends, the mutual-read rule).
 */
export function verifyFriendAdd(payload: unknown, to: B64u): boolean {
  try {
    const res = zFriendPayload.safeParse(payload)
    if (!res.success) return false
    const p = res.data
    if (p.action !== 'add') return false
    if (p.peer === to) return false
    // Schema-guaranteed present for 'add'; narrowed here for TS.
    const key = p.key as B64u
    const sig = p.sig as B64u
    if (key !== p.peer) {
      // Schema guarantees certs are present here; prove key ∈ peer.
      if (p.certs === undefined || p.certs.length === 0) return false
      let proven = false
      for (const c of p.certs) {
        const info = isRootSignedCert(p.peer, c as unknown as SignedEvent)
        if (info !== null && info.pub === key) {
          proven = true
          break
        }
      }
      if (!proven) return false
    }
    return verifySigB64u(sig, friendBytes(to, p.peer), key)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The fold: one chain's events → the owner-asserted friend set
// ---------------------------------------------------------------------------

/** One peer's latest edge state in a chain (integers/strings only; the view
 * is canonical-serializable, so re-folds can be compared bit-identically). */
export interface FriendEdgeState extends CanonicalObject {
  peer: B64u
  /** 'add' = verified countersigned add; 'remove' = unilateral removal. */
  state: 'add' | 'remove'
  /** Witnessed height of the deciding event. */
  height: number
  /** Author-claimed ts of the deciding event (display metadata: the height
   * is the ordering authority; nothing consequence-bearing reads this). */
  ts: number
}

/** The owner-asserted friend view of ONE chain (see the mutual-read rule). */
export interface FriendView extends CanonicalObject {
  root: B64u
  /** Roots whose latest edge state is a verified add, compareKeys-sorted. */
  friends: B64u[]
  /** Latest edge state per peer ever named (verified adds and removes),
   * compareKeys-sorted by peer. Ignored (unverifiable/malformed) events
   * leave no trace here. Ignored means ignored. */
  edges: FriendEdgeState[]
}

/**
 * Derive the owner-asserted friend set from an event list. A pure,
 * deterministic fold (same event SET → bit-identical view, storage order
 * immaterial). Witnessed-lane 'friend' events bound to `root` are walked in
 * (height, ts, id) order: heights are unique on a verified chain; the ts/id
 * tiebreaks keep the fold deterministic even on unverified input. Per peer,
 * the LAST verified event wins:
 *   - 'add'    counts only if verifyFriendAdd passes (fold rule: a forged or
 *              unverifiable countersig is IGNORED: it neither establishes
 *              nor removes an edge);
 *   - 'remove' always applies (unilateral by design; event authenticity is
 *              verifyChain's business. See friendsOfChain).
 * Total: never throws on any input; events that cannot even be id-hashed or
 * whose payloads do not parse are skipped.
 */
export function friendsOf(root: B64u, events: readonly SignedEvent[]): FriendView {
  const recs: { ev: SignedEvent; id: string }[] = []
  for (const ev of events) {
    try {
      const b = ev.body
      if (b.lane !== 'w' || b.type !== 'friend' || b.root !== root) continue
      if (!Number.isSafeInteger(b.height) || !Number.isSafeInteger(b.ts)) continue
      recs.push({ ev, id: eventId(b) }) // eventId throws on non-canonical bodies
    } catch {
      continue // fail closed: an unhashable event never reaches the fold
    }
  }
  recs.sort(
    (a, b) =>
      a.ev.body.height - b.ev.body.height ||
      a.ev.body.ts - b.ev.body.ts ||
      compareKeys(a.id, b.id),
  )
  const byPeer = new Map<B64u, FriendEdgeState>()
  for (const { ev } of recs) {
    const res = zFriendPayload.safeParse(ev.body.payload)
    if (!res.success) continue // malformed → ignored
    const p = res.data
    if (p.peer === root) continue // self-edge → ignored (defense in depth)
    if (p.action === 'add' && !verifyFriendAdd(ev.body.payload, root)) continue // forged → ignored
    byPeer.set(p.peer, { peer: p.peer, state: p.action, height: ev.body.height, ts: ev.body.ts })
  }
  const edges = [...byPeer.values()].sort((a, b) => compareKeys(a.peer, b.peer))
  return {
    root,
    friends: edges.filter((e) => e.state === 'add').map((e) => e.peer),
    edges,
  }
}

/**
 * The authenticated read side: verifyChain first (event signatures, cert and
 * revocation standing, linkage, payload schemas, forks), then fold. Returns
 * null when the chain does not verify. A viewer never derives a friend list
 * from a chain it cannot trust (fail closed, §0). Never throws.
 */
export function friendsOfChain(chain: Chain): FriendView | null {
  try {
    if (!verifyChain(chain).ok) return null
    return friendsOf(chain.root, chain.events)
  } catch {
    return null
  }
}

/**
 * THE relationship predicate (§3/§10 mutual read): friends iff each side's
 * latest edge state for the other is a verified add. Both views must be
 * derived from the two parties' chains (friendsOf/friendsOfChain). False for
 * identical roots. Pure.
 */
export function areFriends(a: FriendView, b: FriendView): boolean {
  if (a.root === b.root) return false
  return a.friends.includes(b.root) && b.friends.includes(a.root)
}
