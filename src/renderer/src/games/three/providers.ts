// Per-game tabletop providers: GameKind → piece system + board style + params.
// docs/GAMES-PLATFORM-SPEC.md §3D tiers WILL: chess family, checkers, go,
// gomoku, othello, connect four. CAN (procedural fallback pieces now): shogi
// (wedge), xiangqi/janggi/makruk/morris (decal tokens). WON'T: TTT, hex.
//
// Standard-board chess kinds use the 'chessSet' system (Poly Haven photoscan
// GLBs via chessSet.ts; ChessSetPieces.tsx owns board + fallbacks).
// CRAZYHOUSE stays 2D-only: its pockets (captured pieces held for dropping)
// have no tabletop representation yet, revisit if a pocket tray ships.

import type { GameKind } from '../kernel'
import type { TabletopProvider } from './types'

const GO_STYLE: TabletopProvider = {
  system: 'goStone',
  board: {
    topColor: '#dcaf5e', // kaya
    topTexture: 'wood-light',
    lineColor: '#3b2a12',
    starPoints: 'auto',
    frameColor: '#c89a4e',
    slabHeight: 0.55
  },
  stone: { diameter: 0.96, height: 0.42 }
}

const CHECKERS_STYLE: TabletopProvider = {
  system: 'disc',
  board: {
    topColor: '#e7cfa4',
    topTexture: 'wood-light',
    checkerColor: '#6d4326',
    checkerTexture: 'wood-dark',
    frameColor: '#4a2f1b',
    frameTexture: 'wood-dark',
    slabHeight: 0.3
  },
  disc: {
    colors: { white: '#ece1c5', black: '#42302a' },
    diameter: 0.78,
    thickness: 0.21,
    grooved: true,
    kingStacks: true
  }
}

// Poly Haven scan look, with a matching procedural fallback board underneath
// (slabHeight 0.3 ≈ the scan's own top surface, so the swap is seamless).
const CHESS_SET_STYLE: TabletopProvider = {
  system: 'chessSet',
  board: {
    topColor: '#e7cfa4',
    topTexture: 'wood-light',
    checkerColor: '#6d4326',
    checkerTexture: 'wood-dark',
    frameColor: '#3a2618',
    frameTexture: 'wood-dark',
    slabHeight: 0.3
  },
  chessSet: { variant: 'marble' }
}

/** Standard-board chess kinds (8×8, orthodox piece codes): crazyhouse is
 *  deliberately absent (pockets aren't representable on the tabletop yet). */
const CHESS_SET_KINDS = [
  'chess',
  'chess960',
  'atomic',
  'antichess',
  'kingofthehill',
  'threecheck',
  'horde',
  'racingkings'
] as const

export const TABLETOP_PROVIDERS: Partial<Record<GameKind, TabletopProvider>> = {
  ...Object.fromEntries(CHESS_SET_KINDS.map((k) => [k, CHESS_SET_STYLE])),
  go: GO_STYLE,
  gomoku: {
    ...GO_STYLE,
    stone: { diameter: 0.88, height: 0.4 }
  },
  checkers: CHECKERS_STYLE,
  'checkers-intl': CHECKERS_STYLE,
  othello: {
    system: 'disc',
    board: {
      topColor: '#1c6b46', // classic othello green
      lineColor: 'rgba(8,26,16,0.85)',
      frameColor: '#241a12',
      frameTexture: 'wood-dark',
      slabHeight: 0.26
    },
    disc: {
      twoTone: true,
      twoToneColors: { light: '#f2eee2', dark: '#191b1e' },
      diameter: 0.8,
      thickness: 0.18
    }
  },
  connect4: {
    system: 'disc',
    board: {
      topColor: '#1d4ed8',
      frameColor: '#1d4ed8',
      slabHeight: 0.3
    },
    disc: {
      colors: { white: '#e23430', black: '#ffc73d' }, // first seat = red
      diameter: 0.95,
      thickness: 0.24
    }
  },
  shogi: {
    system: 'wedge',
    board: {
      topColor: '#e3b96b',
      topTexture: 'wood-light',
      lineColor: '#3b2a12',
      frameColor: '#c89a4e',
      slabHeight: 0.5
    },
    wedge: { width: 0.68, decalDir: 'shogi' }
  },
  xiangqi: {
    system: 'token',
    board: {
      topColor: '#e0b25f',
      topTexture: 'wood-light',
      lineColor: '#43301a',
      frameColor: '#8a5a28',
      frameTexture: 'wood-dark',
      slabHeight: 0.4
    },
    token: { diameter: 0.86, thickness: 0.2, decalDir: 'xiangqi' }
  },
  janggi: {
    system: 'token',
    board: {
      topColor: '#d9a854',
      topTexture: 'wood-light',
      lineColor: '#43301a',
      frameColor: '#8a5a28',
      frameTexture: 'wood-dark',
      slabHeight: 0.4
    },
    token: { diameter: 0.84, thickness: 0.2, decalDir: 'janggi' }
  },
  makruk: {
    system: 'token',
    board: {
      topColor: '#e7cfa4',
      topTexture: 'wood-light',
      checkerColor: '#b98d54',
      checkerTexture: 'wood-dark',
      frameColor: '#4a2f1b',
      frameTexture: 'wood-dark',
      slabHeight: 0.3
    },
    token: { diameter: 0.72, thickness: 0.22 }
  },
  // TODO(P3): morris boards draw mill lines, not a full grid. Needs a 'tracks'
  // top-canvas mode. Tokens on the full grid are acceptable until then.
  morris: {
    system: 'token',
    board: {
      topColor: '#e0b25f',
      topTexture: 'wood-light',
      lineColor: '#3b2a12',
      frameColor: '#8a5a28',
      slabHeight: 0.4
    },
    token: { diameter: 0.6, thickness: 0.2 }
  }
}

/** null → no 3D provider yet (chess family pre-GLB, WON'T-tier games): keep the 2D board. */
export function getTabletopProvider(kind: GameKind): TabletopProvider | null {
  return TABLETOP_PROVIDERS[kind] ?? null
}
