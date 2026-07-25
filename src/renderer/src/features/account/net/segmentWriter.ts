// A6 M1 Lane E: the segment writer (spec §3 entanglement, §4 write lease).
//
// The last mile of a signed, witnessed, RATED game: turn the completed game +
// the witness's terminal stream signature + the opponent's pre-game snapshot
// into a `segment` event, and land it in THIS player's own chain under a live
// write lease, countersigned by the game's non-player witness. Both players run
// this INDEPENDENTLY for their own chain, embedding the SAME witness `wstream`.
// That is the §3 pairwise entanglement: one game, one witness signature, two
// self-carried chains that each verify standalone.
//
// It COMPOSES the built substrate, re-implementing none of it:
//   makeSegmentPayload (segment.ts):       assemble + digest the payload
//   clientRequestLease (protocol.ts):      gather the write lease from the
//                                          canonical witness set (at 1-witness
//                                          scale effectiveThreshold floors to 1)
//   clientAppendWitnessed (protocol.ts):   build the event under the lease,
//                                          collect ≥1 NON-PLAYER attestation
//                                          (spec §4), attach + append
//   foldChainA4 (store/derive.ts).         Re-derive the a4 fold so ladders,
//                                          reputation and standing update
//
// Honest degradation (C-10, no dead buttons): with no reachable witness the
// lease request returns 'insufficient-witnesses' and this returns it verbatim:
// the caller shows "Waiting for a witness", never a dead grant, and CASUAL play
// stays fully available. This is only ever invoked for a rated game between two
// signed-in players; unsigned/casual play never reaches here, so v5 stays
// byte-identical.
//
// Renderer-hosted (it drives a live FabricEndpoint) but every byte is A1/A2/A3
// crypto from @shared. `src/shared/accounts` stays pure. Persistence + the wall
// clock are INJECTED so the whole path folds under a headless MockFabric proof
// (scripts/test-accounts-live-slice.mjs) exactly as it runs in the browser.

import { makeSegmentPayload, type SignedMove } from '@shared/accounts/segment'
import { witnessedHeadOf } from '@shared/accounts'
import type { CanonicalObject } from '@shared/accounts/codec'
import type { B64u, Chain, SignedEvent } from '@shared/accounts/types'
import type { ProfileSnapshot } from '@shared/accounts/storage/types'
import {
  PARAMS_A2,
  PARAMS_A2_DIGEST,
  clientAppendWitnessed,
  clientRequestLease,
  nodeIdOf,
} from '@shared/accounts/witness'
import type {
  ChainSummary,
  FabricEndpoint,
  LeaseParams,
  NodeId,
  SubjectSummary,
} from '@shared/accounts/witness'
import { foldChainA4, type ChainDerived } from '../store/derive'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The completed signed game as mpSession surfaces it (getSignedGame()). */
export interface SignedGameView {
  gameKey: B64u
  players: { w: B64u; b: B64u }
  moves: readonly SignedMove[]
}

/** The opponent's verified pre-game snapshot, as preGame.ts hands it over:
 *  its start head + height, profile snapshot, and (young account ⇒ absent)
 *  newest cosigned checkpoint. */
export interface OppSnapshotView {
  /** Opponent account root (MUST equal game.players[other color]). */
  root: B64u
  head: B64u
  height: number
  profile: ProfileSnapshot
  /** Newest cosigned checkpoint (→ segment.oppCkpt); absent ⇒ §6 seeds. */
  ckpt?: SignedEvent
  /** Certs proving oppCkpt.body.key ∈ opp when the checkpoint is device-signed
   *  (segment.ts A4-02, verified inline by verifySegmentEvent). */
  certs?: SignedEvent[]
}

export interface PublishSegmentInput {
  /** The live fabric endpoint (peerService in prod; MockFabric in tests). */
  fabric: FabricEndpoint
  /** THIS player's own account chain, pre-append. */
  chain: Chain
  /** THIS player's device signing identity (accounts.ts deviceSigningKey()). */
  signing: { root: B64u; key: B64u; priv: Uint8Array }
  /** The completed signed game (mp.getSignedGame()). */
  game: SignedGameView
  /** THIS player's color. */
  color: 'w' | 'b'
  result: '1-0' | '0-1' | '1/2-1/2'
  reason: string
  /** A4 ladder binding (§6): BOTH present on a rated game. Absent ⇒ the
   *  segment writes UNBOUND and the rating fold skips it (legacy/casual). */
  kind?: string
  tc?: { baseMs: number; incMs: number }
  /** The seated witness's terminal stream signature: `wkey` from
   *  mp.getWitnessIdentity().key, `sig` from the observed `wend` message. */
  wstream: { wkey: B64u; sig: B64u }
  /** The opponent's verified pre-game snapshot view. */
  opp: OppSnapshotView
  /** Wall clock (unix ms): the event ts + the lease grant time. Injected so
   *  the path is deterministic headless; prod passes Date.now(). */
  wts: number
  /** Lease epoch (default 1: a fresh account's first witnessed write; M2's
   *  leaseRunner owns the real monotonic epoch). */
  epoch?: number
  /** Lease TTL ms (default PARAMS_A2.leaseTtlMs). */
  ttlMs?: number
  /** Eligibility params for the canonical witness set (default PARAMS_A2). */
  params?: LeaseParams
  /** Params digest embedded in the lease body (default PARAMS_A2_DIGEST). */
  paramsDigest?: B64u
  /** Chain-derived witness summaries keyed by nodeId: supplied by peerService
   *  from the overlay. Empty ⇒ small-population relaxation admits reachable
   *  witnesses (the 1-witness slice), which is exactly the M1 boundary. */
  summaries?: ReadonlyMap<NodeId, ChainSummary>
  /** Persist the updated chain (prod: keyring().saveChain; tests: in-memory).
   *  Omitted ⇒ no persistence (the caller owns it). */
  saveChain?: (root: B64u, chain: Chain) => Promise<void>
}

export type PublishSegmentResult =
  | { ok: true; chain: Chain; event: SignedEvent; fold: ChainDerived }
  | { ok: false; reason: string }

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/**
 * Build THIS player's `segment` for a completed rated game and land it in the
 * own chain under a witnessed write lease. Returns the appended chain, the
 * segment event, and the freshly re-derived a4 fold (ladders/reputation move),
 * or a typed failure: 'insufficient-witnesses' (honest degradation), a shape
 * mismatch, or the append reason. Never partially mutates: on any failure the
 * caller's chain is untouched (clientAppendWitnessed builds a new Chain).
 */
export async function buildAndPublishSegment(input: PublishSegmentInput): Promise<PublishSegmentResult> {
  const params = input.params ?? PARAMS_A2
  const paramsDigest = input.paramsDigest ?? PARAMS_A2_DIGEST
  const epoch = input.epoch ?? 1
  const ttlMs = input.ttlMs ?? PARAMS_A2.leaseTtlMs
  const summaries = input.summaries ?? new Map<NodeId, ChainSummary>()

  // --- consistency: the snapshot's opp and our own root must match the game ---
  const oppColor = input.color === 'w' ? 'b' : 'w'
  const oppRoot = input.game.players[oppColor]
  if (input.opp.root !== oppRoot) return { ok: false, reason: 'opp-root-mismatch' }
  if (input.game.players[input.color] !== input.signing.root) return { ok: false, reason: 'own-root-mismatch' }
  if (input.chain.root !== input.signing.root) return { ok: false, reason: 'chain-root-mismatch' }

  // --- both start heads (§3): our own head + the opponent's snapshot head -----
  const ownHead = witnessedHeadOf(input.chain.events)
  if (!ownHead) return { ok: false, reason: 'no-genesis' }
  const heads =
    input.color === 'w'
      ? { w: { head: ownHead.id, height: ownHead.height }, b: { head: input.opp.head, height: input.opp.height } }
      : { w: { head: input.opp.head, height: input.opp.height }, b: { head: ownHead.id, height: ownHead.height } }

  // --- assemble the payload (digest, transcript, wstream, oppCkpt?) -----------
  const payload = makeSegmentPayload({
    game: input.game.gameKey,
    opp: oppRoot,
    color: input.color,
    result: input.result,
    reason: input.reason,
    moves: input.game.moves,
    heads,
    wstream: input.wstream,
    ...(input.opp.ckpt !== undefined ? { oppCkpt: input.opp.ckpt } : {}),
    ...(input.opp.certs !== undefined ? { oppCerts: input.opp.certs } : {}),
    oppProfile: input.opp.profile,
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.tc !== undefined ? { tc: input.tc } : {}),
  })

  // --- gather the write lease from the canonical witness set ------------------
  // M1 subject summary is minimal (no entanglement window yet: M2 wires it);
  // eligibility relaxes at small population, so the reachable witness grants.
  const subject: SubjectSummary = {
    root: input.chain.root,
    nodeId: nodeIdOf(input.chain.root),
    entangledRoots: new Set<string>(),
    secondDegreeRoots: new Set<string>(),
  }
  const leaseRes = await clientRequestLease({
    fabric: input.fabric,
    root: input.chain.root,
    epoch,
    deviceKey: input.signing.key,
    devicePriv: input.signing.priv,
    grantedWts: input.wts,
    ttlMs,
    paramsDigest,
    subject,
    summaries,
    params,
    nowMs: input.wts,
  })
  if (!leaseRes.ok) return { ok: false, reason: leaseRes.reason } // 'insufficient-witnesses' (C-10)

  // --- append under the lease, collecting ≥1 non-player attestation (§4) ------
  const players = new Set<NodeId>([nodeIdOf(input.game.players.w), nodeIdOf(input.game.players.b)])
  const appendRes = await clientAppendWitnessed({
    fabric: input.fabric,
    chain: input.chain,
    lease: leaseRes.lease,
    deviceKey: input.signing.key,
    devicePriv: input.signing.priv,
    type: 'segment',
    // SegmentPayload → the transport's CanonicalObject seam (cjson-v1 at
    // runtime; the index-signature cast is segment.ts's own makeWitnessedResult
    // pattern, clientAppendWitnessed re-validates the payload schema on append).
    payload: payload as unknown as CanonicalObject,
    ts: input.wts,
    epoch,
    witnessSet: leaseRes.witnessSet,
    players,
  })
  if (!appendRes.ok) return { ok: false, reason: appendRes.reason }

  // --- persist + re-fold so ladders/reputation/standing update ----------------
  if (input.saveChain) await input.saveChain(appendRes.chain.root, appendRes.chain)
  const fold = foldChainA4(appendRes.chain)
  return { ok: true, chain: appendRes.chain, event: appendRes.event, fold }
}
