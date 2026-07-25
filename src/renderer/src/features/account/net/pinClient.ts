// A6 M4 (lane L-pin): the LIVE tOPRF PIN committee over the AccountPeer overlay
// (spec §1). This is the renderer-hosted BODY around the pure committee brain in
// src/shared/accounts/witness/{shamir,oprf,pin,counters,protocol}.ts: it draws a
// distance-ranked T-of-N committee from the live presence directory, provisions
// Shamir shares to each member's `memberServe` (already registered by
// peerService), verifies a PIN with the threshold OPRF (`pinVerifyFlow`), reads
// the committee's replicated failure count, and (on the lifetime cap) trips the
// threshold-signed fuse (`tripFuseIfDue`). NO crypto is reimplemented here; every
// primitive is imported from the tested shared substrate.
//
// Two layers:
//   1. PURE, fabric-injected orchestration (drawPinCommittee / provisionPinCommittee
//      / verifyPinAgainstCommittee / readCommitteeCount / tripFuseIfCapped). The
//      exact surface the headless suite drives over a MockFabric committee.
//   2. A UI-facing app-lifetime CONTROLLER (startPinClientSingleton) the lead wires
//      next to the account peer on sign-in; the un-fixtured PIN dialogs read its
//      reactive state (subscribePinClient / getPinClientState) and drive it
//      (runPinProvision / runPinVerify). When no controller is live (signed out, or
//      the lead hook not yet wired) the surface reports an HONEST state, never a
//      fixture, never a frozen control.
//
// PLATFORM-SPECIFIC renderer hosting; src/shared/accounts stays pure. The account
// ROOT signing key (needed once, to root-sign the PIN record; spec §1) is INJECTED
// (never re-derived here): the suite passes a test root, production wires
// `rootSigningKey()` via setPinRootSignerProvider (see notesForLead). Clock is
// injected, defaulting to Date.now (renderer glue is where wall-clock is allowed).

import {
  PARAMS_A2,
  closestEligible,
  collectAttemptReports,
  dealScalar,
  effectiveCount,
  fuseThreshold,
  isFuseActive,
  liveNodesOf,
  nodeIdOf,
  pinRecordId,
  pinVerifyFlow,
  pointToBytes,
  randScalar,
  scalarToBytes,
  shareCommitment,
  tripFuseIfDue,
  buildPinRecord,
  makePinRecordPayload,
  clientBlind,
  clientFinalize,
  pinKeyFromOutput,
  singleKeyBlindEvaluate,
  type FabricEndpoint,
  type FuseRecord,
  type NodeDirectory,
  type NodeId,
  type PinAttemptReport,
  type SignedPinRecord,
} from '@shared/accounts/witness'
import { toB64u } from '@shared/accounts/hash'
import type { Rng } from '@shared/accounts/witness'
import type { B64u } from '@shared/accounts'
import { getAccountPeer, type AccountPeer } from './peerService'

// ---------------------------------------------------------------------------
// RNG (crypto in the browser, seeded in the suite)
// ---------------------------------------------------------------------------

interface GlobalWithCrypto {
  crypto?: { getRandomValues<T extends ArrayBufferView>(a: T): T }
}

/** A cryptographic byte source `(n) => n random bytes` for share dealing + OPRF
 * blinds. Falls back to nothing usable when no WebCrypto exists (headless
 * without an injected rng). Callers in that case pass a seeded rng. */
export function secureRng(): Rng {
  const c = (globalThis as GlobalWithCrypto).crypto
  if (!c || typeof c.getRandomValues !== 'function')
    throw new Error('pinClient: no WebCrypto RNG available. Inject a seeded rng')
  return (n: number): Uint8Array => c.getRandomValues(new Uint8Array(n))
}

// ---------------------------------------------------------------------------
// Injected account-root signer (spec §1: the PIN record is root-signed)
// ---------------------------------------------------------------------------

/** The account root key material the PIN record is signed with. In production
 * this is a `rootSigningKey()` accessor on the web session (mirrors
 * deviceSigningKey but returns the root child: a LEAD HOOK, see notesForLead);
 * in the suite it is a test keypair. `rootPriv` never leaves the client. */
export interface PinRootSigner {
  root: B64u
  rootPriv: Uint8Array
}

export type PinRootSignerProvider = () => PinRootSigner | null

let rootSignerProvider: PinRootSignerProvider | null = null

/** Register the root-signer provider (the lead calls this once at boot with
 * `rootSigningKey`). Until it is set, the controller stays in an honest
 * signer-unavailable state rather than fabricating a committee. */
export function setPinRootSignerProvider(fn: PinRootSignerProvider | null): void {
  rootSignerProvider = fn
}

// ===========================================================================
// PURE, FABRIC-INJECTED ORCHESTRATION (the suite drives this directly)
// ===========================================================================

/** A distance-drawn committee candidate set (spec §1/§4: closest eligible
 * committee-capable live nodes). */
export interface CommitteeDraw {
  /** The pinN (or fewer) closest committee-capable live nodeIds, excl. self. */
  members: NodeId[]
  /** nodeId → advertised device signing key, from verified presence. Required
   * by tripFuseIfDue / counter reports (a self-chosen key proves nothing). */
  keyOf: Map<NodeId, B64u>
  /** True iff a full pinN-member committee was available. */
  enough: boolean
}

/**
 * Draw the PIN committee for `subjectRoot` from a live presence directory: the
 * `pinN` closest committee-capable live nodes by key-distance (spec §1 "drawn by
 * key-distance from the witness fabric §4"), excluding the account itself. A node
 * only counts if it advertises `caps.committee`. Deterministic given the
 * directory + clock. `enough` says whether a full committee was reachable. The
 * honest degradation signal the wizard surfaces as "waiting for a committee".
 */
export function drawPinCommittee(
  directory: NodeDirectory,
  subjectRoot: B64u,
  nowMs: number,
  params: typeof PARAMS_A2 = PARAMS_A2,
): CommitteeDraw {
  const subjectNode = nodeIdOf(subjectRoot)
  const rows = liveNodesOf(directory, nowMs)
    .filter((sp) => sp.body.caps.committee && sp.body.root !== subjectRoot)
    .map((sp) => ({ nodeId: nodeIdOf(sp.body.root), key: sp.body.key }))
  const members = closestEligible(subjectNode, rows, () => true, params.pinN)
  const keyByNode = new Map(rows.map((r) => [r.nodeId, r.key]))
  const keyOf = new Map<NodeId, B64u>()
  for (const m of members) {
    const k = keyByNode.get(m)
    if (k !== undefined) keyOf.set(m, k)
  }
  return { members, keyOf, enough: members.length >= params.pinN }
}

export type ProvisionPinResult =
  | { ok: true; record: SignedPinRecord; pinPub: B64u; provisioned: NodeId[] }
  | { ok: false; reason: string; provisioned?: NodeId[] }

export interface ProvisionPinOpts {
  fabric: FabricEndpoint
  signer: PinRootSigner
  pin: string
  committee: NodeId[]
  /** Byte source for the OPRF key deal + the pinPub self-check blind. */
  rng: Rng
  params?: typeof PARAMS_A2
}

/**
 * Provision a fresh PIN committee (spec §1): deal a random OPRF key T-of-N with
 * Feldman commitments, derive pinPub via a dealer single-key self-evaluation
 * (offline, since the dealer holds the whole key), root-sign the PIN record, and
 * deliver each member its share over `pin-provision`. A first enrollment only:
 * re-provision (committee handoff) is the separate PIN-gated path (spec §1;
 * exposed to the lead as a follow-up once the change-PIN flow lands).
 *
 * Succeeds when ≥ pinT members accepted their share (the threshold a later
 * verify needs); reports the failures honestly otherwise. Requires the full
 * pinN-member committee up front so the published record commits to N seats.
 */
export async function provisionPinCommittee(opts: ProvisionPinOpts): Promise<ProvisionPinResult> {
  const params = opts.params ?? PARAMS_A2
  if (opts.committee.length !== params.pinN)
    return { ok: false, reason: 'committee-incomplete' }
  if (new Set(opts.committee).size !== opts.committee.length)
    return { ok: false, reason: 'committee-duplicate-members' }

  // 1. Deal the OPRF key T-of-N with per-share Feldman commitments.
  const secret = randScalar(opts.rng)
  const deal = dealScalar(secret, params.pinT, params.pinN, opts.rng)
  const shareCommitments = deal.shares.map((s) => toB64u(pointToBytes(shareCommitment(s.share))))

  // 2. pinPub. The dealer knows the whole key, so a single-key OPRF evaluation
  //    yields the exact output the threshold committee will reproduce (oprf.ts
  //    invariant), and pinKeyFromOutput stretches it into the published pinPub.
  const bl = clientBlind(opts.pin, opts.rng)
  const combined = singleKeyBlindEvaluate(secret, bl.blinded)
  const output = clientFinalize(opts.pin, bl.blindState, combined)
  const pinPub = toB64u(pinKeyFromOutput(output).pub)

  // 3. Root-sign the standalone PIN record (makePinRecordPayload enforces shape).
  let record: SignedPinRecord
  try {
    const payload = makePinRecordPayload({
      committee: opts.committee,
      t: params.pinT,
      shareCommitments,
      pinPub,
    })
    record = buildPinRecord(payload, opts.signer.rootPriv, opts.signer.root)
  } catch (e) {
    return { ok: false, reason: `bad-record: ${e instanceof Error ? e.message : String(e)}` }
  }

  // 4. Deliver each member its share (index i binds to committee[i-1]).
  const provisioned: NodeId[] = []
  for (let i = 1; i <= opts.committee.length; i++) {
    const member = opts.committee[i - 1]
    try {
      const res = await opts.fabric.request(member, 'pin-provision', {
        newRecord: { payload: record.payload, root: record.root, sig: record.sig },
        i,
        share: toB64u(scalarToBytes(deal.shares[i - 1].share)),
      })
      if ((res as { ok?: boolean }).ok === true) provisioned.push(member)
    } catch {
      // unreachable member: its seat stays un-provisioned; verify routes around it
    }
  }
  if (provisioned.length < params.pinT)
    return { ok: false, reason: 'provision-under-threshold', provisioned }
  return { ok: true, record, pinPub, provisioned }
}

export type VerifyPinResult =
  | { ok: true; pinPub: B64u }
  | { ok: false; reason: string; pinPub?: B64u }

export interface VerifyPinOpts {
  fabric: FabricEndpoint
  root: B64u
  pin: string
  record: SignedPinRecord
  wts: number
  rng?: Rng
}

/**
 * Verify a PIN against its live committee (spec §1) via the threshold OPRF: the
 * committee shape is read straight off the account's PIN record. A correct PIN
 * proves success back to the queried members (net-zero counter); a wrong PIN
 * still spent one evaluation at each queried member. That IS the rate limit. A
 * fuse-banned root cannot reach a quorum (honest members refuse), surfaced as
 * `reason:'fuse-active'`.
 */
export async function verifyPinAgainstCommittee(opts: VerifyPinOpts): Promise<VerifyPinResult> {
  const p = opts.record.payload
  const res = await pinVerifyFlow({
    fabric: opts.fabric,
    root: opts.root,
    pin: opts.pin,
    committee: { members: p.committee, t: p.t, shareCommitments: p.shareCommitments, pinPub: p.pinPub },
    wts: opts.wts,
    ...(opts.rng ? { rng: opts.rng } : {}),
  })
  if (res.ok) return { ok: true, pinPub: res.pinPub }
  return { ok: false, reason: res.reason, ...(res.pinPub ? { pinPub: res.pinPub } : {}) }
}

/**
 * The committee-effective lifetime failure count for a root: gather each
 * member's signed attempt report and reduce with the t-th-largest statistic
 * (`effectiveCount`. A lowballing/inflating minority cannot move it). Reports
 * that fail their signature under the member's advertised key are dropped.
 * Returns 0 when fewer than pinT members answer (nothing the committee agrees
 * on yet). The authoritative trip still goes through tripFuseIfCapped; this is
 * the honest meter the UI shows.
 */
export async function readCommitteeCount(
  fabric: FabricEndpoint,
  root: B64u,
  committee: readonly NodeId[],
  keyOf: ReadonlyMap<NodeId, B64u>,
  params: typeof PARAMS_A2 = PARAMS_A2,
): Promise<number> {
  const reports: PinAttemptReport[] = await collectAttemptReports(
    fabric,
    root,
    committee,
    (w) => keyOf.get(w),
  )
  return effectiveCount(reports, params.pinT)
}

export interface TripFuseOpts {
  fabric: FabricEndpoint
  root: B64u
  record: SignedPinRecord
  keyOf: ReadonlyMap<NodeId, B64u>
  wts: number
  /** The account's current held fuse (expired, or none). Sets the cycle floor
   * (spec §1: each post-expiry cycle needs pinRefill more). */
  heldFuse?: FuseRecord | null
}

/**
 * Trip the threshold-signed fuse iff the committee's replicated count has
 * reached this cycle's cap (spec §1). Thin wrapper over `tripFuseIfDue`: it
 * pulls the members' signed counter reports, self-qualifies each co-signer on
 * its own converged count, and returns a verifiable FuseRecord (≥ pinT
 * signatures) or null when not due / the committee won't co-sign.
 */
export async function tripFuseIfCapped(opts: TripFuseOpts): Promise<FuseRecord | null> {
  return tripFuseIfDue({
    fabric: opts.fabric,
    root: opts.root,
    committee: opts.record.payload.committee,
    pinRecord: pinRecordId(opts.record.payload),
    keyOf: opts.keyOf,
    wts: opts.wts,
    heldFuse: opts.heldFuse ?? null,
  })
}

/** The failure threshold that trips THIS cycle's fuse (spec §1: 100, then +R per
 * served ban), given the account's current held (expired) fuse. */
export function currentFuseThreshold(
  heldFuse: FuseRecord | null,
  root: B64u,
  params: typeof PARAMS_A2 = PARAMS_A2,
): number {
  if (heldFuse && heldFuse.body.root === root) return heldFuse.body.fails + params.pinRefill
  return fuseThreshold(0, params)
}

// ---------------------------------------------------------------------------
// UI-facing fuse view (the un-fixtured FuseBanCard renders this)
// ---------------------------------------------------------------------------

export interface PinFuseView {
  trippedWts: number
  expiryWts: number
  fails: number
  /** Number of committee members whose signatures the record carries. */
  signers: number
  committeeN: number
  lifetimeCap: number
  refill: number
  /** Short id of the fuse's bound PIN record. The public reference. */
  recordId: string
}

/** Map a verified FuseRecord to the compact UI view. */
export function fuseViewOf(fr: FuseRecord, params: typeof PARAMS_A2 = PARAMS_A2): PinFuseView {
  return {
    trippedWts: fr.body.trippedWts,
    expiryWts: fr.body.expiryWts,
    fails: fr.body.fails,
    signers: new Set(fr.sigs.map((s) => s.w)).size,
    committeeN: params.pinN,
    lifetimeCap: params.pinLifetimeFails,
    refill: params.pinRefill,
    recordId: fr.body.pinRecord.slice(0, 10),
  }
}

// ===========================================================================
// APP-LIFETIME CONTROLLER (the un-fixtured dialogs read + drive this)
// ===========================================================================

export type PinClientPhase =
  | 'signed-out' // no controller / no root signer available
  | 'no-peer' // signed in but the account peer isn't up
  | 'no-committee' // peer up, but < pinN committee-capable machines reachable
  | 'unset' // committee reachable, no PIN provisioned yet
  | 'set' // PIN provisioned, committee live
  | 'banned' // the fuse is active, witnessed zone locked

export interface PinSeatView {
  nodeId: NodeId
  key: B64u
  /** Short, human seat label (the node id prefix). */
  label: string
  /** True once a share is confirmed placed at this seat. */
  provisioned: boolean
}

export interface PinClientState {
  phase: PinClientPhase
  committee: { t: number; n: number }
  /** Committee-capable machines currently reachable (for the honest wait copy). */
  reachable: number
  seats: PinSeatView[]
  /** Committee-effective lifetime failure count, or null when unknown. */
  failures: number | null
  lifetimeCap: number
  refill: number
  fuse: PinFuseView | null
  busy: 'idle' | 'provisioning' | 'verifying' | 'refreshing'
  error: string | null
}

const SIGNED_OUT_STATE: PinClientState = {
  phase: 'signed-out',
  committee: { t: PARAMS_A2.pinT, n: PARAMS_A2.pinN },
  reachable: 0,
  seats: [],
  failures: null,
  lifetimeCap: PARAMS_A2.pinLifetimeFails,
  refill: PARAMS_A2.pinRefill,
  fuse: null,
  busy: 'idle',
  error: null,
}

export type PinPurpose = 'lease-takeover' | 'device-witness' | 'committee-handoff'

export interface PinOpResult {
  ok: boolean
  reason?: string
}

export interface PinClientHandle {
  readonly root: B64u
  getState(): PinClientState
  subscribe(fn: () => void): () => void
  /** Redraw the committee + pull the count + fuse from the live overlay. */
  refresh(): Promise<void>
  /** Provision a fresh PIN committee for this account. */
  provision(pin: string): Promise<PinOpResult>
  /** Verify a PIN for a witnessed-zone action. */
  verify(pin: string, purpose: PinPurpose): Promise<PinOpResult>
  stop(): void
}

export interface StartPinClientOpts {
  signer: PinRootSigner
  /** Live account peer accessor. Default: peerService.getAccountPeer. */
  getPeer?: () => AccountPeer | null
  now?: () => number
  /** Byte source. Default: WebCrypto. */
  rng?: Rng
  /** Load a persisted PIN record for this root (kv / overlay). */
  loadRecord?: (root: B64u) => Promise<SignedPinRecord | null>
  /** Persist the PIN record for this root (kv / overlay). */
  saveRecord?: (root: B64u, rec: SignedPinRecord) => Promise<void>
  /** Load a persisted fuse record for this root. */
  loadFuse?: (root: B64u) => Promise<FuseRecord | null>
  /** Publish a tripped fuse (kv now; overlay/shard space is the M5 hook). */
  publishFuse?: (root: B64u, fr: FuseRecord) => Promise<void>
}

function shortNode(id: NodeId): string {
  return `${id.slice(0, 6)}…${id.slice(-4)}`
}

function seatsFrom(members: readonly NodeId[], keyOf: ReadonlyMap<NodeId, B64u>, provisioned: ReadonlySet<NodeId>): PinSeatView[] {
  return members.map((m) => ({
    nodeId: m,
    key: keyOf.get(m) ?? '',
    label: shortNode(m),
    provisioned: provisioned.has(m),
  }))
}

/**
 * Build a live PIN-committee controller for one signed-in account. It never
 * fabricates state: with no peer / no committee reachable it reports the honest
 * phase, and only real committee responses move the meter or trip the fuse.
 */
export function createPinClient(opts: StartPinClientOpts): PinClientHandle {
  const root = opts.signer.root
  const getPeer = opts.getPeer ?? getAccountPeer
  const now = opts.now ?? ((): number => Date.now())
  // A byte-source FACTORY: an injected rng (seeded suite) is reused as-is; the
  // production default mints a fresh WebCrypto stream per provision.
  const makeRng: () => Rng = opts.rng ? ((): Rng => opts.rng as Rng) : secureRng
  const listeners = new Set<() => void>()

  let state: PinClientState = { ...SIGNED_OUT_STATE, phase: 'no-peer' }
  let record: SignedPinRecord | null = null
  let fuse: FuseRecord | null = null
  let provisioned = new Set<NodeId>()
  let stopped = false
  // Resolves once any persisted record/fuse has loaded: refresh() awaits it so a
  // caller that refreshes immediately after construction never races the load.
  let ready: Promise<void> | null = null

  const emit = (patch: Partial<PinClientState>): void => {
    state = { ...state, ...patch }
    listeners.forEach((fn) => fn())
  }

  /** nodeId → advertised signing key for every live node (covers the record's
   * committee members that are currently reachable; absent members simply carry
   * no key and their counter reports do not count). */
  const liveKeyOf = (dir: NodeDirectory): Map<NodeId, B64u> => {
    const keyOf = new Map<NodeId, B64u>()
    for (const sp of liveNodesOf(dir, now())) keyOf.set(nodeIdOf(sp.body.root), sp.body.key)
    return keyOf
  }

  const refresh = async (): Promise<void> => {
    if (stopped) return
    if (ready) await ready
    const peer = getPeer()
    if (!peer) {
      emit({ phase: 'no-peer', reachable: 0, seats: [], busy: 'idle' })
      return
    }
    emit({ busy: 'refreshing', error: null })
    const dir = peer.fabric.directory()
    const draw = drawPinCommittee(dir, root, now())

    if (record) {
      const committee = record.payload.committee
      const keyOf = liveKeyOf(dir)
      let count: number | null = null
      try {
        count = await readCommitteeCount(peer.fabric, root, committee, keyOf)
      } catch {
        count = null
      }
      // Trip / detect the fuse when the count reaches this cycle's cap.
      if (!isActiveFuse() && count !== null && count >= currentFuseThreshold(fuse, root)) {
        await tryTrip(peer.fabric, keyOf)
      }
      const active = isActiveFuse()
      emit({
        phase: active ? 'banned' : 'set',
        reachable: committee.filter((m) => keyOf.has(m)).length,
        seats: seatsFrom(committee, keyOf, provisioned),
        failures: active && fuse ? fuse.body.fails : count,
        fuse: active && fuse ? fuseViewOf(fuse) : null,
        busy: 'idle',
      })
      return
    }

    emit({
      phase: draw.enough ? 'unset' : 'no-committee',
      reachable: draw.members.length,
      seats: seatsFrom(draw.members, draw.keyOf, new Set()),
      failures: null,
      fuse: null,
      busy: 'idle',
    })
  }

  const isActiveFuse = (): boolean => fuse !== null && isFuseActive(fuse, now())

  const tryTrip = async (fabric: FabricEndpoint, keyOf: ReadonlyMap<NodeId, B64u>): Promise<void> => {
    if (!record) return
    try {
      const fr = await tripFuseIfCapped({ fabric, root, record, keyOf, wts: now(), heldFuse: fuse })
      if (fr) {
        fuse = fr
        await opts.publishFuse?.(root, fr).catch(() => {})
      }
    } catch {
      // committee unreachable / won't co-sign: leave the fuse untripped, honest
    }
  }

  const provision = async (pin: string): Promise<PinOpResult> => {
    const peer = getPeer()
    if (!peer) return { ok: false, reason: 'no-peer' }
    const draw = drawPinCommittee(peer.fabric.directory(), root, now())
    if (!draw.enough) {
      emit({ phase: 'no-committee', reachable: draw.members.length, seats: seatsFrom(draw.members, draw.keyOf, new Set()) })
      return { ok: false, reason: 'no-committee' }
    }
    emit({ busy: 'provisioning', error: null })
    let res: ProvisionPinResult
    try {
      res = await provisionPinCommittee({ fabric: peer.fabric, signer: opts.signer, pin, committee: draw.members, rng: makeRng() })
    } catch (e) {
      emit({ busy: 'idle', error: e instanceof Error ? e.message : String(e) })
      return { ok: false, reason: 'provision-error' }
    }
    if (!res.ok) {
      emit({ busy: 'idle', error: `provision failed: ${res.reason}` })
      return { ok: false, reason: res.reason }
    }
    record = res.record
    fuse = null
    provisioned = new Set(res.provisioned)
    await opts.saveRecord?.(root, res.record).catch(() => {})
    await refresh()
    return { ok: true }
  }

  const verify = async (pin: string, _purpose: PinPurpose): Promise<PinOpResult> => {
    const peer = getPeer()
    if (!peer) return { ok: false, reason: 'no-peer' }
    if (!record) return { ok: false, reason: 'unset' }
    if (isActiveFuse()) {
      emit({ phase: 'banned', fuse: fuse ? fuseViewOf(fuse) : null })
      return { ok: false, reason: 'fuse-active' }
    }
    emit({ busy: 'verifying', error: null })
    let res: VerifyPinResult
    try {
      res = await verifyPinAgainstCommittee({ fabric: peer.fabric, root, pin, record, wts: now() })
    } catch (e) {
      emit({ busy: 'idle', error: e instanceof Error ? e.message : String(e) })
      return { ok: false, reason: 'verify-error' }
    }
    // A wrong PIN just spent a lifetime failure at each queried member. Re-read
    // the count + trip the fuse if it just crossed the cap.
    await refresh()
    if (res.ok) return { ok: true }
    return { ok: false, reason: res.reason }
  }

  // Load any persisted record + fuse, then draw the first committee view. refresh
  // awaits `ready`, so the load always lands before the first state is computed.
  ready = (async () => {
    try {
      const loaded = opts.loadRecord ? await opts.loadRecord(root) : null
      if (loaded) record = loaded
      const loadedFuse = opts.loadFuse ? await opts.loadFuse(root) : null
      if (loadedFuse) fuse = loadedFuse
    } catch {
      // no persistence / denied: start from the live draw
    }
  })()
  void refresh()

  return {
    root,
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    refresh,
    provision,
    verify,
    stop() {
      stopped = true
      listeners.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Singleton + UI subscription surface (started on sign-in by the lead)
// ---------------------------------------------------------------------------

let singleton: PinClientHandle | null = null
let unsubSingleton: (() => void) | null = null
const uiListeners = new Set<() => void>()

function notifyUi(): void {
  uiListeners.forEach((fn) => fn())
}

/** Subscribe to the live PIN client state (works whether or not one is up). */
export function subscribePinClient(fn: () => void): () => void {
  uiListeners.add(fn)
  return () => {
    uiListeners.delete(fn)
  }
}

/** The current PIN client state: the singleton's, or the honest signed-out
 * default when none is live (no fixture, ever). */
export function getPinClientState(): PinClientState {
  return singleton ? singleton.getState() : SIGNED_OUT_STATE
}

/** The live PIN client handle, or null when signed out / not yet wired. */
export function getPinClient(): PinClientHandle | null {
  return singleton
}

/**
 * Start the app-lifetime PIN client for the signed-in account (idempotent per
 * root). The lead calls this in the account-peer reconcile once the peer is up
 * and the root signer resolves. A no-op returning the live handle if one already
 * runs for the same root.
 */
export function startPinClientSingleton(opts: StartPinClientOpts): PinClientHandle {
  if (singleton && singleton.root === opts.signer.root) return singleton
  stopPinClientSingleton()
  const handle = createPinClient(opts)
  singleton = handle
  unsubSingleton = handle.subscribe(notifyUi)
  notifyUi()
  return handle
}

/** Start the singleton from the registered root-signer provider (the zero-arg
 * path the lead can call on sign-in, resolves the signer itself). Returns null
 * when no provider is set or it yields no signer (honest signed-out). */
export function startPinClientFromProvider(
  extra: Omit<StartPinClientOpts, 'signer'> = {},
): PinClientHandle | null {
  const signer = rootSignerProvider?.() ?? null
  if (!signer) return null
  return startPinClientSingleton({ ...extra, signer })
}

/** Stop + clear the singleton (sign-out / account switch). */
export function stopPinClientSingleton(): void {
  unsubSingleton?.()
  unsubSingleton = null
  singleton?.stop()
  singleton = null
  notifyUi()
}

// --- Imperative delegators the dialogs call (honest failure when none live) --

export async function runPinProvision(pin: string): Promise<PinOpResult> {
  if (!singleton) return { ok: false, reason: rootSignerProvider ? 'signed-out' : 'signer-unavailable' }
  return singleton.provision(pin)
}

export async function runPinVerify(pin: string, purpose: PinPurpose): Promise<PinOpResult> {
  if (!singleton) return { ok: false, reason: 'signed-out' }
  return singleton.verify(pin, purpose)
}

export async function runPinRefresh(): Promise<void> {
  await singleton?.refresh()
}
