// A6 M2 Lane L-mm: OVERLAY-BACKED MATCHMAKING (spec §7 pairing, §4 witness
// fabric / C-10 honest degradation, §3 pairing anchor).
//
// This is the piece that lets ANY TWO STRANGERS get auto-paired for a rated
// game (no manual room code) with a witness assigned from the canonical
// eligible set, exactly as the §1 acceptance test requires. It COMPOSES the
// tested substrate and reimplements none of it:
//
//   pairingLegal (mm/pairing.ts):          both-client legality over public
//                                          PairViews (symmetric, atWts-pinned)
//   canonicalWitnessSet (eligibility.ts): the wN-closest ELIGIBLE live nodes
//                                          for a game, with the §4 small-pop
//                                          relaxation + the anti-sock-puppet
//                                          gates that never relax
//   makePairingPayload (conduct.ts):       the §3/§8 pairing record BOTH chains
//                                          anchor (built here as the handoff
//                                          terms; the witnessed 'pairing' event
//                                          is the L-lease lane's promotion)
//
// SHAPE OF THE LIVENESS. Every signed-in client already announces a SIGNED
// presence into the account fabric and hosts an overlay node (peerService.ts).
// Matchmaking layers a small SIGNED-GOSSIP POOL keyed by (kind, ladder) on top:
//   • a SEEK is a signed advertisement, "I want a rated <ladder> game, here is
//     my public PairView". The exact both-client-verifiable input pairingLegal
//     consumes (§7: T, width, brackets are all publicly recomputable);
//   • every peer folds the SAME shared pool snapshot through the SAME
//     deterministic matching, so each reads off its own legal partner with NO
//     coordinator and NO back-and-forth handshake (a distributed skew is healed
//     by the host's signed OFFER, which the guest re-verifies before joining);
//   • the WITNESS is drawn from the canonical set over the peer's REAL fabric
//     directory (a third presence-announced peer that is neither player), so
//     with no third machine online, canonicalWitnessSet returns EMPTY and the
//     rated flow HONESTLY WAITS ("waiting for a witness"), never a fake pairing
//     (§4 C-10). Casual/link play is entirely unaffected. This module is only
//     ever entered for a rated search between two signed-in accounts.
//
// PLATFORM-SPECIFIC + renderer-hosted (it drives a live pool transport + the
// live account fabric); `src/shared/accounts` stays pure. The CORE below imports
// ONLY @shared and takes its transports + clock INJECTED, so the whole pairing /
// witness-assignment engine folds headless over a MockFabric multi-peer harness
// (scripts/test-accounts-matchmaking.mjs) exactly as it runs in the browser. The
// trystero pool adapter + the React status store are separated below the core so
// the headless bundle marks `trystero`/`react` external and never loads them.

import { useSyncExternalStore } from 'react'
import { joinRoom } from 'trystero'
import { canonicalBytes, type CanonicalObject } from '@shared/accounts/codec'
import { ed25519, sha256, toB64u, utf8, verifySigB64u } from '@shared/accounts/hash'
import {
  PARAMS_A2,
  canonicalWitnessSet,
  liveNodesOf,
  nodeIdOf,
  type ChainSummary,
  type EligibilityParams,
  type FabricEndpoint,
  type NodeDirectory,
  type NodeId,
  type SubjectSummary,
} from '@shared/accounts/witness'
import { pairingLegal, type PairView } from '@shared/accounts/mm/pairing'
import { makePairingPayload } from '@shared/accounts/ratings/conduct'
import type { B64u, PairingPayload } from '@shared/accounts/types'
import { FABRIC_APP_ID } from './browserFabric'
import { resolveIceServers } from './iceConfig'
import { resolveNostrRelays } from './relayConfig'
import { getAccountPeer } from './peerService'

// ===========================================================================
// §0  Ladders + canonical time controls
// ===========================================================================

/** The four shipped rated categories (twin of the renderer LadderKey + the
 *  shared RatedCategory). Unlimited carries no clock ⇒ no ladder (§6). */
export type LadderKey = 'Bullet' | 'Blitz' | 'Rapid' | 'Classical'

export const MM_LADDERS: readonly LadderKey[] = ['Bullet', 'Blitz', 'Rapid', 'Classical']

/** The game-kind registry string every chess ladder folds under (derive.ts
 *  GAME_KIND). ladderId = `${GAME_KIND}:${LadderKey}` (ladders.ts ladderId). */
export const MM_KIND = 'chess'

/** ladderId for a ladder key. The mm/pairing PairView.ladderId + fold key. */
export function ladderIdOf(key: LadderKey): string {
  return `${MM_KIND}:${key}`
}

export interface TimeControlMs {
  baseMs: number
  incMs: number
}

/**
 * A representative time control per ladder: each lands squarely inside its
 * category under ladders.ts timeCategory (estMs = baseMs + 40·incMs vs the
 * PARAMS_A4 rails 179s/480s/1500s): Bullet 1+0 (60s), Blitz 3+2 (260s), Rapid
 * 10+5 (800s), Classical 30+0 (1800s). These match the renderer TIME_CONTROLS
 * presets, so a matchmade game categorizes identically on every surface.
 */
export const MM_DEFAULT_TC: Record<LadderKey, TimeControlMs> = {
  Bullet: { baseMs: 60_000, incMs: 0 },
  Blitz: { baseMs: 180_000, incMs: 2_000 },
  Rapid: { baseMs: 600_000, incMs: 5_000 },
  Classical: { baseMs: 1_800_000, incMs: 0 },
}

// ===========================================================================
// §1  The signed pool messages (advertise / subscribe)
// ===========================================================================

/** A seeker's advertisement into the (kind, ladder) pool. `view` is the EXACT
 *  mm/pairing PairView the counterparty runs pairingLegal against. Public,
 *  recomputable state, signed by the seeker's certified device key so a peer
 *  cannot spoof a stranger's rating/trust into the pool. */
export interface MatchSeekBody {
  v: 1
  t: 'mm-seek'
  kind: string
  ladderId: string
  ladderKey: LadderKey
  /** Seeker account root. */
  root: B64u
  /** Seeker device signing key: what `sig` verifies against (certified under
   *  `root` in the seeker's chain; a fact the pairing record's verifiers judge,
   *  not this ephemeral ad). */
  key: B64u
  /** The public pairing inputs. `view.root` MUST equal `root`, `view.ladderId`
   *  MUST equal `ladderId` (checked on ingest). */
  view: PairView
  /** The time control this seek plays at (the ladder default, or a caller pick
   *  that still categorizes into `ladderKey`). */
  tc: TimeControlMs
  /** Monotonic per-seeker search counter. Freshest (epoch, ts) wins per root. */
  epoch: number
  /** Seeker clock (unix ms): bounds staleness; feeds the pinned atWts. */
  ts: number
}

/** The host's signed OFFER, published once it has opened the game room: the
 *  authoritative rendezvous the guest joins and the witness attaches to. It
 *  re-carries both PairViews + the pinned atWts so the guest AND the assigned
 *  witness independently re-verify pairingLegal before acting. */
export interface MatchOfferBody {
  v: 1
  t: 'mm-offer'
  kind: string
  ladderId: string
  ladderKey: LadderKey
  /** The signer device key (= hostKey): what `sig` verifies against, carried
   *  uniformly with the seek so verifyMatchMsg reads one `key` field. */
  key: B64u
  /** The mp room code the host opened (host-minted; carried here to all three). */
  code: string
  host: B64u
  hostKey: B64u
  hostView: PairView
  guest: B64u
  guestKey: B64u
  guestView: PairView
  tc: TimeControlMs
  /** The pairing-legality atWts BOTH sides evaluated at (max of the two seek
   *  ts): the §7/A4-16 pinned instant the 'pairing' record will also carry. */
  atWts: number
  ts: number
}

export type MatchMsgBody = MatchSeekBody | MatchOfferBody

export interface SignedMatchMsg {
  body: MatchMsgBody
  /** ed25519 by the seeker/host device key over canonicalBytes(body). */
  sig: B64u
}

/** The exact bytes a pool message signs. One place so sign + verify agree. A
 *  CanonicalObject at runtime (cjson-v1); declared as a plain interface because
 *  it nests PairView/TimeControlMs, so canonicalBytes casts at the seam exactly
 *  like preGame.ts's snapshotBytes / segment.ts's makeWitnessedResult. */
function msgBytes(body: MatchMsgBody): Uint8Array {
  return canonicalBytes(body as unknown as CanonicalObject)
}

/** Sign a seek body with the seeker's device private key. */
export function signSeek(body: MatchSeekBody, devicePriv: Uint8Array): SignedMatchMsg {
  return { body, sig: toB64u(ed25519.sign(msgBytes(body), devicePriv)) }
}

/** Sign an offer body with the host's device private key. */
export function signOffer(body: MatchOfferBody, devicePriv: Uint8Array): SignedMatchMsg {
  return { body, sig: toB64u(ed25519.sign(msgBytes(body), devicePriv)) }
}

/** True iff `pv` is a structurally-complete PairView bound to (root, ladderId).
 *  The both-client pairing input, never trusted beyond these shape facts. */
function pairViewOk(pv: unknown, root: B64u, ladderId: string): pv is PairView {
  if (pv === null || typeof pv !== 'object') return false
  const v = pv as Partial<PairView>
  if (v.root !== root || v.ladderId !== ladderId) return false
  if (typeof v.ratingMicro !== 'number' || typeof v.rdMicro !== 'number' || typeof v.tMicro !== 'number')
    return false
  const d = v.display as { state?: unknown } | undefined
  if (!d || typeof d.state !== 'string') return false
  return true
}

/**
 * Verify a pool message end to end, fail-closed on ANY malformation (never
 * throws): the discriminant, the device-key signature over the body, and. For
 * a seek: that its PairView is bound to the advertised (root, ladderId). This
 * establishes PROVENANCE only (that `key` signed it); whether `key` is certified
 * under `root`, and whether the account is banned/fuse-tripped, are chain facts
 * the read-time pairing verifiers establish, never this ephemeral ad.
 */
export function verifyMatchMsg(msg: unknown): msg is SignedMatchMsg {
  if (msg === null || typeof msg !== 'object') return false
  const m = msg as { body?: unknown; sig?: unknown }
  if (typeof m.sig !== 'string' || m.body === null || typeof m.body !== 'object') return false
  const body = m.body as Partial<MatchMsgBody> & { t?: unknown; key?: unknown }
  if (body.v !== 1) return false
  if (typeof body.key !== 'string') return false
  let bytes: Uint8Array
  try {
    bytes = msgBytes(m.body as MatchMsgBody)
  } catch {
    return false
  }
  if (!verifySigB64u(m.sig, bytes, body.key)) return false
  if (body.t === 'mm-seek') {
    const b = m.body as MatchSeekBody
    if (typeof b.root !== 'string' || typeof b.ladderId !== 'string') return false
    // The seek is device-signed: its `key` must be the seeker's advertised
    // device key (`b.key === body.key`, already signature-checked above) and the
    // PairView must be bound to the advertised (root, ladderId).
    return pairViewOk(b.view, b.root, b.ladderId)
  }
  if (body.t === 'mm-offer') {
    const b = m.body as MatchOfferBody
    if (typeof b.code !== 'string' || typeof b.host !== 'string' || typeof b.guest !== 'string') return false
    // The offer is host-signed: its key must be the advertised host device key.
    if (b.key !== b.hostKey) return false
    return pairViewOk(b.hostView, b.host, b.ladderId) && pairViewOk(b.guestView, b.guest, b.ladderId)
  }
  return false
}

// ===========================================================================
// §2  The pool transport seam (advertise / subscribe)
// ===========================================================================

/**
 * A signed-gossip pool for ONE (kind, ladder): every member sees every live
 * message, freshest-per-(root, type). This is the "advertise/subscribe" seam:
 * production rides a dedicated trystero pool room over the account fabric app id
 * (createTrysteroMatchPool); the headless harness rides a shared in-memory hub
 * (createMemoryMatchPool). The CORE engine depends ONLY on this interface, so it
 * is transport-agnostic and unit-testable with no relay.
 */
export interface MatchPool {
  /** Broadcast OUR signed message; replaces our previous of the same type. */
  publish(msg: SignedMatchMsg): void
  /** Every live message in the pool (verified, freshest-per-(root, type)). */
  list(): SignedMatchMsg[]
  /** Withdraw OUR advertisements (leaving the pool / cancel search). */
  retract(root: B64u): void
  /** Notify on any pool change (production drives the poll loop from this). */
  subscribe(cb: () => void): () => void
  /** Leave the pool room / tear down. */
  close(): void
}

/** Freshest-per-(root, type) collapse: a later (epoch, ts) supersedes. Used by
 *  every pool adapter so the engine always folds a de-duplicated snapshot. */
export function freshestByRootType(msgs: readonly SignedMatchMsg[]): SignedMatchMsg[] {
  const best = new Map<string, SignedMatchMsg>()
  for (const m of msgs) {
    const b = m.body
    const root = b.t === 'mm-seek' ? b.root : b.host
    const k = `${b.t}|${root}`
    const prev = best.get(k)
    if (!prev) {
      best.set(k, m)
      continue
    }
    const pe = prev.body.t === 'mm-seek' ? (prev.body as MatchSeekBody).epoch : 0
    const me = b.t === 'mm-seek' ? (b as MatchSeekBody).epoch : 0
    if (me > pe || (me === pe && b.ts >= prev.body.ts)) best.set(k, m)
  }
  return [...best.values()]
}

// ===========================================================================
// §3  Pairing math: deterministic legal matching over a pool snapshot
// ===========================================================================

/** A verified seek projected to what the matching needs. */
interface SeekRow {
  root: B64u
  key: B64u
  view: PairView
  ladderKey: LadderKey
  tc: TimeControlMs
  ts: number
}

/** Canonical lower/upper of two roots (stable string order). Decides host. */
function orderRoots(a: B64u, b: B64u): { host: B64u; guest: B64u } {
  return a < b ? { host: a, guest: b } : { host: b, guest: a }
}

/** A deterministic, both-client-identical key for an unordered pair. The
 *  matching sort order (SHA-256 hex of the canonical pair descriptor). */
function pairKey(kind: string, ladderId: string, a: B64u, b: B64u): string {
  const { host, guest } = orderRoots(a, b)
  return toB64u(sha256(utf8(`mm-pair:${kind}:${ladderId}:${host}:${guest}`)))
}

/** The pinned pairing-legality instant for two seeks: the later of the two
 *  advertised clocks (both peers derive it identically from the signed seeks;
 *  the same atWts the offer carries and the 'pairing' record anchors). */
export function pairAtWts(a: { ts: number }, b: { ts: number }): number {
  return Math.max(a.ts, b.ts)
}

export interface MatchmakingConfig {
  /** Eligibility floors for canonicalWitnessSet (default PARAMS_A2). */
  params?: EligibilityParams
  /** Seeks older than this (relative to `now`) are treated as withdrawn.
   *  Default 45_000 ms (well over a presence heartbeat). */
  maxSeekAgeMs?: number
}

const DEFAULT_MAX_SEEK_AGE_MS = 45_000

/**
 * Fold a pool snapshot for ONE (kind, ladder) into the deterministic legal
 * matching: every peer that runs this over the same snapshot reads off the same
 * partner for its own root, with no coordinator. Legal pairs (pairingLegal at
 * the pinned atWts) are sorted by their canonical pair key and greedily matched,
 * so the assignment is stable and identical across clients.
 *
 * Returns `partnerOf`: root → the root it is matched with (absent = unmatched).
 */
export function computeMatching(
  seeks: readonly SignedMatchMsg[],
  kind: string,
  ladderId: string,
  nowMs: number,
  cfg: MatchmakingConfig = {},
): Map<B64u, B64u> {
  const maxAge = cfg.maxSeekAgeMs ?? DEFAULT_MAX_SEEK_AGE_MS
  const rows: SeekRow[] = []
  for (const m of freshestByRootType(seeks)) {
    if (m.body.t !== 'mm-seek') continue
    const b = m.body
    if (b.kind !== kind || b.ladderId !== ladderId) continue
    if (nowMs - b.ts > maxAge) continue // withdrawn / stale
    rows.push({ root: b.root, key: b.key, view: b.view, ladderKey: b.ladderKey, tc: b.tc, ts: b.ts })
  }

  interface Cand {
    a: SeekRow
    b: SeekRow
    key: string
  }
  const legal: Cand[] = []
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]
      const b = rows[j]
      const atWts = pairAtWts(a, b)
      if (!pairingLegal(a.view, b.view, atWts).legal) continue
      legal.push({ a, b, key: pairKey(kind, ladderId, a.root, b.root) })
    }
  }
  legal.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))

  const partnerOf = new Map<B64u, B64u>()
  const taken = new Set<B64u>()
  for (const c of legal) {
    if (taken.has(c.a.root) || taken.has(c.b.root)) continue
    taken.add(c.a.root)
    taken.add(c.b.root)
    partnerOf.set(c.a.root, c.b.root)
    partnerOf.set(c.b.root, c.a.root)
  }
  return partnerOf
}

// ===========================================================================
// §4  Witness assignment: the canonical eligible set over the live directory
// ===========================================================================

/** A 32-byte nodeId-shaped ranking anchor for a game (deterministic from the
 *  pairing), so every observer ranks candidate witnesses by the SAME distance. */
export function pairWitnessAnchor(kind: string, ladderId: string, host: B64u, guest: B64u): NodeId {
  const o = orderRoots(host, guest)
  return toB64u(sha256(utf8(`mm-witness:${kind}:${ladderId}:${o.host}:${o.guest}`)))
}

/**
 * The canonical witness set for a game between (host, guest): the wN-closest
 * ELIGIBLE live nodes to the game anchor that are NEITHER player, over the live
 * fabric directory. It is the REAL substrate (canonicalWitnessSet) driven with
 * a synthetic subject whose entangled set is {host, guest}, so BOTH players are
 * excluded by the structural (never-relaxing) entanglement gate, `self` is a
 * sentinel, and the small-population relaxation admits an untrusted third
 * machine at tiny scale (§4). EMPTY ⇒ no eligible witness ⇒ the rated flow
 * honestly waits (C-10). Every observer computes the same ranked list from its
 * own directory; the top entry is the assigned witness.
 */
export function assignWitnesses(
  directory: NodeDirectory,
  host: B64u,
  guest: B64u,
  kind: string,
  ladderId: string,
  nowMs: number,
  cfg: MatchmakingConfig = {},
): NodeId[] {
  const params = cfg.params ?? PARAMS_A2
  const anchor = pairWitnessAnchor(kind, ladderId, host, guest)
  const subject: SubjectSummary = {
    // A sentinel root that is not any real account (the `self` gate only ever
    // matters for a candidate whose root equals it. None does). The ranking is
    // by anchor distance; entangledRoots excludes both players unconditionally.
    root: `mm-anchor:${anchor}`,
    nodeId: anchor,
    entangledRoots: new Set<string>([host, guest]),
    secondDegreeRoots: new Set<string>(),
  }
  const summaries: ReadonlyMap<NodeId, ChainSummary> = new Map()
  return canonicalWitnessSet(subject, directory, summaries, params, nowMs)
}

/**
 * How many DISTINCT third machines could witness a game for `selfRoot` right
 * now: the honest network status the rated lobby renders (§4). A witness must
 * advertise the witness cap and be neither `selfRoot` nor `oppRoot` (when an
 * opponent is known). Counts the live directory directly (liveNodesOf), NOT a
 * fixture. Zero ⇒ "no witness reachable: rated play waits".
 */
export function countReachableWitnesses(
  directory: NodeDirectory,
  selfRoot: B64u,
  nowMs: number,
  oppRoot?: B64u,
): number {
  let n = 0
  for (const sp of liveNodesOf(directory, nowMs)) {
    if (!sp.body.caps.witness) continue
    if (sp.body.root === selfRoot) continue
    if (oppRoot !== undefined && sp.body.root === oppRoot) continue
    n++
  }
  return n
}

// ===========================================================================
// §5  The pairing handoff terms (makePairingPayload for all three)
// ===========================================================================

/** Everything the game handoff needs, derived deterministically from a struck
 *  match. The host opens `code`; the guest joins it pinned to `oppRoot`; the
 *  witness attaches. All three re-derive the SAME PairingPayloads from this +
 *  the host-minted gameKey (makePairingTerms). */
export interface MatchAssignment {
  kind: string
  ladderKey: LadderKey
  ladderId: string
  tc: TimeControlMs
  atWts: number
  /** Room rendezvous (host-minted, once known). */
  code: string
  role: 'host' | 'guest'
  self: { root: B64u; key: B64u }
  opponent: { root: B64u; key: B64u }
  /** Our color: the host plays white, the guest black (mp seats host = white). */
  color: 'w' | 'b'
  /** Both public pairing views (for a fresh both-client pairingLegal re-check). */
  hostView: PairView
  guestView: PairView
}

/**
 * Build the two per-color §3/§8 PairingPayloads BOTH chains anchor for a game,
 * from the assignment + the host-minted gameKey: the WitnessRunnerGameInit
 * `pairing:{w,b}` the M2 witness gate consumes (witnessCore.ts). Reuses the
 * tested makePairingPayload; the caller supplies the real gameKey once the mp
 * host mints it (leaseRunner promotes these into the witnessed 'pairing' event).
 */
export function makePairingTerms(a: MatchAssignment, gameKey: B64u): { w: PairingPayload; b: PairingPayload } {
  const { host, guest } = orderRoots(a.self.root, a.opponent.root)
  const white = makePairingPayload({ game: gameKey, opp: guest, kind: a.kind, tc: a.tc, atWts: a.atWts })
  const black = makePairingPayload({ game: gameKey, opp: host, kind: a.kind, tc: a.tc, atWts: a.atWts })
  return { w: white, b: black }
}

// ===========================================================================
// §6  The matchmaking engine (poll loop: headless-testable)
// ===========================================================================

/** The signed-in device identity the engine runs as (Lane C deviceSigningKey). */
export interface MatchmakingIdentity {
  root: B64u
  key: B64u
  priv: Uint8Array
}

/** The engine's search target + the current public pairing view for it. */
export interface SeekTarget {
  ladderKey: LadderKey
  tc: TimeControlMs
  /** OUR public PairView for this ladder (pairViewOf over the live fold). */
  view: PairView
}

export type EnginePhase =
  | 'idle'
  | 'searching' // in the pool, no legal partner yet
  | 'waiting-witness' // a legal partner exists, but no third machine can witness (C-10)
  | 'paired' // matched + witness available; the game handoff is underway

export interface EngineStatus {
  phase: EnginePhase
  ladderKey: LadderKey | null
  /** Distinct third machines that could witness right now (§4). */
  witnessesReachable: number
  /** The matched opponent root, once a legal partner is found. */
  opponentRoot: B64u | null
  /** The assignment once a game room is struck (host) or accepted (guest). */
  assignment: MatchAssignment | null
}

export interface MatchmakingEngineDeps {
  identity: MatchmakingIdentity
  /** The live account fabric. Its directory() is the witness candidate set. */
  fabric: FabricEndpoint
  /** The (kind, ladder) pool transport. */
  pool: MatchPool
  /** OUR current search target + PairView, or null when only witnessing. */
  target: () => SeekTarget | null
  /** Wall clock (unix ms). */
  now: () => number
  cfg?: MatchmakingConfig
  /** HOST side: open the mp game room (rated) and return its code (null =
   *  failed / not yet wired). The lead wires this to onlineStore.host. */
  openRoom?: (a: MatchAssignment) => Promise<string | null>
  /** GUEST side: join the host's room pinned to the opponent root. Wired to
   *  onlineStore.join(code,{rated,oppRoot}). */
  joinRoom?: (a: MatchAssignment) => void
  /** WITNESS side: attach to a game we were assigned to witness. Wired to
   *  witnessController.start(code, gameInit). */
  startWitness?: (a: WitnessAssignment) => void
  /** Status change sink (drives the UI store). */
  onStatus?: (s: EngineStatus) => void
  log?: (msg: string) => void
}

/** What the assigned witness needs to attach to a matchmade game (mirrors
 *  witnessRunner.WitnessRunnerGameInit's participant + ladder binding). */
export interface WitnessAssignment {
  code: string
  kind: string
  ladderKey: LadderKey
  ladderId: string
  tc: TimeControlMs
  atWts: number
  /** Both players' {root, device key}: the witness resolves move-sig keys and
   *  can re-derive the pairing terms (makePairingTerms) from these. */
  participants: { root: B64u; key: B64u }[]
  host: B64u
  guest: B64u
  hostView: PairView
  guestView: PairView
}

export interface MatchmakingEngine {
  /** Run ONE matchmaking round: (re)advertise our seek, fold the pool, act on
   *  our role (host opens + offers, guest joins an offer, witness self-attaches).
   *  Production drives this from pool.subscribe + a heartbeat; the harness calls
   *  it explicitly for determinism. Idempotent per struck game. */
  poll(): Promise<void>
  /** Current status snapshot. */
  status(): EngineStatus
  /** Withdraw our seek + stop. */
  stop(): void
}

/**
 * Create a matchmaking engine over an injected pool + fabric. Transport-agnostic
 * and clock-injected: the harness wires MockFabric + a memory pool + mock room
 * callbacks; production wires the live account fabric + a trystero pool + the
 * onlineStore/witnessController handoffs.
 */
export function createMatchmakingEngine(deps: MatchmakingEngineDeps): MatchmakingEngine {
  const log = deps.log ?? ((): void => {})
  const cfg = deps.cfg ?? {}
  const selfRoot = deps.identity.root

  let stopped = false
  let epoch = 0
  /** Games we have already acted on (opened / joined / started-witnessing),
   *  keyed by a stable identifier, so a repeated poll never double-fires. */
  const openedHost = new Set<string>() // pairKey we've hosted
  const joinedGuest = new Set<string>() // offer codes we've joined
  const witnessing = new Set<string>() // offer codes we're witnessing

  let status: EngineStatus = {
    phase: 'idle',
    ladderKey: null,
    witnessesReachable: 0,
    opponentRoot: null,
    assignment: null,
  }
  const emit = (patch: Partial<EngineStatus>): void => {
    status = { ...status, ...patch }
    deps.onStatus?.(status)
  }

  const currentSeek = (target: SeekTarget, nowMs: number): SignedMatchMsg => {
    const body: MatchSeekBody = {
      v: 1,
      t: 'mm-seek',
      kind: MM_KIND,
      ladderId: ladderIdOf(target.ladderKey),
      ladderKey: target.ladderKey,
      root: deps.identity.root,
      key: deps.identity.key,
      view: target.view,
      tc: target.tc,
      epoch,
      ts: nowMs,
    }
    return signSeek(body, deps.identity.priv)
  }

  /** WITNESS role: for every offer we are neither player of, self-select over
   *  our own directory and attach if we are the canonical top pick. */
  const runWitnessRole = (msgs: SignedMatchMsg[], nowMs: number): void => {
    if (!deps.startWitness) return
    const directory = deps.fabric.directory()
    const selfNode = nodeIdOf(selfRoot)
    for (const m of msgs) {
      if (m.body.t !== 'mm-offer') continue
      const o = m.body
      if (o.host === selfRoot || o.guest === selfRoot) continue // we're a player
      if (witnessing.has(o.code)) continue
      // Re-verify legality before lending our attestation to this pairing.
      if (!pairingLegal(o.hostView, o.guestView, o.atWts).legal) continue
      const set = assignWitnesses(directory, o.host, o.guest, o.kind, o.ladderId, nowMs, cfg)
      if (set.length === 0 || set[0] !== selfNode) continue // not the top pick
      witnessing.add(o.code)
      log(`witness self-assign for room ${o.code} (host ${o.host.slice(0, 8)}…)`)
      deps.startWitness({
        code: o.code,
        kind: o.kind,
        ladderKey: o.ladderKey,
        ladderId: o.ladderId,
        tc: o.tc,
        atWts: o.atWts,
        participants: [
          { root: o.host, key: o.hostKey },
          { root: o.guest, key: o.guestKey },
        ],
        host: o.host,
        guest: o.guest,
        hostView: o.hostView,
        guestView: o.guestView,
      })
    }
  }

  const poll = async (): Promise<void> => {
    if (stopped) return
    const nowMs = deps.now()
    const target = deps.target()

    // Advertise our seek (re-sign each round so ts stays fresh under staleness).
    if (target) {
      epoch += 1
      deps.pool.publish(currentSeek(target, nowMs))
    }

    const msgs = deps.pool.list().filter(verifyMatchMsg)

    // The witness role runs regardless of whether we are searching.
    runWitnessRole(msgs, nowMs)

    if (!target) {
      emit({ phase: 'idle', ladderKey: null, opponentRoot: null, assignment: null })
      return
    }

    const ladderId = ladderIdOf(target.ladderKey)
    // Live third-machine count for the lobby. Once we know the MATCHED OPPONENT,
    // EXCLUDE it: a peer we are pairing WITH can never witness that same game
    // (§4: the canonical set structurally drops both players), so counting it
    // would overstate the honest availability. No opponent yet ⇒ count them all.
    const dir = deps.fabric.directory()
    const witnessCount = (opp?: B64u): number => countReachableWitnesses(dir, selfRoot, nowMs, opp)

    // GUEST role first: if a valid offer names us, accept it (the host's signed
    // offer is authoritative. We re-verify legality, never a blind join).
    for (const m of msgs) {
      if (m.body.t !== 'mm-offer') continue
      const o = m.body
      if (o.guest !== selfRoot) continue
      if (joinedGuest.has(o.code)) continue
      if (o.ladderId !== ladderId) continue
      if (!pairingLegal(o.hostView, o.guestView, o.atWts).legal) continue
      joinedGuest.add(o.code)
      const assignment = offerToAssignment(o, 'guest', deps.identity)
      emit({ phase: 'paired', ladderKey: target.ladderKey, witnessesReachable: witnessCount(o.host), opponentRoot: o.host, assignment })
      log(`accepted offer for room ${o.code} as guest vs ${o.host.slice(0, 8)}…`)
      deps.joinRoom?.(assignment)
      return
    }

    // HOST / discovery role: fold the pool into the deterministic matching.
    const partnerOf = computeMatching(msgs, MM_KIND, ladderId, nowMs, cfg)
    const partner = partnerOf.get(selfRoot)
    if (!partner) {
      emit({ phase: 'searching', ladderKey: target.ladderKey, witnessesReachable: witnessCount(), opponentRoot: null, assignment: null })
      return
    }

    // A legal partner exists. Is a third machine available to witness it?
    const witnessSet = assignWitnesses(dir, selfRoot, partner, MM_KIND, ladderId, nowMs, cfg)
    if (witnessSet.length === 0) {
      // C-10 honest degradation: never a fake pairing without a witness.
      emit({ phase: 'waiting-witness', ladderKey: target.ladderKey, witnessesReachable: witnessCount(partner), opponentRoot: partner, assignment: null })
      return
    }

    const { host } = orderRoots(selfRoot, partner)
    if (host !== selfRoot) {
      // We are the GUEST for this pairing: wait for the host's signed offer
      // (handled above once it lands). Reflect the pending pairing honestly.
      emit({ phase: 'paired', ladderKey: target.ladderKey, witnessesReachable: witnessCount(partner), opponentRoot: partner, assignment: status.assignment })
      return
    }

    // We are the HOST: open the room once, then publish the offer.
    const pk = pairKey(MM_KIND, ladderId, selfRoot, partner)
    if (openedHost.has(pk)) {
      emit({ phase: 'paired', ladderKey: target.ladderKey, witnessesReachable: witnessCount(partner), opponentRoot: partner })
      return
    }
    const partnerSeek = seekOf(msgs, partner, ladderId)
    if (!partnerSeek) {
      emit({ phase: 'searching', ladderKey: target.ladderKey, witnessesReachable: witnessCount(), opponentRoot: null })
      return
    }
    const atWts = pairAtWts({ ts: nowMs }, { ts: partnerSeek.body.ts })
    openedHost.add(pk)
    const provisional = hostAssignment(target, partnerSeek, deps.identity, atWts, '')
    let code: string | null = null
    try {
      code = deps.openRoom ? await deps.openRoom(provisional) : null
    } catch (err) {
      log(`openRoom failed: ${String(err)}`)
      openedHost.delete(pk) // allow a later retry
    }
    if (!code) {
      // Handoff not wired / room open failed: reflect the struck-but-unstarted
      // match honestly (opponent + witness found), never a dead spinner.
      emit({ phase: 'paired', ladderKey: target.ladderKey, witnessesReachable: witnessCount(partner), opponentRoot: partner, assignment: { ...provisional, code: '' } })
      return
    }
    const assignment: MatchAssignment = { ...provisional, code }
    const offer = buildOffer(assignment, partnerSeek.body as MatchSeekBody, target, atWts, nowMs)
    deps.pool.publish(signOffer(offer, deps.identity.priv))
    emit({ phase: 'paired', ladderKey: target.ladderKey, witnessesReachable: witnessCount(partner), opponentRoot: partner, assignment })
    log(`hosting room ${code} for ${partner.slice(0, 8)}…: offer published`)
  }

  return {
    poll,
    status: () => status,
    stop: () => {
      if (stopped) return
      stopped = true
      deps.pool.retract(selfRoot)
    },
  }
}

// --- engine helpers --------------------------------------------------------

function seekOf(msgs: readonly SignedMatchMsg[], root: B64u, ladderId: string): SignedMatchMsg | null {
  const fresh = freshestByRootType(msgs)
  for (const m of fresh)
    if (m.body.t === 'mm-seek' && m.body.root === root && m.body.ladderId === ladderId) return m
  return null
}

function hostAssignment(
  target: SeekTarget,
  partnerSeek: SignedMatchMsg,
  self: MatchmakingIdentity,
  atWts: number,
  code: string,
): MatchAssignment {
  const b = partnerSeek.body as MatchSeekBody
  return {
    kind: MM_KIND,
    ladderKey: target.ladderKey,
    ladderId: ladderIdOf(target.ladderKey),
    tc: target.tc,
    atWts,
    code,
    role: 'host',
    self: { root: self.root, key: self.key },
    opponent: { root: b.root, key: b.key },
    color: 'w', // host = white (mp seats the host as white)
    hostView: target.view,
    guestView: b.view,
  }
}

function buildOffer(
  a: MatchAssignment,
  partnerSeek: MatchSeekBody,
  target: SeekTarget,
  atWts: number,
  nowMs: number,
): MatchOfferBody {
  return {
    v: 1,
    t: 'mm-offer',
    kind: a.kind,
    ladderId: a.ladderId,
    ladderKey: a.ladderKey,
    code: a.code,
    host: a.self.root,
    hostKey: a.self.key,
    // The offer is host-signed: `key` MUST equal hostKey (verifyMatchMsg).
    key: a.self.key,
    hostView: target.view,
    guest: a.opponent.root,
    guestKey: a.opponent.key,
    guestView: partnerSeek.view,
    tc: a.tc,
    atWts,
    ts: nowMs,
  }
}

function offerToAssignment(o: MatchOfferBody, role: 'host' | 'guest', self: MatchmakingIdentity): MatchAssignment {
  const isHost = role === 'host'
  return {
    kind: o.kind,
    ladderKey: o.ladderKey,
    ladderId: o.ladderId,
    tc: o.tc,
    atWts: o.atWts,
    code: o.code,
    role,
    self: { root: self.root, key: self.key },
    opponent: isHost ? { root: o.guest, key: o.guestKey } : { root: o.host, key: o.hostKey },
    color: isHost ? 'w' : 'b',
    hostView: o.hostView,
    guestView: o.guestView,
  }
}

// ===========================================================================
// §7  Pool adapters (in-memory hub for the harness; trystero for production)
// ===========================================================================

/** A shared in-memory pool: every MatchPool minted from one hub sees one
 *  another's messages, exactly like MockFabric's shared directory. This is the
 *  headless harness transport; it is also the honest offline fallback when no
 *  live pool room can be joined. */
export interface MatchPoolHub {
  join(): MatchPool
}

export function createMatchPoolHub(): MatchPoolHub {
  /** Freshest-per-(type|root), so growth is bounded and reads are collapsed. */
  const store = new Map<string, SignedMatchMsg>()
  // Each joined pool keeps its OWN subscriber set. A publish/retract wakes every
  // OTHER member (a REMOTE message; exactly what a live relay delivers) but
  // NEVER the originator: its own publish is a LOCAL ECHO, not a remote message.
  // Without this the live search stack-overflows. The engine subscribes poll to
  // the pool AND poll publishes a fresh (higher-epoch) seek, so a self-notify
  // re-enters poll → publish → notify → … The engine reads list() right after it
  // publishes, so suppressing the self-notify loses nothing. Mirrors the trystero
  // adapter's local-echo rule so both transports behave identically; the headless
  // harness drives poll() manually and is unaffected either way.
  const members = new Set<{ subs: Set<() => void> }>()
  const notifyOthers = (origin: { subs: Set<() => void> }): void => {
    for (const m of members) if (m !== origin) m.subs.forEach((f) => f())
  }
  const keyOf = (m: SignedMatchMsg): string => {
    const b = m.body
    return `${b.t}|${b.t === 'mm-seek' ? b.root : b.host}`
  }
  const put = (m: SignedMatchMsg): void => {
    const k = keyOf(m)
    const prev = store.get(k)
    const pe = prev && prev.body.t === 'mm-seek' ? (prev.body as MatchSeekBody).epoch : 0
    const me = m.body.t === 'mm-seek' ? (m.body as MatchSeekBody).epoch : 0
    if (!prev || me > pe || (me === pe && m.body.ts >= prev.body.ts)) store.set(k, m)
  }
  return {
    join(): MatchPool {
      let left = false
      const self = { subs: new Set<() => void>() }
      members.add(self)
      return {
        publish(m: SignedMatchMsg): void {
          if (left || !verifyMatchMsg(m)) return
          put(m)
          notifyOthers(self)
        },
        list(): SignedMatchMsg[] {
          return left ? [] : [...store.values()]
        },
        retract(root: B64u): void {
          if (left) return
          for (const [k, m] of [...store]) {
            const r = m.body.t === 'mm-seek' ? m.body.root : m.body.host
            if (r === root) store.delete(k)
          }
          notifyOthers(self)
        },
        subscribe(cb: () => void): () => void {
          self.subs.add(cb)
          return () => self.subs.delete(cb)
        },
        close(): void {
          left = true
          members.delete(self)
        },
      }
    },
  }
}

/** A single standalone in-memory pool (its own hub). A convenience for a
 *  one-process test or the offline no-op fallback. */
export function createMemoryMatchPool(): MatchPool {
  return createMatchPoolHub().join()
}

// --- trystero pool room (production) ---------------------------------------
// A dedicated trystero room per (kind, ladder) over the SAME app namespace as
// the account fabric (browserFabric FABRIC_APP_ID): the room id IS the pool
// key. Signed messages gossip to every member; each keeps freshest-per-(root,
// type). Mirrors browserFabric's room usage (native WebRTC via resolveIceServers,
// injected room for headless tests) so `trystero` stays a lazy production-only
// dependency the headless bundle marks external.

interface PoolMessageAction {
  send(data: CanonicalObject, opts?: { target?: string | string[] | null }): Promise<void> | void
}
interface PoolRoom {
  makeAction(
    ns: string,
    config: { kind?: 'message'; onMessage?: (data: unknown, ctx: { peerId: string }) => void },
  ): PoolMessageAction
  leave(): Promise<void>
}

export interface TrysteroMatchPoolOpts {
  kind: string
  ladderId: string
  /** trystero app namespace (default FABRIC_APP_ID: shares the accounts fabric
   *  family; the operator peer can join the same pool). */
  appId?: string
  password?: string
  iceServers?: readonly RTCIceServer[]
  /** Injected room: omit in production (built via joinRoom). Tests inject a
   *  fake so the gossip/dedup logic runs headless with no relay. */
  room?: PoolRoom
}

const POOL_NS = 'mm'

/** The trystero room id for a pool. The (kind, ladder) key, sanitized. */
export function poolRoomId(kind: string, ladderId: string): string {
  return `mm-${kind}-${ladderId}`.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function createTrysteroMatchPool(opts: TrysteroMatchPoolOpts): MatchPool {
  const store = new Map<string, SignedMatchMsg>()
  const subs = new Set<() => void>()
  const notify = (): void => subs.forEach((f) => f())
  const keyOf = (m: SignedMatchMsg): string =>
    `${m.body.t}|${m.body.t === 'mm-seek' ? m.body.root : m.body.host}`
  const ingest = (data: unknown, notifyOnChange: boolean): void => {
    if (!verifyMatchMsg(data)) return
    const m = data
    const k = keyOf(m)
    const prev = store.get(k)
    const pe = prev && prev.body.t === 'mm-seek' ? (prev.body as MatchSeekBody).epoch : 0
    const me = m.body.t === 'mm-seek' ? (m.body as MatchSeekBody).epoch : 0
    if (!prev || me > pe || (me === pe && m.body.ts >= prev.body.ts)) {
      store.set(k, m)
      if (notifyOnChange) notify()
    }
  }
  const room = opts.room ?? joinPoolRoom(opts)
  // A REMOTE message (delivered by the room) DOES notify. It is what drives the
  // engine's poll loop forward when a stranger advertises or offers.
  const action = room.makeAction(POOL_NS, { kind: 'message', onMessage: (d) => ingest(d, true) })
  return {
    publish(m: SignedMatchMsg): void {
      if (!verifyMatchMsg(m)) return
      // LOCAL ECHO: update our OWN store so list() reflects our seek immediately,
      // but do NOT notify subscribers. A self-publish must never re-enter the
      // poll loop (the engine subscribes poll to the pool AND poll publishes a
      // fresh seek: notifying here would recurse poll → publish → notify → …).
      // Only a REMOTE message notifies; the engine reads list() right after it
      // publishes, so nothing is lost. (This is why the boot's nonReentrantPool
      // wrapper is now redundant.)
      ingest(m, false)
      void action.send(m as unknown as CanonicalObject) // no target => broadcast
    },
    list(): SignedMatchMsg[] {
      return [...store.values()]
    },
    retract(root: B64u): void {
      // A gossip transport can't un-send; peers TIME OUT our stale seek via the
      // engine's maxSeekAgeMs bound. We drop it locally + stop re-advertising. A
      // purely LOCAL mutation (like the publish echo), so it doesn't self-notify.
      for (const [k, m] of [...store]) {
        const r = m.body.t === 'mm-seek' ? m.body.root : m.body.host
        if (r === root) store.delete(k)
      }
    },
    subscribe(cb: () => void): () => void {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    close(): void {
      void room.leave()
    },
  }
}

function joinPoolRoom(opts: TrysteroMatchPoolOpts): PoolRoom {
  const iceServers = opts.iceServers ?? resolveIceServers()
  // RELAY-SEAM: share the SAME OUR-relay selection as the account fabric (null ⇒
  // fork defaults ⇒ byte-identical to before).
  const relayConfig = resolveNostrRelays()
  const room = joinRoom(
    {
      appId: opts.appId ?? FABRIC_APP_ID,
      ...(opts.password !== undefined ? { password: opts.password } : {}),
      ...(relayConfig ? { relayConfig } : {}),
      rtcConfig: { iceServers: [...iceServers] },
    },
    poolRoomId(opts.kind, opts.ladderId),
  )
  return room as unknown as PoolRoom
}

// ===========================================================================
// §8  Renderer status store + live-search control
// ===========================================================================
// A small observable (house useSyncExternalStore pattern, like onlineStore /
// accountsUiStore) the rated lobby reads for HONEST live status: the real
// third-machine count from the account peer's fabric directory, and the live
// search phase from the engine. The game HANDOFF (open/join the mp room, attach
// the witness) is wired by the lead via configureMatchmaking. This module owns
// the pool + pairing + witness-assignment, never the mp/witness singletons.

/** The lobby-facing status (adds 'signed-out' to the engine phases). */
export interface MatchmakingUiState {
  phase: 'idle' | 'searching' | 'waiting-witness' | 'paired' | 'signed-out'
  ladderKey: LadderKey | null
  /** Whether the account peer is live (signed in + net up). */
  peerLive: boolean
  /** DISTINCT third machines that could witness right now (§4, live directory). */
  witnessesReachable: number
  /** A legal opponent has been matched. */
  opponentFound: boolean
  error: string | null
}

const IDLE_STATE: MatchmakingUiState = {
  phase: 'idle',
  ladderKey: null,
  peerLive: false,
  witnessesReachable: 0,
  opponentFound: false,
  error: null,
}

let uiState: MatchmakingUiState = IDLE_STATE
const uiListeners = new Set<() => void>()
function setUi(patch: Partial<MatchmakingUiState>): void {
  uiState = { ...uiState, ...patch }
  uiListeners.forEach((fn) => fn())
}

/** The live game-handoff seams the lead wires (accountNetBoot). Absent ⇒ the
 *  search still runs discovery + reflects honest status, but no game opens. */
export interface MatchmakingHandoff {
  /** Get the live account peer (default getAccountPeer). */
  getPeer?: () => { root: B64u; key: B64u; fabric: FabricEndpoint } | null
  /** Resolve THIS device's signing identity (default: web accounts
   *  deviceSigningKey, dynamically imported). */
  signing?: () => Promise<MatchmakingIdentity | null> | MatchmakingIdentity | null
  /** Build the pool transport for a (kind, ladder) (default: trystero room). */
  poolFactory?: (kind: string, ladderId: string) => MatchPool
  /** HOST: open the mp room (rated) → its code (onlineStore.host). */
  openRoom?: (a: MatchAssignment) => Promise<string | null>
  /** GUEST: join the room pinned to oppRoot (onlineStore.join). */
  joinRoom?: (a: MatchAssignment) => void
  /** WITNESS: attach to a matchmade game (witnessController.start). */
  startWitness?: (a: WitnessAssignment) => void
  log?: (msg: string) => void
}

let handoff: MatchmakingHandoff = {}

/** Wire the live handoff (lead, once at boot). Additive/idempotent. */
export function configureMatchmaking(deps: MatchmakingHandoff): void {
  handoff = { ...handoff, ...deps }
}

function defaultGetPeer(): { root: B64u; key: B64u; fabric: FabricEndpoint } | null {
  const p = getAccountPeer()
  return p ? { root: p.root, key: p.key, fabric: p.fabric } : null
}

async function resolveSigning(): Promise<MatchmakingIdentity | null> {
  if (handoff.signing) return handoff.signing()
  try {
    const mod = await import('../../../../../web/accounts')
    const k = mod.deviceSigningKey()
    return k ? { root: k.root, key: k.key, priv: k.priv } : null
  } catch {
    return null
  }
}

const HEARTBEAT_MS = 2_500

interface ActiveSearch {
  engine: MatchmakingEngine
  pool: MatchPool
  timer: ReturnType<typeof setInterval>
  unsub: () => void
}
let active: ActiveSearch | null = null

/** Live third-machine count for the idle lobby header (no search running). */
export function refreshWitnessStatus(): void {
  const getPeer = handoff.getPeer ?? defaultGetPeer
  const peer = getPeer()
  if (!peer) {
    setUi({ peerLive: false, witnessesReachable: 0 })
    return
  }
  setUi({
    peerLive: true,
    witnessesReachable: countReachableWitnesses(peer.fabric.directory(), peer.root, Date.now()),
  })
}

/**
 * Start a LIVE rated search for `target` (the lobby's selected ladder + our
 * live PairView). Honest at every scarcity: signed out ⇒ 'signed-out'; a legal
 * opponent with no third machine ⇒ 'waiting-witness' (never a fake pairing).
 */
export async function startRatedSearch(target: SeekTarget): Promise<void> {
  cancelRatedSearch()
  const getPeer = handoff.getPeer ?? defaultGetPeer
  const peer = getPeer()
  const signing = await resolveSigning()
  if (!peer || !signing) {
    setUi({ phase: 'signed-out', ladderKey: target.ladderKey, peerLive: !!peer, opponentFound: false })
    return
  }
  const ladderId = ladderIdOf(target.ladderKey)
  const pool = (handoff.poolFactory ?? ((kind, lid) => createTrysteroMatchPool({ kind, ladderId: lid })))(
    MM_KIND,
    ladderId,
  )
  const engine = createMatchmakingEngine({
    identity: signing,
    fabric: peer.fabric,
    pool,
    target: () => target,
    now: () => Date.now(),
    ...(handoff.openRoom ? { openRoom: handoff.openRoom } : {}),
    ...(handoff.joinRoom ? { joinRoom: handoff.joinRoom } : {}),
    ...(handoff.startWitness ? { startWitness: handoff.startWitness } : {}),
    onStatus: (s) =>
      setUi({
        phase: s.phase,
        ladderKey: s.ladderKey,
        peerLive: true,
        witnessesReachable: s.witnessesReachable,
        opponentFound: s.opponentRoot !== null,
      }),
    ...(handoff.log ? { log: handoff.log } : {}),
  })
  const unsub = pool.subscribe(() => void engine.poll())
  const timer = setInterval(() => void engine.poll(), HEARTBEAT_MS)
  active = { engine, pool, timer, unsub }
  setUi({ phase: 'searching', ladderKey: target.ladderKey, peerLive: true, opponentFound: false, error: null })
  void engine.poll()
}

/** Stop the live search + leave the pool (cancel / unmount). */
export function cancelRatedSearch(): void {
  if (!active) return
  active.engine.stop()
  active.unsub()
  clearInterval(active.timer)
  active.pool.close()
  active = null
  setUi({ phase: 'idle', opponentFound: false })
  refreshWitnessStatus()
}

/**
 * Offer to WITNESS matchmade games without seeking one (the always-on / idle
 * posture: the operator peer and any signed-in idle instance run this so a
 * two-player table can find its third machine). One witness-only engine per
 * ladder pool; each self-attaches to games it is the canonical witness for.
 * Returns a stop handle. The lead wires this from the boot (opt-in / operator).
 */
export function offerWitnessing(ladderKeys: readonly LadderKey[] = MM_LADDERS): () => void {
  const getPeer = handoff.getPeer ?? defaultGetPeer
  const peer = getPeer()
  if (!peer || !handoff.startWitness) return () => {}
  const poolFactory = handoff.poolFactory ?? ((kind, lid) => createTrysteroMatchPool({ kind, ladderId: lid }))
  const stops: (() => void)[] = []
  void (async () => {
    const signing = await resolveSigning()
    if (!signing) return
    for (const key of ladderKeys) {
      const pool = poolFactory(MM_KIND, ladderIdOf(key))
      const engine = createMatchmakingEngine({
        identity: signing,
        fabric: peer.fabric,
        pool,
        target: () => null, // witness-only: subscribe + attach, never seek
        now: () => Date.now(),
        startWitness: handoff.startWitness,
        ...(handoff.log ? { log: handoff.log } : {}),
      })
      const unsub = pool.subscribe(() => void engine.poll())
      const timer = setInterval(() => void engine.poll(), HEARTBEAT_MS)
      void engine.poll()
      stops.push(() => {
        engine.stop()
        unsub()
        clearInterval(timer)
        pool.close()
      })
    }
  })()
  return () => stops.forEach((s) => s())
}

export const matchmakingStore = {
  getState(): MatchmakingUiState {
    return uiState
  },
  subscribe(fn: () => void): () => void {
    uiListeners.add(fn)
    return () => {
      uiListeners.delete(fn)
    }
  },
  startRatedSearch,
  cancelRatedSearch,
  refreshWitnessStatus,
  offerWitnessing,
  configure: configureMatchmaking,
}

/** React bridge. House useSyncExternalStore convention. */
export function useMatchmaking(): MatchmakingUiState {
  return useSyncExternalStore(matchmakingStore.subscribe, matchmakingStore.getState, matchmakingStore.getState)
}
