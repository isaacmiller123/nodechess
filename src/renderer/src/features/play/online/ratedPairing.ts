// Rated online play. The pure seam between the Play surface and the A4 rating
// protocol: which ladder a clock rates in, and the exact public PairViews this
// surface hands to mm/pairing. Nothing here reaches the matchmaking engine (and
// therefore nothing pulls its trystero transport), which is what lets the
// headless conformance suite render the rated surface and re-verify its §6/§7
// rules with no relay in the process (scripts/test-a4-ui.mjs, A4-26/A4-27).

import type { PairView } from '@shared/accounts/mm/pairing'
import { pairViewOf } from '@shared/accounts/ratings/display'
import { timeCategory, type RatedCategory } from '@shared/accounts/ratings/ladders'
import type { B64u } from '@shared/accounts/types'
import { TIME_CONTROLS, timeControlCategory, type TimeControl } from '../timeControl'

/** The registry kind every chess ladder folds under (matchmaking's MM_KIND;
 *  the ladder id both clients key their fold and their seek pool on). */
export const RATED_KIND = 'chess'

/** The four rated ladders, in speed order. Unlimited is absent on purpose: no
 *  clock stream means no timing forensics, so those games are unrated (§6). */
export const RATED_LADDERS: readonly RatedCategory[] = ['Bullet', 'Blitz', 'Rapid', 'Classical']

/** `${kind}:${category}`. The fold key and PairView.ladderId (twin of the
 *  matchmaking engine's ladderIdOf and of shared ladders.ts ladderId()). */
export function ratedLadderId(key: RatedCategory): string {
  return `${RATED_KIND}:${key}`
}

/**
 * The ladder a control rates in, or null when it rates in none. Derived through
 * the SHARED integer rule (ladders.ts timeCategory over baseMs/incMs) rather
 * than the renderer's float twin, so the ladder this surface advertises is the
 * one the fold will actually credit the game to.
 */
export function ratedLadderOf(tc: TimeControl): RatedCategory | null {
  const cat = timeCategory({ baseMs: tc.baseMs, incMs: tc.incMs })
  return cat === 'Unlimited' ? null : cat
}

/**
 * OUR side of a pairing as the public projection every counterparty verifies:
 * the shared pairViewOf over this ladder's protocol numbers. `tMicro` is §7
 * trust evaluated at the pairing record's witnessed instant, and `ban`/`atWts`
 * (the fold's bans[ladderId] entry) carry an active §8/§9 ban into the view so
 * a banned ladder cannot advertise a seek pairingLegal would refuse anyway.
 */
export function ownPairView(
  root: B64u,
  key: RatedCategory,
  ladder: { n: number; r: number; rd: number },
  tMicro: number,
  ban?: { until: number },
  atWts?: number
): PairView {
  return pairViewOf(root, ratedLadderId(key), ladder, tMicro, key, ban, atWts)
}

/** A pairing the engine has struck, reduced to what a surface may render. The
 *  live MatchAssignment satisfies it structurally. */
export interface StruckPairing {
  role: 'host' | 'guest'
  ladderKey: RatedCategory
  hostView: PairView
  guestView: PairView
  /** The protocol-pinned instant BOTH sides' trust was evaluated at (A4-16).
   *  The only legality-relevant clock; never the renderer's ambient now. */
  atWts: number
}

/** Split a struck pairing into (us, them) by the seat we hold. Every rated
 *  surface renders the opponent through this pair so the §6 information rule is
 *  applied against OUR display state, never against a convenient one. */
export function pairViewsFor(p: StruckPairing): { own: PairView; opp: PairView } {
  return p.role === 'host'
    ? { own: p.hostView, opp: p.guestView }
    : { own: p.guestView, opp: p.hostView }
}

// The two categorizations must agree value-for-value: the picker labels a chip
// with the renderer's float rule while the fold credits the game through the
// protocol's integer rule. Drift means a player is offered "Blitz" and rated in
// Rapid. Checked once at module load in dev builds, and re-run by the UI suite
// with DEV armed, so neither curve can be retuned alone.
if (import.meta.env.DEV) {
  for (const tc of TIME_CONTROLS) {
    const rendered = timeControlCategory(tc)
    const protocol = timeCategory({ baseMs: tc.baseMs, incMs: tc.incMs })
    if (rendered !== protocol) {
      throw new Error(
        `rated ladder drift on ${tc.id}: the picker says ${rendered}, the fold rates it ${protocol}`
      )
    }
  }
}
