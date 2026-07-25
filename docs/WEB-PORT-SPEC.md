# Web Port: binding architecture spec

Goal: a **third target** alongside Windows + macOS, a full web version of nodechess, **self-contained
and standalone** (behaves as if the desktop app doesn't exist: no install prompts, no dataset-import
step, no Electron). Full feature parity. Server-side accounts + DB ("full db hosting"). Engines run
as **browser WASM**. Ships as **one Docker image** that you `docker run` locally OR deploy to any VPS
(local-host and web-host are the SAME artifact), with the DB behind an interface so a managed
Postgres can slot in later. User decisions locked 2026-07-11.

## The core idea: the `Api` seam

The renderer (`src/renderer/**`, ~60k LOC covering all UI, boards, game rules, 3D, WASM ffish, trystero
multiplayer) is **platform-neutral React**. Its ONLY window to the backend is the typed `Api`
interface (`src/shared/types.ts`), reached via `window.api`, with 21 namespaces, 135 call sites, built
once in `src/preload/api.ts` as `ipcRenderer.invoke` wrappers.

**The port = a second `Api` implementation.** The renderer is untouched. Desktop keeps the
Electron-IPC impl; web adds a browser impl that fulfills the same contract via three backends:
- **client-side** (no server): game rules (kernel/ffish), boards, 3D, WASM engines, trystero P2P.
- **HTTP → server** (persistence): games, ratings, school, progress, settings, puzzles, review-save.
- **static assets** (served by the server): openings book, famous games, personas, manuals, curriculum, WASM engine binaries.

`datasets` (import flow) and `updates` (auto-updater) become **no-ops on web**. The web app has no
install step and updates by refresh.

## Reuse map (what the server borrows from `src/main`)

Most main-process LOGIC is already Electron-free and runs on the server verbatim:
- **Rules/scoring/rating**: `analysis/accuracy.ts`, `analysis/estElo.ts`, `review/review.ts`,
  `rating/glicko2.ts`, `ratings/recompute.ts`, `ratings/botStrength.ts`, the game kernel specs.
- **DB repos**: `db/*.repo.ts`, `db/database.ts` migrations. The ONLY electron coupling is
  `database.ts` calling `app.getPath('userData')` for the file path (already proven stubbable in
  our test suites). Refactor: `getAppDb()` takes its path from an injected config, not `app`.
- Server adds only: HTTP layer, auth, user-scoping (a `user_id` column on user-data tables),
  puzzle-query endpoints, static serving, COOP/COEP headers.

## Repository layout (same repo; desktop untouched)

```
src/renderer/            UNCHANGED, shared by both targets
src/preload/api.ts       desktop Api impl (Electron IPC), stays
src/shared/              shared types + wire protocol, stays
src/web/                 NEW: the web target
  main.web.tsx           web entry: mounts <App/>, sets window.api = webApi, no preload
  webApi.ts              the Api impl (HTTP + WASM + static + trystero)
  http.ts                typed fetch client (credentials: same-origin session cookie)
  engines/               WASM engine workers (stockfish, fairy-stockfish) + a UCI-over-worker shim
server/                  NEW: the Node backend (one process)
  index.ts               Fastify: static SPA, COOP/COEP, session auth, /api/* routes
  db/                    imports src/main/db repos with an injected path (SQLite now)
  dbAdapter.ts           the persistence interface (SQLite impl now; Postgres later)
  auth.ts                accounts: argon2id hash, session cookie, /api/auth/*
  routes/                one router per Api namespace's server-backed methods
  puzzles.ts             puzzle-DB query endpoints (the 2GB sqlite stays server-side)
vite.web.config.ts       NEW: plain Vite build of the renderer → dist-web/
Dockerfile               NEW: build SPA + server + puzzle DB → one image
docker-compose.yml       NEW: one-command local host
```

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

### Persistence + accounts (server DB, "full db hosting")
- **Accounts**: email/username + password (argon2id), httpOnly session cookie. Logged-out visitors
  can browse/play-vs-bot/puzzles locally, but games/ratings/school progress require an account
  (server-stored, same account from any browser/device). Auth is friends-scale but real.
- **User-scoping**: user-data tables gain `user_id`; every server repo call is scoped to the session
  user. The desktop single-user DB stays as-is (separate codepath).
- **`dbAdapter`** interface wraps all reads/writes so the SQLite impl can be swapped for Postgres
  without touching routes (the "cloud-ready later" pick).

### Puzzles
The ~2GB puzzle SQLite is NEVER shipped to the browser. Server exposes query endpoints
(`/api/puzzles/next`, by-theme, by-rating, daily); the web `puzzles` namespace calls them. Puzzle DB
ships inside the Docker image (or a mounted volume).

### Multiplayer
**Already browser-native** (trystero WebRTC in the renderer). Works unchanged on web. A web player
and a desktop player can even share a code. Zero server involvement beyond serving the app.

## Hosting

One **Dockerfile**, multi-stage: build the SPA (`vite.web.config`), build the server, copy the
puzzle DB + static datasets → a slim Node runtime image. `docker run -p 8080:8080 nodechess-web`
is the local host; the same image deploys to Fly/Hetzner/DO. COOP/COEP + gzip/brotli for the WASM
and SPA. `docker-compose.yml` for one-command local. The puzzle DB is a build arg / mountable volume
so the image can stay lean.

## Phases (each ends green + hostable-further-along)

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
with honest copy. Server inputs zod-validated (reuse the IPC schemas). Auth: argon2id, httpOnly
cookies, no secrets in the client bundle.
```
