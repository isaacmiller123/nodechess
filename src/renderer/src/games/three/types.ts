// Shared 3D tabletop renderer. Public contract types.
// docs/GAMES-PLATFORM-SPEC.md §3D: ONE react-three-fiber tabletop renderer for
// every game; procedural instanced pieces (stones/discs/wedges/tokens); PBR
// textures from resources/games-art when present, procedural fallback always.
//
// This module is types-only (no three import) so 2D-only code can reference
// the contract without pulling the three bundle.

import type { GameKind } from '../kernel'
import type { TheaterDirective } from './theater'

/** Board plane style. 'holes' = upright connect-four frame. */
export type TabletopLayoutKind = 'cells' | 'intersections' | 'holes'

export interface TabletopBoardShape {
  layout: TabletopLayoutKind
  /** cells/holes: column count; intersections: number of grid LINES per axis. */
  files: number
  ranks: number
}

/** 0-based board coordinate. file 0 = left from white's seat, rank 0 = white's near row (holes: rank 0 = bottom). */
export interface TabletopPos {
  file: number
  rank: number
}

export type TabletopColor = 'white' | 'black'

export interface TabletopPiece {
  id: string
  pos: TabletopPos
  /** Piece-system-specific type: goStone 'stone'; disc 'man' | 'king' | 'disc'; wedge/token: game piece codes ('P', 'r', …). */
  type: string
  color: TabletopColor
}

export type PieceSystemId = 'goStone' | 'disc' | 'wedge' | 'token' | 'chessSet'

/** games-art texture set names (resources/games-art/textures/<name>_{color,normal,roughness}.jpg). */
export type ArtTextureName = 'wood-light' | 'wood-dark' | 'slate' | 'felt'

export interface BoardStyle {
  /** Top-surface base tint / procedural fallback color. */
  topColor: string
  /** Art texture for the top surface (loaded when available, else procedural grain from topColor). */
  topTexture?: ArtTextureName
  /** cells: second checker color. Present = checkered; absent = solid top with seam lines. */
  checkerColor?: string
  checkerTexture?: ArtTextureName
  /** Grid/seam line color (intersections lines, solid-cells seams). */
  lineColor?: string
  /** intersections: star points ('auto' = standard hoshi for 9/13/19). */
  starPoints?: TabletopPos[] | 'auto'
  /** Frame/rim (and holes-frame) color. */
  frameColor: string
  frameTexture?: ArtTextureName
  /** Board slab height in world units (1 unit = 1 square). */
  slabHeight?: number
}

export interface DiscParams {
  /** Othello: one geometry, light top / dark bottom, color shown by flip angle. */
  twoTone?: boolean
  /** Solid-mode piece colors (checkers lacquer, connect-four red/yellow). */
  colors?: Record<TabletopColor, string>
  twoToneColors?: { light: string; dark: string }
  /** Diameter/thickness as a fraction of one square (defaults 0.78 / 0.22). */
  diameter?: number
  thickness?: number
  /** Lathe groove profile on the rim (checkers look). */
  grooved?: boolean
  /** type === 'king' renders a second stacked disc. */
  kingStacks?: boolean
}

export interface StoneParams {
  diameter?: number
  height?: number
}

export interface WedgeParams {
  /** Wedge base width fraction of a square. */
  width?: number
  /** Decal art directory under games-art (e.g. 'shogi'). Glyph fallback when absent. */
  decalDir?: string
}

export interface TokenParams {
  diameter?: number
  thickness?: number
  decalDir?: string
  colors?: Record<TabletopColor, string>
}

export interface ChessSetParams {
  /** Poly Haven photoscan look ('marble', default) or the warm 'wood' recolor. */
  variant?: 'marble' | 'wood'
}

/** GameKind → how the shared tabletop renders it. Registered in three/providers.ts. */
export interface TabletopProvider {
  system: PieceSystemId
  board: BoardStyle
  disc?: DiscParams
  stone?: StoneParams
  wedge?: WedgeParams
  token?: TokenParams
  chessSet?: ChessSetParams
}

export interface Tabletop3DProps {
  kind: GameKind
  board: TabletopBoardShape
  pieces: TabletopPiece[]
  /** Which color's seat the camera starts behind. Default 'white'. */
  orientation?: TabletopColor
  interactive?: boolean
  /** Proposed square/vertex click (renderer never validates rules). */
  onSquareClick?(pos: TabletopPos): void
  /** Proposed drag drop. Owner answers by updating `pieces`; otherwise the piece snaps home. */
  onPieceDrag?(pieceId: string, from: TabletopPos, to: TabletopPos): void
  /** WebGL missing or context lost. Mount the 2D board instead. */
  onUnavailable?(reason: string): void
  /** Base URL for resources/games-art (see three/artLoader.ts). null = procedural only. */
  artBaseUrl?: string | null
  /** Camera preset toggle: default 35° player-side tilt vs top-down. */
  topDown?: boolean
  /** Replay Theater directive (a ref: mutations never re-render). Present =
   *  the cinematic TheaterRig owns the camera + scene clock; OrbitControls
   *  and camera presets are not mounted. See games/three/theater.ts. */
  theater?: { current: TheaterDirective }
  /** Fires once with the live WebGL canvas (Replay Theater export records it). */
  onCanvasReady?(canvas: HTMLCanvasElement): void
  className?: string
}

/** Imperative animation surface (also driven automatically by `pieces` prop diffs). */
export interface Tabletop3DHandle {
  animateMove(pieceId: string, to: TabletopPos): void
  animateCapture(pieceId: string): void
  animateFlip(pieceId: string): void
}
