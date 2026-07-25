// A6 social core: profile records (spec §10 "edit profile (signed
// personal-lane records)" / "view anyone incl. years-offline; staleness shown
// as last witnessed activity"). Profiles ride the EXISTING personal-lane
// 'profile' event type (events.ts zProfilePayload; this module builds on it,
// never forks it): field writes are signed personal-lane events, merged by
// the deterministic LWW fold that verifyChain already owns (chain.ts; ONE
// implementation of the merge rule, reused here, never duplicated).
//
// STALENESS (§10, bound by §4): lastWitnessedActivity derives ONLY from
// witness attestations on the witnessed lane: signature-verified `wts`
// values bound to their event ids. NEVER from author-claimed body.ts (§4:
// timestamps bearing on staleness need witnessed time; §0: no self-asserted
// input for anything consequence-bearing). A chain with no verifiable
// attestation reads null ("no witnessed activity"), never a self-claimed
// time: fail closed. Honest limit, stated plainly: a standalone reader can
// check an attestation's signature and event binding, not the attesting
// witness's eligibility or diversity: those are the fabric's admission rules
// (§4, witness/eligibility.ts); what this reader guarantees is that no
// UNSIGNED or UNBOUND timestamp is ever surfaced.
//
// Platform-neutral: no `node:` imports, no DOM, no ambient time or randomness.

import { verifyChain } from '../chain'
import { eventId, zProfileFields, zProfilePayload } from '../events'
import { verifyAttestation } from '../witness/attest'
import type { B64u, Chain, GenesisPayload, ProfilePayload, SignedEvent } from '../types'

// ---------------------------------------------------------------------------
// Payload builder (caller appends via chain.ts appendPersonal)
// ---------------------------------------------------------------------------

/** The writable profile fields (types.ts PROFILE_FIELDS; caps in events.ts). */
export interface ProfileFieldWrites {
  bio?: string
  /** base64 image, decoded ≤ AVATAR_MAX_BYTES (§2). */
  avatar?: string
  country?: string
  flair?: string
}

/**
 * Assemble a ProfilePayload for a set/edit of profile fields. Validated
 * against the SAME zProfilePayload schema verifyChain enforces, so a payload
 * this builder accepts can never come back 'bad-payload'. Absent fields are
 * left untouched by the LWW fold (a write is per-field, not a wholesale
 * replace). Throws on structural misuse (unknown fields, oversize values).
 * This is the trusted build path.
 */
export function makeProfilePayload(fields: ProfileFieldWrites): ProfilePayload {
  // Validate the INPUT object itself (strict). An unknown field is refused,
  // never silently dropped: the trusted build path fails loudly on misuse.
  const parsed = zProfileFields.safeParse(fields)
  if (!parsed.success) throw new Error('makeProfilePayload: fields do not satisfy zProfileFields')
  const f = parsed.data
  const payload = {
    fields: {
      ...(f.bio !== undefined ? { bio: f.bio } : {}),
      ...(f.avatar !== undefined ? { avatar: f.avatar } : {}),
      ...(f.country !== undefined ? { country: f.country } : {}),
      ...(f.flair !== undefined ? { flair: f.flair } : {}),
    },
  }
  const res = zProfilePayload.safeParse(payload)
  if (!res.success) throw new Error('makeProfilePayload: fields do not satisfy zProfilePayload')
  return payload as ProfilePayload
}

// ---------------------------------------------------------------------------
// Staleness: last witnessed activity (§10/§4)
// ---------------------------------------------------------------------------

/**
 * The newest witness-attested time on the witnessed lane: max `wts` over all
 * attestations that (a) sit on a witnessed-lane event of this list and
 * (b) verify (witness/attest.ts verifyAttestation, ed25519 by att.w over
 * the canonical {e: eventId, epoch, w, wts} bytes, so the time is BOUND to
 * its event and cannot be lifted from elsewhere or minted unsigned).
 * Returns null when no attestation verifies, including the legitimate
 * A1-style offline chain, and NEVER falls back to body.ts (header doctrine).
 * Total: never throws; unhashable events and malformed attestations are
 * skipped.
 */
export function lastWitnessedActivityOf(events: readonly SignedEvent[]): number | null {
  let best: number | null = null
  for (const ev of events) {
    try {
      if (ev.body.lane !== 'w' || !Array.isArray(ev.wit) || ev.wit.length === 0) continue
      const id = eventId(ev.body) // throws on non-canonical bodies → skip
      for (const att of ev.wit) {
        try {
          if (!Number.isSafeInteger(att.wts) || att.wts < 0) continue
          if (!verifyAttestation(att, id)) continue
          if (best === null || att.wts > best) best = att.wts
        } catch {
          continue // one malformed attestation never poisons the rest
        }
      }
    } catch {
      continue
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// The profile view (viewer-derived, §10)
// ---------------------------------------------------------------------------

/** What a profile page renders (§10): all derived, nothing asserted. */
export interface ProfileView {
  root: B64u
  /** Display name from the (verified) genesis event. */
  name: string
  /** LWW-folded field state (verifyChain's fold; the single merge rule). */
  fields: ProfileFieldWrites
  /** Newest verified witness-attested time, or null = no witnessed activity
   * on record (§10 staleness: the UI renders "last seen" / "never seen" from
   * this. Never from any self-claimed timestamp). */
  lastWitnessedActivity: number | null
}

/**
 * Derive the profile view of a chain: verifyChain first (signatures, cert and
 * revocation standing, linkage, payload schemas), then project the verified
 * results. Returns null when the chain does not verify. A viewer never
 * renders a profile it cannot trust (fail closed, §0); "years offline but
 * intact" chains verify fine and render with a stale (or null)
 * lastWitnessedActivity, which is exactly the §10 presentation. Never throws.
 */
export function profileView(chain: Chain): ProfileView | null {
  try {
    const vr = verifyChain(chain)
    if (!vr.ok) return null
    // vr.ok ⇒ exactly one verified genesis at witnessed height 0.
    const genesis = chain.events.find((e) => e.body.lane === 'w' && e.body.type === 'genesis')
    if (!genesis) return null
    const name = (genesis.body.payload as GenesisPayload).name
    // vr.profile values passed zProfileFields inside verifyChain. The cast
    // narrows to the schema the fold already enforced.
    const f = vr.profile as { bio?: string; avatar?: string; country?: string; flair?: string }
    return {
      root: chain.root,
      name,
      fields: {
        ...(f.bio !== undefined ? { bio: f.bio } : {}),
        ...(f.avatar !== undefined ? { avatar: f.avatar } : {}),
        ...(f.country !== undefined ? { country: f.country } : {}),
        ...(f.flair !== undefined ? { flair: f.flair } : {}),
      },
      lastWitnessedActivity: lastWitnessedActivityOf(chain.events),
    }
  } catch {
    return null
  }
}
