# Third-party notices

nodechess is distributed under GPL-3.0-or-later (see [LICENSE](LICENSE)). It bundles or imports the following
third-party software and data. Each is used under its own license, reproduced or linked below. Several of the
engines are GPL binaries. For each one the corresponding source is offered as the upstream link in its entry;
no source tarball is shipped inside the installer.

---

## Stockfish (chess engine)

- **Project:** https://github.com/official-stockfish/Stockfish
- **Version:** Stockfish 18 (tag `sf_18`)
- **License:** GNU General Public License v3.0 (GPL-3.0)
- **Corresponding source:** https://github.com/official-stockfish/Stockfish/tree/sf_18
- **Notes:** Distributed as the official per-platform builds with the NNUE evaluation network embedded:
  Windows x86-64 (AVX2) and macOS Apple Silicon. Neither is bundled in the installer; both are mirrored on
  this project's `datasets-v1` release and downloaded on demand from **Settings → Datasets**
  (`src/main/datasets/datasets.service.ts`). GPLv3 requires that the corresponding source be available to
  recipients; it is, at the link above, and nodechess is itself GPL-3.0-or-later. Stockfish's NNUE network
  is trained in part on Leela Chess Zero self-play data (ODbL); that affects the network's training data,
  not redistribution of the compiled binary, which is governed by GPLv3.

## Stockfish.js (Stockfish WebAssembly, web build)

- **Project:** https://github.com/nmrugg/stockfish.js
- **Version:** 18.0.8 (npm `stockfish`), the Stockfish 18 "lite" builds
- **License:** GNU General Public License v3.0 (GPL-3.0)
- **Corresponding source:** https://github.com/nmrugg/stockfish.js
- **Notes:** The Emscripten port of Stockfish, and the engine behind standard chess in the web app: the
  native binary above is desktop only. `stockfish-18-lite[.js/.wasm]` (multithreaded) and
  `stockfish-18-lite-single[.js/.wasm]` (the fallback when the page is not cross-origin isolated) are
  copied verbatim into `dist-web/engines/` by `vite.web.config.ts` and served same-origin, so the web
  build redistributes them. The small NNUE net is embedded in the `.wasm`; nothing loads from a CDN.

## Fairy-Stockfish (variant engine)

- **Project:** https://github.com/fairy-stockfish/Fairy-Stockfish
- **Version:** 14.0.1 on macOS (the bundled binary reports `Fairy-Stockfish 14.0.1 XQ`), 14 on Windows
- **License:** GNU General Public License v3.0 (GPL-3.0). Copyright Fabian Fichter.
- **Corresponding source:** https://github.com/fairy-stockfish/Fairy-Stockfish/tree/fairy_sf_14_0_1_xq
  (macOS) and https://github.com/fairy-stockfish/Fairy-Stockfish/tree/fairy_sf_14 (Windows)
- **Notes:** The rules and search behind every non-chess chess-family bot: xiangqi, shogi, janggi,
  makruk, placement and the variant wave. This is the one compiled engine nodechess ships rather than
  downloads. `resources/engine/mac/fairy-stockfish` (arm64 Mach-O, ~750 KB) is committed to this
  repository and copied into the macOS app by `electron-builder.yml`, because upstream publishes no macOS
  build. It is the Homebrew 14.0.1 bottle binary, which Homebrew compiles from the `fairy_sf_14_0_1_xq`
  tag above with `largeboards=yes` and no patches. On Windows the official
  `fairy-stockfish-largeboard_x86-64.exe` from the `fairy_sf_14` release is downloaded on demand instead
  (`src/main/datasets/fairyStockfish.ts`, this project's mirror first, the upstream release URL as
  fallback). The GPLv3 obligation is met as it is for Stockfish: the corresponding source is the upstream
  tree at the links above, and nodechess is itself GPL-3.0-or-later.

## Fairy-Stockfish WebAssembly builds

Two separate WASM packagings of Fairy-Stockfish are compiled into the app rather than downloaded, so both
ship in the desktop renderer bundle and in `dist-web/`. Both are GPL-3.0, like the native engine above.
One is redistributed unmodified and one is patched in this repository; each entry says which.

- **fairy-stockfish-nnue.wasm** (the variant engine in the browser)
  - **Project:** https://github.com/fairy-stockfish/fairy-stockfish.wasm
  - **Version:** 1.1.11
  - **License:** GPL-3.0. Copyright Fabian Fichter.
  - **Notes:** Redistributed unmodified. `stockfish.js`, `stockfish.wasm` and `stockfish.worker.js` are
    copied verbatim into `dist-web/engines/fairy/` by `vite.web.config.ts`.

- **ffish-es6** (the variant rules library)
  - **Project:** https://github.com/ianfab/Fairy-Stockfish/tree/master/tests/js
  - **Version:** 0.7.9
  - **License:** GPL-3.0. Copyright Fabian Fichter and Johannes Czech.
  - **Notes:** MODIFIED. `scripts/patch-ffish-csp.mjs` rewrites the package's embind glue in place on
    `npm postinstall` so it no longer calls `new Function`, which is what lets the desktop CSP stay
    without `unsafe-eval` (`src/main/security.ts`). The patch is `scripts/lib/ffish-csp-patch.mjs` in
    this repository, so the modified corresponding source is here alongside the unmodified upstream link.
    The patched module and its `.wasm` are emitted into `out/renderer/assets/` and `dist-web/assets/`.

## lc0 / Leela Chess Zero (engine for the Maia bots)

- **Project:** https://github.com/LeelaChessZero/lc0
- **Version:** 0.32.1
- **License:** GNU General Public License v3.0 (GPL-3.0)
- **Corresponding source:** https://github.com/LeelaChessZero/lc0/tree/v0.32.1
- **Notes:** Loads the Maia weights below and plays the "Human" chess style. Desktop only, and not
  bundled: `src/main/datasets/maia.ts` downloads it on demand into the per-user datasets folder. Windows
  gets `lc0.exe` extracted from the official `lc0-v0.32.1-windows-cpu-dnnl.zip`; macOS gets the
  Apple-Silicon binary from the Homebrew 0.32.1 bottle, which links only system libraries. Same GPLv3
  corresponding-source position as Stockfish: the upstream tree at the link above, with nodechess itself
  GPL-3.0-or-later.

## oneDNN (shipped next to the Windows lc0 build)

- **Project:** https://github.com/uxlfoundation/oneDNN
- **License:** Apache License 2.0
- **Notes:** `dnnl.dll`, taken unmodified from the official lc0 Windows release zip and downloaded
  alongside `lc0.exe`. It is lc0's CPU backend; nodechess does not link against it directly. Windows
  only, and not bundled.

## Maia (human-like chess weights)

- **Project:** https://github.com/CSSLab/maia-chess
- **Version:** release `v1.0`: `maia-1100`, `maia-1300`, `maia-1500`, `maia-1700`, `maia-1900`
- **License:** GNU General Public License v3.0 (GPL-3.0), the license on the maia-chess repository.
  Upstream states no separate terms for the weight files themselves.
- **Source:** https://github.com/CSSLab/maia-chess/releases/tag/v1.0
- **Notes:** Five lc0-format neural nets, ~1.3 MB each, from the CSSLab maia-chess project. They are
  trained on human games from the Lichess database to predict the move a player of a given rating would
  play, which is what the "Human" style uses instead of a strength cap. Desktop only, and not bundled:
  `src/main/datasets/maia.ts` downloads them on demand, this project's mirror first with the CSSLab
  release as the fallback. Both serve byte-identical files.

## KataGo (Go engine)

- **Project:** https://github.com/lightvector/KataGo
- **Version:** 1.16.5
- **License:** MIT. Copyright 2025 David J Wu ("lightvector") and/or other authors of the content in that
  repository.
- **Source:** https://github.com/lightvector/KataGo/tree/v1.16.5
- **Notes:** The Go engine, driven over GTP. Desktop only, and not bundled: `src/main/datasets/katago.ts`
  downloads one archive per platform on demand and extracts it with the OS's own `tar`. Windows is the
  official `katago-v1.16.5-eigen-windows-x64.zip`, unmodified, which carries KataGo's MSVC runtime,
  libzip and OpenSSL DLLs. macOS is a relocatable bundle built from the Homebrew 1.16.5 bottle (Metal
  backend): the binary plus its transitive Homebrew dependency dylibs, load paths rewritten to
  `@executable_path` and ad-hoc signed. Those dependency libraries are redistributed under their own
  upstream licenses, not under KataGo's MIT license.

## KataGo neural networks

- **g170 nets** (`kata-b6c96.bin.gz`, `kata-b10c128.bin.gz`), the ordinary strength levels
  - **Source:** https://katagoarchive.org/g170/ (`g170-b6c96-s175395328-d26788732` and
    `g170e-b10c128-s1141046784-d204142634`)
  - **License:** Creative Commons CC0 1.0 Universal (public domain dedication), per
    https://katagoarchive.org/g170/LICENSE.txt, where Jane Street and David J. Wu ("lightvector") each
    dedicate their portion of the training data to the public domain.
- **Human-SL net** (`kata-b18-humanv0.bin.gz`, optional, 94.5 MB), the human-like levels
  - **Source:** `b18c384nbt-humanv0.bin.gz` from the KataGo v1.15.0 release,
    https://github.com/lightvector/KataGo/releases/tag/v1.15.0
  - **License:** not stated upstream. KataGo's MIT license covers the content of its repository; neither
    that license nor the v1.15.0 release names terms for this net or a source for its training data. It
    is redistributed as published.
- **Notes:** All three are mirrored on this project's `datasets-v1` release and downloaded on demand by
  `src/main/datasets/katago.ts`, with the upstream URLs as fallbacks. None is bundled.

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
