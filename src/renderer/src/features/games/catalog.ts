// Games library catalog: the LIBRARY-UI view of the game registry.
//
// TODO(P2): replace this local catalog with the real game kernel registry
// (src/renderer/src/games/registry.ts per docs/GAMES-PLATFORM-SPEC.md §Game
// kernel). Every field here mirrors the registry shape (kind/family/title/
// tagline/board/flipPolicy) so the swap is mechanical: the library UI must
// consume the registry ONLY once it lands.
import type { Rules } from 'chessops/types'

export type GameFamily = 'chess' | 'draughts' | 'go' | 'grid'
export type GameStatus = 'playable' | 'coming'

/* THE FOUR SHELVES, from design-lab/v1/games.html.
 *
 * `family` is a rules fact (which kernel plays it) and it cuts the wrong way
 * for a shelf: xiangqi, shogi and janggi are family 'chess' but nobody browsing
 * looks for them under Variants, and checkers is family 'draughts' while
 * sitting on the same shelf as them. So the shelf is its own field.
 *
 * Chess is alone at the top because the rest of this app is chess: Play,
 * Puzzles, School, Openings and Analysis all mean chess and nothing else.
 * Filing it under Variants would make the game a variant of itself, and every
 * shelf below is described by how it differs from that one card. */
export type GameGroup = 'chess' | 'variants' | 'international' | 'other'

export interface CatalogEntry {
  kind: string
  family: GameFamily
  /** Which of the four shelves the card sits on. */
  group: GameGroup
  title: string
  tagline: string
  /** Extra words the filter matches, beyond the title and the tagline. */
  aliases: string
  status: GameStatus
  /** chessops rules id. Present for the playable chess-variant wave. */
  rules?: Rules
  /** Characteristic position rendered on the library card (chess family). */
  thumbFen?: string
  /** True when Local OTB is wired end-to-end via the variant adapter. */
  otbReady?: boolean
  /** Manual id → resources/manuals/<id>.md */
  manualId: string
}

// ---- Chess itself ---------------------------------------------------------

export const STANDARD_CHESS: CatalogEntry = {
  kind: 'chess',
  family: 'chess',
  group: 'chess',
  title: 'Chess',
  tagline: 'The standard game. Everything else here bends one of its rules.',
  aliases: 'standard classical orthodox',
  status: 'playable',
  rules: 'chess',
  thumbFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  otbReady: true,
  manualId: 'chess'
}

// ---- Playable now: the chessops variant wave (P1) -------------------------

export const CHESS_VARIANTS: CatalogEntry[] = [
  {
    kind: 'chess960',
    family: 'chess',
    group: 'variants',
    title: 'Chess960',
    tagline: 'Fischer Random. 960 shuffled start positions, no opening theory.',
    aliases: 'fischer random shuffle',
    status: 'playable',
    rules: 'chess',
    thumbFen: 'bqnrkrnb/pppppppp/8/8/8/8/PPPPPPPP/BQNRKRNB w DFdf - 0 1',
    otbReady: true,
    manualId: 'chess960'
  },
  {
    kind: 'crazyhouse',
    family: 'chess',
    group: 'variants',
    title: 'Crazyhouse',
    tagline: 'Captured pieces switch sides. Drop them back anywhere.',
    aliases: 'drop pocket bughouse',
    status: 'playable',
    rules: 'crazyhouse',
    thumbFen: 'r1bq1rk1/ppp2ppp/2n2n2/3pp3/1b2P3/2NP1N2/PPP2PPP/R1BQKB1R w KQ - 0 1',
    otbReady: true, // drops via ChessFamilyBoard pockets (chessgroundx)
    manualId: 'crazyhouse'
  },
  {
    kind: 'atomic',
    family: 'chess',
    group: 'variants',
    title: 'Atomic',
    tagline: 'Every capture explodes. Nuke the enemy king to win.',
    aliases: 'explode blast nuke',
    status: 'playable',
    rules: 'atomic',
    thumbFen: 'rn1qkb1r/ppp1pppp/5n2/8/8/2N5/PPPP1PPP/R1BQKB1R w KQkq - 0 1',
    otbReady: true,
    manualId: 'atomic'
  },
  {
    kind: 'antichess',
    family: 'chess',
    group: 'variants',
    title: 'Antichess',
    tagline: 'Lose everything to win. Captures are forced.',
    aliases: 'losing giveaway suicide',
    status: 'playable',
    rules: 'antichess',
    thumbFen: '8/2p2p2/8/4b3/8/2P2P2/8/8 w - - 0 1',
    otbReady: true,
    manualId: 'antichess'
  },
  {
    kind: 'kingofthehill',
    family: 'chess',
    group: 'variants',
    title: 'King of the Hill',
    tagline: 'March your king to the four centre squares and win on the spot.',
    aliases: 'koth center centre',
    status: 'playable',
    rules: 'kingofthehill',
    thumbFen: 'r1bq1rk1/ppp2ppp/2np1n2/4p3/3KP3/2N2N2/PPP2PPP/R1BQ1B1R w - - 0 1',
    otbReady: true,
    manualId: 'kingofthehill'
  },
  {
    kind: 'threecheck',
    family: 'chess',
    group: 'variants',
    title: 'Three-check',
    tagline: 'Check the enemy king three times and the game is yours.',
    aliases: '3check checks',
    status: 'playable',
    rules: '3check',
    thumbFen: 'rnbqkb1r/ppp2Bpp/5n2/3pp3/4P3/8/PPPP1PPP/RNBQK1NR b KQkq - 0 1',
    otbReady: true,
    manualId: 'threecheck'
  },
  {
    kind: 'horde',
    family: 'chess',
    group: 'variants',
    title: 'Horde',
    tagline: 'Thirty-six pawns against a full army. Hold the line or break it.',
    aliases: 'pawns swarm',
    status: 'playable',
    rules: 'horde',
    thumbFen: 'rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1',
    otbReady: true,
    manualId: 'horde'
  },
  {
    kind: 'racingkings',
    family: 'chess',
    group: 'variants',
    title: 'Racing Kings',
    tagline: 'No checks allowed. First king to the eighth rank wins the race.',
    aliases: 'race sprint',
    status: 'playable',
    rules: 'racingkings',
    thumbFen: '8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1',
    otbReady: true,
    manualId: 'racingkings'
  },
  {
    kind: 'placement',
    family: 'chess',
    group: 'variants',
    title: 'Placement',
    tagline: 'Set up your own back rank, then play chess.',
    aliases: 'draft setup arrange',
    status: 'playable',
    // Library card only (the classic 8x8 thumb board renders it): a mid-draft
    // back rank, placement's signature moment. Rules stay with ffish.
    thumbFen: '2bqkb1r/pppppppp/8/8/8/8/PPPPPPPP/3QK1NR w - - 0 1',
    otbReady: true,
    manualId: 'placement'
  },
  // ---- ffish wave (P2): rules via Fairy-Stockfish WASM, board via
  // ChessFamilyBoard (no thumbFen: the classic 8x8 thumb board cannot render
  // these; gmArt.tsx owns the card art).
  {
    kind: 'xiangqi',
    family: 'chess',
    group: 'international',
    title: 'Xiangqi',
    tagline: 'Chinese chess: rivers, palaces and cannon batteries.',
    aliases: 'chinese elephant cannon river',
    status: 'playable',
    otbReady: true,
    manualId: 'xiangqi'
  },
  {
    kind: 'shogi',
    family: 'chess',
    group: 'international',
    title: 'Shogi',
    tagline: 'Japanese chess: captured pieces re-enter the fight.',
    aliases: 'japanese drop promote',
    status: 'playable',
    otbReady: true,
    manualId: 'shogi'
  },
  {
    kind: 'janggi',
    family: 'chess',
    group: 'international',
    title: 'Janggi',
    tagline: 'Korean chess: free-roaming generals and leaping cannons.',
    aliases: 'korean general cannon',
    status: 'playable',
    otbReady: true,
    manualId: 'janggi'
  },
  {
    kind: 'makruk',
    family: 'chess',
    group: 'international',
    title: 'Makruk',
    tagline: 'Thai chess: ancient rules, razor-sharp endgames.',
    aliases: 'thai ancient siamese',
    status: 'playable',
    otbReady: true,
    manualId: 'makruk'
  }
]

// ---- The other-boards wave (P2): checkers/go/grid, playable via KernelOtb -

export const OTHER_BOARDS: CatalogEntry[] = [
  { kind: 'checkers', family: 'draughts', group: 'international', title: 'Checkers', tagline: 'The 8x8 classic. Jump, capture, crown your kings.', aliases: 'draughts american english jump', status: 'playable', otbReady: true, manualId: 'checkers-american' },
  { kind: 'checkers-intl', family: 'draughts', group: 'international', title: 'International Draughts', tagline: '10x10 board, flying kings, forced majority captures.', aliases: 'polish 10x10 flying kings', status: 'playable', otbReady: true, manualId: 'checkers-intl' },
  { kind: 'go', family: 'go', group: 'other', title: 'Go', tagline: 'Surround territory, capture stones. The deepest game on earth.', aliases: 'baduk weiqi igo territory', status: 'playable', otbReady: true, manualId: 'go' },
  { kind: 'gomoku', family: 'grid', group: 'other', title: 'Gomoku', tagline: 'Five in a row on a Go board. Simple rules, brutal tactics.', aliases: 'renju five in a row', status: 'playable', otbReady: true, manualId: 'gomoku' },
  { kind: 'hex', family: 'grid', group: 'other', title: 'Hex', tagline: 'Connect your two sides. No draws, ever.', aliases: 'connection hexagon nash', status: 'playable', otbReady: true, manualId: 'hex' },
  { kind: 'othello', family: 'grid', group: 'other', title: 'Othello', tagline: 'Flip the board in one move. A minute to learn, a lifetime to master.', aliases: 'reversi flip discs', status: 'playable', otbReady: true, manualId: 'othello' },
  { kind: 'connect4', family: 'grid', group: 'other', title: 'Connect Four', tagline: 'Drop, stack and trap. Solved, but never boring.', aliases: 'four in a row drop', status: 'playable', otbReady: true, manualId: 'connect4' },
  { kind: 'morris', family: 'grid', group: 'other', title: "Nine Men's Morris", tagline: 'Form mills, remove men. A Roman classic.', aliases: 'mills merels roman', status: 'playable', otbReady: true, manualId: 'morris' },
  { kind: 'tictactoe', family: 'grid', group: 'other', title: 'Tic-Tac-Toe', tagline: 'The gateway game. Perfect play in three lines.', aliases: 'noughts crosses xo', status: 'playable', otbReady: true, manualId: 'tictactoe' }
]

/** The Variant Lab's card. It opens the editor rather than a game, which is
 *  why it has no rules, no board and no manual of its own. */
export const CREATE_YOUR_OWN: CatalogEntry = {
  kind: 'custom-editor',
  family: 'chess',
  group: 'variants',
  title: 'Create your own',
  tagline: 'Draw a board, place the pieces, write the rules.',
  aliases: 'variant editor custom build design',
  status: 'playable',
  manualId: 'custom-editor'
}

/* Catalog order is the order of the page. Create your own is the last thing in
 * Variants, because building one is what you do after the nine we ship stop
 * surprising you. */
export const CATALOG: CatalogEntry[] = [
  STANDARD_CHESS,
  ...CHESS_VARIANTS.filter((e) => e.group === 'variants'),
  CREATE_YOUR_OWN,
  ...CHESS_VARIANTS.filter((e) => e.group === 'international'),
  ...OTHER_BOARDS
]

export interface CatalogGroup {
  id: GameGroup
  title: string
  entries: CatalogEntry[]
}

/** The four shelves in page order, with their cards in catalog order. */
export const GROUPS: CatalogGroup[] = [
  { id: 'chess', title: 'Chess', entries: [] },
  { id: 'variants', title: 'Variants', entries: [] },
  { id: 'international', title: 'International', entries: [] },
  { id: 'other', title: 'Other', entries: [] }
]

for (const entry of CATALOG) {
  GROUPS.find((g) => g.id === entry.group)?.entries.push(entry)
}

/** Everything the filter matches for one card, lowercased once at module load. */
export function haystack(entry: CatalogEntry): string {
  return `${entry.title} ${entry.tagline} ${entry.aliases}`.toLowerCase()
}
