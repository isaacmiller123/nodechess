// Decentralized accounts. Shared type contract (spec: docs/ACCOUNTS-SPEC.md v1.1,
// parameters: docs/ACCOUNTS-PARAMS.md). Types only: implementations live in the
// sibling modules. Everything in src/shared/accounts must be platform-neutral:
// no `node:` imports, no DOM globals (this tree typechecks under BOTH
// tsconfig.node.json and tsconfig.web.json).
//
// Byte-encoding conventions (see hash.ts / codec.ts):
//  - all hashes/keys/signatures inside JSON payloads are base64url-no-pad strings
//  - every hash is sha256 over cjson-v1 canonical bytes
//  - every signature is ed25519 over the exact canonical bytes named below

import type { CanonicalObject } from './codec'

/** base64url-no-pad string carrying bytes (keys, sigs, hashes). */
export type B64u = string

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** SLIP-0010 hardened child purposes (path m/purpose'/index'). */
export const KEY_PURPOSE = { device: 0, session: 1, context: 2 } as const
export type KeyPurpose = (typeof KEY_PURPOSE)[keyof typeof KEY_PURPOSE]

export interface Identity {
  /** 32-byte argon2id output: THE root secret. Never serialized unencrypted except keyfile export. */
  seed: Uint8Array
  rootPriv: Uint8Array
  rootPub: Uint8Array
  /** First TAG_LEN base32 chars of sha256(rootPub), uppercase. */
  tag: string
  /** NFKC → trim → casefold form (fed to salt derivation). */
  foldedName: string
  /** Original-casing name as typed at creation (display; carried in profile). */
  displayName: string
}

/** Result of username validation/normalization. Throws NameError on invalid input. */
export interface NormalizedName {
  folded: string
  display: string
}

// ---------------------------------------------------------------------------
// Chain events
// ---------------------------------------------------------------------------

export type Lane = 'w' | 'p'

/**
 * Event types: A1 set + A3's 'segment' + A4's conduct/commend/pin. A2 carries
 * lease/witness/PIN state as standalone records (witness/types.ts). The
 * registry is open but every type's payload schema is closed (zod, .strict()).
 *
 *  genesis  w  height 0, prev absent, signed by root. payload: GenesisPayload
 *  cert     p  root-signed child-key certificate. payload: CertPayload
 *  revoke   w  root- or device-signed key revocation. payload: RevokePayload
 *  profile  p  LWW profile field write. payload: ProfilePayload
 *  ckpt     w  checkpoint (§2). payload: CheckpointPayload
 *  segment  w  entanglement game segment (§3, A3). payload: SegmentPayload
 *              (storage/types.ts): pairwise-countersigned transcript digest,
 *              both heads, witness stream sig, opponent ckpt + profile
 *              snapshot. Deleting one breaks the owner's own hash chain.
 *              That is the retention mechanism (§5 layer 1).
 *  conduct  w  witnessed conduct fact not derivable from segments (§6b, A4):
 *              an aborted game, a no-show, an accepted rematch. payload:
 *              ConductPayload. Appended by the subject's own compliant client
 *              under witness attestation.
 *  commend  w  countersigned peer commendation ("good game", §6b, A4) in the
 *              RECIPIENT's chain, carrying the commender's signature + inline
 *              certs. payload: CommendPayload. Rate limit (one per opponent
 *              per game, must reference a real segment) is a fold rule.
 *  pin      w  chain-authoritative anchor of the CURRENT PIN record digest
 *              (§1, A4 seam 3): handoff verifiers resolve the newest 'pin'
 *              event to learn the account's real committee/record. payload:
 *              PinAnchorPayload.
 *  friend   w  friend edge (§3/§10, A6) in the SUBJECT's chain: a
 *              countersigned 'add' (peer's signature over the canonical edge
 *              bytes, inline certs when device-signed) or a unilateral
 *              'remove'. payload: FriendPayload. Countersig verification and
 *              the mutual-read rule live in social/friends.ts (a fold rule,
 *              like commends. An unverifiable add is ignored, never counted).
 */
export type EventType =
  | 'genesis'
  | 'cert'
  | 'revoke'
  | 'profile'
  | 'ckpt'
  | 'segment'
  | 'conduct'
  | 'commend'
  | 'pin'
  | 'pairing'
  | 'selfban'
  | 'friend'

/**
 * The signed body. `sig` (in SignedEvent) covers canonicalBytes(body).
 * The event hash (`id`) is sha256(canonicalBytes(body)). Signatures and
 * witness attestations attach OUTSIDE the hash so countersigning never
 * changes linkage.
 *
 * Linkage rules:
 *  - witnessed lane ('w'): single chain. height strictly contiguous from 0
 *    (genesis). prev = id of the previous witnessed event (null only at
 *    genesis). Two distinct valid bodies sharing (root, lane='w', prev) are
 *    self-authenticating fraud (same-epoch rule lands with leases in A2).
 *  - personal lane ('p'): per-signer chains. height contiguous from 0 PER
 *    `key`; prev = id of that key's previous personal event (null for its
 *    first). Concurrent writes across devices are sync noise; merge order is
 *    deterministic: sort by (ts, key, height, id).
 */
export interface EventBody extends CanonicalObject {
  v: 1
  lane: Lane
  type: EventType
  /** Chain owner's root pubkey. Binds the event to the account. */
  root: B64u
  /** Signing pubkey: the root itself or a certified child. */
  key: B64u
  height: number
  /** Absent (not null) at chain starts. Cjson has no null. */
  prev?: B64u
  /** Author-claimed unix ms. Witnessed time attaches via attestation (A2). */
  ts: number
  payload: CanonicalObject
}

/** Reserved for A2: shape fixed now so chain storage doesn't migrate. */
export interface WitnessAttestation extends CanonicalObject {
  /** Witness pubkey. */
  w: B64u
  /** Witnessed unix ms (diversity-bound per §4). */
  wts: number
  /** Lease epoch under which the event was admitted. */
  epoch: number
  /** ed25519 over canonicalBytes({e: eventId, epoch, w, wts}). */
  sig: B64u
}

export interface SignedEvent {
  body: EventBody
  /** ed25519 by body.key over canonicalBytes(body). */
  sig: B64u
  /** Witness countersignatures. Empty until A2. */
  wit?: WitnessAttestation[]
}

/**
 * A VERIFIER's read-time eligibility view (A4 review fixes A4-03/05/14):
 * given a witness/cosigner SIGNING key (the `w` of a WitnessAttestation or a
 * segment's wstream.wkey), is that key one the verifier currently recognizes
 * as an ELIGIBLE fabric witness (§4 floors: resolved by the caller through
 * its own NodeDirectory / gossip memory, witness/eligibility.ts)? Signature
 * validity alone is NOT eligibility: any sybil can mint valid-signing keys,
 * so every evidence layer that EARNS score from attestations or cosignatures
 * (mm/trust.ts trustEvidenceOf, ratings/reputation.ts repEvidenceOf,
 * ratings/fold.ts ratingEvidenceOf. The A4-02 vouched-rating layer) counts a
 * key only when this predicate accepts it. The predicate is verifier-LOCAL
 * read-time context: it must never reach a fold or any checkpoint-embedded
 * state (the A4-04 determinism invariant).
 */
export type WitnessEligibility = (w: B64u) => boolean

/** sha256(canonicalBytes(body)) as B64u: the id every `prev` points at. */
export type EventId = B64u

// --- payloads ---------------------------------------------------------------

export interface GenesisPayload extends CanonicalObject {
  /** Digest binding the FROZEN-AT-GENESIS parameter set (params.ts). */
  params: B64u
  /** Display name, original casing. */
  name: string
}

export interface CertPayload extends CanonicalObject {
  /** Child pubkey being introduced. */
  pub: B64u
  purpose: number
  /** SLIP-0010 child index (per purpose). */
  index: number
  /** Optional human label ("MacBook", "Work PC"). */
  label?: string
}

export interface RevokePayload extends CanonicalObject {
  /** Revoked child pubkey. */
  pub: B64u
}

export interface ProfilePayload extends CanonicalObject {
  /** LWW field writes; keys from PROFILE_FIELDS. Avatar ≤ AVATAR_MAX_BYTES. */
  fields: CanonicalObject
}

/**
 * A4 conduct event (§6b). `kind`:
 *  - 'abort':          a witnessed game that ended with no result.
 *  - 'noshow':         a witnessed pairing where the subject never moved.
 *  - 'rematch-accept': the subject accepted a rematch; `prior` names the
 *                      finished game's key. Counts in the fold only when a
 *                      segment for `prior` with the same `opp` is in-chain.
 */
export interface ConductPayload extends CanonicalObject {
  kind: 'abort' | 'noshow' | 'rematch-accept'
  /** Game key ('abort'/'rematch-accept': the new game; 'noshow': the pairing key). */
  game: B64u
  /** Counterparty root. */
  opp: B64u
  /** Finished game a rematch-accept follows. Required for 'rematch-accept'. */
  prior?: B64u
}

/**
 * A4 commendation (§6b): lives in the RECIPIENT's chain. `sig` is the
 * commender's ed25519 over canonical commend bytes (ratings/conduct.ts
 * commendBytes: {v:1, t:'commend', game, from: opp, to: root}) under `key`;
 * `certs` carry the commender's root-signed cert events proving `key` belongs
 * to `opp` (absent when root-signed): verifiable with no recursion into the
 * commender's chain. The fold accepts at most one per (opp, game) and only
 * when a segment for `game` naming `opp` is in-chain.
 */
export interface CommendPayload extends CanonicalObject {
  game: B64u
  /** Commender root. */
  opp: B64u
  /** Commender signing key (root or certified child). */
  key: B64u
  /** Commender signature over commendBytes. */
  sig: B64u
  /** Commender cert events proving `key` (absent when key === opp). */
  certs?: CanonicalObject[]
}

/**
 * A4 PIN anchor (§1 seam 3): canonicalHash of the account's CURRENT PinRecord
 * (witness/pin.ts). The newest 'pin' event in the verified chain is the
 * chain-authoritative record a handoff verifier trusts; `gen` is the handoff
 * generation, strictly increasing across 'pin' events.
 */
export interface PinAnchorPayload extends CanonicalObject {
  record: B64u
  gen: number
}

/**
 * A5 pairing record (§6b input machinery; closes review A4-12): appended
 * WITNESSED into BOTH players' chains when a rated match is found, BEFORE the
 * game starts (the witness serves a rated game only when both pairings are
 * anchored). This makes abort/no-show omission self-executing evidence: a
 * pairing that is never settled by a later segment or conduct event for the
 * same `game` counts as misconduct in the reputation fold: the record is
 * already in your chain, so "forgetting" the abort is no longer possible.
 */
export interface PairingPayload extends CanonicalObject {
  /** The game key the pairing commits to (segment.ts gameKey). */
  game: B64u
  /** Counterparty root. */
  opp: B64u
  /** Ladder binding, mirroring the segment's (§6). */
  kind: string
  tc: { baseMs: number; incMs: number }
  /** Witnessed match time (the pairing-legality atWts, §7). */
  atWts: number
  /**
   * A7 (closes A4-02 + A4-10): the serving witness's attest over the
   * counterparty's vouched rating + §4 head height at match time. OPTIONAL:
   * legacy pairing records stay byte-valid; absent ⇒ read-time evidence keeps
   * the embedded floor pin (the sound A4 representation). Shape + helpers:
   * witness/attest.ts PairingWitAttest. Read-time material only; no fold input.
   */
  witAttest?: {
    ratingMicro: number
    headHeight: number
    w: B64u
    wts: number
    sig: B64u
  }
}

/**
 * A5 anticheat self-ban (§8/§9): appended by the compliant client when the
 * deterministic Tier-2 CONVICTION fires (A5-21, 2026-07-22: the 5σ line;
 * the 3σ escalation obliges only deeper analysis, never a ban), BEFORE any
 * further witnessed-lane event. `verdict` digests the reproducible Tier-2
 * verdict record published into shard space; `window` names the K-window
 * that convicted.
 */
export interface SelfBanPayload extends CanonicalObject {
  kind: 'anticheat'
  /** Ladder id the conviction window ran on. */
  ladder: string
  /** Window index (commit-reveal salted, §7b). */
  window: number
  /** Ban expiry, diversity-bound witnessed time (§4/§9). */
  expiryWts: number
  /** canonicalHash of the Tier-2 verdict record. */
  verdict: B64u
}

/**
 * A6 friend edge (§3 "friendships are witnessed-lane entanglements", §10):
 * witnessed lane, in the SUBJECT's own chain. An 'add' asserts the edge WITH
 * the counterparty's proven consent: `sig` is the peer's ed25519 over
 * friendBytes({v:1, t:'friend', a, b}) (social/friends.ts; a/b = the two
 * roots in compareKeys order, so BOTH parties countersign identical bytes and
 * one signature per party serves both chains) under `key`; `certs` carry the
 * PEER's root-signed cert events proving key ∈ peer when key !== peer (the
 * commend inline-cert pattern, recursion-bounded via events.ts zCertEvent).
 * A 'remove' is unilateral (§3): the subject's own event signature is the
 * whole authorization; it carries no countersig material.
 *
 * The RELATIONSHIP is the mutual read (social/friends.ts areFriends): friends
 * iff BOTH chains' latest edge state for the pair is a verified 'add'. A
 * replayed/stale countersignature can therefore never resurrect an edge the
 * peer removed: the peer's own chain outranks any material in yours (§0).
 */
export interface FriendPayload extends CanonicalObject {
  action: 'add' | 'remove'
  /** Counterparty root. Never the chain root itself (no self-edges). */
  peer: B64u
  /** 'add' only: peer signing key (the peer root or a certified child). */
  key?: B64u
  /** 'add' only: peer countersignature over friendBytes (social/friends.ts). */
  sig?: B64u
  /** 'add' only: peer cert events proving `key`. Present iff key !== peer. */
  certs?: CanonicalObject[]
}

export interface CheckpointPayload extends CanonicalObject {
  /** Id of the previous checkpoint event. Absent for the first checkpoint. */
  prevCkpt?: B64u
  /** Witnessed-lane height this checkpoint covers through (inclusive). */
  through: number
  /**
   * Fold snapshot at `through`. MUST embed the prior checkpoint's snapshot
   * digest (§2a) and equal exact recomputation over (prevThrough, through]
   * from the prior snapshot (§2b). A1 folds are structural (BasicFoldState);
   * A4 swaps in rating/trust/ban folds behind the same ChainFold interface.
   */
  state: CanonicalObject
  /** canonicalHash(state). */
  stateDigest: B64u
  // NOTE: M-of-N witness cosignatures (§2c) attach in A2 as a `cosig` member
  // OUTSIDE the payload (like WitnessAttestation; countersigning must never
  // change the event id). No field is missing here.
}

// ---------------------------------------------------------------------------
// Chain container + verification
// ---------------------------------------------------------------------------

/**
 * An account chain: the self-carried file (§0). Storage-order is arbitrary
 * for the personal lane; verification derives its own deterministic order.
 */
export interface Chain {
  root: B64u
  events: SignedEvent[]
}

export type VerifyErrorCode =
  | 'bad-genesis'
  | 'bad-signature'
  | 'bad-linkage'
  | 'bad-height'
  | 'uncertified-key'
  | 'revoked-key'
  | 'bad-payload'
  | 'bad-canonical'
  | 'fork'
  | 'bad-checkpoint'
  | 'wrong-root'
  /** A4 review fix (A4-09): one game may enter one chain once. A repeated
   * segment game key is self-evident replay fraud. */
  | 'dup-game'
  /** A4 review fix (A4-01/02/08): a segment event whose own verification
   * (witness stream binding, embedded-oppCkpt authenticity) fails. */
  | 'bad-segment'

export interface VerifyError {
  code: VerifyErrorCode
  /** Offending event id where known. */
  event?: EventId
  detail: string
}

/**
 * Deterministic verification output: same chain bytes → same result object
 * (bit-identical through canonical serialization) on node and in the browser
 * bundle. This object is the A1 determinism-gate artifact.
 */
export interface VerifyResult {
  ok: boolean
  errors: VerifyError[]
  /** Head id of the witnessed lane (absent if no witnessed events verify). */
  witnessedHead?: EventId
  witnessedHeight?: number
  /** Per-signer personal-lane heads. */
  personalHeads: { key: B64u; head: EventId; height: number }[]
  /** Certified, unrevoked child keys at head. */
  activeKeys: { pub: B64u; purpose: number; index: number }[]
  /** Derived profile state (LWW fold over personal lane). */
  profile: CanonicalObject
  /** Fold state at head under the A1 basic fold. */
  fold: CanonicalObject
  /** canonicalHash over a stable projection of this result. The parity digest. */
  digest: B64u
}

/** Pure fold over witnessed-lane events (§2 checkpoints; A4 ratings/trust/bans). */
export interface ChainFold<S extends CanonicalObject> {
  /** Stable fold identifier baked into checkpoint payloads. */
  id: string
  init(root: B64u): S
  /** Must be pure and total: same (state, event) → same state. */
  step(state: S, event: SignedEvent): S
}

/**
 * Self-authenticating fork proof (§2): two distinct signed bodies by the same
 * root/lane sharing one prev. Anyone can verify with no context but the two
 * events (plus certs proving key membership, carried alongside).
 */
export interface ForkProof {
  root: B64u
  a: SignedEvent
  b: SignedEvent
  /** Certs proving a.key / b.key belong to root (empty when signed by root itself). */
  certs: SignedEvent[]
}

// ---------------------------------------------------------------------------
// Keyring
// ---------------------------------------------------------------------------

/**
 * Minimal async KV the keyring persists through. Adapters: in-memory (tests),
 * web localStorage/IDB (src/web), node file (server/operator; lives outside
 * src/shared, which must stay platform-neutral).
 */
export interface KeyStore {
  get(key: string): Promise<Uint8Array | null>
  set(key: string, value: Uint8Array): Promise<void>
  del(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}

/**
 * What the keyring persists per account on a device. The ROOT SEED IS NOT
 * STORED by default: sign-in re-derives it; day-to-day witnessed-lane
 * signing uses the device child key. Storing the seed is an explicit opt-in
 * (keyfile semantics) so a stolen localStorage can cost at most the device
 * key, which a witnessed revocation retires (§1).
 */
export interface StoredAccount {
  v: 1
  foldedName: string
  displayName: string
  tag: string
  rootPub: B64u
  device: { index: number; pub: B64u; certEvent: EventId }
  /** present only on explicit "keep me signed in on this device" opt-in */
  seedB64u?: string
}

// ---------------------------------------------------------------------------
// Mnemonic / keyfile export
// ---------------------------------------------------------------------------

export interface Keyfile {
  v: 1
  kind: 'chess-sharp-keyfile'
  name: string
  tag: string
  /** The 32-byte seed. Plaintext by design. This IS the lifeline (C-5). */
  seed: B64u
}

// ---------------------------------------------------------------------------
// Limits (spec §2/§10 + ACCOUNTS-PARAMS)
// ---------------------------------------------------------------------------

export const TAG_LEN = 5
export const NAME_MIN = 3
export const NAME_MAX = 24
export const AVATAR_MAX_BYTES = 32 * 1024
export const N_CKPT = 20
export const PROFILE_FIELDS = ['bio', 'avatar', 'country', 'flair'] as const
export const BIO_MAX = 500
