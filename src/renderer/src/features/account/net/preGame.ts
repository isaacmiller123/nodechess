// A6 M1 Lane E: the pre-game snapshot exchange (spec §3 entanglement).
//
// Before move 1 of a SIGNED, RATED game, each player hands the opponent a
// SIGNED snapshot of its own account state. Its current witnessed head +
// height, its profile snapshot, and (when it has one) its newest M-of-N
// cosigned checkpoint. Each side then folds the opponent's snapshot into the
// `segment` it writes for its OWN chain (segment.ts MakeSegmentOpts): the
// snapshot supplies `heads` (both chains' start heads, §3), `oppProfile` (the
// §5 reconstruction snapshot embedded per game), and `oppCkpt` (the §6 pinned
// fold input. ABSENT for a young opponent, which the fold reads as the §6
// seeds 1200/350). This is the PRECURSOR to the M2 witnessed `'pairing'` record
// (ratings/conduct.ts makePairingPayload): same game/opp/head binding, but
// exchanged peer-to-peer over the fabric rather than anchored in both chains.
//
// The signed contract is the whole point: a snapshot is authority-free relay
// data, so it is only trusted for its ed25519 signature by the sender's
// certified device key. The receiver pins BOTH directions: the snapshot names
// the game it is for and the opponent it is for, so a snapshot cannot be
// replayed across games or re-aimed at a third party.
//
// Platform-specific hosting layer (renderer): it holds a live FabricEndpoint,
// but every byte it signs/verifies is A1's cjson-v1 + ed25519, reused from
// @shared, never re-implemented. `src/shared/accounts` stays pure; the one
// shared touch this consumes is the lead's additive `pregame-snapshot`
// FabricRequestKind member (witness/types.ts).

import { z } from 'zod'
import { canonicalBytes, type CanonicalObject } from '@shared/accounts/codec'
import { ed25519, toB64u, verifySigB64u } from '@shared/accounts/hash'
import {
  eventId,
  verifyEventSig,
  witnessedHeadOf,
  zB64u32,
  zB64u64,
  zCkptEvent,
  zPairingPayload,
  zProfileSnapshot,
} from '@shared/accounts/events'
import { makePairingPayload } from '@shared/accounts/ratings/conduct'
import type { B64u, Chain, PairingPayload, SignedEvent } from '@shared/accounts/types'
import type { ProfileSnapshot } from '@shared/accounts/storage/types'
import { clientAppendWitnessed, verifyAttestation } from '@shared/accounts/witness'
import type { FabricEndpoint, Lease, NodeId } from '@shared/accounts/witness/types'
import { nodeIdOf } from '@shared/accounts/witness/distance'

// ---------------------------------------------------------------------------
// The signed pre-game snapshot contract
// ---------------------------------------------------------------------------

/**
 * The body a player signs before move 1. `key` is the certified DEVICE signing
 * key the signature verifies against (certified under `root` in the sender's
 * chain: a fact the segment's read-time verifiers judge, not this record).
 * `head`/`height` are the sender's current witnessed head; `profile` is its §5
 * reconstruction snapshot; `ckpt` is its newest cosigned checkpoint or ABSENT
 * (young account → the §6 seeds path). `game`/`opp` bind the snapshot to ONE
 * game against ONE opponent (anti-replay). A CanonicalObject at runtime (cjson
 * -v1), but declared as a plain interface because `ckpt` nests a SignedEvent:
 * canonicalBytes casts at the seam, exactly like segment.ts makeWitnessedResult.
 */
export interface PreGameSnapshotBody {
  v: 1
  t: 'pregame-snapshot'
  /** Global game key (wire v6 gameKey) this snapshot is for. */
  game: B64u
  /** Sender account root. */
  root: B64u
  /** Sender's certified device signing key: what `sig` verifies against. */
  key: B64u
  /** The opponent root this snapshot is aimed at (binds direction). */
  opp: B64u
  /** Sender's current witnessed head id (→ segment.heads[senderColor]). */
  head: B64u
  /** Sender's current witnessed head height. */
  height: number
  /** Sender's profile snapshot (→ segment.oppProfile on the receiver's side). */
  profile: ProfileSnapshot
  /** Sender clock (unix ms): informational; the receiver bounds it. */
  ts: number
  /** Sender's newest M-of-N cosigned checkpoint (→ segment.oppCkpt). ABSENT for
   *  a young account, which the §6 fold correctly reads as the seeds. */
  ckpt?: SignedEvent
}

export interface SignedPreGameSnapshot {
  body: PreGameSnapshotBody
  /** ed25519 by body.key over canonicalBytes(body). */
  sig: B64u
}

const zPreGameBody = z.strictObject({
  v: z.literal(1),
  t: z.literal('pregame-snapshot'),
  game: zB64u32,
  root: zB64u32,
  key: zB64u32,
  opp: zB64u32,
  head: zB64u32,
  height: z.int().min(0),
  profile: zProfileSnapshot,
  ts: z.int().min(0),
  // Recursion-bounded ckpt event (non-recursive schema, like segment.oppCkpt).
  ckpt: zCkptEvent.optional(),
})

const zSignedPreGame = z.strictObject({ body: zPreGameBody, sig: zB64u64 })

/** The exact bytes a snapshot signs. One place, so sign and verify agree. */
function snapshotBytes(body: PreGameSnapshotBody): Uint8Array {
  return canonicalBytes(body as unknown as CanonicalObject)
}

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

export interface SnapshotFields {
  game: B64u
  root: B64u
  key: B64u
  opp: B64u
  head: B64u
  height: number
  profile: ProfileSnapshot
  ts: number
  ckpt?: SignedEvent
}

/** Assemble + sign a pre-game snapshot with the sender's device key. `ckpt`
 *  absent ⇒ the field is OMITTED from the signed bytes (young account). */
export function signPreGameSnapshot(f: SnapshotFields, devicePriv: Uint8Array): SignedPreGameSnapshot {
  const body: PreGameSnapshotBody = {
    v: 1,
    t: 'pregame-snapshot',
    game: f.game,
    root: f.root,
    key: f.key,
    opp: f.opp,
    head: f.head,
    height: f.height,
    profile: f.profile,
    ts: f.ts,
    ...(f.ckpt !== undefined ? { ckpt: f.ckpt } : {}),
  }
  return { body, sig: toB64u(ed25519.sign(snapshotBytes(body), devicePriv)) }
}

/**
 * Verify a received snapshot, fail-closed on ANY malformation (never throws):
 * strict shape, ed25519 signature by body.key over the body, and. When a
 * checkpoint rides: that it is a self-signed 'ckpt' event OF the sender's root
 * (so an opponent cannot bolt a stranger's checkpoint onto its snapshot; the
 * FULL §6 cosigner/prefix check is verifySegmentEvent's job downstream). This
 * proves the record's PROVENANCE only: that `key` is certified under `root`,
 * that the head is real, and that the account is not fuse-banned are chain
 * facts the segment's read-time verifiers establish, never this relay record.
 */
export function verifyPreGameSnapshot(snap: unknown): snap is SignedPreGameSnapshot {
  const res = zSignedPreGame.safeParse(snap)
  if (!res.success) return false
  const s = res.data as unknown as SignedPreGameSnapshot
  let bytes: Uint8Array
  try {
    bytes = snapshotBytes(s.body)
  } catch {
    return false
  }
  if (!verifySigB64u(s.sig, bytes, s.body.key)) return false
  const ckpt = s.body.ckpt
  if (ckpt !== undefined) {
    if (ckpt.body.type !== 'ckpt' || ckpt.body.lane !== 'w') return false
    if (ckpt.body.root !== s.body.root) return false
    if (!verifyEventSig(ckpt)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Fabric transport: serve our snapshot / request the opponent's
// ---------------------------------------------------------------------------

/** Return-shaped error the request channel surfaces (never throws the handler). */
function reqError(reason: string): CanonicalObject {
  return { error: reason } as unknown as CanonicalObject
}

/**
 * Register the `pregame-snapshot` request handler on the fabric: answer a peer's
 * request with OUR signed snapshot for the game it names, aimed back at that
 * peer. The requester sends `{ game, from }` where `from` is its own root; we
 * refuse the request unless `nodeIdOf(from)` equals the fabric-level sender
 * nodeId: a peer can only ask AS a root whose nodeId it actually controls, so
 * it cannot make us cut a snapshot aimed at a root it does not own. `provider`
 * builds our snapshot for (game, thatPeerRoot). Returns an unsubscribe-free
 * registration (the fabric owns handler lifetime), mirroring witnessServe.
 */
export function servePreGame(
  fabric: FabricEndpoint,
  provider: (game: B64u, oppRoot: B64u) => SignedPreGameSnapshot,
): void {
  fabric.onRequest('pregame-snapshot', async (from, payload) => {
    const p = payload as unknown as { game?: unknown; from?: unknown }
    if (typeof p.game !== 'string' || typeof p.from !== 'string') return reqError('bad-request')
    // Anti-spoof: the claimed requester root must own the requesting nodeId.
    if (nodeIdOf(p.from) !== from) return reqError('nodeid-mismatch')
    try {
      return provider(p.game, p.from) as unknown as CanonicalObject
    } catch {
      return reqError('provider-failed')
    }
  })
}

export interface RequestSnapshotOpts {
  fabric: FabricEndpoint
  /** The opponent's fabric nodeId (keyed exchange). */
  opp: NodeId
  /** The game key both sides are about to play. */
  game: B64u
  /** OUR root. Sent so the responder can aim its snapshot back at us. */
  selfRoot: B64u
  /** The opponent root we expect (pin; the mp hello identity). */
  expectOppRoot: B64u
}

export type RequestSnapshotResult =
  | { ok: true; snapshot: SignedPreGameSnapshot }
  | { ok: false; reason: string }

/**
 * Request the opponent's signed snapshot over the fabric and verify it end to
 * end: signature valid, aimed at THIS game, from the EXPECTED opponent root, and
 * addressed to US. Honest degradation: an unreachable opponent or a bad snapshot
 * returns {ok:false, reason}. The caller can still play CASUAL (unwitnessed)
 * while rated writing waits, never a dead button.
 */
export async function requestPreGameSnapshot(opts: RequestSnapshotOpts): Promise<RequestSnapshotResult> {
  let res: unknown
  try {
    res = await opts.fabric.request(opts.opp, 'pregame-snapshot', {
      game: opts.game,
      from: opts.selfRoot,
    } as unknown as CanonicalObject)
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  if (res !== null && typeof res === 'object' && 'error' in (res as Record<string, unknown>))
    return { ok: false, reason: String((res as { error: unknown }).error) }
  if (!verifyPreGameSnapshot(res)) return { ok: false, reason: 'bad-snapshot' }
  const snap = res
  if (snap.body.game !== opts.game) return { ok: false, reason: 'game-mismatch' }
  if (snap.body.root !== opts.expectOppRoot) return { ok: false, reason: 'opp-mismatch' }
  if (snap.body.opp !== opts.selfRoot) return { ok: false, reason: 'not-for-us' }
  return { ok: true, snapshot: snap }
}

// ---------------------------------------------------------------------------
// Provider helper: build our own snapshot from the live chain (lead-facing)
// ---------------------------------------------------------------------------

export interface SnapshotProviderDeps {
  /** Our current own account chain (re-read per game; the head advances). */
  chain: () => Chain
  /** Our device signing identity. */
  signing: { root: B64u; key: B64u; priv: Uint8Array }
  /** Our profile snapshot (name required; §5). */
  profile: () => ProfileSnapshot
  /** Our newest cosigned checkpoint, or undefined (young account → seeds). */
  ckpt?: () => SignedEvent | undefined
  /** Wall clock (unix ms). The glue layer's, never the pure library's. */
  now: () => number
}

/**
 * Build a `servePreGame` provider that snapshots our live chain: reads the
 * current witnessed head, attaches our profile + newest checkpoint, signs. The
 * lead wires this from the signed-in session (accounts.ts deviceSigningKey +
 * loadOwnChain) once per online session.
 */
export function makeSnapshotProvider(
  deps: SnapshotProviderDeps,
): (game: B64u, oppRoot: B64u) => SignedPreGameSnapshot {
  return (game, oppRoot) => {
    const chain = deps.chain()
    const head = witnessedHeadOf(chain.events)
    if (!head) throw new Error('preGame: own chain has no witnessed head (no genesis)')
    const ckpt = deps.ckpt?.()
    return signPreGameSnapshot(
      {
        game,
        root: deps.signing.root,
        key: deps.signing.key,
        opp: oppRoot,
        head: head.id,
        height: head.height,
        profile: deps.profile(),
        ts: deps.now(),
        ...(ckpt !== undefined ? { ckpt } : {}),
      },
      deps.signing.priv,
    )
  }
}

/** The event id a pre-game snapshot's checkpoint names (M2 pairing precursor;
 *  handy for the lead when promoting this to the witnessed 'pairing' record). */
export function snapshotCkptId(snap: SignedPreGameSnapshot): B64u | null {
  return snap.body.ckpt ? eventId(snap.body.ckpt.body) : null
}

// ===========================================================================
// M2: the REAL witnessed 'pairing' record (spec §3/§8; the ratings/conduct.ts
// anchoring contract). Promotes the pre-game snapshot precursor above into the
// on-chain, WITNESSED pairing both players append to their OWN chains BEFORE the
// first move. The event that turns on the WitnessCore pairing gate
// (witnessCore.ts:489: a rated session is refused unless both players' pairing
// anchors are present and consistent). Same game/opp/kind/tc binding as the
// snapshot, but countersigned by the game's non-player witness under each
// player's live lease, so it is a durable both-chains anchor, not relay data.
// ===========================================================================

export interface AnchorPairingInput {
  /** The live fabric endpoint (peerService in prod; a MockFabric in tests). */
  fabric: FabricEndpoint
  /** THIS player's own account chain, pre-pairing. */
  chain: Chain
  /** THIS device's signing identity. */
  signing: { root: B64u; key: B64u; priv: Uint8Array }
  /** The live write lease from `leaseRunner.acquire()` (spec §4). */
  lease: Lease
  /** The witness set the lease was gathered from. The attest fan-out target. */
  witnessSet: readonly NodeId[]
  /** The host-minted global game key (both sides verified it identical, §3). */
  game: B64u
  /** The counterparty root (→ payload.opp). */
  opp: B64u
  /** Ladder binding, mirroring the segment's (§6). */
  kind: string
  tc: { baseMs: number; incMs: number }
  /** The pairing-legality witnessed timestamp (§7/A4-16): the one instant BOTH
   *  sides evaluate pairingLegal at, supplied by the matchmaker (L-mm). */
  atWts: number
  /** Both players' nodeIds. The attesting witness must be NEITHER (§4). */
  players: ReadonlySet<NodeId>
  /** The lease epoch (fencing token): the SAME epoch the post-game segment
   *  lands under, so the pairing → segment pair is one monotonic run. */
  epoch: number
  /** Event ts (wall clock, ms). Default `atWts`. */
  ts?: number
  /** Persist the appended chain (prod: keyring().saveChain). */
  saveChain?: (root: B64u, chain: Chain) => Promise<void>
}

export type AnchorPairingResult =
  | { ok: true; chain: Chain; event: SignedEvent; payload: PairingPayload }
  | { ok: false; reason: string }

/**
 * Append THIS player's witnessed 'pairing' event to its own chain under the live
 * lease, countersigned by the game's non-player witness (spec §3/§4/§8). Both
 * players run this INDEPENDENTLY before move 1; each carries the SAME game key +
 * ladder binding and names the OTHER as `opp`, so the two anchors are the
 * cross-wise pair the witness's pairing gate requires. Honest degradation: no
 * reachable witness ⇒ the append returns 'insufficient-witnesses' /
 * 'no-non-player-witness' verbatim (the rated button waits, C-10). Never
 * partially mutates: clientAppendWitnessed builds a new Chain.
 */
export async function anchorPairing(input: AnchorPairingInput): Promise<AnchorPairingResult> {
  if (input.chain.root !== input.signing.root) return { ok: false, reason: 'chain-root-mismatch' }
  if (input.opp === input.signing.root) return { ok: false, reason: 'self-pairing' }
  let payload: PairingPayload
  try {
    // The trusted build path (throws on structural misuse; the fold's
    // silent-ignore rule handles untrusted material at read time).
    payload = makePairingPayload({ game: input.game, opp: input.opp, kind: input.kind, tc: input.tc, atWts: input.atWts })
  } catch {
    return { ok: false, reason: 'bad-pairing-terms' }
  }
  const appendRes = await clientAppendWitnessed({
    fabric: input.fabric,
    chain: input.chain,
    lease: input.lease,
    deviceKey: input.signing.key,
    devicePriv: input.signing.priv,
    type: 'pairing',
    // PairingPayload → the transport's CanonicalObject seam (cjson-v1 at runtime;
    // clientAppendWitnessed re-validates the payload schema on append).
    payload: payload as unknown as CanonicalObject,
    ts: input.ts ?? input.atWts,
    epoch: input.epoch,
    witnessSet: input.witnessSet,
    players: input.players,
  })
  if (!appendRes.ok) return { ok: false, reason: appendRes.reason }
  if (input.saveChain) await input.saveChain(appendRes.chain.root, appendRes.chain)
  return { ok: true, chain: appendRes.chain, event: appendRes.event, payload }
}

export interface PairingTerms {
  /** The host-minted global game key. */
  game: B64u
  /** Both players' roots by color. */
  players: { w: B64u; b: B64u }
  /** Ladder binding (§6). */
  kind: string
  tc: { baseMs: number; incMs: number }
  /** The pairing-legality witnessed timestamp (§7/A4-16). */
  atWts: number
}

/**
 * The two per-color PairingPayloads the WitnessCore pairing gate cross-checks
 * (witnessCore.ts pairingGateError): each names THIS game key + ladder binding
 * and (cross-wise) the OTHER player's root as `opp` (white pairs against black
 * and vice versa, which also pins each payload to a distinct chain). Deterministic
 * from the match terms the witness already holds, so the witness reconstructs the
 * anchors it will enforce rather than trusting a blind flag, the M2 form of
 * `WitnessGameInit.pairing`, replacing M1's 'embedder-verified'.
 */
export function pairingAnchorsFor(t: PairingTerms): { w: PairingPayload; b: PairingPayload } {
  return {
    w: makePairingPayload({ game: t.game, opp: t.players.b, kind: t.kind, tc: t.tc, atWts: t.atWts }),
    b: makePairingPayload({ game: t.game, opp: t.players.w, kind: t.kind, tc: t.tc, atWts: t.atWts }),
  }
}

export interface VerifyPairingExpect {
  /** The game key the pairing must commit to. */
  game: B64u
  kind: string
  tc: { baseMs: number; incMs: number }
  /** The chain owner root (the pairing lives in THIS player's chain). */
  self: B64u
  /** The counterparty root the pairing must name as `opp`. */
  opp: B64u
}

/**
 * Cross-check a REAL anchored pairing event against the game terms, fail-closed on
 * any malformation (never throws): a self-signed witnessed 'pairing' event OF
 * `self`, carrying ≥1 valid non-attestation-bound... Precisely: a valid event
 * signature, ≥1 WitnessAttestation binding to it (it was actually witnessed), and
 * a payload naming exactly this game / ladder binding / opponent. This is what the
 * embedder (witnessController) runs to assert 'embedder-verified' against the real
 * chain events; the FULL chain-context validity (lease threshold, non-player
 * attester) is verifyChain's / the reconstruction layer's job downstream.
 */
export function verifyPairingEvent(event: unknown, expect: VerifyPairingExpect): event is SignedEvent {
  try {
    const ev = event as SignedEvent
    if (!ev || typeof ev !== 'object' || !ev.body) return false
    if (ev.body.lane !== 'w' || ev.body.type !== 'pairing') return false
    if (ev.body.root !== expect.self) return false
    if (!verifyEventSig(ev)) return false
    const res = zPairingPayload.safeParse(ev.body.payload)
    if (!res.success) return false
    const p = res.data
    if (p.game !== expect.game || p.opp !== expect.opp || p.kind !== expect.kind) return false
    if (p.tc.baseMs !== expect.tc.baseMs || p.tc.incMs !== expect.tc.incMs) return false
    const id = eventId(ev.body)
    const attested = (ev.wit ?? []).some((a) => verifyAttestation(a, id))
    return attested
  } catch {
    return false
  }
}

/** Extract the PairingPayload from a verified anchored pairing event (for the
 *  witness's `{ w, b }` gate input, when the embedder holds the real events). */
export function pairingPayloadOf(event: SignedEvent): PairingPayload | null {
  const res = zPairingPayload.safeParse(event.body.payload)
  return res.success ? (res.data as unknown as PairingPayload) : null
}
