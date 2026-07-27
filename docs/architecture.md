# ARCHITECTURE & TECH DECISIONS

> Lead-architect spec for the offline Electron chess **analysis & teaching** app:
> Stockfish analysis, LOCAL-only (no-LLM) coaching, polished UI. This document covers the
> stack, process model, IPC surface, data pipeline, engine bundling, packaging, repo layout,
> and the FOUNDATION (v0) milestone.
>
> Companion specs: `docs/ui-ux.md`, `docs/content-coaching.md`, `docs/feature-addendum.md`,
> `docs/STATUS.md`. Where this doc and the addendum disagree on detail, **this doc wins for
> architecture**; the addendum wins for feature scope.

**Status, 2026-07-27 (app v1.3.0).** Sections 0, 1, 2.1, 2.3, 5, 6.1, 6.4, 7 and 9 were corrected
against the tree on this date. Sections 2.2, 2.4, 3, 4, 8 and 10 describe shipped behavior.
Section 11 is kept as the v0 milestone record and marked historical there: it shipped, and the
product has moved past it (macOS builds, a web target, the games platform, decentralized
accounts). Where a fact can drift, the live source wins over this file: `package.json` for
versions, `electron-builder.yml` for packaging, `docs/WEB-PORT-SPEC.md` + `docs/DEPLOY-WEB.md` for
the web target, `docs/GAMES-PLATFORM-SPEC.md` for the games platform, `docs/SCHOOL-SPEC.md` for
School, `docs/ACCOUNTS-SPEC.md` for accounts.

---

## 0. Licensing posture (decides several stack choices up front)

The app is **GPL-3.0** as a whole, and that is a deliberate, locked decision:

- **Stockfish** (engine) and **lc0** (Maia body) are GPL-3.0. They ship as arms-length UCI
  subprocesses, not linked code.
- **chessground** (board UI) and **chessops** (rules/PGN/EPD) are GPL-3.0.
- Because we are already in GPL territory, we **do not** pay the "stay permissive" tax: we use
  the best lichess-grade libraries (chessground + chessops) directly instead of avoiding them.

Consequences honored throughout this spec:

1. Ship the **verbatim GPL-3.0 / LICENSE texts** plus a **THIRD-PARTY-NOTICES** file and an
   in-app **About → Licenses** screen.
2. Ship a **written offer + pinned source pointer** for each GPL/AGPL binary (Stockfish, lc0).
   We ship the *unmodified official* binaries, pinned to an exact release tag, so the cleanest
   compliance is to point at that tag. `THIRD-PARTY-NOTICES.md` at the repo root carries that
   pointer (Stockfish 18, tag `sf_18`, plus the corresponding-source URL); `docs/CREDITS.md`
   carries the per-asset art credits.
3. **Bundled content is open only:** Lichess puzzle DB (CC0), `chess-openings` (CC0), piece
   sets restricted to GPL/Apache/MIT/CC0/CC-BY (default **cburnett**, GPLv2+), board themes as
   CSS flat colors. No chess.com proprietary assets, ever.
4. **Sounds:** the shipped set is three themes. `classic/`, `real/` and `games/` are synthesized
   in-repo (`scripts/gen-sounds.mjs`, `gen-game-sounds.mjs`) and carry this project's own license.
   `standard/` IS the Lichess set, **AGPL-3.0-or-later**, shipped as unmodified data assets
   alongside (not linked into) the app, with provenance, upstream commit and license recorded in
   `src/renderer/src/assets/sounds/ATTRIBUTION.md`. *(This supersedes the original "Kenney CC0
   only, never lichess sounds" line: the license turned out to be clear, not unclear.)*
5. **AGPL code is deferred** (Maia-3) and never linked into the app.

---

## 1. Final tech stack (versions + rationale)

Versions below are the `package.json` pins as of 2026-07-27. `package.json` is the source of truth;
this table exists to record *why* each choice was made.

| Layer | Choice | Version (pin) | Why |
|---|---|---|---|
| Desktop shell | **Electron** | `^42.5.0` (Node 24) | Mature, cross-platform, native child-process for engines, `extraResources` for bundled content. Node 24 is what gives us `node:sqlite` with no native module. |
| Build tooling | **electron-vite** | `^5.0.0` | Pre-wired main/preload/renderer triple-build, HMR for renderer, hot-reload for main/preload, TS+React out of the box. Documented for electron-builder resource exclusion. |
| Bundler under the hood | **Vite / Rollup** | vite `^7.3.5` | Fast, ESM-first. Also builds the web target directly (`vite.web.config.ts`, no Electron). |
| UI runtime | **React + TypeScript** | React `^19.2.7`, TS `^6.0.3` | Component model fits the analysis/board/sidebar layout; TS for the typed IPC surface. |
| Board rendering | **chessground** | `^9.2.1` | The actual lichess board: drag+click moves, legal dots, last-move/check highlights, premoves, right-click arrows/circles. Rendering only, no chess logic, zero deps. GPL-3.0 (accepted). |
| Variant board rendering | **chessgroundx** | `^10.7.5` | chessground fork with non-8x8 geometries (shogi/xiangqi/janggi) for the games platform. See `docs/GAMES-PLATFORM-SPEC.md`. |
| Rules / SAN / FEN / EPD / PGN | **chessops** | `^0.15.0` | lichess-grade. **Decisive:** full PGN game tree (variations + NAGs + comments) via `pgn` module; `makeFen(setup,{epd:true})` for EPD keys; legal-move `dests` map feeds chessground. GPL-3.0 (accepted). *(chess.js is NOT a dependency and is imported nowhere: chessops is the only rules library, in the app and in the build scripts alike, §5.5.)* |
| Analysis/play/review engine | **Stockfish** (native NNUE binary) | **18** (release `sf_18`) | Native > WASM: full NNUE, true multithreading. NNUE net **embedded** → no loose `.nnue` to ship. **Not bundled:** imported at runtime from the public GitHub release via Settings → Datasets (`src/main/datasets`, `docs/DATASETS.md`), which is what keeps the installer small. GPL-3.0. |
| Engines in the browser | **stockfish** (WASM) + **lila-stockfish-web** | `^18.0.8`, `^0.0.11` | The web target has no child processes: the same UCI seam is spoken by WASM workers (`src/web/engines`). Multi-thread needs COOP/COEP, which the host sets. |
| Variants engine | **fairy-stockfish-nnue.wasm** (+ a native mac binary) | `^1.1.11` | Chess variants and the xiangqi/shogi/janggi/makruk bots. The ~750 KB mac binary is the one engine that IS bundled (`electron-builder.yml` mac block); Windows imports it. |
| Human-feel engine | **lc0** (CPU build) + **Maia-1** weights | `maia-1100..1900.pb.gz` | Human move distribution for sub-1900 play. Imported at runtime like Stockfish (`src/main/datasets/maia.ts`), never bundled. GPL-3.0 (weights treated as GPL pending CSSLab confirmation). |
| Local DB | **`node:sqlite`** (Node builtin) | n/a (ships with Electron 42) | `DatabaseSync`, synchronous, zero install. **No native module**, so no `@electron/rebuild`, no `asarUnpack`, no ABI rebuild step. `src/main/db/database.ts` is deliberately electron-free so the same repos + migrations run under Electron AND the web server. |
| Spaced repetition | **ts-fsrs** (FSRS-6) | `^5.4.1` | MIT, default weights, `request_retention=0.9`. Schedules failed-puzzle / mistake review cards. |
| Ratings | **hand-rolled Glicko-2** (~120 LOC) | in-repo | Glickman spec, numerically verified. Puzzle rating + vs-bot rating. No runtime dep. |
| IPC validation | **zod** | `^4.4.3` | Schema-validate every IPC payload in `ipcMain.handle`. |
| Packaging | **electron-builder** | `^26.15.3` | Windows **NSIS** + **portable** + **zip**; macOS **dmg** + **zip** (§7). |
| Icons | **in-house SVG sprite** | in-repo | `src/renderer/src/components/IconSprite.tsx` draws the rail and chrome (ids `i-home`, `i-play`, …), per UI-v1. **lucide-react** `^1.21.0` (MIT) survives inside feature surfaces. |
| Fonts | **Inter** (UI) + **JetBrains Mono** (numerals) + **Noto Sans Symbols 2** | OFL, self-hosted variable `.woff2` | Bundled under `resources/fonts/`, declared in `src/renderer/src/styles/fonts.css`. Same bytes on macOS, Windows and the web. No Google Fonts hotlink (`font-src 'self'`). |
| 3D | **three** + **@react-three/fiber** + **drei** | `^0.185.1`, `^9.6.1`, `^10.7.7` | The games-platform 3D tabletop and Replay Theater, lazy-chunked so 2D never pays for it. |
| Charts | **hand-rolled SVG** (eval graph) | n/a | Best control over the lichess-style advantage fill; zero dep. |

**Node / npm:** Node 24 comes with Electron 42 and is what the main process runs on. The web server
bundle targets `node22` (`scripts/build-server.mjs`) and the Docker image builds and runs on
`node:26-alpine`. No `"type":"module"` in `package.json` (keeps main/preload as plain CJS and avoids
the `.cjs` electron-builder glob footgun).

---

## 2. Process / module breakdown (main / renderer / preload)

Three Electron processes, hardened to defaults. **All Node, engine, and DB access lives in MAIN; the renderer is pure UI and talks only over the typed IPC bridge.**

### 2.1 MAIN process (`src/main`): privileged
Owns the OS, the engines, and the database. No UI.

```
src/main/
  index.ts                 # app lifecycle; DEV userData redirect (see §8); window creation
  window.ts                # BrowserWindow factory w/ locked webPreferences + nav guards
  security.ts              # installCsp() + hardenWindow(): window-open deny, will-navigate guard
  menu.ts                  # application menu
  ipc/                     # 21 files: registry.ts + util.ts + 19 *.ipc.ts, one per domain
    registry.ts            # registers every ipcMain.handle
    engine.ipc.ts  puzzles.ipc.ts  puzzles.daily.ipc.ts  puzzles.rush.ipc.ts
    openings.ipc.ts  games.ipc.ts  review.ipc.ts  ratings.ipc.ts  coach.ipc.ts
    famous.ipc.ts  personas.ipc.ts  school.ipc.ts  customVariants.ipc.ts
    datasets.ipc.ts  dialog.ipc.ts  maintenance.ipc.ts  settings.ipc.ts
    updates.ipc.ts  app.ipc.ts
  engine/
    StockfishPool.ts       # persistent SF processes: analyze instance + play instance
    MaiaPool.ts            # lc0 process + Maia weight routing
    FairyPool.ts           # Fairy-Stockfish (variants + the non-chess bots)
    KatagoPool.ts  gtp.ts  # go bots, over GTP rather than UCI
    UciEngine.ts           # thin hand-rolled UCI wrapper (spawn, line-buffer, MultiPV stream, stop)
    paths.ts               # resolveEnginePath() dev vs process.resourcesPath
  datasets/                # runtime import of the engine + puzzle DB (see docs/DATASETS.md);
                           # imported copies always win over bundled ones
  db/
    database.ts            # node:sqlite connections + user_version migrations; path INJECTED
    puzzles.repo.ts        # queries over the imported puzzle DB
    games.repo.ts          # game / game_move / progress_snapshot
    ratings.repo.ts  progress.repo.ts  daily.repo.ts  rush.repo.ts  customVariants.repo.ts
  coach/                   # LOCAL no-LLM coaching engine (motif detectors + templates + Viktor).
                           # See content-coaching.md and docs/SCHOOL-SPEC.md
  analysis/
    accuracy.ts            # Lichess Win% + Accuracy% + move classification
    estElo.ts              # per-game Elo band
  rating/
    glicko2.ts             # hand-rolled Glicko-2
    fsrs.ts                # FSRS-6 scheduling
  ratings/                 # botStrength.ts, recompute.ts (rating integrity migrations)
  review/  openings/  famous/  personas/  school/  updates/  util/
```

Key invariants:
- **Two Stockfish instances**, never one: an *analysis* instance (MultiPV 3–5, `go infinite`) and a
  *play/review* instance (MultiPV 1, bounded `go`), so a live game never blocks the analysis board.
- **Engines spawned from MAIN only** via `child_process.spawn(path, [], {stdio:['pipe','pipe','pipe']})`.
  Killed on `window.closed` and `app.will-quit`; a running `go infinite` is `stop`ped before reuse.
- **DB opened in MAIN only** (on desktop). `puzzles.sqlite` is opened read-only through the
  `datasets` resolvers (imported copy first, then bundled) rather than a fixed
  `process.resourcesPath`, because an import mid-session must win on the next open; the writable
  `app.sqlite` lives under `userData`. `database.ts` itself takes both paths injected and imports
  nothing from `electron`, which is what lets the web server reuse the same repos and migrations.

### 2.2 PRELOAD (`src/preload`): the only bridge
Sandboxed (Electron 20+). Bundled to a **single file** by electron-vite. Exposes exactly one frozen,
typed API object via `contextBridge`. **Never** exposes raw `ipcRenderer`, `fs`, `child_process`, or `path`.

```
src/preload/
  index.ts                 # contextBridge.exposeInMainWorld('api', api)
  api.ts                   # the typed surface (mirrors §4 channels)
```

### 2.3 RENDERER (`src/renderer`): unprivileged UI
React + chessground + chessops. No Node. Calls only `window.api.*`.

```
src/renderer/src/
  main.tsx  App.tsx
  board/
    Board.tsx              # in-house chessground wrapper (init in useEffect, cg.set on props, destroy on unmount)
    EvalBar.tsx            # Win%-mapped fill, flips with orientation
    PromotionPicker.tsx  PieceIcon.tsx  pieceSets.ts
  components/              # shell + cross-screen chrome: Layout.tsx (the ten destinations),
                           # IconSprite.tsx, CommandPalette.tsx, Onboarding, ErrorBoundary, …
  panels/
    MoveList.tsx           # recursive variation tree, NAG glyphs, current-node highlight
  features/
    home/  play/  games/  puzzles/  school/  openings/  analysis/  progress/
    account/  settings/  library/  landing/  welcome/
    play/online/           # INTERNET multiplayer, renderer-owned WebRTC P2P (see §3.1)
  games/                   # the games-platform kernels, registry, bots and boards
  chess/  state/  hooks/  sound/  assets/
  styles/                  # UI-v1: design-lab/v1's stylesheets, installed verbatim (see docs/ui-ux.md)
```
Shared TS types for `window.api` live in `src/shared/types.ts` (imported by preload, renderer and
the web `Api` impl), not under `src/renderer`.

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
Plus: `setWindowOpenHandler(() => ({action:'deny'}))` and a `will-navigate` guard (`hardenWindow`
in `src/main/security.ts`), **no remote origins**, and a strict **CSP** applied via
`session.defaultSession.webRequest.onHeadersReceived`. The production policy (`installCsp`,
same file) is:

```
default-src 'none';
script-src 'self' 'wasm-unsafe-eval';   /* wasm ONLY: ffish rules engine + Variant Lab.
                                           NOT 'unsafe-eval': ffish's embind glue is
                                           rewritten eval-free by scripts/patch-ffish-csp.mjs */
style-src 'self' 'unsafe-inline';
img-src 'self' data: file:;             /* file: for the extraResources games art */
font-src 'self';
connect-src 'self' wss: file:;          /* wss: for the multiplayer signaling relays (§3.1) */
media-src 'self'
```
Dev relaxes this for HMR (`DEV_CSP`), so only the packaged app proves the production policy:
`scripts/smoke-packed-wasm.mjs` is the check, and it must be re-run after touching that line.

The production renderer is loaded with `loadFile`, i.e. **`file://`**. The `app://` protocol is a
TODO in `src/main/window.ts`, not something that shipped. Every `ipcMain.handle` goes through
`src/main/ipc/util.ts`, which asserts the sender origin against an allowlist (`app:` or `file:`, or
localhost in dev only, with an exact host match so `localhost.evil.com` cannot pass) and then
zod-validates the payload before doing any work.

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

### 3.1 Internet multiplayer (renderer-owned WebRTC P2P does NOT cross IPC)

Multiplayer is the one feature that lives **entirely in the renderer** and never touches the main
process or `window.api`. Chromium already ships a native `RTCPeerConnection`, so two nodechess clients
talk **peer-to-peer over a WebRTC data channel**. End-to-end encrypted, direct, no relay in the game
path. There is **no user-run server and no port forwarding**: one player hosts and gets a random room
**code** like `A1B2C-D3E4F` (a 50-bit Crockford-base32 key, *not* an IP); the other enters it and the
two connect across NATs and countries. (This replaced the old same-LAN `ws` transport that lived in
`src/main/mp/`: that whole subtree, its IPC channel, and the `ws` dependency are gone.)

Peer **discovery/signaling** rides on [`trystero`](https://github.com/dmotz/trystero) (Nostr strategy
over a pool of public `wss://` relays): the room code seeds the room key + a derived password, so only
the two players who share the code complete the handshake. Once the data channel is up, no game data
touches the relays. NAT traversal uses public STUN (Google + Cloudflare, the latter for regions where
Google is blocked) with best-effort TURN fallback for symmetric NATs.

Layers (`src/renderer/src/features/play/online/` + `src/shared/mp/`):
- `@shared/mp/wire.ts`: isomorphic wire protocol (zod schemas, `PROTOCOL_VERSION`, hello handshake,
  wire-level ping/pong heartbeat, the room-code codec). Zero Node imports.
- `mpSession.ts` (`MpNetSession`): pure host-authoritative session logic (clocks, turn order, draw/
  resign/rematch, discovery timeout), transport-agnostic via an injected `MpTransport`.
- `rtcTransport.ts`: the trystero-backed transport factory (the only file that touches the network).
- `mpClient.ts`: the singleton `mp` the UI imports.

Because `MpNetSession` and the wire protocol are pure and transport-injected, they run unchanged under
bare Node: `scripts/test-mp.mjs` drives a full host↔guest game over an in-memory transport pair, and
`scripts/check-relays.mjs` probes live relay/TURN reachability.

Security note: this is the reason the CSP `connect-src` is `'self' wss:` (not just `'self'`): the
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
`resources/data/puzzles.sqlite` (read-only, git-ignored, **imported at runtime rather than bundled**,
see §6.1) and `resources/openings/openings.json`. Raw downloads land in `data/raw/` (git-ignored).

Scripts live in `scripts/` and are wired into `package.json`. The two heaviest steps are Python,
run through a Node shim so the npm script surface stays uniform:
```jsonc
"scripts": {
  "setup:engines":       "node scripts/run-python.mjs scripts/fetch_engines.py",     // Stockfish + Fairy-SF + Maia
  "setup:puzzles":       "node scripts/fetch-puzzles.mjs",                           // .csv.zst download
  "build:puzzles":       "node scripts/run-python.mjs scripts/build_puzzles_db.py",  // decompress → SQLite
  "build:puzzle-chunks": "node scripts/build-puzzle-chunks.mjs",                     // web: split the DB into static chunks
  "build:openings":      "node scripts/build-openings.mjs",                          // chess-openings → openings.json
  "build:famous":        "node scripts/build-famous.mjs",                            // PGN validate + engine annotate
  "build:personas":      "node scripts/build-persona-data.mjs",                      // persona books + metadata
  "setup":               "npm run setup:engines && npm run setup:puzzles && npm run build:puzzles && npm run build:openings"
}
```
`build:puzzle-chunks` belongs to the web target: it turns the built SQLite into the 24 MiB chunks
the browser reads over HTTP Range (`docs/DEPLOY-WEB.md` Part 6). Desktop never uses it.

### 5.1 `fetch-puzzles.mjs`: download
- `GET https://database.lichess.org/lichess_db_puzzle.csv.zst` → `data/raw/` (~286 MiB, CC0).
- Record the `Last-Modified` and byte count to `data/raw/puzzle_download.log` (already present:
  299,950,785 bytes, 2026-06-03) for the in-app **About → Data version**.

### 5.2 `build_puzzles_db.py`: decompress → transform → build
Python 3 (stdlib `sqlite3` + `csv`, no native build deps), run via `scripts/run-python.mjs`.
1. **Decompress with the long-window flag** (mandatory): the stdlib `compression.zstd` on Python
   3.14+ with `window_log_max: 31`, falling back to the `zstandard` package on older interpreters.
   *Without the long window you hit "Frame requires too much memory for decoding."*
2. **Validate the header** equals exactly
   `PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags`. Fail loudly on drift.
3. **Schema + fast import** (one transaction, `PRAGMA journal_mode=OFF; synchronous=OFF`):
   ```sql
   CREATE TABLE puzzles(
     PuzzleId TEXT PRIMARY KEY, FEN TEXT NOT NULL, Moves TEXT NOT NULL,
     Rating INTEGER NOT NULL, RatingDeviation INTEGER, Popularity INTEGER,
     NbPlays INTEGER, Themes TEXT, GameUrl TEXT, OpeningTags TEXT);
   ```
   Use the CSV reader as a real parser (Themes/OpeningTags are **space-separated inside the field**;
   GameUrl contains `#`).
4. **Theme-aware prune** (the shipped refinement of the original flat prune): a first pass counts
   puzzles per theme. Rich themes are pruned on `NbPlays >= 50 AND Popularity >= 80`; a puzzle
   carrying any *thin* theme (fewer than 20,000 puzzles in total) is **always kept**, so rare-theme
   lesson pools are never starved. *(Constants `MIN_PLAYS` / `MIN_POPULARITY` / `THIN_THEME_MAX`.)*
5. **Normalize themes** into a covering junction table for instant theme+rating selection:
   ```sql
   CREATE TABLE puzzle_themes(Theme TEXT, Rating INTEGER, PuzzleId TEXT);
   -- split Themes on spaces, insert ~N×avg(themes) rows
   CREATE INDEX idx_pt ON puzzle_themes(Theme, Rating, PuzzleId);  -- covering
   CREATE INDEX idx_rating ON puzzles(Rating);
   ```
6. `ANALYZE;` then `VACUUM;` → write `resources/data/puzzles.sqlite`.

**Runtime correctness rule (enforced in the puzzle feature, not the DB):** the CSV `FEN` is the
position *before* the opponent's lead-in move. Apply `Moves[0]` to `FEN` to get the position shown to
the player; the **solution starts at `Moves[1]`**. UCI promotions append the piece letter (`e7e8q`).

### 5.3 `build-openings.mjs`: opening names
- Vendor `lichess-org/chess-openings` at a **pinned commit** (CC0).
- Run `bin/gen.py` (`pip install "chess>=1,<2" && make`) to emit `dist/all.tsv`
  (`eco, name, pgn, uci, epd`), **or** regenerate the `uci`/`epd` columns in Node with chessops if
  avoiding Python in CI (then validate against python-chess as the golden oracle).
- Emit `resources/openings/openings.json`: a map **`epd → {eco, name}`** (~3,733 rows, a few hundred KB).
- **EPD = 4-field FEN** (placement + side-to-move + castling + en-passant), **no move counters**.
- **En-passant rule (the #1 correctness gotcha):** the ep field is set **only when a legal ep capture
  exists**. After `1.e4 e5 2.Nf3` → ep `-`; after `1.e4 Nf6 2.e5 d5` → ep `d6`. The runtime key
  generator (chessops `makeFen{epd:true}`) already does this. Covered by a golden-oracle test.
- Runtime name detection: walk game positions, look up each EPD, keep the **deepest** match, stop
  below ~20 pieces (mirrors scalachess `OpeningDb`); transpositions resolve for free.

### 5.4 Polyglot opening books: NOT BUILT
The plan below was never implemented: there is no `scripts/build-books.mjs`, no `build:books` npm
script and no `resources/books/`. Persona opening play is served instead by
`scripts/build-persona-data.mjs` → `resources/personas/` (read by `src/main/personas/book.ts`).
Kept as the record of the design if per-player Polyglot books are ever revisited: per-player `.bin`
from CC0 Lichess PGNs, split White/Black, capped ~12–16 plies, read as 16-byte big-endian records
(`>QHHI`) binary-searched by Zobrist key, with castling rewritten (`e1h1`→`e1g1`) before applying.

### 5.5 `build-famous.mjs`: validate the famous-games dataset
- The dataset is hand-authored public-domain move records in `resources/famous/games.json` (plus
  `persona-games.json`). The script **fetches nothing**: it replays every game's SAN movetext with
  **chessops** to prove the moves are legal and complete and that the declared result matches the
  final position, exiting non-zero on any failure, so it can gate a commit.
- No `annotations.json` is built. Commentary for a famous game is produced at **view time** by the
  existing review engine + coach, so no copyrighted annotation is ever bundled.

---

## 6. Stockfish + NNUE + lc0/Maia: bundling & invocation

### 6.1 What ships (and what deliberately does not)
The heavy datasets are **NOT bundled**. Stockfish (~114 MB) and `puzzles.sqlite` (~2 GB) are
imported at runtime from the public GitHub release via **Settings → Datasets**
(`src/main/datasets`, `docs/DATASETS.md`), which is what keeps the installer and the repo small.
What `electron-builder.yml` actually bundles via `extraResources` is only the tiny, always-on
content:
```
resources/
  openings/openings.json       # EPD → {eco, name}
  famous/                      # games.json + persona-games.json (move records only)
  curriculum/                  # the 40-chapter School content
  personas/                    # persona catalog + books
  games-art/                   # games-platform piece SVGs + CC0 board textures (~14 MB)
  engine/mac/fairy-stockfish   # mac ONLY (~750 KB): no official upstream mac build exists
```
Imported at runtime instead, under `<userData>/datasets/`:
```
  engine/stockfish[.exe]       # SF18 (NNUE EMBEDDED; no loose .nnue)
  engine/fairy-stockfish[.exe] # Windows: imported rather than bundled
  puzzles.sqlite               # the pruned Lichess puzzle DB (§5)
  maia/lc0[.exe] (+ dnnl.dll)  # lc0 CPU build
  maia/weights/maia-1100.pb.gz … maia-1900.pb.gz
  katago/katago[.exe] + nets/  # go bots (docs/GAMES-PLATFORM-SPEC.md)
```
- **NNUE is embedded** in the official SF18 binary → no separate network file at runtime.
- Bundled `extraResources` land **outside the asar**, which is what lets the mac Fairy-Stockfish
  binary be executed (asar-packed binaries cannot be).
- There is no `resources/licenses/`. `THIRD-PARTY-NOTICES.md` and `LICENSE` sit at the repo root.

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
The executable bit is set on macOS/Linux at the moment the binary is written: by the dataset importer for an
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
`lc0 --weights=<userData>/datasets/maia/weights/maia-<n>.pb.gz` (`src/main/engine/MaiaPool.ts`),
talk UCI the same way, **`go nodes 1`**: the raw policy head *is* the human-move model, so one node
is the model's own answer and searching further only makes it less human. Routing: `<1320` →
Maia-1100; `<1900` → nearest Maia net; `1900–3190` → Stockfish `UCI_Elo`.

---

## 7. Packaging (electron-builder: Windows NSIS + portable + zip, macOS dmg + zip)

`electron-builder.yml`, abridged (the file itself is the source of truth):
```yaml
appId: org.nodechess.app
productName: nodechess
directories: { output: release }
publish: { provider: github, owner: isaacmiller123, repo: nodechess }
asar: true
files:
  - "out/**"                 # electron-vite main/preload/renderer output
extraResources:              # the lean set only (§6.1): no engines, no puzzle DB
  - { from: "resources/openings",  to: "openings"  }
  - { from: "resources/famous",    to: "famous"    }
  - { from: "resources/curriculum",to: "curriculum"}
  - { from: "resources/personas",  to: "personas"  }
  - { from: "resources/games-art", to: "games-art" }
win:
  target: [nsis (x64), portable (x64), zip (x64)]
  icon: build/icon.ico
mac:
  target: [dmg (arm64, x64), zip (arm64, x64)]
  icon: build/icon.icns
  extraResources: [ resources/engine/mac/fairy-stockfish ]
  identity: null            # local/unsigned: spawning an imported binary needs
  hardenedRuntime: false    # the hardened runtime OFF (or an allow-jit entitlement)
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  artifactName: nodechess-Setup-${version}.${ext}
portable:
  artifactName: nodechess-Portable-${version}.${ext}
```
- **NSIS** → assisted installer (`nodechess-Setup-x.y.z.exe`). The names are spelled out rather
  than left to electron-builder's default because `updateLogic.pickWinAsset` matches this prefix.
- **portable** → single self-contained `.exe` (exposes `PORTABLE_EXECUTABLE_DIR/FILE` at runtime).
- **No `asarUnpack`**: with `node:sqlite` there is no native module and no `.node` file to unpack.
- `publish` declares the GitHub feed so electron-builder emits `latest.yml` / `latest-mac.yml`.
  Nothing publishes from here: CI packages with `--publish never` and attaches the files itself.
  Windows auto-updates in place; macOS is check + notify + browser download, because Squirrel.Mac
  refuses unsigned bundles. See `docs/RELEASE.md`.
- `npm run setup` is **not** a packaging prerequisite any more: the datasets it builds are imported
  at runtime (§6.1), so a clean checkout can package without a 2 GB build first.

---

## 8. DEV containment: nothing leaks to the Desktop

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
- `app.setPath` **must** run before `ready` (and `sessionData` override too), which is why it's the first thing in `main`.
- `.devdata/` holds the dev `app.sqlite`, caches, logs, settings, and is **git-ignored** (see §9).
- Raw downloads/build temp live under `data/raw/`, `data/tmp/`. Also git-ignored.
- Net effect: a clean `git status` after a dev session shows **no** stray files, and nothing ever lands
  on the Desktop or in the repo root.

---

## 9. Repo directory tree

Committed layout as of 2026-07-27. Build outputs (`out/`, `out-seed/`, `dist-web/`, `dist-seed/`,
`dist-server/`, `dist-puzzles/`, `release/`) and runtime data (`.devdata/`, `.webdata/`, `data/`)
are git-ignored and not listed.

```
chess-sharp/
├─ CLAUDE.md  README.md  CHANGELOG.md  LICENSE  THIRD-PARTY-NOTICES.md
├─ package.json  knip.json
├─ tsconfig.json  tsconfig.node.json  tsconfig.web.json  tsconfig.server.json
├─ electron.vite.config.ts        # desktop: main / preload / renderer
├─ electron.seed.config.ts        # the seed node's tray desktop build
├─ vite.web.config.ts             # the web SPA (no Electron)
├─ vite.seed.config.ts            # the seed node's browser build
├─ electron-builder.yml
├─ Dockerfile  docker-compose.yml  .dockerignore  .env.production
├─ build/                         # installer assets: icon.ico, icon.icns, icon.png
├─ .github/workflows/             # build.yml (desktop), web.yml (SPA + docker)
├─ scripts/                       # ~127 files: ETL (§5), test:* and smoke:* suites
├─ src/
│   ├─ main/        … (see §2.1)  # Electron main
│   ├─ preload/     … (see §2.2)
│   ├─ renderer/    … (see §2.3)  # shared by desktop AND web
│   ├─ web/                       # the web Api impl: webApi.ts, data/ (chunked puzzles),
│   │                             # engines/ (WASM), content/, localData.ts, sw.ts
│   ├─ seed/                      # the standalone seed node (its own app)
│   └─ shared/
│       ├─ types.ts               # the Api contract: preload, renderer and src/web all read it
│       ├─ mp/                    # the multiplayer wire protocol (§3.1)
│       └─ accounts/              # decentralized accounts (docs/ACCOUNTS-SPEC.md)
├─ server/                        # the web target's Fastify process: index.ts, bridge.ts,
│                                 # auth.ts, review.ts, afinal.ts, judge/, operator/
├─ deploy/                        # relay + TURN production stack: DEPLOY.md, Caddyfile,
│                                 # docker-compose.prod.yml, relay.config.toml, turnserver.conf
├─ design-lab/                    # the design work; v1/ is the shipped UI (docs/ui-ux.md)
├─ resources/                     # content bundled at package time (§6.1)
│   ├─ openings/openings.json     # built by build:openings, committed (small, CC0)
│   ├─ famous/                    # games.json + persona-games.json (move records, committed)
│   ├─ curriculum/chapters/       # the 40-chapter School content (committed)
│   ├─ personas/  manuals/        # persona catalog + the 23 game manuals (committed)
│   ├─ games-art/                 # games-platform pieces + CC0 board textures (committed)
│   ├─ assets/                    # alt piece sets (SVG) + sounds
│   ├─ fonts/                     # self-hosted variable .woff2 + their OFL texts
│   ├─ engine/mac/                # fairy-stockfish (committed); stockfish here is git-ignored
│   └─ data/puzzles.sqlite        # built, git-ignored, imported at runtime rather than shipped
└─ docs/                          # FLAT, 19 files. Entry points:
    ├─ architecture.md            # this file
    ├─ STATUS.md  ROADMAP.md  VIABILITY.md
    ├─ ui-ux.md  content-coaching.md  feature-addendum.md
    ├─ SCHOOL-SPEC.md  school-curriculum.md  GAMES-PLATFORM-SPEC.md  MP-V3-SPEC.md
    ├─ ACCOUNTS-SPEC.md  ACCOUNTS-PARAMS.md
    ├─ WEB-PORT-SPEC.md  DEPLOY-WEB.md  WEB-DEPLOY.md  RELEASE.md
    └─ DATASETS.md  CREDITS.md
```

---

## 10. `.gitignore` + Git LFS plan

**Principle:** commit **source + small open data** only. Large binaries and generated DBs are either
**fetched/built by scripts** (so they never enter history; preferred) or, where a binary genuinely
needs versioning, tracked via **Git LFS configured before the first binary commit**.

`.gitignore`, abridged to the families that matter (the file itself is the source of truth):
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
*(Note: `build/` is a committed installer-assets dir, so the build-output ignore uses a distinct name.
Keep electron-vite's output at `out/`/`dist/`, not `build/`, to avoid clobbering `build/icon.ico`.)*

**LFS strategy: fetch-first, LFS only where needed.** The engines, Maia weights, and `puzzles.sqlite`
are **fetched/built by `npm run setup`**, so by default they are git-ignored and **never** enter history
(keeps the repo lean and dodges LFS quota entirely). LFS is reserved for binaries we *choose* to
version, and so far we have chosen none: the one bundled binary,
`resources/engine/mac/fairy-stockfish` (~750 KB), is committed plain.

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

> **Historical.** This section is the v0 plan as written, kept as the record. v0 shipped and the
> product is at v1.3.0: macOS builds exist (11.2 defers them), the puzzle DB and engine are imported
> rather than bundled (§6.1), and `docs/STATUS.md` is the live phase log. Do not read 11.1 to 11.4
> as a description of the app today.

**Goal:** a polished, fully offline analysis board with local coaching, bundled puzzles with a local
rating, calibrated-Elo + human-feel play, full game review with an accuracy-based strength band, and a
small famous-games library: all containerized, all open-licensed, packaged as Windows NSIS + portable.

### 11.1 In scope (v0)
1. **App shell & security**: electron-vite triple-build; locked `webPreferences`; CSP; `app://` protocol;
   typed `window.api`; DEV userData redirect to `.devdata`.
2. **Engine integration**: Stockfish 18 (analysis + play instances) via the UCI wrapper; lc0+Maia-1 for
   human-feel play; bounded `go`, MultiPV streaming, clean lifecycle.
3. **Analysis board**: chessground + chessops; legal-move dots; eval bar (Win%-mapped, flips); engine
   panel (MultiPV 3–5, depth, click-to-preview); recursive move list with variations/NAGs; right-click arrows.
4. **Openings**: `openings:lookup` (EPD → name/ECO, deepest match) wired into the move list.
5. **Puzzles**: bundled pruned `puzzles.sqlite`; `puzzles:next` by theme+rating; correct
   `FEN+Moves[0]` presentation; **Glicko-2** local rating with per-attempt updates; FSRS review of failures.
6. **Play vs computer**: Stockfish `UCI_Elo` 1320–3190 + Maia routing below; persisted to `game`.
7. **Game review**: depth-fixed Stockfish over a full game; per-move win% / accuracy / classification
   (incl. sound-sacrifice-aware brilliancy); cached `game_review`/`move_eval`; local coach text per critical move.
8. **Performance estimate**: accuracy-based per-game Elo **band** (Lichess pipeline), aggregated via
   inverse-variance shrinkage; always shown as a range, labeled distinct from the Glicko rating.
9. **Persistence**: `app.sqlite` (writable, in `userData`) with `game`/`game_move`/`progress_snapshot`/
   `rating`/`puzzle_attempt`/`game_review`/`move_eval`/FSRS cards; `user_version` migrations; PGN import/export.
10. **Famous games**: ~100 PD/CC0 games with **build-time engine-generated** annotations.
11. **Local coaching engine**: motif detectors + slot-fill templates (no LLM, no network) driving
    review and puzzle feedback.
12. **Packaging & compliance**: NSIS + portable builds; bundled GPL texts + engine source/offer +
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
