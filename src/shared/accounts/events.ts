// Chain events: zod v4 schemas mirroring types.ts EXACTLY, plus the
// id/sign/verify primitives every other accounts module builds on.
// (spec: docs/ACCOUNTS-SPEC.md §2, contract: ./types.ts)
//
// Platform-neutral: no `node:` imports, no DOM globals.

import { z } from 'zod'
import { canonicalBytes, canonicalHash } from './codec'
import { ed25519, toB64u, verifySigB64u } from './hash'
import {
  AVATAR_MAX_BYTES,
  BIO_MAX,
  NAME_MAX,
  NAME_MIN,
  type B64u,
  type EventBody,
  type EventId,
  type EventType,
  type Lane,
  type SignedEvent,
} from './types'

// ---------------------------------------------------------------------------
// b64u primitives (hash.ts convention: base64url, no padding)
// ---------------------------------------------------------------------------

const B64U_RE = /^[A-Za-z0-9_-]+$/
/** b64u of 32 bytes (pubkeys, sha256 ids, digests): exactly 43 chars. */
export const zB64u32 = z.string().length(43).regex(B64U_RE)
/** b64u of 64 bytes (ed25519 signatures): exactly 86 chars. */
export const zB64u64 = z.string().length(86).regex(B64U_RE)

const zHeight = z.int().min(0)
const zTs = z.int().min(0)

// ---------------------------------------------------------------------------
// Payload schemas (one per A1 event type, all .strict())
// ---------------------------------------------------------------------------

/** Control chars, zero-width chars, bidi/paragraph separators: never in names. */
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u2060\ufeff]/

/** Display-form name: NAME_MIN..NAME_MAX chars, trimmed, no control/zero-width. */
export const zName = z
  .string()
  .min(NAME_MIN)
  .max(NAME_MAX)
  .refine((s) => s.trim() === s, 'name has leading/trailing whitespace')
  .refine((s) => !NAME_FORBIDDEN.test(s), 'name contains control or zero-width characters')

/** Avatar stays a base64 string; decoded cap AVATAR_MAX_BYTES → chars cap. */
export const AVATAR_B64_MAX_CHARS = Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 8

export const zGenesisPayload = z.strictObject({
  params: zB64u32,
  name: zName,
})

export const zCertPayload = z.strictObject({
  pub: zB64u32,
  /** KEY_PURPOSE: 0=device, 1=session, 2=context. */
  purpose: z.int().min(0).max(2),
  index: z.int().min(0),
  label: z.string().min(1).max(64).optional(),
})

export const zRevokePayload = z.strictObject({
  pub: zB64u32,
})

/** Profile field writes. Keys restricted to PROFILE_FIELDS (types.ts). */
export const zProfileFields = z.strictObject({
  bio: z.string().max(BIO_MAX).optional(),
  avatar: z.string().max(AVATAR_B64_MAX_CHARS).optional(),
  country: z.string().max(64).optional(),
  flair: z.string().max(64).optional(),
})

export const zProfilePayload = z.strictObject({
  fields: zProfileFields,
})

export const zCheckpointPayload = z.strictObject({
  prevCkpt: zB64u32.optional(),
  through: zHeight,
  state: z.record(z.string(), z.unknown()),
  stateDigest: zB64u32,
})

/**
 * A ckpt SignedEvent, validated by a NON-RECURSIVE schema (body pinned to a
 * ckpt payload). This exists so a segment's `oppCkpt` does NOT reference the
 * general zSignedEvent, which, via the segment payload's own oppCkpt, would
 * be mutually recursive and let an attacker nest segment-in-oppCkpt to any
 * depth, overflowing zod's safeParse stack on untrusted input (a verifier
 * must fail closed, not throw). A real oppCkpt IS a ckpt event, so pinning the
 * type here is both the correct shape and the recursion bound (a ckpt payload
 * carries no event-typed field). `wit` reuses zWitnessAttestation (a straight,
 * acyclic reference: z.lazy only handles its forward declaration below).
 */
export const zCkptEvent = z.strictObject({
  body: z.strictObject({
    v: z.literal(1),
    lane: z.literal('w'),
    type: z.literal('ckpt'),
    root: zB64u32,
    key: zB64u32,
    height: zHeight,
    prev: zB64u32.optional(),
    ts: zTs,
    payload: zCheckpointPayload,
  }),
  sig: zB64u64,
  wit: z.array(z.lazy(() => zWitnessAttestation)).optional(),
})

/** A3 game segment (§3): see storage/types.ts SegmentPayload for the field
 * contract. oppCkpt is the opponent's cosigned ckpt event, validated by the
 * non-recursive zCkptEvent above (bounds untrusted-input recursion depth). */
export const zSegmentHeads = z.strictObject({
  w: z.strictObject({ head: zB64u32, height: zHeight }),
  b: z.strictObject({ head: zB64u32, height: zHeight }),
})

export const zProfileSnapshot = z.strictObject({
  name: zName,
  bio: z.string().max(BIO_MAX).optional(),
  country: z.string().max(64).optional(),
  flair: z.string().max(64).optional(),
  avatarDigest: zB64u32.optional(),
})

export const zSegmentPayload = z.strictObject({
  game: zB64u32,
  opp: zB64u32,
  color: z.enum(['w', 'b']),
  result: z.enum(['1-0', '0-1', '1/2-1/2']),
  reason: z.string().min(1).max(64),
  transcript: zB64u32,
  plies: z.int().min(0).max(4096),
  heads: zSegmentHeads,
  wstream: z.strictObject({ wkey: zB64u32, sig: zB64u64 }),
  oppCkpt: zCkptEvent.optional(),
  oppProfile: zProfileSnapshot,
  // A4 ladder binding (§6): game kind + clock. Absent (pre-A4 segments or
  // unlimited/unrated play) ⇒ the rating fold skips the segment.
  kind: z.string().min(1).max(32).optional(),
  tc: z.strictObject({ baseMs: z.int().min(0).max(86_400_000), incMs: z.int().min(0).max(3_600_000) }).optional(),
  // A4 review fix (A4-02): certs proving the embedded oppCkpt's signing key
  // belongs to the opponent root when it is a device key (recursion-bounded,
  // like commend certs; z.lazy only for the forward declaration: zCertEvent
  // is defined below zSegmentPayload). Absent when the oppCkpt is root-signed.
  oppCerts: z.array(z.lazy(() => zCertEvent)).max(8).optional(),
})

/**
 * A cert SignedEvent, validated by a NON-RECURSIVE schema (body pinned to a
 * cert payload): the same recursion-bounding pattern as zCkptEvent. Used
 * where cert events ride INSIDE another payload (commend certs): a cert
 * payload carries no event-typed field, so nesting depth is bounded.
 */
export const zCertEvent = z.strictObject({
  body: z.strictObject({
    v: z.literal(1),
    lane: z.literal('p'),
    type: z.literal('cert'),
    root: zB64u32,
    key: zB64u32,
    height: zHeight,
    prev: zB64u32.optional(),
    ts: zTs,
    payload: zCertPayload,
  }),
  sig: zB64u64,
  wit: z.array(z.lazy(() => zWitnessAttestation)).optional(),
})

/** A4 conduct event (§6b). See types.ts ConductPayload for semantics.
 * A4 review fix (A4-13): 'rematch-accept' additionally carries the
 * COUNTERPARTY's signature (sig by key over rematchBytes, certs proving
 * key∈opp when not root-signed): a unilateral self-claim never counts. */
export const zConductPayload = z
  .strictObject({
    kind: z.enum(['abort', 'noshow', 'rematch-accept']),
    game: zB64u32,
    opp: zB64u32,
    prior: zB64u32.optional(),
    sig: zB64u64.optional(),
    key: zB64u32.optional(),
    certs: z.array(zCertEvent).max(8).optional(),
  })
  .refine((p) => (p.kind === 'rematch-accept') === (p.prior !== undefined), {
    message: "prior is required for 'rematch-accept' and forbidden otherwise",
    path: ['prior'],
  })
  .refine((p) => (p.kind === 'rematch-accept') === (p.sig !== undefined && p.key !== undefined), {
    message: "sig+key are required for 'rematch-accept' and forbidden otherwise",
    path: ['sig'],
  })
  .refine((p) => p.kind === 'rematch-accept' || p.certs === undefined, {
    message: "certs only accompany 'rematch-accept'",
    path: ['certs'],
  })

/** A4 commendation (§6b): see types.ts CommendPayload. Certs are inline,
 * recursion-bounded cert events of the COMMENDER (body.root === opp). */
export const zCommendPayload = z.strictObject({
  game: zB64u32,
  opp: zB64u32,
  key: zB64u32,
  sig: zB64u64,
  certs: z.array(zCertEvent).max(8).optional(),
})

/** A4 PIN anchor (§1 seam 3): see types.ts PinAnchorPayload. */
export const zPinAnchorPayload = z.strictObject({
  record: zB64u32,
  gen: z.int().min(0),
})

/** A6 friend edge (§3/§10): see types.ts FriendPayload. Certs are inline,
 * recursion-bounded cert events of the PEER (body.root === peer), present
 * exactly when the countersigning key is not the peer root itself, the
 * commend pattern, but schema-enforceable here because `key` and `peer` are
 * both payload fields. Countersig VERIFICATION is social/friends.ts's fold
 * rule (a schema cannot check signatures); an in-chain add with a forged
 * countersig is a schema-valid event the fold ignores. */
export const zFriendPayload = z
  .strictObject({
    action: z.enum(['add', 'remove']),
    peer: zB64u32,
    key: zB64u32.optional(),
    sig: zB64u64.optional(),
    certs: z.array(zCertEvent).min(1).max(8).optional(),
  })
  .refine((p) => (p.action === 'add') === (p.sig !== undefined && p.key !== undefined), {
    message: "key+sig are required for 'add' and forbidden for 'remove'",
    path: ['sig'],
  })
  .refine((p) => p.action !== 'add' || (p.key === p.peer) === (p.certs === undefined), {
    message: "certs are required iff key is not the peer root ('add')",
    path: ['certs'],
  })
  .refine((p) => p.action === 'add' || p.certs === undefined, {
    message: "certs only accompany 'add'",
    path: ['certs'],
  })

/** A5 pairing record: see types.ts PairingPayload. A7 adds the OPTIONAL
 * serving-witness attest (A4-02/A4-10 closure), additive: legacy records
 * without it still parse, and the strict shapes refuse any other extension. */
export const zPairingPayload = z.strictObject({
  game: zB64u32,
  opp: zB64u32,
  kind: z.string().min(1).max(32),
  tc: z.strictObject({ baseMs: z.int().min(0).max(86_400_000), incMs: z.int().min(0).max(3_600_000) }),
  atWts: zTs,
  witAttest: z
    .strictObject({
      ratingMicro: z.int().min(0).max(4_000_000_000),
      headHeight: z.int().min(0),
      w: zB64u32,
      wts: zTs,
      sig: z.string().min(1),
    })
    .optional(),
})

/** A5 anticheat self-ban: see types.ts SelfBanPayload. */
export const zSelfBanPayload = z.strictObject({
  kind: z.literal('anticheat'),
  ladder: z.string().min(1).max(64),
  window: z.int().min(0),
  expiryWts: zTs,
  verdict: zB64u32,
})

export const PAYLOAD_SCHEMA: Record<EventType, z.ZodType> = {
  genesis: zGenesisPayload,
  cert: zCertPayload,
  revoke: zRevokePayload,
  profile: zProfilePayload,
  ckpt: zCheckpointPayload,
  segment: zSegmentPayload,
  conduct: zConductPayload,
  commend: zCommendPayload,
  pin: zPinAnchorPayload,
  pairing: zPairingPayload,
  selfban: zSelfBanPayload,
  friend: zFriendPayload,
}

/** The lane each event type belongs to (types.ts registry). */
export const LANE_FOR: Record<EventType, Lane> = {
  genesis: 'w',
  cert: 'p',
  revoke: 'w',
  profile: 'p',
  ckpt: 'w',
  segment: 'w',
  conduct: 'w',
  commend: 'w',
  pin: 'w',
  pairing: 'w',
  selfban: 'w',
  friend: 'w',
}

// ---------------------------------------------------------------------------
// Event body / signed event / attestation schemas
// ---------------------------------------------------------------------------

/**
 * Structural body shape WITHOUT per-type payload validation: used by chain
 * loading so a chain carrying a bad payload still loads and verifyChain can
 * report 'bad-payload' instead of the loader throwing.
 */
export const zEventBodyCore = z.strictObject({
  v: z.literal(1),
  lane: z.enum(['w', 'p']),
  type: z.enum(['genesis', 'cert', 'revoke', 'profile', 'ckpt', 'segment', 'conduct', 'commend', 'pin', 'pairing', 'selfban', 'friend']),
  root: zB64u32,
  key: zB64u32,
  height: zHeight,
  prev: zB64u32.optional(),
  ts: zTs,
  payload: z.record(z.string(), z.unknown()),
})

/** Full body validation: shape + lane rule + per-type payload schema. */
export const zEventBody = zEventBodyCore.superRefine((b, ctx) => {
  if (b.lane !== LANE_FOR[b.type])
    ctx.addIssue({
      code: 'custom',
      message: `event type '${b.type}' belongs in lane '${LANE_FOR[b.type]}'`,
      path: ['lane'],
    })
  // Certificates are ALWAYS root-signed (spec §1). A device-signed cert is
  // not a weaker cert, it is an invalid payload.
  if (b.type === 'cert' && b.key !== b.root)
    ctx.addIssue({ code: 'custom', message: 'cert events must be signed by the root key', path: ['key'] })
  // A friend edge has two DISTINCT endpoints (spec §3/§10). A self-edge is
  // meaningless and refused outright, not left to the fold.
  if (b.type === 'friend' && (b.payload as { peer?: unknown }).peer === b.root)
    ctx.addIssue({ code: 'custom', message: 'friend event peer must not be the chain root', path: ['payload'] })
  const res = PAYLOAD_SCHEMA[b.type].safeParse(b.payload)
  if (!res.success)
    for (const issue of res.error.issues)
      ctx.addIssue({
        code: 'custom',
        // STABLE text only: the sub-issue's code + path, never zod's
        // free-form `message`: these strings reach VerifyError.detail and
        // therefore the parity digest, and zod's prose drifts across minors.
        message: `payload invalid: ${issue.code} at ${issue.path.map(String).join('.') || '$'}`,
        path: ['payload'],
      })
})

/**
 * STABLE rendering of a zod issue for VerifyError.detail: composed ONLY from
 * the issue `code` and `path`, never zod's free-text `message`, which can
 * change under a zod minor bump and would shift the parity digest of invalid
 * chains. 'custom' issues carry OUR OWN fixed messages (the superRefine rules
 * above) and pass through verbatim.
 */
export function stableIssueDetail(
  issue: { code?: string; path: ReadonlyArray<PropertyKey>; message: string } | undefined,
): string {
  if (!issue) return 'bad shape'
  if (issue.code === 'custom') return issue.message
  const path = issue.path.map(String).join('.')
  return path ? `${issue.code ?? 'invalid'} at ${path}` : (issue.code ?? 'invalid')
}

export const zWitnessAttestation = z.strictObject({
  w: zB64u32,
  wts: zTs,
  epoch: z.int().min(0),
  sig: zB64u64,
})

/** Loose signed-event shape (loading); payload contents checked at verify. */
export const zSignedEventCore = z.strictObject({
  body: zEventBodyCore,
  sig: zB64u64,
  wit: z.array(zWitnessAttestation).optional(),
})

/** Full signed-event validation (body payload included). */
export const zSignedEvent = z.strictObject({
  body: zEventBody,
  sig: zB64u64,
  wit: z.array(zWitnessAttestation).optional(),
})

// ---------------------------------------------------------------------------
// id / sign / verify
// ---------------------------------------------------------------------------

/** sha256(canonicalBytes(body)) as b64u: the id every `prev` points at. */
export function eventId(body: EventBody): EventId {
  return toB64u(canonicalHash(body))
}

/** Sign a body with the private key matching body.key. Pure; ts is the caller's. */
export function signBody(body: EventBody, priv: Uint8Array): SignedEvent {
  const sig = toB64u(ed25519.sign(canonicalBytes(body), priv))
  return { body, sig }
}

/** ed25519 verify of ev.sig by ev.body.key over canonicalBytes(body). Never throws. */
export function verifyEventSig(ev: SignedEvent): boolean {
  // canonicalBytes can throw on a malformed body (e.g. a non-safe-integer
  // payload). A verifier must fail closed, not throw, on untrusted input.
  let msg: Uint8Array
  try {
    msg = canonicalBytes(ev.body)
  } catch {
    return false
  }
  return verifySigB64u(ev.sig, msg, ev.body.key)
}

// ---------------------------------------------------------------------------
// Head helpers (shared by certs/chain/checkpoint, linkage math in ONE place)
// ---------------------------------------------------------------------------

export interface Head {
  id: EventId
  height: number
}

/** Highest witnessed event of a well-formed event list (null when no genesis). */
export function witnessedHeadOf(events: readonly SignedEvent[]): Head | null {
  let best: SignedEvent | null = null
  for (const ev of events) {
    if (ev.body.lane !== 'w') continue
    if (!best || ev.body.height > best.body.height) best = ev
  }
  return best ? { id: eventId(best.body), height: best.body.height } : null
}

/** Highest personal event BY `key` (personal heights are per signing key). */
export function personalHeadOf(events: readonly SignedEvent[], key: B64u): Head | null {
  let best: SignedEvent | null = null
  for (const ev of events) {
    if (ev.body.lane !== 'p' || ev.body.key !== key) continue
    if (!best || ev.body.height > best.body.height) best = ev
  }
  return best ? { id: eventId(best.body), height: best.body.height } : null
}
