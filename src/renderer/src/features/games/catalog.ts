// Games library catalog — the LIBRARY-UI view of the game registry.
//
// TODO(P2): replace this local catalog with the real game kernel registry
// (src/renderer/src/games/registry.ts per docs/GAMES-PLATFORM-SPEC.md §Game
// kernel). Every field here mirrors the registry shape (kind/family/title/
// tagline/board/flipPolicy) so the swap is mechanical: the library UI must
// consume the registry ONLY once it lands.
import type { Rules } from 'chessops/types'

export type GameFamily = 'chess' | 'draughts' | 'go' | 'grid'
export type GameStatus = 'playable' | 'coming'

export interface CatalogEntry {
  kind: string
  family: GameFamily
  title: string
  tagline: string
  status: GameStatus
  /** chessops rules id — present for the playable chess-variant wave. */
  rules?: Rules
  /** Characteristic position rendered on the library card (chess family). */
  thumbFen?: string
  /** True when Local OTB is wired end-to-end via the variant adapter. */
  otbReady?: boolean
  /** Manual id → resources/manuals/<id>.md */
  manualId: string
}

// ---- Playable now: the chessops variant wave (P1) -------------------------

export const CHESS_VARIANTS: CatalogEntry[] = [
  {
    kind: 'chess960',
    family: 'chess',
    title: 'Chess960',
    tagline: 'Fischer Random — 960 shuffled start positions, zero opening theory.',
    status: 'playable',
    rules: 'chess',
    thumbFen: 'bqnrkrnb/pppppppp/8/8/8/8/PPPPPPPP/BQNRKRNB w DFdf - 0 1',
    otbReady: true,
    manualId: 'chess960'
  },
  {
    kind: 'crazyhouse',
    family: 'chess',
    title: 'Crazyhouse',
    tagline: 'Captured pieces switch sides — drop them back anywhere.',
    status: 'playable',
    rules: 'crazyhouse',
    thumbFen: 'r1bq1rk1/ppp2ppp/2n2n2/3pp3/1b2P3/2NP1N2/PPP2PPP/R1BQKB1R w KQ - 0 1',
    otbReady: true, // drops via ChessFamilyBoard pockets (chessgroundx)
    manualId: 'crazyhouse'
  },
  {
    kind: 'atomic',
    family: 'chess',
    title: 'Atomic',
    tagline: 'Every capture explodes — nuke the enemy king to win.',
    status: 'playable',
    rules: 'atomic',
    thumbFen: 'rn1qkb1r/ppp1pppp/5n2/8/8/2N5/PPPP1PPP/R1BQKB1R w KQkq - 0 1',
    otbReady: true,
    manualId: 'atomic'
  },
  {
    kind: 'antichess',
    family: 'chess',
    title: 'Antichess',
    tagline: 'Lose everything to win — captures are forced.',
    status: 'playable',
    rules: 'antichess',
    thumbFen: '8/2p2p2/8/4b3/8/2P2P2/8/8 w - - 0 1',
    otbReady: true,
    manualId: 'antichess'
  },
  {
    kind: 'kingofthehill',
    family: 'chess',
    title: 'King of the Hill',
    tagline: 'March your king to the four center squares to win instantly.',
    status: 'playable',
    rules: 'kingofthehill',
    thumbFen: 'r1bq1rk1/ppp2ppp/2np1n2/4p3/3KP3/2N2N2/PPP2PPP/R1BQ1B1R w - - 0 1',
    otbReady: true,
    manualId: 'kingofthehill'
  },
  {
    kind: 'threecheck',
    family: 'chess',
    title: 'Three-check',
    tagline: 'Check the enemy king three times and the game is yours.',
    status: 'playable',
    rules: '3check',
    thumbFen: 'rnbqkb1r/ppp2Bpp/5n2/3pp3/4P3/8/PPPP1PPP/RNBQK1NR b KQkq - 0 1',
    otbReady: true,
    manualId: 'threecheck'
  },
  {
    kind: 'horde',
    family: 'chess',
    title: 'Horde',
    tagline: 'Thirty-six pawns versus a full army — hold the line or break it.',
    status: 'playable',
    rules: 'horde',
    thumbFen: 'rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1',
    otbReady: true,
    manualId: 'horde'
  },
  {
    kind: 'racingkings',
    family: 'chess',
    title: 'Racing Kings',
    tagline: 'No checks allowed — first king to the eighth rank wins the race.',
    status: 'playable',
    rules: 'racingkings',
    thumbFen: '8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1',
    otbReady: true,
    manualId: 'racingkings'
  },
  // ---- ffish wave (P2): rules via Fairy-Stockfish WASM, board via
  // ChessFamilyBoard (no thumbFen — the classic 8x8 thumb Board cannot render
  // these; ArtThumb owns the card art).
  {
    kind: 'xiangqi',
    family: 'chess',
    title: 'Xiangqi',
    tagline: 'Chinese chess — rivers, palaces and cannon batteries.',
    status: 'playable',
    otbReady: true,
    manualId: 'xiangqi'
  },
  {
    kind: 'shogi',
    family: 'chess',
    title: 'Shogi',
    tagline: 'Japanese chess — captured pieces re-enter the fight.',
    status: 'playable',
    otbReady: true,
    manualId: 'shogi'
  },
  {
    kind: 'janggi',
    family: 'chess',
    title: 'Janggi',
    tagline: 'Korean chess — free-roaming generals and leaping cannons.',
    status: 'playable',
    otbReady: true,
    manualId: 'janggi'
  },
  {
    kind: 'makruk',
    family: 'chess',
    title: 'Makruk',
    tagline: 'Thai chess — ancient rules, razor-sharp endgames.',
    status: 'playable',
    otbReady: true,
    manualId: 'makruk'
  },
  {
    kind: 'placement',
    family: 'chess',
    title: 'Placement',
    tagline: 'Set up your own back rank, then play chess.',
    status: 'playable',
    // Library card only (the classic 8x8 thumb Board renders it): a mid-draft
    // back rank — placement's signature moment. Rules stay with ffish.
    thumbFen: '2bqkb1r/pppppppp/8/8/8/8/PPPPPPPP/3QK1NR w - - 0 1',
    otbReady: true,
    manualId: 'placement'
  }
]

// ---- The other-boards wave (P2): checkers/go/grid — playable via KernelOtb -

export const COMING_SOON: CatalogEntry[] = [
  { kind: 'checkers', family: 'draughts', title: 'Checkers', tagline: 'The 8×8 classic — jump, capture, crown your kings.', status: 'playable', otbReady: true, manualId: 'checkers-american' },
  { kind: 'checkers-intl', family: 'draughts', title: 'International Draughts', tagline: '10×10 flying kings and forced majority captures.', status: 'playable', otbReady: true, manualId: 'checkers-intl' },
  { kind: 'go', family: 'go', title: 'Go', tagline: 'Surround territory, capture stones — the deepest game on earth.', status: 'playable', otbReady: true, manualId: 'go' },
  { kind: 'gomoku', family: 'grid', title: 'Gomoku', tagline: 'Five in a row on a Go board — simple rules, brutal tactics.', status: 'playable', otbReady: true, manualId: 'gomoku' },
  { kind: 'othello', family: 'grid', title: 'Othello', tagline: 'Flip the board in one move — a minute to learn, a lifetime to master.', status: 'playable', otbReady: true, manualId: 'othello' },
  { kind: 'hex', family: 'grid', title: 'Hex', tagline: 'Connect your two sides — no draws, ever.', status: 'playable', otbReady: true, manualId: 'hex' },
  { kind: 'connect4', family: 'grid', title: 'Connect Four', tagline: 'Drop, stack and trap — solved, but never boring.', status: 'playable', otbReady: true, manualId: 'connect4' },
  { kind: 'morris', family: 'grid', title: 'Nine Men’s Morris', tagline: 'Form mills, remove men — a Roman classic.', status: 'playable', otbReady: true, manualId: 'morris' },
  { kind: 'tictactoe', family: 'grid', title: 'Tic-Tac-Toe', tagline: 'The gateway game — perfect play in three lines.', status: 'playable', otbReady: true, manualId: 'tictactoe' },
  { kind: 'custom-editor', family: 'chess', title: 'Variant Editor', tagline: 'Design your own chess variant — pieces, boards, rules.', status: 'coming', manualId: 'custom-editor' }
]

export const CATALOG: CatalogEntry[] = [...CHESS_VARIANTS, ...COMING_SOON]
