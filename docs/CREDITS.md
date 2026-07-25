# Art credits — games platform

Per-asset provenance for everything under `resources/games-art/**`. CC-BY assets REQUIRE this
attribution to ship; the Settings-facing string lives in `src/shared/credits.ts`
(`GAMES_ART_CREDITS` / `GAMES_ART_CREDITS_TEXT`) — keep both in sync when assets change.
Chess piece sets already bundled in `resources/assets/piece/` are credited in
`src/renderer/src/board/pieceSets.ts` and their per-set `LICENSE.txt`.

All files below were verified byte-identical to their upstream sources on 2026-07-06
(licenses checked against the upstream repos' LICENSE files and lichess-org/lila
`COPYING.md` at that date).

## Xiangqi pieces — `games-art/xiangqi/`

- **Set:** `xiangqi_gmchess_style_wood` (14 SVGs, upstream filenames kept)
- **Author:** Kadagaden (vector remake of the gmchess piece set)
- **License:** CC-BY-4.0 (`games-art/xiangqi/LICENSE.txt`)
- **Source:** <https://github.com/Kadagaden/chess-pieces> (`xiangqi_gmchess_style_wood/`)

## Janggi pieces — `games-art/janggi/`

- **Set:** `janggi_wooden` (14 SVGs, upstream filenames kept; inspired by Kakao Janggi)
- **Author:** Kadagaden
- **License:** CC-BY-4.0 (`games-art/janggi/LICENSE.txt`)
- **Source:** <https://github.com/Kadagaden/chess-pieces> (`janggi_wooden/`)

## Shogi pieces — `games-art/shogi/`

- **Set:** `kanji/` = `kanji_red_wood` (30 SVGs), `international/` = `international` (30 SVGs);
  upstream (pychess-style) filenames kept
- **Author:** Ka-hu. The 2-kanji characters inside `kanji_red_wood` were made by
  **Hari Seldon** and are licensed **CC-BY-SA-3.0**
  (<https://commons.wikimedia.org/wiki/Category:SVG_traditional_shogi_pieces>) — attribute both.
  The `international` set is Ka-hu's modification of
  [CouchTomato87](https://github.com/CouchTomato87/InternationalizedPieces)'s and
  [Hidetchi](https://github.com/Hidetchi)'s pieces.
- **License:** CC-BY-4.0 (`games-art/shogi/LICENSE.txt`), kanji glyphs CC-BY-SA-3.0
- **Source:** <https://github.com/Ka-hu/shogi-pieces>

## Extra chess piece sets — `games-art/chess-extra/`

12 SVGs each (`wK.svg` … `bP.svg`), copied from lichess-org/lila `public/piece/<set>/`;
licenses verified against lila `COPYING.md`. Only permissive sets are bundled — no GPL/AGPL or
non-commercial sets here.

| Set | Author | License | Source |
| --- | --- | --- | --- |
| `rhosgfx/` | [RhosGFX](https://rhosgfx.itch.io/) | CC0-1.0 | <https://github.com/lichess-org/lila/tree/master/public/piece/rhosgfx> |
| `chessnut/` | [Alexis Luengas](https://github.com/LexLuengas) | Apache-2.0 | <https://github.com/LexLuengas/chessnut-pieces> (via lila) |
| `fantasy/` | [Maurizio Monge](https://github.com/maurimo/chess-art) | MIT | <https://github.com/maurimo/chess-art> (via lila) |
| `spatial/` | [Maurizio Monge](https://github.com/maurimo/chess-art) | MIT | <https://github.com/maurimo/chess-art> (via lila) |
| `celtic/` | [Maurizio Monge](https://github.com/maurimo/chess-art) | MIT | <https://github.com/maurimo/chess-art> (via lila) |

## PBR board textures — `games-art/textures/`

CC0 1K materials from [ambientCG](https://ambientcg.com) (created by Lennart Demes), JPEG
maps only (`_color` = Color, `_normal` = NormalGL, `_roughness` = Roughness), recompressed to
keep the bundle small (~3 MB total). CC0 needs no attribution, but the exact asset ids are
recorded here so the files stay reproducible:

| Local name | ambientCG asset | Use | URL |
| --- | --- | --- | --- |
| `wood-light_*` | Wood048 (1K-JPG) | light board wood | <https://ambientcg.com/view?id=Wood048> |
| `wood-dark_*` | Wood027 (1K-JPG) | dark frame wood | <https://ambientcg.com/view?id=Wood027> |
| `slate_*` | Onyx013 (1K-JPG) | slate/dark stone boards | <https://ambientcg.com/view?id=Onyx013> |
| `felt_*` | Fabric034 (1K-JPG) | table felt | <https://ambientcg.com/view?id=Fabric034> |

License: CC0-1.0 (<https://docs.ambientcg.com/license/>).

## 3D chess set — `games-art/chess3d/`

Photoscanned chess set (pieces + board) from [Poly Haven](https://polyhaven.com), repackaged
by `scripts/prep-chess3d.mjs` (re-run it to reproduce the pack from upstream):

- **Asset:** "Chess Set" — <https://polyhaven.com/a/chess_set>
- **Author:** Riley Queen
- **License:** CC0-1.0 (`games-art/chess3d/LICENSE.txt`) — no attribution required; recorded
  for provenance and listed on the credits screen anyway.
- **Repackaging:** one geometry-only GLB per piece type × color (12) + `board.glb`, re-exported
  from the official 2k glTF release (source nodes `piece_<type>_<color>_NN`); the three shared
  PBR JPEG sets ship once under `chess3d/textures/` (diffuse 2k, normal + ARM 1k;
  ARM = R:AO / G:roughness / B:metalness). `manifest.json` records per-file tri counts/bytes,
  the physical square size, and the board-top height. Pack total ≈ 9.9 MB (budget 15 MB).
- **Loader:** `src/renderer/src/games/three/chessSet.ts` ('marble' = native scan; 'wood' =
  recolor of the same maps). Smoke gate: `scripts/smoke-chess3d.mjs`.

## How the assets are wired

- **Packaged builds:** `electron-builder.yml` `extraResources` copies `resources/games-art` →
  `<resourcesPath>/games-art`.
- **Renderer URL resolution (dev + packaged):** `src/renderer/src/games/art.ts`
  (`gamesArtUrl('shogi/kanji/0OU.svg')`); it also installs `window.__gamesArtBase` for the 3D
  tabletop's `games/three/artLoader.ts`.
