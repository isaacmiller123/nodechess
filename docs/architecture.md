# ARCHITECTURE & TECH DECISIONS

> Lead-architect spec for the offline Electron chess **analysis & teaching** app:
> Stockfish analysis, LOCAL-only (no-LLM) coaching, fully bundled content, polished UI.
> This document is the source of truth for the stack, process model, IPC surface, data
> pipeline, engine bundling, packaging, repo layout, and the FOUNDATION (v0) milestone.
>
> Companion specs: `docs/ui-ux.md`, `docs/content-coaching.md`, `docs/feature-addendum.md`,
> `docs/STATUS.md`. Where this doc and the addendum disagree on detail, **this doc wins for
> architecture**; the addendum wins for feature scope.

---

## 0. Licensing posture (decides several stack choices up front)

The app is **GPL-3.0** as a whole, and that is a deliberate, locked decision:

- **Stockfish** (engine) and **lc0** (Maia body) are GPL-3.0 — they ship as arms-length UCI
  subprocesses, not linked code.
- **chessground** (board UI) and **chessops** (rules/PGN/EPD) are GPL-3.0.
- Because we are already in GPL territory, we **do not** pay the "stay permissive" tax: we use
  the best lichess-grade libraries (chessground + chessops) directly instead of avoiding them.

Consequences honored throughout this spec:

1. Ship the **verbatim GPL-3.0 / LICENSE texts** plus a **THIRD-PARTY-NOTICES** file and an
   in-app **About → Licenses** screen.
2. Ship a **written offer + pinned source pointer** for each GPL/AGPL binary (Stockfish, lc0).
   We ship the *unmodified official* binaries, pinned to an exact release tag, so the cleanest
   compliance is to point at that tag and bundle a source tarball in `resources/licenses/`.
3. **Bundled content is open only:** Lichess puzzle DB (CC0), `chess-openings` (CC0), piece
   sets restricted to GPL/Apache/MIT/CC0/CC-BY (default **cburnett**, GPLv2+), board themes as
   CSS flat colors, sounds as **Kenney CC0** (we do NOT ship Lichess "standard" sounds — unclear
   license). No chess.com proprietary assets, ever.
4. **AGPL is deferred** (Maia-3) and never used in any hosted/networked mode.

---

## 1. Final tech stack (versions + rationale)

| Layer | Choice | Version (pin) | Why |
|---|---|---|---|
| Desktop shell | **Electron** | `^32` (Node 20 ABI) | Mature, cross-platform, native child-process for engines, `extraResources`/`asarUnpack` for binaries. |
| Build tooling | **electron-vite** | `^2.3` | Pre-wired main/preload/renderer triple-build, HMR for renderer, hot-reload for main/preload, TS+React out of the box. Documented for electron-builder resource exclusion. |
| Bundler under the hood | **Vite / Rollup** | (via electron-vite) | Fast, ESM-first; mark native deps `external`. |
| UI runtime | **React + TypeScript** | React `^18.3`, TS `^5.5` | Component model fits the analysis/board/sidebar layout; TS for the typed IPC surface. |
| Board rendering | **chessground** | `^9.2` | The actual lichess board: drag+click moves, legal dots, last-move/check highlights, premoves, right-click arrows/circles. Rendering only, no chess logic, zero deps. GPL-3.0 (accepted). |
| Rules / SAN / FEN / EPD / PGN | **chessops** | `^0.15` | lichess-grade. **Decisive:** full PGN game tree (variations + NAGs + comments) via `pgn` module; `makeFen(setup,{epd:true})` for EPD keys; legal-move `dests` map feeds chessground. GPL-3.0 (accepted). |
| Rules fallback (NOT primary) | chess.js | `^1.4` | BSD-2. Used only in **build scripts** (legality validation of famous-game PGNs, UCI↔SAN in ETL) where a tiny dependency is convenient. **Not** the runtime PGN parser — it drops RAV variations. |
| Analysis/play/review engine | **Stockfish** (native NNUE binary) | **18** (release `sf_18`, 2026-01-31), `x86-64-universal` Windows build | Native > WASM: full NNUE, true multithreading, **no SharedArrayBuffer / COOP-COEP plumbing**. NNUE net **embedded** → no loose `.nnue` to ship. `x86-64-universal` auto-detects CPU → one binary, no illegal-instruction crashes. GPL-3.0. *(Supersedes the addendum's "17.x" — pin SF18 as current stable; the integration is identical.)* |
| Human-feel engine | **lc0** (CPU build) + **Maia-1** weights | lc0 `0.31.x` cpu-dnnl/openblas; `maia-1100..1900.pb.gz` | Human move distribution for sub-1900 play. `go nodes 8`. GPL-3.0 (weights treated as GPL pending CSSLab confirmation). |
| Local DB | **better-sqlite3** | `^11` | Synchronous, fastest, mature. Native module → rebuilt for Electron ABI via `@electron/rebuild`, marked `external`, `asarUnpack`'d. **Main process only.** |
| Native rebuild | **@electron/rebuild** | `^3.6` | Rebuilds better-sqlite3 against the shipped Electron ABI on postinstall + in packaging. |
| Spaced repetition | **ts-fsrs** (FSRS-6) | `^4` | MIT, 21 default weights, `request_retention=0.9`. Schedules failed-puzzle / mistake review cards. |
| Ratings | **hand-rolled Glicko-2** (~120 LOC) | in-repo | Glickman spec, numerically verified. Puzzle rating + vs-bot rating. No runtime dep. |
| IPC validation | **zod** | `^3.23` | Schema-validate every IPC payload in `ipcMain.handle`. |
| Packaging | **electron-builder** | `^25` | Windows **NSIS** + **portable** targets; `extraResources` / `asarUnpack` for engines + DB. |
| Icons | **Lucide** | `^0.4xx` | MIT, ~1,600 stroke icons; all 16 app glyphs verified present. Vendored as SVG sprite (offline). Phosphor (MIT) as fallback. |
| Fonts | **Inter** (UI) + **Noto Sans** (fallback) | OFL, self-hosted `.woff2` | Inter ships **tabular figures** by default → eval bar / clocks / ratings align. No Google Fonts hotlink. |
| Charts | **hand-rolled SVG** (eval graph) | — | Best control over the lichess-style advantage fill; zero dep. Recharts (MIT) only if a quick chart is needed elsewhere. |

**Node / npm:** Node 20 LTS (matches Electron 32 ABI), npm 10+. No `"type":"module"` in `package.json` initially (keeps main/preload as plain CJS and avoids the `.cjs` electron-builder glob footgun); revisit later.

---

## 2. Process / module breakdown (main / renderer / preload)

Three Electron processes, hardened to defaults. **All Node, engine, and DB access lives in MAIN; the renderer is pure UI and talks only over the typed IPC bridge.**

### 2.1 MAIN process (`src/main`) — privileged
Owns the OS, the engines, and the database. No UI.

```
src/main/
  index.ts                 # app lifecycle; DEV userData redirect (see §8); window creation
  window.ts                # BrowserWindow factory w/ locked webPreferences + CSP + nav guards
  ipc/
    registry.ts            # registers every ipcMain.handle; one file per domain below
    engine.ipc.ts          # engine:* channels
    puzzles.ipc.ts         # puzzles:* channels
    openings.ipc.ts        # openings:* channels
    games.ipc.ts           # games:* channels
    review.ipc.ts          # review:* channels
    ratings.ipc.ts         # ratings:* / srs:* channels
    coach.ipc.ts           # coach:* channels
    famous.ipc.ts          # famous:* channels
    settings.ipc.ts        # settings:* / app:* channels
  engine/
    StockfishPool.ts       # persistent SF processes: analyze instance + play instance
    Lc0Maia.ts             # lc0 process + Maia weight routing
    UciEngine.ts           # thin hand-rolled UCI wrapper (spawn, line-buffer, MultiPV stream, stop)
    paths.ts               # resolveEnginePath() dev vs process.resourcesPath
  db/
    open.ts                # better-sqlite3 connections: read-only puzzles.sqlite + writable app.sqlite (ATTACH)
    migrations/            # user_version-gated migrations for app.sqlite
    puzzles.repo.ts        # queries over bundled puzzle DB
    games.repo.ts          # game / game_move / progress_snapshot
    ratings.repo.ts        # rating / puzzle_attempt; FSRS cards
  coach/                   # LOCAL no-LLM coaching engine (motif detectors + templates) — see content-coaching.md
  rating/
    glicko2.ts             # hand-rolled Glicko-2
    accuracy.ts            # Lichess Win% + Accuracy% + per-game Elo band
  classify/                # move classification (win% drop buckets, brilliancy/sacrifice detect)
```

Key invariants:
- **Two Stockfish instances**, never one: an *analysis* instance (MultiPV 3–5, `go infinite`) and a
  *play/review* instance (MultiPV 1, bounded `go`), so a live game never blocks the analysis board.
- **Engines spawned from MAIN only** via `child_process.spawn(path, [], {stdio:['pipe','pipe','pipe']})`.
  Killed on `window.closed` and `app.will-quit`; a running `go infinite` is `stop`ped before reuse.
- **DB opened in MAIN only.** `puzzles.sqlite` opened `{readonly:true, fileMustExist:true}` from
  `process.resourcesPath`; the writable `app.sqlite` lives under `userData` and is `ATTACH`ed.

### 2.2 PRELOAD (`src/preload`) — the only bridge
Sandboxed (Electron 20+). Bundled to a **single file** by electron-vite. Exposes exactly one frozen,
typed API object via `contextBridge`. **Never** exposes raw `ipcRenderer`, `fs`, `child_process`, or `path`.

```
src/preload/
  index.ts                 # contextBridge.exposeInMainWorld('api', api)
  api.ts                   # the typed surface (mirrors §4 channels)
```

### 2.3 RENDERER (`src/renderer`) — unprivileged UI
React + chessground + chessops. No Node. Calls only `window.api.*`.

```
src/renderer/
  main.tsx
  App.tsx
  board/
    Chessground.tsx        # ~40-line in-house wrapper (init in useEffect, cg.set on props, destroy on unmount)
    EvalBar.tsx            # Win%-mapped fill, flips with orientation
    PromotionPicker.tsx
  panels/
    EnginePanel.tsx        # MultiPV lines, depth, click-to-preview
    MoveList.tsx           # recursive variation tree, NAG glyphs, current-node highlight
    ReviewPanel.tsx        # accuracy bars, class badges, eval graph
    CoachPanel.tsx         # local coach text
  features/
    play/  puzzles/  openings/  famous/  progress/  curriculum/
    play/online/           # INTERNET multiplayer, renderer-owned WebRTC P2P (see §3.1)
  state/                   # one immutable game-tree store (current path + nodes)
  styles/                  # CSS variables (design tokens), board/piece theme CSS
  shared/types.ts          # shared TS types for window.api (imported by preload + renderer)
```

### 2.4 Security defaults (set explicitly, treated as review bugs if changed)
```ts
webPreferences: {
  contextIsolation: true,   // default ≥12
  nodeIntegration: false,   // default ≥5
  sandbox: true,            // default ≥20
  webSecurity: true,
  preload: <built preload path>,
}
```
Plus: `setWindowOpenHandler(() => ({action:'deny'}))`, a `will-navigate` guard, **no remote origins**,
and a strict **CSP** applied via `session.defaultSession.webRequest.onHeadersReceived`:

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'self' wss:;   /* wss: for the multiplayer signaling relays (see §3.1) */
media-src 'self';
```
Production renderer is served from a registered custom **`app://`** protocol (not `file://`).
Every `ipcMain.handle` validates `event.senderFrame.url` against the `app://` origin allowlist
**and** validates the payload with a zod schema before doing any work.

---

## 3. Renderer ↔ Main data flow (one direction of trust)

```
 RENDERER (sandbox)          PRELOAD (bridge)            MAIN (privileged)
 React UI ───window.api.x──▶ ipcRenderer.invoke('x') ──▶ ipcMain.handle('x')
                                                          ├─ zod.parse(payload)
                                                          ├─ assert sender origin = app://
                                                          ├─ EnginePool / DB repo / coach
   ◀──────── Promise<Result> ◀─────────────────────────  └─ return typed result
```
Streaming (engine `info` lines) uses a **dedicated push channel**: main `webContents.send('engine:line', …)`
throttled per `multipv` index; renderer subscribes via a single `api.engine.onLine(cb)` exposed through
the bridge (the callback is registered through contextBridge, the raw emitter is never exposed).

### 3.1 Internet multiplayer (renderer-owned WebRTC P2P — does NOT cross IPC)

Multiplayer is the one feature that lives **entirely in the renderer** and never touches the main
process or `window.api`. Chromium already ships a native `RTCPeerConnection`, so two nodechess clients
talk **peer-to-peer over a WebRTC data channel** — end-to-end encrypted, direct, no relay in the game
path. There is **no user-run server and no port forwarding**: one player hosts and gets a random room
**code** like `A1B2C-D3E4F` (a 50-bit Crockford-base32 key, *not* an IP); the other enters it and the
two connect across NATs and countries. (This replaced the old same-LAN `ws` transport that lived in
`src/main/mp/` — that whole subtree, its IPC channel, and the `ws` dependency are gone.)

Peer **discovery/signaling** rides on [`trystero`](https://github.com/dmotz/trystero) (Nostr strategy
over a pool of public `wss://` relays): the room code seeds the room key + a derived password, so only
the two players who share the code complete the handshake. Once the data channel is up, no game data
touches the relays. NAT traversal uses public STUN (Google + Cloudflare, the latter for regions where
Google is blocked) with best-effort TURN fallback for symmetric NATs.

Layers (`src/renderer/src/features/play/online/` + `src/shared/mp/`):
- `@shared/mp/wire.ts` — isomorphic wire protocol (zod schemas, `PROTOCOL_VERSION`, hello handshake,
  wire-level ping/pong heartbeat, the room-code codec). Zero Node imports.
- `mpSession.ts` (`MpNetSession`) — pure host-authoritative session logic (clocks, turn order, draw/
  resign/rematch, discovery timeout), transport-agnostic via an injected `MpTransport`.
- `rtcTransport.ts` — the trystero-backed transport factory (the only file that touches the network).
- `mpClient.ts` — the singleton `mp` the UI imports.

Because `MpNetSession` and the wire protocol are pure and transport-injected, they run unchanged under
bare Node: `scripts/test-mp.mjs` drives a full host↔guest game over an in-memory transport pair, and
`scripts/check-relays.mjs` probes live relay/TURN reachability.

Security note: this is the reason the CSP `connect-src` is `'self' wss:` (not just `'self'`) — the
signaling relays are outbound WebSockets. WebRTC media/data itself is not subject to `connect-src`.

---

## 4. Secure IPC API surface (channels)

All request/response channels are `ipcRenderer.invoke` ⇄ `ipcMain.handle`. Push channels are
main→renderer events delivered through a bridge-wrapped subscription. Every payload has a zod schema.
Naming: `domain:verb`.

### engine (analysis / play)
| Channel | Dir | Payload → Result |
|---|---|---|
| `engine:analyze` | req | `{fen, multipv, limit:{depth|movetime|nodes|infinite}}` → `{handleId}` (streams `engine:line`) |
| `engine:stop` | req | `{handleId}` → `{ok}` |
| `engine:play` | req | `{fen, level:{uciElo|skill}, limit}` → `{bestmove, ponder?}` |
| `engine:setOptions` | req | `{instance:'analysis'|'play', threads, hash, multipv}` → `{ok}` |
| `engine:newGame` | req | `{instance}` → `{ok}` (sends `ucinewgame`) |
| `engine:status` | req | `{}` → `{analysisReady, playReady, lc0Ready}` |
| `engine:line` | **push** | → `{handleId, depth, seldepth, multipv, scoreCp?, mate?, nodes, nps, pv:string[]}` |
| `engine:bestmove` | **push** | → `{handleId, bestmove, ponder?}` |

### maia (human-feel play)
| Channel | Dir | Payload → Result |
|---|---|---|
| `maia:play` | req | `{fen, rating}` → `{bestmove}` (routes to nearest Maia net, `go nodes 8`) |

### puzzles
| Channel | Dir | Payload → Result |
|---|---|---|
| `puzzles:next` | req | `{theme?, ratingLo?, ratingHi?, excludeSolved?}` → `{puzzle}` |
| `puzzles:get` | req | `{puzzleId}` → `{puzzle}` |
| `puzzles:attempt` | req | `{puzzleId, solved, ms}` → `{ratingAfter, rd, delta}` |
| `puzzles:themes` | req | `{}` → `{themes:[{key,count}]}` |

### openings
| Channel | Dir | Payload → Result |
|---|---|---|
| `openings:lookup` | req | `{epd}` → `{eco, name}\|null` (longest/deepest match) |
| `openings:book` | req | `{fen}` → `{moves:[{uci, san, weight, white, draw, black}]}` (Polyglot + stats) |

### games / review
| Channel | Dir | Payload → Result |
|---|---|---|
| `games:save` | req | `{pgn, headers, opponent, timeControl, userColor, source}` → `{gameId}` |
| `games:list` | req | `{filter?, limit, offset}` → `{games:[…]}` |
| `games:get` | req | `{gameId}` → `{game, moves}` |
| `games:importPgn` | req | `{pgnText}` → `{gameIds:[…]}` |
| `games:exportPgn` | req | `{gameId}` → `{pgnText}` |
| `review:run` | req | `{gameId, depth}` → `{reviewId}` (streams progress) |
| `review:get` | req | `{gameId}` → `{review, moveEvals}` (cached) |
| `review:progress` | **push** | → `{gameId, ply, total}` |

### coach (LOCAL, no-LLM)
| Channel | Dir | Payload → Result |
|---|---|---|
| `coach:explainMove` | req | `{fenBefore, played, best, pv, evalBefore, evalAfter}` → `{verdict, motifs:[…], text}` |
| `coach:positional` | req | `{fen}` → `{terms:[…], text}` |

### ratings / SRS / progress
| Channel | Dir | Payload → Result |
|---|---|---|
| `ratings:get` | req | `{kind:'puzzle'|'vs-bot'}` → `{rating, rd, sigma}` |
| `srs:due` | req | `{limit}` → `{cards:[…]}` |
| `srs:review` | req | `{cardId, grade}` → `{nextDue}` |
| `progress:summary` | req | `{}` → `{strengthBand, puzzleRating, accuracyTrend, curriculumPct}` |
| `perf:estimate` | req | `{gameId}` → `{estElo, low, high, accuracy}` |

### famous games / curriculum / settings
| Channel | Dir | Payload → Result |
|---|---|---|
| `famous:list` | req | `{group?}` → `{games:[…]}` |
| `famous:get` | req | `{id}` → `{game, annotations}` |
| `curriculum:tree` | req | `{}` → `{bands:[…]}` |
| `settings:get` / `settings:set` | req | `{key}` / `{key, value}` → `{value}` / `{ok}` |
| `app:openLicenses` | req | `{}` → `{notices}` |
| `app:dataVersion` | req | `{}` → `{puzzleDbDate, engineVersion, appVersion}` |

The preload `api` object mirrors this exactly, e.g.:
```ts
window.api = {
  engine: { analyze, stop, play, setOptions, onLine, onBestmove },
  puzzles:{ next, get, attempt, themes },
  openings:{ lookup, book },
  games:  { save, list, get, importPgn, exportPgn },
  review: { run, get, onProgress },
  coach:  { explainMove, positional },
  ratings:{ get }, srs:{ due, review }, progress:{ summary }, perf:{ estimate },
  famous: { list, get }, curriculum:{ tree },
  settings:{ get, set }, app:{ openLicenses, dataVersion },
};
```

---

## 5. Data pipeline (download → decompress → transform → bundle)

All ETL runs at **build time on the dev/CI machine**, never on the user's device. Outputs:
`resources/data/puzzles.sqlite` (read-only, bundled) and `resources/openings/openings.json` +
`resources/books/*.bin`. Raw downloads land in `data/raw/` (git-ignored).

Scripts live in `scripts/` and are wired into `package.json`:
```jsonc
"scripts": {
  "setup:engines":  "node scripts/fetch-engines.mjs",     // Stockfish 18 + lc0 + Maia
  "setup:puzzles":  "node scripts/fetch-puzzles.mjs",     // .csv.zst download
  "build:puzzles":  "node scripts/build-puzzles-db.mjs",  // decompress → SQLite
  "build:openings": "node scripts/build-openings.mjs",    // chess-openings → openings.json
  "build:books":    "node scripts/build-books.mjs",       // (NEXT) per-player Polyglot .bin
  "build:famous":   "node scripts/build-famous.mjs",      // PGN validate + engine annotate
  "setup":          "npm run setup:engines && npm run setup:puzzles && npm run build:puzzles && npm run build:openings"
}
```

### 5.1 `fetch-puzzles.mjs` — download
- `GET https://database.lichess.org/lichess_db_puzzle.csv.zst` → `data/raw/` (~286 MiB, CC0).
- Record the `Last-Modified` and byte count to `data/raw/puzzle_download.log` (already present:
  299,950,785 bytes, 2026-06-03) for the in-app **About → Data version**.

### 5.2 `build-puzzles-db.mjs` — decompress → transform → bundle
1. **Decompress with the long-window flag** (mandatory):
   `zstd --long=31 -d lichess_db_puzzle.csv.zst -o lichess_db_puzzle.csv` (or Node zstd in long mode).
   *Without `--long=31` you hit "Frame requires too much memory for decoding."*
2. **Validate the header** equals exactly
   `PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags` — fail loudly on drift.
3. **Schema + fast import** (better-sqlite3, one transaction, `PRAGMA journal_mode=OFF; synchronous=OFF`):
   ```sql
   CREATE TABLE puzzles(
     PuzzleId TEXT PRIMARY KEY, FEN TEXT NOT NULL, Moves TEXT NOT NULL,
     Rating INTEGER NOT NULL, RatingDeviation INTEGER, Popularity INTEGER,
     NbPlays INTEGER, Themes TEXT, GameUrl TEXT, OpeningTags TEXT);
   ```
   Use the CSV reader as a real parser (Themes/OpeningTags are **space-separated inside the field**;
   GameUrl contains `#`).
4. **Prune for installer size** (decisive): keep `NbPlays >= 50 AND Popularity >= 80`, preserving
   full theme/rating coverage → roughly a few hundred K puzzles. *(Tunable; goal is a lean DB.)*
5. **Normalize themes** into a covering junction table for instant theme+rating selection:
   ```sql
   CREATE TABLE puzzle_themes(Theme TEXT, Rating INTEGER, PuzzleId TEXT);
   -- split Themes on spaces in Node, insert ~N×avg(themes) rows
   CREATE INDEX idx_pt ON puzzle_themes(Theme, Rating, PuzzleId);  -- covering
   CREATE INDEX idx_rating ON puzzles(Rating);
   ```
6. `ANALYZE;` then `VACUUM;` → write `resources/data/puzzles.sqlite`.

**Runtime correctness rule (enforced in the puzzle feature, not the DB):** the CSV `FEN` is the
position *before* the opponent's lead-in move. Apply `Moves[0]` to `FEN` to get the position shown to
the player; the **solution starts at `Moves[1]`**. UCI promotions append the piece letter (`e7e8q`).

### 5.3 `build-openings.mjs` — opening names
- Vendor `lichess-org/chess-openings` at a **pinned commit** (CC0).
- Run `bin/gen.py` (`pip install "chess>=1,<2" && make`) to emit `dist/all.tsv`
  (`eco, name, pgn, uci, epd`) — **or** regenerate the `uci`/`epd` columns in Node with chessops if
  avoiding Python in CI (then validate against python-chess as the golden oracle).
- Emit `resources/openings/openings.json`: a map **`epd → {eco, name}`** (~3,733 rows, a few hundred KB).
- **EPD = 4-field FEN** (placement + side-to-move + castling + en-passant), **no move counters**.
- **En-passant rule (the #1 correctness gotcha):** the ep field is set **only when a legal ep capture
  exists**. After `1.e4 e5 2.Nf3` → ep `-`; after `1.e4 Nf6 2.e5 d5` → ep `d6`. The runtime key
  generator (chessops `makeFen{epd:true}`) already does this — covered by a golden-oracle test.
- Runtime name detection: walk game positions, look up each EPD, keep the **deepest** match, stop
  below ~20 pieces (mirrors scalachess `OpeningDb`); transpositions resolve for free.

### 5.4 `build-books.mjs` (NEXT iteration) — opening books
- Build per-player **Polyglot `.bin`** from CC0 Lichess PGNs (`zstd --long=31 -d` the monthly dump,
  filter by Elo/time control, `polyglot make-book`), split White/Black, cap ~12–16 plies. Bundle only
  the **generated `.bin`** (the moves are free facts; never redistribute third-party PGN files verbatim).
- Reader: 16-byte big-endian records `>QHHI`, binary search by Zobrist key; rewrite castling
  (king-captures-rook `e1h1`→`e1g1`) before applying.

### 5.5 `build-famous.mjs` (v0 = engine annotations only)
- ~100 curated PD/CC0 games → validate legality at build time (chess.js) → run **build-time Stockfish 18
  + the coach motif layer** over each → emit `resources/famous/annotations.json` (our content, no third-party
  license). Curated human prose (Wikipedia CC-BY-SA / Gutenberg PD) is partitioned and deferred to NEXT.

---

## 6. Stockfish + NNUE + lc0/Maia: bundling & invocation

### 6.1 What ships
```
resources/
  engine/
    win/stockfish.exe          # SF18 x86-64-universal (NNUE EMBEDDED — no loose .nnue)
    win/lc0.exe                # lc0 CPU build
    win/lc0/ *.dll             # openblas/dnnl runtime deps
    weights/maia-1100.pb.gz … maia-1900.pb.gz
  licenses/
    GPL-3.0.txt
    stockfish-src-<tag>.tar    # corresponding source (or written offer + pinned URL)
    lc0-src-<tag>.tar
    THIRD-PARTY-NOTICES.md
```
- **NNUE is embedded** in the official SF18 binary → no separate network file at runtime.
- `x86-64-universal` auto-detects CPU at startup → one binary, no per-CPU variants, no illegal-instruction crashes.
- The whole `resources/` tree is shipped via electron-builder `extraResources` and is **outside the asar**
  (asar-packed binaries cannot be executed).

### 6.2 Path resolution (the classic dev-vs-packaged bug)
Resolution is **platform-aware off a single code path** (`src/main/datasets/paths.ts`): the binary is
`stockfish.exe` on Windows and `stockfish` (no extension) on macOS/Linux, under a per-OS subfolder
(`win`/`mac`/`linux`). An *imported* engine (in `userData/datasets/`) always wins over a *bundled* one, and
dev resolves relative to `__dirname` while packaged resolves under `process.resourcesPath`:
```ts
const dir  = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const name = process.platform === 'win32' ? 'stockfish.exe' : 'stockfish';
const bundled = app.isPackaged
  ? path.join(process.resourcesPath, 'engine', dir, name)
  : path.join(__dirname, '../../resources/engine', dir, name);
```
The executable bit is set on macOS/Linux at the moment the binary is written — by the dataset importer for an
imported engine (`chmod 0o755`), and by `scripts/fetch_engines.py` for a bundled one.

### 6.3 UCI session protocol (thin hand-rolled wrapper)
On spawn: `uci` → wait `uciok` → `setoption name Threads value <max(1,physicalCores-1)>` →
`setoption name Hash value <128..512 by RAM>` → `isready` → wait `readyok`. `ucinewgame` on reset.
- **Analysis:** `setoption name MultiPV value 3..5`; `position fen <FEN>`; `go infinite` (or `go movetime`);
  **`stop` before any new `go`** on a running infinite search.
- **Play:** `MultiPV 1`; `UCI_LimitStrength true` + `UCI_Elo <1320..3190>` (or `Skill Level 0..20`);
  bounded `go movetime|depth`. Reset `UCI_LimitStrength false` / `Skill Level 20` for full-strength analysis.
- **Line parsing:** buffer stdout, split on `\n` (a chunk may hold partial/multiple lines), tokenize each
  `info` line; everything after `pv` is the move list. Track the latest line per `multipv` index → N stable
  rows. `score cp` is side-to-move-relative centipawns; `score mate N` is mate distance. Search ends at
  `bestmove <m> [ponder <m>]`.
- **Lifecycle:** kill all engine children on window close / `app.will-quit`; `stop` runaway searches.

### 6.4 lc0 + Maia
`lc0 --weights=resources/engine/weights/maia-<n>.pb.gz`, talk UCI the same way, `go nodes 8` for
human-feel moves. Routing: `<1320` → Maia-1100; `<1900` → nearest Maia net; `1900–3190` → Stockfish `UCI_Elo`.

---

## 7. Packaging (electron-builder: Windows NSIS + portable)

`electron-builder.yml`:
```yaml
appId: org.offlinechess.trainer
productName: Offline Chess Trainer
directories: { output: release, buildResources: build }
files:
  - "out/**"                 # electron-vite main/preload/renderer output
asar: true
asarUnpack:
  - "**/node_modules/better-sqlite3/**"
  - "out/main/**/*.node"
extraResources:
  - { from: "resources", to: "." }   # engines, weights, puzzles.sqlite, openings, licenses
win:
  target: [nsis, portable]
  icon: build/icon.ico
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  artifactName: ${productName}-Setup-${version}.${ext}
portable:
  artifactName: ${productName}-Portable-${version}.${ext}
```
- **NSIS** → assisted installer (`Offline Chess Trainer-Setup-x.y.z.exe`).
- **portable** → single self-contained `.exe` (exposes `PORTABLE_EXECUTABLE_DIR/FILE` at runtime).
- The built `puzzles.sqlite` is opened **read-only** from `process.resourcesPath`; any writable copy is
  created in `userData` on first run (writing to a `resourcesPath` DB throws `SQLITE_READONLY`).
- `npm run setup` must complete (engines + DB present in `resources/`) **before** `electron-builder` runs.

---

## 8. DEV containment — nothing leaks to the Desktop

The hard rule: in development, **all** runtime/user data stays inside the project. We redirect Electron's
`userData` (and session data) into a git-ignored project folder **before** the `ready` event, gated on
`!app.isPackaged`. In production, `userData` keeps its OS-default location.

`src/main/index.ts` (very top, before anything touches `app`):
```ts
import { app } from 'electron';
import path from 'node:path';

if (!app.isPackaged) {
  const devData = path.join(__dirname, '../../.devdata');   // <project>/.devdata
  app.setPath('userData', devData);
  app.setPath('sessionData', path.join(devData, 'session'));
}
```
- `app.setPath` **must** run before `ready` (and `sessionData` override too) — that's why it's the first thing in `main`.
- `.devdata/` holds the dev `app.sqlite`, caches, logs, settings — and is **git-ignored** (see §9).
- Raw downloads/build temp live under `data/raw/`, `data/tmp/` — also git-ignored.
- Net effect: a clean `git status` after a dev session shows **no** stray files, and nothing ever lands
  on the Desktop or in the repo root.

---

## 9. Repo directory tree (exact)

```
chess/
├─ .gitignore
├─ .gitattributes                 # Git LFS tracking (see §10)
├─ README.md
├─ package.json
├─ tsconfig.json  tsconfig.node.json  tsconfig.web.json
├─ electron.vite.config.ts        # main / preload / renderer sections
├─ electron-builder.yml
├─ build/                         # installer assets (committed)
│   └─ icon.ico
├─ scripts/                       # build-time ETL (committed)
│   ├─ fetch-engines.mjs
│   ├─ fetch-puzzles.mjs
│   ├─ build-puzzles-db.mjs
│   ├─ build-openings.mjs
│   ├─ build-books.mjs            # NEXT
│   └─ build-famous.mjs
├─ src/
│   ├─ main/        … (see §2.1)
│   ├─ preload/     … (see §2.2)
│   ├─ renderer/    … (see §2.3)
│   └─ shared/
│       └─ types.ts               # IPC types shared by preload + renderer
├─ resources/                     # bundled at package time (mostly git-ignored / LFS)
│   ├─ engine/
│   │   ├─ win/stockfish.exe      # fetched (ignored)
│   │   ├─ win/lc0.exe            # fetched (ignored)
│   │   └─ weights/maia-*.pb.gz   # fetched (ignored)
│   ├─ data/puzzles.sqlite        # built (ignored)
│   ├─ openings/openings.json     # built (committed — small, CC0)
│   ├─ books/*.bin                # built (LFS, NEXT)
│   ├─ famous/                    # curated PGN + annotations.json (committed)
│   ├─ assets/
│   │   ├─ piece/cburnett/*.svg   # committed (GPLv2+) + a few alt sets
│   │   ├─ board/*.css            # flat-color CSS themes
│   │   ├─ sound/*.mp3            # Kenney CC0
│   │   ├─ icons/lucide-sprite.svg
│   │   └─ fonts/Inter*.woff2 NotoSans*.woff2
│   └─ licenses/                  # GPL text, engine source/offer, THIRD-PARTY-NOTICES
├─ data/                          # build inputs (git-ignored)
│   ├─ raw/                       # downloads (.csv.zst, logs)
│   └─ tmp/                       # decompression scratch
├─ .devdata/                      # DEV userData redirect target (git-ignored)
└─ docs/
    ├─ architecture.md            # this file
    ├─ ui-ux.md
    ├─ content-coaching.md
    ├─ feature-addendum.md
    └─ STATUS.md
```

---

## 10. `.gitignore` + Git LFS plan

**Principle:** commit **source + small open data** only. Large binaries and generated DBs are either
**fetched/built by scripts** (so they never enter history — preferred) or, where a binary genuinely
needs versioning, tracked via **Git LFS configured before the first binary commit**.

`.gitignore` (already in place, aligned to §9):
```
node_modules/  .pnp/  .pnp.js
dist/ dist-electron/ out/ build-output/ release/ *.tsbuildinfo
*.exe *.nsis *.dmg *.AppImage *.deb *.snap *.blockmap
/.userdata/ /.appdata/ /.cache/ /.devdata/
/data/raw/ /data/tmp/ *.zst *.zip
/resources/engine/stockfish* /resources/engine/*.exe /resources/engine/**/*.exe /resources/engine/weights/*.pb.gz
/resources/data/*.sqlite /resources/data/*.db *.sqlite-journal *.sqlite-wal *.sqlite-shm
*.log npm-debug.log* .env .env.local .env.*.local
/_*.json
.vscode/* !.vscode/extensions.json !.vscode/settings.json
.idea/ .DS_Store Thumbs.db desktop.ini
```
*(Note: `build/` is a committed installer-assets dir, so the build-output ignore uses a distinct name —
keep electron-vite's output at `out/`/`dist/`, not `build/`, to avoid clobbering `build/icon.ico`.)*

**LFS strategy — fetch-first, LFS only where needed.** The engines, Maia weights, and `puzzles.sqlite`
are **fetched/built by `npm run setup`**, so by default they are git-ignored and **never** enter history
(keeps the repo lean and dodges LFS quota entirely). LFS is reserved for binaries we *choose* to version
(e.g. curated `resources/books/*.bin`, or a release-pinned engine snapshot if we ever vendor one).

`.gitattributes` (committed **before** any binary is ever added):
```
*.nnue   filter=lfs diff=lfs merge=lfs -text
*.bin    filter=lfs diff=lfs merge=lfs -text
*.pb.gz  filter=lfs diff=lfs merge=lfs -text
resources/engine/**/stockfish* filter=lfs diff=lfs merge=lfs -text
*.woff2  -text
*.svg    text eol=lf
*.mjs    text eol=lf
```
Every dev must `git lfs install` once. If LFS quota is a concern, prefer keeping the asset ignored +
fetched. **Never** `git add` a large binary before `.gitattributes` is committed (it bakes the raw blob
into history permanently).

---

## 11. FOUNDATION (v0) milestone

**Goal:** a polished, fully offline analysis board with local coaching, bundled puzzles with a local
rating, calibrated-Elo + human-feel play, full game review with an accuracy-based strength band, and a
small famous-games library — all containerized, all open-licensed, packaged as Windows NSIS + portable.

### 11.1 In scope (v0)
1. **App shell & security** — electron-vite triple-build; locked `webPreferences`; CSP; `app://` protocol;
   typed `window.api`; DEV userData redirect to `.devdata`.
2. **Engine integration** — Stockfish 18 (analysis + play instances) via the UCI wrapper; lc0+Maia-1 for
   human-feel play; bounded `go`, MultiPV streaming, clean lifecycle.
3. **Analysis board** — chessground + chessops; legal-move dots; eval bar (Win%-mapped, flips); engine
   panel (MultiPV 3–5, depth, click-to-preview); recursive move list with variations/NAGs; right-click arrows.
4. **Openings** — `openings:lookup` (EPD → name/ECO, deepest match) wired into the move list.
5. **Puzzles** — bundled pruned `puzzles.sqlite`; `puzzles:next` by theme+rating; correct
   `FEN+Moves[0]` presentation; **Glicko-2** local rating with per-attempt updates; FSRS review of failures.
6. **Play vs computer** — Stockfish `UCI_Elo` 1320–3190 + Maia routing below; persisted to `game`.
7. **Game review** — depth-fixed Stockfish over a full game; per-move win% / accuracy / classification
   (incl. sound-sacrifice-aware brilliancy); cached `game_review`/`move_eval`; local coach text per critical move.
8. **Performance estimate** — accuracy-based per-game Elo **band** (Lichess pipeline), aggregated via
   inverse-variance shrinkage; always shown as a range, labeled distinct from the Glicko rating.
9. **Persistence** — `app.sqlite` (writable, in `userData`) with `game`/`game_move`/`progress_snapshot`/
   `rating`/`puzzle_attempt`/`game_review`/`move_eval`/FSRS cards; `user_version` migrations; PGN import/export.
10. **Famous games** — ~100 PD/CC0 games with **build-time engine-generated** annotations.
11. **Local coaching engine** — motif detectors + slot-fill templates (no LLM, no network) driving
    review and puzzle feedback.
12. **Packaging & compliance** — NSIS + portable builds; bundled GPL texts + engine source/offer +
    in-app About → Licenses; `setup` scripts reproducible from clean checkout.

### 11.2 Explicitly deferred to NEXT
Named-player opening books (2b); Maia move-match estimator + Regan correction; curated human (Wikipedia/
Gutenberg) prose + credits partitioning; Maia-3 (AGPL, flagged); richer long-horizon dashboards; macOS/Linux builds.

### 11.3 Acceptance criteria (binary, testable)
- **A1 Containment:** after a full dev session (open app, analyze, play, solve puzzles, review a game),
  `git status` is clean and **no file** appears on the Desktop or in the repo root; all dev data is under `.devdata/`.
- **A2 Reproducible build:** from a clean clone, `git lfs install && npm ci && npm run setup` produces
  `resources/engine/win/stockfish.exe`, `resources/data/puzzles.sqlite`, and `resources/openings/openings.json`
  with **no network access at runtime thereafter**.
- **A3 Offline guarantee:** with the network disabled, the packaged app launches, analyzes, plays,
  serves puzzles, and reviews a game with **zero outbound connections** (verified: CSP `connect-src 'self'`,
  no `webRequest` to remote hosts).
- **A4 Engine analysis:** loading a FEN and pressing analyze streams ≥3 stable MultiPV lines with depth,
  eval (cp/mate, correct sign), and PV; `stop` halts within ~50 ms; switching positions never leaks a process.
- **A5 Eval bar correctness:** a +3.0 eval renders ~85–90% fill (Win% sigmoid, not linear); the bar flips
  when the board is flipped; mate shows a full bar.
- **A6 Puzzle correctness:** every served puzzle shows the position **after** `Moves[0]`; the accepted
  solution begins at `Moves[1]`; promotions (`e7e8q`) are handled; a solve/fail updates the Glicko rating
  and shows the delta.
- **A7 Opening names:** `1.e4 e5 2.Nf3` is recognized via EPD lookup with ep field `-` (golden-oracle test
  passes for the ep edge cases); a transposition into a named line still resolves to the name.
- **A8 Game review:** reviewing a saved game yields per-side accuracy %, ACPL, a classified move list
  (incl. at least one correctly-praised sound sacrifice in a fixture game), an eval graph, and a
  per-critical-move coach comment; re-opening the game loads the cached review instantly.
- **A9 Strength band:** a reviewed game reports "Estimated strength ~N (low–high)" as a range, never a
  single number, and is labeled distinct from the puzzle/vs-bot Glicko rating.
- **A10 Play:** "Play vs Computer" at a chosen Elo produces legal, level-appropriate moves; the game is
  saved and has a working "Review this game" CTA; the human-feel (Maia) opponent is selectable below 1900.
- **A11 Security defaults:** `contextIsolation`, `sandbox`, `nodeIntegration:false`, `webSecurity` are all
  at secure values; the renderer cannot reach `require`/`fs`/`child_process`; `window.open` and external
  navigation are denied; every IPC handler rejects a malformed payload (zod) and a non-`app://` sender.
- **A12 Packaging:** `electron-builder` emits both a working NSIS installer and a portable `.exe`;
  `stockfish.exe`/`better-sqlite3` run from outside the asar; the read-only `puzzles.sqlite` opens and the
  writable `app.sqlite` is created in `userData` on first launch.
- **A13 Licenses:** About → Licenses lists Stockfish/lc0 (GPL-3.0 + source pointer), chessground/chessops
  (GPL-3.0), piece/sound/font/icon attributions; the GPL text and engine source/offer are present in the build.

### 11.4 Definition of done
All A1–A13 pass on a clean Windows checkout; `npm run setup` + `electron-builder` are green in CI; the spec
docs (`architecture.md`, `ui-ux.md`, `content-coaching.md`) match the shipped behavior.
