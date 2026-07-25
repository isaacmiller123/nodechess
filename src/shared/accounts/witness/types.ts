// A2 witness fabric — shared type contract (spec §1 PIN, §4 witness fabric,
// ACCOUNTS-PARAMS §Witness/§PIN). Types + protocol rules only; implementations
// live in sibling modules. Platform-neutral: no `node:` imports, no DOM globals.
//
// Signing/hashing conventions are A1's: cjson-v1 canonical bytes, sha256 ids,
// ed25519 signatures, base64url-no-pad byte strings.

import type { CanonicalObject } from '../codec'
import type { B64u, EventId, SignedEvent, WitnessAttestation, Chain } from '../types'

// ---------------------------------------------------------------------------
// Node identity & key distance
// ---------------------------------------------------------------------------

/** nodeId = sha256(rootPub) — 32 bytes. All fabric distance is XOR over this. */
export type NodeId = B64u

/**
 * Signed, ephemeral presence record (C-3 — expiring coordination state, no
 * authority). Broadcast into the fabric room; the union of live records forms
 * each observer's NodeDirectory. Nothing here is trusted beyond its signature:
 * eligibility is judged by the OBSERVER from floors + the subject's chain.
 */
export interface PresenceBody extends CanonicalObject {
  v: 1
  root: B64u
  /** Signing child key (device) — certified in the node's own chain. */
  key: B64u
  caps: {
    witness: boolean
    committee: boolean
    /** Advertised shard budget, MB (§11) — informational until A3. */
    shardMb: number
  }
  /** Params revision this node coordinates under. */
  params: B64u
  /** Sender-claimed unix ms — bounded by receivers against local clock. */
  ts: number
  /** Attested uptime percent over trailing 30d (0-100, integer). */
  uptimePct: number
}

export interface SignedPresence {
  body: PresenceBody
  sig: B64u
}

/**
 * An observer's view of live nodes. Directories are LOCAL and may differ
 * across observers; every rule that matters (thresholds, eligibility,
 * diversity) is enforced on the SIGNATURE SET of a record, never on any
 * single observer's directory — so view divergence degrades liveness only,
 * never safety.
 */
export interface NodeDirectory {
  nodes: Map<NodeId, SignedPresence>
  /** Presence records older than this are treated as offline. */
  staleAfterMs: number
}

/** Chain-derived facts about a subject needed for eligibility judgment. */
export interface SubjectSummary {
  root: B64u
  nodeId: NodeId
  /** Roots with a direct game/friend edge inside eligEntanglementFreeDays. */
  entangledRoots: Set<string>
  /** Roots of the subject's opponents' opponents (for shared-partner overlap). */
  secondDegreeRoots: Set<string>
}

// ---------------------------------------------------------------------------
// Write lease (§4) — threshold-granted, epoch-fenced
// ---------------------------------------------------------------------------

export interface LeaseBody extends CanonicalObject {
  v: 1
  /** Account root the lease serializes. */
  root: B64u
  /** Monotonic fencing token. First lease for an account = epoch 1. */
  epoch: number
  /** Device child pubkey the lease is granted TO. */
  device: B64u
  /** Witnessed grant time (median of grantor clocks, ms). */
  grantedWts: number
  ttlMs: number
  /** Params revision the grantors enforced. */
  params: B64u
  /**
   * Takeover proof reference: absent for epoch 1 and for renewals by the SAME
   * device; for a takeover (different device), the eventId of the PIN-gated
   * session record that authorized it (see PinSessionBody).
   */
  takeover?: B64u
}

/** One grantor's signature over canonicalBytes(LeaseBody). */
export interface LeaseGrant extends CanonicalObject {
  /** Grantor witness nodeId. */
  w: NodeId
  /** Grantor's signing key (certified in its own chain). */
  key: B64u
  /** Grantor's independent clock reading at grant, ms. */
  wts: number
  /** ed25519 over canonicalBytes({body: leaseBodyHash, w, wts}). */
  sig: B64u
}

/**
 * A lease is VALID iff:
 *  - ≥ tLease distinct grantors, each signature verifying,
 *  - every grantor eligible for the subject (floors + entanglement-distance)
 *    under the embedded params revision,
 *  - grantedWts within timeWindowMs of the median of grantor wts values,
 *  - epoch strictly greater than any previously observed lease epoch for the
 *    root (observers keep gossip memory, C-1),
 *  - not expired: now < grantedWts + ttlMs (heartbeat renewals re-sign the
 *    same epoch with a fresh grantedWts),
 *  - takeover rule: epoch N+1 granted to a DIFFERENT device than epoch N
 *    requires `takeover` referencing a valid PIN session record; same-device
 *    re-grants (crash recovery) need none,
 *  - no unexpired fuse-tripped record for the root (fuse check is MANDATORY
 *    for grantors — granting into a fuse window is witness misbehavior).
 */
export interface Lease {
  body: LeaseBody
  grants: LeaseGrant[]
}

// ---------------------------------------------------------------------------
// Witnessed events & checkpoints (completes A1's reserved shapes)
// ---------------------------------------------------------------------------

/**
 * Witness admission rule (what a witness MUST check before countersigning an
 * event, in order): (1) valid unexpired lease for (root, event.body.key)'s
 * device at the CURRENT epoch; (2) no unexpired fuse record for root; (3) the
 * event's prev/height extend the head this witness has cached for the lane
 * (a mismatch is either honest lag → refuse with its head, or fork → emit
 * proof); (4) its own clock within timeWindowMs of the event's claimed ts...
 * the attestation carries the WITNESS's clock, not the client's. Attestations
 * reuse A1's WitnessAttestation shape verbatim: sig over
 * canonicalBytes({e, epoch, w, wts}).
 */
export type { WitnessAttestation }

/**
 * Checkpoint cosignature = WitnessAttestation on the ckpt event, with the
 * added obligation that the witness RECOMPUTED the incremental fold step
 * before signing (§2b) — cosigning a bad checkpoint is slashable. Checkpoint
 * validity at verify time: ≥ ckptM attestations from distinct eligible
 * witnesses spanning ≥ 3 distinct /16 nodeId prefixes (diversity bound).
 */
export interface CheckpointCosigRule {
  m: number
  n: number
  prefixDiversityMin: number
}

// ---------------------------------------------------------------------------
// Witnessed time (§4)
// ---------------------------------------------------------------------------

/**
 * A witnessed timestamp for an event/record = the MEDIAN of its attestations'
 * wts values, valid iff every attestation sits within timeWindowMs of that
 * median (outliers invalidate only themselves; validity needs the surviving
 * set to still satisfy the applicable threshold). Claims bearing on account
 * age, ban expiry, or staleness additionally require ≥ timeDiversityMin
 * attesters that are entanglement-distant from the subject.
 */
export interface WitnessedTime {
  medianWts: number
  attesters: NodeId[]
  diversityOk: boolean
}

// ---------------------------------------------------------------------------
// PIN — tOPRF committee (§1), RFC 9497 OPRF(ristretto255, SHA-512)
// ---------------------------------------------------------------------------

/**
 * PIN provisioning (witnessed-lane event type 'pin', root-signed):
 *  - Client picks OPRF key k, Shamir-splits it T-of-N over the ristretto255
 *    scalar field, sends share k_i to committee member i (transport-encrypted
 *    to the member's key), then DELETES k and every share.
 *  - shareCommitments[i] = k_i·G — published so members can't silently swap
 *    shares and clients/verifiers can check partial evaluations (DLEQ per
 *    RFC 9497 VOPRF mode against the commitment).
 *  - pinPub: client computes out = OPRF(k, pin), pinKey = SLIP-0010-style
 *    HMAC-SHA512 seed stretch of out → ed25519 keypair; publishes pinPub.
 *    Deriving pinKey REQUIRES a committee evaluation (that is the whole
 *    design: offline brute force is impossible, the rate limit lives with
 *    the committee's counter).
 * The payload is part of the account chain — fuse checks and takeover
 * verification read it from there.
 */
export interface PinRecordPayload extends CanonicalObject {
  committee: NodeId[] // length pinN
  t: number // pinT
  shareCommitments: B64u[] // k_i·G, index-aligned with committee
  pinPub: B64u
  params: B64u // PARAMS_A2_DIGEST
  /** Present when this record re-provisions an earlier committee: the
   * eventId of the previous 'pin' record + the carried-forward counter. */
  prev?: B64u
  carriedFails?: number
}

/**
 * Attempt counting (C-2, spec §1) — evaluations minus proven successes:
 *  - Every blind-evaluation REQUEST a member serves for (root) increments
 *    that member's local attempt counter and issues an evalNonce.
 *  - A client that derives pinKey proves success by signing
 *    {root, evalNonce, wts} with pinKey within the session window; the
 *    member marks that evaluation successful (net contribution 0).
 *  - A member's reported count = evaluations served − successes proven.
 *  - The committee-effective count = MAX over any pinT members' co-attested
 *    reports (a minority can't low-ball; honest members gossip counts).
 *  - The counter NEVER resets. On fuse expiry, headroom refills by pinRefill.
 *  - Committee handoff (re-provision) REQUIRES a pinKey-signed authorization
 *    and carries the effective count forward in the new PinRecord
 *    (carriedFails) — co-signed by the OLD committee threshold.
 */
export interface PinAttemptReport extends CanonicalObject {
  root: B64u
  w: NodeId
  fails: number
  asOfWts: number
  sig: B64u // by the member's key over canonicalBytes of the above
}

/** Threshold-signed fuse record, published under the account's key (§1). */
export interface FuseRecordBody extends CanonicalObject {
  v: 1
  root: B64u
  fails: number
  trippedWts: number
  expiryWts: number // trippedWts + pinBanDays
  pinRecord: EventId
  params: B64u
}

export interface FuseRecord {
  body: FuseRecordBody
  /** ≥ pinT member signatures over canonicalBytes(body). */
  sigs: { w: NodeId; key: B64u; sig: B64u }[]
}

/**
 * PIN-gated session record — what lease takeovers and witnessed device
 * enrollment countersigning reference. Verifiable by anyone against pinPub
 * in the chain's active 'pin' record.
 */
export interface PinSessionBody extends CanonicalObject {
  v: 1
  root: B64u
  /** Device being authorized (takeover target / enrolling device). */
  device: B64u
  purpose: 'lease-takeover' | 'device-witness' | 'committee-handoff'
  evalNonce: B64u
  wts: number
  /**
   * For purpose 'lease-takeover': the exact lease epoch this session authorizes.
   * Replay-binds the session to ONE epoch, so a takeover session captured at
   * epoch N cannot be replayed to authorize a later epoch takeover. REQUIRED for
   * lease-takeover (verifyTakeover rejects a missing/mismatched epoch); absent
   * for device-witness / committee-handoff.
   */
  epoch?: number
  /**
   * For purpose 'committee-handoff': the new PIN record id this session
   * authorizes. Replay-binds the session to ONE handoff, so a captured session
   * cannot be replayed to authorize a re-provision to a different record. REQUIRED
   * for committee-handoff (pin-handoff + verifyHandoff reject a mismatch).
   */
  record?: B64u
}

export interface PinSession {
  body: PinSessionBody
  /** ed25519 by pinKey over canonicalBytes(body). */
  pinSig: B64u
}

/**
 * Root-signed authorization, used for accounts that carry NO active PIN record
 * (spec §1: the PIN gates the witnessed zone, and provisioning one needs a live
 * committee — so until a PIN exists the password alone is the account, exactly
 * as the sign-in copy states). Same body as a PIN session so the epoch/device/
 * purpose replay-binding is identical; the only difference is which key signs.
 *
 * A verifier chooses the lane from the SUBJECT'S OWN signed state, never from
 * the claimant: an account with an active PIN record must present a PinSession
 * (verifyTakeover refuses this lane whenever pinPub is known), so a password
 * thief cannot downgrade a PIN-protected account by omitting the session.
 */
export interface RootSession {
  body: PinSessionBody
  /** ed25519 by the account ROOT key over canonicalBytes(body). */
  rootSig: B64u
}

/**
 * The session authorizing a different-device lease takeover. Which lane applies
 * is fixed by the account's own signed state, not by the caller: 'pin' for an
 * account carrying an active PIN record, 'root' for one that does not. Both
 * hash to LeaseBody.takeover under the same rule, so the lease body is
 * lane-agnostic (see lease.takeoverAuthId / lease.verifyTakeover).
 */
export type TakeoverAuth =
  | { kind: 'pin'; session: PinSession }
  | { kind: 'root'; session: RootSession }

// ---------------------------------------------------------------------------
// Slashing & adjudication (§4)
// ---------------------------------------------------------------------------

/**
 * Evidence bundle for the double-grant case. Deterministic verdict (adjudicate):
 *  - SAME epoch, two valid leases to DIFFERENT devices → the INTERSECTION
 *    grantors double-signed at one epoch and are the faulty set (witness fault),
 *    attributed via keyOf so a fabricated grant set cannot frame an honest node.
 *  - Identical leases, or same-device same-epoch renewal → guilty:'none'.
 *  - DIFFERENT epochs → guilty:'none': a later epoch legitimately supersedes an
 *    earlier one; a genuine fork under such leases is caught only by the
 *    self-authenticating adjudicateFork path (which verifies the signed events +
 *    certified keys), NOT from the lease pair.
 * The accused's appeal is mechanical: present both leases.
 */
export interface DoubleGrantEvidence {
  root: B64u
  a: Lease
  b: Lease
  /** Chain slice — RESERVED. adjudicate does NOT consume it (fork verdicts go
   * through adjudicateFork on a self-authenticating ForkProof); kept so callers
   * can carry the slice for the fork path without a shape change. */
  events: SignedEvent[]
}

export interface SlashVerdict {
  guilty: 'user' | 'witnesses' | 'none'
  /** Slashed party keys (root for user; grantor nodeIds for witnesses). */
  slashed: string[]
  reason: string
}

// ---------------------------------------------------------------------------
// Fabric transport abstraction
// ---------------------------------------------------------------------------

/** Request/response messages are canonical objects; the transport moves bytes,
 * the protocol layer owns all validation. Implementations: MockFabric
 * (in-process N-node, suites), TrysteroFabric (browser + node/werift). */
export interface FabricEndpoint {
  nodeId: NodeId
  announce(p: SignedPresence): void
  directory(): NodeDirectory
  request(to: NodeId, kind: FabricRequestKind, payload: CanonicalObject): Promise<CanonicalObject>
  onRequest(
    kind: FabricRequestKind,
    handler: (from: NodeId, payload: CanonicalObject) => Promise<CanonicalObject>
  ): void
  close(): Promise<void>
}

export type FabricRequestKind =
  | 'lease-grant' // client → witness: request a LeaseGrant for a LeaseBody
  | 'lease-renew'
  | 'attest' // client → witness: countersign an event under a lease
  | 'salt-grant' // client → witness: A5-17 (A7) anchored salt grant, signing-time disciplined
  | 'cosign-ckpt' // client → witness: checkpoint cosignature (recompute first)
  | 'pin-provision' // client → member: deliver a share (encrypted)
  | 'pin-eval' // client → member: blind evaluation request → partial + nonce
  | 'pin-prove' // client → member: pinKey-signed success proof
  | 'pin-report' // any → member: request signed PinAttemptReport
  | 'pin-fuse-sign' // any → member: co-sign a fuse trip (member self-qualifies on its own counter)
  | 'pin-counter-sync' // any → member: exchange signed counter reports (A4 seam 1 anti-spreading gossip)
  | 'pin-handoff' // client → old member: authorize re-provision
  | 'fuse-check' // any → member: current fuse state for a root
  | 'head' // any → witness: cached head for a root/lane
  // A3 overlay (spec §5; overlay/types.ts payload contracts). The fabric
  // remains transport-only — these kinds ride request() like every other,
  // and the overlay layer owns all routing + validation.
  | 'overlay-ping'
  | 'overlay-find-node'
  | 'overlay-find-value'
  | 'overlay-store'
  | 'overlay-fetch' // viewer → holder: summary / event pages / shard bodies
  // A7 social transport (spec §3/§10; social/transport.ts payload contracts).
  // Mailbox is a dedicated RPC pair (admission is stateful, drain must be
  // authenticated AND clearing — semantics find-value/store cannot honor).
  | 'social-mail-send' // sender → relay: offer an envelope for a recipient box
  | 'social-mail-drain' // recipient → relay: recipient-root-signed drain+clear
  // A6 live rated play (spec §3): before move 1 each player exchanges a SIGNED
  // pre-game snapshot ({head, height, profileSnapshot, latestCheckpoint?}) with
  // the opponent so each side can build its own countersigned segment (heads /
  // oppProfile / oppCkpt). Transport-only here; the signed payload contract +
  // sign/verify live in the A6 net layer (M1 Lane E preGame.ts). Precursor to
  // the M2 'pairing' record.
  | 'pregame-snapshot' // player ↔ opponent: exchange the signed pre-game snapshot

// ---------------------------------------------------------------------------
// Witness-side cache (C-1 gossip memory — reconstructible, unauthoritative)
// ---------------------------------------------------------------------------

export interface WitnessCacheEntry {
  root: B64u
  witnessedHead?: EventId
  witnessedHeight?: number
  lastEpoch?: number
  fuse?: FuseRecord
  forkProofSeen?: boolean
}

/** What a witness node persists between sessions. Losing it is safe (rebuilt
 * from gossip); holding it is what makes fork detection have memory. */
export interface WitnessStore {
  get(root: B64u): Promise<WitnessCacheEntry | null>
  put(e: WitnessCacheEntry): Promise<void>
  list(): Promise<WitnessCacheEntry[]>
}

export type { Chain, SignedEvent, EventId, B64u }
