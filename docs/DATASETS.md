# Datasets

nodechess keeps the repository and installer lean by **not** committing or bundling the two large datasets it
needs. Instead they are imported at runtime, with one click, from this project's public GitHub release, and
stored under your user-data folder. This document covers what they are, where they come from, their
licenses, and how to host or rebuild them yourself.

## What gets imported

| Key | Dataset | Imported file | Download size | On-disk size |
|---|---|---|---|---|
| `engine` | Stockfish 18 (per-OS binary, NNUE embedded) | `datasets/engine/stockfish.exe` (Windows) · `datasets/engine/stockfish` (macOS/Linux) | ~109 MB | ~109 MB |
| `puzzles` | Lichess puzzle database (Zstandard-compressed SQLite) | `datasets/puzzles.sqlite` | ~673 MB | ~2.0 GB |
| `maia` | lc0 0.32.1 (per-OS) + Maia 1100–1900 weights (the "Human" chess style) | `datasets/maia/lc0[.exe]` (+ `dnnl.dll` on Windows) · `datasets/maia/weights/maia-<level>.pb.gz` | ~2–21 MB + 5 × ~1.3 MB | same |
| `katago` | KataGo 1.16.5 (per-OS archive) + Go nets (b6c96, b10c128; Human-SL b18 optional) | `datasets/katago/katago[.exe]` (+ libs + `default_gtp.cfg`) · `datasets/katago/nets/kata-*.bin.gz` | ~4.5 MB + 3.7/11.1/94.5 MB | ~36 MB + nets |

The engine artifact is selected per `process.platform`/`process.arch` (see `ENGINE_ARTIFACTS` in
`src/main/datasets/datasets.service.ts`); the puzzle SQLite is byte-for-byte identical on every OS. Both
are stored under `app.getPath('userData')/datasets/`: `%APPDATA%/nodechess/datasets/` on Windows,
`~/Library/Application Support/nodechess/datasets/` on macOS (in development this is redirected to
`<project>/.devdata/datasets/`). Every consumer resolves an **imported file first**, then any bundled file,
so importing applies without a reinstall.

> The folder name comes from `productName`, so installs made before the nodechess rename hold their data
> under `Chess#/` instead. Electron will not find it under the new name. Anyone upgrading in place has to
> re-import, or move the old folder across by hand, until a migration ships.

The smaller content is committed to the repo and bundled in the app, so those features work
immediately: the openings book, the 0→2000 curriculum, famous games, persona definitions, and
piece/sound assets.

## How the importer works

`Settings → Datasets → Import datasets` triggers the main-process importer (`src/main/datasets`):

1. Streams the artifact matching the host OS/arch from the release URL.
2. For the puzzle DB, decompresses the Zstandard stream on the fly using Node's built-in `zlib` zstd
   support (Node 24+ / Electron 42). No external tools required.
3. Verifies the download against a known **SHA-256** and writes atomically (`*.part` → rename), so a failed
   or cancelled download never leaves a corrupt install.
4. On macOS/Linux, marks the freshly written engine binary executable (`chmod 0o755`) so it can be spawned.

The download is the only time the app touches the network; everything afterwards is fully offline.

## Provenance & licensing

### Stockfish 18: GPL-3.0

- **Binary source:** the official release at <https://github.com/official-stockfish/Stockfish/releases>
  (tag `sf_18`), one binary per OS/CPU: `stockfish-windows-x86-64-avx2` on Windows,
  `stockfish-macos-m1-apple-silicon` on Apple-Silicon macOS (and the matching `stockfish-macos-x86-64-avx2`
  on Intel). The NNUE evaluation network is embedded in each binary.
- **License:** GNU GPL v3. Redistributing the binary obliges us to offer the **corresponding source**.
  That source is the upstream repository at tag `sf_18`:
  <https://github.com/official-stockfish/Stockfish/tree/sf_18>. Because nodechess itself is licensed
  GPL-3.0-or-later, this obligation is satisfied for the whole distribution.

### Lichess puzzle database: CC0-1.0

- **Source dump:** `https://database.lichess.org/lichess_db_puzzle.csv.zst` (~300 MB), from
  <https://database.lichess.org/>: ~6 million puzzles, columns
  `PuzzleId, FEN, Moves, Rating, RatingDeviation, Popularity, NbPlays, Themes, GameUrl, OpeningTags`.
- **License:** Creative Commons CC0 1.0 (public domain). No attribution required; credit is given gladly.
- nodechess builds the dump into an indexed `puzzles.sqlite` (see `scripts/build_puzzles_db.py`) and
  distributes that SQLite file Zstandard-compressed.

### Games-platform engines (datasets-v1 assets, uploaded + verified 2026-07-06)

All of these live on the same `datasets-v1` release. The chess-family/Go bot engines are per-platform;
the nets are platform-independent. Asset name → size → sha256:

| Asset | Bytes | sha256 | Source / license |
|---|---|---|---|
| `stockfish-sf18-win-x64.exe` | 114007552 | `c86215fa…118911` | official sf_18 build, GPL-3.0 |
| `stockfish-sf18-mac-arm64` | 113853992 | `bc0cac90…563590` | official sf_18 m1-apple-silicon, GPL-3.0 |
| `fairy-stockfish-14-win-x64.exe` | 1930240 | `2fe12ff0fcad0295482cab7660e1fcc24259cebc4ef164839fb16c9f9cabfc99` | official `fairy_sf_14` release, `fairy-stockfish-largeboard_x86-64.exe`, GPL-3.0 |
| `fairy-stockfish-14-mac-arm64` | 743240 | `df96025ba16b8be2c3f7ae2e867844545330915e477c512eaf4c1202918f9e87` | Homebrew 14.0.1 bottle binary (largeboard: xiangqi/shogi/janggi present; links system libs only), GPL-3.0 |
| `lc0-0.32.1-win-x64.exe` | 2196992 | `2130a6b980c8d9543888d3d4b2e45642b550ba73b36e05ae892e9c9130afd5ed` | from official `lc0-v0.32.1-windows-cpu-dnnl.zip`, GPL-3.0 |
| `lc0-0.32.1-win-x64-dnnl.dll` | 19601280 | `4c642ebe5e4300fb74417d43cc57d5ef33656f7b5fc536a9655ca02f8120c930` | same zip (oneDNN, Apache-2.0) |
| `lc0-0.32.1-mac-arm64` | 1848672 | `6a6f5e8083025c6cd194ddcfb3ead17b51347c4591cff436670ce7a3bd14f98f` | Homebrew 0.32.1 bottle `libexec/lc0` (system libs only), GPL-3.0 |
| `katago-win-x64.zip` | 4773666 | `02c0dd2417939bf891988f7106e4776e513c2a198e2338bd42aa826def67669b` | official `katago-v1.16.5-eigen-windows-x64.zip`, unmodified, MIT-style (see upstream LICENSE) |
| `katago-mac-arm64.tgz` | 4451080 | `bd6cf118f55654936143aee0656105a40b3263bb4ca3f9c1f58d1a820bb1463b` | relocatable bundle built from the Homebrew 1.16.5 bottle (Metal backend): binary + 84 dylibs rewritten to `@executable_path`, ad-hoc signed, + `default_gtp.cfg` |
| `kata-b6c96.bin.gz` | 3827339 | `f57fddf4672364d385d6ab177364ab819810d1123e229cb2649c4f337a2160b1` | katagoarchive.org g170 (`g170-b6c96-s175395328-d26788732`), CC0 |
| `kata-b10c128.bin.gz` | 11138361 | `1a8e05a4ea3fca20dab79410cbb566c760767fcdd2fa0b701cfe259a84cc8b04` | katagoarchive.org g170 (`g170e-b10c128-s1141046784-d204142634`), CC0 |
| `kata-b18-humanv0.bin.gz` | 99066230 | `637746e44f0efe00ad1245a50aa9bbf0716efe364c43965ead97bd6835d84ab5` | KataGo v1.15.0 release (`b18c384nbt-humanv0.bin.gz`, Human-SL) |
| `maia-1100.pb.gz` … `maia-1900.pb.gz` | ~1.3 MB each | see `MAIA_WEIGHTS` in `src/main/datasets/maia.ts` | mirror of CSSLab maia-chess v1.0, GPL-3.0 |

Consumers: `src/main/datasets/maia.ts` (lc0 + maia weights; mirror-first with CSSLab fallback for the
weights) and `src/main/datasets/katago.ts` (KataGo archive + nets; mirror-first with
katagoarchive.org/GitHub fallback). The KataGo binary ships as an **archive** (it is not
self-contained on either OS); the importer extracts it with the system `tar` (bsdtar, present on
macOS and Windows 10+, and it reads `.zip` as well as `.tgz`). Everything else follows the raw
one-file-per-item pattern. `scripts/verify-katago.mjs` spawns the imported mac KataGo over GTP with
the b6c96 net and prints a 9×9 `genmove` as proof the bundle runs. Rebuilding the mac KataGo bundle:
install `katago` from Homebrew, copy the binary + transitive `/opt/homebrew` dylibs, rewrite ids/load
paths to `@executable_path/<name>` with `install_name_tool`, `codesign -f -s -` each file, add
`default_gtp.cfg` from the bottle's `share/katago/configs/gtp_example.cfg`, then `tar -czf` the
directory contents (files at archive root).

The Fairy-Stockfish group is wired in `src/main/datasets/fairyStockfish.ts` (mirror-first from this
release, official `fairy_sf_14` URL as the win-x64 fallback; the mac binary additionally ships
BUNDLED in `resources/engine/mac`, see `electron-builder.yml`). Keep asset names + checksums in
sync with this table.

### lichess-org/chess-openings: CC0-1.0

- **Source:** the `a.tsv`–`e.tsv` files at <https://github.com/lichess-org/chess-openings>, 3,733 named
  ECO lines (`eco`, `name`, `pgn`).
- **License:** CC0 1.0 (public domain).
- The openings explorer dataset (`src/renderer/src/features/openings/openings-db.json`) and the live
  position-lookup map (`resources/openings/openings.json`) are generated from these and committed, since
  they are small.

## Rebuilding the datasets yourself

You don't need the release to build everything from the original public sources:

```bash
# Stockfish engine -> resources/engine/<os>/stockfish[.exe]  (auto-detects your OS/CPU)
npm run setup:engines

# Lichess puzzle dump -> data/raw, then build the SQLite DB -> resources/data/puzzles.sqlite
# (build:puzzles needs Python 3.14+ for stdlib zstd, or `pip install zstandard` on older Python)
npm run setup:puzzles
npm run build:puzzles

# Openings (both the explorer list and the lookup map)
npm run build:openings        # resources/openings/openings.json (EPD -> {eco,name})
node scripts/build-openings-list.mjs  # src/.../openings-db.json (full searchable book)
```

## Hosting the release assets (maintainers)

The importer (`src/main/datasets/datasets.service.ts`) points at a release named `datasets-v1`. Besides the
games-platform assets tabulated above, it needs the shared puzzle DB plus **one engine binary per supported
platform**: the raw binary, not the upstream archive (this importer streams a single file; it does not
unzip/untar):

- `puzzles.sqlite.zst`: `resources/data/puzzles.sqlite` compressed with Zstandard (level ~12). Shared by all OSes.
- `stockfish-sf18-win-x64.exe`: a copy of `resources/engine/win/stockfish.exe`.
- `stockfish-sf18-mac-arm64`: a copy of `resources/engine/mac/stockfish` (Apple Silicon).

Each engine asset name + its `bytes`/`sha256` live in the `ENGINE_ARTIFACTS` map in
`src/main/datasets/datasets.service.ts`, keyed by `${process.platform}-${process.arch}`. **Adding a platform
= upload its raw binary here and add one verified row to that map.** Until a platform's asset is uploaded,
Macs/PCs of that kind can still run from a *bundled* engine (a from-source build) but cannot import one.

To regenerate and publish them:

```bash
# Compress the puzzle DB (Node has zstd built in; no CLI needed)
node -e "const fs=require('fs'),z=require('zlib'),{pipeline}=require('stream'); \
  pipeline(fs.createReadStream('resources/data/puzzles.sqlite'), \
  z.createZstdCompress({params:{[z.constants.ZSTD_c_compressionLevel]:12}}), \
  fs.createWriteStream('puzzles.sqlite.zst'), e=>{if(e)throw e; console.log('done')})"

# Engine binaries (run setup:engines on each OS first to populate resources/engine/<os>/)
cp resources/engine/win/stockfish.exe stockfish-sf18-win-x64.exe   # on Windows
cp resources/engine/mac/stockfish      stockfish-sf18-mac-arm64    # on Apple-Silicon macOS

# Record the sha256 + byte size for each, then update ENGINE_ARTIFACTS to match:
shasum -a 256 stockfish-sf18-mac-arm64 && stat -f%z stockfish-sf18-mac-arm64

gh release create datasets-v1 \
  puzzles.sqlite.zst stockfish-sf18-win-x64.exe stockfish-sf18-mac-arm64 \
  --title "Datasets v1" --notes "Stockfish 18 engines (per-OS) + Lichess puzzle DB (compressed)."
# (or `gh release upload datasets-v1 stockfish-sf18-mac-arm64` to add the Mac binary to an existing release)
```

If you change the asset bytes, update the matching `bytes`/`sha256` fields in
`src/main/datasets/datasets.service.ts` (the importer verifies them). The current `darwin-arm64` row already
carries the verified checksum for `stockfish-sf18-mac-arm64`.
