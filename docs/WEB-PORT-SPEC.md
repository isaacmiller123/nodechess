# Web Port: binding architecture spec

Goal: a **third target** alongside Windows + macOS, a full web version of nodechess, **self-contained
and standalone** (behaves as if the desktop app doesn't exist: no install prompts, no dataset-import
step, no Electron). Full feature parity. Engines run as **browser WASM**.
User decisions locked 2026-07-11.

**Status, 2026-07-27: the persistence half of this plan was replaced, and the spec below is
updated to match.** The web target ships **STATIC**. There is no server-side game database and no
server-side puzzle query API. `src/web/webApi.ts` opens with "NOTHING here talks to a server", and
every namespace resolves in the browser: game data lives in `localStorage`-backed stores, and the
~2 GB puzzle DB is read as a chunked static artifact over HTTP `Range`. The live deployment is a
static SPA on Cloudflare Pages with the puzzle chunks in R2 (`docs/DEPLOY-WEB.md`). The Fastify
server and the Docker image still exist and are still CI'd (`docs/WEB-DEPLOY.md`), but they serve
the SPA plus a legacy `/api/ipc` bridge, not the app's data. The W1 to W6 phase list at the end is
kept as the historical build order.

## The core idea: the `Api` seam

The renderer (`src/renderer/**`, ~60k LOC covering all UI, boards, game rules, 3D, WASM ffish, trystero
multiplayer) is **platform-neutral React**. Its ONLY window to the backend is the typed `Api`
interface (`src/shared/types.ts`), reached via `window.api`, with 21 namespaces, 135 call sites, built
once in `src/preload/api.ts` as `ipcRenderer.invoke` wrappers.

**The port = a second `Api` implementation.** The renderer is untouched. Desktop keeps the
Electron-IPC impl; web adds a browser impl that fulfills the same contract via four backends, all
of them in the browser:
- **client compute** (no server): game rules (kernel/ffish), boards, 3D, WASM engines
  (`src/web/engines`), review/perf/persona moves, the coach's move explanations (`src/main/coach`,
  pure chessops, shared verbatim with desktop), the opening table, trystero P2P.
- **local state** (`src/web/localData.ts`, `reviewStore.ts`, `schoolProgress.ts`): games, ratings,
  settings, custom variants, puzzle attempts/daily/rush, stored reviews, School progress. **This
  browser IS the database.** There is no account to sync to and no server that could hold it.
- **the puzzle library** (`src/web/data` via `src/web/puzzles.ts`): the ~2 GB puzzle database split
  into static chunks and read over HTTP `Range`. Reads degrade to their honest empty shapes when
  the artifact is not deployed, and `datasets.status` reports `puzzles:false` so gated surfaces
  show their own notice.
- **static content** (`src/web/content`): curriculum chapters, famous games, the persona catalog,
  the same resource files the desktop main process reads, emitted into the build by
  `vite.web.config.ts` and fetched on demand.

Two things are honestly missing rather than moved, both in School: spaced repetition keeps no
schedule in the browser (nothing is ever reported due, and grading a review is refused rather than
silently dropped), and Viktor's `school:narrate`/`debrief` cannot be bundled for a browser because
his voice layer constructs a native engine pool at module scope.

`datasets` (import flow) and `updates` (auto-updater) become **no-ops on web**. The web app has no
install step and updates by refresh.

## Reuse map (what the browser and the server borrow from `src/main`)

Most main-process LOGIC is already Electron-free and runs verbatim off the desktop:
- **Rules/scoring/rating**: `analysis/accuracy.ts`, `analysis/estElo.ts`, `review/review.ts`,
  `rating/glicko2.ts`, `ratings/recompute.ts`, `ratings/botStrength.ts`, the game kernel specs.
  The web build runs these **in the browser**.
- **Coach**: `src/main/coach` is pure chessops with no engine, so the web `Api` imports it directly.
- **DB repos**: `db/*.repo.ts` + `db/database.ts` migrations. The electron coupling was removed:
  `database.ts` takes its paths from an injected config, imports nothing from `electron`, and is
  what the `/api/ipc` bridge bundle runs on the server. The browser does NOT use these repos.

## Repository layout (same repo; desktop untouched)

```
src/renderer/            UNCHANGED, shared by both targets
src/preload/api.ts       desktop Api impl (Electron IPC), stays
src/shared/              shared types + wire protocol + accounts, stays
src/web/                 the web target
  main.web.tsx           web entry: mounts <App/>, sets window.api = webApi, no preload
  webApi.ts              the Api impl (client compute + local state + static + trystero)
  localData.ts           games/ratings/settings/attempts, in the browser
  reviewStore.ts         stored full-game reviews
  schoolProgress.ts      placement, lessons, chapter tests, mastery, study days
  puzzles.ts             the puzzles namespace over the chunked artifact
  data/                  chunkedDb.ts + puzzleSource.ts + manifest.ts: sql.js-httpvfs over Range
  content/               curriculum / famous / personas, fetched from the build output
  engines/               WASM engine workers (stockfish, fairy-stockfish) + a UCI-over-worker shim
  accounts.ts            decentralized accounts in the browser (docs/ACCOUNTS-SPEC.md)
  sw.ts                  service worker: offline shell + puzzle-chunk caching
  public/_headers        COOP/COEP for the static host
server/                  the Node process behind the Docker image
  index.ts               Fastify: static SPA, COOP/COEP, /api/auth/*, /api/ipc/*, /api/review/*
  bridge.ts              serves the desktop's own zod-validated ipc handlers over
  bridge-entry.ts        POST /api/ipc/<channel>, prebundled by scripts/build-ipc-bridge.mjs
  electron-shim.ts       the `electron` replacement that lets those handlers run in plain Node
  users.ts               per-user app.sqlite under DATA_DIR/users/<id>, LRU handle cache
  auth.ts                interim accounts: argon2id (hash-wasm), session cookie, /api/auth/*
  afinal.ts              the ACCOUNTS_DECENTRALIZED switch: ON gates /api/auth/* to 410
  review.ts              review persistence for the server path
  judge/  operator/      server-side judge + operator peer (docs/ACCOUNTS-SPEC.md)
vite.web.config.ts       plain Vite build of the renderer → dist-web/
Dockerfile               build SPA + server → one image
docker-compose.yml       one-command local host
```
There is no `src/web/http.ts`, no `server/db/`, no `server/dbAdapter.ts`, no `server/routes/` and
no `server/puzzles.ts`. The planned "one router per Api namespace" never happened: the server
exposes exactly the three namespaces documented at the top of `server/index.ts`.

## Backends in detail

### Engines (browser WASM, user pick)
- **Stockfish WASM** (lila-style single+multi-thread; multi-thread needs SharedArrayBuffer →
  COOP/COEP headers, which the server sets): analysis, chess bots, and the eval feed for **client-side
  game review** (the existing pure `accuracy.ts` classifier runs in the browser over WASM eval).
- **Fairy-Stockfish WASM** (`fairy-stockfish-nnue.wasm`): chess variants + xiangqi/shogi/janggi/
  makruk bots. (ffish WASM is already bundled for rules.)
- **Maia / KataGo**: lc0/KataGo WASM are heavy/weak. Web v1: chess "Human" style and go bots use the
  best available WASM (KataGo weak-net or a capped policy net) OR are marked "desktop-only for now"
  in the UI, decided per-engine during the engine phase, documented, never a broken button.
- Contract: the web `engine` namespace speaks the SAME request/response shapes as the IPC one; a
  worker pool mirrors the desktop pool semantics (serialize, cancel, level→movetime).

### Persistence + accounts (browser-local; the server DB plan was dropped)
- **Persistence is browser-local.** Games, ratings, settings, attempts, reviews and School progress
  live in the browser (`src/web/localData.ts`, `reviewStore.ts`, `schoolProgress.ts`). No `user_id`
  column, no per-namespace routers, no `dbAdapter`, no Postgres seam: none of that was built, and
  the seam it was meant to hide does not exist.
- **Accounts are decentralized** (`docs/ACCOUNTS-SPEC.md`, `src/web/accounts.ts`): an account is a
  keypair, not a row in a server table. The interim server accounts described in the original plan
  (username + password, argon2id, httpOnly session cookie) still exist in `server/auth.ts` but are
  **gated off**: every shipped server bundle defaults `ACCOUNTS_DECENTRALIZED` on and answers
  `/api/auth/*` with `410 Gone` (`server/afinal.ts`). They are the reversible emergency fallback,
  reachable only with `ACCOUNTS_DECENTRALIZED=0`.
- Consequence, stated plainly: **clearing browser storage clears the data.** There is no server
  copy to restore from.

### Puzzles
The ~2 GB puzzle SQLite is not shipped to the browser as one file and there are no server query
endpoints (grep `/api/puzzles` in `server/`: nothing). Instead the DB is **chunked** by
`scripts/build-puzzle-chunks.mjs` into 60 files of 24 MiB (`dist-puzzles/`) plus a manifest, and the
browser reads pages out of the middle of those chunks over HTTP `Range` (sql.js-httpvfs, wrapped by
`src/web/data/chunkedDb.ts`). Opening one puzzle costs a few 8 KiB windows. The chunk origin must
answer `206`, which is why the live deployment puts them in R2 rather than on Pages
(`docs/DEPLOY-WEB.md` Part 6). `VITE_PUZZLE_BASE_URL` selects the origin at build time and defaults
to `<base>puzzles/`.

### Multiplayer
**Already browser-native** (trystero WebRTC in the renderer). Works unchanged on web. A web player
and a desktop player can even share a code. Zero server involvement beyond serving the app.

## Hosting

Two routes, and they are not alternatives to each other:

- **The live deployment is static.** `npm run build:web` → `dist-web/` uploaded to Cloudflare
  Pages, with the puzzle chunks in R2. No server process at all. Click-by-click:
  `docs/DEPLOY-WEB.md`.
- **The Docker image is the self-host route.** One multi-stage **Dockerfile**: build the SPA
  (`vite.web.config.ts`), build the server, → a slim Node runtime image.
  `docker run -p 8080:8080 nodechess-web` is the local host and the same image deploys to a VPS.
  It serves the SPA with COOP/COEP plus the legacy `/api/ipc` bridge. `docs/WEB-DEPLOY.md`.

## Phases (historical: the 2026-07 build order, kept as the record)

W1, W2 and W5 landed as written. **W3 and W4 did not**: the server DB and the puzzle query API were
built and then replaced by browser-local persistence and the chunked static artifact, and W6's
Postgres-ready `dbAdapter` was never built at all. Read them as the plan of record, not as a
description of the code.

- **W1 Seam + skeleton (foundational, UNBLOCKS all)**: refactor `getAppDb()` to injected path;
  `vite.web.config` + `main.web.tsx` building the renderer as a plain SPA against a STUB webApi;
  Fastify server serving that SPA with COOP/COEP; Dockerfile skeleton; `npm run dev:web` + build. Proof:
  the SPA boots in a browser (menus render; anything needing the backend shows a clean "coming
  online" state, never a crash).
- **W2 Engines**: Stockfish + Fairy-SF WASM workers behind the `engine` namespace; client-side
  review. Proof: analysis eval bar + a chess bot game + a variant bot game work in-browser.
- **W3 Accounts + persistence**: auth, user-scoped server DB (reusing `src/main/db` repos +
  server-side review/rating), games/ratings/progress/settings namespaces over HTTP. Proof: sign up,
  play a bot game, it's saved to the server DB and survives a hard refresh + a different browser.
- **W4 Puzzles + School + static**: puzzle query API; school server logic; openings/famous/
  personas/manuals as static. Proof: puzzles rated, a School chapter playable, placement works.
- **W5 Parity edges**: `datasets`/`updates` no-ops with honest UI; `dialog` → browser download/
  upload; webm export via browser; 3D/theater verified in-browser. Proof: every desktop surface has
  a working or gracefully-degraded web equivalent. No dead buttons.
- **W6 Docker + deploy**: finished image, compose, Postgres-ready `dbAdapter`, deploy docs, a web
  CI job (build SPA + server, headless smoke). Proof: `docker run` → full app on localhost; a smoke
  test hits `/` and a couple of `/api` routes.

## Quality gates (every phase)
Desktop build stays 100% intact (its suites + `npm run package` unaffected, because the web target is
additive). Web build typechecks + builds. New server/web logic gets headless tests in the existing
`scripts/test-*.mjs` style. No dead buttons in the web UI: every `Api` method resolves or degrades
with honest copy. Server inputs zod-validated (reuse the IPC schemas). No secrets in the client
bundle.
