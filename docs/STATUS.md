# Project Status

A living log of the agentic build loop. Newest entries at the bottom of each phase.

## Locked decisions (2026-06-24 kickoff survey)
- **Platform:** Electron desktop, chess.com/lichess-grade UI (React + TypeScript + Vite).
- **Coaching:** LOCAL only, Stockfish + heuristic explanation engine. No LLM, no internet, no cost at runtime.
- **Content:** offline-bundled (Lichess CC0 puzzle DB, openings TSV, theme taxonomy).
- **Assets:** open / redistributable only (Lichess piece sets & sounds + an open icon pack). No chess.com proprietary assets.
- **Product UI:** NO emojis. Sparing use allowed only in coaching/interaction text.
- **Containment:** everything stays inside the project dir; nothing may leak onto the Desktop.
- **Distribution:** set up for git.
- **Reach:** study / play / learn, foundation through ~2000 Elo.

## Agentic Loop 1: Foundation
- **Research** (12 parallel agents): engine, lichess assets, puzzle DB, openings, analysis UI/UX, chess libs,
  move classification, coaching engine, curriculum, electron arch/security, icons/visual tokens, storage/SRS.
- **Synthesize** (3 agents): architecture & tech decisions · UI/UX spec · content & coaching spec.
- **Verify** (1 critic): licensing + feasibility + completeness; emits the hardened FOUNDATION feature list.
- Output specs will be saved to `docs/architecture.md`, `docs/ui-ux.md`, and `docs/content-coaching.md`.

## Agentic Loop 1: Supplemental research (expanded scope, 2026-06-24)
Follow-up requirements from the user, now under research (`w47yrab2o`):
- Play vs **engine at any level** AND vs **human-like / top-player styles + openings** (Maia/lc0 + per-player opening books).
- **Elo / performance-rating estimation** from the user's play.
- Full game review (accuracy, blunders, brilliants; already planned).
- **Famous games library** with idea explanations (redistributable annotated PGNs + local coaching engine).
- **Saved game history** + progress tracking; **puzzle score / local rating** (Glicko-2).

## Assets fetched
- `data/raw/lichess_db_puzzle.csv.zst`: 299,950,785 bytes (verified), Lichess CC0, dated 2026-06-03.

## Agentic Loop 1: Research COMPLETE (2026-06-24)
- Main fleet (16 agents, 1.24M tokens) + supplemental fleet (5 agents, 302K tokens) done.
- Specs persisted to `docs/`: `architecture.md`, `ui-ux.md`, `content-coaching.md`, `feature-addendum.md`.
  (The raw research dump and the critic's v0/NEXT feature lists were working inputs; both were retired
  once their conclusions landed in the specs above.)
- Critic blockers actioned: (1) `.gitignore` hardened + `.gitattributes` added (`.devdata/`, `*.pb.gz`, lc0 subdirs now ignored);
  (2) **Maia/lc0 demoted to NEXT**: v0 ships Stockfish-only play until weights license is cleared in writing;
  (3) DB schema → adopt the addendum superset; (4) opening explorer W/D/L cut from v0; (5) coach strings authored fresh (no AGPL XML);
  (6) theme-aware puzzle prune + no `ORDER BY RANDOM()`; (7) bundle actual GPL source tarballs, not just URLs.

## Key locked tech (from architecture.md)
- Electron 32 + electron-vite 2.3 + React 18 + TS 5.5; chessground 9.2 + chessops 0.15 (GPL app-wide, accepted).
- Stockfish 18 native `x86-64-universal` (NNUE embedded; no WASM/COOP-COEP). better-sqlite3 11 (main only).
- ts-fsrs (FSRS-6) for review; hand-rolled Glicko-2; zod IPC validation; electron-builder (NSIS + portable).
- Lucide icons (MIT) + Inter font (OFL). DEV containment: `app.setPath('userData', <project>/.devdata)` gated on `!isPackaged`.

## Foundation build progress (Loop 1)
- **DONE: App shell + security baseline + typed IPC** (items 1-2). `npm run typecheck` + `npm run build` green
  (Vite 7, React 19, Zod 4, TS 6, Electron 42). Dev userData->`.devdata` containment redirect in place.
- **DONE: Puzzle DB pipeline** (item 5 data). `scripts/build_puzzles_db.py` (stdlib zstd+sqlite3, theme-aware prune):
  4,699,980 puzzles, 21.4M junction rows, ratings 399-3327, 2.1 GB. Themed query 0.3 ms via covering index. (Size is a
  packaging-time knob: tunable via one constant.)
- **DONE: Native Stockfish 18 integration** (item 4). `scripts/fetch_engines.py` fetches + UCI-probes the binary
  (x86-64-avx2, embedded NNUE). `src/main/engine/` UciEngine (pure-Node UCI wrapper) + StockfishPool (analysis/play
  instances) + `engine:*` IPC (analyze/stop/play/status/newGame + line/bestmove push). **A4 smoke PASS**: 3 MultiPV
  lines (depth/score/pv) stream, stop halts < 1s. Engine binaries git-ignored, fetched by setup.
- Toolchain pinned: Vite 7 + electron-vite 5 + @vitejs/plugin-react 5 (vite-8 peer conflict resolved).

## Build scripts now (Python where it avoids native-build fragility)
- `setup:engines` -> `python scripts/fetch_engines.py` (Stockfish fetch + UCI probe)
- `build:puzzles` -> `python scripts/build_puzzles_db.py` (CSV.zst -> puzzles.sqlite)
- `smoke_engine.mjs` -> raw-UCI A4 smoke test

## DONE: Analysis board + app shell (2026-06-24)
- chessground + chessops analysis workbench: drag/click moves, legal dots, last-move/check highlight,
  promotion picker, eval bar (Win% sigmoid, flips), MultiPV engine panel (live IPC stream, click-to-play),
  variation move tree (figurine<->letter toggle), flip + first/prev/next/last + keyboard nav, FEN load/copy.
- App shell: left rail nav + bottom profile chip (avatar + username), contextual topbar, routing.
- Settings (real): profile (username + avatar upload), theme light/dark, 4 board color themes (CSS-gradient),
  legal-dots / coordinates / animation / sound toggles: localStorage-backed, applied app-wide.
- **Visually verified** via preview inspect: dark theme + Inter, 648px board w/ 33 cburnett pieces,
  eval bar height-matched, accent colors correct. typecheck + build green.

## Expanded scope from user (2026-06-24, "build everything"):
- GM-STYLE bots (Tal/Fischer/etc.): opening book (their games) + style-weighted MultiPV selection + peak-Elo cap.
- Polished HOME dashboard (progress + continue-where-you-left-off per activity + recent games + both ratings).
- Full SETTINGS parity with top sites (board styles, behaviors). Base done, expand.
- Profile (rail) + opponent/level in topbar during play.
- Famous games under Lessons.

## Loop 2 + Loop 3: FEATURE-COMPLETE (2026-06-24)
All requested features built, integrated, verified (typecheck + build + `electron .` boot green throughout):
- Home dashboard · Play vs engine (any Elo) + **GM personas with real opening books** · Analysis
  (eval bar, MultiPV, move tree) + **game review** (accuracy/blunders/brilliants, eval graph, est-Elo band)
  + **live coach** · Puzzles (4.7M, Glicko-2 rating, hints, coach) · **Lessons** (54-lesson curriculum +
  interactive player) · **Famous games** (30 validated, viewer + analyze) · Openings explorer · Progress/My Games ·
  Settings (themes, 3 piece sets, sound, profile).
- Backends via node:sqlite (no native build). Engines bundled (Stockfish). Open assets only. No emojis.
- Built by many parallel agent fleets (research → implement → adversarial-verify → harden), lead-integrated.
- Commit trail: scaffold → engine → db → b1(play/puzzles/home) → b2 backend → wide wave → wave2 →
  persona books → live coaching → interactive lessons.

## Remaining
- Hardening pass (in progress: 6-dimension adversarial review) → fix findings.
- Packaging: installer + GitHub release (deferred per user). Decision needed: puzzle-DB size for the
  shippable installer (full 2.1 GB vs lean ~450 MB to fit GitHub's 2 GB asset limit).

## (historical) Next: remaining FOUNDATION (v0), ordered
1. Repo hygiene + DEV-containment redirect (done: hygiene; pending: code).  2. App shell + security baseline + typed IPC.
3. Reconcile schema + persistence.  4. Native Stockfish integration (fetch + UCI wrapper, 2 instances, Windows-safe kill).
5. Puzzle DB build pipeline (theme-aware prune).  6. Analysis board.  7. FEN/PGN load.  8. Openings name lookup.
9. Puzzles + Glicko-2.  10. Play vs Stockfish (any level).  11. Full game review.  12. Local coaching engine.
13. Accuracy→Elo band.  14. Famous games (engine-annotated).  15. Saved games + progress.  16. Settings + Credits.
17. Packaging.  18. Sound + motion + a11y.

## Web port, Phase W1 COMPLETE (2026-07-11)
Binding spec: `docs/WEB-PORT-SPEC.md`. The seam + skeleton phase landed, desktop untouched (all 28
`scripts/test-*.mjs` suites green, `electron-vite build` green, typecheck node+web+server green):
- **DB seam**: `src/main/db/database.ts` is electron-free, `configureDb({appDbDir, puzzles})`
  injection; desktop injects `app.getPath('userData')` + datasets resolvers from `src/main/index.ts`.
  Proven headless by `scripts/test-db-seam.mjs` (bundle has zero electron refs; migrations 0→10 at an
  injected path; lazy mid-session puzzle-DB pickup).
- **Web target**: `src/web/` (`index.html`, `main.web.tsx`, `webApi.ts`) + `vite.web.config.ts` →
  `dist-web/` SPA. `webApi` is the second typed `Api` impl. REAL on web day one: settings, Variant
  Lab, the **local game archive** (localStorage `game`-table mirror: finished OTB/online games land
  in Library/Home/Analysis lists), **opening-name lookup** (the desktop's EPD-keyed
  resources/openings/openings.json lazy-loads as its own 62 KB-gz chunk, same chessops keying), and
  dialog.saveFile = browser download. Datasets reported ABSENT (routes Play/Analysis/School into the
  renderer's own EngineRequiredNotice gates: no fake Stockfish; engine.newGame also rejects to
  close PlayView's probe-race), bot moves reject with the renderer's own BotUnavailableError so
  toasts show honest copy. Everything else resolves honest empties or rejects with coming-online
  copy. `scripts/test-web-stub.mjs`: runtime shape parity vs `src/preload/api.ts` (83 methods / 18
  namespaces) + behavior contract.
- **Server**: `server/index.ts` (Fastify) serves the SPA with COOP/COEP on every response
  (browser shows `crossOriginIsolated === true`: SharedArrayBuffer ready for W2 engines), immutable
  asset caching, SPA fallback, `/api/*` 503 coming-online, `/healthz`, `/games-art` statics.
  Bundled self-contained by `scripts/build-server.mjs` (fastify stays in devDependencies, desktop
  package unaffected). `scripts/test-web-server.mjs` headless smoke. Dockerfile + compose skeleton.
- **Scripts**: `dev:web`, `build:web`, `build:server`, `serve:web`, `start:web`, `typecheck:server`,
  `test:db-seam`, `test:web-stub`, `test:web-server`.
- **Boot proof (browser, production server)**: all menus render; Home/Progress zero-states; Puzzles
  "No puzzles available"; School "No chapters yet"; Analysis "Stockfish 18 · unavailable" + install
  card; Settings import → honest "No downloads on the web" alert; updates → "You're on the latest
  version"; Games library fully live (client-side rules/boards/manuals); **online multiplayer hosts
  from the browser** (trystero relays connect, join code issued).
- **Audit** (16-agent workflow, every renderer Api call site traced + adversarially verified):
  7 confirmed findings, all fixed in W1-owned files (engine.newGame reject; BotUnavailableError bot
  rejections; real openings.lookup; localStorage game archive; bare `/api` 503; asset-shaped 404s
  instead of SPA fallback; main.web.tsx boot .catch). Accepted W1 gaps, renderer-owned by design:
  Rush "Band cleared 0 solved" card when Start is pressed with no puzzle DB (W4 makes puzzles real),
  Analysis review's generic "Review failed. Please try again." copy (W2 makes review real).
- Known W5 items (renderer copy, untouched by design): welcome dialog "no internet" line, engine/
  dataset notices phrased as desktop downloads ("Download in Settings → Datasets" CTAs), Updates
  card subtitle, mpSession version-mismatch copy, background-tab throttling for web MP hosts
  (Electron sets backgroundThrottling:false; a backgrounded browser tab hosting a game may need a
  visibilitychange keepalive).

## Web port, W2–W6 COMPLETE: full port shipped (2026-07-12)
All six phases of docs/WEB-PORT-SPEC.md are built, integrated, and verified. Desktop 100% intact
(all 32 scripts/test-*.mjs suites green, electron-vite build green, typecheck node+web+server green).
Built by 5 parallel agents (engines / server / client / renderer-copy / docker) + lead integration;
every phase browser-verified against the production server + real 2.1 GB puzzle DB.
- **W2 engines (browser WASM)** in `src/web/engines/**`: Stockfish 18 lite (7 MB, multithreaded,
  NNUE embedded; single-thread fallback when not crossOriginIsolated) + Fairy-Stockfish 14 WASM
  (all variant kinds + Variant Lab custom inis via FS.writeFile/VariantPath). Exact desktop
  semantics: two logical instances, handleId streaming, calibrated sub-1320 weak model (pick-for-pick
  identical to the desktop under seeded RNG), evalVariant 300 ms bounded eval, persona moves
  client-side. Client-side game review imports the DESKTOP accuracy.ts/estElo.ts directly.
  Go bots + Maia = honest desktop-only rejections (decision record: lc0/KataGo WASM too heavy for
  v1). Verified live: bot game replies (French Defense vs 1500), Analysis streaming MultiPV depth
  48, engines gate lifted via datasets.status integration switch.
- **W3 accounts + persistence** in `server/{auth,users,bridge,review,electron-shim,bridge-entry}.ts`:
  argon2id (hash-wasm), httpOnly sid cookie (30-day rolling, Secure on https, TRUST_PROXY opt-in),
  users+sessions in DATA_DIR/server.sqlite, **per-user DB files** (DATA_DIR/users/<id>/app.sqlite via
  openAppDb + setDbOverride under a global FIFO mutex: deliberate deviation from the spec's user_id
  column for total repo reuse, documented). THE IPC BRIDGE: desktop ipc modules bundled UNMODIFIED
  with an electron shim → POST /api/ipc/<channel>, original zod schemas enforced; public content
  channels (puzzles/famous/school-content/personas/coach) work signed-out against an anon DB.
  Client: src/web/{http,authStore,localData,reviewStore}.ts + account chip (own React root).
  Signed-out = full local mode (localStorage archive + REAL local Glicko-2 ratings); signed-in =
  account DB. Verified live: signup → session survives hard refresh → game saved through the bridge
  returns from the account DB.
- **W4 puzzles + school + statics**: served through the same bridge off the real puzzle DB
  (PUZZLES_PATH) + resources trees (RESOURCES_ROOT shim). Verified live signed-out: real rated
  puzzles with theme counts, 40 School chapters, placement flow live on the WASM engine.
  (An earlier "(2.4M short)" note here was a miscount. The committed DB row-counts at the full
  4,699,980 puzzles, verified 2026-07-14.)
- **W5 parity edges**: src/renderer/src/platform.ts isWebBuild + honest web copy in Onboarding,
  EngineRequiredNotice/PuzzlesRequiredNotice, KernelBot KataGo card, DatasetsPanel, UpdatesPanel,
  DailyMode, mpSession version-mismatch. Desktop rendering byte-identical (flag false there).
- **W6 deploy**: final multi-stage Dockerfile (volume-first puzzle DB; bake-in via named build
  context + WITH_PUZZLES arg; /data volume; HEALTHCHECK; USER node), docker-compose.yml,
  .github/workflows/web.yml (test job + docker job, bridge-aware smoke), docs/WEB-DEPLOY.md
  (env table, reverse-proxy COOP/COEP + TRUST_PROXY notes, Fly/Hetzner sketches).
- **Scripts**: build:server now emits server + ipc-bridge; new suites test:web-engines (85),
  test:web-auth (31), test:web-bridge (46), test:web-client (47).
- Known v1 limits (documented): go/maia bots desktop-only; single-writer FIFO DB mutex
  (friends-scale); UCI_Elo on the lite net may drift slightly from desktop calibration anchors.

## Web port: hardening pass (audit fixes, 2026-07-14)
An adversarial audit of the (still-uncommitted) web port found ZERO criticals. Cross-user
isolation, SQL injection, path traversal, the channel allowlist, argon2 params and session entropy
were all attacked and held. It did find 8 MAJOR hosting-hardening gaps, all fixed, desktop untouched
(the shared ipc-file caps sit far above real renderer usage; desktop build + full suite wall stay
byte-for-behavior identical). Fixes:
- **Unauthenticated DoS closed** (was the gate even for friends): the public bridge channels
  `school:debrief` / `school:narrate` / `coach:explainMove` / `puzzles:next` / `puzzles:batch` now
  `.max()`-cap every array + length-bound every string (mirroring the already-hardened review.ts),
  so an anon POST can't pin the single global DB mutex. Load-tested for real: a 287 KB / 1500-move
  payload (under the 1 MiB body limit) is rejected at the zod gate in ~45 ms BEFORE entering the
  mutex; a 20× flood keeps legit requests at ~12 ms.
- **Auth abuse bounds**: `@fastify/rate-limit` on `/api/auth/*` (login 10/min/IP, signup 5/hr/IP,
  `global:false` so nothing else is limited) + a 2-wide argon2 concurrency gate (each hash is
  ~19 MiB, so an unbounded burst was a memory-exhaustion vector) + a `MAX_ACCOUNTS` signup ceiling
  (each account is an on-disk DB).
- **Secure cookie by default**: the sid cookie is `Secure` on any https request AND whenever
  `NODE_ENV=production` (so a proxy that forgets `X-Forwarded-Proto` can't downgrade it);
  `COOKIE_SECURE=1/0` overrides. `TRUST_PROXY=1` documented as REQUIRED behind a proxy (env table +
  docker-compose + proxy section). It also gives rate limiting real client IPs.
- **Bounded per-user DB handles**: the handle Map is now an LRU (`MAX_OPEN_USER_DBS`, default 32)
  that closes cold handles; the anon DB is pinned. Eviction only ever runs inside the FIFO mutex,
  so a closed handle can never be in use.
- **Session tokens hashed at rest**: the DB stores `sha256(token)`; the raw 256-bit token lives
  only in the cookie; lookups hash the presented value. A `user_version` 0→1 boot migration hashes
  any pre-existing raw rows in place without logging anyone out.
- **Honest web debrief** (W-01, was NOT in the old known-limits): the boss debrief arrives from the
  renderer with empty evals and delegated to the server's Viktor, which needs native Stockfish
  (absent on web). The failure was swallowed and every move classified "fine". Now `src/web/engines/
  debrief.ts` runs viktor.ts's own enrichment CLIENT-side on the WASM analysis instance (same
  DEBRIEF_DEPTH=12, MAX_POSITIONS=24 budget, mover-POV/negate/mate conventions) before the bridge
  call; an engineless browser rejects with honest copy instead of posting empty evals. Verified live
  in a browser: the enriched move carries a real best move, 13-ply PV, and mover-POV eval.
- **Local→account import on signup**: `src/web/migrate.ts` copies signed-out localStorage progress
  (games + their cached reviews under new server ids, custom variants, settings; ratings stay
  local) into the fresh account on first signup; sign-IN shows a "stays on this browser" notice
  instead (merging into existing account data is undecidable). Best-effort, never blocks the reload.
- **Username enumeration softened**: login now runs a full argon2 verify against a decoy hash when
  the user row is absent, so response timing no longer distinguishes unknown-user from wrong-password.
  Signup 409s still reveal taken names, an accepted friends-scale trade-off, documented.
- **CSRF backstop**: on top of SameSite=Lax, an Origin-allowlist hook refuses cross-origin mutating
  `/api` calls (same-origin and no-Origin non-browser clients pass).
- Minors swept: STATUS/README/Docker/CI stale copy corrected; the committed puzzle DB row-counts at
  the full 4,699,980 (the earlier "2.4M short" note was a miscount); README self-host quickstart
  added; CI now exercises the WITH_PUZZLES bake-in path.
- New/extended tests: cap rejection + CSRF + 413 body-limit (test-web-bridge), Secure-cookie +
  rate-limit 429 + MAX_ACCOUNTS + token-hash-at-rest + v0→v1 migration (test-web-auth, now 3-phase),
  debrief enrichment + engineless-reject + signup import (test-web-client).

## Decentralized accounts, Phase A1 COMPLETE: identity & keys (2026-07-14)
Binding spec: docs/ACCOUNTS-SPEC.md v1.1; parameters: docs/ACCOUNTS-PARAMS.md (NEW; every §13
open parameter decided + rationale; 3 items flagged for sign-off: checkpoint M=4/N=8, per-category
reveal thresholds 120/100/80/40, reputation fold weights). Built by a 3-builder fleet against a
lead-written contract, then a 29-agent adversarial review (6 attack dimensions, findings
independently verified: 4 major + 13 minor confirmed, 6 refuted) and a fix pass. Desktop 100%
intact: full wall 36/36 scripts/test-*.mjs green, electron-vite build + build:web + build:server +
typecheck (node/web/server) green.
- **src/shared/accounts/** (platform-neutral, no node:/DOM; typechecks under BOTH node and web
  tsconfigs): cjson-v1 canonical codec (sorted keys, integers only, no null, NFC, lone-surrogate +
  `__proto__` rejection: byte-determinism is the product), sha256/ed25519 wiring (@noble, sync),
  argon2id identity derivation (m=64MiB t=3 p=1, salt=sha256(NFKC-casefolded username), password
  NFKD: both FROZEN-AT-GENESIS in PARAMS_V1, digest ZDoblqaVf5z1zL8IvmWK2sdZK29JTNWZpY38XuDBZdk),
  SLIP-0010 ed25519 hardened children (official test vectors), name#TAG (5-char base32), BIP39
  24-word mnemonic + keyfile export, two-lane chain (witnessed single-writer hash chain; personal
  per-signer CRDT with deterministic merge), root-signed key certificates + revocation, checkpoints
  (embed prior snapshot, incremental one-step verify, deep verify), self-authenticating fork
  proofs, keyring (tag-aware: same-name different-tag identities coexist per §1).
- **src/web/accounts.ts**: web keyring glue over localStorage + window.__chessAccounts dev surface
  (no UI: A6 owns UI). Chain-first persist with rollback; createAccount never overwrites an
  existing chain. Web bundle +35.4 KiB gzip. Desktop renderer untouched.
- **Interim accounts (server/auth.ts) untouched and still live**. A-final flips them off.
- **Tests (491 assertions)**: test-accounts-core (154: SLIP-0010 vectors, argon2 KAT, NFD-password
  = NFC-password, normalization attack matrix), test-accounts-chain (144: tamper matrix, forks,
  checkpoint fraud incl. all bad-checkpoint branches, revoke-then-recert, duplicate-event
  canonicalization, CRDT merge determinism), test-web-accounts (151: node-vs-browser-bundle byte
  parity, rollback, coexistence), test-web-accounts-browser (42: REAL headless Chromium via
  playwright-core: derivation + chain verify bit-identical to node, crossOriginIsolated). CI:
  web.yml provisions chromium-headless-shell (browser worst-case gate now exists per §14);
  build.yml runs the two node suites on node 22.
- Review catches worth noting: password Unicode normalization was MISSING (NFC vs NFD → permanent
  lockout under C-5): now NFKD, frozen; `__proto__` canonical-vs-zod split-brain; chainToBytes
  duplicate-event non-canonicality; createAccount write-order brick. All fixed + regression-tested.
- A2 de-risk spike (throwaway, scratchpad): trystero 0.25.2 joins rooms under bare node with
  werift's RTCPeerConnection as rtcPolyfill: node↔browser connect ~4s over real Nostr relays,
  3-peer mesh verified, esbuild self-contained CJS bundle proven from an empty dir (satisfies the
  no-node_modules Docker constraint). node-datachannel works too but its native addon breaks
  isolated bundling: fallback only. Operator peer architecture: werift.
- Known A6 item: keyring.removeAccount + createAccount same creds = honest dead end (chain is
  preserved by design; record re-adoption flow lands with the account UI).

## Decentralized accounts, Phase A2 COMPLETE: witness fabric + PIN (2026-07-16)
Binding spec: docs/ACCOUNTS-SPEC.md v1.1 §1/§4/§8/§11; params docs/ACCOUNTS-PARAMS.md
(PARAMS_A2_DIGEST = oDyonXFK6JWN23sLdAqWJwaFiuxkm4eeZq7cxxdy2zc). Committed fecb758 + review-pass
42e716a. Converged clean over 5 Opus review rounds (defects 13→10→13→1→0) + a /code-review pass.
- **src/shared/accounts/witness/** (platform-neutral, deterministic): canonical witness set +
  eligibility, XOR-distance/closestEligible/prefixBucket (witness/distance.ts; nodeId =
  sha256(rootPub)), write lease with epochs, diversity-bound witnessed time, the tOPRF PIN
  committee (Shamir + OPRF), presence/attestation/slash, FabricEndpoint abstraction with MockFabric
  (suites) + TrysteroFabric (server/operator/peer.ts, trystero 0.25.2 + werift).
- **Proof (in test):** lease grant/takeover PIN-gated; a forced same-epoch fork is slashed; a
  different-epoch double-grant is appealed. Judge WASM sha256 =
  a8fbc05ec6920b56d7485826dcb02c5ffd2826bcbf751cf973046f237a9096f1 (stockfish-18-lite-single).
- Suites: test-accounts-{witness,pin,lease,fabric}.mjs + operator-smoke.mjs + test-judge-node.mjs.
  Desktop 100% intact.
- **4 residual seams deferred to A3's authority layer**: committee
  failure-counter anti-spreading; full canonical-set lease verification at attest; authoritative
  pin-record-chain anchoring for handoff; authenticated device-ownership at lease grant.

## Decentralized accounts, Phase A3 COMPLETE: overlay + storage + wire v6 (2026-07-19)
Binding spec: docs/ACCOUNTS-SPEC.md v1.1 §5 (three retention layers, Kademlia overlay,
authenticated pointers, reconstruction viewer) + §8 (wire v6); params docs/ACCOUNTS-PARAMS.md §Storage
(N_shards=40, K_rec=12). PARAMS_A3_DIGEST =
ACxJEbqGQj7VOdWBvaLMiYuhfDHluYo0bZ0gbu_1yNE. Bricks 1/2/6 committed 17b39f4; bricks 3/4/5 built by a
pure-Fable fleet then driven through 5 adversarial Fable review+verify+fix rounds (per the accounts
model policy), each finding independently verified before fixing.
- **src/shared/accounts/storage/**: RS codec (rs.ts: GF(2^8), Cauchy MDS matrix, any 12-of-40
  reconstruct, sha256 integrity); shard duty + repair (shards.ts: distance-assigned shard keys,
  publish-on-write, finalSync, background runRepair: eviction=churn=healed; owner-committed
  per-shard body auth via SnapshotHeader.commitSig + bodyHashes); authenticated pointers (pointers.ts:
  segment/chain/shard proof kinds, proof-ranked per-key cap that survives sybil floods, index built
  at write time so viewing never searches); reconstruction viewer (viewer.ts: resolve → verified
  contact sheet → freshest-holder profile + newest M-of-N checkpoint + head, incremental verify +
  spot-check, lazy history pager).
- **overlay/**: Kademlia over FabricEndpoint (k-buckets, iterative FIND_NODE/VALUE/STORE, bootstrap;
  operator peer = fallback relay). **wire v6**, PROTOCOL_VERSION 6, `witness` role, per-move
  signature chaining + countersigned clock stream; existing test-mp GREEN behind the v5 gate.
- **THE §5 PROOF (test-accounts-reconstruct.mjs):** 1,000 witnessed games + 50 five-cosigner
  checkpoints, 300 opponent nodes on a real overlay at production 40/12 geometry, owner's node gone
  forever → a fresh viewer reconstructs profile + newest checkpoint + head + FULL history BIT-FAITHFUL
  to the original chain bytes; degraded <K_rec → honest temporary unavailability → runRepair
  re-encodes/redistributes → heals. Failure mode is temporary unavailability that heals, never loss.
- **Authority model, both viewing paths:** the EXPECTED path (verified chain reconstructs) is
  absolute on NO-FORGE + NO-SUPPRESS: head/segment/checkpoint/name/profile source ONLY from the
  verified chain (or verifyChain-gated); a non-linking pool event by ANY key (incl. a certified,
  non-revoked leaked device key) can neither inject content nor outrank the verified head. The FLOOR
  path (no chain to vet linkage) fails toward NO-FORGE and honestly surfaces the one irreducible
  residual via `revocationContested`. Accepted compromise **C-12** (spec §12).
- Suites (all green): test-accounts-shards (246), -pointers (105), -reconstruct (217), plus -rs (102)
  and -overlay (78); registered in package.json + .github/workflows/build.yml. Desktop 100% intact:
  electron-vite build + typecheck (node/web/server) exit 0.
- **A2→A3 residual seams:** substrate now exists (replicated chains/certs, chain-authoritative
  storage) but the witness-side hooks are NOT wired, deferred to A4's first brick. The new-module
  browser byte-parity is exercised inside the suites; wiring RS/overlay parity into the playwright CI
  gate is a small follow-up.

## Decentralized accounts, Phase A4 COMPLETE: ratings, reputation, trust, matchmaking (2026-07-21)
Binding spec: docs/ACCOUNTS-SPEC.md v1.1 §6/§6b/§7 + §14-A4; params docs/
ACCOUNTS-PARAMS.md + src/shared/accounts/ratings/params.ts (PARAMS_A4_DIGEST =
y99AjAdObDkadHPTKacPt2KUOmUciH6S7vgPbLVnFzM).
Owner directives this phase: pure-Fable builders (verified per agent) and **BUILD-ONLY**. No
post-build adversarial review rounds, no /code-review pass; testing-as-built only (every brick
shipped its suite green before integration). Built by a 6-brick Fable fleet + lead integration.
- **Wave 0 (lead)**: event registry gained witnessed-lane 'conduct'/'commend'/'pin' types (strict
  zod; recursion-bounded zCertEvent for inline commend certs); SegmentPayload.kind/tc ladder
  binding; PARAMS_A4 (fixed-point micro-units; sign-off items carried from the params doc).
- **detmath** (ratings/detmath.ts): FDLIBM-scheme dexp/dln from IEEE basic ops only (Math.exp/log
  are implementation-defined = banned in fold code); max relerr ~2e-16; 89 frozen exact-bit
  goldens. Suite 137.
- **A2→A3 seams closed** (witness/counters.ts, chainauth.ts, protocol.ts): converged PIN failure
  counters (signed monotonic per-member reports, trimmed-sum estimator; spread-proof AND
  inflation-bounded, regression = misbehavior evidence); full canonical-set verifyLease at attest
  when chain facts are replicated (honest floor preserved); chain-authoritative PIN-record
  anchoring via the 'pin' event (cosig fallback labeled); certified-unrevoked device-ownership at
  lease grant (chain-verified vs attributed paths labeled). Suite test-accounts-seams 53; all A2
  suites byte-untouched green.
- **Conduct + reputation** (ratings/conduct.ts, reputation.ts): §6b fold per PARAMS_A4 weights.
  Integer-counter state with windowed per-(game,opp) memory (repPairWindow=200; the window rule
  that expires memory is the same rule that expires reference validity. No dedup gap, asserted);
  countersigned commendations verified against inline certs, fail-closed; neutral start 80
  (misconduct presumed-innocent, merit earned from zero). Suite 120.
- **Trust + matchmaking** (mm/trust.ts, pairing.ts): chain-shape T in micro-units (age
  w/ attester-diversity cap, windowed entanglement-weighted opponent diversity trustDivWindow=1000.
  Sock puppets contribute ≈0, checkpoint cadence/cosig cleanliness, completion hygiene from
  RepState); width(T)=50+450(1−T)², island term, fixed 800-Elo spillover rails, symmetric
  pairingLegal (provisional-first pools; nothing rating-shaped ever shown to provisionals,
  visibleOpponentInfo/spectatorOpponentInfo pure rules). Suite 178. Fresh-account baseline
  T=550_000 (below the 600_000 island gate): A5 calibration dial, flagged.
- **Wire ladder binding** (segment.ts, mp/witnessCore.ts): witness end-signature optionally covers
  (kind, tc): byte-exact legacy shape when absent; verifySegmentEvent enforces segment↔wstream
  match ('bad-ladder-binding'), closing ladder-lying (the witness observes the session config +
  clock stream and is the authority). test-mp-v6 132; test-mp (v5) byte-untouched 277. A6 seam:
  mpSession's advisory onWitnessStream path ignores ladder-bound wends until it derives its own
  binding.
- **Ratings fold** (ratings/glicko.ts, ladders.ts, fold.ts, display.ts + checkpoint.ts): glicko-det
  port of the shipped glicko2.ts on detmath (float outputs within 1e-9 of the original; micro-unit
  integer boundary, round-half-up); ladders per (kind × TimeCategory) in exact integer math;
  **a4-v1 ChainFold**: per-ladder {r,rd,vol,n,placed}, embedded RepState + TrustInputs (verbatim
  delegation, composition-fidelity asserted), reserved bans shape, opponent inputs pinned to the
  segment's embedded M-of-N oppCkpt ONLY (never self-asserted; seeds 1200/350 otherwise),
  placement RD floor 300 for 10 games, windowed game-key dedup (a duplicated game cannot rate
  twice in-window; out-of-window duplication stays self-evident cross-chain fraud); display states
  Placement(n/10) → Provisional(n/reveal 120/100/80/40) → Ranked. checkpoint.ts folds are now a
  registry keyed by the state's f id (basic-v1 default; unknown ids fail closed; fold transitions
  verify deep-only). Suite 253.
- **Lead integration fixes**: chain.ts's in-chain checkpoint audit now selects the fold by the
  registry rule (a4-v1 recomputed lazily over the identical walked sequence, memory O(#ckpts);
  malformed/unknown fold ids are bad-checkpoint fraud): chain suite 144→154; browser gate
  extended (accounts-fixture + both web-accounts suites): detmath float64 bit-grid, RS 12-of-40
  encode/drop/reconstruct, overlay k-bucket routing math, PARAMS_A4, and the a4-v1 fold state hash
  over a rated fixture chain: all byte-identical in real headless Chromium vs the node oracle vs
  frozen goldens (web-accounts 167, browser gate 58). The A3 "RS/overlay browser parity" follow-up
  is hereby closed.
- **Suites registered** (package.json + .github/workflows/build.yml): accounts-detmath/seams/
  reputation/trust-mm/ratings. **Full wall green** (46 suites incl. all games/web/desktop),
  typecheck node/web/server clean, electron-vite build + build:web + build:server all green.
  Desktop 100% intact.
- **Sign-off items open for Isaac**: (1) ckpt cosigners M=4/N=8, (2) reveal thresholds
  120/100/80/40, (3) reputation fold weights (all standing from ACCOUNTS-PARAMS.md) plus new
  A4-flagged dials: fresh-account trust baseline (550k vs island gate 600k) and same-rail-only
  spillover pairing. Next phase: **A5, anticheat** (canonical judge pinning, Tier 1/2, estElo
  refit, oracle-margin + commit-reveal calibration, self-ban rule).

## Decentralized accounts, A4 adversarial-review fix pass COMPLETE (2026-07-21)
Input: the A4 adversarial review, 29 verified findings (8 crit · 12 major ·
9 minor; root cause of the critical cluster: folds trusted self-asserted / cryptographically
unverified inputs, violating §0). Fixed 27; 2 deliberately deferred with in-code hooks
(A4-12 abort-omission → A5's obligation machinery; A4-21 commender-revocation → A6 read-time
discount). Fixed by a 5-brick Fable fixer fleet (build+test only, per phase policy) + lead
verifier-layer work:
- **F1 (segment/wire)**: witness end-signature atomically covers kind/tc/players/reason on rated
  segments ('bad-ladder-binding' on mismatch/partial: kills color-flip win-forgery A4-01 and
  self-asserted reason/opp A4-08); `verifyEmbeddedOppCkpt` (root-binding + inline-cert provenance
  + ≥ckptM cryptographically-verified prefix-diverse cosigners, fail-hard 'bad-opp-ckpt': kills
  the sybil/borrowed-checkpoint rating forgeries A4-02/05/06). Legacy byte-shapes preserved;
  test-mp (v5) byte-untouched. mp-v6 132→173.
- **F3 (mm)**: TrustInputs is BODY-ONLY. All wit-derived state removed, so the A4-04
  honest-verifier consensus split is architecturally impossible (wit-invariance asserted: fold with
  stripped/garbled/re-attested wit ⇒ identical state hash); verified read-time `trustEvidenceOf`
  (real attestation sig checks, §4 ≥3-attester thin-cap) replaces folded forgeable age/cosig
  (A4-03); diversity counts only fully-verified segments with proven oppCkpts, proxy floor 50k for
  young opponents (A4-05/06); `pairingLegal(a,b,atWts)` pinned-time (A4-16). trust-mm suite rebuilt
  on real crypto with forgery negatives (A4-20/23/24), 178→246.
- **F2 (ratings)**: reputation gates on verified segments; legacy segments count completion-only
  (unbound reason/color/opp can no longer mint misconduct-innocence or merit) (A4-07/08);
  rematch-accept requires the counterparty countersignature AND the rematch game's own bound
  segment (windowed pending settlement) (A4-13); commends entanglement-weighted: 20/20 for
  established (proven-oppCkpt) pairs, 1/20 floor for fresh commenders, sybil farm caps at sub 20
  (A4-14); pinnedOpponent magnitude clamp; suites rebuilt on real crypto incl. the review's exact
  attack vectors (A4-19/22). ratings 253→300, reputation 120→197.
- **F4 (lead, verifier layer)**: verifyChain now verifies EVERY segment ('bad-segment'), rejects
  chain-wide duplicate game keys ('dup-game': replay re-rating dead at the chain layer, A4-09),
  and requires a4-v1 checkpoints once rated segments exist (basic-v1-over-rated = fraud;
  makeCheckpointEvent auto-selects a4-v1) (A4-10); fold-transition checkpoints verify via the
  deep fallback at selectCheckpoint AND cosignCheckpoint so first a4-v1 checkpoints surface and
  gather cosigners (A4-15). chain suite 154→164.
- **F5 (account UI mock)**: every surface now derives from the shared authorities. Quadratic
  width() only (A4-18), qualitative trust meter with numeric oracle dev-only (A4-25), provisional-
  viewer projections via visibleOpponentInfo/spectatorOpponentInfo (A4-17), legality-asserted demo
  pairing (A4-26), provisional bracket-toggle guard (A4-27), displayState/revealThreshold-congruent
  fixtures by construction (A4-28), C-12 degradation carriers + renderings + degraded fixture
  (A4-29).
- Schema groundwork (lead): zSegmentPayload.oppCerts; zConductPayload rematch-accept countersig
  fields; VerifyErrorCode +'dup-game'/'bad-segment'.
- **Full wall + typecheck + electron/web/server builds green post-fix** (46 suites; accounts wall
  now chain 164 · mp-v6 173 · ratings 300 · reputation 197 · trust-mm 246 · web-accounts 167 ·
  browser gate incl. re-frozen a4 fold-state golden).

## Decentralized accounts: Phase A5 COMPLETE (build + calibration; one params decision OPEN) (2026-07-21)
Binding: docs/ACCOUNTS-SPEC.md §8/§9/§7(b) + §14-A5;
params src/shared/accounts/judge/params.ts (PARAMS_A5, provisional-until-calibrated by design).
Built by a 6-brick Fable fleet (J1–J6) + lead groundwork; testing-as-built, owner reviews separately.
- **Lead groundwork**: PARAMS_A5 + digest; witnessed event types 'pairing' (self-executing
  abort/no-show obligation: the A4-12 machinery) + 'selfban' (§8 compliance event).
- **J1 judge core** (judge/{types,judge}.ts + node/web adapters): content-hash-pinned
  stockfish-18-lite-single on every platform (web adapter verifies wasm bytes pre-instantiation,
  TOCTOU-free; bypasses play/analysis engine selection); fixed nodes/MultiPV/Hash, per-game
  ucinewgame+TT reset; canonical JudgeOutput + digest; UCI input sanitation. Determinism gate:
  warm-replay + fresh-instance bit-identity; frozen 9-position t1 golden digest. judge-node 17→42.
- **J5 pairing obligation** (conduct/reputation/witnessCore): witnessed pairing anchored in BOTH
  chains before move 1 (witness refuses rated games without both anchors); strict next-event
  settlement deadline (§8 pattern); unsettled pairing ≡ one recorded noshow (no new weights).
  reputation 197→259, mp-v6 →187.
- **J2 Tier-1 signals** (judge/tier1.ts): ACPL/engine-match(±15cp equivalence)/complexity port/
  clock-fit/trajectory as pure integer functions over JudgeOutput. Zero transcendentals
  (precomputed integer knots); canonical Tier1Record + digest. tier1 165.
- **J3 estElo refit** (gen-judge-corpus + judge/anchors.ts, committed f385611): full 176-game
  known-strength corpus re-analyzed through the real judge at t1 (401 s wall); judge-config fit
  MAE 296/332 (vs shipped depth-12 275/325: same regime); TIER1_ANCHORS_JUDGE wired in J2's
  shape; original analysis-side fit byte-untouched. judge-fit 67.
- **J4 Tier-2 + bans** (judge/tier2.ts, fold bans, pairing/display): commit-reveal window salt
  from T_lease threshold-sig bytes (unpredictable-before/recomputable-after, golden-covered);
  Regan-style window z with a ±3σ per-game cap making "no single game convicts" ARITHMETICALLY
  impossible under 3 games; deterministic escalation trigger (trailing-K ≥ 3.0σ); reproducible
  verdict + suppression records (full-recompute receipts); a4-v1 bans folded from selfban events
  ONLY (suppression is read-time auditor evidence: checkpoint determinism preserved); pairing/
  display honor bans ('banned' state, symmetric illegal). tier2 189; fold goldens unchanged.
- **J6 calibration + proof** (gen-cheater-corpus, 280 games judged; measured anchors into
  judge/anchors.ts TIER2_ANCHORS_JUDGE, σ_match 0.0623, σ_acpl 28.8cp, per-band curves):
  **THE §14-A5 PROOF**: honest holdout (352 sides) → ZERO convictions, zero escalations, max
  trailing-30 z 1.48σ (held-out 2.12σ); FULL-engine bot convicted at game 6, HALF at game 23:
  both within one K-window; threshold-ε metered bot stays sub-escalation as designed. Browser
  verdict-bit parity in real Chromium: web judge adapter at true t1 on golden positions ⇒ digest
  === node's; tier1/tier2 parity sections. browser gate 58→79. Calibration suite 43 (engine-
  dependent, local-only; artifacts + receipts committed under scripts/data/).
- **OPEN DECISION for Isaac: §7(a) empty-margin obligation NOT met at current params**: metered
  assistance sitting just under the 3.0σ escalation line yields ≈ +2.5 Elo/game converging to a
  BOUNDED ≈ +140–150 Elo one-time inflation (not unbounded), undetected at (K=30, 2-signal z).
  Options measured/analyzed: K≈64 (bound → ≈+95), cross-window lifetime accumulation (Regan's
  actual method: sustained metering eventually convicts; lead-recommended), adding clockFit/
  trajectory into z (clock uncalibrated yet), lowering escalation (risky: honest held-out max
  2.12σ). No parameter was changed; the calibration receipts make the decision reproducible.
- Suites registered (package.json: tier1/tier2/judge-fit/judge-calibration; CI wall: first three).
  Full wall + typecheck + electron/web/server builds green post-phase.

## Decentralized accounts, A5 addendum: lifetime accumulation (owner decision executed) (2026-07-21)
Owner resolved the §7(a) empty-margin decision: **option 1, cross-window lifetime accumulation**
(noting it was the spec's own intent, §8 "Regan-style ACCUMULATED evidence", and that the island
term already contains metered cheaters behaviorally); stability over optimization, bounded
one-shot inflation accepted as a minor flaw. Built as brick J7 (minimal, additive):
- PARAMS_A5 + `lifetimeScheme: 'z-sum-over-sqrt-windows-v1'` (lead): z_life(W) = ⌊Σ z_w/√W⌋ over
  a ladder's closed windows, ~N(0,1) under the null ⇒ SAME escalation/conviction thresholds, no
  new dials; 5σ absorbs evaluate-at-every-W multiplicity (union bound < 3e-3 over 300k games).
- tier2.ts: `lifetimeVerdict`, escalationDue lifetime extension (3-arg callers byte-unchanged),
  Tier2VerdictBody optional lifetime evidence with full recompute receipts. tier2 189→241.
- **Proof extended on 230 additional real metered games** (504 total corpus games): metered bot
  (realized ~2.15σ/window, 8/9 windows individually sub-escalation) → lifetime ESCALATION at
  window 4, CONVICTION at window 7 (210 games); honest holdout lifetime trajectory max 0.906σ
  (2.09σ margin to escalation): zero false signals. calibration 43→56.
- **Digest-drift handling (precedent recorded):** the lifetimeScheme row drifted PARAMS_A5_DIGEST
  and every drift detector fired as designed. Resolution rules now in force: Tier1Record-bearing
  corpora are RE-JUDGED from stored transcripts (J7 re-judged all 280 pre-drift games: 0 signal
  mismatches, a full-corpus determinism receipt); flat fit corpora keep their FIT-TIME pin
  (JUDGE_ANCHORS_PARAMS_DIGEST is historical provenance, never rewritten) with the suite asserting
  ENGINE-CONFIG IDENTITY (nodes/multiPv/hash/wasm) as the true anchor-validity invariant +
  loud drift note; parity goldens embedding the digest re-freeze (judge-node frozen T1 digest,
  browser-gate JUDGE_GOLDENS). All 50 suites + typecheck + three builds green post-addendum.
A5 is now COMPLETE. Remaining A5-adjacent residuals (documented, deliberate): clock-forensics
calibration (clockFit emitted but not a z input), salted-window re-exercise over cheater corpora,
suppression chain-side scanner + overlay verdict publishing (embedder/A6 work).

## Decentralized accounts, A5 adversarial review COMPLETE (2026-07-21)
Fable Workflow: search+verify x7 dims ->
implication search x5 -> dedup (38) -> unbiased verifier round (independent technical refuter +
relevance/congruency judge per finding; relevance decided by the verifiers) -> synth. Ran across two
resumes (API/spend interruptions; recovered from the workflow journal/return, no wasted spend);
verifier round COMPLETE for all 38. **Outcome: 33 CONFIRMED (3 critical / 16 major / 14 minor), 5
dropped** (appendix). No A5 code changed.
Critical (all independently verified): A5-01 canonical transcript->positions judging surface unpinned
in the shared core (in-repo callers already diverge -> verdict-bit divergence); A5-02 Tier-2 scores
signals vs the LAGGING fold display rating -> honest strong/improving accounts false-escalate during
the rating climb (verifier: real false-positive channel; ~25% false 90-day-ban trigger for elite
fresh accounts, deterministic lifetime false-conviction under sustained pool-capped lag; violates
§0 no-false-fraud + §8 astronomically-low-FPR); A5-03 verifyTier2Verdict blesses a suppression record
whose trailing-K z never reached escalation -> false suppression -> permanent distrust.
Major clusters: content-hash gate integrity (A5-10/12/13 + minor A5-11: checked!=loaded / TOCTOU on
node, unlinked hash literals, vacuous engine-identity guard); Tier-1 signal soundness (A5-14 dead
score-equivalence window, A5-15 increment-baked clockFit=0 for honest fast play, A5-16 unvalidated
self-asserted clock inputs); salt unpredictability/uniqueness (A5-18 + minor A5-17); ban-path FPR +
determinism (A5-20 late deadline vs lifetime trigger, A5-21 obligation gated on 3sigma not 5sigma,
A5-22 self-asserted non-monotonic expiry -> self-un-ban); liveness (A5-04/23 judge hang, no watchdog);
and a TEST-INTEGRITY cluster recurring the A4-19/22 vacuous-coverage class (A5-06/07/08/09). Notable
minors: A5-34 committed anchor provenance numbers don't match the committed corpus (1.884->1.482 measured),
A5-36 strength-trajectory signal computed+tested but never fed to any verdict (smurf channel absent),
A5-38 unbounded bans state in attacker-controlled ladder strings.
**Next: the FIX phase** (owner-specified flow: fix+test until fixed -> unbiased testers -> rewrite this
md for owner review). Prioritize A5-02/03 (honest-player false-fraud in the sole ban path) + the
content-hash cluster. A5 code otherwise built + calibrated green; fixes land on top.

## Decentralized accounts, A5 fix phase COMPLETE: all 33 findings adjudicated (2026-07-22)
Outcome: **30 FIXED, 3 DEFERRED-ratified**. Nothing open.
**Owner-delegated adjudication of the 4 open items** (directive: "honest players are never
banned, ever"):
- **A5-21 DECIDED + FIXED. The anticheat ban re-anchored on the 5σ CONVICTION.** selfBanDueNow
  now gates on escalationDue's new `conviction` report (earliest trailing-K window OR lifetime
  prefix crossing zThresholdMicro, same A5-20 lossless both-arms/min-by-ordinal deadline
  contract); the make/verifyTier2Verdict suppression gates require the RECOMPUTED conviction
  (escalation-band suppressions are refused with a typed error). 3σ escalation obliges ONLY
  deeper analysis. Rationale: 3σ ban gate ⇒ ≈1.35e-3/window FPR ⇒ an honest 1k/3k/10k-game
  career eventually owes a false 90-day ban with p ≈ 23%/58%/94% (§0 false-fraud); 5σ ⇒
  ≈2.9e-7/look, union < 3e-3 over 10^4 windows. Metering still convicts (J7 lifetime, W=4 at
  2.6σ/window). ACCOUNTS-SPEC §8 amended in place (conviction-anchored obligation + deadline).
  No PARAMS_A5 change (no digest drift); no pre-existing golden re-frozen.
- **A5-14 deferral RATIFIED** (match-criterion flip without the J6 refit breaks the calibrated
  honest null: false-positive hazard; revisit AT the J6 refit, before A-final volume).
- **A5-17 deferral RATIFIED** (anchor mechanism landed; witness signing-time discipline +
  embedder wiring are A6; no honest-ban exposure, and the ban path now also needs 5σ).
- **A5-36 deferral RATIFIED** (uncalibrated trajectory weight in z would flag honest improvers;
  the exact protected class; awaits the J4/J6 honest-slope calibration).
**Fable adversarial review of the re-anchor (same day):** 5 angles -> refuter + relevance judge
per finding; 35 agents, model audit clean (0/36 transcripts show Opus). 15 candidates -> 11
confirmed -> ALL FIXED: (a) escalationDue's validation domain made input-shape-determined
(upfront full-domain validation, ratified in the doc block + 4 regressions); (b) the inclusive
>= at zThresholdMicro pinned via a crafted exact-boundary window (z = 5_000_000 bit-exact,
one-micro-below twin refused everywhere); (c) lossless both-arms + earliest-prefix conviction
reporting pinned (drop-arm / report-last mutants now caught); + 7 stale "trigger"-anchored doc
sites corrected (types.ts, selfBanExpiryWts param -> convictionWts, fold.ts, module rule (b),
suite headers, review-doc supersession notes).
Final gates green: tier2 **394** (was 343 pre-decision) / tier1 268 / ratings 300 / chain 164 /
CI calibration 73 / typecheck node+web+server exit 0.

## Decentralized accounts: A6 Social & polish BUILT (2026-07-22)
Five parallel Fable lanes (wf_5dbaee62-e4d; model audit 0/5 Opus), all landed + self-verified:
- **Friends + profile** (src/shared/accounts/social/{friends,profile}.ts): §3/§10 countersigned
  friend edges: additive 'friend' witnessed-lane event type; countersig over sorted-pair
  canonical bytes (unreplayable across pairs); MUTUAL-read rule (both chains must assert the
  edge; removal by either side wins); commend-pattern inline certs, schema-enforced; profile
  rides the existing 'profile' LWW event; lastWitnessedActivity from verified attestations only.
  Suite test-accounts-social 95.
- **Presence + mailbox** (social/{presence,mailbox}.ts): root-signed ephemeral presence
  (caller-supplied nowWts, ttl-capped, freshest-wins, order-independent); mailbox anti-spam per
  §10: per-sender-root rate limit, per-recipient fair-share quota, edge-priority eviction
  (edge-0 sybils structurally CANNOT evict established-edge mail), bounded state, deterministic
  drain order. Suite test-accounts-mailbox 81.
- **A5→A6 embedder seams** (judge/embed.ts): banDeadline (CONVICTION-anchored min-by-ordinal;
  escalation NEVER yields a deadline; sub-5σ conviction claims refused, §0); consensusSaltOpts
  (witnessSet pin + requireAnchor:true, closing A5-17/18's consensus-path duty) + windowAnchor
  derivation; suppressionScan (next-witnessed-event rule, upfront full-domain validation);
  publish/adoptVerdictRow (full recompute verify; adoptVerdictRowJudge pins TIER2_ANCHORS_JUDGE
  for the ban path: A5-33 structural). Suite test-accounts-embed 146.
- **Renderer wiring**: mock store internals replaced with the REAL adapter, createAccount/
  signIn/signOut/export over src/web/accounts.ts + keyring (real argon2id), chain-derived
  profile/ladders/reputation/devices via shared folds + verifyChain; additive A6 web surface
  (resumeSession fail-closed, updateProfile signed personal-lane, listKeyringAccounts); boots
  signed-OUT, opt-in remembered seed, real mnemonic/keyfile export only; remaining
  network-dependent surfaces greppably DEV_FIXTURE-flagged with honest offline/preview copy.
  Suite test-web-accounts-wiring 74; electron + web builds green.
- **A-final flag** (server/afinal.ts + src/web/accountsFlag.ts): ACCOUNTS_DECENTRALIZED.
  Shipped builds default ON (interim /api/auth namespace answers 410 interim-accounts-superseded;
  server/auth.ts untouched, env-reversible OFF); content plane (/api/ipc puzzles/curriculum +
  /api/review + statics) untouched either way; web client suppresses interim auth UI when ON.
  Suite test-afinal-flag 67.
Lead integration: social/judge barrels reconciled; 5 suites registered (package.json + build.yml).
Gates: 5 new suites 463 asserts ALL GREEN; regressions green (chain 164 / ratings 300 / tier2 394
/ reputation 259 / core 154 / web-accounts 167 / web auth+client+server+bridge); typecheck ×3
exit 0; build:server + build:web + electron build exit 0.
**Deliberate residuals (documented in-code/suites):** live transport (presence/friends/mailbox
sync over the overlay) + witness signing-time discipline + canonical-reveal publication slot =
the network-integration pass; avatar upload preview-only; edgeMicro relay fold caller-supplied;
full-session kill of interim cookies on ipc/review deferred until decentralized persistence
replaces per-user DBs. A6 adversarial review round: recommended next (phase discipline). Not
yet run under the <1h build directive.

## Decentralized accounts: A6 review round COMPLETE, A6 CALLED (2026-07-22)
Owner-capped single search+verify+fix round (wf_905a1c4a-629, resumed once after an app
restart). Completeness pre-check: every §10/§14-A6 item present + suite-covered. Funnel: 6 find
angles → 20 candidates → refuter+judge verify → **15 confirmed (1 crit / 7 major / 7 minor) →
ALL FIXED same day**. Headliners:
suppressionScan strict-opts false-fraud channel REMOVED (critical: window/expiryWts are never
compliance criteria); adoptVerdictRow junk-padding evidence-suppression cliff fixed; renderer
profile fold routed through the canonical revoked-key-aware profileView; resumeSession
fail-closed boot + genesis-verified names; sign-out-forgets-seed contract tested; DEV_FIXTURE
made a real live gate with per-surface preview badges; §10 staleness wired end-to-end; A5-21
conviction-only ban copy everywhere; privacy-default remembered seed.
MODEL-POLICY NOTE: 2/6 finders partially bounced to Opus (API fallback); ALL 40 verifiers +
the fix agent pure Fable: every confirmed finding Fable-reproduced; incident recorded in the
review doc per the standing directive.
Final gates: social 97 / mailbox 81 / embed 148 / wiring 100 / afinal 67 / chain 164 / tier2
394 / reputation 290 / web suites green / typecheck ×3 / build:web + build:server exit 0.
(ratings + web-accounts fold-state goldens were mid-refreeze by the CONCURRENT A4 fix agent at
wall time: A4-lane, not A6.) **A6 CALLED.**

## Decentralized accounts: A4 review re-verified + completed on Fable (2026-07-22)
The 2026-07-21 A4 fix pass (recorded as a "Fable fleet") was in fact **Opus 4.8**, off the
Fable-only accounts model policy. An adversarial **Fable-5 re-verification** found only **16/29**
review findings genuinely closed + test-pinned (not the claimed 27/29): 12 partial, 1 open. The
remaining 13 were then closed under a **divergence-safe Fable protocol** (Fable output trusted-
terminal; any Opus divergence quarantined → 1 Fable verifier, else 2 independent non-coordinating
Opus-max verifiers). All fixes landed **pure Fable** (audited per-agent transcripts); A4-01/09 were
cleared by two unanimous Opus-max verifiers; A4-02 (sybil ratchet: cosigners unanchored to any
witness roster) was closed by a Fable fix that pins §6 seeds in-fold and applies roster eligibility
only at read time (`ratingEvidenceOf`), keeping embedded state deterministic (no A4-04 regression).
- **All 29 A4 findings CLOSED**, with 3 deliberate deferrals (A4-02 pin fidelity → A5,
  A4-10 stale-checkpoint → A5, A4-21 commend-revocation → A6, each with an in-code A5/A6 hook).
- **New:** the eligibility fixes established the read-time evidence layer across ratings/reputation/
  trust (`ratingEvidenceOf`/`repEvidenceOf`/`trustEvidenceOf`) + a real renderer test harness
  `scripts/test-a4-ui.mjs` (222 asserts: the §6 hiding rule, quadratic width, degradation carriers).
- **Full wall green (verified on the live tree):** ratings 340 / reputation 290 / trust-mm 277 /
  tier2 394 / tier1 268 / a4-ui 222 / reconstruct 217 / mp 277 / mp-v6 187 / shards 246 + the rest of
  the accounts/judge/web suites; typecheck (node/web/server) + desktop/web/server builds all exit 0.
- **A-final live:** ACCOUNTS_DECENTRALIZED default ON, interim /api/auth 410-gated, env-reversible
  (test-afinal-flag 67 asserts).

## Decentralized accounts, Phase A6 STARTED: go-live wiring (2026-07-23)
Owner directive: make the spec's A1–A6 REAL and LIVE (anyone can make an account + play as intended)
on mac/windows/browser. A go-live audit (real vs mock
vs unwired) confirmed the A1–A5 substrate is real+
tested but NOTHING was wired live (only unsigned mp + interim server accounts ran; TrysteroFabric/
operator peer never mounted; account UI = DEV_FIXTURE). A6 wires the tested substrate into the
running app.
- **M1 vertical slice BUILT + verified headless (2026-07-23):** 5 file-disjoint lanes in the new
  src/renderer/src/features/account/net/ dir + one lead schema add (`pregame-snapshot`
  FabricRequestKind). Lane A browserFabric+iceConfig (real trystero WebRTC transport, C-11 ICE
  resolver); Lane B peerService+kvStore (per-client overlay node + witness/committee serve +
  IndexedDB KV, §11 caps); Lane C signing wiring (mpSession.configureSigning + onlineStore
  signing-provider/segment-publisher seams: casual play byte-identical); Lane D witnessRunner
  (drives WitnessCore to produce wclk/wend: the missing runtime piece); Lane E segmentWriter +
  preGame snapshot + THE M1 SLICE PROOF. Suites green from lead shell: test-accounts-live-slice 50
  (two chains carry matching rated segments, both verifyChain green, both ladders move off 1200),
  witness-runner 59, browser-fabric 19, peer 49, mp-v6 208 (+21 signing), mp 277 (casual
  byte-untouched), fabric 63, typecheck clean. Registered in package.json + build.yml.
  Lead integration (renderer boot + game-over publisher + witness path + real-relay smoke) IN
  PROGRESS. Remaining: M2 matchmaking/lease/ladders · M3 storage/reconstruction live · M4 social/
  PIN/presence/mailbox + un-fixture UI · M5 anticheat live · M6/A-final walkthrough + flip.

## A6-M1 LIVE-WIRED + verified (2026-07-23)
A signed, witnessed, RATED online game now appends matching countersigned segments to BOTH players'
self-carried chains over REAL WebRTC (trystero 0.25.2 + werift), proven end-to-end by
scripts/smoke-live-slice.mjs (18 asserts, 3 peers each in its own worker over a real trystero
transport + localhost Nostr relay: public relays rate-limit bare-node; browsers don't). Both
chains verifyChain green, same game key/transcript/witness-terminal-sig (§3 entanglement), a4 fold
moved both Blitz ladders off 1200. Wiring: account/net/{accountNetBoot (peer starts on sign-in via
createBrowserFabric+kv+heartbeat), segmentPublisher (SignedGameOutcome→buildAndPublishSegment +
pre-game snapshot exchange), witnessController (idle instance witnesses a room)}; mpSession
verifyWitnessEndMsg additively surfaces the RATED wend (casual byte-identical, test-mp 277). Builds:
electron-vite + web + server green; typecheck clean. HONEST M1 boundary (→ M2/M3/M6): witness
assignment is MANUAL (window.__chessWitness or the operator peer); no pool auto-matchmaking; landed
segment doesn't live-refresh UI ladders yet; public-relay+coturn reliability is ops; certs/checkpoints
in pre-game snapshot are M2/M3. NEXT M2: overlay matchmaking (auto-pair opponents+witnesses), live
write-lease, ladders update in-app.

## A6 M2-live, M3-live, M4-live, M5-built + M2 bugs fixed (2026-07-23/24)
- M2 LIVE-WIRED + smoke green (44 asserts): two STRANGERS auto-pair with NO room code over real
  WebRTC, distinct 3rd-peer witness, both hold a live write-lease at one monotonic epoch, real
  'pairing' event anchors in both chains, countersigned rated 'segment' lands in both chains,
  both ladders move; honest C-10 2-user wait.
- M2 root-fix (3 integration bugs): matchmaking pool re-entrancy (notify on REMOTE only),
  witnessController head-seed without gameKey, mpSession resends start/resync to a late-seated
  witness (KILLED the 9s WITNESS_SEAT_DELAY_MS). Casual byte-identical (test-mp 277); mp-v6 227.
- M3 LIVE: shard duty/publish-on-write + throttled finalSync (per-game so owner-gone reconstruction
  holds after ONE game) + background repair + write-time pointers + §11 KV budget; reconstruction
  viewer un-fixtured. Suites: shard-duty 68, viewer-client 65.
- M4 LIVE: social (presence/mailbox/friend edges, §10 anti-spam sybil-proof, 52), PIN committee
  (setup+fuse, 52), and the account UI un-fixtured (PIN/social/overview/security/gamechrome/profile).
- M5 BUILT: judgeRunner Tier-1 (56, real pinned WASM), verdictClient Tier-2/self-ban/verdict-rows
  (81), fairplay UI un-fixtured to the REAL pinned hash. NOT yet live-wired into the game-over path
  (the M5 judge hook + pinClient.publishFuse to shard space = the last integration).
- BOOT (accountNetBoot): M3 storage gate + KV budget + publish-on-write + repair loop; M4 PIN +
  social start on sign-in; rootSigningKey() added (named export, not on window). Signed-out/casual =
  byte-identical no-op. Full combined tree green (typecheck + electron/web/server builds).
- REMAINING: M5 judge live-wire into game-over + publishFuse to shard space; then M6/A-final:
  the acceptance run (make account → match stranger → witnessed rated game → reconstruct → anticheat)
  + no-dead-button audit + flip ACCOUNTS_DECENTRALIZED default + kill interim cookies.

## A6 M6 / A-FINAL COMPLETE: the §1 acceptance gate is GREEN on the live wire (2026-07-24)
- **THE ACCEPTANCE SMOKE (scripts/smoke-acceptance.mjs · `npm run smoke:acceptance`): ALL GREEN, 74
  asserts, stable across repeated runs.** FOUR FRESH argon2id accounts, each in its own worker over the
  REAL trystero 0.25.2 + werift WebRTC transport (localhost Nostr relay signaling; the sanctioned
  harness that KEEPS the real transport; a bare-node mesh trips public-pool rate-limiting, the
  werift ICE is 100% real over 127.0.0.1 host candidates), running the whole §1 sentence asserted step by
  step: (1) each root is INDEPENDENTLY re-derived from (name,password) via deriveIdentity, a real §1
  account, reproducible (C-5), not a test keypair; (2) two STRANGERS auto-pair with NO room code (shared
  gameKey = signed-pool rendezvous), host=white; (3) a DISTINCT third peer self-assigns as WITNESS, the
  witnessed 'pairing' anchors + verifies in BOTH chains at lease epoch 1; (4) a scripted rated Blitz game →
  countersigned 'segment' lands in BOTH chains (verifyChain green, verifySegmentEvent null, same
  game/transcript/witness-terminal-sig), the a4 fold moves BOTH ladders off 1200 (winner up, loser down);
  (5) the M5 Tier-1 judge runs over the finished SIGNED transcript on BOTH instances → a Tier1Record naming
  the played game + the chess:Blitz ladder, both sides scored, IDENTICAL tier1Digest (the §8 cross-instance
  parity); (6) both players finalSync their chain into shard space (40 rows + self chain-pointer), the OWNER
  (white) SIGNS OFF, and a FOURTH fresh peer RECONSTRUCTS white from shard space with the owner OFFLINE,
  status 'expected', chain BIT-FAITHFUL to white's bytes, real folded profile (genesis display name + the 1
  Blitz game). PHASE 2 covers honest 2-user degradation: 2 peers, no witness → 'waiting-witness' (opponentFound,
  NO game opened, no lease grabbed: never a fake pairing, C-10); CASUAL unsigned play still starts + moves
  (byte-identical v5). New helper: scripts/smoke/acceptancePeerWorker.ts (the M2 mmPeerWorker superset,
  argon2id identity + M3 storage-duty gate/repair + onPublished→Tier-1 judge + finalSync + a viewer role).
- **A-FINAL FLIPPED (default ON) + the acceptance gate justifies it.** scripts/build-server.mjs injects
  __ACCOUNTS_DECENTRALIZED_DEFAULT__='on', so EVERY shipped bundle (dist-server, Docker) resolves
  ACCOUNTS_DECENTRALIZED ON and the interim /api/auth answers 410 Gone. The emergency lever
  (ACCOUNTS_DECENTRALIZED=0) + interim session-cookie coexistence on the content/persistence planes stay
  intact (server/afinal.ts), so no deploy ships account-less by surprise and an honest user's per-user data
  is never stranded behind an unreachable path. test-afinal-flag GREEN (67 asserts): shipped default ON,
  interim 410-gated whole-namespace, env-reversible both ways, /healthz + /api/ipc + /api/review + statics
  untouched.
- **NO-DEAD-BUTTON AUDIT: near-zero, as expected.** Every remaining DEV_FIXTURE / FixturePreviewBadge
  surface is a SIGNED-OUT / dev-showcase preview that a LIVE component replaces when signed in: DataTab
  mounts LiveStoragePanel (real readStorageStats) when a peer exists and the mock StoragePanel only
  signed-out; the live RatedLobby renders RatedLobbyLive (real fold/trust/live matchmaking) while the
  "Sample matchmaking: awaiting network transport" badge lives only in the dev RatedLobbyShowcase body
  (mounted with an `initial` prop, never in-app); ChainViewer / ProfilePage / TrustWidthMeter badges are all
  clearly-labeled "sign in…" / no-root previews. The ONE genuine disabled control is SecurityTab's device
  "Revoke" (disabled with the reason stated, never a mock signature). FLAGGED not fixed: enabling it is a
  PIN/committee-gated witnessed-lane 'revoke' append (a real feature, not a trivial fix). No trivial
  fairplay/hub dead buttons remained.
- **HONEST RESIDUALS for a real cross-machine / phone deploy** (NOT yet perfect): (a) PUBLIC-RELAY
  reliability + a coturn TURN server for NAT-hard peers are ops work. The smoke signals over a localhost
  relay because a bare-node mesh trips public-pool rate-limiting; real browsers spread across the public
  trystero pool avoid that, but public-relay flakiness is unproven here. (b) A freshly-online owner that
  shards then closes within seconds relies on a routing-table refresh (peer.bootstrap) before finalSync so
  a sparsely-bootstrapped peer replicates shards OFF-owner: the app's 60s presence cadence heals this over
  time, but the fast path is smoke-explicit. (c) background-tab keepalive (presence heartbeat + shard duty
  while backgrounded) is untested. (d) the in-worker Tier-1 uses the sanctioned spec-faithful UCI double
  (test-accounts-judge-runner's engine); the real pinned-WASM judge runs in the live game-over path
  (accountNetBoot) and its determinism is proven by test-accounts-judge-runner §7 + test-judge-node, but is
  not exercised by THIS smoke.
- GATES (all green): smoke-acceptance 74 (x2 stable); test-afinal-flag 67; typecheck node/web/server x3
  clean; electron + web + server builds green; test-mp 277 (casual byte-identical) + test-mp-store +
  test-mp-v6; broad desktop wall 33/33 suites (every accounts suite incl. reconstruct, tier1/2, judge-runner,
  viewer-client, live-slice, matchmaking, shard-duty). A6 COMPLETE.

## Post-A-final: cross-device accounts, the rebrand, a static web target, UI-v1 (2026-07-25 to 07-27)
Seven commits landed after the entry above. Scope and date per commit, oldest first.
- **c44d731 (2026-07-25) Cross-device accounts + the standalone seed node.** Lease takeover gets two
  lanes, PIN-signed when the account carries an active PIN record and root-signed when it does not,
  chosen from the subject's own signed state; that broke the deadlock (a PIN needed a live committee,
  the committee needed a PIN) which had made a second device impossible. leaseRunner auto-takes only
  past a full TTL, so a live holder is still refused. signIn now resolves its own chain over the
  overlay on a machine that has never seen the account, verifies it, and enrolls a fresh per-machine
  device key as a root-signed cert; only a full reconstruction is adoptable, since the segment-union
  floor would silently truncate history. NEW PROGRAM src/seed (dist-seed + out-seed): N nodes in one
  process, for seed.nodechess.com and as a tray desktop app from the same source, infrastructure by
  default (routing, shard hosting, relay, presence) with caps.witness and caps.committee false, so it
  carries capacity and zero authority. Also service receipts (shared/accounts/receipts.ts), signed by
  the receiver rather than the performer; nothing consumes them yet. Gates: typecheck x3, all 37
  accounts suites, all 7 web suites, both seed builds; lease 45, lease-runner 50, web-accounts 183,
  receipts 13.
- **fff521d (2026-07-25) Account UI: delete the machinery, keep the product.** 7 tabs to 3 (Profile /
  Friends / Account), 7,000 lines out: chain viewer, shard-duty tables, overlay stats, witness-peer
  lists, the fair-play explainer (it published the judge's exact sigma thresholds), GameChromeShowcase,
  the PIN wizard/entry/fuse card (provisioning cannot currently succeed and the fuse can still ban for
  90 days; the protocol keeps the lane, so turning it on later is an append, not a migration),
  OverviewSection, NetStatusPill, the Rated lobby. Every one deleted with zero typecheck breakage.
  TrustWidthMeter deliberately kept at this point. test-a4-ui 188 green; A4-26/A4-27 were pinned to
  the deleted lobby and are excised with a note to re-point them at the Play rated flow.
- **1845e5f (2026-07-25) nodechess: rated play in Play, a static web target, and the rebrand.** Rated
  is now a choice inside Play, Online, next to the time control; the separate lobby is gone. The web
  target lost its backend: the 2 GB puzzle SQLite is split into sub-25 MiB chunks read over HTTP
  Range, and curriculum, personas, famous games and openings ship as static JSON, which leaves
  nothing for a server to do. TrustWidthMeter deleted (its two pinned rules survive as the shared
  quadratic width() goldens and a source scan for trust vocabulary across every player-facing file).
  Docs 9,913 to about 6,626 lines, flattened out of the three-bucket split. Rebrand across 81 files,
  appId org.nodechess.app; the single kept Chess# reference is in docs/DATASETS.md, because installs
  predating the rename hold their datasets under the old productName folder. First verification of
  the combined tree: typecheck x3, 57 of 57 suites, build:web + build:seed + build:server.
- **c5a568e (2026-07-25) Remove every em dash, and verify the combined tree.** 664 files. The
  character was not swapped for a hyphen: most became a period, comma or colon, and a few tails were
  dropped as mechanism nobody had asked for. No behavior change; the two goldens files that moved
  were comment blocks above frozen digests, not the digests. Typecheck x3, 57 suites judged by exit
  code, build:web/seed/server, both apps booted. NOT established by that pass: no rated game was
  actually paired (every public relay refused this machine), and the puzzle artifact was absent from
  the checkout, so the puzzle path went unobserved.
- **0aaff75 (2026-07-25) Wire the chunked puzzle artifact into the web target.** First run of
  build:puzzle-chunks against the real database: 2.15 GB becomes 1.49 GB across 60 chunk files,
  largest 24.0 MiB, clearing the Cloudflare Pages 25 MiB per-file cap. 4,699,980 puzzles from rating
  399 to 3327; the 73 theme counts are precomputed into the manifest, so listing themes is no longer
  a GROUP BY over 21M junction rows. Verified end to end in the browser (themes with counts, a puzzle
  fetched by rating, rendered with a clean console).
- **4f722ae (2026-07-25) Design lab: ten directions on two swappable axes.** Ten independent takes,
  four screens each, against a shared token contract, so any navigation feel can be viewed under any
  visual style. The owner picked d01 (flat nav with a persistent readout, graphite with an amber
  signal) as the basis of UI-v1. The eight unpicked directions stay in-tree as the record of what was
  considered and rejected.
- **b065a55 (2026-07-27) UI-v1: the app is design-lab/v1, and it ships.** v1's stylesheets are
  installed VERBATIM as src/renderer/src/styles/{tokens,palettes,shell,brand,board-pieces}.css and
  every view is transcribed from its page; app.css (845 lines) and global.css (296) are deleted, and
  components.css is the only place for additions, and only for surfaces v1 never drew. NEVER SHOW
  FABRICATED DATA applied throughout: five invented account profiles reachable from the shipped UI, a
  `?? 1500` Elo rendered as a measurement, a `?? 52` placement accuracy that silently decided which
  chapters unlocked, and a rating chart drawn around a seed constant are gone. NEW: recovery-phrase
  sign in (mnemonicToSeed had no caller, so every account was single-device), QR device pairing (the
  code carries a public key and a nonce, never the seed; the approval step on the holder is the
  security), a web landing page, first-run and welcome-back surfaces, and updateRecovery.ts for a tab
  left open across a deploy. DEPLOYMENT: the puzzle artifact moved to R2 because Cloudflare Pages does
  not serve HTTP Range (it answered a 1,024 byte request with all 25,165,824 bytes, and sql.js-httpvfs
  accepts any 2xx as the range, so the reader parsed whole files as the page at that offset and
  returned puzzles that do not exist); dist-web went from 1.5 GB to 67 MB; docs/DEPLOY-WEB.md is the
  click by click. MOBILE audited at 375x812, 390x844 and 360x740: the live game screen had NO BOARD on
  a phone (.board-wrap measured 0x0), and nothing had ever spent an env(safe-area-inset-bottom)
  despite asking for viewport-fit=cover.
- **STILL OPEN after this run.** (a) The chunked puzzle artifact has to be built and uploaded before
  a deploy has puzzles at all: dist-puzzles is gitignored, is not part of the site upload, and goes
  to its own bucket (docs/DEPLOY-WEB.md Part 6). (b) The Cloudflare Pages project and the DNS/domain
  setup are not recorded as done here (docs/DEPLOY-WEB.md Parts 2 to 5). (c) The GitHub repo rename
  to isaacmiller123/nodechess is still pending, so `node scripts/release.mjs check` fails and the
  in-app updater names a repo that does not resolve (docs/RELEASE.md §2). (d) The A-final residuals
  above stand: public-relay reliability and a TURN server for NAT-hard peers are ops work, and rated
  ladders need real opponents before they mean anything.
