# FEATURE ADDENDUM

> Integration spec for seven NEW capabilities layered onto the existing offline Electron chess
> analysis/teaching app (Stockfish analysis, eval bar, move classification, bundled Lichess
> puzzles, beginner→2000 curriculum, local no-LLM coaching engine, SQLite, polished UI).
>
> **Governing principles**
> 1. **One analysis engine, one human engine.** Stockfish 17.x (NNUE, CPU) does all strength work
>    (analysis + calibrated-Elo play). lc0 (CPU) + Maia-1 weights is the human-feel opponent.
>    Do not bundle a third engine in v0.
> 2. **Moves are free; words are not.** Raw moves/PGNs are uncopyrightable facts. Prose annotations
>    are copyrightable — ship only PD/CC0/CC-BY-SA, or engine-generate them.
> 3. **Engines are arms-length UCI subprocesses.** All engines (Stockfish/lc0, both GPL-3.0) run
>    via `child_process.spawn` over stdin/stdout, bundled with `electron-builder extraResources`,
>    resolved via `process.resourcesPath`. Ship each engine's source/offer-of-source + license text.
>    **Defer anything AGPL (Maia-3) to a later iteration.**
> 4. **Two distinct rating quantities, never conflated in UI:** a *move-quality performance rating*
>    (from analysis) and a *result-based Glicko-2 rating* (puzzles + vs-bot).

---

## 1. Play vs Engine at Any Level

**Technical approach.**
Reuse the already-bundled Stockfish for adjustable-strength play. Spawn a dedicated Stockfish
instance (separate from the analysis instance so a game and an analysis can run concurrently), set
`UCI_LimitStrength = true` and `UCI_Elo` in the calibrated range **1320–3190**. `Skill Level` (0–20)
is the legacy fallback; `UCI_Elo` overrides it. Stockfish's floor is **1320** — it cannot emulate a
true beginner, so the sub-1320 band is covered by Maia-1100 (capability #2) or, if Maia is not yet
present, extra randomization (MultiPV + weighted-random pick of a slightly inferior legal move).
Because nominal `UCI_Elo` is calibrated to CCRL 40/4 time controls, build an **in-app calibration
loop**: nudge the effective level based on the user's results rather than trusting the label blindly.

**Data/engines to bundle (+ license + size).**
- Stockfish 17.x NNUE, CPU build — **GPL-3.0** — already in the bundle (~40–75 MB incl. NNUE). **No
  new asset.**

**DB schema additions.** None unique to this item; games are persisted by capability #6 (`game`,
`game_move`). Store `opponent_type='engine'`, `opponent_engine='stockfish'`, `opponent_elo` on the
game row.

**UI surface.** "Play vs Computer" entry → setup panel with an Elo slider (1320–3190, plus a
"Beginner" notch that routes to Maia-1100/randomized), color pick, and time control. In-game:
existing board + eval bar (optionally hidden during play), resign/draw/takeback, post-game
"Review this game" CTA (capability #4).

**Placement: FOUNDATION (v0).** Pure config on an engine that already ships. Lowest cost, highest value.

---

## 2. Play vs Human-like / Top-Player STYLES & Openings

This is two sub-features: **(2a) human-like play** and **(2b) named-player style/repertoire**. They
have very different maturity.

### 2a. Human-like opponent (Maia-1 on lc0)

**Technical approach.**
Bundle the **lc0 CPU build** and the **Maia-1 weight files** (`maia-1100.pb.gz` … `maia-1900.pb.gz`,
100-Elo steps). Map the user's rating to the nearest Maia net; spawn `lc0 --weights=maia-1500.pb.gz`.
Run with a **small fixed search (`go nodes 8`)** rather than strict `go nodes 1` — this preserves the
human move distribution while cutting the worst un-human one-move piece blunders that strict policy-only
play produces (esp. maia-1900). **Rating-to-engine routing:** below ~1900 → Maia (most human);
1900–3190 → Stockfish `UCI_Elo`; below 1320 → Maia-1100.

**Data/engines to bundle (+ license + size).**
- lc0 CPU-only Windows build (`cpu-openblas` or `cpu-dnnl`) — **GPL-3.0-or-later** — ~23 MB. No GPU/CUDA.
- Maia-1 weights, all nine nets — **treat as GPL-3.0** (repo is GPL-3.0; weights license unstated —
  conservative reading) — a few MB each, **tens of MB total**. Confirm weights license with CSSLab
  before commercial release.

### 2b. Named top-player styles & openings

**Technical approach.**
**No open, redistributable net plays "as Magnus/Kasparov"** — CSSLab's `maia-individual` deliberately
withholds per-player models (privacy/stylometry) and needs a GPU to train. The honest, fully-offline,
license-clean design is **opening book + style-matched engine**:
1. **Build per-player Polyglot `.bin` books at package time** from that player's PGNs, split by color
   (White/Black repertoire) and weighted by frequency/score. Generate with an external CLI
   (`ddugovic/polyglot` `make-book -only-white/-only-black` + `merge-book`, or a tiny custom 16-byte-
   entry writer — python-chess can READ but not WRITE books). Validate the Zobrist hash matches the
   runtime reader against known signature openings.
2. **At runtime:** play the book for the opening, then hand off to Stockfish (capped Elo) or Maia
   (human feel) for the middlegame/endgame.
3. **Style lean (optional):** lc0's shipped **WDL-Contempt** system (`Contempt`, `ContemptMode`,
   `WDLCalibrationElo`, `WDLEvalObjectivity`, `DrawScore`) biases toward sharp/aggressive vs solid
   play. Stockfish has **no style knob** in the NNUE era (Contempt removed) — strength only.
4. **Frame honestly in UI:** "plays X's opening repertoire, then a strength/style-matched engine,"
   **never** "play AS X."

**Data/engines to bundle (+ license + size).**
- Per-player PGNs for book building — assemble from **Lichess CC0** dumps and/or pgnmentor per-player
  collections. **Bundle only the generated `.bin` books, not third-party PGN files verbatim**
  (pgnmentor grants no redistribution license; the *moves* are free facts, but ship books you built).
  Books are small (KB–low-MB each).
- Optional: **Gyal personality nets** (aggressive/solid/sacrificial archetypes) — **license
  unspecified → DO NOT bundle** until a clear open license is confirmed.
- **Do NOT** bundle `maia-individual` (AGPL, no models), ChessBase Mega (paid, copyrighted
  annotations), or Maia-2 (MIT but Python-library-only, no UCI).

**DB schema additions (covers 2a + 2b).**
```sql
-- A selectable opponent persona (human-like level, or a named-player book persona).
CREATE TABLE bot_persona (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,         -- "Maia 1500", "Kasparov (repertoire)"
  kind            TEXT NOT NULL,         -- 'maia' | 'stockfish' | 'book+engine'
  engine          TEXT NOT NULL,         -- 'lc0' | 'stockfish'
  weights_file    TEXT,                  -- e.g. 'maia-1500.pb.gz'
  nominal_elo     INTEGER,
  book_file       TEXT,                  -- polyglot .bin for 2b personas
  style_params    TEXT,                  -- JSON: lc0 contempt/WDL opts
  glicko_rating   REAL DEFAULT 1500,     -- fixed nominal rating used when this bot is an opponent
  enabled         INTEGER DEFAULT 1
);
CREATE TABLE opening_book (
  id          INTEGER PRIMARY KEY,
  player_name TEXT,
  color       TEXT,                      -- 'white' | 'black'
  bin_file    TEXT NOT NULL,
  game_count  INTEGER,                   -- shallow books (e.g. Morphy 211) flagged in UI
  source      TEXT,                      -- 'lichess-cc0' | 'self-built'
  license     TEXT
);
```

**UI surface.** "Play vs Computer" opponent gallery: a **Human-like** row (Maia avatars by rating,
labeled "plays like a ~1500 club player") and a **Style/Player** row (named personas with a clear
"plays X's openings, then a matched engine" caption and a game-count confidence note for sparse books).

**Placement.**
- **2a Maia human-like play → FOUNDATION (v0).** It is the headline differentiator and only adds ~25 MB.
- **2b named-player books → NEXT ITERATION.** Needs a per-player PGN→book build pipeline, validation,
  and careful framing; ship after the core loop is solid. (A single generic "aggressive vs solid"
  style toggle via lc0 WDL-Contempt can ride along in v0 if cheap, but per-player repertoires wait.)

---

## 3. Elo / Performance-Rating Estimation from the User's Play

**Technical approach (open, offline, fully specified).**
Implement the **open Lichess accuracy pipeline** with the already-bundled Stockfish at fixed depth
~16–20:
1. Stockfish eval before/after each user move → **win-percent** via the Lichess logistic
   `Win = 50 + 50·(2/(1+exp(−0.00368208·cp)) − 1)`, cp capped at ±1000.
2. **Per-move accuracy** `Acc = 103.1668·exp(−0.04354415·winDiff) − 3.1669`, clamped to [0,100],
   where `winDiff = winBefore − winAfter`.
3. **Game accuracy** = blend of volatility-weighted mean and harmonic mean over sliding windows.
   Move thresholds: inaccuracy 10 / mistake 20 / blunder 30 (win-% drop).
4. **Accuracy → per-game Elo**, piecewise-linear keyed to time control (rapid default
   `Elo ≈ (accuracy − 64)·100`, clamped 400–2800). **Re-fit slope/intercept yourself** on a sampled
   Lichess CC0 set so the constants match *your* Stockfish depth, then freeze them.
5. **Aggregate** per-game estimates via **inverse-variance shrinkage** toward a Bayesian prior
   (e.g. 1200, low confidence), weighting each game by its count of non-trivial decisions (drop
   opening plies 1–8 and trivial recaptures). **Always report a range, never a single number.**
6. **Second independent estimator (NEXT):** Maia move-match — run several Maia nets, take the
   interpolated argmax move-match level, combine with the accuracy estimate by inverse-variance
   weighting. Add a cheap Regan-style complexity correction by weighting cp-loss with the win-%
   delta (already S-curve-scaled) and excluding positions with |eval| > ~3.00.

Single-game ACPL/accuracy explains only ~5–7% of rating variance — useful only after aggregating many
games, and only as a band.

**Data/engines to bundle.** None new for the accuracy estimator (Stockfish already present). Maia nets
(from #2a) are reused for the optional move-match estimator. Optionally pre-attach evals from the
**Lichess CC0 evaluations dataset** during calibration only (not shipped at runtime).

**DB schema additions.**
```sql
CREATE TABLE perf_estimate (
  id              INTEGER PRIMARY KEY,
  game_id         INTEGER REFERENCES game(id),  -- NULL = rolled-up estimate
  method          TEXT,        -- 'accuracy' | 'maia-match' | 'combined'
  est_elo         REAL,
  est_low         REAL,        -- band edges
  est_high        REAL,
  analyzed_moves  INTEGER,
  accuracy        REAL,
  created_at      INTEGER
);
```

**UI surface.** On each reviewed game: "Estimated strength this game: ~1450 (1300–1600)". A profile
"Estimated Playing Strength" panel showing the aggregated band narrowing over time, explicitly
labeled as *move-quality* strength (distinct from the vs-bot Glicko rating of #6/#7).

**Placement.**
- **Accuracy-based per-game + aggregated estimate → FOUNDATION (v0).** It rides directly on the game
  review that v0 already needs, and the formulas are fully open.
- **Maia move-match estimator + Regan correction → NEXT ITERATION.**

---

## 4. Full Game Review (Accuracy, Blunders, Brilliants)

**Technical approach.**
Run the bundled Stockfish over the full game at fixed depth/nodes, reusing the existing move-
classification + local coaching engine. For each ply compute eval-before/after, win-% delta, and the
Lichess accuracy number (shared with #3). Classify via win-% drop thresholds (inaccuracy/mistake/
blunder). **Brilliancy** = a move that is best-or-near-best AND involves a sound sacrifice / sharp tactic
(detect via the existing motif layer: sacrifice-for-mate, fork/pin/skewer, only-move). **Critically,
tune the coach to recognize sound sacrifices** so romantic-era / deliberate sacs are praised, not
mislabeled "blunder." Emit a per-game accuracy %, an ACPL, classified move list, and an idea-level
explanation per critical move from the local no-LLM coaching engine. Cache results in the DB so review
is instant on re-open.

**Data/engines to bundle.** None new (Stockfish + existing coaching/motif layer).

**DB schema additions.**
```sql
CREATE TABLE game_review (
  game_id        INTEGER PRIMARY KEY REFERENCES game(id),
  accuracy_white REAL, accuracy_black REAL,
  acpl_white     INTEGER, acpl_black INTEGER,
  engine         TEXT, depth INTEGER,
  reviewed_at    INTEGER
);
CREATE TABLE move_eval (
  id          INTEGER PRIMARY KEY,
  game_id     INTEGER REFERENCES game(id),
  ply         INTEGER,
  eval_cp     INTEGER,
  best_move   TEXT,
  played_move TEXT,
  win_pct     REAL,
  accuracy    REAL,
  class       TEXT,      -- best|good|inaccuracy|mistake|blunder|brilliant|book
  motif       TEXT,      -- fork|pin|sac|... from coach
  comment     TEXT       -- local coach idea-explanation
);
```

**UI surface.** Post-game "Game Review" screen mirroring chess.com/Lichess: accuracy bars per side,
move-class counts (with brilliant/blunder icons), an annotated move list, eval graph, per-move coach
text, and a "play out from here vs engine" option. Surfaces the #3 strength band.

**Placement: FOUNDATION (v0).** It is the payoff of the analysis engine and feeds #3 and #6. Core.

---

## 5. Famous-Games Library with Idea Explanations

**Technical approach.**
Cleanly separate the **moves layer** (always free) from the **annotation layer** (license-gated):
- **Moves:** bundle ~100 curated famous games (Opera Game, Immortal, Evergreen, Game of the Century,
  Kasparov–Topalov 1999, etc.) assembled from **public-domain facts / Lichess CC0**, with your own
  headers. Pick one authoritative move list per game and **validate legality at build time** via
  chess.js (some 19th-c. games have disputed move orders).
- **Primary annotations (do first):** **engine-generated at build time** — run Stockfish + the local
  coaching/motif layer over every game, emit best-move/blunder/brilliancy tags + idea explanations,
  cache as shipped JSON. **Zero licensing risk, uniform coverage.** Tune so famous sacrifices read as
  brilliant, not as "−0.7 blunder."
- **Secondary annotations (marquee ~40 games):** bundle **Wikipedia CC BY-SA 4.0** prose — requires
  attribution + share-alike, so **keep CC BY-SA content partitioned** with a per-annotation source/
  license field and an auto-generated **in-app credits screen**. Optionally add **Project Gutenberg
  PD** book prose (Lasker, Capablanca, *Morphy's Games of Chess*) — zero obligations but OCR +
  descriptive→SAN conversion effort. **Self-authored Lichess Studies** (your license) are a clean
  owned pipeline.
- **Do NOT bundle:** pgnmentor files verbatim (no redistribution grant), ChessBase Mega annotations
  (copyrighted), or Lichess **broadcast** games (CC BY-SA, not CC0). For very recent games rely on
  the uncopyrightable-moves principle + your own engine annotations.

**Data/engines to bundle (+ license + size).**
- ~100-game curated PGN (moves) — **PD / CC0** — small (low single-digit MB).
- Engine-generated annotation JSON — **your content, no third-party license** — small.
- Wikipedia prose for ~40 games — **CC BY-SA 4.0** (attribution + share-alike) — small.
- Stockfish — already bundled (build-time only here).

**DB schema additions.**
```sql
CREATE TABLE famous_game (
  id      INTEGER PRIMARY KEY,
  players TEXT, event TEXT, year INTEGER, eco TEXT, result TEXT,
  theme   TEXT,                 -- 'Romantic sac','Fischer',...
  pgn_moves TEXT NOT NULL
);
CREATE TABLE game_annotation (
  id        INTEGER PRIMARY KEY,
  game_id   INTEGER REFERENCES famous_game(id),
  ply       INTEGER,
  type      TEXT,               -- 'engine' | 'human'
  source    TEXT,               -- URL / 'self'
  license   TEXT,               -- 'PD' | 'CC0' | 'CC-BY-SA-4.0'
  text      TEXT
);
```

**UI surface.** "Famous Games" browser grouped by era/theme; game viewer = existing board + eval bar +
annotation panel showing engine commentary, with human prose where present and a license badge.
Credits screen lists all CC BY-SA sources.

**Placement.**
- **Library + engine-generated annotations → FOUNDATION (v0)** (small, high-teaching-value, reuses
  build-time Stockfish).
- **Curated human (Wikipedia/Gutenberg) prose + credits screen → NEXT ITERATION** (license partitioning
  + OCR/attribution work).

---

## 6. Saved Game History + Progress Tracking

**Technical approach.**
Persist every played and imported game (moves, headers, result, opponent, time control) in SQLite,
linked to review (#4) and performance estimates (#3). Progress tracking = time-series rollups over
games/reviews/puzzles/lessons: accuracy trend, estimated-strength band over time, blunder rate,
curriculum completion, puzzle rating. Support PGN import/export (chess.js / `@mliebelt/pgn-parser`).

**Data/engines to bundle.** None.

**DB schema additions.**
```sql
CREATE TABLE game (
  id            INTEGER PRIMARY KEY,
  pgn           TEXT NOT NULL,
  white         TEXT, black TEXT, result TEXT,
  opponent_type TEXT,           -- 'engine'|'maia'|'bot_persona'|'human-import'
  opponent_ref  INTEGER,        -- -> bot_persona.id when applicable
  opponent_elo  INTEGER,
  time_control  TEXT,
  user_color    TEXT,
  played_at     INTEGER,
  source        TEXT            -- 'play'|'import'
);
CREATE TABLE game_move (
  game_id INTEGER REFERENCES game(id), ply INTEGER, san TEXT, fen TEXT, clock_ms INTEGER,
  PRIMARY KEY (game_id, ply)
);
CREATE TABLE progress_snapshot (
  id INTEGER PRIMARY KEY, taken_at INTEGER,
  est_strength REAL, est_low REAL, est_high REAL,
  avg_accuracy REAL, blunder_rate REAL,
  puzzle_rating REAL, games_played INTEGER,
  curriculum_pct REAL
);
```

**UI surface.** "My Games" list (filter/search, accuracy + result columns, open → review). "Progress"
dashboard: strength-band chart, accuracy/blunder trends, puzzle rating, curriculum %. Profile header
summarizing both rating quantities (clearly labeled).

**Placement: FOUNDATION (v0).** It is the persistence backbone every other feature writes into; the
curriculum and puzzles already imply storage. Ship the `game`/`game_move`/`progress_snapshot` core in
v0; richer trend visualizations can grow in NEXT.

---

## 7. Puzzle Score / Local Rating

**Technical approach.**
Implement **Glicko-2** (official Glickman spec, numerically verified: 1464.06 / RD 151.52 / σ 0.06000)
as a small dependency-free local module. Each **puzzle is an opponent** rated at its difficulty;
solve = 1, fail = 0; update **per puzzle (rating period 1)** as Lichess does. Defaults: rating 1500,
RD 350, σ 0.06; **τ ≈ 0.2–0.4 for puzzles** (lower than play, to tame per-puzzle volatility) with an
**RD floor**. Grow RD during inactivity via `φ' = √(φ² + σ²)`. Display strength as **rating ± 2·RD**.
The same module serves **vs-bot Glicko** (#1/#2): opponent = the bot's fixed `glicko_rating`, τ ≈ 0.5.
**Keep the puzzle/vs-bot Glicko rating clearly distinct from the move-quality performance estimate
(#3)** in all UI.

**Data/engines to bundle.** None (formulas are bundled code). Puzzles already ship (Lichess CC0).

**DB schema additions.**
```sql
CREATE TABLE rating (
  id        INTEGER PRIMARY KEY,
  kind      TEXT NOT NULL,        -- 'puzzle' | 'vs-bot'
  rating    REAL DEFAULT 1500,
  rd        REAL DEFAULT 350,
  sigma     REAL DEFAULT 0.06,
  updated_at INTEGER
);
CREATE TABLE puzzle_attempt (
  id         INTEGER PRIMARY KEY,
  puzzle_id  TEXT NOT NULL,
  puzzle_elo INTEGER NOT NULL,
  solved     INTEGER NOT NULL,    -- 1|0
  ms         INTEGER,
  rating_after REAL, rd_after REAL,
  attempted_at INTEGER
);
```

**UI surface.** Puzzle screen shows current puzzle rating ± band and per-attempt delta; a small
"Puzzle Rating" history sparkline. Rating feeds the #6 progress dashboard.

**Placement: FOUNDATION (v0).** Bundled puzzles without a rating are inert; Glicko-2 is ~100 lines and
fully specified. The shared module also unlocks vs-bot ratings for #1/#2 at no extra cost.

---

## Engine & Bundle Summary

| Component | Role | License | Size | v0? |
|---|---|---|---|---|
| Stockfish 17.x NNUE (CPU) | Analysis, review, level-capped play, build-time annotation | GPL-3.0 | ~40–75 MB | Yes (exists) |
| lc0 CPU build | Body for Maia human play | GPL-3.0-or-later | ~23 MB | Yes |
| Maia-1 weights (1100–1900) | Human-like opponent + (later) move-match estimator | Treat as GPL-3.0 (unstated) | tens of MB | Yes |
| Per-player Polyglot books | Named-player repertoires | Self-built from CC0/PD facts | small | Next |
| Gyal nets | Style archetypes | Unspecified — verify | small | Hold |
| Maia-3 (5M) native UCI | Higher-fidelity human play, Elo/SelfElo/OppoElo | **AGPL-3.0** | 150–300+ MB (PyTorch) | Next (flagged) |
| Famous-games PGN (moves) | Library | PD / CC0 | low MB | Yes |
| Wikipedia/Gutenberg prose | Human annotations | CC BY-SA 4.0 / PD | small | Next |

**Cross-cutting risks to honor before commercial release:** GPL/AGPL source-availability obligations
(ship engine sources + license texts; AGPL = defer until truly needed and never in a hosted mode);
confirm Maia weights license with CSSLab; re-calibrate all accuracy→Elo constants to your Stockfish
depth; validate Polyglot Zobrist hashing and famous-game move legality at build time; tune the coach so
sound sacrifices are not flagged as blunders; never present a single over-precise Elo number.

---

## ADD TO FOUNDATION (v0)

1. **Play vs engine at any level** — Stockfish `UCI_LimitStrength`/`UCI_Elo` 1320–3190 (no new asset).
2. **Saved game history + core progress tracking** — `game`/`game_move`/`progress_snapshot`; the
   persistence backbone everything writes into.
3. **Full game review** — accuracy %, blunder/mistake/brilliant classification, local coach idea
   explanations, cached evals.
4. **Accuracy-based Elo/performance estimation** — open Lichess pipeline, aggregated, shown as a band.
5. **Puzzle local rating (Glicko-2)** — per-puzzle updates; shared module also powers vs-bot ratings.
6. **Human-like opponent (Maia-1 on lc0 CPU)** — `go nodes 8`, rating-to-engine routing; +~25 MB.
7. **Famous-games library with engine-generated idea explanations** — ~100 PD/CC0 games, build-time
   Stockfish commentary.

## ADD TO NEXT ITERATION

1. **Named top-player styles & openings** — per-player Polyglot books (built at package time) + style-
   matched engine, with optional lc0 WDL-Contempt aggression lever and honest "plays X's repertoire" framing.
2. **Maia move-match Elo estimator + Regan-style complexity correction** — second independent strength estimator.
3. **Curated human annotations for famous games** — Wikipedia CC BY-SA + Gutenberg PD prose, partitioned,
   with an in-app attribution/credits screen.
4. **Maia-3 (5M) native-UCI human engine (behind a feature flag)** — higher fidelity + Elo/SelfElo/OppoElo,
   pending AGPL-3.0 review and heavier PyTorch packaging.
5. **Richer progress dashboards** — long-horizon trend charts and curriculum analytics atop the v0 snapshots.
