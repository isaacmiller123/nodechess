import type { ThemeCount } from '@shared/types'

/**
 * The theme taxonomy behind Custom's "All themes" drawers.
 *
 * The puzzle DB stores a FLAT list of theme keys (puzzles.repo listThemes is a
 * GROUP BY), so the nine groups are authored here. That makes this map a claim
 * about the data, and a claim can drift: anything the DB reports that no group
 * claims lands in a tenth drawer rather than disappearing, and a key a group
 * claims but the DB does not have is simply not drawn. Both directions are
 * handled in groupThemes below.
 */
export interface ThemeGroup {
  name: string
  /** Membership, in the order the chips should read. */
  keys: string[]
  /** The names shown while the drawer is shut. Filtered to what the DB has. */
  preview: string[]
}

export const THEME_GROUPS: ThemeGroup[] = [
  {
    name: 'Tactic',
    keys: [
      'fork',
      'pin',
      'skewer',
      'discoveredAttack',
      'doubleCheck',
      'deflection',
      'attraction',
      'clearance',
      'interference',
      'intermezzo',
      'sacrifice',
      'quietMove',
      'defensiveMove',
      'capturingDefender',
      'hangingPiece',
      'trappedPiece',
      'xRayAttack',
      'zugzwang'
    ],
    preview: ['fork', 'pin', 'skewer', 'deflection', 'zugzwang']
  },
  {
    name: 'Mate',
    keys: [
      'mate',
      'mateIn1',
      'mateIn2',
      'mateIn3',
      'mateIn4',
      'mateIn5',
      'backRankMate',
      'smotheredMate',
      'anastasiaMate',
      'arabianMate',
      'bodenMate',
      'dovetailMate',
      'doubleBishopMate',
      'hookMate',
      'killBoxMate',
      'vukovicMate'
    ],
    preview: ['mate', 'mateIn1', 'backRankMate', 'smotheredMate']
  },
  {
    name: 'Attack',
    keys: ['kingsideAttack', 'queensideAttack', 'exposedKing', 'attackingF2F7', 'advancedPawn'],
    preview: ['kingsideAttack', 'exposedKing', 'advancedPawn']
  },
  {
    name: 'Length',
    keys: ['oneMove', 'short', 'long', 'veryLong', 'healthyMix'],
    preview: ['oneMove', 'short', 'long', 'veryLong', 'healthyMix']
  },
  {
    name: 'Phase',
    keys: ['opening', 'middlegame', 'endgame'],
    preview: ['opening', 'middlegame', 'endgame']
  },
  {
    name: 'Endgame type',
    keys: [
      'rookEndgame',
      'pawnEndgame',
      'knightEndgame',
      'bishopEndgame',
      'queenEndgame',
      'queenRookEndgame'
    ],
    preview: ['rookEndgame', 'pawnEndgame', 'queenEndgame']
  },
  {
    name: 'Outcome',
    keys: ['crushing', 'advantage', 'equality'],
    preview: ['crushing', 'advantage', 'equality']
  },
  {
    name: 'Special move',
    keys: ['promotion', 'underPromotion', 'enPassant', 'castling'],
    preview: ['promotion', 'underPromotion', 'enPassant', 'castling']
  },
  {
    name: 'Source',
    keys: ['master', 'masterVsMaster', 'superGM'],
    preview: ['master', 'masterVsMaster', 'superGM']
  }
]

/** The drawer everything unclaimed falls into. Named for what it is. */
const OVERFLOW = 'Everything else'

export interface BuiltGroup {
  name: string
  themes: ThemeCount[]
  preview: string[]
}

/**
 * Sort the DB's themes into the drawers. Only themes the DB actually reports
 * are drawn, and any it reports that no group claims get their own drawer, so
 * the picker can never offer a theme with nothing behind it nor hide one.
 */
export function groupThemes(themes: ThemeCount[]): BuiltGroup[] {
  const byKey = new Map(themes.map((t) => [t.key, t]))
  const claimed = new Set<string>()
  const out: BuiltGroup[] = []

  for (const g of THEME_GROUPS) {
    const present: ThemeCount[] = []
    for (const key of g.keys) {
      const t = byKey.get(key)
      if (!t) continue
      present.push(t)
      claimed.add(key)
    }
    if (present.length === 0) continue
    out.push({
      name: g.name,
      themes: present,
      preview: g.preview.filter((k) => byKey.has(k))
    })
  }

  const rest = themes.filter((t) => !claimed.has(t.key))
  if (rest.length > 0) {
    out.push({
      name: OVERFLOW,
      themes: rest,
      preview: rest.slice(0, 5).map((t) => t.key)
    })
  }

  return out
}
