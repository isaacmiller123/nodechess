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

## Piece sets

The bundled piece sets (e.g. cburnett, merida, chessnut, fantasy, pirouetti) originate from the Lichess
asset collection and are used under their respective open licenses (CC0 / CC-BY-SA / GPL as applicable).
The active set's author and license are shown in **Settings → Appearance**.

## Sounds

- **"Standard" sound theme — Lichess standard sound set**
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

UI icons are from [Lucide](https://lucide.dev/) — ISC License.

---

If you believe any attribution here is incomplete or incorrect, please open an issue.
