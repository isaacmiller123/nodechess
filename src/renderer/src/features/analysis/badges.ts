// Chess.com-style review-badge metadata used by the Analysis surfaces (MoveList
// chips, ReviewPanel summary table, CoachPanel headline, EvalGraph dots). Pure
// data, no React.
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

/* Chess.com visual language: teal !!, blue !, green star for Best, greens for
   Excellent/Good, beige Book, yellow ?!, orange ?, red ✗ Miss, red ??. The tone
   suffixes map onto tokens in analysis.css (tone-great -> --accent blue,
   tone-excellent -> --success green, tone-miss -> --danger red, the rest ->
   --class-* tokens). Glyphs stay ASCII/Unicode text. Never emoji. */
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

/** Badges whose SAN text is tinted in the move list. Chess.com tints only the
 *  dramatic classes; routine Best/Excellent/Good/Book/Forced keep neutral text
 *  and rely on the icon so the table doesn't turn into a rainbow. */
export function isEmphasisBadge(badge: ReviewBadge): boolean {
  return (
    badge === 'Brilliant' ||
    badge === 'Great' ||
    badge === 'Inaccuracy' ||
    badge === 'Mistake' ||
    badge === 'Miss' ||
    badge === 'Blunder'
  )
}

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
