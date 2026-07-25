# nodechess: Roadmap & future-work reminders

> Running list of everything still to do, so nothing gets lost between sessions.
> Status per the owner (2026-06-30): the whole thing is **~60% there**.
> Authoritative school spec: `docs/SCHOOL-SPEC.md`. Curriculum: `docs/school-curriculum.md`.

## 🔜 In progress / recently shipped (this session)
- [x] **Games platform shipped (2026-07-06/07, spec-driven).** Per the binding
      `docs/GAMES-PLATFORM-SPEC.md`: game kernel + registry; 22 playable games (chess + 8 chessops
      variants, xiangqi/shogi/janggi/makruk/placement via ffish WASM, both checkers, go + gomoku,
      othello/connect4/hex/morris/TTT) each with local OTB + 5-level bots + online (wire v4,
      game-agnostic) + an authored in-app manual with live board diagrams; engines published to
      datasets for BOTH platforms (Fairy-Stockfish 14, KataGo 1.16.5 + nets incl. Human-SL,
      lc0 + Maia 1100–1900 as the chess "Human" style); shared react-three-fiber 3D tabletop
      (Poly Haven CC0 chess set, ambientCG PBR boards, per-game 2D/3D toggle per the approved
      tier table, WebGL auto-fallback to 2D); Variant Lab custom-variant editor (variants.ini →
      ffish runtime load + Fairy-SF VariantPath bots); visual polish audit pass done. Suites all
      green: games-kernel 68, ffish 85, go 80, checkers 74, small-games 101, custom-variants 83,
      manuals 222, bots 176, bots-ui 24, board3d 27, mp 215, mp-store 147.
- [ ] **Games platform residuals.** (1) CI (`.github/workflows/build.yml`) typechecks + builds +
      packages on windows-latest + macos-latest but does not yet run the game suites (spec P3
      wants suites in CI on both OSes. Needs a Windows-verified run before wiring in). (2) No
      tagged release contains the games platform yet (v1.0.1 predates it). Tag once pushed.
      (3) `src/main/window.ts` TODO(packaging): move loadFile → registered `app://` protocol;
      PROD_CSP already allows `file:` for the extraResources games-art so art survives the move.
- [x] **Removed the old Lessons tab → folded into the School.** Deleted the `Lessons` nav tab,
      `features/lessons/*`, and the `curriculum` backend/IPC/types. Home "next" card now continues the
      current School chapter / starts the next / prompts placement.
- [x] **Moved Famous Games into Analysis.** Standalone Famous tab + `features/famous/*` deleted; a
      "Load famous game" picker inside Analysis loads any famous game into the real analysis board
      (eval bar, review, coach, badges all light up).
- [x] **Audited + revised the Analysis tab + own-game flow.** Fixed: the broken "click a saved game →
      empty board" (gameId now threads through; saved games actually load + orient to your side);
      "Analyze this game" button on the end-of-game banner; a single engine crash no longer
      permanently wedges all reviews (timeout + exit handler + review:cancel); eval-bar fake +0.00
      when engine off; one-frame stale arrows after navigating; keyboard nav hijacking page scroll;
      eval-graph marker leaking out of variations; review accuracy now persists to the game row so the
      Progress accuracy column fills; perf:estimate returns YOUR side not a 2-player average; mate-0
      mis-scoring; move-list autoscroll; loaded-game header strip; responsive layout; MultiPV persists;
      inline FEN errors. (Owner said "more to do from there". Awaiting next direction.)

- [x] **Full-project audit-and-fix pass (2026-07-02).** 6 subsystem auditors → triage → 6 fixers →
      integration verify: 47 verified defects fixed (3 critical: dead SRS/streak systems, custom mode
      moving the Glicko rating, stale placement completions → v7 `auto_completed` provenance migration;
      13 high incl. unsolvable underpromotion curriculum items, sawtooth eval graph, wrong-side clock
      drain, review results never persisted, retry double-rating, fake Home daily card, `eloFloor`
      leaking over IPC). Typecheck + build clean; installed and verified live at user_version 7.

- [x] **Polish overhaul (2026-07-02, owner-directed).** 8-agent fleet: School UI overhauled (tiered
      journey layout, hero current-chapter, lesson timeline, capstone test card); school playthrough
      polished (custom annotation brushes, debrief blank-square bug fixed via per-line `fen`, move
      history in boss/placement/model, hint ladders in school puzzles + Custom/Daily modes, Viktor
      persona with portrait + states); review quality (depth 18-20, chess.com classification incl.
      Brilliant/Great/Miss, badge chips on every move, per-side review table, recalibrated Elo estimate
      w/ ACPL); sub-1320 engine strength rebuilt (main-process MultiPV softmax, no more uniform-random
      moves); famous games start at move 1; "Your games | Famous" browser in Analysis; opening line
      moved into the sidebar; openings grouped family→variations; settings overhaul (6 app themes,
      QoL toggles: autoQueen/confirmResign/hints/engine-arrows/eval-bar/low-time/volume, per-scope
      progress reset with confirm).

- [x] **Online multiplayer v3 hardening (2026-07-06, spec-driven).** Killed the four user bugs
      (B1 nav-unmounts-the-game, B2 dead clocks, B3 "random resigns", B4 polish gaps) per the binding
      `docs/MP-V3-SPEC.md` written from a 45-defect audit. Wire bumped to PROTOCOL_VERSION 3 (gameId +
      ply on every in-game message, dedicated `flag`/`abort`/`gameOver`/`drawDecline`/`resumeReq`/
      `resync`, timestamped ping/pong); the live game now lives in an app-lifetime `onlineStore`
      singleton (OnlineTab is a pure view, navigating away no longer destroys the game); lichess
      first-move grace (white move1 debits 0, no increment; abort watchdog replaces the pre-move flag);
      flags ride their own message with insufficient-material draw adjudication; monotonic clocks,
      lag compensation, heartbeat self-stall forgiveness, suspend/resume with speed-scaled reconnect
      grace, symmetric rematch. **Test coverage (builder-tests):** `scripts/test-mp.mjs` is the v3 session
      suite, **215 assertions** over every §2 rule (mock-pair transport with peer re-join, injected
      third peer, send-error + controllable delivery); `scripts/test-mp-store.mjs` runs the store against a
      mocked mp (esbuild-aliased), **112 assertions** (optimistic-move rollback, K-vs-heavy
      insufficient-material flag→draw, save-once, peerAway board-freeze, sole `mp.leave()` caller); and
      the two-window Electron E2E harness (`scratchpad/mp-e2e-v3`) drives the REAL session over live
      Nostr relays: first-move grace (no debit while idle), Fischer debit+increment with guest clock
      acks, a real 15s flag delivered as `flag` (not resign) with the loser at 0, and the no-move
      abort path. All PASS.

## ⏳ Deferred (needs a decision or owner action)
- [x] **Mac Stockfish engine: upload to the release.** DONE 2026-07-06 (Fix A): uploaded
      `resources/engine/mac/stockfish` as `stockfish-sf18-mac-arm64` (sha256 matches the
      `ENGINE_ARTIFACTS` row; a stray asset literally named `stockfish` was deleted, an earlier
      upload that kept the raw filename and the importer never matched). Fresh Mac installs
      can now import the engine. The same pass published the whole games-platform engine set
      (Fairy-Stockfish 14, lc0 0.32.1, KataGo 1.16.5 + Go nets, Maia weights mirror) for BOTH
      platforms. See the asset table in docs/DATASETS.md.
- [ ] **chess.com 1:1 puzzle-rating rework.** Behavior-match their puzzle rating model. (The puzzle
      team flagged this as design-forked and left the Glicko-2 ladder intact; Rush deliberately
      doesn't move it.)
- [ ] **Proactive in-game Viktor coaching.** Viktor narrates at instructive moments during live play
      (the `narrate` path is built but not wired into a live game loop).

## 🔜 Next major system: decentralized accounts (spec locked 2026-07-14)
- [ ] **docs/ACCOUNTS-SPEC.md** is the binding spec: database-less accounts (entangled personal
      chains + witnesses + client-side deterministic anticheat + trust-width matchmaking).
      Build phases A1–A6 defined in §14; open parameters in §13. Supersedes the interim
      server-account system when complete. Also queued from the same design sessions: repertoire
      trainer (SRS opening drills), shareable game/profile links, one-click rematch everywhere,
      networking-resilience polish pass.

## 🔭 Post-A-final: P2P self-sufficiency ("Bitcoin-grade bootstrap", owner directive 2026-07-21)
- [ ] **Owner's goal, recorded verbatim in spirit:** the accounts/network substrate should stand on
      its own like Bitcoin does. No reliance on third-party rendezvous (Nostr relays, public
      TURN) beyond first contact, and the substrate should be product-agnostic enough to
      "translate to any platform or idea." NOT to be built now, only after the rest (A5, A6,
      A-final) is finished. The current Nostr/TURN + operator-peer bootstrap is accepted for the interim
      (spec C-11 already mandates replaceability).
- [ ] Sketch of the robust design (to be spec'd properly when picked up):
      1. **Peer address book**: persist known-good peers per device; on startup, redial them
         before touching any external rendezvous (Bitcoin's addrman pattern).
      2. **User-base-as-infrastructure**: the DESKTOP app can accept inbound connections
         (listening socket + UPnP/NAT-PMP attempt): any reachable user self-advertises as a
         beacon; beacons do signaling introductions AND peer-relay (TURN-equivalent) for
         NAT-stuck peers. The operator peer stops being special. It's just one more beacon.
      3. **Beacon seeds shipped in releases**: a signed, per-release list of long-lived community
         beacons baked into the binary (Bitcoin's DNS-seed pattern), so a fresh install can join
         with zero third-party services.
      4. **In-overlay introductions**: once connected to anyone, all further rendezvous rides the
         overlay itself (FabricEndpoint already abstracts transport for this).
      5. **Substrate extraction**: keep src/shared/accounts/** game-agnostic (it already is:
         segments carry a kind string; the judge is a pluggable verdict fn) so the identity/chain/
         witness/storage stack can be lifted into any future product.
- [ ] **Web port.** The renderer is already React/TS; the blockers are the Electron-only main process
      (node:sqlite DBs, local Stockfish, IPC). Path: replace IPC with a server/WASM backend, use
      Stockfish.wasm in-browser for the engine, and host a DB/API for puzzles/games. Notes in session.

## ✅ Done (for reference)
- **Internet multiplayer (2026-07-02):** play any two computers anywhere. One player hosts and gets a
  code like `A1B2C-D3E4F`, the other enters it and connects, across NATs/countries, with no user-run
  server and no port forwarding. Replaces the old same-LAN WebSocket transport entirely. Built on WebRTC
  data channels in the renderer (Chromium `RTCPeerConnection`), peer discovery via **trystero** (Nostr
  relays); the code is a random room key, not an IP. Host-authoritative clocks/turn-order,
  draw/resign/rematch, wire-level heartbeat, 30s discovery timeout. Harnesses: `scripts/test-mp.mjs`
  (pure-session assertions over an in-memory transport pair) and `scripts/check-relays.mjs` (relay/TURN
  reachability probe).
- Mac port (cross-platform, congruent codebase); analysis-loop freeze fixed.
- 40-chapter Chess School authored, soundness-audited (all pass), installed.
- Viktor coach; board-centric lesson UI; chapter tests.
- Placement game → internal-Elo estimate → name-based chapter unlock (Elo never shown), shipped.
- Old Lessons tab removed → School; Famous folded into Analysis; Analysis own-game-review fixed.
- **Puzzles trainer finished (DB v5):** 4 modes: Train (adaptive), Custom/Themed (pick themes+
  difficulty+length → focused set + accuracy-ring summary), Rush/Storm (rush3/rush5/storm/survival,
  prefetched queue + climbing band + lives/clock HUD, own high-score), Daily (deterministic daily +
  local streak + cross-mode stats + history). Rush doesn't move the Glicko ladder.
- **School ideas built (DB v6):** (1) test P1 polish: `recordTest` is now server-authoritative on
  pass/fail, fail-both resets the whole chapter (keeps best_pct), multi-ply "play the opening out"
  supported; (2) weakness-driven "recommended next chapter" (name-based, never Elo); (3) SM-2-lite
  spaced repetition of concepts (concept_srs + a "reviews due" drill); (4) daily lesson + local-day
  study streak. Surfaced via a Today card + Recommended-next card on the School home.
