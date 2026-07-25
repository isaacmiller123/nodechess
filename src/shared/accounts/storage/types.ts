// A3 storage: shared type contract (spec §3 entanglement, §5 storage layers /
// authenticated pointers / viewing flow, ACCOUNTS-PARAMS §Storage). Types +
// validity rules only; implementations live in sibling modules.
// Platform-neutral: no `node:` imports, no DOM globals.
//
// Conventions are A1/A2's: cjson-v1 canonical bytes, sha256 ids, ed25519
// signatures, base64url-no-pad byte strings. Every verifier here is pure and
// byte-deterministic on node and in the browser bundle.

import type { CanonicalObject } from '../codec'
import type { B64u, EventId, SignedEvent } from '../types'
import type { NodeId } from '../witness/types'

// ---------------------------------------------------------------------------
// Reed-Solomon shard framing (rs.ts)
// ---------------------------------------------------------------------------

/**
 * One erasure-coded shard of a blob. Coding is RS over GF(2^8) (poly 0x11d,
 * generator 0x02) with the systematic Cauchy matrix [I_k; C],
 * C[r][j] = 1/((k+r) XOR j). Disjoint x/y index sets, so every k-row subset
 * is invertible (true MDS: ANY kRec of nShards reconstruct).
 *
 * Integrity is end-to-end: `dataHash` = sha256 of the ORIGINAL blob rides in
 * every shard's framing and reconstruction re-hashes the output against it.
 * A corrupted or substituted shard set can never yield an accepted blob.
 */
export interface Shard extends CanonicalObject {
  v: 1
  /** Row index in [0, n). Rows < k are the systematic data rows. */
  idx: number
  k: number
  n: number
  /** Original blob length (bytes). Strips the zero padding on reconstruct. */
  dataLen: number
  /** b64u(sha256(original blob)). */
  dataHash: B64u
  /** b64u shard payload, ceil(dataLen / k) bytes. */
  body: B64u
}

// ---------------------------------------------------------------------------
// Snapshot header: binds a shard job to a countersigned chain state
// ---------------------------------------------------------------------------

/**
 * The header every full-chain shard job carries. Authority comes from the
 * EMBEDDED countersigned head event, never from the publisher: `head` must be
 * a witnessed event of `root` (owner-signed + witness-attested), `headId` its
 * event id, and `blobHash`/`blobLen` bind the erasure-coded bytes
 * (chainToBytes of the chain at that head). After reconstruction the viewer
 * verifies the chain AND checks its witnessed head equals `headId`.
 * `certs` carry the cert events proving head.body.key belongs to root (empty
 * when root-signed), so verification needs no external context.
 *
 * `commitSig` binds blobHash/blobLen AND every shard body to OWNER authority at
 * STORE time: an ed25519 signature by `head.body.key` (itself proven for root by
 * `certs`) over the commitment tuple (shards.ts snapshotCommitBytes), which
 * includes `bodyHashes`. Without it a keyless attacker could pair a replayed
 * real head with a foreign blobHash and pin a shard slot the real snapshot could
 * never displace: the reconstruct gate catches a forged blob but only AFTER a
 * poison row has locked the key. A verifier re-checks it, so blobHash and the
 * per-row body bytes are authenticated with no external context; only the owner
 * (or a certified device) can cut a snapshot.
 *
 * `bodyHashes[i]` = sha256 of shard row i's body bytes (n entries, idx order),
 * committed by `commitSig`. A store-time verifier binds each accepted shard body
 * to its owner-committed hash, so a keyless attacker cannot pin a slot with a
 * same-length garbage/byte-flipped body (which the framing's blob-level dataHash
 * cannot see per-row) and strand an otherwise-recoverable snapshot.
 */
export interface SnapshotHeader {
  v: 1
  root: B64u
  headId: EventId
  height: number
  head: SignedEvent
  certs: SignedEvent[]
  blobHash: B64u
  blobLen: number
  k: number
  n: number
  /** PARAMS_A3_DIGEST the job was cut under. */
  params: B64u
  /** b64u(sha256(body)) of every shard row, idx order (n entries). The owner's
   * per-row body commitment, authenticated by commitSig. */
  bodyHashes: B64u[]
  /** ed25519 by head.body.key over snapshotCommitBytes(header): the owner's
   * commitment that blobHash/blobLen + bodyHashes are the snapshot of the chain
   * at headId. */
  commitSig: B64u
}

/** What a shard carrier stores + serves per (subject, idx): the job header
 * plus its shard. The overlay key is shardKey(subjectNodeId, idx). */
export interface ShardEnvelope {
  v: 1
  header: SnapshotHeader
  shard: Shard
}

// ---------------------------------------------------------------------------
// Game segments (§3): the entanglement event payload (EventType 'segment')
// ---------------------------------------------------------------------------

/** Compact profile snapshot embedded in every segment (~the §5 reconstruction
 * snapshot). The avatar rides as a digest reference, never inline (2 KB/game
 * budget). Absent fields = unset. */
export interface ProfileSnapshot extends CanonicalObject {
  name: string
  bio?: string
  country?: string
  flair?: string
  avatarDigest?: B64u
}

/** A checkpoint embedded for the A4 fold: the opponent's newest ckpt EVENT
 * with its M-of-N cosignatures riding in `wit`. Verifiable with no recursion
 * into the opponent's chain (§6 pinned fold inputs). Absent when the opponent
 * has no checkpoint yet (young account). */
export type EmbeddedCheckpoint = SignedEvent

/**
 * Payload of a witnessed-lane 'segment' event: one rated game, written into
 * BOTH players' chains (each player writes its own segment event; the pairwise
 * countersigning lives in the transcript's interleaved per-move signatures,
 * wire v6).
 *
 * Load-bearing for anti-poisoning: `opp` NAMES the counterparty. A pointer
 * whose embedded proof is a segment event only authorizes the named
 * counterparty as holder (see PointerRecord).
 */
export interface SegmentPayload {
  /** Global game key (wire v6 gameKey): canonicalHash of the game-start
   * record; the value every per-move signature covers. */
  game: B64u
  /** Counterparty root. */
  opp: B64u
  /** This chain's owner played... */
  color: 'w' | 'b'
  result: '1-0' | '0-1' | '1/2-1/2'
  /** Termination reason (bounded free text: 'checkmate', 'resign', ...). */
  reason: string
  /** canonicalHash of the full signed transcript (segment.ts transcriptDigest:
   * {v, g, moves:[{ply, move, clockMs, sig}...], result, reason}). */
  transcript: B64u
  plies: number
  /** BOTH chain heads at game start (§3), keyed by color. */
  heads: {
    w: { head: B64u; height: number }
    b: { head: B64u; height: number }
  }
  /** Witness stream signature over {v:1, t:'wend', g, result, plies,
   * transcript}: the §3 "witness signs the interleaved stream" terminal
   * signature. `wkey` is the witness signing key. */
  wstream: { wkey: B64u; sig: B64u }
  /** Opponent's newest M-of-N-cosigned checkpoint at game time (§6 fold
   * input). Absent for young opponents. */
  oppCkpt?: EmbeddedCheckpoint
  /** Opponent's profile snapshot at game time (§5 reconstruction snapshot). */
  oppProfile: ProfileSnapshot
  /** A4 ladder binding (§6), dimension 1: game-kind registry id ('chess',
   * 'chess960', …). Absent on pre-A4 segments ⇒ the rating fold skips them. */
  kind?: string
  /** A4 ladder binding (§6), dimension 2: the clock. TimeCategory is derived
   * in EXACT INTEGER math (ratings/, estMs = baseMs + 40·incMs vs fixed
   * thresholds: same semantics as the renderer's timeControlCategory without
   * its float division). baseMs === 0 ⇒ Unlimited ⇒ unrated. Absent ⇒ the
   * rating fold skips the segment. */
  tc?: { baseMs: number; incMs: number }
  /** A4 review fix (A4-02): cert events proving oppCkpt.body.key belongs to
   * `opp` when the embedded checkpoint is device-signed (absent when
   * root-signed). Verified inline, no recursion into the opponent's chain. */
  oppCerts?: SignedEvent[]
}

// ---------------------------------------------------------------------------
// Witnessed result record (§3 rage-quit denial)
// ---------------------------------------------------------------------------

/**
 * Published by the game's witness for BOTH chains when a decisive result
 * exists (resign/flag/mate) regardless of either player's cooperation. A
 * chain missing a witness-adjudicated decisive segment it should contain is
 * a tamper signal (§8-style suppression). Standalone record (not a chain
 * event): verifiable from the record + the witness's presence/cert alone.
 */
export interface WitnessedResultBody extends CanonicalObject {
  v: 1
  game: B64u
  /** Both players' roots, keyed by color. */
  players: { w: B64u; b: B64u }
  result: '1-0' | '0-1' | '1/2-1/2'
  reason: string
  /** Transcript digest up to and including the last countersigned ply. */
  transcript: B64u
  plies: number
  wts: number
}

export interface WitnessedResultRecord {
  body: WitnessedResultBody
  /** Witness root + signing key + ed25519 over canonicalBytes(body). */
  wroot: B64u
  wkey: B64u
  sig: B64u
}

// ---------------------------------------------------------------------------
// Authenticated pointers (§5): closes index poisoning
// ---------------------------------------------------------------------------

/**
 * What a pointer may point at. In ALL 'segment'/'chain' cases the embedded
 * proof `event` is the SUBJECT's OWN countersigned witnessed event. Never the
 * holder's: because only the subject's signature is unforgeable by the holder
 * (a holder self-signing "I played X" is freely mintable = poisoning; the
 * subject's signed event naming the holder is not). This is the single
 * canonical (root, opp, hash) direction; ACCOUNTS-SPEC.md §5 ("embeds the
 * countersigned segment header it references: X's head signature + witness
 * countersignature") is authoritative and reads the same way.
 *
 *  - 'segment': the SUBJECT's chain segment event of a game with the holder,
 *    event.body.root === subject, event.payload.opp === holder root. hash =
 *    the event id of THAT (subject's) segment event. The subject signed it and
 *    a witness attested it, so only a real opponent the subject actually named
 *    can be enumerated as a holder.
 *  - 'chain': the SUBJECT's own witnessed head/checkpoint event authorizing a
 *    full-chain replica (a friend/pinner or the subject's own device);
 *    event.body.root === subject. hash = blobHash of chainToBytes at that head.
 *  - 'shard': holder is an assigned shard carrier. hash = the shard job's
 *    blobHash; `idx` names the shard row.
 */
export type PointerKind = 'segment' | 'chain' | 'shard'

/**
 * Proof material embedded IN the pointer (the whole point of §5): a pointer
 * is valid ONLY if its embedded proof independently authorizes the holder.
 *
 *  - 'segment'/'chain': `event` is a countersigned (owner-signed +
 *    witness-attested) witnessed event OF THE SUBJECT'S CHAIN
 *    (event.body.root === subject). For 'segment' its payload names the holder
 *    as counterparty (segment.opp === holder root); 'chain' is the subject's
 *    head/checkpoint. certs prove event.body.key belongs to the subject. A
 *    viewer verifies sig + attestation + the naming rule. A stranger replaying
 *    the subject's public head event as a 'segment' fails the opp===holder
 *    rule, and a holder cannot self-sign a subject-rooted event, so neither can
 *    mint an enumerable pointer.
 *  - 'shard': `header` is the SnapshotHeader (itself embedding the
 *    countersigned head). The holder additionally claims duty by key
 *    distance: rank = xorDistance(holderNodeId, shardKey(subject, idx)) is
 *    OBJECTIVE: viewers enumerate at most dutyK carriers per idx, closest
 *    first. Poisoning a slot requires grinding sha256(rootPub) into the top
 *    dutyK AND holding bytes that reconstruct to the countersigned head.
 */
export interface PointerProof {
  /** For 'segment' / 'chain'. */
  event?: SignedEvent
  certs?: SignedEvent[]
  /** For 'shard'. */
  header?: SnapshotHeader
}

export interface PointerBody {
  v: 1
  /** Subject root the pointer indexes (stored under nodeIdOf(subject)). */
  subject: B64u
  /** Holder identity: account root + the certified device key that signs. */
  holder: B64u
  key: B64u
  kind: PointerKind
  /** Content hash (see PointerKind). */
  hash: B64u
  /** Shard row for kind 'shard'. */
  idx?: number
  /** Holder-claimed freshness (unix ms): used for ranking only, never
   * authority; capped by verifiers at the embedded proof's witnessed time
   * plus a bounded skew. */
  ts: number
  proof: PointerProof
  /** Holder's certs proving `key` belongs to `holder` (empty if root-signed). */
  holderCerts: SignedEvent[]
}

export interface PointerRecord {
  body: PointerBody
  /** ed25519 by body.key over canonicalBytes(body). */
  sig: B64u
}

/** The verified, ranked view a viewer builds from an enumerated pointer set:
 * real entanglements + at most dutyK carriers per shard row, everything else
 * discarded (§5 "viewers rank by embedded proof and ignore the rest"). */
export interface ContactSheet {
  subject: B64u
  segments: { holder: B64u; ptr: PointerRecord }[]
  chains: { holder: B64u; ptr: PointerRecord }[]
  /** By shard idx, closest-first, length ≤ dutyK each. */
  shards: Map<number, { holder: B64u; nodeId: NodeId; ptr: PointerRecord }[]>
}

// ---------------------------------------------------------------------------
// Viewing flow (§5)
// ---------------------------------------------------------------------------

/** What a holder serves the viewer on the profile fast path: newest head +
 * newest M-of-N checkpoint + newest profile events: exactly the pinned
 * inputs A4's folds need. Every element is independently verifiable; the
 * summary confers nothing. */
export interface HolderSummary {
  v: 1
  root: B64u
  head?: SignedEvent
  ckpt?: SignedEvent
  /** Newest profile-bearing events (personal lane) the holder has. */
  profileEvents: SignedEvent[]
  certs: SignedEvent[]
}

/** Reconstruction output (viewer.ts). `sources` names how each fact was met
 * so the §5 acceptance proof can assert the guaranteed floor vs expected. */
export interface ReconstructedProfile {
  root: B64u
  /** FLOOR path only. The C-12 honest signal (spec §12): present (true) when
   * the view honored ≥1 DEVICE-signed revocation with no chain linkage to vet
   * it. NO-FORGE (§0) requires honoring such revokes (device-to-device
   * revocation is a model feature), but their evidence is mintable by any
   * leaked certified key, so honest content MAY be transiently withheld: the
   * view is revocation-DEGRADED, never silently complete. Absent whenever a
   * verified chain adjudicated (expected path) and when only root-signed /
   * chain-linked revocations gate; a reconstructing chain heals it (§14). */
  revocationContested?: boolean
  /** Verified newest witnessed head seen across sources. */
  head?: { id: EventId; height: number }
  /** Newest checkpoint that passed incremental verify (+ spot-check when
   * drawn). */
  ckpt?: { id: EventId; through: number; state: CanonicalObject }
  profile: CanonicalObject
  /** Full chain when shard/chain reconstruction succeeded; absent when only
   * the segment-union floor was reachable. */
  chain?: import('../types').Chain
  /** Verified game segments recovered (union across sources, deduped by
   * event id). The guaranteed floor. */
  segments: SignedEvent[]
  sources: { pointers: number; holders: number; shardsUsed: number; viaChain: boolean }
}
