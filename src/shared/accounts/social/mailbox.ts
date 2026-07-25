// A6 social surface: MAILBOX + ANTI-SPAM (spec §10, C-3). The store-and-
// forward box a relaying peer keeps for an offline recipient (friend requests
// and similar), with the §10 flood defense implemented EXACTLY:
//
//   "relaying peers enforce per-sender-root rate limits + per-recipient
//    fair-share quotas, prioritizing senders with an existing entanglement/
//    trust/reputation edge, so a sybil flood can't evict requests from
//    established roots before the offline recipient next syncs."
//
// Modeled as a deterministic PURE structure: mailboxAdmit(state, msg, meta)
// → { state', admitted, reason?, evicted? }. No I/O, no ambient time:
// meta.nowWts is the caller's witnessed-time input (§4), and meta.edgeMicro
// is the caller-VERIFIED edge strength of the sender toward the recipient
// (entanglement / trust / reputation, folded to one integer in [0, 1e6] by
// the relay from public signed data. Never self-asserted by the sender, §0).
// This module trusts meta exactly as far as its shape: the cryptographic
// verification of edges is the caller's job because it requires chains, which
// this bounded structure deliberately does not hold. What IS verified here,
// unconditionally: the envelope's ed25519 signature by the SENDER ROOT. A
// relay must never store spoofed mail, or the flood defense is defeated by
// impersonating established senders. Fail-closed typed rejections everywhere.
//
// C-3 honesty: this state is ephemeral coordination. Expiring (retentionMs),
// reconstructible (senders just re-send), NO authority (a dropped request
// harms liveness, never truth; friendship itself is the §3 witnessed edge,
// not the mailbox). Honest players are never *harmed*: the §10 invariant
// asserted in scripts/test-accounts-mailbox.mjs is that an established
// root's admitted message CANNOT be evicted by any number of fresh roots.
//
// DETERMINISM: state is a CanonicalObject (plain objects/arrays, integers
// and strings only) so canonicalHash(state) is the bit-identity anchor. The
// state after any call sequence is a pure function of that sequence. Eager
// global pruning on every state-MODIFYING call (trust.ts discipline: rejected-
// before-prune inputs return the SAME state reference), explicit caps on
// every axis, and a documented total eviction order.
//
// Platform-neutral: no `node:` imports, no DOM, no Date.now/Math.random.

import { z } from 'zod'
import { canonicalBytes, canonicalHash, compareKeys, type CanonicalObject } from '../codec'
import { zB64u32, zB64u64 } from '../events'
import { ed25519, toB64u, verifySigB64u } from '../hash'
import type { B64u } from '../types'

// ---------------------------------------------------------------------------
// Parameters (C-3 revisable coordination params; state pins the digest so two
// relays folding under different rule sets fail closed instead of diverging)
// ---------------------------------------------------------------------------

export interface MailboxParams extends CanonicalObject {
  v: number
  /** Per-sender-root fixed rate window, ms. */
  rateWindowMs: number
  /** Max ADMITTED messages per sender root per window (across all recipients). */
  ratePerWindow: number
  /** Max stored messages per recipient box. */
  boxCap: number
  /** Fair share: max slots one sender root may hold in one recipient's box. */
  perSenderPerBox: number
  /** Max recipient boxes one relay tracks. */
  recipientsCap: number
  /** Max sender rate-windows tracked (bounded rate-limiter memory). */
  sendersCap: number
  /** Stored mail older than this is pruned, ms. */
  retentionMs: number
  /** Max payload chars (opaque string, ciphertext/b64u, relay never reads it). */
  payloadMaxChars: number
}

export const PARAMS_SOCIAL_MAILBOX = {
  v: 1,
  rateWindowMs: 3_600_000, // 1 h
  ratePerWindow: 8,
  boxCap: 64,
  perSenderPerBox: 4,
  recipientsCap: 512,
  sendersCap: 4096,
  retentionMs: 14 * 86_400_000, // 14 d
  payloadMaxChars: 2048,
} as const satisfies MailboxParams

export function mailboxParamsDigest(params: MailboxParams): string {
  return toB64u(canonicalHash(params))
}

export const PARAMS_SOCIAL_MAILBOX_DIGEST: string = mailboxParamsDigest(PARAMS_SOCIAL_MAILBOX)

// ---------------------------------------------------------------------------
// Envelope: what a sender signs. The relay treats payload as opaque.
// ---------------------------------------------------------------------------

export interface MailEnvelope extends CanonicalObject {
  v: 1
  /** Sender ROOT public key. Also the signer of this envelope. */
  sender: B64u
  /** Recipient ROOT public key. */
  recipient: B64u
  /** Message kind, e.g. 'friend-request' (1..32 chars). */
  kind: string
  /** Opaque bounded payload. The relay never interprets it. */
  payload: string
  /** Sender-claimed unix ms: informational + id uniqueness; never trusted. */
  sentTs: number
}

export interface SignedMail {
  body: MailEnvelope
  sig: B64u
}

/** Message id: sha256 of the canonical envelope bytes (dedup/replay anchor). */
export function mailId(body: MailEnvelope): B64u {
  return toB64u(canonicalHash(body))
}

/** Sign an envelope with the SENDER ROOT private key matching body.sender. Pure. */
export function signMail(body: MailEnvelope, senderRootPriv: Uint8Array): SignedMail {
  return { body, sig: toB64u(ed25519.sign(canonicalBytes(body), senderRootPriv)) }
}

// ---------------------------------------------------------------------------
// State (CanonicalObject: plain objects, arrays, integers, strings)
// ---------------------------------------------------------------------------

export interface StoredMail extends CanonicalObject {
  id: B64u
  sender: B64u
  kind: string
  payload: string
  sig: B64u
  sentTs: number
  /** Relay-stamped witnessed arrival time (meta.nowWts at admit). */
  arrivedWts: number
  /** The sender's caller-verified edge toward the recipient, frozen at admit. */
  edgeMicro: number
}

export interface SenderWindow extends CanonicalObject {
  winStartWts: number
  count: number
}

export interface MailboxState extends CanonicalObject {
  v: 1
  /** Digest of the MailboxParams this state was built under (fail-closed pin). */
  params: B64u
  /** Recipient root → stored mail, admit order. */
  boxes: { readonly [recipient: string]: readonly StoredMail[] }
  /** Sender root → rate window. */
  senders: { readonly [sender: string]: SenderWindow }
}

/** Fresh empty relay state pinned to a params rule set. */
export function mailboxInit(params: MailboxParams = PARAMS_SOCIAL_MAILBOX): MailboxState {
  return { v: 1, params: mailboxParamsDigest(params), boxes: {}, senders: {} }
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/** Caller-verified admission facts. NEVER derived from the message itself. */
export interface AdmitMeta {
  /** Witnessed time of arrival (§4). The caller's clock discipline, not ours. */
  nowWts: number
  /**
   * Sender→recipient edge strength in micro-units [0, 1e6], computed by the
   * relay from PUBLIC SIGNED DATA (a §3 witnessed friend/game edge, mm/trust
   * T, §6b reputation. Caller's fold). 0 = no known edge (fresh root).
   */
  edgeMicro: number
}

const zMailEnvelope = z.strictObject({
  v: z.literal(1),
  sender: zB64u32,
  recipient: zB64u32,
  kind: z.string().min(1).max(32),
  payload: z.string(),
  sentTs: z.int().min(0),
})
const zSignedMail = z.strictObject({ body: zMailEnvelope, sig: zB64u64 })
const zAdmitMeta = z.strictObject({
  nowWts: z.int().min(0),
  edgeMicro: z.int().min(0).max(1_000_000),
})

export type MailboxReject =
  | 'bad-shape' //      envelope failed strict shape or payload bounds
  | 'bad-meta' //       meta failed strict shape (non-integer, out of range)
  | 'params-mismatch' //state pinned to a different params digest
  | 'bad-sig' //        envelope signature does not verify under body.sender
  | 'self-mail' //      sender === recipient
  | 'duplicate' //      same mail id already stored in the recipient's box
  | 'rate-limited' //   sender exceeded ratePerWindow in the current window
  | 'relay-full' //     new recipient box would exceed recipientsCap
  | 'sender-share' //   sender already holds perSenderPerBox slots in this box
  | 'box-full' //       box at cap and no strictly-lower-edge message to evict

export interface AdmitResult {
  state: MailboxState
  admitted: boolean
  reason?: MailboxReject
  /** Present iff admission displaced a stored message (see eviction order). */
  evicted?: StoredMail
}

/**
 * Pure admission fold. Check pipeline, in this exact order (documented so the
 * rejection reason is itself deterministic):
 *
 *   1. 'bad-shape'       strict envelope shape + payload ≤ payloadMaxChars
 *   2. 'bad-meta'        strict meta shape (integers in range)
 *   3. 'params-mismatch' state.params ≠ digest(params)
 *   4. 'bad-sig'         ed25519 by body.sender over canonicalBytes(body)
 *   5. 'self-mail'       sender === recipient.
 *      Rejections 1..5 are PURE: the returned state is the SAME reference.
 *   6. PRUNE             global eager prune (expired mail + expired windows);
 *                        every later outcome, admitted or not, returns state'
 *   7. 'duplicate'       id already in the recipient's box (checked BEFORE the
 *                        rate charge, so replaying a captured envelope cannot
 *                        burn the sender's own budget)
 *   8. 'rate-limited'    sender's fixed window ≥ ratePerWindow (window rolls
 *                        when nowWts ≥ winStartWts + rateWindowMs; only
 *                        ADMITTED messages are ever counted, never refunded)
 *   9. 'relay-full'      recipient box absent and boxes at recipientsCap (a
 *                        new recipient NEVER evicts another recipient's box:
 *                        otherwise sybil recipients could flush real boxes)
 *  10. 'sender-share'    sender already holds perSenderPerBox slots in box
 *  11. 'box-full'        box at boxCap: the eviction candidate is the stored
 *                        message minimal by (edgeMicro ASC, arrivedWts DESC,
 *                        id DESC by compareKeys), i.e. weakest edge first,
 *                        then the NEWEST arrival (earliest-received mail of a
 *                        class is retained longest), then the greater id.
 *                        Admit-with-eviction iff msg.edgeMicro is STRICTLY
 *                        greater than the candidate's; equal edge ⇒ reject
 *                        (first-come wins within a class). THE §10 INVARIANT
 *                        FALLS OUT: a fresh root (edge 0) can never satisfy
 *                        0 > candidate.edge for any established (edge ≥ 1)
 *                        message, so no sybil flood of ANY size evicts an
 *                        established root's request. The converse also holds:
 *                        an established sender always displaces sybil mail
 *                        from a full box.
 *  12. admit             append StoredMail (arrival stamped nowWts, edge
 *                        frozen), charge the sender window; a NEW window at
 *                        sendersCap evicts the tracked window minimal by
 *                        (winStartWts ASC, sender ASC by compareKeys).
 *                        HONEST TRADEOFF (A6 review mailbox-1): prune (step
 *                        6) already dropped every EXPIRED window, so the
 *                        evicted window is an ACTIVE one. That sender's
 *                        rate limit resets early. Deterministic bounded
 *                        memory is chosen over a perfect limiter at the cap;
 *                        sendersCap must be sized so rotation is rare, and a
 *                        flood cannot exploit it: each fresh sender burns
 *                        its own window slot and box admission still gates
 *                        on edge priority + per-box caps.
 *
 * Same (state, msg, meta, params) ⇒ bit-identical result, every platform.
 */
export function mailboxAdmit(
  state: MailboxState,
  msg: SignedMail,
  meta: AdmitMeta,
  params: MailboxParams = PARAMS_SOCIAL_MAILBOX,
): AdmitResult {
  // 1..5: pure gate, state untouched (same reference) on rejection.
  if (!zSignedMail.safeParse(msg).success || msg.body.payload.length > params.payloadMaxChars)
    return { state, admitted: false, reason: 'bad-shape' }
  if (!zAdmitMeta.safeParse(meta).success) return { state, admitted: false, reason: 'bad-meta' }
  if (state.params !== mailboxParamsDigest(params))
    return { state, admitted: false, reason: 'params-mismatch' }
  let bytes: Uint8Array
  try {
    bytes = canonicalBytes(msg.body)
  } catch {
    return { state, admitted: false, reason: 'bad-shape' }
  }
  if (!verifySigB64u(msg.sig, bytes, msg.body.sender)) return { state, admitted: false, reason: 'bad-sig' }
  const { sender, recipient } = msg.body
  if (sender === recipient) return { state, admitted: false, reason: 'self-mail' }

  // 6: prune, then work on mutable copies (state' from here on).
  const { boxes, senders } = prune(state, meta.nowWts, params)
  const pruned: MailboxState = { v: 1, params: state.params, boxes, senders }

  // 7: dedup before any charge.
  const id = mailId(msg.body)
  const box = boxes[recipient] ?? []
  if (box.some((m) => m.id === id)) return { state: pruned, admitted: false, reason: 'duplicate' }

  // 8: per-sender-root rate limit (fixed window, global across recipients).
  const win = senders[sender]
  const rolled = !win || meta.nowWts >= win.winStartWts + params.rateWindowMs
  const count = rolled ? 0 : win.count
  if (count >= params.ratePerWindow) return { state: pruned, admitted: false, reason: 'rate-limited' }

  // 9: recipient capacity (no cross-recipient eviction, ever).
  if (!(recipient in boxes) && Object.keys(boxes).length >= params.recipientsCap)
    return { state: pruned, admitted: false, reason: 'relay-full' }

  // 10: fair share inside the box.
  let senderHeld = 0
  for (const m of box) if (m.sender === sender) senderHeld++
  if (senderHeld >= params.perSenderPerBox)
    return { state: pruned, admitted: false, reason: 'sender-share' }

  // 11. Box capacity + priority eviction.
  let nextBox = box
  let evicted: StoredMail | undefined
  if (box.length >= params.boxCap) {
    let cand = 0
    for (let i = 1; i < box.length; i++) if (evictionBefore(box[i], box[cand])) cand = i
    if (!(meta.edgeMicro > box[cand].edgeMicro))
      return { state: pruned, admitted: false, reason: 'box-full' }
    evicted = box[cand]
    nextBox = box.filter((_, i) => i !== cand)
  }

  // 12. Admit + charge.
  const stored: StoredMail = {
    id,
    sender,
    kind: msg.body.kind,
    payload: msg.body.payload,
    sig: msg.sig,
    sentTs: msg.body.sentTs,
    arrivedWts: meta.nowWts,
    edgeMicro: meta.edgeMicro,
  }
  const nextBoxes = { ...boxes, [recipient]: [...nextBox, stored] }
  const nextSenders: Record<string, SenderWindow> = { ...senders }
  if (!(sender in nextSenders) && Object.keys(nextSenders).length >= params.sendersCap) {
    let victim: string | undefined
    for (const s of Object.keys(nextSenders)) {
      if (
        victim === undefined ||
        nextSenders[s].winStartWts < nextSenders[victim].winStartWts ||
        (nextSenders[s].winStartWts === nextSenders[victim].winStartWts && compareKeys(s, victim) < 0)
      )
        victim = s
    }
    if (victim !== undefined) delete nextSenders[victim]
  }
  nextSenders[sender] = rolled
    ? { winStartWts: meta.nowWts, count: 1 }
    : { winStartWts: win!.winStartWts, count: count + 1 }
  return {
    state: { v: 1, params: state.params, boxes: nextBoxes, senders: nextSenders },
    admitted: true,
    ...(evicted !== undefined ? { evicted } : {}),
  }
}

/** True iff a is evicted before b: edgeMicro ASC, then arrivedWts DESC, then id DESC. */
function evictionBefore(a: StoredMail, b: StoredMail): boolean {
  if (a.edgeMicro !== b.edgeMicro) return a.edgeMicro < b.edgeMicro
  if (a.arrivedWts !== b.arrivedWts) return a.arrivedWts > b.arrivedWts
  return compareKeys(a.id, b.id) > 0
}

/** Global eager prune: drop expired mail, drop emptied boxes, drop expired windows. */
function prune(
  state: MailboxState,
  nowWts: number,
  params: MailboxParams,
): { boxes: Record<string, readonly StoredMail[]>; senders: Record<string, SenderWindow> } {
  const boxes: Record<string, readonly StoredMail[]> = {}
  for (const r of Object.keys(state.boxes)) {
    const kept = state.boxes[r].filter((m) => nowWts - m.arrivedWts < params.retentionMs)
    if (kept.length > 0) boxes[r] = kept
  }
  const senders: Record<string, SenderWindow> = {}
  for (const s of Object.keys(state.senders)) {
    const w = state.senders[s]
    if (nowWts < w.winStartWts + params.rateWindowMs) senders[s] = w
  }
  return { boxes, senders }
}

// ---------------------------------------------------------------------------
// Drain: the recipient syncs
// ---------------------------------------------------------------------------

export interface DrainResult {
  state: MailboxState
  /** Priority order: edgeMicro DESC, arrivedWts ASC, id ASC (established and
   * earliest first). The §10 prioritization, visible at delivery too. */
  msgs: StoredMail[]
}

/**
 * The recipient came online: prune, hand over their box in priority order,
 * and clear it. Pure; nowWts is the caller's witnessed-time input. Unknown
 * recipient ⇒ empty list (and the pruned state). Bad inputs fail closed to
 * the SAME state reference and no messages.
 */
export function mailboxDrain(
  state: MailboxState,
  recipient: B64u,
  nowWts: number,
  params: MailboxParams = PARAMS_SOCIAL_MAILBOX,
): DrainResult {
  if (!zB64u32.safeParse(recipient).success || !Number.isSafeInteger(nowWts) || nowWts < 0)
    return { state, msgs: [] }
  if (state.params !== mailboxParamsDigest(params)) return { state, msgs: [] }
  const { boxes, senders } = prune(state, nowWts, params)
  const box = boxes[recipient]
  const msgs = box ? [...box] : []
  msgs.sort((a, b) => {
    if (a.edgeMicro !== b.edgeMicro) return b.edgeMicro - a.edgeMicro
    if (a.arrivedWts !== b.arrivedWts) return a.arrivedWts - b.arrivedWts
    return compareKeys(a.id, b.id)
  })
  if (box) delete boxes[recipient]
  return { state: { v: 1, params: state.params, boxes, senders }, msgs }
}
