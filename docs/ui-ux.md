# UI/UX SPEC

> Implementable UI/UX specification for the Offline Chess Trainer — a fully offline, local-first
> chess analysis & teaching desktop app (Electron + React + TypeScript + Vite). Targets a
> chess.com / lichess-grade feel using only open, redistributable assets.
>
> **Scope.** This document defines the screen map, the full component inventory, the complete
> Analysis Board layout, the interaction model, the design-token set, the icon pack + mapping, the
> piece/board/sound theming model, and the animation/micro-interaction catalog. It is the visual
> and interaction contract that the renderer (`src/renderer`) implements against the IPC surface
> from the main process.
>
> **Governing constraints (from `docs/STATUS.md` and `docs/feature-addendum.md`):**
> 1. **NO emojis in the product UI.** Sparing use is allowed only inside coaching / interaction
>    prose, never in chrome, labels, buttons, or navigation.
> 2. **Open assets only.** Board = `chessground` (GPL-3.0). Pieces default `cburnett` (GPLv2+).
>    Icons = **Lucide** (MIT). Font = **Inter** (OFL). No chess.com proprietary assets, names
>    ("Brilliant/Great/Miss" branding), or artwork. Use generic open labels with open hex values.
> 3. **Two rating quantities are never conflated.** A *move-quality performance rating* (from
>    analysis, shown as a band) and a *result-based Glicko-2 rating* (puzzles + vs-bot). The UI
>    must always label which is which.
> 4. **Engines run in the main process** over UCI; the renderer only sees IPC results. No engine,
>    `fs`, or `child_process` access from the renderer.
>
> **Companion specs:** `docs/architecture.md` (process/IPC/packaging), `docs/content-coaching.md`
> (coach text, curriculum, classification math). Where this spec references a formula or DB table,
> the authoritative definition lives in those documents and in `docs/feature-addendum.md`.

---

## 0. Design Principles

1. **Board-first.** The board is the hero on every chess-bearing screen. Everything else is a
   sidebar or an overlay. The board never reflows mid-interaction.
2. **One source of visual truth.** Every color, space, radius, shadow, and font size is a design
   token (CSS custom property). No hard-coded hex or px in component CSS except inside the token
   layer.
3. **Calm chrome, expressive data.** Neutral surfaces and text; saturated color is reserved for
   evals, classifications, and the accent. The eval bar and classification badges are the only
   places strong color appears at rest.
4. **Reveal depth on demand.** A beginner sees a board, a move list, and a hint. An advanced user
   can open engine lines, NAG editing, variation trees, and performance bands. Progressive
   disclosure, not separate apps.
5. **Keyboard-complete.** Every analysis/navigation action has a shortcut mirroring lichess so
   muscle memory transfers. Mouse and keyboard are equal-class citizens.
6. **Deterministic & offline.** No spinners that imply network. "Analyzing…" always means local
   Stockfish. Latency is engine depth, not I/O.
7. **Accessible by default.** WCAG AA contrast for text and UI; never rely on color alone —
   classification badges pair color + icon + letter/word; legal-move dots have a shape, not just a
   tint.

---

## 1. Screen Map

Top-level navigation is a persistent **left rail** (icon + label) on desktop widths, collapsing to
an icon-only rail below 1100 px. Seven primary destinations, plus secondary screens reachable from
within them.

```
App Shell
├─ Home / Dashboard            [home]        landing; resume, daily, progress glance
├─ Play                        [swords]      vs Engine / vs Human-like (Maia) / vs Style+Book
│   ├─ Play Setup (opponent gallery, color, time, level)
│   └─ Game Screen (live board + clocks + controls)
├─ Analysis Board              [cpu]         the analysis workbench (full spec §4)
│   └─ Game Review (post-game; accuracy, classifications, eval graph)
├─ Puzzles / Trainer           [puzzle]      rated puzzles, themed sets, SRS review queue
│   └─ Puzzle Result / Streak
├─ Lessons                     [graduation]  curriculum 0→2000; lesson player; famous games
│   ├─ Lesson Player (interactive board lesson)
│   └─ Famous Games library + viewer
├─ Progress / Profile          [user]        ratings (both kinds), trends, my games, achievements
│   └─ My Games (list → opens Game Review)
└─ Settings                    [settings]    appearance, board/piece/sound themes, engine, data, about
    └─ Credits / Licenses
```

### 1.1 Home / Dashboard

Purpose: orient and resume in one glance. No data fetch beyond local DB.

Layout: a responsive card grid (12-col, 8 px gutter).

- **Resume card** (span 6): last position / last game thumbnail (mini static board), "Continue
  analysis" or "Resume game" CTA.
- **Daily puzzle card** (span 3): mini board, "Solve" CTA, current puzzle rating ± band.
- **Continue learning card** (span 3): next lesson in the active curriculum band, progress ring.
- **Strength snapshot** (span 6): dual readout — *Estimated playing strength* band (move-quality)
  and *Puzzle rating* ± band (Glicko-2), clearly separated with a one-line caption each.
- **Recent games strip** (span 6): horizontal scroller of last 5 games (result chip, accuracy %,
  opponent), each → Game Review.
- **Quick actions row** (span 12): `Play`, `Analyze a position / paste FEN/PGN`, `Train`, `Learn`.

### 1.2 Play

Two states: **Setup** and **Game**.

- **Setup (opponent gallery).** Tabbed or sectioned rows (per addendum §1/§2):
  - **Engine row** — a single configurable opponent: Elo slider 1320–3190, plus a "Beginner" notch
    that routes to Maia-1100 / randomized sub-1320. Color picker (white / random / black). Time
    control chips (Unlimited, 30+0, 10+0, 5+3, 3+2, 1+0; "Correspondence/Untimed" default for a
    teaching app). "Show eval bar during play" toggle (default off).
  - **Human-like row** — Maia avatars by rating (1100…1900 in 100 steps), captioned "plays like a
    ~1500 club player," not "plays as." (Maia is FOUNDATION.)
  - **Style / Player row** — named personas (NEXT iteration): persona card with caption "plays X's
    openings, then a matched engine," plus a game-count confidence note for sparse books.
  - Primary CTA: **Start game**.
- **Game.** Live board (hero) + clock(s) + captured-material tray + controls. Sidebar holds the
  move list (read-only during play unless takeback) and, post-game, a "Review this game" CTA that
  hands off to Game Review (§4.10). Eval bar hidden by default, toggleable.

### 1.3 Analysis Board

The workbench. Full layout in §4. Reached from Home, from "Analyze" quick actions, from any game's
"Open in analysis," and from a pasted FEN/PGN.

### 1.4 Puzzles / Trainer

- **Trainer home:** current puzzle rating ± band sparkline; mode chips — **Rated** (random near
  rating), **Themes** (theme picker grid using Lucide motif icons), **Review** (SRS due queue from
  FSRS-6), **Daily**.
- **Puzzle screen:** board (hero) + side panel with: prompt ("White to move," "Find the fork"),
  hint button (progressive: highlight piece → show arrow → show move), rating delta on solve/fail,
  streak counter, "Next" and "Retry," and a post-solve mini-explanation from the local coach.
- **Result/Streak overlay:** solved/failed state, rating change with animated band, "Continue" CTA.

### 1.5 Lessons

- **Curriculum map:** five bands (0–600, 600–1000, 1000–1400, 1400–1800, 1800–2000) as a vertical
  track of unlockable nodes; the active node is highlighted; gating driven by the user's strength
  estimate. Each node shows a progress ring and a Lucide motif/topic icon.
- **Lesson player:** interactive board + instruction panel (step text, "your move" prompts,
  success/retry feedback using the open praise vocabulary), prev/next step, "show solution."
- **Famous Games:** browsable library grouped by era/theme (cards: players, year, ECO, result,
  theme tag). Viewer = board + eval bar + annotation panel (engine commentary always; human prose
  where present, with a license badge).

### 1.6 Progress / Profile

- **Profile header:** dual rating summary — *Estimated playing strength* band and *Puzzle / vs-bot
  Glicko* rating ± band — each captioned, never merged into one number.
- **Trends:** strength-band-over-time chart (band narrows as confidence grows), accuracy trend,
  blunder-rate trend, puzzle-rating sparkline, curriculum completion %.
- **My Games:** filterable/searchable table (date, opponent, result, accuracy, est. strength),
  row → Game Review. PGN import/export controls.
- **Achievements (light):** streaks, lessons completed, motifs mastered. No gamified pressure.

### 1.7 Settings

Sectioned single-scroll page with a sticky section nav:

- **Appearance:** theme (System / Light / Dark), accent (fixed default; optional alternates).
- **Board & Pieces:** board theme picker, piece set picker, coordinates (off/inside/outside),
  ranks position (right/left), animation speed, show legal-move dots, show last-move highlight,
  show check highlight, highlight on hover.
- **Sound:** sound theme picker, master volume, per-event toggles (move, capture, check, low-time,
  game-end, notify), mute.
- **Engine:** analysis Threads, Hash (MB), MultiPV (1–5), default depth/movetime budget, "use full
  strength for analysis" lock, show WDL.
- **Gameplay:** default time control, default opponent, confirm resign/takeback, premove on/off,
  auto-promote-to-queen vs always-ask.
- **Data:** data location (read-only display), puzzle DB version + count, "re-download data,"
  export/import user data, clear caches.
- **About / Credits:** version, engine version + GPL source pointer, full asset license list
  (auto-generated), links (offline-safe, open in default browser only on explicit click).

---

## 2. App Shell & Cross-Screen Components

### 2.1 Shell

- **TitleBar** (custom, frameless): app name (left), centered context title (current screen), window
  controls (right). Drag region excludes interactive zones. Height `--space-9` (40 px).
- **LeftRail (primary nav):** 7 destinations, each `NavItem` = Lucide icon + label, active state =
  accent-soft background + accent left-marker (3 px) + accent icon. Collapses to icon-only < 1100 px
  with tooltips. Footer slot: theme quick-toggle, Settings.
- **ContentArea:** routed screen; max content width 1440 px, centered, with responsive side gutters.
- **GlobalToast / Snackbar:** bottom-center, for non-blocking confirmations ("PGN copied," "Analysis
  cached"). Auto-dismiss 4 s.
- **CommandPalette (optional, NEXT):** `Ctrl/Cmd+K` fuzzy actions/navigation.

### 2.2 Reusable primitives (the component inventory baseline)

| Component | Notes |
|---|---|
| `Button` | variants: primary, secondary, ghost, danger, icon-only; sizes sm/md/lg; loading + disabled states |
| `IconButton` | square, tooltip-required, used heavily in control bars |
| `ToggleButton` / `SegmentedControl` | board flip-state, figurine/letter toggle, mode chips |
| `Slider` | Elo, volume, engine knobs; shows live value bubble; keyboard ±, Shift=±10 |
| `Select` / `Dropdown` | theme pickers, time control |
| `Tabs` | within Play setup, Settings sections, analysis side panels |
| `Card` | dashboard tiles, opponent personas, lesson nodes, game rows |
| `Badge` / `Chip` | result chips, license badges, classification badges (special, §4.7) |
| `Tooltip` | required on every icon-only control; 300 ms delay; keyboard-focus triggers it |
| `Modal` / `Dialog` | promotion (board overlay), confirm resign, paste FEN/PGN, credits |
| `Sparkline` / `MiniChart` | ratings history, dashboard glances |
| `ProgressRing` / `ProgressBar` | lesson progress, analysis-of-game progress |
| `RatingBand` | the dual-rating readout primitive; renders `value ± band` with a caption + kind tag |
| `MiniBoard` | static, non-interactive FEN thumbnail (resume card, game rows, puzzle previews) |
| `EmptyState` | "No games yet," "No puzzles due," with a single CTA |
| `Skeleton` | for DB-bound lists (instant in practice; shown only if > 120 ms) |

---

## 3. The Board Component (`<ChessBoard/>`)

A thin React wrapper (~40 lines) around **chessground** (GPL-3.0), the actual lichess board. The
wrapper owns a `useRef` container, calls `Chessground(el, config)` in `useEffect`, pushes prop
changes via `cg.set(...)`, draws shapes via `cg.setShapes(...)`, and `cg.destroy()` on unmount. No
community wrapper (those are stale/GPL/React≤18); we own ~40 lines instead.

- **Rendering:** chessground DOM is `.cg-wrap > cg-container > cg-board`; pieces are absolutely
  positioned `.piece` elements styled purely by CSS background-image. **Swapping a piece set or
  board theme = swapping one CSS wrapper class** (§7).
- **Legality:** chessground has no chess logic. We feed `movable.dests` (a `Map<from, to[]>`) from
  **chessops** (GPL-3.0, lichess-grade, full PGN tree/NAG/EPD) computed each ply. chessops is the
  rules/SAN/FEN/PGN/EPD engine across the app; `chess.js` only as a fallback path.
- **Sizing:** board edge = `min(available)` snapped to a multiple of 8 px so squares are integer
  pixels. `cg-wrap` fills its grid cell; the board never reflows during a move.
- **Config surface used:** `orientation`, `fen`, `turnColor`, `check`, `lastMove`, `selected`,
  `coordinates`, `ranksPosition`, `highlight{lastMove,check}`, `animation{enabled,duration}`,
  `movable{free:false,color,dests,events.after}`, `premovable`, `draggable{enabled,showGhost,
  distance}`, `selectable`, `drawable{enabled,shapes,brushes}`, `viewOnly`.

---

## 4. ANALYSIS BOARD — Full Layout

The flagship screen. Three columns at the desktop default (≥ 1280 px):

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  TitleBar: "Analysis"                                                           │
├──────┬───────────────────────────────────────┬────────────────────────────────┤
│      │                                        │  ENGINE LINES PANEL  (top-N)   │
│ EVAL │                                        │  ─ line 1: +0.42 d28  e4 e5 …  │
│ BAR  │              BOARD (hero)              │  ─ line 2: +0.10 d28  Nf3 …    │
│  ▓   │          chessground render            │  ─ line 3: −0.05 d27  c4 …     │
│  ▓   │                                        │────────────────────────────────│
│  ▓   │                                        │  MOVE LIST  (variation tree)   │
│  ░   │                                        │  1. e4 e5  2. Nf3! Nc6  …       │
│  ░   │                                        │     (2… d6 3. d4 …)             │
│  ░   │                                        │                                │
│      │                                        │────────────────────────────────│
│      │  COORD / TURN STRIP                     │  CONTROLS BAR                  │
├──────┴───────────────────────────────────────┴────────────────────────────────┤
│  REVIEW STRIP (when in review mode): accuracy bars · classification counts ·   │
│  EVAL GRAPH (clickable, scrubs the move list)                                  │
└───────────────────────────────────────────────────────────────────────────────┘
```

Below 1280 px the engine-lines + move-list + controls stack into a single right column; below
1024 px the right column moves **under** the board (board stays full width). The eval bar always
hugs the board's left edge and flips with orientation.

### 4.1 Eval Bar (`<EvalBar/>`)

- **Width** `--space-5` (16 px); full board height; sits flush to the board's outer (orientation)
  edge. Flips with the board: bottom of the bar always corresponds to the side at the bottom.
- **Mapping (authoritative).** Do **not** map raw centipawns linearly. Convert cp → Win% via the
  lichess logistic:
  `Win% = 50 + 50·(2/(1 + exp(−0.00368208·cp)) − 1)`, with cp clamped to `[−1000, 1000]`.
  White-fill fraction = `Win%/100`. For mate: `cp = sign·(21 − min(10,|mate|))·100` then through the
  same curve (forced mate ≈ full bar, finite).
- **Visuals:** white-advantage fill = `--eval-white`, black-advantage fill = `--eval-black`; a thin
  midpoint tick at 50% = `--eval-mid`. Signed eval text (`+1.2`, `−0.8`, `M3`) is pinned at the
  advantaged side's inner edge, using the opposite fill's text color for contrast; tabular figures
  (Inter `tnum`). Fill height animates ~200 ms ease-out.
- **States:** `idle` (last committed eval), `thinking` (subtle shimmer at the fill boundary while
  depth climbs), `mate` (success-green accent flash on the bar edge).

### 4.2 Board (`<ChessBoard/>` in analysis mode)

As §3, with: legal-move dots on, last-move + check highlight on, drawable on (arrows/circles),
premove off (analysis), figurine/letter toggle does not affect the board. Promotion handled by the
overlay picker (§5.6).

### 4.3 Move List (`<MoveList/>`)

A recursive variation-tree renderer over the chessops PGN node tree. This is the second-densest
component after the board.

- **Mainline:** move number once per White move, then SAN tokens. Current node highlighted
  (`--accent-soft` background, accent text). Click any token → board jumps to that node.
- **Figurine ⇄ letter toggle** (`SegmentedControl` in the move-list header):
  - *Letter* mode: `Nf3`, `Qxd5` (ASCII SAN).
  - *Figurine* mode: piece letter replaced by the Unicode chess glyph (♞f3, ♛xd5) rendered in the
    figurine font; pawns show no glyph. Toggle is purely presentational and instant; it persists in
    settings. Default = letter (clearer for beginners).
- **NAG glyphs:** rendered inline immediately after SAN, in a colored superscript matching the
  classification palette where applicable:
  `$1 !` good, `$2 ?` mistake, `$3 ‼ (!!)` brilliant, `$4 ?? ` blunder, `$5 !?` interesting,
  `$6 ?!` dubious. Position NAGs ($10 =, $13 ∞, $14/15 ⩲/⩱, $16/17 ±/∓, $18/19 +−/−+) render as a
  small eval-glyph after the move when present. Glyphs are stored on move nodes (`move_eval.motif` /
  PGN NAGs), not recomputed at render.
- **Variations:** nested, parenthesized, indented one level per depth, dimmed (`--text-secondary`),
  with a collapse caret. Main line is weight 500; variations 400.
- **Move context menu** (right-click a move): Promote variation to mainline, Delete from here,
  Add/replace glyph (! ? !! ?? !? ?!), Add comment, Copy FEN, Copy PGN-from-here.
- **Comments:** rendered as a muted inline block under the move; coach-generated text is tagged with
  a small Lucide `brain` icon; user comments are plain.
- **Auto-scroll:** active node always scrolled into view (centered when possible).
- **Inline classification badge:** in review mode, each played move shows its classification badge
  (§4.7) immediately left of the SAN.

### 4.4 Engine Lines Panel (`<EnginePanel/>` + N × `<EngineLine/>`)

- **Header:** engine on/off toggle (Lucide `cpu`), depth readout (`d28`), nps, MultiPV stepper
  (1–5; default 3 for analysis, 1 elsewhere), "+ line into tree" affordance, and a small "go
  infinite / fixed depth" mode control.
- **Each `<EngineLine>`** (one per MultiPV index, stable rows updated by depth):
  - **Eval** (left, tabular, colored by sign): `+0.42` or `M5`. cp → signed pawns; mate → `M#`.
  - **Depth** chip: `d28`.
  - **PV** as clickable SAN tokens (figurine/letter follows the global toggle). Hovering a token
    previews that line on the board via `cg.setShapes` (a faint arrow for the next move) and a
    ghosted step-through, **without committing**. Clicking a token steps the board into the line as
    a temporary variation; "add to tree" commits it.
  - **WDL** (optional, when `UCI_ShowWDL` on): a thin three-segment bar (win/draw/loss per-mille).
- **Streaming/parse contract:** main process parses `info depth/seldepth/multipv/score cp|mate/
  nodes/nps/time/pv` lines and emits the latest complete set per depth over IPC; the panel renders N
  stable rows that update in place. `score` is side-to-move POV → the renderer negates to a
  White-centric absolute for display consistency, and shows the sign from the side-to-move where
  contextually clearer (eval bar always White-centric).
- **Out-of-order / lowerbound/upperbound** lines are buffered per multipv index and only the latest
  stable line per index is shown.

### 4.5 Controls Bar (`<ControlsBar/>`)

A single row of `IconButton`s under the move list (Lucide icons, tooltips required):

`flip-vertical-2` (flip board, `f`) · `chevrons-left` (first, `↑`/`0`) · `chevron-left`
(prev, `←`/`j`) · `chevron-right` (next, `→`/`k`) · `chevrons-right` (last, `↓`/`$`) ·
`play`/`pause` (autoplay through line) · `rotate-ccw` (retry / reset to start position) ·
`lightbulb` (hint, in trainer/lesson contexts) · `settings` (analysis settings popover).

Secondary actions live in an overflow `…`: copy FEN, copy PGN, paste FEN/PGN, load game, export,
"play out vs engine from here."

### 4.6 Accuracy + Eval Graph (review mode) (`<ReviewStrip/>`)

Shown only after a Game Review (§4.10) is computed; collapsed otherwise.

- **Accuracy summary:** per-side accuracy % as horizontal bars (White / Black), each with the value
  in tabular figures; ACPL shown as a secondary stat. Accuracy uses the lichess per-move formula
  `Acc = 103.1668·exp(−0.04354415·winDiff) − 3.1669` (clamped 0–100) and the game-accuracy blend
  (volatility-weighted mean + harmonic mean), per `docs/content-coaching.md`.
- **Classification counts:** a compact legend/tally row — count per class with its badge (§4.7):
  Best, Good, Book, Inaccuracy, Mistake, Blunder, Brilliant. Clicking a class filters the move list
  to those moves.
- **Eval Graph (`<EvalGraph/>`):** hand-rolled SVG area chart (no chart lib, for pixel control of
  the advantage fill). X = plies, Y = Win% (0–100, White perspective). Area above 50% shaded
  `--eval-white`, below `--eval-black`; line `--text-secondary`. A vertical scrubber syncs to the
  current move; clicking/dragging the graph jumps the board and move list. Blunders/brilliants are
  marked with small badge dots at their plies; "jump to next blunder" buttons flank the graph.
  Recharts/visx are acceptable fallbacks but the hand-rolled SVG is preferred for the lichess look.

### 4.7 Classification Badges (`<ClassBadge/>`)

The visual vocabulary for move quality. **Open labels + open hex only** (no chess.com branding).
Each badge = color + Lucide icon + short word/glyph (never color alone).

| Class | Label (open) | NAG | Color token | Lucide icon |
|---|---|---|---|---|
| Brilliant | Brilliant | `$3` | `--class-brilliant` (teal) | `sparkles` |
| Best | Best | — | `--class-best` (green) | `circle-check` |
| Good | Good | `$1` | `--class-good` (muted green) | `check` |
| Book | Book | — | `--class-book` (brown) | `book-open` |
| Inaccuracy | Inaccuracy | `$6` | `--class-inaccuracy` (amber) | `alert-circle` |
| Mistake | Mistake | `$2` | `--class-mistake` (orange) | `alert-triangle` |
| Blunder | Blunder | `$4` | `--class-blunder` (red) | `x-octagon` |

- **Thresholds (authoritative in content spec):** lichess win-% drop — Inaccuracy ≥ 10, Mistake
  ≥ 20, Blunder ≥ 30; Best = engine best/near-best; Book = in opening DB; **Brilliant = best/near-
  best AND a sound sacrifice/sharp tactic** detected by the motif layer (tuned so romantic-era and
  deliberate sacrifices read as Brilliant, never "blunder"). "Great/Miss" (chess.com concepts) are
  **not** used.
- **Forms:** inline (small, in move list — icon + glyph), and large (in review tally + on-board
  move stamp). The large on-board stamp animates in over the destination square for ~600 ms after a
  reviewed move is reached.

### 4.8 Side-Panel Tabs

The right column hosts switchable panels above the move list when space-constrained: **Lines**
(engine), **Explorer** (offline opening explorer: opening name + ECO from the CC0 chess-openings
EPD map, candidate moves with W/D/L from the self-built CC0 stats, transposition-aware), **Coach**
(local no-LLM idea explanation for the current move), **Review** (accuracy/graph). On wide screens
Lines + Explorer/Coach show simultaneously.

### 4.9 Input Affordances on the Analysis Board

Paste box / load: an overflow action opens a modal accepting FEN or full PGN (with variations/NAGs
via chessops), validated before load with a clear error on illegal input. A persistent small "FEN"
field at the bottom shows the current position's FEN (click to copy).

### 4.10 Game Review entry

Triggered from a finished game ("Review this game") or My Games. Shows a determinate
`ProgressBar` ("Analyzing… move 18 / 41") while Stockfish runs at fixed depth across the game
(cached in `game_review`/`move_eval`, instant on re-open). On completion the Analysis Board enters
**review mode**: per-move classification badges populate the move list, the Review Strip (§4.6)
expands, and the estimated **playing-strength band** for the game is shown ("Estimated strength
this game: ~1450 (1300–1600)"), explicitly labeled move-quality and distinct from the Glicko
rating.

---

## 5. Interaction Model

### 5.1 Moving pieces

Both input methods are always enabled simultaneously (chessground supports both):

- **Drag:** press-and-move past `draggable.distance` (3 px) lifts the piece; a `showGhost` ghost
  stays on the origin; legal destinations show `.move-dest` dots; drop on a legal square commits;
  drop off-board or on an illegal square snaps back with a short shake.
- **Click-move:** click a piece → it becomes `.selected` and legal targets show dots; click a legal
  target → commits; click the same piece again or empty illegal square → deselect; click another own
  piece → reselect.

### 5.2 Legal-move dots & highlights

- **Legal dots:** small centered dots on empty legal targets; **capture targets** render as a ring
  around the occupied square (chessground's capture style), so captures are visually distinct from
  quiet moves — a shape difference, not just color.
- **Last move:** origin + destination squares tinted `--hl-last-move`.
- **Check:** checked king square gets a radial `--hl-check` glow.
- **Selected:** `--hl-selected` tint on the selected piece's square.
- **Hover (optional):** faint square tint on hover when "highlight on hover" is enabled.

### 5.3 Arrows & circles (annotations)

Right-click drawing via chessground `drawable`, matching lichess brushes exactly:

- Right-click-drag = **arrow** (origin→destination); right-click-tap = **circle** (destination).
- Brush by modifier: plain = green (`--brush-green`), Shift/Ctrl = red (`--brush-red`),
  Alt/Meta = blue (`--brush-blue`), Shift+Alt = yellow (`--brush-yellow`). Each brush has
  color/opacity/lineWidth tokens.
- Left-click anywhere clears all shapes. Engine "best move" can render a managed accent arrow
  (toggle `a`), drawn distinctly from user shapes.

### 5.4 Premove (play screens only)

In **Play** (not analysis): when it isn't the user's turn, clicking/dragging a move arms a
**premove**, shown with `--hl-premove` on origin+destination and `.premove-dest` targets. It
executes automatically if legal once the opponent moves, or clears on illegal. Cancel by clicking
the board background or pressing `Esc`. Premove is settings-gated (default on for timed, off for
untimed teaching games).

### 5.5 Promotion

When a pawn reaches the last rank, an **on-board overlay picker** appears anchored to the
destination file: four piece choices (Q, R, B, N) in the current piece set, stacked toward the
board center, on a dimmed scrim. Click selects; `Esc` or click-scrim cancels the move. Keyboard:
`q/r/b/n` select; `Enter` defaults to queen. Setting "auto-promote to queen" skips the picker
(Shift+drop forces the picker even when auto-promote is on).

### 5.6 Keyboard navigation (mirror lichess verbatim)

| Key(s) | Action |
|---|---|
| `←` / `j` | previous move |
| `→` / `k` | next move |
| `↑` / `0` | first move (start position) |
| `↓` / `$` | last move |
| `Shift+←/→` (or `Shift+J/K`) | enter / exit variation |
| `f` | flip board |
| `l` | toggle local engine |
| `z` | toggle all computer analysis |
| `a` | toggle engine best-move arrow |
| `space` | play engine best move (analysis) / autoplay toggle |
| `x` | show threat |
| `e` | open opening/endgame explorer |
| `Shift+C` | show / hide comments |
| `?` | keyboard-shortcut help dialog |
| `Esc` | cancel premove / close overlay / deselect |

Move-list tokens are focusable; arrow keys move focus and the board follows. Focus rings use
`--focus-ring`.

### 5.7 Board flip

`f` or the flip control swaps `orientation`. The eval bar, coordinates, and captured-material tray
all flip consistently; the move list does not change order. Flip animates pieces ~200 ms.

### 5.8 Strength / performance sliders

- **Engine-strength slider (Play setup):** Elo 1320–3190 with a "Beginner" notch below 1320 routing
  to Maia-1100/randomized. The slider shows a live value bubble and a one-line plain caption ("Club
  player," "Strong club," "Expert," "Master-level") — never an over-precise promise. Internally maps
  to `UCI_LimitStrength=true` + `UCI_Elo`; the calibration loop nudges effective level by results.
- **Maia level slider (Human-like):** discrete stops 1100–1900 (100-Elo steps), captioned "plays
  like a ~N club player."
- **Analysis performance sliders (Settings → Engine):** Threads, Hash (MB), MultiPV (1–5),
  depth/movetime budget. Live tradeoff hint ("higher = deeper but slower"). These are *performance*
  controls; a separate "use full strength for analysis" lock ensures analysis/coaching always run at
  full strength regardless of the play-strength slider.
- All sliders: keyboard `←/→` step, `Shift` = ×10 / next notch, `Home/End` = min/max; value
  announced to screen readers.

### 5.9 Touch / trackpad

Drag and click both work via pointer events. Long-press = context menu equivalent (right-click).
Pinch is ignored on the board (board size is fixed by layout, zoom is the app's).

---

## 6. DESIGN TOKENS

All tokens are CSS custom properties on `:root` (light) and `[data-theme="dark"]` (dark overrides).
Component CSS reads only tokens. Hex values are concrete and drop-in.

### 6.1 Color — Light theme

```css
:root {
  /* Backgrounds & surfaces */
  --bg-page:        #ffffff;
  --bg-subtle:      #f4f5f7;
  --surface:        #ffffff;
  --surface-2:      #eef0f3;
  --border:         #e2e5ea;
  --border-strong:  #cfd4dc;

  /* Text */
  --text-primary:   #1b1c1d;
  --text-secondary: #5b6168;
  --text-muted:     #8a9099;
  --text-inverse:   #ffffff;

  /* Accent (lichess-style blue) */
  --accent:         #3893e8;
  --accent-hover:   #2f7fcc;
  --accent-active:  #2a72b8;
  --accent-soft:    #e7f1fc;   /* soft background fills, active nav */
  --on-accent:      #ffffff;

  /* Semantic */
  --success:        #629924;
  --success-soft:   #eaf3df;
  --danger:         #cc3333;
  --danger-soft:    #fbe9e9;
  --warning:        #e58f2a;
  --warning-soft:   #fdf1e3;
  --info:           #3893e8;

  /* Focus */
  --focus-ring:     #3893e8;

  /* Eval bar */
  --eval-white:     #f0f0f0;
  --eval-black:     #403d39;
  --eval-mid:       #888888;

  /* Move classification badges */
  --class-brilliant:  #1baca6;  /* teal */
  --class-best:       #649b3b;  /* green */
  --class-good:       #7d9b58;  /* muted green */
  --class-book:       #a88865;  /* brown */
  --class-inaccuracy: #e0a44a;  /* amber */
  --class-mistake:    #e08a3c;  /* orange */
  --class-blunder:    #ca3431;  /* red */

  /* Board highlights & brushes (theme-independent overlays) */
  --hl-last-move:   rgba(155,199,0,0.41);
  --hl-check:       radial-gradient(rgba(255,0,0,0.55), rgba(255,0,0,0.0) 70%);
  --hl-selected:    rgba(20,85,30,0.30);
  --hl-premove:     rgba(20,30,85,0.25);
  --brush-green:    #15781b;
  --brush-red:      #882020;
  --brush-blue:     #003088;
  --brush-yellow:   #e68f00;
}
```

### 6.2 Color — Dark theme (lichess-derived)

```css
[data-theme="dark"] {
  --bg-page:        #161512;
  --bg-subtle:      #1f1d1a;
  --surface:        #262421;
  --surface-2:      #2e2b27;
  --border:         #3a3733;
  --border-strong:  #4a4641;

  --text-primary:   #c8c6c1;
  --text-secondary: #9b9893;
  --text-muted:     #75726d;
  --text-inverse:   #161512;

  --accent:         #3893e8;
  --accent-hover:   #4ea0ef;
  --accent-active:  #5aa9f2;
  --accent-soft:    #1d2b3a;
  --on-accent:      #ffffff;

  --success:        #7bb33a;
  --success-soft:   #21311a;
  --danger:         #e06c6c;
  --danger-soft:    #3a1f1f;
  --warning:        #e0a44a;
  --warning-soft:   #36291a;
  --info:           #4ea0ef;

  --focus-ring:     #4ea0ef;

  --eval-white:     #e8e8e6;
  --eval-black:     #100f0d;
  --eval-mid:       #888888;

  --class-brilliant:  #2bc4bd;
  --class-best:       #79b94a;
  --class-good:       #8fae66;
  --class-book:       #b89a76;
  --class-inaccuracy: #e6b25e;
  --class-mistake:    #e89a52;
  --class-blunder:    #e0504d;

  --hl-last-move:   rgba(155,199,0,0.45);
  --hl-check:       radial-gradient(rgba(255,40,40,0.60), rgba(255,40,40,0.0) 70%);
  --hl-selected:    rgba(120,200,120,0.30);
  --hl-premove:     rgba(120,140,220,0.28);
  /* brushes inherit from :root */
}
```

### 6.3 Board square colors (per-theme CSS classes, not core tokens)

Selected by a wrapper class on the board (e.g. `.board-brown`, `.board-green`, `.board-blue`).
Square fills live in theme CSS so they are independent of light/dark chrome.

| Theme | Light square | Dark square |
|---|---|---|
| **Brown** (default, lichess) | `#f0d9b5` | `#b58863` |
| **Green** | `#eeeed2` | `#769656` |
| **Blue** | `#dee3e6` | `#8ca2ad` |
| **Grey** (high-contrast) | `#d8d8d8` | `#8f8f8f` |

Optional wood/marble textures (AGPL board images) are **not** bundled by default to avoid AGPL
copyleft; flat CSS themes above are the shipped defaults. Coordinate label color = dark-square color
on light squares and vice-versa for contrast.

### 6.4 Spacing scale (4 px base)

```css
:root {
  --space-0: 0;     --space-1: 2px;  --space-2: 4px;  --space-3: 8px;
  --space-4: 12px;  --space-5: 16px; --space-6: 20px; --space-7: 24px;
  --space-8: 32px;  --space-9: 40px; --space-10: 48px; --space-11: 64px;
}
```

### 6.5 Radius

```css
:root {
  --radius-sm:   4px;   /* chips, inputs, small buttons */
  --radius-md:   8px;   /* cards, panels, buttons */
  --radius-lg:   12px;  /* modals, large cards */
  --radius-pill: 999px; /* toggles, rating pills, segmented controls */
  --radius-board: 4px;  /* board outer corner */
}
```

### 6.6 Shadows / elevation

```css
:root {
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.06);
  --shadow-md: 0 2px 8px rgba(0,0,0,0.10);
  --shadow-lg: 0 8px 24px rgba(0,0,0,0.14);
}
[data-theme="dark"] {
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.30);
  --shadow-md: 0 2px 8px rgba(0,0,0,0.40);
  --shadow-lg: 0 8px 24px rgba(0,0,0,0.50);
}
```

Dark mode leans on `--border` for separation more than shadow.

### 6.7 Typography

```css
:root {
  --font-sans: 'Inter','Noto Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --font-mono: 'JetBrains Mono','Roboto Mono',ui-monospace,monospace;
  --font-figurine: 'Noto Sans Symbols 2','Inter',sans-serif; /* Unicode chess glyphs */

  /* Sizes */
  --fs-xs: 12px; --fs-sm: 13px; --fs-base: 14px; --fs-md: 16px;
  --fs-lg: 18px; --fs-xl: 22px; --fs-2xl: 28px; --fs-3xl: 36px;

  /* Weights */
  --fw-regular: 400; --fw-medium: 500; --fw-semibold: 600; --fw-bold: 700;

  /* Line heights */
  --lh-tight: 1.2;  --lh-body: 1.5;

  /* Numeric: tabular figures everywhere data is shown */
  --num-feature: 'tnum' 1;  /* applied to eval, clocks, ratings, depth/nodes */
}
```

- **Font shipping:** self-host Inter `.woff2` (OFL); **never** hotlink (app is offline). Inter
  defaults to tabular figures — ideal for the eval bar, clocks, ratings, depth/nodes; apply
  `font-feature-settings: var(--num-feature)` defensively on those readouts.
- **Figurine glyphs** (move list figurine mode) use `--font-figurine`. If SVG piece sets are
  preferred for figurines, render small inline SVGs instead and skip the symbols font.
- **Mono** is optional, for PGN export view alignment only.

### 6.8 Motion tokens

```css
:root {
  --dur-instant: 80ms;   --dur-fast: 140ms;  --dur-base: 200ms;
  --dur-slow: 320ms;     --dur-board: 200ms; /* piece animation */
  --ease-out: cubic-bezier(0.16,1,0.3,1);
  --ease-in-out: cubic-bezier(0.4,0,0.2,1);
}
```

`prefers-reduced-motion`: disable non-essential transitions (eval-bar fill, badge entrances,
graph scrubber tween); piece movement reduces to a 0 ms snap.

### 6.9 Z-index scale

```css
:root {
  --z-base: 0; --z-board-overlay: 50; --z-sticky: 100; --z-rail: 200;
  --z-dropdown: 300; --z-tooltip: 400; --z-modal: 500; --z-toast: 600;
}
```

---

## 7. Icons, Pieces, Boards, Sounds (theming model)

### 7.1 Icon pack — Lucide (MIT)

Primary UI icon pack: **Lucide** (~1,600 stroke icons, 24×24, 2 px stroke — clean, matches the
minimal lichess/chess.com aesthetic). Bundled offline as a tree-shaken `lucide-react` import set
**or** a vendored SVG sprite (pin the version, snapshot the SVGs so an upgrade can't drop a glyph).
**Phosphor (MIT)** is the only fallback for a niche glyph Lucide lacks; do not mix three packs in
visible UI. The lichess in-house icon font (AGPL) and chess.com's icon font (proprietary) are **not**
used.

### 7.2 Icon mapping (all names verified in Lucide)

| Purpose | Icon | | Purpose | Icon |
|---|---|---|---|---|
| Home | `home` | | Flip board | `flip-vertical-2` |
| Play (vs) | `swords` | | First move | `chevrons-left` |
| Analysis / engine | `cpu` | | Previous move | `chevron-left` |
| Puzzles | `puzzle` | | Next move | `chevron-right` |
| Lessons / learn | `graduation-cap` | | Last move | `chevrons-right` |
| Openings / theory | `book-open` | | Play / autoplay | `play` |
| Profile / progress | `user` | | Pause | `pause` |
| Settings | `settings` | | Retry / reset | `rotate-ccw` |
| Coach | `brain` | | Hint | `lightbulb` |
| Target / find-the-move | `target` | | Clock / time | `clock` |
| Trophy / achievement | `trophy` | | Eval graph | `line-chart` |
| Resign | `flag` | | Correct | `circle-check` |
| Wrong | `circle-x` | | Sound on/off | `volume-2` / `volume-x` |
| Brilliant | `sparkles` | | Best | `circle-check` |
| Good | `check` | | Book | `book-open` |
| Inaccuracy | `alert-circle` | | Mistake | `alert-triangle` |
| Blunder | `x-octagon` | | Command palette | `command` |
| Copy | `copy` | | Paste / load | `clipboard` |
| Export | `download` | | Import | `upload` |
| Filter | `filter` | | Search | `search` |
| More / overflow | `ellipsis` | | Close | `x` |

### 7.3 Piece sets

Pieces are swapped by a **wrapper class** on the board; each set is 12 SVGs
`{w,b}{P,N,B,R,Q,K}.svg`, themed via the chessground CSS selector pattern
`.set-cburnett cg-board piece.pawn.white { background-image: url('assets/piece/cburnett/wP.svg') }`.

**Bundle only the redistribution-safe shortlist** (verified open in lila COPYING.md):

| Set | License | Look | Default |
|---|---|---|---|
| **cburnett** | GPLv2+ | classic (lichess default) | **yes** |
| merida | GPLv2+ | classic tournament | |
| chessnut | Apache-2.0 | modern flat | |
| fantasy / spatial / celtic | MIT (Monge) | high-quality permissive | |
| rhosgfx | CC0 | zero-restriction fallback | |
| kiwen-suwi / Firi | CC BY 4.0 | modern (needs attribution) | |

**Do NOT bundle** any CC-BY-NC set (maestro, staunty, fresca, cardinal, icpieces, gioco, tatiana,
dubrovny, horsey, california, caliente, anarcandy, cooke, monarchy, xkcd) or freeware-only sets
(alpha, chess7, companion, leipzig) — they are non-commercial / personal-only. Piece-set switching
is instant (CSS class swap) with a ~140 ms crossfade.

### 7.4 Board themes

Flat CSS color themes (§6.3) are the shipped set (no image-license burden). The board theme is a
wrapper class (`.board-brown` default). Texture themes (AGPL images) are out of scope for v0.

### 7.5 Sound themes

- **Do NOT ship the lichess "standard" sound set** (no clear license) or robot/instrument/
  woodland/other. Cleanly free options: lila **futuristic / nes / piano / sfx** (AGPLv3+, only if we
  accept AGPL on the app) — otherwise the safe default is **Kenney CC0** UI/interface audio remapped
  to events. Default ship = Kenney CC0 to keep licensing clean.
- **Events:** `move`, `capture`, `check`, `castle`, `promote`, `low-time`, `game-start`,
  `game-end-win/lose/draw`, `puzzle-correct`, `puzzle-wrong`, `notify`. Each mapped to one short
  clip (`.mp3` / `.webm`; Chromium plays either).
- **Engine:** a small `SoundManager` in the renderer preloads decoded buffers; respects master
  volume + per-event toggles + global mute; never overlaps more than 2 concurrent SFX; sounds are
  gated behind a first-user-gesture unlock. Sound theme = a folder of clips selected by name.

### 7.6 Credits / Licenses screen

Auto-generated from a per-asset manifest (set, author, license, link). CC-BY and GPL/CC-BY-SA
assets are listed with attribution + license text; Stockfish/lc0 GPL source pointers and license
texts are surfaced here (ship-blocking compliance). Reachable from Settings → About.

---

## 8. Animations & Micro-Interactions

All durations/eases use the §6.8 motion tokens; all honor `prefers-reduced-motion`.

| Interaction | Animation |
|---|---|
| Piece move (commit) | translate origin→dest, `--dur-board` `--ease-out`; captured piece fades out 120 ms |
| Illegal drop | snap-back 140 ms + 2-cycle horizontal shake (4 px) |
| Legal-dot reveal | dots fade+scale-in 80 ms on selection; fade-out on deselect |
| Eval-bar update | fill height tween `--dur-base` `--ease-out`; mate = success edge-flash 320 ms |
| Engine line update | eval/depth numbers tick with a 100 ms cross-fade; no layout shift |
| Move-list jump | active highlight slides; list auto-scrolls (smooth, 200 ms) |
| Classification badge (review) | inline badge pops in 140 ms; on-board large stamp scales 0.8→1 over 600 ms then settles |
| Eval-graph scrub | scrubber line follows pointer with 60 ms lag tween; dot markers enlarge on hover |
| Promotion picker | scrim fade 140 ms; choices stagger-in 40 ms each |
| Board flip | pieces animate to new squares `--dur-board`; eval bar + coords flip instantly |
| Arrow draw | arrow grows from origin to pointer in real time; release sets opacity to brush value |
| Hint (trainer) | progressive: piece pulse → arrow draw-in → move ghost; each step a separate user click |
| Rating change | value count-up tween 320 ms; band width animates; +Δ / −Δ chip slides up and fades |
| Toast | slide-up + fade 140 ms; auto-dismiss; hover pauses timer |
| Nav active | accent left-marker slides between items 200 ms |
| Tab switch | content cross-fade 140 ms (no horizontal slide, to avoid board reflow feel) |
| Theme/piece switch | 140 ms crossfade on affected surfaces; no full-page flash |

Micro-interaction rules: never animate the board's *size*; never block input on an animation
(commits are immediate, the tween is cosmetic); keep concurrent animations ≤ 3 on the board region.

---

## 9. Responsive & Accessibility

- **Breakpoints:** `≥1280` three-column analysis; `1024–1279` two-column (engine+moves+controls in
  one right column); `<1024` board full-width with the panel stack below; `<1100` left rail collapses
  to icons. Minimum supported window 1024×680.
- **Board sizing:** board = `min(viewport-height − chrome, right-gutter-constrained-width)` snapped
  to ×8 px; sidebar takes the remainder with a 320 px min before it wraps under the board.
- **Contrast:** all text meets WCAG AA on its surface; classification colors verified against
  surface; eval-bar text uses opposite-fill color.
- **Color independence:** classification = color + icon + word; legal dots vs capture rings differ
  by shape; check = glow + (optional) king flash.
- **Focus:** visible `--focus-ring` on all interactive elements; logical tab order; move-list tokens
  and engine-line tokens are focusable and operable by keyboard.
- **Screen readers:** board exposes an ARIA live region announcing moves in SAN; sliders announce
  value + label; icon-only buttons have `aria-label` matching their tooltip; classification badges
  have text alternatives.
- **Reduced motion:** disables cosmetic tweens; piece movement snaps.

---

## 10. State, Theming & Data Wiring (renderer contract)

- **Theme state:** `data-theme` on `<html>` (`light`/`dark`, default from System); board theme +
  piece set as wrapper classes on `<ChessBoard>`; all read from a single settings store persisted via
  IPC to the writable SQLite DB.
- **Engine data:** the Engine Lines panel, Eval Bar, and Coach panel subscribe to a single streamed
  analysis channel (IPC events from the main-process Stockfish). One analysis instance; play uses a
  separate instance so a game and analysis can run concurrently (per addendum §1).
- **Move tree:** one immutable chessops PGN node tree in a store; MoveList, board, eval graph, and
  review badges are all views over the current path. Click/keyboard navigation only changes the
  current path.
- **Ratings:** `RatingBand` reads the two distinct quantities — performance estimate
  (`perf_estimate`) and Glicko (`rating`) — and always renders the kind caption. Never compute a
  single merged number.
- **Review cache:** review mode reads `game_review` / `move_eval`; if absent, runs the review
  pipeline with a determinate progress bar, then caches.

---

## 11. Implementation Checklist (v0 UI)

1. App shell: TitleBar, LeftRail, ContentArea, routing for the 7 screens.
2. Token layer: ship `tokens.css` (§6) as the only color/space/type source.
3. `<ChessBoard>` chessground wrapper + chessops dests; piece/board theme classes; promotion overlay.
4. Analysis Board: EvalBar, MoveList (figurine/letter, NAGs, variation tree), EnginePanel/EngineLine
   (MultiPV streaming), ControlsBar, keyboard nav.
5. Review mode: ClassBadge set, ReviewStrip (accuracy + counts), hand-rolled EvalGraph, strength band.
6. Play: opponent gallery (Engine + Maia rows), strength slider, Game screen, premove, clocks.
7. Puzzles: trainer home, puzzle screen, hint ladder, rating delta + sparkline.
8. Lessons: curriculum map, lesson player, famous-games library + viewer.
9. Progress/Profile: dual rating header, trends, My Games, PGN import/export.
10. Settings: appearance, board/piece/sound pickers, engine knobs, data, Credits/Licenses screen.
11. SoundManager (Kenney CC0 default), animation/motion pass, accessibility pass.

---

*End of UI/UX SPEC.*
