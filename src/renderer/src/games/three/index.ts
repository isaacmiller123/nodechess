// Shared 3D tabletop renderer: public surface.
//
// Consumers (GamePage wave-2, dev harness) import from HERE only; internals
// (piece systems, board generators, motion controller) may reshuffle freely.
// Load this module lazily (React.lazy / dynamic import): it pulls three.js.
//
// Exceptions (import DIRECTLY, never through this index; they are three-free
// so eager 2D code can use them without pulling the chunk): ./webgl (support
// probe), ./types (contract types), ./theater (Replay Theater choreography).

export { Tabletop3D } from './Tabletop3D'
export { getTabletopProvider, TABLETOP_PROVIDERS } from './providers'
export { isTabletopSupported, detectWebGL } from './webgl'
export { setGamesArtResolver, resolveGamesArtUrl } from './artLoader'
export type {
  Tabletop3DProps,
  Tabletop3DHandle,
  TabletopBoardShape,
  TabletopLayoutKind,
  TabletopPiece,
  TabletopPos,
  TabletopColor,
  TabletopProvider,
  PieceSystemId
} from './types'
