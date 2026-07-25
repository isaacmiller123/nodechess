// A6 M4 (lanes L-presence-mail + L-friends): the LIVE social surface over the
// AccountPeer overlay (spec §3 friendships, §10 presence/mailbox/anti-spam, C-3).
// This is the renderer-hosted BODY around the pure, tested social transport in
// src/shared/accounts/social/{transport,presence,mailbox,friends,edgeStrength}.ts:
// it publishes/reads ephemeral presence over the overlay, RUNS this client as a
// mailbox RELAY for others, sends/drains store-and-forward mail with the §10
// anti-spam quotas enforced end-to-end, and drives the §3 friend
// request→countersigned-consent handshake over that mailbox. NO crypto and NO
// admission/eviction logic is reimplemented here. Every primitive is imported
// from the shared substrate and reused VERBATIM (createSocialRelay /
// publishSocialPresence / fetchSocialPresence / sendSocialMail /
// drainSocialMailbox / makeFriendRequestMail / makeFriendConsentMail /
// readFriendMail / consentToFriendRequest / adoptFriendConsent). The §10
// invariants therefore hold BY CONSTRUCTION: a relay stores no spoofed mail, a
// sybil flood cannot evict an established root's request (mailboxAdmit's
// strictly-greater-edge rule), and every edge the relay prioritizes with is
// derived from PUBLIC SIGNED DATA (edgeStrength.ts), never sender-asserted.
//
// Two layers, exactly the M4 pinClient shape:
//   1. PURE, fabric/overlay-injected orchestration (installSocialRelay /
//      publishOwnPresence / fetchPresence / sendFriendRequest / syncMailbox /
//      consentToRequest / adoptConsent): thin wrappers the headless suite
//      drives directly over a MockFabric network of real account peers.
//   2. A UI-facing app-lifetime CONTROLLER (createSocialClient) + singleton the
//      lead starts on sign-in next to the account peer; the un-fixtured
//      PeopleTab reads its reactive state (useSocialClient / getSocialClientState)
//      and drives it (runSendFriendRequest / runAcceptRequest / runSyncMailbox …).
//      With no peer / signed out it reports an HONEST empty state, never a
//      fixture, never a dead control.
//
// PLATFORM-SPECIFIC renderer hosting; src/shared/accounts stays pure. Presence,
// mail envelopes, drain requests and friend halves are ALL account-ROOT-signed,
// so (exactly like pinClient) the account root signer is INJECTED (never
// re-derived here): the suite passes a test root, production wires
// `rootSigningKey()` via setSocialRootSignerProvider (see notesForLead). Clocks
// are injected, defaulting to Date.now (renderer glue is where wall-clock lives);
// the pure wrappers take explicit witnessed-ms so they stay deterministic.

import {
  consentToFriendRequest,
  adoptFriendConsent,
  createSocialRelay,
  drainSocialMailbox,
  fetchSocialPresence,
  friendsOf,
  makeChainEdgeProvider,
  mailId,
  makeFriendConsentMail,
  makeFriendRemovePayload,
  makeFriendRequestMail,
  publishSocialPresence,
  readFriendMail,
  sendSocialMail,
  signSocialPresence,
  EDGE_ENTANGLE_PER_GAME_MICRO,
  MAIL_KIND_FRIEND_CONSENT,
  MAIL_KIND_FRIEND_REQUEST,
  PARAMS_SOCIAL_PRESENCE,
  type DrainedMail,
  type EdgeMicroProvider,
  type FriendHalf,
  type SendMailResult,
  type SocialPresenceBody,
  type SocialRelay,
  type SocialStatus,
} from '@shared/accounts/social'
import type { MailboxParams } from '@shared/accounts/social'
import type { FabricEndpoint } from '@shared/accounts/witness'
import type { OverlayNode } from '@shared/accounts/overlay'
import type { B64u, Chain, FriendPayload } from '@shared/accounts'
import { getAccountPeer, type AccountPeer } from './peerService'

// ---------------------------------------------------------------------------
// Injected account-root signer (spec §3/§10: presence, mail envelopes, drain
// requests and friend halves are all root-signed, same discipline as pinClient)
// ---------------------------------------------------------------------------

/** The account root key material this client signs presence, mail envelopes,
 * drain requests and friend halves with. In production this is a
 * `rootSigningKey()` accessor on the web session (mirrors deviceSigningKey but
 * returns the root child: the SAME LEAD HOOK pinClient needs; see notesForLead);
 * in the suite it is a test keypair. `rootPriv` never leaves the client. */
export interface SocialRootSigner {
  root: B64u
  rootPriv: Uint8Array
}

export type SocialRootSignerProvider = () => SocialRootSigner | null

let rootSignerProvider: SocialRootSignerProvider | null = null

/** Register the root-signer provider (the lead calls this once at boot with
 * `rootSigningKey`). Until it is set, the singleton stays in an honest
 * signer-unavailable state rather than fabricating a social surface. */
export function setSocialRootSignerProvider(fn: SocialRootSignerProvider | null): void {
  rootSignerProvider = fn
}

// ---------------------------------------------------------------------------
// Constants (C-3 coordination cadence: presence is ephemeral, §4/§11)
// ---------------------------------------------------------------------------

/** Self-declared presence lifetime, ms: kept inside PARAMS_SOCIAL_PRESENCE's
 * ttlMaxMs cap (5 min) so verifiers never refuse it; the controller re-announces
 * well inside this (heartbeat below). */
export const SOCIAL_PRESENCE_TTL_MS = 240_000
/** Production heartbeat: re-publish presence every 60 s (a live tab must refresh
 * it before the ttl lapses). Off by default: suites stay timer-free. */
export const SOCIAL_HEARTBEAT_MS = 60_000
/** Production mailbox poll: drain relays every 45 s so requests arrive while the
 * recipient is online. Off by default. */
export const SOCIAL_SYNC_MS = 45_000

// ===========================================================================
// PURE, FABRIC/OVERLAY-INJECTED ORCHESTRATION (the suite drives this directly)
// ===========================================================================

export interface InstallRelayOpts {
  /** Injected clock (ms). Stamps mail arrivals + drain windows. */
  now: () => number
  /** The §10 edge fold the relay prioritizes with. Default:
   * makeChainEdgeProvider over `chainOf`. A missing/unverifiable chain folds to
   * edge 0 inside the fold (fail closed). Safe, just no priority for that root. */
  edgeMicroOf?: EdgeMicroProvider
  /** The relay's view of reconstructed chains (its C-1 cache / the overlay
   * storage layer). The source makeChainEdgeProvider derives edges from.
   * Default: `() => null` (every edge folds to 0: rate/cap/fair-share still hold;
   * see notesForLead to wire this to the live reconstruction cache). */
  chainOf?: (root: B64u) => Chain | null
  /** Mailbox rule set (state pins its digest). Default PARAMS_SOCIAL_MAILBOX. */
  params?: MailboxParams
}

/**
 * Install THIS node's mailbox relay on its fabric endpoint (spec §10): every
 * signed-in client relays for others, exactly as every client is an eligible
 * witness/committee member (peerService). The relay calls the pure mailboxAdmit/
 * mailboxDrain at its boundary VERBATIM: this wrapper only supplies the clock
 * and the edge fold. Registers `social-mail-send` / `social-mail-drain` handlers
 * (additive, disjoint from the overlay/witness/member kinds already served).
 */
export function installSocialRelay(fabric: FabricEndpoint, opts: InstallRelayOpts): SocialRelay {
  const edgeMicroOf =
    opts.edgeMicroOf ?? makeChainEdgeProvider({ chainOf: opts.chainOf ?? ((): Chain | null => null) })
  return createSocialRelay(fabric, {
    nowMs: opts.now,
    edgeMicroOf,
    ...(opts.params ? { params: opts.params } : {}),
  })
}

/**
 * Publish this account's presence claim to the overlay (spec §10). Root-signs a
 * fresh {status, ts, ttl} body (signSocialPresence) and stores it to the
 * replicateK closest nodes, each re-verifying through its own gate. Returns the
 * number of true stores (0 = no relays reachable yet; honest, not an error).
 */
export function publishOwnPresence(
  node: OverlayNode,
  signer: SocialRootSigner,
  status: SocialStatus,
  nowMs: number,
  ttlMs: number = SOCIAL_PRESENCE_TTL_MS,
): Promise<number> {
  const body: SocialPresenceBody = {
    v: 1,
    root: signer.root,
    status,
    ts: Math.floor(nowMs),
    ttlMs: Math.min(ttlMs, PARAMS_SOCIAL_PRESENCE.ttlMaxMs),
  }
  return publishSocialPresence(node, signSocialPresence(body, signer.rootPriv))
}

/**
 * Fetch + verify a root's presence at witnessed time `nowWts`, projected to the
 * status enum. null-or-expired reads as 'offline' (fail closed). There is no
 * negative presence claim and no authority (C-3).
 */
export async function fetchPresence(
  node: OverlayNode,
  root: B64u,
  nowWts: number,
): Promise<SocialStatus | 'offline'> {
  const view = await fetchSocialPresence(node, root, Math.floor(nowWts))
  return view?.status ?? 'offline'
}

/**
 * Offer a §3 friend REQUEST to `peerRoot` over the mailbox (survives an offline
 * recipient: the relays hold it until the recipient next syncs). The half rides
 * under the account ROOT key (key === selfRoot, no certs needed) and the
 * envelope is root-signed; both are makeFriendRequestMail's job. Refusals are
 * honest degradation in the returned per-relay outcomes.
 */
export function sendFriendRequest(o: {
  fabric: FabricEndpoint
  node: OverlayNode
  signer: SocialRootSigner
  peerRoot: B64u
  nowMs: number
}): Promise<SendMailResult> {
  const mail = makeFriendRequestMail({
    selfRoot: o.signer.root,
    peerRoot: o.peerRoot,
    key: o.signer.root,
    priv: o.signer.rootPriv,
    rootPriv: o.signer.rootPriv,
    sentTs: Math.floor(o.nowMs),
  })
  return sendSocialMail(o.fabric, o.node, mail)
}

/** The CONSENT leg back to the original requester (its half rides a
 * 'friend-consent' mail; the requester adopts it to complete the mutual edge). */
export function sendFriendConsent(o: {
  fabric: FabricEndpoint
  node: OverlayNode
  signer: SocialRootSigner
  peerRoot: B64u
  nowMs: number
}): Promise<SendMailResult> {
  const mail = makeFriendConsentMail({
    selfRoot: o.signer.root,
    peerRoot: o.peerRoot,
    key: o.signer.root,
    priv: o.signer.rootPriv,
    rootPriv: o.signer.rootPriv,
    sentTs: Math.floor(o.nowMs),
  })
  return sendSocialMail(o.fabric, o.node, mail)
}

/**
 * Sync this account's mailbox: sign one root-authenticated drain request and
 * union its relays' verified boxes, in the §10 priority order (established +
 * earliest first). Each returned DrainedMail is re-verified against this root by
 * the substrate: a malicious relay can drop/reorder but never inject.
 */
export function syncMailbox(o: {
  fabric: FabricEndpoint
  node: OverlayNode
  signer: SocialRootSigner
  nowMs: number
}): Promise<DrainedMail[]> {
  return drainSocialMailbox(o.fabric, o.node, {
    recipient: o.signer.root,
    rootPriv: o.signer.rootPriv,
    ts: Math.floor(o.nowMs),
  })
}

/** Read a drained mail as a verified friend REQUEST half (or null; wrong kind,
 * forged, cross-pair-replayed, or third-party-smuggled all fail closed here). */
export function readRequestHalf(m: DrainedMail): FriendHalf | null {
  return readFriendMail(m.mail, MAIL_KIND_FRIEND_REQUEST)
}

/** Read a drained mail as a verified friend CONSENT half (or null). */
export function readConsentHalf(m: DrainedMail): FriendHalf | null {
  return readFriendMail(m.mail, MAIL_KIND_FRIEND_CONSENT)
}

/**
 * CONSENT step (recipient of a request): validate the requester's half against
 * SELF and return the FriendPayload the recipient appends to ITS OWN chain (the
 * witnessed-lane 'friend' add). null = the half does not verify / does not bind
 * to self. The returned payload is guaranteed to satisfy verifyFriendAdd, the
 * "countersigned + verifies" property is structural, not asserted.
 */
export function consentToRequest(request: FriendHalf, selfRoot: B64u): FriendPayload | null {
  return consentToFriendRequest(request, selfRoot)
}

/** ADOPT step (original requester, on draining the consent): same rule, bound to
 * the peer actually asked (`expectedPeer`) so an unsolicited stranger 'consent'
 * never auto-appends an unrequested edge. Appending the payload completes the §3
 * mutual edge. */
export function adoptConsent(consent: FriendHalf, selfRoot: B64u, expectedPeer: B64u): FriendPayload | null {
  return adoptFriendConsent(consent, selfRoot, expectedPeer)
}

/** §10 relayer priority chip, derived from the relay-frozen edgeMicro (public
 * signed data only): a §3 edge (friend/game, ≥ one entanglement unit) shows
 * 'entangled'; earned-but-edgeless (trust/reputation) shows 'reputable'; a fresh
 * root (edge 0) shows 'new'. Mirrors the surviving-the-flood semantics. */
export type MailPriority = 'entangled' | 'reputable' | 'new'
export function priorityOfEdge(edgeMicro: number): MailPriority {
  if (edgeMicro >= EDGE_ENTANGLE_PER_GAME_MICRO) return 'entangled'
  if (edgeMicro > 0) return 'reputable'
  return 'new'
}

// ===========================================================================
// APP-LIFETIME CONTROLLER (the un-fixtured PeopleTab reads + drives this)
// ===========================================================================

export type SocialClientPhase =
  | 'signed-out' // no controller / no root signer available
  | 'no-peer' // signed in but the account peer isn't up
  | 'live' // peer up: presence/mailbox/friends over the live overlay

export type FriendPresence = SocialStatus | 'offline'

/** One friend row: a countersigned edge in the OWN chain (friendsOf fold), with
 * live presence overlaid. `label` is a short root handle until a name resolves
 * (see resolveName). Never a fabricated display name. */
export interface SocialFriendView {
  root: B64u
  label: string
  /** Resolved display name (best-effort, via resolveName), or null. */
  name: string | null
  presence: FriendPresence
  /** Every §3 edge carries two signatures. Folded adds are countersigned. */
  countersigned: boolean
  /** Author-claimed ts of the deciding 'friend' add (display metadata only;
   * the fold's height is the ordering authority), or null. */
  since: number | null
}

/** One pending incoming request (a verified request half waiting in the box). */
export interface SocialRequestView {
  /** The mail id (stable action handle). */
  id: string
  from: B64u
  label: string
  name: string | null
  /** Relay-frozen §10 priority (from public-signed-data edge). */
  priority: MailPriority
  edgeMicro: number
  ts: number
}

export interface SocialClientState {
  phase: SocialClientPhase
  /** This account's own published presence status. */
  status: SocialStatus
  friends: SocialFriendView[]
  requests: SocialRequestView[]
  /** Relays that admitted this account's last presence publish, the honest
   * "mailbox reachable" signal (0 ⇒ the social surface is degraded, not broken). */
  presenceReplicas: number
  busy: 'idle' | 'syncing' | 'sending' | 'accepting' | 'refreshing'
  error: string | null
}

const SIGNED_OUT_STATE: SocialClientState = {
  phase: 'signed-out',
  status: 'online',
  friends: [],
  requests: [],
  presenceReplicas: 0,
  busy: 'idle',
  error: null,
}

export interface SendResult {
  ok: boolean
  reason?: string
}

export interface StartSocialClientOpts {
  signer: SocialRootSigner
  /** Live account peer accessor. Default: peerService.getAccountPeer. */
  getPeer?: () => AccountPeer | null
  now?: () => number
  /** Load this account's own chain (for the friendsOf fold). Default: none →
   * the friends list stays empty (honest) until the lead wires loadOwnChain. */
  loadChain?: () => Promise<Chain | null>
  /** Append a witnessed-lane 'friend' add/remove to the own chain. The §3
   * countersigned edge write. Wired by the lead to the M2 lease+appendWitnessed
   * path (returns true once it lands). Absent ⇒ the edge is still countersigned
   * and mailed, and the UI reports the honest "writes when a witness is
   * reachable" state (no dead button). */
  appendFriendEdge?: (payload: FriendPayload, peerRoot: B64u) => Promise<boolean>
  /** The relay's edge-fold chain source (C-1 cache). Default: () => null. */
  chainOf?: (root: B64u) => Chain | null
  edgeMicroOf?: EdgeMicroProvider
  /** Best-effort display-name resolver (lead: viewerClient). Non-blocking. */
  resolveName?: (root: B64u) => Promise<string | null>
  /** Re-publish presence every N ms (browser keepalive). Default off (no timer). */
  heartbeatMs?: number
  /** Drain the mailbox every N ms. Default off (no timer). */
  syncMs?: number
  mailboxParams?: MailboxParams
  /** Initial published status. Default 'online'. */
  status?: SocialStatus
}

export interface SocialClientHandle {
  readonly root: B64u
  getState(): SocialClientState
  subscribe(fn: () => void): () => void
  /** Re-fold friends from the own chain + refresh presences. */
  refresh(): Promise<void>
  /** Drain the mailbox: surface new requests, adopt consents for edges we asked. */
  sync(): Promise<void>
  /** Publish/update this account's presence status. */
  setStatus(status: SocialStatus): Promise<void>
  /** Offer a §3 friend request to a peer root (rides the mailbox). */
  sendRequest(peerRoot: B64u): Promise<SendResult>
  /** Accept an incoming request by mail id (countersign + mail consent back). */
  acceptRequest(id: string): Promise<SendResult>
  /** Decline an incoming request (drop it locally; ephemeral, C-3). */
  declineRequest(id: string): void
  /** Remove a friend (unilateral signed witnessed event, §3). */
  removeFriend(peerRoot: B64u): Promise<SendResult>
  stop(): void
}

function shortRoot(root: B64u): string {
  return `${root.slice(0, 6)}…${root.slice(-4)}`
}

/**
 * Build a live social controller for one signed-in account. It never fabricates
 * state: with no peer it reports 'no-peer' and empty lists; friends come only
 * from the OWN chain's countersigned adds; requests come only from verified,
 * relay-delivered mail. All heavy work degrades honestly.
 */
export function createSocialClient(opts: StartSocialClientOpts): SocialClientHandle {
  const root = opts.signer.root
  const getPeer = opts.getPeer ?? getAccountPeer
  const now = opts.now ?? ((): number => Date.now())
  const listeners = new Set<() => void>()

  let state: SocialClientState = { ...SIGNED_OUT_STATE, phase: 'no-peer', status: opts.status ?? 'online' }
  let relay: SocialRelay | null = null
  let relayFabric: FabricEndpoint | null = null
  let stopped = false
  let syncing = false
  // A STRICTLY-monotonic drain timestamp per client: the relay refuses a drain
  // whose ts is ≤ the last it accepted for this recipient (replay protection), so
  // two syncs inside one wall-clock ms (or under a coarse/frozen test clock)
  // would have the second refused. Bumping past the last used ts keeps every
  // real sync effective while preserving the substrate's replay guard.
  let lastDrainTs = 0
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let syncTimer: ReturnType<typeof setInterval> | undefined

  // Roots we have an outstanding OUTGOING request to. A consent from one of
  // these auto-adopts into an edge; a "consent" from anyone else is treated as
  // an incoming request (substrate rule: an unsolicited signed half IS a request).
  const pendingOutgoing = new Set<B64u>()
  // Verified incoming request halves, keyed by mail id (the action handle).
  const incoming = new Map<string, { from: B64u; half: FriendHalf; edgeMicro: number; ts: number }>()
  // Best-effort resolved names (root → name), filled lazily; never blocks a render.
  const nameCache = new Map<B64u, string>()

  const emit = (patch: Partial<SocialClientState>): void => {
    state = { ...state, ...patch }
    for (const fn of listeners) fn()
  }

  const labelFor = (r: B64u): { label: string; name: string | null } => ({
    label: shortRoot(r),
    name: nameCache.get(r) ?? null,
  })

  /** Kick off best-effort name resolution for a set of roots; emits once any
   * land. Non-blocking, deduped, failure-silent (C-3 / honest). */
  const resolveNames = (roots: readonly B64u[]): void => {
    if (!opts.resolveName) return
    const missing = [...new Set(roots)].filter((r) => r !== root && !nameCache.has(r))
    if (missing.length === 0) return
    void Promise.all(
      missing.map(async (r) => {
        try {
          const n = await opts.resolveName!(r)
          if (n) nameCache.set(r, n)
        } catch {
          /* honest: no resolver / unreachable ⇒ short root stands */
        }
      }),
    ).then(() => {
      if (!stopped) void refresh()
    })
  }

  /** Ensure this node's relay is installed on the live peer fabric (idempotent
   * per fabric. A peer swap re-installs). */
  const ensureRelay = (peer: AccountPeer): void => {
    if (relay && relayFabric === peer.fabric) return
    relay?.close()
    relay = installSocialRelay(peer.fabric, {
      now,
      ...(opts.edgeMicroOf ? { edgeMicroOf: opts.edgeMicroOf } : {}),
      ...(opts.chainOf ? { chainOf: opts.chainOf } : {}),
      ...(opts.mailboxParams ? { params: opts.mailboxParams } : {}),
    })
    relayFabric = peer.fabric
  }

  /** Fold friends from the own chain + overlay their live presence. */
  const refresh = async (): Promise<void> => {
    if (stopped) return
    const peer = getPeer()
    if (!peer) {
      emit({ phase: 'no-peer', friends: [], requests: [], busy: 'idle' })
      return
    }
    ensureRelay(peer)
    emit({ phase: 'live', busy: 'refreshing', error: null })

    // Friends = the OWN chain's currently-asserted countersigned adds (§3).
    let friendRoots: B64u[] = []
    const sinceOf = new Map<B64u, number>()
    try {
      const chain = opts.loadChain ? await opts.loadChain() : null
      if (chain) {
        const view = friendsOf(root, chain.events)
        friendRoots = view.friends
        for (const e of view.edges) if (e.state === 'add') sinceOf.set(e.peer, e.ts)
      }
    } catch {
      friendRoots = [] // no chain / denied ⇒ honest empty, never a crash
    }

    // Live presence per friend (§10, ephemeral). Fail-closed to 'offline'.
    const nowWts = now()
    const presences = await Promise.all(
      friendRoots.map((r) => fetchPresence(peer.overlay, r, nowWts).catch(() => 'offline' as FriendPresence)),
    )
    const friends: SocialFriendView[] = friendRoots.map((r, i) => ({
      root: r,
      ...labelFor(r),
      presence: presences[i],
      countersigned: true,
      since: sinceOf.get(r) ?? null,
    }))
    resolveNames([...friendRoots, ...[...incoming.values()].map((x) => x.from)])

    emit({ phase: 'live', friends, requests: requestViews(), busy: 'idle' })
  }

  const requestViews = (): SocialRequestView[] =>
    [...incoming.entries()]
      .map(([id, x]) => ({
        id,
        from: x.from,
        ...labelFor(x.from),
        priority: priorityOfEdge(x.edgeMicro),
        edgeMicro: x.edgeMicro,
        ts: x.ts,
      }))
      // §10 order: established + earliest first (the drain order, mirrored).
      .sort((a, b) => b.edgeMicro - a.edgeMicro || a.ts - b.ts)

  /** Drain the mailbox: classify verified mail into requests + auto-adopt
   * consents for edges we actually requested. */
  const sync = async (): Promise<void> => {
    if (stopped || syncing) return // never overlap drains (concurrent ts collisions)
    const peer = getPeer()
    if (!peer) {
      emit({ phase: 'no-peer', busy: 'idle' })
      return
    }
    ensureRelay(peer)
    emit({ busy: 'syncing', error: null })
    syncing = true
    try {
      let drained: DrainedMail[]
      try {
        lastDrainTs = Math.max(Math.floor(now()), lastDrainTs + 1)
        drained = await syncMailbox({ fabric: peer.fabric, node: peer.overlay, signer: opts.signer, nowMs: lastDrainTs })
      } catch {
        emit({ busy: 'idle' })
        return
      }
      for (const dm of drained) {
        const req = readRequestHalf(dm)
        if (req) {
          recordIncoming(dm, req)
          continue
        }
        const consent = readConsentHalf(dm)
        if (!consent) continue
        if (pendingOutgoing.has(consent.from)) {
          // A consent to an edge WE asked for → adopt + append our own add.
          const payload = adoptConsent(consent, root, consent.from)
          if (payload) {
            const landed = await appendEdge(payload, consent.from)
            if (landed) pendingOutgoing.delete(consent.from)
          }
        } else {
          // An unsolicited signed half is, per the substrate, a REQUEST, surface it.
          recordIncoming(dm, consent)
        }
      }
      resolveNames([...incoming.values()].map((x) => x.from))
      await refresh()
    } finally {
      syncing = false
    }
  }

  const recordIncoming = (dm: DrainedMail, half: FriendHalf): void => {
    // Already a confirmed friend? Then this is a duplicate/stale request. Ignore.
    if (state.friends.some((f) => f.root === half.from)) return
    // Key by the canonical mail id (sha256 of the envelope). Collision-free and
    // stable across re-drains, the action handle the UI accepts against.
    incoming.set(mailId(dm.mail.body), {
      from: half.from,
      half,
      edgeMicro: dm.edgeMicro,
      ts: dm.arrivedWts,
    })
  }

  /** Append a friend edge via the injected witnessed-write hook (honest false
   * when no hook / no witness. The caller degrades, never crashes). */
  const appendEdge = async (payload: FriendPayload, peerRoot: B64u): Promise<boolean> => {
    if (!opts.appendFriendEdge) return false
    try {
      return await opts.appendFriendEdge(payload, peerRoot)
    } catch {
      return false
    }
  }

  const setStatus = async (status: SocialStatus): Promise<void> => {
    const peer = getPeer()
    emit({ status })
    if (!peer) return
    ensureRelay(peer)
    try {
      const n = await publishOwnPresence(peer.overlay, opts.signer, status, now())
      emit({ presenceReplicas: n })
    } catch {
      /* no relays reachable ⇒ presenceReplicas unchanged (honest) */
    }
  }

  const sendRequest = async (peerRoot: B64u): Promise<SendResult> => {
    const peer = getPeer()
    if (!peer) return { ok: false, reason: 'no-peer' }
    if (peerRoot === root) return { ok: false, reason: 'self' }
    ensureRelay(peer)
    emit({ busy: 'sending', error: null })
    try {
      const res = await sendFriendRequest({ fabric: peer.fabric, node: peer.overlay, signer: opts.signer, peerRoot, nowMs: now() })
      pendingOutgoing.add(peerRoot)
      emit({ busy: 'idle' })
      if (res.admitted === 0) return { ok: false, reason: 'no-relay' }
      return { ok: true }
    } catch (e) {
      emit({ busy: 'idle', error: e instanceof Error ? e.message : String(e) })
      return { ok: false, reason: 'send-error' }
    }
  }

  const acceptRequest = async (id: string): Promise<SendResult> => {
    const peer = getPeer()
    if (!peer) return { ok: false, reason: 'no-peer' }
    const item = incoming.get(id)
    if (!item) return { ok: false, reason: 'gone' }
    ensureRelay(peer)
    emit({ busy: 'accepting', error: null })
    // Countersign: derive OUR chain-appendable add from the requester's half.
    const payload = consentToRequest(item.half, root)
    if (!payload) {
      emit({ busy: 'idle', error: 'request no longer verifies' })
      return { ok: false, reason: 'bad-request' }
    }
    // Append our own edge (witnessed lane) + mail the consent half back.
    const landed = await appendEdge(payload, item.from)
    let consentSent = false
    try {
      const res = await sendFriendConsent({ fabric: peer.fabric, node: peer.overlay, signer: opts.signer, peerRoot: item.from, nowMs: now() })
      consentSent = res.admitted > 0
    } catch {
      consentSent = false
    }
    incoming.delete(id)
    await refresh()
    emit({ busy: 'idle' })
    if (!landed && !consentSent) return { ok: false, reason: 'no-relay' }
    // consent is out (peer can complete their side); landed reflects our chain write.
    return { ok: true, ...(landed ? {} : { reason: 'edge-pending-witness' }) }
  }

  const declineRequest = (id: string): void => {
    incoming.delete(id)
    emit({ requests: requestViews() })
  }

  const removeFriend = async (peerRoot: B64u): Promise<SendResult> => {
    const peer = getPeer()
    if (!peer) return { ok: false, reason: 'no-peer' }
    emit({ busy: 'accepting', error: null })
    let payload: FriendPayload
    try {
      payload = makeFriendRemovePayload(peerRoot)
    } catch {
      emit({ busy: 'idle' })
      return { ok: false, reason: 'bad-peer' }
    }
    const landed = await appendEdge(payload, peerRoot)
    await refresh()
    emit({ busy: 'idle' })
    return landed ? { ok: true } : { ok: false, reason: 'edge-pending-witness' }
  }

  // Kick the initial presence publish + friends fold once (async, non-blocking).
  // The FIRST mailbox drain is left to the caller / the sync timer, so it never
  // races an explicit sync() (the drain-ts monotonicity guard + the syncing lock
  // both cover it, but not overlapping is simplest).
  void (async () => {
    if (stopped) return
    await setStatus(opts.status ?? 'online')
    await refresh()
  })()

  // Optional production timers (off in suites → deterministic).
  if (opts.heartbeatMs && opts.heartbeatMs > 0)
    heartbeatTimer = setInterval(() => void setStatus(state.status), opts.heartbeatMs)
  if (opts.syncMs && opts.syncMs > 0) syncTimer = setInterval(() => void sync(), opts.syncMs)

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
    sync,
    setStatus,
    sendRequest,
    acceptRequest,
    declineRequest,
    removeFriend,
    stop() {
      stopped = true
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
      if (syncTimer !== undefined) clearInterval(syncTimer)
      relay?.close()
      relay = null
      relayFabric = null
      listeners.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Singleton + UI subscription surface (started on sign-in by the lead)
// ---------------------------------------------------------------------------

let singleton: SocialClientHandle | null = null
let unsubSingleton: (() => void) | null = null
const uiListeners = new Set<() => void>()

function notifyUi(): void {
  for (const fn of uiListeners) fn()
}

/** Subscribe to the live social-client state (works whether or not one is up). */
export function subscribeSocialClient(fn: () => void): () => void {
  uiListeners.add(fn)
  return () => {
    uiListeners.delete(fn)
  }
}

/** The current social-client state: the singleton's, or the honest signed-out
 * default when none is live (a stable reference between changes, for
 * useSyncExternalStore; NEVER a fixture). */
export function getSocialClientState(): SocialClientState {
  return singleton ? singleton.getState() : SIGNED_OUT_STATE
}

/** The live social-client handle, or null when signed out / not yet wired. */
export function getSocialClient(): SocialClientHandle | null {
  return singleton
}

/**
 * Start the app-lifetime social client for the signed-in account (idempotent per
 * root). The lead calls this in the account-peer reconcile once the peer is up
 * and the root signer resolves. A no-op returning the live handle if one already
 * runs for the same root.
 */
export function startSocialClientSingleton(opts: StartSocialClientOpts): SocialClientHandle {
  if (singleton && singleton.root === opts.signer.root) return singleton
  stopSocialClientSingleton()
  const handle = createSocialClient(opts)
  singleton = handle
  unsubSingleton = handle.subscribe(notifyUi)
  notifyUi()
  return handle
}

/** Start the singleton from the registered root-signer provider (the zero-arg
 * path the lead can call on sign-in). Returns null when no provider is set or it
 * yields no signer (honest signed-out). */
export function startSocialClientFromProvider(
  extra: Omit<StartSocialClientOpts, 'signer'> = {},
): SocialClientHandle | null {
  const signer = rootSignerProvider?.() ?? null
  if (!signer) return null
  return startSocialClientSingleton({ ...extra, signer })
}

/** Stop + clear the singleton (sign-out / account switch). */
export function stopSocialClientSingleton(): void {
  unsubSingleton?.()
  unsubSingleton = null
  singleton?.stop()
  singleton = null
  notifyUi()
}

// --- Imperative delegators the UI calls (honest failure when none live) ------

export async function runSendFriendRequest(peerRoot: B64u): Promise<SendResult> {
  if (!singleton) return { ok: false, reason: rootSignerProvider ? 'signed-out' : 'signer-unavailable' }
  return singleton.sendRequest(peerRoot)
}

export async function runAcceptRequest(id: string): Promise<SendResult> {
  if (!singleton) return { ok: false, reason: 'signed-out' }
  return singleton.acceptRequest(id)
}

export function runDeclineRequest(id: string): void {
  singleton?.declineRequest(id)
}

export async function runRemoveFriend(peerRoot: B64u): Promise<SendResult> {
  if (!singleton) return { ok: false, reason: 'signed-out' }
  return singleton.removeFriend(peerRoot)
}

export async function runSetStatus(status: SocialStatus): Promise<void> {
  await singleton?.setStatus(status)
}

export async function runSyncMailbox(): Promise<void> {
  await singleton?.sync()
}
