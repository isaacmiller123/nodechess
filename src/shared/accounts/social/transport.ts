// A7 social transport (kickoff brick 1; spec §10, §3, §5, C-3): the layer
// that makes the PURE social modules (presence.ts, mailbox.ts, friends.ts,
// which stay pure) actually move between peers over the A3 overlay:
//
//   1. PRESENCE. The fuse-record publish pattern (storage/pointers.ts house
//      template): a deterministic per-root overlay key, a store GATE (verify
//      root signature, ttl cap, clock-bounded freshness, key binding, refuse
//      malformed), a freshest-wins MERGE (presence.ts rule 4 semantics), and
//      publish/fetch helpers. Rides ValueKind 'record'. The value is
//      self-describing ({t:'social-presence'}), and the gate composes over a
//      `base` validator/merge exactly like makePointerStoreValidator.
//   2. MAILBOX RELAYING: store-and-forward under a RECIPIENT-derived overlay
//      key. The key selects the relays (the k overlay-closest nodes, the same
//      duty-by-distance rule shards use); the relay boundary is a dedicated
//      request pair (send/drain) because admission is STATEFUL (rate windows)
//      and drain must be AUTHENTICATED and clearing. Semantics FIND_VALUE
//      cannot honor. At that boundary the relay calls the pure mailboxAdmit /
//      mailboxDrain VERBATIM: per-sender-root rate limits, fair share, and
//      edge-priority eviction stay exactly as mailbox.ts defines them. With
//      meta.edgeMicro computed by the §10 edge-strength fold (edgeStrength.ts)
//      from PUBLIC SIGNED DATA the relay itself verifies.
//   3. FRIEND-EDGE COUNTERSIGNATURE EXCHANGE: the §3 add flow needs the
//      counterparty's signature over the sorted-pair canonical bytes
//      (friends.ts friendBytes). The round-trip rides the mailbox: a
//      friend-request mail carries the requester's HALF (its signature +
//      key-provenance certs); consent mints the counterpart half and mails it
//      back; each side then appends its own witnessed-lane 'friend' add built
//      from the peer's half. Because BOTH parties sign the identical
//      two-root-bound bytes, one half serves both chains and can never be
//      replayed into another pair: verification is friends.ts
//      verifyFriendAdd, reused verbatim (no parallel crypto rules).
//
// WIRE KINDS: 'social-mail-send' / 'social-mail-drain' are members of the
// FabricRequestKind union in witness/types.ts (folded in at A7 lane
// integration: the lane originally rode a documented cast because that file
// was out of its set). Every FabricEndpoint implementation routes kinds
// generically by string (MockFabric keeps a Map; the fabric is
// transport-only, C-11: nothing pattern-matches the union at runtime).
//
// §0 stance: the mailbox and presence are C-3 ephemeral coordination state,
// expiring, reconstructible, NO authority. Nothing here mints truth: presence
// feeds no consequence-bearing input; a dropped or evicted mail harms
// liveness, never correctness (friendship itself is the §3 witnessed edge).
// What IS load-bearing: no relay stores spoofed mail (envelope signature
// verified by mailboxAdmit), no store gate accepts an unsigned/oversized/
// malformed record, drains are recipient-root-signed and replay-refused, and
// the §10 invariant, a sybil flood can't evict an established root's request
// before the offline recipient next syncs, holds THROUGH the relay because
// edgeMicro comes only from verified public data (edgeStrength.ts: fresh
// root ⇒ exactly 0) and eviction needs a STRICTLY greater edge.
//
// Determinism rules (suite-load-bearing): platform-neutral (no `node:`
// imports, no DOM globals), no Date.now / Math.random / timers. Clocks are
// injected (nowMs / caller wts). Relay state after any call sequence is a
// pure function of that sequence (mailbox.ts discipline). Fail-closed typed
// refusals everywhere; verifiers never throw, builders throw on misuse.

import { z } from 'zod'
import {
  canonicalBytes,
  compareKeys,
  parseCanonical,
  type CanonicalObject,
  type CanonicalValue,
} from '../codec'
import { zB64u32, zB64u64, zSignedEvent } from '../events'
import { concatBytes, ed25519, fromB64u, sha256, toB64u, utf8, verifySigB64u } from '../hash'
import type { B64u, Chain, FriendPayload, SignedEvent, WitnessEligibility } from '../types'
import type { FabricEndpoint, NodeId } from '../witness/types'
import type { MergeFn } from '../overlay/node'
import { onOverlay, overlayRequest } from '../overlay/rpc'
import type { OverlayNode, StoreValidator, ValueKind } from '../overlay/types'
import { PARAMS_A3 } from '../storage/params'
import { edgeMicroOfChains } from './edgeStrength'
import { makeFriendAddPayload, makeFriendSig, verifyFriendAdd } from './friends'
import {
  mailboxAdmit,
  mailboxDrain,
  mailboxInit,
  mailId,
  PARAMS_SOCIAL_MAILBOX,
  signMail,
  type MailboxParams,
  type MailboxState,
  type MailEnvelope,
  type SignedMail,
} from './mailbox'
import {
  PARAMS_SOCIAL_PRESENCE,
  presenceOf,
  verifySocialPresence,
  type SignedSocialPresence,
  type SocialPresenceParams,
  type SocialPresenceView,
} from './presence'

// ---------------------------------------------------------------------------
// Overlay keys: domain-separated, one per root (pointers.ts key discipline)
// ---------------------------------------------------------------------------

/** Domain separators: fixed forever (derivation is structural; everything
 * revisable rides the records, never the key). */
const PRESENCE_KEY_TAG = 'cs:a7:social-presence-key:v1'
const MAILBOX_KEY_TAG = 'cs:a7:social-mailbox-key:v1'

function taggedRootKey(tag: string, root: B64u): B64u {
  const r = fromB64u(root)
  if (r.length !== 32) throw new Error('social key: root must decode to 32 bytes')
  return toB64u(sha256(concatBytes(utf8(tag), r)))
}

/** The overlay key a root's social presence row lives under (kind 'record').
 * Domain-separated from nodeIdOf(root), pointer keys, shard keys, and the
 * mailbox key: presence floods never contend with anything else. Throws on
 * programmer misuse (builders throw; verifiers fail closed). */
export function presenceKeyOfRoot(root: B64u): B64u {
  return taggedRootKey(PRESENCE_KEY_TAG, root)
}

/** The overlay key a recipient's mailbox RELAYS cluster at: the k closest
 * nodes to this key serve as the recipient's relays (duty-by-distance, the
 * shard rule). No replicated value lives at this key. Mail rides the
 * authenticated send/drain pair, not FIND_VALUE. Throws on misuse. */
export function mailboxKeyOfRoot(recipient: B64u): B64u {
  return taggedRootKey(MAILBOX_KEY_TAG, recipient)
}

// ---------------------------------------------------------------------------
// 1. PRESENCE: row, store gate, merge, publish/fetch
// ---------------------------------------------------------------------------

/** Self-describing discriminant of a presence row under kind 'record'. */
export const SOCIAL_PRESENCE_ROW_T = 'social-presence'

/** The stored/offered value at presenceKeyOfRoot(root): ONE root's freshest
 * verified claim (freshest-wins keeps exactly one; presence is a point
 * value, not a set). */
export interface SocialPresenceRow {
  v: 1
  t: typeof SOCIAL_PRESENCE_ROW_T
  claim: SignedSocialPresence
}

// Shallow row shape only: the DEEP verification (strict claim schema, ttl
// cap, root signature) is presence.ts verifySocialPresence, reused verbatim.
const zPresenceRowShallow = z.strictObject({
  v: z.literal(1),
  t: z.literal(SOCIAL_PRESENCE_ROW_T),
  claim: z.record(z.string(), z.unknown()),
})

/** Wrap a claim for publishing. Throws unless the claim fully verifies.
 * The trusted build path never mints a row the gates would refuse. */
export function makeSocialPresenceRow(
  sp: SignedSocialPresence,
  params: SocialPresenceParams = PARAMS_SOCIAL_PRESENCE,
): SocialPresenceRow {
  if (!verifySocialPresence(sp, params))
    throw new Error('makeSocialPresenceRow: claim does not verify under the given params')
  return { v: 1, t: SOCIAL_PRESENCE_ROW_T, claim: sp }
}

/** Does a stored/offered value claim to be a social-presence row? A value
 * that CLAIMS the discriminant but fails the full gate is REFUSED, never
 * passed through to a (possibly permissive) base validator. */
export function looksLikeSocialPresenceRow(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { t?: unknown }).t === SOCIAL_PRESENCE_ROW_T
  )
}

/** Extract the verified claim of a row bound to `target`, or null (fail
 * closed). Signature/shape/ttl-cap via verifySocialPresence; binding =
 * presenceKeyOfRoot(claim.root) === target (the pointer-layer rule: a row
 * can never squat a foreign key). Clock-free: freshness bounds live in the
 * store gate (write time) and presenceOf (read time). */
export function presenceRowClaim(
  value: unknown,
  target: B64u,
  params: SocialPresenceParams = PARAMS_SOCIAL_PRESENCE,
): SignedSocialPresence | null {
  try {
    if (!zPresenceRowShallow.safeParse(value).success) return null
    const sp = (value as SocialPresenceRow).claim
    if (!verifySocialPresence(sp, params)) return null
    if (presenceKeyOfRoot(sp.body.root) !== target) return null
    return sp
  } catch {
    return null
  }
}

/** presence.ts rule-4 ordering: freshest body.ts wins; exact tie broken by
 * the lexicographically GREATER sig. A pure function of the claim pair. */
function fresherClaim(a: SignedSocialPresence, b: SignedSocialPresence): SignedSocialPresence {
  if (a.body.ts !== b.body.ts) return a.body.ts > b.body.ts ? a : b
  return compareKeys(a.sig, b.sig) > 0 ? a : b
}

export interface SocialStoreGateOpts {
  /** Injected clock (ms). REQUIRED. No ambient time (write-side freshness). */
  nowMs: () => number
  /** Presence rule set; default PARAMS_SOCIAL_PRESENCE. */
  presence?: SocialPresenceParams
  /** Fallback gate for values this layer does not own. Default mirrors the
   * overlay's own default (accept 'record', refuse the rest): compose with
   * makePointerStoreValidator/makeShardStoreValidator via THEIR `base`. */
  base?: StoreValidator
  /** Fallback merge for values this layer does not own. Default: replace. */
  baseMerge?: MergeFn
}

export interface SocialStoreGate {
  validator: StoreValidator
  merge: MergeFn
}

/**
 * Build the social layer's store gate for one node (install as the overlay
 * node's validator+merge, wrapping the storage layer's own gate as `base`).
 *
 * VALIDATOR (write time, clock-bounded): a value claiming the presence
 * discriminant is accepted only if the full claim verifies (strict shape,
 * ttl ≤ params cap, ed25519 by the ROOT), is bound to the target key, and is
 * LIVE at this node's injected clock. Not expired (now − ts ≤ ttl) and not
 * implausibly future (ts − now ≤ skewMax). Everything else about it refuses:
 * unsigned, forged, oversized-ttl, malformed, foreign-key. All stored:false
 * (honest degradation, never an error).
 *
 * MERGE (store fold AND read-side getMerged fold): freshest-wins between the
 * verified claims of prev and next (rule-4 ordering above). Deliberately
 * clock-free so the fold is a pure function of the value pair; an unverifiable
 * side simply loses to a verifiable one, and a wholly unverifiable pair folds
 * to the prev value (never manufactured junk).
 */
export function makeSocialStoreGate(opts: SocialStoreGateOpts): SocialStoreGate {
  const params = opts.presence ?? PARAMS_SOCIAL_PRESENCE
  const base: StoreValidator = opts.base ?? ((_f, _t, kind, _v) => kind === 'record')
  const baseMerge: MergeFn = opts.baseMerge ?? ((_prev, next) => next)

  const validator: StoreValidator = (from, target, kind, value) => {
    try {
      if (kind !== 'record' || !looksLikeSocialPresenceRow(value))
        return base(from, target, kind, value)
      const sp = presenceRowClaim(value, target, params)
      if (sp === null) return false
      const now = Math.floor(opts.nowMs())
      if (!Number.isSafeInteger(now) || now < 0) return false
      if (now - sp.body.ts > sp.body.ttlMs) return false // expired at write
      if (sp.body.ts - now > params.skewMaxMs) return false // implausible future
      return true
    } catch {
      return false // gates fail closed, never throw into the overlay
    }
  }

  const merge: MergeFn = (prev, next, kind, target) => {
    try {
      const nextSocial = looksLikeSocialPresenceRow(next)
      const prevSocial = looksLikeSocialPresenceRow(prev)
      if (kind !== 'record' || (!nextSocial && !prevSocial))
        return baseMerge(prev, next, kind, target)
      const cN = nextSocial ? presenceRowClaim(next, target, params) : null
      const cP = prevSocial && prev !== null ? presenceRowClaim(prev, target, params) : null
      if (cN !== null && cP !== null)
        return { v: 1, t: SOCIAL_PRESENCE_ROW_T, claim: fresherClaim(cN, cP) } as unknown as CanonicalObject
      if (cN !== null) return { v: 1, t: SOCIAL_PRESENCE_ROW_T, claim: cN } as unknown as CanonicalObject
      if (cP !== null) return { v: 1, t: SOCIAL_PRESENCE_ROW_T, claim: cP } as unknown as CanonicalObject
      // Neither side is a VERIFIED presence claim bound to THIS key (a
      // shape-only lookalike, an unverifiable claim, or a foreign-key row).
      // DELEGATE to baseMerge: do NOT manufacture an empty presence row.
      // KEY-DOMAIN DISCIPLINE (Round-A composition finding): a manufactured
      // {t:'social-presence'} row is self-recognized as social and would shadow
      // a co-installed layer's genuine row (e.g. the composed verdict gate) for
      // the rest of a getMerged fold. Standalone baseMerge = replace, which the
      // read path (presenceRowClaim) still rejects as "no presence"; the store
      // validator already refused an unverifiable claim at write time.
      return baseMerge(prev, next, kind, target)
    } catch {
      return baseMerge(prev, next, kind, target)
    }
  }

  return { validator, merge }
}

/** Minimal read surface (pointers.ts PointerReadNode discipline): any
 * OverlayNode; with getMerged (OverlayNodeExt) reads fold ALL holders. */
export interface SocialReadNode {
  get(target: B64u, kind: ValueKind): Promise<CanonicalObject | null>
  getMerged?(target: B64u, kind: ValueKind): Promise<CanonicalObject | null>
}

/** Publish a root's presence claim to the replicateK closest nodes (each
 * re-verifies via its own gate). Returns the number of true stores. Throws
 * on a claim the trusted build path should never produce. */
export function publishSocialPresence(
  node: OverlayNode,
  sp: SignedSocialPresence,
  params: SocialPresenceParams = PARAMS_SOCIAL_PRESENCE,
): Promise<number> {
  const row = makeSocialPresenceRow(sp, params)
  return node.put(presenceKeyOfRoot(sp.body.root), 'record', row as unknown as CanonicalObject)
}

/**
 * Fetch + verify a root's presence at witnessed time `nowWts` (caller's, §4).
 * The fetched row is UNTRUSTED: the claim goes through presenceOf. Full
 * signature/shape/ttl verification plus expiry and future-skew at nowWts,
 * and must name the requested root. null = offline/unknown (fail closed).
 */
export async function fetchSocialPresence(
  node: SocialReadNode,
  root: B64u,
  nowWts: number,
  params: SocialPresenceParams = PARAMS_SOCIAL_PRESENCE,
): Promise<SocialPresenceView | null> {
  try {
    const key = presenceKeyOfRoot(root)
    const row = node.getMerged ? await node.getMerged(key, 'record') : await node.get(key, 'record')
    if (row === null) return null
    const sp = presenceRowClaim(row, key, params)
    if (sp === null) return null
    const views = presenceOf([sp], nowWts, params)
    return views.find((v) => v.root === root) ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 2. MAILBOX RELAYING: wire kinds, relay, send, authenticated drain
// ---------------------------------------------------------------------------

/** The two social request kinds: members of witness/types.ts
 * FabricRequestKind (folded into the union at A7 lane integration). */
export const SOCIAL_MAIL_SEND_KIND = 'social-mail-send'
export const SOCIAL_MAIL_DRAIN_KIND = 'social-mail-drain'

/** Wire-sanity cap on one drain response (relay boxCap bounds the real count). */
export const DRAIN_WIRE_MSGS_MAX = 256
/** Drain freshness window: |req.ts − relay now| must sit inside this. */
export const DRAIN_SKEW_MS = 120_000

// Shallow send shape. The DEEP gate (strict envelope schema, payload bound,
// envelope signature by the sender root, self-mail, dedup, rate, fair-share,
// edge-priority eviction) is mailboxAdmit, reused verbatim.
const zMailSendReq = z.strictObject({
  v: z.literal(1),
  mail: z.strictObject({
    body: z.record(z.string(), z.unknown()),
    sig: zB64u64,
  }),
})

const zMailSendRes = z.strictObject({
  v: z.literal(1),
  admitted: z.boolean(),
  reason: z.string().max(32).optional(),
})

const zDrainReqBody = z.strictObject({
  v: z.literal(1),
  t: z.literal('social-mail-drain'),
  recipient: zB64u32,
  /** Requester-claimed ms: bounded by the relay's clock AND strictly
   * monotonic per recipient at each relay (replay refusal). */
  ts: z.int().min(0),
})

const zDrainReq = z.strictObject({ body: zDrainReqBody, sig: zB64u64 })

const zDrainRes = z.strictObject({
  v: z.literal(1),
  msgs: z.array(z.record(z.string(), z.unknown())).max(DRAIN_WIRE_MSGS_MAX),
})

// Strict mirror of mailbox.ts StoredMail for re-verification at the drainer.
const zStoredMailWire = z.strictObject({
  id: zB64u32,
  sender: zB64u32,
  kind: z.string().min(1).max(32),
  payload: z.string(),
  sig: zB64u64,
  sentTs: z.int().min(0),
  arrivedWts: z.int().min(0),
  edgeMicro: z.int().min(0).max(1_000_000),
})

/** The §10 fold seam the relay computes meta.edgeMicro through: MUST derive
 * from public signed data only (edgeStrength.ts is the canonical fold,
 * makeChainEdgeProvider wires it). Never sender-asserted. */
export type EdgeMicroProvider = (sender: B64u, recipient: B64u, nowWts: number) => number

/** Compose the canonical chain-derived provider: `chainOf` is the relay's
 * view of reconstructed chains (its C-1 cache / the overlay's storage layer);
 * absent or unverifiable chains fail toward edge 0 inside the fold. */
export function makeChainEdgeProvider(o: {
  chainOf: (root: B64u) => Chain | null
  eligible?: WitnessEligibility
}): EdgeMicroProvider {
  return (sender, recipient, nowWts) => {
    let senderChain: Chain | null = null
    let recipientChain: Chain | null = null
    try {
      senderChain = o.chainOf(sender) ?? null
      recipientChain = o.chainOf(recipient) ?? null
    } catch {
      /* fail toward no chains ⇒ edge 0 */
    }
    return edgeMicroOfChains({
      sender,
      recipient,
      senderChain,
      recipientChain,
      atWts: nowWts,
      ...(o.eligible !== undefined ? { eligible: o.eligible } : {}),
    })
  }
}

export interface SocialRelayOpts {
  /** Injected clock (ms). REQUIRED. Stamps arrivals and drain windows. */
  nowMs: () => number
  /** The §10 edge fold (makeChainEdgeProvider). A throwing or out-of-range
   * provider degrades to edge 0: an honest sender loses priority, never
   * admission; a forged HIGH edge is impossible from here (fail closed). */
  edgeMicroOf: EdgeMicroProvider
  /** Mailbox rule set; default PARAMS_SOCIAL_MAILBOX (state pins the digest). */
  params?: MailboxParams
  /** Drain freshness window override; default DRAIN_SKEW_MS. */
  drainSkewMs?: number
}

export interface SocialRelay {
  /** Current relay state (test seam + C-1 cache handoff). Never mutated in
   * place. Every admission/drain replaces it wholesale (mailbox.ts). */
  state(): MailboxState
  close(): void
}

/**
 * Install the relay boundary on a fabric endpoint. Every admission decision,
 * including the §10 eviction order, is mailboxAdmit's verbatim; this layer
 * only supplies meta = { nowWts: floor(nowMs()), edgeMicro: fold(...) } and
 * commits the returned state. Drains are authenticated: the request body is
 * ed25519-signed by the RECIPIENT ROOT, must sit inside the relay's freshness
 * window, and must carry a ts STRICTLY greater than the last drained ts for
 * that recipient at this relay: a captured drain replayed later clears
 * nothing (typed 'drain-refused', the rpc.ts error convention).
 */
export function createSocialRelay(fabric: FabricEndpoint, opts: SocialRelayOpts): SocialRelay {
  const params = opts.params ?? PARAMS_SOCIAL_MAILBOX
  const skew = opts.drainSkewMs ?? DRAIN_SKEW_MS
  let state = mailboxInit(params)
  const lastDrainTs = new Map<B64u, number>()
  let closed = false
  const alive = (): boolean => !closed

  onOverlay(fabric, SOCIAL_MAIL_SEND_KIND, zMailSendReq, async (_from, req) => {
    const mail = req.mail as unknown as SignedMail
    const nowWts = Math.floor(opts.nowMs())
    // Loose peek at the routing fields for the edge fold: mailboxAdmit is
    // the authority on the envelope (a lying shape rejects there).
    const b = mail.body as unknown as { sender?: unknown; recipient?: unknown }
    let edge = 0
    if (typeof b.sender === 'string' && typeof b.recipient === 'string') {
      try {
        const raw = opts.edgeMicroOf(b.sender, b.recipient, nowWts)
        edge = Number.isSafeInteger(raw) && raw >= 0 ? Math.min(raw, 1_000_000) : 0
      } catch {
        edge = 0
      }
    }
    const res = mailboxAdmit(state, mail, { nowWts, edgeMicro: edge }, params)
    state = res.state
    return {
      v: 1,
      admitted: res.admitted,
      ...(res.reason !== undefined ? { reason: res.reason } : {}),
    } as unknown as CanonicalObject
  }, alive)

  onOverlay(fabric, SOCIAL_MAIL_DRAIN_KIND, zDrainReq, async (_from, req) => {
    const nowWts = Math.floor(opts.nowMs())
    const body = req.body
    let msg: Uint8Array
    try {
      msg = canonicalBytes(body as unknown as CanonicalValue)
    } catch {
      return { error: 'drain-refused' }
    }
    if (!verifySigB64u(req.sig, msg, body.recipient)) return { error: 'drain-refused' }
    if (!Number.isSafeInteger(nowWts) || nowWts < 0) return { error: 'drain-refused' }
    if (Math.abs(body.ts - nowWts) > skew) return { error: 'drain-refused' } // stale or future
    const last = lastDrainTs.get(body.recipient)
    if (last !== undefined && body.ts <= last) return { error: 'drain-refused' } // replay
    const res = mailboxDrain(state, body.recipient, nowWts, params)
    state = res.state
    lastDrainTs.set(body.recipient, body.ts)
    return { v: 1, msgs: res.msgs } as unknown as CanonicalObject
  }, alive)

  return {
    state: () => state,
    close: () => {
      closed = true
    },
  }
}

/** Relay selection: the replicateK overlay-closest nodes to the recipient's
 * mailbox key, self excluded (a node never fabric-requests itself; its own
 * relay copy would be redundant with the k−1 others). */
async function relayTargets(
  node: OverlayNode,
  recipient: B64u,
  replicateK: number,
): Promise<NodeId[]> {
  const closest = await node.lookup(mailboxKeyOfRoot(recipient))
  return closest
    .filter((c) => c.nodeId !== node.nodeId)
    .slice(0, replicateK)
    .map((c) => c.nodeId)
}

export interface SendMailResult {
  /** Relays offered to (lookup-closest, self excluded). */
  offered: number
  /** Relays that admitted the mail. */
  admitted: number
  /** Per-relay outcome in offer order ('admitted' or the typed reject). */
  outcomes: string[]
}

/**
 * Offer signed mail to the recipient's relays. The mail must already be
 * signMail-signed by the SENDER ROOT (mailbox.ts rule, relays refuse
 * anything else). Refusals are honest degradation, never errors.
 */
export async function sendSocialMail(
  fabric: FabricEndpoint,
  node: OverlayNode,
  mail: SignedMail,
  o: { replicateK?: number } = {},
): Promise<SendMailResult> {
  const recipient = (mail.body as { recipient?: unknown }).recipient
  if (typeof recipient !== 'string') throw new Error('sendSocialMail: mail has no recipient')
  const targets = await relayTargets(node, recipient, o.replicateK ?? PARAMS_A3.replicateK)
  const outcomes: string[] = []
  let admitted = 0
  for (const to of targets) {
    const r = await overlayRequest(
      fabric,
      to,
      SOCIAL_MAIL_SEND_KIND,
      { v: 1, mail } as unknown as CanonicalObject,
      zMailSendRes,
    )
    if (r.ok && r.res.admitted) {
      admitted++
      outcomes.push('admitted')
    } else {
      outcomes.push(r.ok ? (r.res.reason ?? 'refused') : r.reason)
    }
  }
  return { offered: targets.length, admitted, outcomes }
}

/** One drained message, RE-VERIFIED at the drainer (see verifyDrainedMail). */
export interface DrainedMail {
  mail: SignedMail
  /** Highest relay-frozen edge observed for this id (priority ordering). */
  edgeMicro: number
  /** Earliest relay arrival observed for this id. */
  arrivedWts: number
}

/**
 * Re-verify one relay-returned StoredMail against the RECIPIENT's own root:
 * strict shape, envelope reconstruction, id binding (mailId), and the sender
 * root's ed25519 over the canonical envelope. A malicious relay can drop or
 * reorder mail (liveness, C-3): it can NEVER inject mail a sender didn't
 * sign, or rebind mail to a different recipient (§0). null = discard.
 */
export function verifyDrainedMail(m: unknown, recipient: B64u): DrainedMail | null {
  try {
    const p = zStoredMailWire.safeParse(m)
    if (!p.success) return null
    const s = p.data
    if (s.sender === recipient) return null
    const env: MailEnvelope = {
      v: 1,
      sender: s.sender,
      recipient,
      kind: s.kind,
      payload: s.payload,
      sentTs: s.sentTs,
    }
    if (mailId(env) !== s.id) return null
    if (!verifySigB64u(s.sig, canonicalBytes(env), s.sender)) return null
    return {
      mail: { body: env, sig: s.sig },
      edgeMicro: s.edgeMicro,
      arrivedWts: s.arrivedWts,
    }
  } catch {
    return null
  }
}

/**
 * The recipient syncs: sign one drain request (ROOT key), present it to every
 * relay, union the verified results (dedup by mail id; edge folds to max and
 * arrival to min, order-independent), and hand back the §10 priority order:
 * edgeMicro DESC, arrivedWts ASC, id ASC: established and earliest first,
 * exactly mailboxDrain's comparator applied to the union. Throws only on
 * programmer misuse (priv not matching recipient); relay refusals and forged
 * messages are silently dropped (fail closed).
 */
export async function drainSocialMailbox(
  fabric: FabricEndpoint,
  node: OverlayNode,
  o: { recipient: B64u; rootPriv: Uint8Array; ts: number; replicateK?: number },
): Promise<DrainedMail[]> {
  if (toB64u(ed25519.getPublicKey(o.rootPriv)) !== o.recipient)
    throw new Error('drainSocialMailbox: rootPriv does not match recipient')
  if (!Number.isSafeInteger(o.ts) || o.ts < 0)
    throw new Error('drainSocialMailbox: ts must be a non-negative integer')
  const body = { v: 1, t: 'social-mail-drain', recipient: o.recipient, ts: o.ts }
  const sig = toB64u(ed25519.sign(canonicalBytes(body), o.rootPriv))
  const targets = await relayTargets(node, o.recipient, o.replicateK ?? PARAMS_A3.replicateK)
  const byId = new Map<B64u, DrainedMail>()
  for (const to of targets) {
    const r = await overlayRequest(
      fabric,
      to,
      SOCIAL_MAIL_DRAIN_KIND,
      { body, sig } as unknown as CanonicalObject,
      zDrainRes,
    )
    if (!r.ok) continue
    for (const raw of r.res.msgs) {
      const dm = verifyDrainedMail(raw, o.recipient)
      if (dm === null) continue
      const id = mailId(dm.mail.body)
      const prev = byId.get(id)
      if (prev === undefined) {
        byId.set(id, dm)
      } else {
        byId.set(id, {
          mail: prev.mail,
          edgeMicro: Math.max(prev.edgeMicro, dm.edgeMicro),
          arrivedWts: Math.min(prev.arrivedWts, dm.arrivedWts),
        })
      }
    }
  }
  const out = [...byId.entries()]
  out.sort((a, b) => {
    if (a[1].edgeMicro !== b[1].edgeMicro) return b[1].edgeMicro - a[1].edgeMicro
    if (a[1].arrivedWts !== b[1].arrivedWts) return a[1].arrivedWts - b[1].arrivedWts
    return compareKeys(a[0], b[0])
  })
  return out.map(([, dm]) => dm)
}

// ---------------------------------------------------------------------------
// 3. FRIEND-EDGE COUNTERSIGNATURE EXCHANGE (riding the mailbox)
// ---------------------------------------------------------------------------

export const MAIL_KIND_FRIEND_REQUEST = 'friend-request'
export const MAIL_KIND_FRIEND_CONSENT = 'friend-consent'

/**
 * One party's HALF of a §3 friend edge: `sig` is makeFriendSig output. The
 * party's ed25519 over friendBytes(from, to), the SORTED-PAIR canonical
 * bytes binding BOTH roots, so a half minted for (from, to) verifies for no
 * other pair (unreplayable by construction; friends.ts owns the rule). `key`
 * is the signer (the `from` root or a certified child; `certs` prove the
 * child, required iff key !== from). The COUNTERPARTY (`to`) turns a half
 * into its own chain's 'friend' add via friendHalfToAddPayload.
 */
export interface FriendHalf {
  v: 1
  t: 'friend-half'
  /** The half's minter. The root whose consent this half proves. */
  from: B64u
  /** The counterparty root the edge binds to (the half's only valid user). */
  to: B64u
  key: B64u
  sig: B64u
  certs?: SignedEvent[]
}

const zFriendHalf = z.strictObject({
  v: z.literal(1),
  t: z.literal('friend-half'),
  from: zB64u32,
  to: zB64u32,
  key: zB64u32,
  sig: zB64u64,
  certs: z.array(zSignedEvent).min(1).max(4).optional(),
})

/**
 * Convert a half into the FriendPayload the `to` side appends to ITS OWN
 * chain. Then prove it with friends.ts verifyFriendAdd (the ONE verifier:
 * schema, no self-edge, key provenance via inline root-signed certs, and the
 * signature over the two-root-bound bytes). null = refuse (fail closed):
 * forged, tampered, or cross-pair-replayed halves all die here.
 */
export function friendHalfToAddPayload(half: unknown): FriendPayload | null {
  try {
    const p = zFriendHalf.safeParse(half)
    if (!p.success) return null
    const h = half as FriendHalf
    if (h.from === h.to) return null
    const payload = makeFriendAddPayload({
      peer: h.from,
      key: h.key,
      sig: h.sig,
      ...(h.certs !== undefined ? { certs: h.certs } : {}),
    })
    return verifyFriendAdd(payload, h.to) ? payload : null
  } catch {
    return null
  }
}

/** Full half verification (shape + the derived add proving out). */
export function verifyFriendHalf(half: unknown): FriendHalf | null {
  return friendHalfToAddPayload(half) === null ? null : (half as FriendHalf)
}

/**
 * Mint this party's half toward `peerRoot`, signing friendBytes(selfRoot,
 * peerRoot) with `priv` (the selfRoot key itself, or a certified child whose
 * root-signed cert events ride along). Trusted build path. Throws unless
 * the result fully verifies.
 */
export function makeFriendHalf(o: {
  selfRoot: B64u
  peerRoot: B64u
  key: B64u
  priv: Uint8Array
  certs?: SignedEvent[]
}): FriendHalf {
  if (toB64u(ed25519.getPublicKey(o.priv)) !== o.key)
    throw new Error('makeFriendHalf: priv does not match key')
  const half: FriendHalf = {
    v: 1,
    t: 'friend-half',
    from: o.selfRoot,
    to: o.peerRoot,
    key: o.key,
    sig: makeFriendSig(o.priv, o.selfRoot, o.peerRoot),
    ...(o.certs !== undefined ? { certs: o.certs } : {}),
  }
  if (verifyFriendHalf(half) === null)
    throw new Error('makeFriendHalf: built half does not verify (bad certs/key provenance?)')
  return half
}

/** Deterministic mail-payload codec for a half: b64u of the canonical bytes
 * (codec-exact both ways; no JSON.parse of untrusted text). */
export function encodeFriendHalf(half: FriendHalf): string {
  return toB64u(canonicalBytes(half as unknown as CanonicalValue))
}

/** Decode + FULLY verify a half from a mail payload. null = refuse. */
export function decodeFriendHalf(payload: string): FriendHalf | null {
  try {
    return verifyFriendHalf(parseCanonical(fromB64u(payload)))
  } catch {
    return null
  }
}

function makeFriendMail(
  kind: string,
  o: {
    selfRoot: B64u
    peerRoot: B64u
    key: B64u
    priv: Uint8Array
    certs?: SignedEvent[]
    /** SENDER ROOT private key: the envelope signer (mailbox.ts rule; the
     * half's `priv` may be a device key, the envelope's may not). */
    rootPriv: Uint8Array
    sentTs: number
    params?: MailboxParams
  },
): SignedMail {
  if (toB64u(ed25519.getPublicKey(o.rootPriv)) !== o.selfRoot)
    throw new Error('makeFriendMail: rootPriv does not match selfRoot')
  const half = makeFriendHalf(o)
  const payload = encodeFriendHalf(half)
  const max = (o.params ?? PARAMS_SOCIAL_MAILBOX).payloadMaxChars
  if (payload.length > max)
    throw new Error(`makeFriendMail: encoded half exceeds payloadMaxChars (${payload.length} > ${max}), too many certs`)
  const env: MailEnvelope = {
    v: 1,
    sender: o.selfRoot,
    recipient: o.peerRoot,
    kind,
    payload,
    sentTs: o.sentTs,
  }
  return signMail(env, o.rootPriv)
}

/** The REQUEST leg: the requester's half riding a 'friend-request' mail. */
export function makeFriendRequestMail(o: Parameters<typeof makeFriendMail>[1]): SignedMail {
  return makeFriendMail(MAIL_KIND_FRIEND_REQUEST, o)
}

/** The CONSENT leg: the consenter's half riding a 'friend-consent' mail. */
export function makeFriendConsentMail(o: Parameters<typeof makeFriendMail>[1]): SignedMail {
  return makeFriendMail(MAIL_KIND_FRIEND_CONSENT, o)
}

/**
 * Read a friend-exchange mail (drained + verifyDrainedMail'd, or received
 * live) into its verified half. Refuses (null): wrong kind; a half whose
 * minter is not the envelope SENDER or whose counterparty is not the envelope
 * RECIPIENT (no third-party smuggling of someone else's half); any half that
 * fails full verification; a bad envelope signature. Fail closed, total.
 */
export function readFriendMail(
  mail: SignedMail,
  expectKind: string = MAIL_KIND_FRIEND_REQUEST,
): FriendHalf | null {
  try {
    if (mail.body.kind !== expectKind) return null
    if (!verifySigB64u(mail.sig, canonicalBytes(mail.body), mail.body.sender)) return null
    const half = decodeFriendHalf(mail.body.payload)
    if (half === null) return null
    if (half.from !== mail.body.sender || half.to !== mail.body.recipient) return null
    return half
  } catch {
    return null
  }
}

/**
 * CONSENT step (the recipient of a request): validate the requester's half
 * against SELF, and return the FriendPayload to append to the OWN chain (the
 * witnessed-lane 'friend' add: chain.ts appendWitnessed is the caller's, as
 * everywhere in the pure social layer). The consent mail back to the
 * requester is makeFriendConsentMail. null = the request does not verify or
 * does not bind to self (fail closed).
 */
export function consentToFriendRequest(request: FriendHalf, selfRoot: B64u): FriendPayload | null {
  if (verifyFriendHalf(request) === null) return null
  if (request.to !== selfRoot) return null
  return friendHalfToAddPayload(request)
}

/** ADOPT step (the original requester, on draining the consent): same rule,
 * from the consent half, PLUS the requester binds the consent to the peer it
 * actually asked (`expectedPeer`): an unsolicited "consent" from a stranger
 * must not auto-append an edge the requester never requested (it is a signed
 * half, i.e. a REQUEST, and goes through the consent flow instead). Appending
 * the returned payload completes the §3 mutual edge. Both chains then read
 * friends (friends.ts areFriends). */
export function adoptFriendConsent(
  consent: FriendHalf,
  selfRoot: B64u,
  expectedPeer?: B64u,
): FriendPayload | null {
  if (expectedPeer !== undefined && (consent as { from?: unknown }).from !== expectedPeer) return null
  return consentToFriendRequest(consent, selfRoot)
}
