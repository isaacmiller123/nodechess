# Third-party notices

nodechess is distributed under GPL-3.0-or-later (see [LICENSE](LICENSE)). It bundles or imports the following
third-party software and data. Each is used under its own license, reproduced or linked below.

---

## Stockfish (chess engine)

- **Project:** https://github.com/official-stockfish/Stockfish
- **Version:** Stockfish 18 (tag `sf_18`)
- **License:** GNU General Public License v3.0 (GPL-3.0)
- **Corresponding source:** https://github.com/official-stockfish/Stockfish/tree/sf_18
- **Notes:** Distributed as the official Windows x86-64 (AVX2) build with the NNUE evaluation network
  embedded. GPLv3 requires that the corresponding source be available to recipients; it is, at the link
  above, and nodechess is itself GPL-3.0-or-later. Stockfish's NNUE network is trained in part on
  Leela Chess Zero self-play data (ODbL); that affects the network's training data, not redistribution of
  the compiled binary, which is governed by GPLv3.

## Lichess puzzle database

- **Source:** https://database.lichess.org/
- **License:** Creative Commons CC0 1.0 Universal (public domain dedication)
- **Notes:** ~6 million puzzles. Used to build the bundled/imported `puzzles.sqlite`. CC0 imposes no
  conditions; attribution is given voluntarily.

## lichess-org/chess-openings (ECO opening book)

- **Source:** https://github.com/lichess-org/chess-openings
- **License:** Creative Commons CC0 1.0 Universal (public domain dedication)
- **Notes:** 3,733 named ECO lines. Used to generate the openings explorer dataset and the live
  position-lookup map.

## Chessground (board UI)

- **Project:** https://github.com/lichess-org/chessground
- **License:** GPL-3.0

## chessops (chess rules / FEN / PGN)

- **Project:** https://github.com/niklasf/chessops
- **License:** GPL-3.0

## qrcode-generator (QR encoding)

- **Project:** https://github.com/kazuhikoarase/qrcode-generator
- **Version:** 2.0.4
- **License:** MIT
- **Copyright:** 2009 Kazuhiko Arase
- **Notes:** Bundled, not fetched. Generates the device sign-in code shown on the Account page.
  "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

## jsQR (QR decoding fallback)

- **Project:** https://github.com/cozmo/jsQR
- **Version:** 1.4.0
- **License:** Apache-2.0
- **Copyright:** Cosmo Wolfe and contributors
- **Notes:** Bundled, not fetched. The camera scanner uses the browser's native `BarcodeDetector`
  where it exists (Chrome, Edge, Android) and falls back to this pure-JavaScript decoder on Safari
  and Firefox. Nothing loads from a CDN: the web build is offline-first and its headers require
  cross-origin isolation.

## Piece sets

The bundled piece sets (e.g. cburnett, merida, chessnut, fantasy, pirouetti) originate from the Lichess
asset collection and are used under their respective open licenses (CC0 / CC-BY-SA / GPL as applicable).
The active set's author and license are shown in **Settings → Appearance**.

## Sounds

- **"Standard" sound theme**, the Lichess standard sound set
  - **Source:** [lichess-org/lila](https://github.com/lichess-org/lila), commit
    [`ecf6f39ed8b5`](https://github.com/lichess-org/lila/tree/ecf6f39ed8b5dc6d9b5d6847954e8cd332127b1d/public/sound/standard)
    (`public/sound/standard/`)
  - **License:** GNU Affero General Public License v3.0 or any later version (AGPL-3.0-or-later),
    per lila's COPYING.md. Copyright (c) 2012–2026 the lila authors.
  - **Notes:** Files are unmodified apart from renaming to this app's sound-event names and are
    distributed as data assets alongside (not linked into) this GPL-3.0-or-later application. The
    full file mapping and license details live in
    `src/renderer/src/assets/sounds/ATTRIBUTION.md`.
- **"Classic" and "Realistic" sound themes** are original works synthesized offline in-repo by
  `scripts/gen-sounds.mjs` (pure-Node procedural audio, no third-party recordings) and are covered
  by this project's own license.

## Icons

UI icons are from [Lucide](https://lucide.dev/), under the ISC License.

## Fonts

Bundled as `.woff2` under `resources/fonts/`, with each project's full license text beside them.
Nothing is fetched from a font CDN at runtime: the desktop CSP pins `font-src 'self'` and the
offline mode requires every byte to be local. All three are SIL Open Font License 1.1, which
permits bundling and redistribution as part of a larger work; none declares a Reserved Font Name.

- **Inter** (UI text)
  - **Project:** https://github.com/rsms/inter
  - **License:** SIL Open Font License 1.1 (`resources/fonts/LICENSE-Inter.txt`)
  - **Copyright:** 2016 The Inter Project Authors
  - **Files:** `inter-latin-wght-normal.woff2`, `inter-latin-ext-wght-normal.woff2`,
    `inter-latin-wght-italic.woff2`
  - **Notes:** Google Fonts' Inter v20 build, variable on the `wght` axis, in Google's standard
    `latin` and `latin-ext` unicode-range subsets. Redistributed unmodified; the other subsets
    Google publishes (cyrillic, greek, vietnamese) are not bundled.

- **JetBrains Mono** (clocks, evaluations, keys, hashes)
  - **Project:** https://github.com/JetBrains/JetBrainsMono
  - **License:** SIL Open Font License 1.1 (`resources/fonts/LICENSE-JetBrainsMono.txt`)
  - **Copyright:** 2020 The JetBrains Mono Project Authors
  - **Files:** `jetbrains-mono-latin-wght-normal.woff2`,
    `jetbrains-mono-latin-ext-wght-normal.woff2`
  - **Notes:** Google Fonts' JetBrains Mono v24 build, variable on the `wght` axis, `latin` and
    `latin-ext` subsets. Redistributed unmodified.

- **Noto Sans Symbols 2** (the twelve chess figurines plus the star, check and cross used by the
  analysis move badges: U+2605, U+2654-265F, U+2713, U+2717)
  - **Project:** https://github.com/notofonts/symbols
  - **License:** SIL Open Font License 1.1 (`resources/fonts/LICENSE-NotoSansSymbols2.txt`)
  - **Copyright:** The Noto Project Authors
  - **File:** `noto-sans-symbols-2-ui.woff2`
  - **Notes:** MODIFIED. Google Fonts' `symbols` subset, further subset to those fifteen characters
    with `pyftsubset` (382 KB down to 3.2 KB). Under OFL 1.1 this is a Modified Version; it is
    redistributed under the same license and the font is referenced in CSS as `nodechess Symbols`
    so it is never mistaken for the unmodified upstream family.

---

If you believe any attribution here is incomplete or incorrect, please open an issue.
