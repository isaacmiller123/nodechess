// A4 ladders (spec §6, brick 2a): one ladder per (game kind × TimeCategory),
// bound to the shipped renderer enum. TimeCategory is derived in EXACT INTEGER
// math (PARAMS_A4 thresholds): estMs = baseMs + tcIncWeight·incMs, compared
// against the fixed ms thresholds: the same semantics as the renderer's
// timeControlCategory (src/renderer/.../play/timeControl.ts) without its float
// division, so every verifier lands on the identical category from the
// identical clock. Unlimited (baseMs === 0: the segment schema bounds baseMs
// ≥ 0, so === 0 is exactly the renderer's `<= 0`) is UNRATED: no clock stream
// ⇒ no timing forensics ⇒ the rating fold skips the segment (fold.ts).
//
// ladderId(kind, tc) = `${kind}:${category}`. `kind` (1..32 chars, free
// registry string per zSegmentPayload) MAY itself contain ':'. The category
// is always the LAST ':'-component and category names never contain ':', so
// the id is unambiguous parsed from the right. The fold never stores an
// Unlimited ladder (it skips before deriving the id), but ladderId is total.
//
// Platform-neutral, pure integer math: no `node:` imports, no DOM, no floats.

import { PARAMS_A4 } from './params'

export type TimeCategory = 'Bullet' | 'Blitz' | 'Rapid' | 'Classical' | 'Unlimited'
/** The categories that carry a ladder (Unlimited games are unrated, §6). */
export type RatedCategory = Exclude<TimeCategory, 'Unlimited'>

export interface TimeControlMs {
  /** Initial time per side, ms. 0 = Unlimited (no clock). */
  baseMs: number
  /** Increment per move, ms. */
  incMs: number
}

/**
 * The §6 time category in exact integer math. estMs = baseMs +
 * PARAMS_A4.tcIncWeight·incMs (all safe integers under the segment schema
 * bounds: ≤ 86_400_000 + 40·3_600_000); strictly-less-than thresholds mirror
 * the renderer's float form value-for-value.
 */
export function timeCategory(tc: TimeControlMs): TimeCategory {
  if (tc.baseMs === 0) return 'Unlimited'
  const estMs = tc.baseMs + PARAMS_A4.tcIncWeight * tc.incMs
  if (estMs < PARAMS_A4.tcBulletMaxEstMs) return 'Bullet'
  if (estMs < PARAMS_A4.tcBlitzMaxEstMs) return 'Blitz'
  if (estMs < PARAMS_A4.tcRapidMaxEstMs) return 'Rapid'
  return 'Classical'
}

/** The ladder a (kind, tc) game rates in: `${kind}:${category}`. */
export function ladderId(kind: string, tc: TimeControlMs): string {
  return `${kind}:${timeCategory(tc)}`
}

/** Per-category reveal threshold (§6 [SIGN-OFF]: games before a rating
 * renders, 120/100/80/40). */
export function revealThreshold(category: RatedCategory): number {
  switch (category) {
    case 'Bullet':
      return PARAMS_A4.revealBullet
    case 'Blitz':
      return PARAMS_A4.revealBlitz
    case 'Rapid':
      return PARAMS_A4.revealRapid
    case 'Classical':
      return PARAMS_A4.revealClassical
  }
}
