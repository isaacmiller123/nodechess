// A6 social surface: SOCIAL presence (spec §10 "presence (ephemeral)", C-3).
// Ephemeral ROOT-signed "I am online / playing / away" claims plus a pure,
// deterministic aggregation. Expiring, reconstructible, NO account data
// (no rating, no name: viewers derive those from the chain), NO authority.
//
// Relationship to witness/presence.ts (checked first, deliberately not
// duplicated): that module is FABRIC presence. A device-key-signed
// capability advertisement (witness/committee/shardMb) feeding the
// observer-local NodeDirectory that seeds witness-set selection. Social
// presence is a different surface with a different signer (the account ROOT,
// so no cert verification is needed to attribute it), different content
// (a status enum, no capabilities), and a different consumption contract (a
// pure fold over a claim set, not a mutable directory). What IS shared is the
// underlying machinery: canonicalBytes signing, verifySigB64u, strict zod
// shapes, compareKeys ordering, newest-per-root + staleness pruning. Reused
// here from codec/hash/events rather than re-implemented.
//
// §0 stance, stated honestly: presence is NON-consequence-bearing UI state.
// A modified client can claim to be online. That feeds no rating, trust,
// reputation, ban, or witnessed-time input, so lying gains nothing. The real
// §0 protection is attribution: the root signature means nobody can forge
// SOMEONE ELSE'S presence, and verification fails closed on any bad shape or
// signature. The claimed `ts` is sender-asserted (exactly like fabric
// presence) and is BOUNDED by the verifier: ttl capped by params, far-future
// claims dropped, expiry judged against a caller-supplied `nowWts` derived
// from witnessed time (§4): never ambient clock. No Date.now() anywhere.
//
// Platform-neutral: no `node:` imports, no DOM globals, integers only.

import { z } from 'zod'
import { canonicalBytes, canonicalHash, compareKeys, type CanonicalObject } from '../codec'
import { zB64u32, zB64u64 } from '../events'
import { ed25519, toB64u, verifySigB64u } from '../hash'
import type { B64u } from '../types'

// ---------------------------------------------------------------------------
// Parameters (C-3 coordination state: revisable, not frozen-at-genesis;
// same discipline as witness/params.ts: consumers pin a digest per rule set)
// ---------------------------------------------------------------------------

export interface SocialPresenceParams extends CanonicalObject {
  v: number
  /** Hard cap on a claim's self-declared ttl. A claim cannot assert immortal presence. */
  ttlMaxMs: number
  /** Claims timestamped further than this into the verifier's future are dropped. */
  skewMaxMs: number
}

export const PARAMS_SOCIAL_PRESENCE = {
  v: 1,
  ttlMaxMs: 300_000, // 5 min. Clients re-announce well inside this
  skewMaxMs: 120_000,
} as const satisfies SocialPresenceParams

export const PARAMS_SOCIAL_PRESENCE_DIGEST: string = toB64u(canonicalHash(PARAMS_SOCIAL_PRESENCE))

// ---------------------------------------------------------------------------
// Claim shape
// ---------------------------------------------------------------------------

export const SOCIAL_STATUSES = ['online', 'playing', 'away'] as const
export type SocialStatus = (typeof SOCIAL_STATUSES)[number]

/** Ephemeral, ROOT-signed presence claim. No account data beyond the root id. */
export interface SocialPresenceBody extends CanonicalObject {
  v: 1
  /** Account root public key (b64u, 32 bytes). Also the signer. */
  root: B64u
  status: SocialStatus
  /** Sender-claimed unix ms at issue. Bounded by verifiers, never trusted raw. */
  ts: number
  /** Self-declared lifetime, ms. Capped at params.ttlMaxMs by verifiers. */
  ttlMs: number
}

export interface SignedSocialPresence {
  body: SocialPresenceBody
  sig: B64u
}

const zSocialPresenceBody = z.strictObject({
  v: z.literal(1),
  root: zB64u32,
  status: z.enum(SOCIAL_STATUSES),
  ts: z.int().min(0),
  ttlMs: z.int().min(1),
})

const zSignedSocialPresence = z.strictObject({ body: zSocialPresenceBody, sig: zB64u64 })

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

/** Sign a presence body with the ROOT private key matching body.root. Pure; ts is the caller's. */
export function signSocialPresence(body: SocialPresenceBody, rootPriv: Uint8Array): SignedSocialPresence {
  return { body, sig: toB64u(ed25519.sign(canonicalBytes(body), rootPriv)) }
}

/**
 * Verify a social presence claim: strict shape, ttl within params.ttlMaxMs,
 * ed25519 signature by body.ROOT over canonicalBytes(body). Fail-closed:
 * returns false on any bad shape/bound/signature, never throws.
 */
export function verifySocialPresence(
  sp: SignedSocialPresence,
  params: SocialPresenceParams = PARAMS_SOCIAL_PRESENCE,
): boolean {
  const parsed = zSignedSocialPresence.safeParse(sp)
  if (!parsed.success) return false
  if (sp.body.ttlMs > params.ttlMaxMs) return false
  let msg: Uint8Array
  try {
    msg = canonicalBytes(sp.body)
  } catch {
    return false
  }
  return verifySigB64u(sp.sig, msg, sp.body.root)
}

// ---------------------------------------------------------------------------
// Aggregation: pure, deterministic, order-independent
// ---------------------------------------------------------------------------

export interface SocialPresenceView {
  root: B64u
  status: SocialStatus
  /** The winning claim's issue timestamp. */
  ts: number
  /** When this view expires (body.ts + body.ttlMs). For renders, not authority. */
  expiresWts: number
}

/**
 * Deterministic aggregation of a claim set at witnessed time `nowWts`
 * (caller-supplied, §4, NEVER ambient time):
 *
 *  1. drop every claim failing verifySocialPresence (fail-closed skip);
 *  2. drop expired claims: nowWts − body.ts > body.ttlMs (a claim at exactly
 *     ts + ttlMs is still live, mirroring witness/presence.ts age ≤ stale);
 *  3. drop far-future claims: body.ts − nowWts > params.skewMaxMs (bounded
 *     skew tolerance; within the bound counts as live, like fabric presence);
 *  4. freshest-wins per root: highest body.ts; exact-ts tie broken by the
 *     lexicographically GREATER sig (compareKeys) so the result is a pure
 *     function of the claim SET, independent of input order;
 *  5. output sorted by root (compareKeys ascending).
 *
 * Pure and bit-deterministic: same claim multiset + same nowWts ⇒ identical
 * result on every platform. Absence of a claim means offline. There is no
 * negative claim and no authority anywhere in this file.
 */
export function presenceOf(
  claims: readonly SignedSocialPresence[],
  nowWts: number,
  params: SocialPresenceParams = PARAMS_SOCIAL_PRESENCE,
): SocialPresenceView[] {
  if (!Number.isSafeInteger(nowWts) || nowWts < 0) return [] // fail closed on bad time input
  const best = new Map<B64u, SignedSocialPresence>()
  for (const sp of claims) {
    if (!verifySocialPresence(sp, params)) continue
    if (nowWts - sp.body.ts > sp.body.ttlMs) continue // expired
    if (sp.body.ts - nowWts > params.skewMaxMs) continue // implausible future
    const prev = best.get(sp.body.root)
    if (
      !prev ||
      sp.body.ts > prev.body.ts ||
      (sp.body.ts === prev.body.ts && compareKeys(sp.sig, prev.sig) > 0)
    )
      best.set(sp.body.root, sp)
  }
  const out: SocialPresenceView[] = []
  for (const sp of best.values())
    out.push({
      root: sp.body.root,
      status: sp.body.status,
      ts: sp.body.ts,
      expiresWts: sp.body.ts + sp.body.ttlMs,
    })
  out.sort((a, b) => compareKeys(a.root, b.root))
  return out
}
