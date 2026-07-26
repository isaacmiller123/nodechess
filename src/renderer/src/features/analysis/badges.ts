// Review-badge metadata: one glyph vocabulary for the whole page, so a ?! never
// has to be explained twice. Consumed by the review table, the move list, the
// note on the current move, and Play's own move list. Pure data, no React.
//
// 'Miss' now lives in the shared MoveBadge union itself; ReviewBadge is kept as
// an alias for the existing import sites.
import type { MoveBadge } from '@shared/types'

export type ReviewBadge = MoveBadge

/** Per-ply badge lookup for the move list (1-based half-move ply). */
export type BadgeMap = Map<number, ReviewBadge>

export interface BadgeMeta {
  /** Compact glyph rendered inside the chip (ASCII/Unicode, never emoji). */
  glyph: string
  /** Human-readable name ("Great" -> shown in table rows / tooltips / aria). */
  label: string
  /** Tone suffix -> .bchip-<tone> background + .tone-<tone> text color. */
  tone: string
}

/* Teal !!, green ! and a green star for Best, greens for Excellent/Good, beige
   Book, yellow ?!, orange ?, red ✗ Miss, red ??. The tone is the name of a
   colour, not a colour: markClass below turns it into the v1 mark class that
   reads the matching --class-* token. Glyphs stay ASCII/Unicode text. Never
   emoji. */
const META: Record<ReviewBadge, BadgeMeta> = {
  Brilliant: { glyph: '!!', label: 'Brilliant', tone: 'brilliant' },
  Great: { glyph: '!', label: 'Great', tone: 'great' },
  Best: { glyph: '★', label: 'Best', tone: 'best' },
  Excellent: { glyph: '✓', label: 'Excellent', tone: 'excellent' },
  Good: { glyph: '✓', label: 'Good', tone: 'good' },
  Book: { glyph: 'B', label: 'Book', tone: 'book' },
  Forced: { glyph: '→', label: 'Forced', tone: 'book' },
  Inaccuracy: { glyph: '?!', label: 'Inaccuracy', tone: 'inaccuracy' },
  Mistake: { glyph: '?', label: 'Mistake', tone: 'mistake' },
  Miss: { glyph: '✗', label: 'Miss', tone: 'miss' },
  Blunder: { glyph: '??', label: 'Blunder', tone: 'blunder' }
}

export function badgeMeta(badge: ReviewBadge): BadgeMeta {
  // Defensive fallback: an unknown string from a stale DB cache renders as Good.
  return META[badge] ?? META.Good
}

/** Whether a badge is worth surfacing as a mark (move list / eval-graph dot).
 *  Routine Good/Excellent moves are suppressed to avoid a wall of marks. */
export function isNotableBadge(badge: ReviewBadge): boolean {
  return badge !== 'Good' && badge !== 'Excellent'
}

/* Both move lists now colour the MARK and leave the move text alone, which is
   what v1's analysis page does, so the "which classes are dramatic enough to
   tint the SAN" question no longer has a caller and its answer is gone with
   it. markClass below is the one thing a list needs from a badge. */

/** Chess.com-style coach headline tail: "Qxb2" + badgeHeadline('Blunder') ->
 *  "Qxb2 is a blunder". Grammar per badge; unknown strings fall back to the
 *  meta label so a stale cache still reads sensibly. */
export function badgeHeadline(badge: ReviewBadge): string {
  switch (badge) {
    case 'Brilliant':
      return 'is brilliant'
    case 'Great':
      return 'is a great move'
    case 'Best':
      return 'is best'
    case 'Excellent':
      return 'is excellent'
    case 'Good':
      return 'is good'
    case 'Book':
      return 'is a book move'
    case 'Forced':
      return 'was forced'
    case 'Inaccuracy':
      return 'is an inaccuracy'
    case 'Mistake':
      return 'is a mistake'
    case 'Miss':
      return 'was a miss'
    case 'Blunder':
      return 'is a blunder'
    default:
      return `is ${badgeMeta(badge).label.toLowerCase()}`
  }
}

/* v1 names its classification marks .an-mk.is-<mark>, and its vocabulary is
   shorter than ours in two places: it writes "inacc" rather than "inaccuracy",
   and it never drew Best or Excellent because the one game in the mock did not
   contain them. Both marks are declared beside the other eight in analysis.css.
   Forced shares Book's token, which is already what badgeMeta gives it. */
const MARK_CLASS: Record<string, string> = {
  brilliant: 'is-brilliant',
  great: 'is-great',
  best: 'is-best',
  excellent: 'is-excellent',
  good: 'is-good',
  book: 'is-book',
  inaccuracy: 'is-inacc',
  mistake: 'is-mistake',
  miss: 'is-miss',
  blunder: 'is-blunder'
}

/** v1 modifier for a badge's mark glyph, e.g. 'Inaccuracy' -> 'is-inacc'. */
export function markClass(badge: ReviewBadge): string {
  return MARK_CLASS[badgeMeta(badge).tone] ?? 'is-good'
}

/** The classes a review flags as worth a second look. Drives "Go to the next
 *  mistake" and the readout count; Miss is included because a missed
 *  punishment is exactly the kind of move you came back to find. */
export function isMistakeBadge(badge: ReviewBadge): boolean {
  return (
    badge === 'Inaccuracy' || badge === 'Mistake' || badge === 'Miss' || badge === 'Blunder'
  )
}

/** Row order of the chess.com-style review summary table. */
export const BADGE_TABLE_ORDER: ReviewBadge[] = [
  'Brilliant',
  'Great',
  'Best',
  'Excellent',
  'Good',
  'Book',
  'Inaccuracy',
  'Mistake',
  'Miss',
  'Blunder'
]

/** Count badges for one side from the review's move evals. */
export function countBadges(
  moveEvals: { color: 'white' | 'black'; badge: MoveBadge }[],
  color: 'white' | 'black'
): Map<ReviewBadge, number> {
  const counts = new Map<ReviewBadge, number>()
  for (const m of moveEvals) {
    if (m.color !== color) continue
    const b = m.badge as ReviewBadge
    counts.set(b, (counts.get(b) ?? 0) + 1)
  }
  return counts
}
