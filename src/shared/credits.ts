// Art credits for the games platform (resources/games-art/**). CC-BY assets
// REQUIRE user-facing attribution, so Settings must surface this (render
// GAMES_ART_CREDITS as a list, or GAMES_ART_CREDITS_TEXT as one string).
// Full per-file detail + license links live in docs/CREDITS.md. Keep the two
// in sync when assets change.

export interface ArtCredit {
  /** What the asset is, user-facing (e.g. 'Xiangqi pieces (gmchess wood)'). */
  readonly asset: string
  readonly author: string
  /** SPDX-ish id: 'CC-BY-4.0' | 'CC0-1.0' | 'MIT' | 'Apache-2.0' | ... */
  readonly license: string
  readonly url: string
}

export const GAMES_ART_CREDITS: readonly ArtCredit[] = [
  {
    asset: 'Xiangqi pieces (gmchess style wood)',
    author: 'Kadagaden',
    license: 'CC-BY-4.0',
    url: 'https://github.com/Kadagaden/chess-pieces'
  },
  {
    asset: 'Janggi pieces (wooden)',
    author: 'Kadagaden',
    license: 'CC-BY-4.0',
    url: 'https://github.com/Kadagaden/chess-pieces'
  },
  {
    asset: 'Shogi pieces (2-kanji red wood; kanji glyphs by Hari Seldon, CC-BY-SA-3.0)',
    author: 'Ka-hu',
    license: 'CC-BY-4.0',
    url: 'https://github.com/Ka-hu/shogi-pieces'
  },
  {
    asset: 'Shogi pieces (international; after CouchTomato87 & Hidetchi)',
    author: 'Ka-hu',
    license: 'CC-BY-4.0',
    url: 'https://github.com/Ka-hu/shogi-pieces'
  },
  {
    asset: 'Chess pieces (RhosGFX)',
    author: 'RhosGFX',
    license: 'CC0-1.0',
    url: 'https://rhosgfx.itch.io/'
  },
  {
    asset: 'Chess pieces (Chessnut)',
    author: 'Alexis Luengas',
    license: 'Apache-2.0',
    url: 'https://github.com/LexLuengas/chessnut-pieces'
  },
  {
    asset: 'Chess pieces (Fantasy, Spatial, Celtic)',
    author: 'Maurizio Monge',
    license: 'MIT',
    url: 'https://github.com/maurimo/chess-art'
  },
  {
    asset: 'Board textures (Wood048, Wood027, Onyx013, Fabric034)',
    author: 'ambientCG',
    license: 'CC0-1.0',
    url: 'https://ambientcg.com'
  },
  {
    asset: '3D chess set (photoscanned pieces + board)',
    author: 'Riley Queen (Poly Haven)',
    license: 'CC0-1.0',
    url: 'https://polyhaven.com/a/chess_set'
  }
] as const

/** One-line-per-asset attribution block for the Settings credits screen. */
export const GAMES_ART_CREDITS_TEXT: string = GAMES_ART_CREDITS.map(
  (c) => `${c.asset}, ${c.author} (${c.license}), ${c.url}`
).join('\n')
