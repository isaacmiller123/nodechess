# CONTENT & COACHING SPEC

> Offline Electron chess teaching/analysis app. This spec is the authorable source of truth for: the curriculum tree (beginner → ~2000 Elo), the puzzle theme taxonomy + rating-band mapping, the **local (no-LLM) coaching engine** (classification math, motif detection, template NLG), the spaced-repetition + local rating subsystem, and the bundled data-sources/licenses table.
>
> All numbers, formulas, and thresholds below are concrete and implementation-ready. Algorithm code is described to be **re-implemented in clean BSD/MIT modules** (never copied from AGPL/GPL sources — math and facts are not copyrightable; source text is). Stockfish is bundled as a separate UCI process so its GPL stays compartmentalized.

---

## 0. Conventions & shared primitives

These are referenced throughout.

### 0.1 Engine eval conventions
- All evals come from a **bundled Stockfish 18** child process over UCI (see §6). `info ... score cp <x>` is **centipawns from side-to-move POV**; `score mate <n>` is mate-in-n plies (sign = who mates). Coaching always converts to a **fixed POV** (the player whose move is being judged) before computing diffs.
- Analysis/review runs at a **fixed budget** (`go depth 20` or `~1500 ms movetime`, plus `MultiPV 2` minimum) so classification is **reproducible and cacheable** (key = `FEN + depth`). Great/Brilliant tests need the 2nd-best line.

### 0.2 Win% (Lichess canonical) — single source of truth
```ts
// cp clamped to [-1000, 1000]; mate mapped to a finite high band.
const WIN_MULT = -0.00368208;            // Lichess constant (lila PR #11148)
function rawWinningChances(cp: number): number { // returns -1..1
  const c = Math.max(-1000, Math.min(1000, cp));
  return 2 / (1 + Math.exp(WIN_MULT * c)) - 1;
}
function mateToCp(mate: number): number { // signed
  const sign = Math.sign(mate);
  return sign * (21 - Math.min(10, Math.abs(mate))) * 100;
}
function winPercent(scoreCp: number | null, mate: number | null): number {
  const cp = mate != null ? mateToCp(mate) : (scoreCp ?? 0);
  return 50 + 50 * rawWinningChances(cp);   // 0..100
}
```
> **DRIFT WARNING:** Do not mix in the older `-0.004` constant from python-chess-annotator. Use `-0.00368208` everywhere.

### 0.3 cp → Win% reference table (white POV)
| cp | Win% | verbal band |
|---:|---:|---|
| 0 | 50.0 | equal / balanced |
| +50 | 54.6 | slightly better |
| +100 | 59.1 | clearly better |
| +200 | 67.4 | clearly better |
| +300 | 74.6 | winning advantage |
| +600 | 89.5 | completely winning |
| +1000 | 97.5 | completely winning |
| mate | ~99–100 | forced mate in N |

### 0.4 Glossary
- **Win% drop / shift** = `winBefore − winAfter` from the mover's POV (0..100 scale), or as a 0..1 chances delta in some thresholds (note the factor-of-2 caveat in §3.2).
- **Opening-FEN / EPD key** = 4-field FEN (placement, turn, castling, en-passant *only if a legal ep capture exists*), no move counters. Used for opening name + transposition lookups.

---

# 1. CURRICULUM TREE (beginner → ~2000 Elo)

Structure: **Band → Unit → Lesson → Objectives → linked puzzle themes + rating range**. Five bands keyed to a per-user Glicko-2 estimate. Endgames are gated by Silman rating class; strategy is introduced only from Band 3 (Steps "Step 4"). Repertoire ships as swappable PGN modules. Puzzle ratings are **puzzle-Glicko-2 difficulty**, surfaced to users as "difficulty", never as FIDE Elo.

> **Authoring rule:** every lesson's `puzzleThemes` are keys from the §2 taxonomy; every `ratingRange` is a window into the bundled Lichess puzzle DB. The lesson runtime queries `puzzle_theme(theme, rating BETWEEN lo AND hi)`.

## 1.1 Lesson schema (TypeScript / JSON)

```ts
/** Stable enum of band ids. */
type BandId = "B0_600" | "B600_1000" | "B1000_1400" | "B1400_1800" | "B1800_2000";

/** A puzzle-theme key from the Lichess taxonomy (see §2). */
type PuzzleTheme = string; // validated against THEME_ENUM at author/build time

interface RatingRange {
  lo: number;   // inclusive puzzle-Glicko rating
  hi: number;   // inclusive
}

interface PuzzleQuery {
  themes: PuzzleTheme[];        // OR-set unless allOf=true
  allOf?: boolean;             // require ALL themes on each puzzle
  rating: RatingRange;
  count: number;               // puzzles to serve in this lesson
  excludeThemes?: PuzzleTheme[]; // e.g. exclude "mateIn4" from a fork drill
  fallbackThemes?: PuzzleTheme[]; // used if pool < count (thin tags)
}

interface LessonObjective {
  id: string;
  text: string;                // learner-facing, imperative ("Win material with a knight fork")
  mastery: {                   // unlock/credit rule
    type: "puzzleAccuracy" | "puzzleCount" | "interactiveBoard" | "quiz";
    threshold: number;         // e.g. 0.80 accuracy, or 8 solved
    window?: number;           // last-N attempts the threshold is measured over
  };
}

interface InteractiveSegment {     // optional non-puzzle teaching steps
  kind: "explainer" | "guidedBoard" | "modelGame" | "drillVsEngine";
  fen?: string;                    // start position
  pgn?: string;                    // model line / guided line (with comments/NAGs)
  engineElo?: number;              // for drillVsEngine (UCI_Elo 1320..3190)
  notes?: string;
}

interface Lesson {
  id: string;                      // globally unique, stable (used as SRS/progress key)
  band: BandId;
  unitId: string;
  order: number;                   // sequence within unit
  title: string;
  summary: string;                 // 1–2 sentences
  prerequisites: string[];         // lesson ids that must be mastered first
  objectives: LessonObjective[];
  interactive?: InteractiveSegment[];
  puzzle: PuzzleQuery;             // the drilled puzzle set
  estMinutes: number;
  tags?: string[];
}

interface Unit {
  id: string;
  band: BandId;
  order: number;
  title: string;
  goal: string;                    // what the learner can do after the unit
  lessons: Lesson[];
}

interface Band {
  id: BandId;
  order: number;
  label: string;                   // "Absolute Beginner (0–600)"
  ratingFloor: number;             // user-Glicko gate to start the band
  units: Unit[];
}

interface Curriculum {
  version: string;                 // pin with puzzle DB snapshot
  puzzleDbSnapshot: string;        // e.g. "lichess_db_puzzle 2026-06-03"
  bands: Band[];
}
```

### 1.1.1 Example authored lesson (JSON)
```json
{
  "id": "B600_1000.tactics.fork.knight",
  "band": "B600_1000",
  "unitId": "B600_1000.tactics",
  "order": 3,
  "title": "Knight Forks",
  "summary": "Use the knight's unique geometry to attack two pieces at once and win material.",
  "prerequisites": ["B0_600.tactics.mate_in_one", "B0_600.safety.dont_hang"],
  "objectives": [
    { "id": "obj.spot", "text": "Spot a knight fork that wins material",
      "mastery": { "type": "puzzleAccuracy", "threshold": 0.80, "window": 12 } },
    { "id": "obj.royal", "text": "Recognize the royal fork (K+Q)",
      "mastery": { "type": "puzzleCount", "threshold": 5 } }
  ],
  "interactive": [
    { "kind": "explainer", "fen": "4k3/8/8/3N4/8/8/8/4K3 w - - 0 1",
      "notes": "Knight on d5 attacks c7, e7, f6, b6, f4, b4, c3, e3 — eight squares, none on its own line." },
    { "kind": "guidedBoard", "pgn": "1. ... (guided: play Nf7+ forking K and Q)" }
  ],
  "puzzle": {
    "themes": ["fork"],
    "rating": { "lo": 700, "hi": 1050 },
    "count": 10,
    "excludeThemes": ["mateIn4", "veryLong"],
    "fallbackThemes": ["hangingPiece"]
  },
  "estMinutes": 12
}
```

## 1.2 Full band → unit → lesson tree

Legend per lesson: **objectives** abbreviated; **themes** = §2 keys; **rating** = puzzle-Glicko window.

### BAND 0 — Absolute Beginner (0–600) · `ratingFloor: 0`
Goal: know the rules, never hang for free, deliver basic mates.

- **Unit B0.rules — The Board & The Pieces**
  - *L1 How pieces move* — obj: move each piece legally. themes: — (interactive only). rating: n/a
  - *L2 Special moves* — obj: castle, en-passant, promotion. themes: `promotion`,`enPassant`,`castling`. rating: 600–900 (sparse; mostly interactive)
  - *L3 Check, checkmate, stalemate* — obj: distinguish the three. themes: `mate`,`mateIn1`. rating: 600–800
  - *L4 Piece values & trades* — obj: count material, avoid bad trades. themes: `hangingPiece`. rating: 600–800
- **Unit B0.mate — First Checkmates**
  - *L1 Mate in one* — themes: `mateIn1`,`oneMove`. rating: 600–800
  - *L2 Overkill mates (K+Q vs K, K+2R vs K)* — themes: `mate`,`endgame`. rating: 600–900 (supplement with authored positions)
  - *L3 K+R vs K (the box/ladder)* — themes: `endgame`,`rookEndgame`. rating: 700–950 (authored fallback)
- **Unit B0.safety — Don't Hang Pieces**
  - *L1 Spot a free capture* — themes: `hangingPiece`,`oneMove`. rating: 600–850
  - *L2 The fork (intro)* — themes: `fork`. rating: 700–950
  - *L3 Defend a hanging piece* — themes: `hangingPiece`,`defensiveMove`. rating: 700–950

### BAND 1 — Beginner (600–1000) · `ratingFloor: 600`
Goal: the core tactical motifs, opening principles, a first opening, basic king-and-pawn ideas.

- **Unit B1.tactics — Pins, Skewers, Forks**
  - *L1 Pin* — themes: `pin`. rating: 700–1050
  - *L2 Skewer* — themes: `skewer`. rating: 750–1100
  - *L3 Knight & pawn forks* — themes: `fork`. rating: 700–1050
  - *L4 Discovered attack* — themes: `discoveredAttack`. rating: 800–1150
- **Unit B1.mating — Back-Rank & Mating Nets**
  - *L1 Back-rank mate* — themes: `backRankMate`,`mateIn1`. rating: 700–1050
  - *L2 Mate in 2 (intro)* — themes: `mateIn2`,`short`. rating: 800–1150
  - *L3 Smothered mate (intro)* — themes: `smotheredMate`. rating: 900–1200
- **Unit B1.openings — Opening Principles**
  - *L1 Center, develop, castle* — themes: `opening`. rating: 700–1000 (with `OpeningTags` filter)
  - *L2 The Italian Game* — interactive PGN module; obj: reach a sound Italian setup
  - *L3 The London System* — interactive PGN module
- **Unit B1.endgame — King & Pawn Basics**
  - *L1 Opposition* — themes: `endgame`,`pawnEndgame`. rating: 800–1100 (authored fallback)
  - *L2 Promoting a pawn* — themes: `promotion`,`pawnEndgame`. rating: 800–1150

### BAND 2 — Intermediate Beginner (1000–1400) · `ratingFloor: 1000`
Goal: combination motifs, calculation, K+P vs K technique, first real strategy.

- **Unit B2.combos — Removing Defenders & Combinations**
  - *L1 Deflection* — themes: `deflection`. rating: 1050–1400
  - *L2 Attraction* — themes: `attraction`. rating: 1050–1400
  - *L3 Capturing the defender* — themes: `capturingDefender`. rating: 1050–1400
  - *L4 Intermezzo (zwischenzug)* — themes: `intermezzo`. rating: 1100–1450
- **Unit B2.mating — Forced Mates**
  - *L1 Mate in 2* — themes: `mateIn2`. rating: 1000–1350
  - *L2 Sacrificial mating attacks* — themes: `sacrifice`,`kingsideAttack`. rating: 1100–1450
- **Unit B2.endgame — Essential King & Pawn**
  - *L1 K+P vs K (key squares)* — themes: `pawnEndgame`. rating: 1000–1350
  - *L2 Outside passed pawn* — themes: `pawnEndgame`,`advancedPawn`. rating: 1100–1400
- **Unit B2.strategy — First Strategy (Steps "Step 4")**
  - *L1 Weak squares & outposts* — interactive; obj: place a knight on a protected outpost
  - *L2 Open files for rooks* — interactive
  - *L3 Good vs bad bishop* — interactive

### BAND 3 — Intermediate (1400–1800) · `ratingFloor: 1400`
Goal: advanced tactics, theoretical rook endgames, calculation discipline, deeper repertoire.

- **Unit B3.tactics — Advanced Motifs**
  - *L1 Interference* — themes: `interference`. rating: 1450–1800
  - *L2 X-ray / battery* — themes: `xRayAttack`. rating: 1450–1800
  - *L3 Quiet move (the in-between non-capture)* — themes: `quietMove`. rating: 1500–1850
  - *L4 Overloaded pieces* — themes: `deflection` (proxy) + app's own overload detector. rating: 1450–1800
- **Unit B3.endgame — Theoretical Rook Endgames**
  - *L1 Lucena (building a bridge)* — themes: `rookEndgame`. rating: 1450–1800 (authored fallback)
  - *L2 Philidor (third-rank defense)* — themes: `rookEndgame`. rating: 1450–1800 (authored fallback)
  - *L3 Rook on the 7th rank* — themes: `rookEndgame`,`advancedPawn`. rating: 1500–1850
- **Unit B3.calc — Calculation & Visualization**
  - *L1 Forcing-moves first (checks, captures, threats)* — themes: `short`,`long`. rating: 1500–1850
  - *L2 Candidate moves & elimination* — interactive
- **Unit B3.openings — Repertoire Deepening**
  - swappable PGN modules per opening (white d4/e4, black vs e4 / vs d4)

### BAND 4 — Advanced (1800–2000) · `ratingFloor: 1800`
Goal: prophylaxis, deep endgame theory, conversion technique, long forced sequences.

- **Unit B4.strategy — Prophylaxis & Maneuvering**
  - *L1 Prophylactic thinking (stop their plan first)* — interactive
  - *L2 Zugzwang & triangulation* — themes: `zugzwang`,`endgame`. rating: 1800–2050
- **Unit B4.endgame — Higher Endgame Theory**
  - *L1 R+2 vs R* — themes: `rookEndgame`. rating: 1800–2050 (authored fallback)
  - *L2 Queen endgames* — themes: `queenEndgame`. rating: 1800–2050
  - *L3 Conversion technique (winning won positions)* — themes: `advantage`,`crushing`. rating: 1800–2050
- **Unit B4.tactics — Long & Very-Long Combinations**
  - *L1 Mate in 4–5* — themes: `mateIn4`,`mateIn5`. rating: 1800–2050
  - *L2 Very-long forced lines* — themes: `veryLong`. rating: 1850–2100
- **Unit B4.attack — The Attacking Game**
  - *L1 Opposite-side castling races* — themes: `kingsideAttack`,`queensideAttack`. rating: 1800–2050
  - *L2 Sacrifices for the initiative* — themes: `sacrifice`. rating: 1800–2050

> **Coverage note:** ratings concentrate in ~1100–1600; **band ends (very low and ≥1900) need authored positions** to backfill thin pools. Each lesson's `fallbackThemes` plus an `authoredPositions` PGN module mitigate this.

---

# 2. PUZZLE THEME TAXONOMY & RATING-BAND MAPPING

Source: Lichess `puzzleTheme.xml` keys, used as the **schema enum** for `PuzzleTheme`. Themes are the **space-separated tokens** in the puzzle DB `Themes` column. Build step normalizes them into a `puzzle_theme(PuzzleId, Theme, Rating)` junction (covering index `(Theme, Rating, PuzzleId)`) for instant theme+rating selection.

## 2.1 Theme groups (enum)

```ts
export const THEME_ENUM = [
  // Motifs / tactics
  "advancedPawn","attackingF2F7","capturingDefender","discoveredAttack","doubleCheck",
  "exposedKing","fork","hangingPiece","interference","intermezzo","kingsideAttack",
  "pin","queensideAttack","sacrifice","skewer","trappedPiece","attraction","clearance",
  "deflection","defensiveMove","quietMove","xRayAttack","zugzwang","enPassant","castling",
  "promotion","underPromotion",
  // Mates
  "mate","mateIn1","mateIn2","mateIn3","mateIn4","mateIn5","anastasiaMate","arabianMate",
  "backRankMate","bodenMate","doubleBishopMate","dovetailMate","hookMate","killBoxMate",
  "vukovicMate","smotheredMate",
  // Phases
  "opening","middlegame","endgame",
  // Endgame types
  "pawnEndgame","rookEndgame","bishopEndgame","knightEndgame","queenEndgame",
  "queenRookEndgame",
  // Length
  "oneMove","short","long","veryLong",
  // Eval bands (advantage magnitude)
  "advantage","crushing","equality",
  // Goals / origins
  "mateGoal","master","masterVsMaster","superGM","playerGames",
  // Special
  "casual","healthyMix"
] as const;
export type PuzzleTheme = typeof THEME_ENUM[number];
```

## 2.2 Theme one-liner definitions (learner-facing tooltips)
Adapt-and-attribute from `puzzleTheme.xml` (AGPL UI **text** — paraphrase, credit Lichess). Examples shipped verbatim-ish:
- **fork** — one piece attacks two enemy pieces at once.
- **pin** — a piece can't move without exposing a more valuable one behind it.
- **skewer** — a valuable piece is attacked and forced to move, exposing a lesser one behind it.
- **discoveredAttack** — moving a blocking piece reveals an attack from a long-range piece behind it.
- **doubleCheck** — two pieces give check at once; only a king move escapes.
- **deflection** — distract a piece from a defensive duty (a.k.a. overloading).
- **capturingDefender** — remove the piece that defends another, then win it.
- **interference** — block the line between a defender and what it defends.
- **backRankMate** — mate on the back rank where the king is hemmed in by its own pawns.
- **trappedPiece** — a piece with no safe square is won.
- **hangingPiece** — an undefended piece can simply be taken.
- **zugzwang** — any move worsens the position; you'd rather pass.

## 2.3 Eval-band thresholds (from taxonomy)
- `equality` — `|eval| ≤ 200 cp`
- `advantage` — `200 ≤ eval ≤ 600 cp` ("decisive/clear advantage")
- `crushing` — `eval ≥ 600 cp`

These map to the verbal bands used by the coach (§3, §4): equal / slightly better / clearly better / winning / completely winning / forced mate.

## 2.4 Theme → rating-band coverage matrix
Approximate puzzle-Glicko **center of mass** per theme and recommended teaching band. "Pool" flags thin tags needing `fallbackThemes` / authored positions.

| Theme | Typical rating center | Intro band | Pool |
|---|---:|---|---|
| mateIn1 / oneMove | 700 | B0 | rich |
| hangingPiece | 850 | B0 | rich |
| fork | 950 | B1 | rich |
| pin | 1000 | B1 | rich |
| skewer | 1050 | B1 | medium |
| backRankMate | 1000 | B1 | medium |
| discoveredAttack | 1100 | B1 | rich |
| mateIn2 / short | 1200 | B2 | rich |
| deflection / attraction | 1300 | B2 | medium |
| capturingDefender | 1300 | B2 | medium |
| intermezzo | 1350 | B2 | medium |
| sacrifice | 1400 | B2/B3 | rich |
| pawnEndgame | 1300 | B2 | medium |
| interference | 1650 | B3 | **thin** |
| xRayAttack | 1650 | B3 | **thin** |
| quietMove | 1700 | B3 | **thin** |
| rookEndgame | 1650 | B3 | medium |
| zugzwang | 1900 | B4 | **thin** |
| queenEndgame | 1900 | B4 | **thin** |
| mateIn4 / mateIn5 / veryLong | 1950 | B4 | medium |

> **Selection query (runtime):** `SELECT p.* FROM puzzle_theme t JOIN puzzles p USING(PuzzleId) WHERE t.Theme=:theme AND t.Rating BETWEEN :lo AND :hi AND p.PuzzleId NOT IN (mastered) ORDER BY RANDOM() LIMIT :count`. On a thin pool (`< count`), retry with `fallbackThemes`, then with the authored-positions module.

---

# 3. LOCAL COACHING / EXPLANATION ENGINE

Four deterministic layers, all offline, no LLM:
**(A) classify magnitude → (B) diff the board → (C) detect motifs from PV → (D) fill templates.**

> All detector logic is **re-implemented** from documented behavior (Lichess `Advice.scala`, `winningChances.ts`, `practiceCtrl.ts`, lichess-puzzler `cook.py`/`util.py`, Chesskit) into clean BSD/MIT modules on top of **chess.js** primitives. Never paste AGPL/GPL source.

## 3.1 cp → Win% → Accuracy formulas

### Win% — see §0.2 (`winPercent`).

### Per-move Accuracy%
```ts
function moveAccuracy(winBefore: number, winAfter: number): number {
  // both 0..100, from the MOVER's POV (winAfter uses post-move position, mover's POV)
  if (winAfter >= winBefore) return 100;
  const winDiff = winBefore - winAfter;
  const acc = 103.1668 * Math.exp(-0.04354 * winDiff) - 3.1669 + 1; // +1 uncertainty bonus
  return Math.max(0, Math.min(100, acc));
}
```
Anchor table the curve fits (`winDiff → accuracy`): `0→100, 5→75, 10→60, 20→42, 40→20, 60→5, 80→0, 90→0, 100→0`.

### Game accuracy (whole game)
```
windowSize = clamp(round(totalMoves / 10), 2, 8)
For each move i:
  weight_i = clamp(stdDev(Win% over an ~centered window of size windowSize), 0.5, 12)
weightedMean = Σ(acc_i * weight_i) / Σ(weight_i)
harmonicMean = N / Σ(1 / acc_i)            // guard acc_i==0 with a small epsilon
gameAccuracy = (weightedMean + harmonicMean) / 2
```
**ACPL** (separate stat): mean per-move centipawn loss from the mover's view, each move's loss capped at ±1000 cp (and overall MAX_CPL guard ~2000). Lower = stronger. Report alongside accuracy, not instead of it.

## 3.2 Move classification thresholds

The same Win% engine drives **two intensities**. Compute the **POV-signed Win% drop** (`shift`, on the 0..1 chances scale) of the played move vs the position before it.

> **Factor-of-2 caveat:** `Advice.scala` buckets a chances **delta** (0..1) at `0.10 / 0.20 / 0.30`. The Practice tool buckets a `shift = -povDiff(...)` where `povDiff` already **halves** the chances difference, hence its tighter `0.025 / 0.06 / 0.14`. Keep them as **two separate functions**; don't reuse one helper across both.

### (a) Post-game REVIEW annotations (Lichess `Advice.scala`)
```ts
// delta = POV-signed (prevWinChances - currWinChances) on 0..1 chances scale
function reviewVerdict(delta: number): "blunder"|"mistake"|"inaccuracy"|"ok" {
  if (delta >= 0.30) return "blunder";
  if (delta >= 0.20) return "mistake";
  if (delta >= 0.10) return "inaccuracy";
  return "ok";
}
```

### (b) Live PRACTICE / "guess the move" (Lichess `practiceCtrl.ts`)
```ts
function practiceVerdict(shift: number, playedIsBest: boolean): string {
  if (playedIsBest) return "goodMove";          // best move (or equivalent castling) always good
  if (shift < 0.025) return "goodMove";
  if (shift < 0.06)  return "inaccuracy";
  if (shift < 0.14)  return "mistake";
  return "blunder";
}
```

### (c) Mate transitions (special-cased, `Advice.scala`)
```
cp -> mate(negative for mover)  => MateCreated
mate(positive) -> cp            => MateLost
mate(pos) -> mate(neg)          => MateLost
mate(pos) -> worse mate(pos)    => MateDelayed   (NOT annotated)

MateCreated severity: Inaccuracy if prevPovCp < -999; Mistake if < -700; else Blunder
MateLost severity:    Inaccuracy if povCp     >  999; Mistake if  > 700; else Blunder
```

### (d) Optional chess.com-style rich badges (Chesskit win%-diff model)
Use **clearly-labeled approximations** (chess.com's exact cp/depth and the "Brilliant/Great/Miss" names/icons are proprietary — use generic labels for shipping, see §7 design tokens). Operate on `winPercentageDiff` (signed to mover, 0..100 scale):
```
diff < -20  -> Blunder
diff < -10  -> Mistake
diff < -5   -> Inaccuracy
diff < -2   -> Good
else        -> Excellent
playedIsBest -> Best ;  position in opening book -> Book ;  single legal/forced -> Forced
```
- **Brilliant (internal label):** `diff ≥ -2` AND move is a **sound piece sacrifice** AND mover not losing AND the best **alternative** wasn't already winning (white < 97% / black > 3%).
- **Great:** `diff ≥ -2`, not a recapture, not losing, not already winning, AND (crossed the 50% line with `diff > 10`) OR (beats the 2nd-best line by > 10%). **Requires `MultiPV ≥ 2`.**

#### Sacrifice detector (Chesskit-style, for Brilliant/Great)
```
1. Play the candidate move; take the engine PV for the resulting position, truncated to EVEN length.
2. Cancel out matching captures along that PV (recaptures wash out).
3. If only single pawns remain in play -> NOT a sacrifice.
4. Material values P1 N3 B3 R5 Q9. If, after the wash, the MOVER ends up DOWN material -> it's a sacrifice.
```
Note: this never flags pure pawn sacrifices (known limitation — flag in UI copy if used).

## 3.3 Board-diff layer (what changed)

Given `posBefore`, `move`, `posAfter` and the engine eval swing, compute (all via chess.js `attackers()` / `isAttacked()` re-implementations):

- **material_diff** = signed material change for the mover.
- **newly hanging** = pieces that are `isHanging` in `posAfter` but were defended/safe in `posBefore`.
- **king-safety delta** = change in attacker count near each king / loss of pawn shield.
- **new threats** = enemy moves now winning material or giving mate that weren't available before.
- **mate threats created/removed**.

### Core primitives (port targets, chess.js-based)
```ts
const VAL = {p:1,n:3,b:3,r:5,q:9};
const KING_VAL = {...VAL, k:99};
const RAY = new Set(['q','r','b']);

// isDefended: square has a same-color attacker, OR (ray-defense reveal) removing a ray
//   attacker on the line reveals a same-color ray defender behind it.
// isHanging   = !isDefended(sq) && hasEnemyAttacker(sq)
// canBeTakenByLowerPiece = an enemy non-king attacker of strictly lower value exists
// isInBadSpot = hasEnemyAttacker(sq) && (isHanging(sq) || canBeTakenByLowerPiece(sq))
// isTrapped   = non-pawn/non-king piece in a bad spot, no legal escape to a non-bad square,
//               no equal-or-better capture available
```
> **chess.js gap:** there is no `pin()` / `is_pinned()`. Derive absolute pins/skewers via **ray scans toward the king** + king alignment. Budget time here — it's the trickiest primitive.

## 3.4 Motif detection from engine PV + board diff

Run detectors over the **engine best-move PV** (to explain the *best* move) and over the **played continuation** (to explain the *mistake*). Each detector is a pure boolean over node list + board states. **Gate every motif claim behind the engine eval swing** — assert "wins material via fork" only if the eval actually swings (static scans alone can be fooled by pins/in-between moves).

### fork
On a player move (not by the king) landing on a square that is **not in a bad spot**, count attacked enemy non-pawn pieces where either `KING_VAL[target] > KING_VAL[mover]` (forking something more valuable) **or** the target is hanging and not also defended by the moving piece. **count > 1 ⇒ fork.**

### skewer
After an opponent ray-piece move, the player captures on `opp.to` with a ray piece (Q/R/B); the opponent had moved **into** the between-squares of the capture line; `KING_VAL[opp] > KING_VAL[captured]`; and the capture lands in a bad spot. (The more valuable piece was in front, exposing the lesser behind.)

### pin (absolute / relative)
Derive via ray scan: an enemy piece on the line between an attacking ray piece and (a) the enemy king ⇒ **absolute pin**; (b) a more valuable enemy piece ⇒ **relative pin**. Sub-detectors:
- **pin_prevents_attack** — a pinned enemy piece can't defend a higher/hanging player piece.
- **pin_prevents_escape** — a pinned enemy piece can't flee its attacker along the pin line.

### discovered attack / discovered check / double check
- **discovered_check** = a checker exists that is **not** the square the player just moved to.
- **discovered_attack** = `discovered_check` OR a capture whose `from→to` between-squares contain the **previous player move's `from` square** (the piece that vacated the line), with the unveiled line distinct from the moved piece.
- **double_check** = `board.checkers().length > 1`.

### hanging piece
The piece captured on the first player move was a **non-pawn** that was `isHanging` in the prior position, and material is retained afterward.

### back-rank mate
Final position is checkmate; the mated king is on its back rank; its 2–3 escape squares one rank ahead are blocked by its own pieces or attacked; and ≥1 checker sits on the back rank.

### mate-net (general)
Final position `isCheckmate()`; narrate the forcing PV (`mateIn N`). For named patterns (smothered, Anastasia, Arabian, Boden, hook, dovetail, Vukovic, kill-box, double-bishop) match the known geometric signature; otherwise label generically "forced mate in N".

### deflection / interference (removing the guard)
- **deflection** — capture a piece that is `isHanging` only because a defending **ray** piece was distracted from its line.
- **interference** — capture a piece hanging only because an **interfering piece landed in `between(target, defender)`**, severing the defense.

### overloaded piece (app's own — Lichess `overloading()` is a stub returning False)
**Implement it:** a single enemy piece is the **sole defender of two or more** player targets (or one target + a key mating square); any move removing/distracting it wins material. Detect by: for each enemy piece D, collect the set of friendly-of-D squares whose only defender is D; if `|set| ≥ 2`, D is overloaded.

### capturing the defender / x-ray
- **capturing_defender** — remove the piece critical to defending another, then win the other.
- **x-ray** — a ray piece attacks/defends *through* an intervening piece along the same line.

## 3.5 Template-based NLG

Templates are **slot-fill** keyed by `(verdict) × (primary motif) × (fact slots)`. Maintain **3–5 surface variants per cell**, chosen by a **deterministic hash of `(ply, fen)`** so wording varies without an LLM and stays reproducible. Always keep a **guaranteed fallback** template. Only emit a *positional* comment when no tactical motif fired **and** a static-eval term crossed a notable threshold (new passed pawn, new outpost, lost pawn shield) — to avoid noise.

### Slot vocabulary
- `{playedSan}`, `{bestSan}`, `{pieceName}`, `{square}`, `{attackerSan}`, `{targetName}`, `{evalBand}` (equal / slightly better / clearly better / winning / completely winning / forced mate in N), `{evalBefore}`, `{evalAfter}` (formatted `+1.2` / `-0.8` / `M3`), `{n}` (mate distance).

### Minimal Lichess-style comment template (proven baseline)
```
[ "(" {evalBefore} " → " {evalAfter} ") " ]
( mate:  "Checkmate is now unavoidable." | "Lost forced checkmate sequence." | "Not the best checkmate sequence."
  | cp:  <VerdictWord> "." )
" " {bestSan} " was best."
```

### Verdict words & encouragement (adapt from `learn.xml`)
- Verdicts: `Inaccuracy`, `Mistake`, `Blunder`, `Best`, `Excellent`, `Good`, `Book`.
- Praise (solved): "Excellent!", "Great job!", "Perfect!", "Nailed it.", "You're good at this!"
- Retry (failed): "Retry", "Find a better move."

### Template cells (examples)

**blunder × hangingPiece**
```
"Blunder. After {playedSan}, your {pieceName} on {square} is undefended — {attackerSan} just takes it. {bestSan} keeps the position {evalBand}."
```
**mistake × fork (on the played move, you walked into it)**
```
"Mistake. {playedSan} lets {attackerSan} fork your king and {targetName}. Better was {bestSan}, staying {evalBand}."
```
**good/best × fork (explaining the best move)**
```
"{bestSan}! The knight forks the king and the {targetName} — you win material and end up {evalBand}."
```
**blunder × MateLost**
```
"Blunder. {playedSan} throws away a forced mate. {bestSan} mated in {n}."
```
**inaccuracy × positional (no tactic)**
```
"Slightly inaccurate. {playedSan} leaves you {evalBand}; {bestSan} kept more pressure (a new outpost on {square})."
```
**fallback (no motif fires)**
```
"{bestSan} was the strongest move here, keeping a {evalBand}."
```

### Best-move narration (PV walk)
Explain the engine's choice by narrating the first 2–4 plies of the PV with motif tags attached, then truncate (≤ ~10 half-moves or game end), and always show the resulting `{evalBand}`:
```
"Best was {san1}; after {san2} {san3} you win the {targetName} ({motif}), reaching {evalBand}."
```

### Worked example outputs

Position A — White to move has `Nf7+` forking K and Q (best is `Nf7+`, played `Bd3` losing the thread):
- Played `Bd3` (delta 0.34 ⇒ blunder):
  > "(+3.1 → +0.2) Blunder. **Nxf7+** was best — the knight forks the king and the queen, winning material and leaving you completely winning."

Position B — Black hangs a rook with `Rd8??` (best `Rc7`):
  > "Blunder. After **Rd8**, your rook on d8 is undefended — **Bxd8** just takes it. **Rc7** keeps the position equal."

Position C — Best move is a quiet mate-net `Qg4` (mate in 3):
  > "**Qg4!** Checkmate is now unavoidable — after **…Kh8 Qxh4+ Kg8 Qh7#** it's a forced mate in 3."

Position D — solved a training puzzle cleanly:
  > "Nailed it. The deflection **Rxe6** removes the defender of g7, and the mate follows."

---

# 4. SPACED REPETITION + LOCAL RATING

## 4.1 Spaced repetition — FSRS-6 (chosen over SM-2)

**Why FSRS-6:** separate Difficulty(1–10)/Stability(days-to-90%-recall)/Retrievability tracking; ~20–30% fewer reviews than SM-2 for equal retention; early lapses don't permanently wreck a card. Library: **ts-fsrs** (MIT, FSRS v6, Node ≥ 20).

### What becomes a card
A **failed puzzle**, a **recurring mistake pattern**, or an **opening line** to retain. One FSRS `Card` per reviewable item, keyed by the item id (e.g. `PuzzleId` or `lessonId#objective`).

### Card fields persisted
`stability, difficulty, due, state(New|Learning|Review|Relearning), reps, lapses, last_review, elapsed_days, scheduled_days`.

### Default parameters (ship as-is)
```
request_retention = 0.9   // desired retention
w (21 FSRS-6 weights) = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
  1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
  1.8729, 0.5425, 0.0912, 0.0658, 0.1542 ]
```
> **Never hand-edit the 21 weights.** Optionally re-optimize from the user's own review log later (fsrs-rs / optimizer) once there are hundreds of reviews. Defaults are population averages — only approximate for a single sparse user early on.

### Grade mapping (solve result → FSRS Rating)
```
failed OR needed a hint        -> Again (or Hard)
solved with ≥1 wrong attempt   -> Hard
solved clean                   -> Good
solved clean AND fast          -> Easy
```

### API usage (ts-fsrs)
```ts
import { createEmptyCard, fsrs, Rating } from "ts-fsrs";
const f = fsrs();                              // default params
let card = loadOr(createEmptyCard());          // from DB or new
const preview = f.repeat(card, now);           // all four outcomes (for UI "next due" hints)
const { card: next } = f.next(card, now, rating); // commit chosen rating
persist(next);                                 // store stability/difficulty/due/...
```
**Due query:** `SELECT * FROM srs_cards WHERE due <= :now ORDER BY due LIMIT :n`.

## 4.2 Local puzzle rating — Glicko-2 (Lichess-identical model)

Each puzzle attempt = **one rated game, player vs puzzle**, **binary** outcome (solved-before-any-wrong-move = 1 / failed = 0). The puzzle's bundled `Rating` / `RatingDeviation` are the **opponent**. Use a vetted lib (`glicko2` npm / `glicko2.ts`), not hand-rolled.

### Player state
```
rating     start 1500
RD         start 350     // grows with inactivity (apply RD-aging on idle gaps)
volatility start 0.06
```
### Per-attempt update
1. Treat the puzzle as the opponent with `(puzzleRating, puzzleRD)`.
2. Outcome `s ∈ {0,1}`.
3. Run one Glicko-2 step → new `(rating, RD, volatility)`.
4. **Clamp RD** to a sane floor/ceiling so a long idle gap or a streak doesn't cause wild swings.

### Uses of the user rating
- **Difficulty-matched selection:** pick puzzles within ±100 of the current rating for a lesson/free-play session.
- **Band gating:** a band's `ratingFloor` is checked against this estimate to unlock content.
- Display as **"puzzle difficulty rating"**, explicitly *not* FIDE Elo.

> Glicko-2 is designed for batched rating periods; per-attempt application (as Lichess does) is acceptable. Keep RD floors/ceilings to tame post-idle behavior.

---

# 5. CONTENT / PROGRESS PERSISTENCE (schema sketch)

Two databases, ATTACHed at runtime:
- **`puzzles.sqlite`** — read-only, bundled, built at ETL time from the Lichess CSV.
- **`user.sqlite`** — writable, in `app.getPath('userData')`; survives app updates.

```sql
-- puzzles.sqlite (read-only)
CREATE TABLE puzzles (
  PuzzleId TEXT PRIMARY KEY, FEN TEXT NOT NULL, Moves TEXT NOT NULL,
  Rating INTEGER NOT NULL, RatingDeviation INTEGER, Popularity INTEGER,
  NbPlays INTEGER, Themes TEXT, GameUrl TEXT, OpeningTags TEXT );
CREATE TABLE puzzle_theme (PuzzleId TEXT, Theme TEXT, Rating INTEGER);
CREATE INDEX idx_pt_theme_rating ON puzzle_theme(Theme, Rating, PuzzleId); -- covering
CREATE INDEX idx_puzzles_rating ON puzzles(Rating);

-- user.sqlite (writable)
CREATE TABLE user_rating (id INTEGER PRIMARY KEY CHECK(id=1),
  rating REAL, rd REAL, vol REAL, updated_at INTEGER);
CREATE TABLE attempts (id INTEGER PRIMARY KEY, puzzle_id TEXT, solved INTEGER,
  ms INTEGER, wrong_moves INTEGER, rating_before REAL, rating_after REAL, ts INTEGER);
CREATE TABLE srs_cards (item_id TEXT PRIMARY KEY, kind TEXT,
  stability REAL, difficulty REAL, due INTEGER, state INTEGER,
  reps INTEGER, lapses INTEGER, last_review INTEGER,
  elapsed_days INTEGER, scheduled_days INTEGER);
CREATE INDEX idx_srs_due ON srs_cards(due);
CREATE TABLE progress (lesson_id TEXT, objective_id TEXT, mastered INTEGER,
  accuracy REAL, solved_count INTEGER, updated_at INTEGER,
  PRIMARY KEY (lesson_id, objective_id));
CREATE TABLE games (id INTEGER PRIMARY KEY, pgn TEXT, event TEXT, white TEXT,
  black TEXT, result TEXT, date TEXT, eco TEXT);
PRAGMA user_version = 1;   -- bump per migration
```
**ETL gotcha:** Lichess `Moves` are UCI; `Moves[0]` is the **opponent setup move** — apply it to `FEN` to get the shown position; the **solution starts at `Moves[1]`**. Validate during import with chess.js.

---

# 6. ENGINE CONTRACT (what the coach consumes)

- **Bundle native Stockfish 18** (x86-64-universal on Windows; NNUE embedded — no loose `.nnue`). Spawn from the **Electron main process**, talk UCI over stdin/stdout; never spawn from renderer; route via IPC.
- **Session:** `uci`→`uciok`; set `Threads = max(1, cores-1)`, `Hash = 128–512 MB`; `isready`→`readyok`; `ucinewgame` on reset.
- **Coaching/review go:** `setoption name MultiPV value 2` (min, for Great/Brilliant), `go depth 20` (or `movetime 1500`). Parse streaming `info ... multipv i ... score cp|mate ... pv ...` until `bestmove`; keep the **latest line per multipv index**.
- **Strength bots:** `UCI_LimitStrength=true` + `UCI_Elo` (1320–3190) for rating-matched opponents; `Skill Level` (0–20) for beginner bots. Reset to full strength + `MultiPV 1` for pure analysis/play.
- **Reproducibility:** fix depth/nodes and **cache per-FEN+depth** so coaching text is stable across sessions.

---

# 7. DATA SOURCES & LICENSES (everything bundled)

> Decision dependency: **chessground/chessops are GPL-3.0**; if used, the app is already copyleft, so GPL piece sets/sounds add no burden. If you want permissive/closed, swap to MIT/CC assets and a non-GPL board. Ship an in-app **Credits/Licenses** screen; pin every source to a commit/release; verify `COPYING.md` at that SHA.

## 7.1 Engine & networks
| Asset | What | License | Obligation |
|---|---|---|---|
| Stockfish 18 (native binary) | analysis/coaching engine, NNUE embedded | **GPL-3.0** | ship GPL text + pointer to exact source/release tag; credit Leela (net = ODbL); run as separate UCI process |
| official-stockfish/networks | loose `.nnue` (only if not using embedded net) | GPL-3.0 / net ODbL | not needed at runtime (binary embeds net) |

## 7.2 Data (puzzles, openings, names, evals)
| Asset | Format | License | Notes |
|---|---|---|---|
| Lichess puzzle DB (`lichess_db_puzzle.csv.zst`) | zstd CSV, 10 cols, 6,014,381 rows (~300 MB / ~2 GB decompressed) | **CC0 1.0** | fully redistributable; decompress with `zstd --long=31 -d`; `Moves[0]` = opponent setup move |
| lichess-org/chess-openings | TSV → dist `eco,name,pgn,uci,epd` (~3,733 lines) | **CC0 1.0** | opening names + EPD keys; ep field only if legal ep exists |
| Polyglot `.bin` opening book | binary, 16-byte big-endian entries | **generate your own from CC0 Lichess PGNs** | community books (gmcheems-org) have mixed/unclear licenses — avoid; build clean book to be safe |
| Lichess open game DB (standard rated PGN) | `.pgn.zst` monthly | **CC0 1.0** | source for self-built book + explorer stats (filter high Elo) |
| puzzleTheme.xml / learn.xml (UI text) | XML strings | **AGPL-3.0 (text)** | adapt-and-attribute theme defs + praise vocab; don't copy verbatim into permissive modules |
| Lumbra's Gigabase | PGN/SCID | **CC BY-NC-SA 4.0** | **NON-COMMERCIAL — do NOT bundle** |
| Lichess Elite (nikonoel) / PGN Mentor | PGN | **unstated/ambiguous** | do not redistribute; rebuild from CC0 dumps |

## 7.3 Visual / audio assets
| Asset | License | Bundle? |
|---|---|---|
| chessground (board UI lib) | **GPL-3.0** | yes if accepting copyleft |
| Piece sets: cburnett, merida, mono, letter, pixel | **GPLv2+** | yes (cburnett = default) |
| Piece set: mpchess | **GPLv3+** | yes |
| Piece set: chessnut | **Apache-2.0** | yes (permissive) |
| Piece sets: fantasy, spatial, celtic (Monge) | **MIT** | yes (permissive) |
| Piece set: rhosgfx | **CC0** | yes (permissive) |
| Piece sets: kiwen-suwi, Firi, totoy, papercut | **CC BY 4.0** | yes (attribute) |
| Piece set: shapes | **CC BY-SA 4.0** | yes (attribute + SA) |
| Piece sets: **staunty, maestro, fresca, cardinal, icpieces, gioco, tatiana, dubrovny (sadsnake1), horsey, california, caliente, anarcandy, disguised, cooke, monarchy, xkcd** | **CC BY-NC-SA** | **NO — non-commercial** |
| Piece sets: alpha, chess7, companion, leipzig, reillycraig, riohacha, shahi-ivory-brown | freeware / no-deriv / no-license | **NO** |
| Board: flat-color CSS (brown/blue/green/purple) | trivial CSS, no image license | yes (preferred) |
| Board textures (wood/maple/marble…) | **AGPL-3.0** | only if accepting AGPL; else generate/buy CC0 |
| Sounds: futuristic, nes, piano, sfx (Enigmahack) | **AGPLv3+** | only if AGPL-OK |
| Sounds: **standard (default), robot, instrument, woodland, other** | **non-free / unclear** | **NO — do not ship** |
| Sounds: lisp | CC BY-NC-SA | **NO — non-commercial** |
| **Kenney audio packs** (UI/interface/impact) | **CC0** | **yes — recommended commercial-safe sound source** |

## 7.4 Libraries (runtime/build)
| Lib | Purpose | License |
|---|---|---|
| chess.js | move-gen, SAN/FEN, `attackers()`/`isAttacked()` for coach primitives | BSD-2-Clause |
| chessops | EPD keys, full PGN tree (variations/NAGs/comments), legality | GPL-3.0 |
| chessground | board rendering/interaction | GPL-3.0 |
| ts-fsrs | FSRS-6 scheduler | MIT |
| glicko2 / glicko2.ts | local user puzzle rating | MIT |
| better-sqlite3 (+ @electron/rebuild) | local SQLite (main process; rebuild for Electron ABI; mark external) | MIT |
| zstd / fzstd | decompress CSV at ETL | BSD/Apache |
| Lucide (icons) / Inter (font) | UI icon pack + tabular-figure font | MIT / SIL OFL |

## 7.5 Design tokens (for coaching/badge UI)
- **Classification badge colors** (generic labels — avoid chess.com's "Brilliant/Great/Miss" branding): Best `#649b3b`, Excellent `#5c8bb0`, Good `#7d9b58`, Book `#a88865`, Inaccuracy `#e0a44a`, Mistake `#e08a3c`, Blunder `#ca3431`. Always pair color **with an icon + label** (color-blind safety).
- **Eval bands → words:** ≤50cp equal · 50–150 slightly better · 150–300 clearly better · 300–600 winning · >600 completely winning · mate "forced mate in N".

---

## 8. Known gaps / risks to track
- **Overloading** is unimplemented upstream (deflection proxy only) — §3.4 specifies building it; ship that detector.
- **Win% constant drift** (`-0.00368208` vs `-0.004`) and **threshold scale** (Advice delta vs Practice halved shift) — keep separate, documented.
- **Motif false positives** in non-puzzle positions — always gate on the engine eval swing and fall back to the generic template.
- **Thin puzzle pools** at band extremes and rare themes (interference/xRay/quietMove/zugzwang/queenEndgame) — `fallbackThemes` + authored positions.
- **License contagion** — re-implement AGPL/GPL algorithms in clean BSD/MIT; keep Stockfish arms-length; honor CC-BY/SA/GPL attribution in the Credits screen; **never ship NC piece sets/sounds or the default Lichess "standard" sounds in a commercial build.**
- **FSRS defaults** are population averages — re-optimize only after hundreds of reviews; never hand-edit the 21 weights.
