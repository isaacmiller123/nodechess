# CHESS SCHOOL: MASTER CURRICULUM (the backbone)

> **Status:** draft 3 (LOGARITHMIC REWEIGHT), 2026-06-27. Authored to conform to
> **[SCHOOL-SPEC.md](SCHOOL-SPEC.md)** (binding, incl. the new **§2.2a "Logarithmic depth"** principle) and
> grounded in the real bundled puzzle DB (`resources/data/puzzles.sqlite`, 4,699,980 Lichess puzzles, ratings
> 399–3327) and the theme taxonomy in **[content-coaching.md](content-coaching.md) §1–2**.
>
> Every chapter is written against this document and cross-checked back against it.
> It defines the **full 40-chapter arc** plus detailed plans for **Batch 1 (chapters
> 1–5)**. Coach persona = **Viktor** (exacting old-school master). If anything here conflicts with
> SCHOOL-SPEC.md, **the spec wins**. Fix this doc.
>
> **Where the content actually is:** all 40 chapters shipped as JSON under
> `resources/curriculum/chapters/`. Batches 2–8 were authored from the §5 preview without ever being
> expanded to Batch-1 depth here, so for chapters 6–40 the shipped JSON is ahead of this document.

---

## 0. How to read this document (authoring contract)

### 0.1 What changed in draft 3 (and why): READ THIS FIRST

Draft 2 set a **26-chapter arc** with a strong 7-chapter foundation but a roughly-**even** chapter-per-band
distribution above the foundation (about one chapter per ~100-Elo band, 8→26). The user has now made a new
principle **binding** (SCHOOL-SPEC §2.2a):

> *"Higher Elo looks empty. Knowledge doesn't equal linear improvement. It's **LOGARITHMIC**. The more you
> learn the more there is to learn."*

**Improvement is logarithmic, not linear.** 0→500 is a handful of ideas (the rules, material safety,
mate-in-one). 1500→2000 is an enormous body: every major opening carries deep theory and many variations, the
middlegame plans multiply, the endgame catalogue is large (K&P, rook, bishop, knight, queen, opposite-bishops,
theoretical draws), calculation deepens, and positional understanding turns subtle. A curriculum that gives the
0→1000 span the same chapter density as the 1700→2000 span is **upside-down**. It makes the top look empty
exactly where the material is densest.

**The fix (this draft):**
1. **Keep the 7-chapter foundation (ch 1–7) intact**. It still matters enormously and is not gutted. Its
   plans are preserved and lightly updated (§2).
2. **Substantially expand the middle and especially the upper portion (~1200→2000+)** with many more chapters
   AND more lessons per chapter as the Elo climbs.
3. **Weight chapters logarithmically by tier** so each narrower high-Elo band carries *more* chapters than the
   wide low-Elo band below it. The top 300-point band (1700→2000+) is the **single heaviest** tier.
4. **Climb the lesson count** with Elo: foundation chapters ≈ 4–5 lessons; summit chapters ≈ 8–10. The deepest
   chapters (a major opening's full theory, the endgame catalogue) carry the most lessons.

**Total: 40 chapters** (was 26). The 14 new chapters sit **entirely in the middle and upper tiers**, and they add
the openings the 1400–2000 player must know (Caro-Kann, French, Scotch/open games, Queen's Gambit complex, Ruy
Lopez, the Indian defences, deep Sicilian), the **full endgame catalogue** split into the chapters it really
needs (K&P, rook, minor-piece, queen/complex, the theoretical catalogue), the **positional + calculation +
conversion** mastery layer, and an advanced-opening-theory chapter. Every one is grounded in a measured DB pool
(§3). The internal Elo band is still the **gating/grouping device only** (SCHOOL-SPEC §1) and is **never shown
to the user** (constraint 5); a chapter's identity is its **NAME**.

### 0.2 The lesson/chapter model (unchanged from the spec)
- **One chapter = one coherent theme** (SCHOOL-SPEC §2.2): an opening + its variations + arising tactics, OR a
  tactics family, OR a positional/middlegame idea, OR an endgame family. **No** rigid
  opening→middlegame→endgame inside a chapter (the user rejected it). Go **deep**, and *deeper, with more
  lessons,* as the Elo rises (the logarithmic principle applies inside the chapter too: a high-Elo opening
  chapter carries many variation lessons, a high-Elo endgame chapter many position-types).
- **A chapter has 4–10 lessons** (the spec's "3–6" is SOFT and explicitly *"higher-Elo topics may need more"*):
  **foundation ≈ 4–5, lower-middle ≈ 6–7, upper-middle ≈ 7–8, summit ≈ 8–10.** A lesson is the atom and is
  **NOT always an opening**: it can be an opening/system, a **variation** of the chapter opening (variations
  are *super important*, so go deep), a tactics lesson, a positional lesson, an endgame-scenario lesson, or a
  warm-up (SCHOOL-SPEC §2.1). When the chapter has an opening, it is **usually lesson 1**; later lessons expand
  the theme with variations + arising tactics + how to exploit common replies.
- **Each lesson carries Elo-appropriate warm-up AND cool-down puzzles where sensible** (SCHOOL-SPEC §2.1).
  Warm-up = slightly *below* target, to prime the pattern. Cool-down = at/slightly *above* band, to consolidate
  under pressure. Every puzzle theme below is a real key from the §2 taxonomy; every rating window is a real,
  populated slice of the bundled DB (§3).
- **Every chapter has a TEST** (SCHOOL-SPEC §4): **10–15 questions, ≥70 % to pass, 2 attempts, correct answers
  hidden on fail, fail-both ⇒ retake the whole chapter, takeable anytime.** Composition: **2–4 multiple-choice
  "key idea" questions**; the rest are **board questions**. Play the opening/line out, exploit the explained
  moves, and judge whether the opponent's move was **correct or a blunder**.
- **Progressive / cumulative (constraint 1):** every chapter assumes the learner has **mastered everything in
  all earlier chapters.** Each chapter below states an explicit **"assumes you already know"** line. No concept
  is used before the chapter that teaches it.
- **Internal Elo is grouping/gating ONLY (constraint 5):** each chapter carries an `internal Elo band` *for
  unlock ordering and difficulty grouping*. It is marked **INTERNAL-ONLY** and is **never rendered in the School
  UI.** The user sees the chapter NAME and a progress ring. Never a number.
- **Build order:** batches of 5, perfected and cross-checked before proceeding (SCHOOL-SPEC §7). This doc ships
  the full arc skeleton + the detailed Batch-1 plans; later batches get their detailed plans appended as each
  batch begins. 40 chapters ⇒ **8 batches** (§5).

### 0.3 Why 40 chapters, and why they cluster at the top (the logarithmic rationale)

The chapter count is **decoupled from "one 100-Elo band each"** (SCHOOL-SPEC §2.2a: *"a roughly-even
chapter-per-band distribution is WRONG"*). Chapters are allocated to **match how much real, drillable material
each region of strength contains**, which grows logarithmically with rating.

- **Tier A: the foundation is a small body of ideas, given the room it needs and no more (ch 1–7, internal
  0→820).** Rules, board vision, material safety, win-conditions, the elementary mates, mating-net recognition.
  Seven chapters is exactly right (draft 2's hard-won result; *kept intact*). The nominal span is "820 Elo
  points," but the *quantity of knowledge* is small, so even seven chapters over 820 points is **low density**,
  by design (~0.85 chapters per 100 Elo, the lowest in the school).
- **Tier B: the core tactics + first repertoire are a moderate body (ch 8–16, internal 820→1360).** The fork,
  pins/skewers, discovered/double attacks (each a full chapter where the DB is rich), then the first real
  openings (Italian, London, Scandinavian, Vienna) and the attacking-pattern + combination layer. Nine chapters
  over ~540 points (~1.67 per 100 Elo; roughly **double** the foundation's density).
- **Tier C: the upper-middle is a LARGE body (ch 17–28, internal 1360→1660).** Openings multiply and endgame
  theory and positional understanding begin in earnest: more open-game theory (Scotch/Four Knights/Petrov),
  **two more major Black defences (Caro-Kann, French)**, **K&P endgames**, **pawn structure**, the **Queen's
  Gambit / d4 closed-game complex**, the **Ruy Lopez**, the **Greek-gift sacrifice**, **Sicilian foundations**,
  **rook endgames**, **advanced quiet-move tactics**, the **Indian defences**. **Twelve chapters over just ~300
  points** (~4.0 per 100 Elo), already far denser than the entire 820-point foundation.
- **Tier D: the advanced tier is the LARGEST body of lessons (ch 29–40, internal 1660→2000+).** The full
  endgame catalogue (minor-piece, queen/complex, theoretical draws/wins), the deep Sicilian main lines,
  prophylaxis & positional mastery, opposite-side-castling attacks, deep calculation & defence, conversion
  technique, advanced opening theory + the Bong Cloud curiosity, strategic mastery, and the summit of long
  calculation + mate-in-4/5. **Twelve chapters carrying the deepest lessons** (8–9 each, **102 lessons**; the
  most of any tier) over the top ~340 points (~3.5 per 100 Elo). This is the densest *content* tier in the
  school: exactly where the user said it "looks empty" today.

**The distribution proves the shape (measured on the four tier sections of §1; verified this session):**

| Tier (chapters) | Internal-Elo span (nominal) | Width | Chapters | Chapters / 100 Elo | Lessons | Avg lessons/ch |
|---|---|---:|---:|---:|---:|---:|
| **A: Foundation** (ch 1–7) | 0 → 820 | 820 | **7** | **0.85** | 34 | 4.9 |
| **B: Core tactics + 1st repertoire** (ch 8–16) | 820 → 1360 | 540 | **9** | **1.67** | 54 | 6.0 |
| **C: Upper-middle** (ch 17–28) | 1360 → 1660 | 300 | **12** | **4.00** | 84 | 7.0 |
| **D: Advanced / summit** (ch 29–40) | 1660 → 2000+ | 340 | **12** | **3.53** | 102 | 8.5 |
| **Total** | 0 → 2000+ | n/a | **40** | n/a | **274** | 6.85 |

The **"chapters per 100 Elo"** column rises **0.85 → 1.67 → 4.00 → 3.53**. That *is* the logarithmic curve:
each narrower, higher band is far denser than the wide low band beneath it. The top tier dips a hair below C
only because its nominal span is capped at 2000 while its real content runs "2000+"; by every other measure D is
the heaviest tier: it carries the **most lessons (102)** and the **deepest chapters (8.5 avg, 8–10 each)**, and
ties C for the most chapters. The **avg-lessons/chapter** column rises monotonically **4.9 → 6.0 → 7.0 → 8.5**,
so the depth compounds with the chapter count. **Tiers C+D (ch 17–40) hold 24 of 40 chapters (60 %) and 186 of
274 lessons (68 %)**, while the whole foundation (ch 1–7, a wider Elo span) holds **7 chapters (18 %) and 34
lessons (12 %)**. The top is no longer empty. It is, correctly, the bulk of the school.

- **Not padding.** Every chapter has a distinct, named, drillable theme with a real puzzle pool (§3). The 14
  new chapters are all openings/endgames/positional-or-calculation themes a genuine 1400–2000 player must own;
  none duplicates another. 40 is the count the material *needs* once you accept that knowledge is
  logarithmic: quality over a round number, exactly as instructed.

### 0.4 Puzzle-window conventions used below
- `theme @ lo–hi` means: query `puzzle_themes WHERE Theme=theme AND Rating BETWEEN lo AND hi`. Multiple themes
  listed without "ALL" are an **OR-set**; "**ALL**" means require every theme on each puzzle. `OpeningTags`
  filters opening-arising tactics (963,839 puzzles carry tags; every named system below has a measured tagged
  pool, see §3.4).
- **DB floor is 399.** Nothing rated below 399 exists. For the earliest chapters the *effective* puzzle floor
  is **399–~650**; those chapters lean on the richest floor themes (`mate`, `mateIn1`, `hangingPiece`,
  `backRankMate`, `mateIn2`) and on **authored positions** for sub-400 ideas (piece movement, special moves, the
  elementary mates). This is the spec's documented "very-low band needs authored positions" case.
- **Thin-pool themes** (use `fallbackThemes` + authored positions): `pin`/`skewer`/`discoveredAttack`/
  `defensiveMove` **below ~800**; `smotheredMate`/`anastasiaMate`/`bodenMate`/`doubleBishopMate` **above ~1600**
  (named mates skew to 1200–1600); `queenRookEndgame`, `xRayAttack`, `underPromotion`, `mateIn5` at the high
  end. **Rich anywhere needed:** `mate`/`mateIn1`, `mateIn2`, `mateIn3`, `short`/`long`, `crushing`, `advantage`,
  `sacrifice`, `kingsideAttack`, `fork` (≥800), `pin`/`discoveredAttack`/`deflection`/`attraction` (≥1000),
  `rookEndgame`, `pawnEndgame`, `defensiveMove`/`quietMove`/`zugzwang`/`veryLong` (≥1500, and these *grow* with Elo).

---

## 1. THE FULL 40-CHAPTER ARC

A strictly cumulative, gap-free difficulty ladder. Each row: **chapter · NAME · internal Elo band
(INTERNAL-ONLY, never shown) · theme-type · planned lessons · one-line focus**. The internal band both
**orders** the arc and **gates unlocks** (SCHOOL-SPEC §1); it grows monotonically by floor. Bands below ~800
are deliberately **finer than 100 points** (the foundation has more than one must-master theme per 100 points);
bands above ~1400 **overlap and pack tightly** (many themes share a 100-point window because the material is
dense there, which is the logarithmic point).

### 1.1 Tier A: FOUNDATION (ch 1–7, internal 0→820) · *kept intact from draft 2*

| # | Chapter NAME (user-facing) | Internal Elo band (INTERNAL-ONLY) | Theme type | Lessons | One-line focus |
|--:|---|---|---|--:|---|
| 1 | **Meet the Board & Pieces** | 0–80 | foundation | 5 | Files/ranks/colours; how every piece moves **and captures**; make legal moves with intent. |
| 2 | **Special Moves & the Two Goals** | 80–160 | foundation | 4 | Castling, en passant, promotion; what a *check* is; the aim = mate / avoid mate. |
| 3 | **Check, Checkmate, Stalemate, and Mate in One** | 160–280 | foundation/mates | 5 | The three states; deliver **mate-in-one** with every piece; stalemate is a draw (the great trap). |
| 4 | **Piece Values & Never Hang a Piece** | 280–420 | foundation/safety | 5 | Point values; good vs. bad trades; **take the free piece**, don't leave yours *en prise*. |
| 5 | **Board Vision: Is It Defended?** | 420–560 | foundation/safety | 5 | Scan every piece; attackers-vs-defenders counting; capture least-valuable-first; the safety checklist. |
| 6 | **The Elementary Mates (heavy pieces)** | 560–700 | endgame | 5 | K+Q vs K, K+R vs K (the box), two rooks (the ladder); walk the king to the edge, never stalemate. |
| 7 | **Mating Nets: Mate in Two & the Back Rank** | 700–820 | mates | 5 | Mate-in-two pattern recognition; the **back-rank mate**; forcing the king into a box; first 2-move calc. |

### 1.2 Tier B: CORE TACTICS & FIRST REPERTOIRE (ch 8–16, internal 820→1400)

| # | Chapter NAME | Internal Elo band (INTERNAL-ONLY) | Theme type | Lessons | One-line focus |
|--:|---|---|---|--:|---|
| 8 | **The Fork: Winning Material by Double Attack** | 820–960 | tactics | 5 | Knight / pawn / queen forks; the **royal fork**; making a fork with a forcing first move. |
| 9 | **Pins & Skewers** | 960–1080 | tactics | 5 | Absolute vs. relative pin; pile on the pinned piece; the skewer (pin in reverse); endgame skewers. |
| 10 | **Discovered & Double Attacks** | 1080–1180 | tactics | 6 | Discovered attack, discovered **check**, **double check**; build and fire the battery; unmask the gun. |
| 11 | **Opening Principles & the Italian Game** | 1100–1220 | opening (system) | 6 | Centre/develop/castle/connect; a sound **Italian**; Two Knights, the Fried Liver, punish the bad copy. |
| 12 | **The London System** | 1180–1300 | opening (system) | 6 | The universal d4–Bf4 setup vs. everything; the …c5/…Qb6 lines; the Bxh7 / kingside-attack plan. |
| 13 | **The Scandinavian & Meeting 1.e4** | 1240–1340 | opening (system) | 6 | 1.e4 d5 as Black; …Qa5 / …Qd6; queen safety; common 1.e4 traps (Damiano, Englund refuted). |
| 14 | **The Vienna Game & Gambit** | 1300–1400 | opening (system) | 6 | 1.e4 e5 2.Nc3; the **Vienna Gambit** (f4); sharp king-hunts; the Bishop's-Opening move-order. |
| 15 | **Mating Patterns & Attacking the King** | 1300–1420 | mates/attack | 7 | Smothered, Anastasia, Arabian, hook, Boden; the f7/f2 attack; sacrifices that force a known mate. |
| 16 | **Removing the Guard: Combinations** | 1360–1480 | tactics (combos) | 7 | Deflection, attraction, clearance, capturing the defender, interference, the intermezzo; multi-move wins. |

### 1.3 Tier C (UPPER-MIDDLE): openings multiply, endgames and positional play begin (ch 17–28, internal 1360→1720)

*(Bands overlap heavily here: many dense themes share each 100-point window. This is the start of the
logarithmic bulge.)*

| # | Chapter NAME | Internal Elo band (INTERNAL-ONLY) | Theme type | Lessons | One-line focus |
|--:|---|---|---|--:|---|
| 17 | **The Scotch & the Open Games** | 1360–1470 | opening (system) | 6 | 1.e4 e5 beyond the Italian: the **Scotch**, Scotch Gambit, **Four Knights**, the **Petrov/Russian** defence. |
| 18 | **The Caro-Kann Defence** | 1400–1500 | opening (system) | 6 | 1.e4 c6: the Advance, Exchange, Classical and main lines; the solid structure, the good light-squared bishop, the …c5 break. |
| 19 | **King & Pawn Endgames** | 1420–1520 | endgame | 7 | Opposition, key squares, the rule of the square, the outside passed pawn, triangulation, breakthroughs. |
| 20 | **The French Defence** | 1440–1540 | opening (system) | 6 | 1.e4 e6: the Advance, Exchange, Knight/Tarrasch lines; the bad bishop, the …c5/…f6 breaks, the chain. |
| 21 | **Pawn Structure & Weak Squares** | 1480–1580 | positional | 7 | Outposts, open/half-open files, good vs. bad bishop, isolated/backward/doubled pawns, the minority attack. |
| 22 | **The Queen's Gambit & the d4 Closed Games** | 1500–1600 | opening (system) | 7 | 1.d4 d5: QGD (Orthodox/Exchange), the **Slav/Semi-Slav**, the QGA; the IQP, the carlsbad structure. |
| 23 | **The Sacrifice & the Greek Gift** | 1520–1620 | tactics/attack | 7 | The intermezzo recap; the **Bxh7+** Greek-gift sacrifice; the exchange sac; sound vs. unsound sacrifice. |
| 24 | **The Ruy Lopez (Spanish)** | 1540–1640 | opening (system) | 7 | 1.e4 e5 2.Nf3 Nc6 3.Bb5: the Morphy Defence, the Marshall, the Berlin, the Exchange; the closed-centre plans. |
| 25 | **The Sicilian Defence: Foundations** | 1560–1660 | opening (system) | 7 | 1.e4 c5: the **Open Sicilian** vs. the **Alapin/Closed/Smith-Morra**; the pawn-structure plans, typical breaks. |
| 26 | **Rook Endgames** | 1580–1680 | endgame | 8 | Lucena (build the bridge), Philidor (third-rank defence), rook on the 7th, the active rook, the cut-off king. |
| 27 | **Advanced Tactics: Quiet Moves & X-Rays** | 1600–1700 | tactics | 8 | Trapped pieces, interference, x-ray/battery, the **quiet move**, the in-between defence; non-forcing wins. |
| 28 | **The Indian Defences: King's Indian & Nimzo** | 1620–1720 | opening (system) | 8 | 1.d4 Nf6: the **King's Indian** (…g6 pawn-storm) and the **Nimzo-Indian** (…Bb4, doubled pawns vs. bishop pair). |

### 1.4 Tier D (ADVANCED): the full catalogue + deepest theory + the summit (ch 29–40, internal 1660→2000+)

*(The heaviest tier: 12 chapters over ~300 nominal points, the densest in the school.)*

| # | Chapter NAME | Internal Elo band (INTERNAL-ONLY) | Theme type | Lessons | One-line focus |
|--:|---|---|---|--:|---|
| 29 | **Prophylaxis & Positional Mastery** | 1660–1760 | positional | 8 | Stop their plan first; the bishop pair, the two-weaknesses principle, piece manoeuvring, when to release tension. |
| 30 | **The Sicilian Defence: Main Lines** | 1680–1780 | opening (system) | 8 | The **Najdorf**, the **Dragon** (Yugoslav Attack), the Scheveningen/Taimanov; opposite-wing races, …d5 breaks. |
| 31 | **Minor-Piece Endgames** | 1700–1800 | endgame | 8 | Bishop vs. knight, the good/bad bishop in the endgame, **opposite-coloured bishops**, knight vs. pawns, fortresses. |
| 32 | **Attacking with Opposite-Side Castling** | 1720–1820 | attack | 8 | Pawn storms, the race, sacrifices to open files/rip the shield, the exposed king, defence under fire. |
| 33 | **Queen & Complex Endgames** | 1740–1840 | endgame | 8 | Queen vs. pawn(s), queen-and-pawn endings, queen+rook, perpetual-check defence, the principle of activity. |
| 34 | **Deep Calculation & Defence** | 1760–1860 | calculation | 9 | Candidate moves & elimination, forcing-moves-first, the **only-move defence**, prophylactic calculation, blunder-checks. |
| 35 | **Conversion: Winning Won Positions** | 1780–1880 | technique | 8 | Trade into a won endgame, two weaknesses, do-not-hurry, avoid the swindle, **zugzwang** to finish, the safe win. |
| 36 | **Endgame Theory: Theoretical Draws & Wins** | 1800–1900 | endgame | 9 | The wrong-rook-pawn draw, the Vancura, R-vs-R+P, the fortress, the breakthrough, the catalogue of known results. |
| 37 | **The d4 Indian Complex & Flank Openings** | 1820–1920 | opening (system) | 9 | The **Grünfeld**, the **Benoni/Benko**, the **Catalan**, the **English/Réti**; transpositions and the modern flank. |
| 38 | **Advanced Opening Theory & the Bong Cloud** | 1850–1950 | opening + curiosity | 9 | Move-order subtleties, the gambit-or-decline decision, novelties & traps; **Bong Cloud** as a labeled king-safety lesson. |
| 39 | **Strategic Mastery: The Complete Middlegame** | 1880–1980 | positional/strategy | 9 | Dynamic vs. static, the pawn-sac for initiative, the exchange sac for a bind, long-term compensation, the plan. |
| 40 | **Long Calculation & Mate in 4–5** | 1950–2000+ | calculation/mates | 9 | Candidate moves under depth, very-long forced lines, **mate-in-4 and mate-in-5**, the cleanest forcing path. |

---

### 1.5 Progression logic (strictly cumulative, no gaps)

- **Ch 1–7: the foundation (~0–820).** Rules & board vision → material safety → win-conditions & mate-in-one →
  the elementary mates → mating-net recognition. *Tactics-before-openings*, *fundamentals before the fork*. By
  ch 7 the learner finishes a won game and calculates a 2-move mate. **Kept intact** from draft 2.
- **Ch 8–10: the core tactics (~820–1180).** Fork → pins/skewers → discovered/double attacks: the three
  double-attack/line families, each a full chapter where the DB is rich (§3). The fundamentals recognised as
  fundamentals.
- **Ch 11–16: first repertoire + patterns (~1100–1480).** A full White repertoire (Italian e4, London d4),
  Black's Scandinavian vs. 1.e4, the sharp Vienna; then **mating patterns** (named mates as concrete attacking
  targets) and **combinations** (chaining the ch 8–10 motifs with the removing-the-guard family). The openings
  now have something to aim at.
- **Ch 17–28: the upper-middle bulge (~1360–1720).** Openings multiply (Scotch/open games, Caro-Kann, French,
  the Queen's Gambit complex, the Ruy Lopez, Sicilian foundations) **interleaved with** the first deep
  non-opening layers the same player needs at the same time: **K&P endgames (19)**, **pawn structure (21)**,
  **the sacrifice/Greek gift (23)**, **rook endgames (26)**, **advanced quiet-move tactics (27)**, and the
  **Indian defences (28)**. Twelve chapters over ~300 nominal points. The density crosses the foundation's.
- **Ch 29–40: the summit (~1660–2000+).** The **full endgame catalogue** (minor-piece 31, queen/complex 33,
  the theoretical catalogue 36) plus the deep openings (Sicilian main lines 30, the d4 Indian/flank complex 37,
  advanced opening theory 38), the **positional + calculation + conversion** mastery layer (prophylaxis 29,
  opposite-side attack 32, deep calculation/defence 34, conversion 35, strategic mastery 39), and finally **long
  calculation + mate-in-4/5 (40)**. Twelve chapters: the densest tier, where the user said the old arc "looked
  empty."
- **Bong Cloud** is deliberately at **ch 38**: by then the student understands king safety, move-order, and
  opening theory deeply enough to study a famous *violation* as a teaching contrast (the one serious idea inside
  it, king activity or stepping out of a pin), framed honestly as a labeled curiosity per SCHOOL-SPEC §8.

**Internal-band overlaps are intentional and *increase* with Elo.** Low bands are finer than 100 points (the
foundation packs several must-master themes per 100); high bands overlap heavily (e.g. ch 24=1540–1640,
25=1560–1660, 26=1580–1680) because many dense themes legitimately share a window up there. That overlap *is*
the logarithmic density. Unlock gating uses the band **floor** (you unlock ch N when your estimate reaches its
floor); the test (SCHOOL-SPEC §4) corrects mis-placements. The ordering 1→40 is the canonical path.

---

## 2. DETAILED PLANS: BATCH 1 (chapters 1–5)

> Authoring note for every Batch-1 chapter: the DB floor is **399**. Use the **399–~650** windows as your real
> puzzle floor and **author positions** for anything below that (piece movement, special moves, the elementary
> mates). Keep Viktor's voice exacting but encouraging. These are total beginners. Every board must be a
> **legal position**; every opening line **sound**; every puzzle a **real DB row** in the stated theme+window
> (or an authored position clearly tagged `authored`). PLAY each line/scenario out before finalizing
> (SCHOOL-SPEC §7.3). Batch 1 is the **deep foundation**: do not rush it; this is the material the user said
> "matters enormously." *(These five chapters are unchanged in substance from draft 2; the reweight is above
> them in the arc.)*

---

### CHAPTER 1: Meet the Board & Pieces · internal Elo 0–80 *(INTERNAL-ONLY, never shown)*

**Assumes you already know:** *nothing*. This is the first chapter and the true zero point.

**Theme:** Absolute orientation. The board's geometry and how **every piece moves and captures**, drilled on
interactive boards until the learner can make any legal move on purpose. *Foundation* chapter. No opening, no
engine; lesson 1 is pure warm-up. Goal: *I can find any square, and I can move and capture with every piece.*

**Lessons (5):**

1. **"The Board: Squares, Files, Ranks, Colours" (warm-up / interactive)**, *type: warmup.*
   Teaches: files **a–h**, ranks **1–8**, naming a square (e4, g7), light vs. dark squares, the rule **"light
   square on the right,"** the centre (e4/d4/e5/d5) vs. the rim. Drills: *click e4*; *click every dark square
   on the 4th rank*; *which colour is h1?* Pure interactive boards.
   - Warm-up puzzles: none (orientation).
   - Cool-down puzzles: none. Interactive "find the square" tasks only (authored). This lesson is navigation,
     not tactics.

2. **"Rook, Bishop, Queen: the Long-Range Pieces" (interactive)**, *type: warmup/interactive.*
   Teaches: **rook** (ranks & files, any distance), **bishop** (diagonals, stays one colour forever), **queen**
   (rook + bishop combined: the most powerful piece), and that long-range pieces are **blocked** by other
   pieces (they cannot jump). Capturing = landing on an enemy piece's square. Drills: *move the rook from a1 to
   a8*; *which squares does a bishop on c1 reach?*; *capture the undefended pawn with the queen.*
   - Warm-up puzzles: none.
   - Cool-down puzzles: `oneMove @ 399–520` filtered to **single obvious captures with a rook/bishop/queen**
     (author selects rook/bishop/queen instances), practice making one clean legal capture. Fallback: authored
     single-capture boards.

3. **"Knight, Pawn, King: the Short-Range Pieces" (interactive)**, *type: warmup/interactive.*
   Teaches: the **knight** (the L / "two-and-one," and its superpower: it **jumps over** pieces), the **pawn**
   (moves straight **forward** one square, the **two-square** first move, captures **diagonally**; the single
   most confusing rule for beginners, drill it hard), and the **king** (one square in any direction; the king
   can capture but is never itself captured). Drills: *move the knight g1→f3*; *the pawn on e2: show its move
   squares vs. its capture squares*; *capture the pawn diagonally.*
   - Warm-up puzzles: none.
   - Cool-down puzzles: `oneMove @ 399–520` filtered to **knight/pawn captures** (author-selected). Fallback:
     authored knight-fork-free single-capture boards.

4. **"How Pieces Capture & Relative Power" (interactive + judgment)**, *type: positional/concept.*
   Teaches: capturing is *replacing* the enemy piece on its square (except en passant, taught ch 2); which
   pieces are "worth more" at a feel level (queen > rook > bishop ≈ knight > pawn: full values come in ch 4);
   and *which squares a piece controls* (a queen on d4 hits a whole cross + both diagonals). Drills: *click
   every square the queen on d4 attacks*; *which of these two captures wins the bigger piece?* (intuition only, no counting yet).
   - Warm-up puzzles: `oneMove @ 399–520` (any clean single capture).
   - Cool-down puzzles: `hangingPiece @ 399–550` framed simply as *"an enemy piece sits undefended. Capture
     it."* Pool ~10.4k at floor: abundant. (The gentlest real "win material" task; previews ch 4.)

5. **"Putting It Together: Make the Right Move" (interactive drill)**, *type: warmup/drill.*
   Teaches: combining everything. On a small, calm position, *find a legal move that does something useful*
   (develop toward the centre, capture a free piece, get the king off the back row). No tactics beyond "take
   what's free." Reinforces piece movement under mild choice pressure. 6–8 guided boards.
   - Warm-up puzzles: `hangingPiece @ 399–550` (take the free piece).
   - Cool-down puzzles: `hangingPiece @ 450–600` (slightly harder free captures). Fallback `oneMove @ 450–600`.

**Chapter 1 TEST (10 questions): blueprint**
- **Multiple-choice key-idea (3):**
  1. "How does a pawn capture?" → *diagonally forward (it moves straight but captures diagonally).*
  2. "Which piece can jump over other pieces?" → *the knight.*
  3. "A bishop that starts on a light square will, for the whole game, stay on:" → *light squares only.*
- **Board questions (7):**
  - **(×3) Move identification:** *click every square the rook / bishop / knight on the marked square can move
    to.* Verifies movement of each long- and short-range piece. Authored boards.
  - **(×2) Make the capture:** a free enemy piece sits in range; *capture it with the correct piece* (one with
    a long-range piece, one with the knight or pawn). From `hangingPiece @ 399–550` (single-capture instances)
    or authored.
  - **(×1) Square colour / geometry:** *click h1's colour* type item, or *click the only dark square the queen
    on d4 attacks on the 7th rank.* Authored.
  - **(×1) Judge the move (correct-or-blunder):** two boards, a piece "captures" by moving like the wrong piece
    (e.g. a rook moving diagonally) → that is **illegal / a blunder of understanding**; vs. a correct legal
    capture → **correct**. (Trains legality, the bedrock for everything later.)

---

### CHAPTER 2: Special Moves & the Two Goals · internal Elo 80–160 *(INTERNAL-ONLY, never shown)*

**Assumes you already know:** *Chapter 1*. Every piece's movement and capture, the board's geometry, and how
to make a clean legal move. (We now add the special moves and the concept of *check*.)

**Theme:** The three special moves (castling, en passant, promotion), the meaning of **check** (your king is
attacked, so you must respond), and the **point of the game**: deliver checkmate, avoid being mated.
*Foundation* chapter. Goal: *I can castle, promote, and play en passant; I recognise check and know I must
answer it.*

**Lessons (4):**

1. **"Castling: Get Your King Safe" (interactive)**, *type: warmup/interactive.*
   Teaches: **O-O** (kingside) and **O-O-O** (queenside): king two squares toward the rook, the rook hops over.
   The conditions, stated plainly: king & that rook **unmoved**, **no pieces between**, king **not in check**,
   and the king does **not pass through or land on** an attacked square. Why we castle: king safety + rook
   activation. Drills: *castle kingside*; *here you may NOT castle: why?* (king in check / square attacked).
   - Warm-up puzzles: none (interactive).
   - Cool-down puzzles: `castling @ 800–1000` **if available** (the `castling` theme is sparse, only a few
     thousand rows and mostly higher); otherwise **authored** castling positions. Tag authored.

2. **"En Passant & Promotion: the Pawn's Special Powers" (interactive)**, *type: warmup/interactive.*
   Teaches: **en passant**. The one-time diagonal capture of an enemy pawn that *just* made its two-square
   jump, landing beside yours; show the exact trigger and that the chance is lost if not taken immediately.
   **Promotion**: a pawn reaching the last rank becomes a **queen** (or under-promotes to R/B/N); the queening
   is usually decisive. Drills: the canonical e5×d6 e.p. trigger; promote a7–a8=Q; an under-promotion to a
   knight that gives check.
   - Warm-up puzzles: `promotion @ 399–650` (push it and it queens / wins). Pool ~3.4k at floor: modest but
     real; fallback `advancedPawn @ 399–650` (~5k).
   - Cool-down puzzles: `promotion @ 500–700` **OR** `advancedPawn @ 500–700`. Fallback authored e.p. boards
     (the `enPassant` tag is nearly empty at the floor, so **author** e.p. positions).

3. **"Check: Your King Is Attacked" (interactive + judgment)**, *type: positional/rules.*
   Teaches: **check** = the king is under attack and you **must** respond *this move* by one of exactly three
   means: **move** the king, **block** the line (only vs. a ray piece), or **capture** the checker. You may
   never leave your king in check, and you may never move into check. Show all three escapes from one position;
   show an illegal "ignore the check" attempt and why it's not allowed.
   - Warm-up puzzles: `mate @ 399–520` framed as *"the king is in check: which response is legal?"* (use the
     huge `mate` pool, ~156k at floor, but ask only for a legal check-escape, not yet for mate).
   - Cool-down puzzles: `mateIn1 @ 399–520` framed gently as *"give a check"* / *"escape the check"*. Picks
     where the only good move is forcing. Pool ~47k at floor.

4. **"The Goal of Chess: Mate, and What a Game Is" (concept + guided)**, *type: positional/concept.*
   Teaches: the **object of the game**. Trap the enemy king so it can't escape check (**checkmate**) while
   keeping your own safe; a game is a sequence of legal moves toward that goal; resignation/draw exist but the
   target is mate. Preview (no technique yet): show one clean checkmate and name it "checkmate: the king cannot
   escape, block, or capture." This sets up Chapter 3. Drills: *which of these positions is the king trapped
   in?* (intuitive, full definitions next chapter).
   - Warm-up puzzles: `mate @ 399–550` (recognise "this position is already mate").
   - Cool-down puzzles: `mateIn1 @ 399–550` (*deliver* the mate: a first taste; fully taught in ch 3). Pool
     ~47k–54k at floor: abundant.

**Chapter 2 TEST (11 questions): blueprint**
- **Multiple-choice key-idea (3):**
  1. "Which is NOT a condition for castling?" → *(answer: the king must have been checked at least once; it
     must NOT be in check; the real conditions are unmoved K+R, empty between, not in/through/into check).*
  2. "When can you capture en passant?" → *immediately after the enemy pawn makes its two-square jump beside
     yours, and only that move.*
  3. "When your king is in check you may:" → *move it, block the check, or capture the checker (not ignore it).*
- **Board questions (8):**
  - **(×2) Castle correctly:** *play O-O* / *play O-O-O* from a legal setup. Authored.
  - **(×1) Spot the illegal castle:** two boards; *click the position where castling is NOT allowed* (king in
    check / passes through an attacked square). Authored.
  - **(×1) Play en passant:** the trigger is on the board; *make the en-passant capture.* Authored.
  - **(×1) Promote:** *push the pawn and promote to a queen* (or the winning under-promotion). From
    `promotion @ 399–650` or authored.
  - **(×2) Escape the check:** two positions; *play a legal response to check* (one by moving, one by blocking
    or capturing). From `mateIn1`/`mate @ 399–550` (check-escape instances) or authored.
  - **(×1) Judge the move (correct-or-blunder):** a side "responds" to check with an unrelated move that leaves
    the king attacked → **illegal / blunder**; vs. a correct capture-of-the-checker → **correct**.

---

### CHAPTER 3: Check, Checkmate, Stalemate, and Mate in One · internal Elo 160–280 *(INTERNAL-ONLY, never shown)*

**Assumes you already know:** *Chapters 1–2*. Piece movement & capture, the special moves, and what *check* is
and that it must be answered. (We now distinguish checkmate from stalemate and learn to **deliver mate in one**
with every piece.)

**Theme:** The three end states. **check** (recap), **checkmate** (in check, no legal escape ⇒ game over),
**stalemate** (NOT in check, no legal move ⇒ **draw**; the great beginner trap), and the first real finishing
skill: **mate-in-one** with the queen, rook, minor pieces, and pawns. *Foundation/mates* chapter. Goal: *I never
confuse mate with stalemate, and I can find and deliver a mate-in-one with any piece.*

**Lessons (5):**

1. **"Checkmate vs. Stalemate. Know the Difference" (interactive + judgment)**, *type: positional/rules.*
   Teaches: **checkmate** (king in check, no move/block/capture saves it; you win) vs. **stalemate** (king NOT
   in check but the side to move has **no legal move**. It's a **draw**, throwing away a win). The single
   contrast drill that defines the chapter: *same position, two candidate moves (one mates, one stalemates)
   pick the mate.* Show the classic K+pawn stalemate where the stronger side blunders the full point.
   - Warm-up puzzles: `mate @ 399–550` (recognise the position is already mate, not stalemate).
   - Cool-down puzzles: `mateIn1 @ 399–550` (deliver the mate). Plus an authored **mate-or-stalemate pair set**
     (the defining drill). Pool abundant.

2. **"Mate in One: the Queen" (tactics)**, *type: tactics.*
   Teaches: the most common beginner mate. The **queen**, supported by a friendly piece or its own king, next
   to the enemy king (the "kiss of death"), or on a rank/file with the king boxed. The two questions on every
   candidate: *is the king attacked?* and *can it escape, block, or capture?* If "no" to all three, it's mate.
   3–4 model queen mates, then drill.
   - Warm-up puzzles: `mate @ 399–520` (spot that a queen check is mate).
   - Cool-down puzzles: `mateIn1 @ 450–600` **ALL** with `short`/`oneMove` (clean queen one-movers). Abundant.

3. **"Mate in One: the Rook & the Back Rank" (tactics)**, *type: tactics.*
   Teaches: the **rook** mate on a rank or file with the king's escape squares covered, and the first sight of
   the **back-rank** shape (the enemy king trapped on its home rank by its own pawns; a rook/queen delivers
   mate). Why back-rank mates happen and how a single rook can finish a game. 4 model rook/back-rank mates.
   - Warm-up puzzles: `mateIn1 @ 399–550` (rook mates).
   - Cool-down puzzles: `backRankMate @ 450–650` **OR** `mateIn1 @ 500–650`. `backRankMate` skews low and is
     rich at the floor (~40k under 600): use it. (Full back-rank exploitation returns in ch 7.)

4. **"Mate in One: Minor Pieces & Pawns" (tactics)**, *type: tactics.*
   Teaches: the *less obvious* mate-in-ones. A **bishop** or **knight** delivering the final blow (often a
   supported or discovered check), and a **pawn** mate. Reinforces that **any** piece can give mate, so you must
   check every checking move. 4 model positions across piece types, then mixed drilling.
   - Warm-up puzzles: `mateIn1 @ 399–550` (mixed).
   - Cool-down puzzles: `mateIn1 @ 500–650` filtered to **minor-piece / pawn** mates (author-selected). Fallback
     `mate @ 500–650`.

5. **"Find the Mate in One, Mixed Drill" (tactics)**, *type: tactics.*
   Teaches: the integration skill. Given any position, **scan all checks**, and find the one that is mate.
   Builds the habit "checks first." Mixed sources across all piece types and both back-rank and open-king
   shapes. Heavy drilling. This is the chapter's payoff.
   - Warm-up puzzles: `mateIn1 @ 450–600` (mixed).
   - Cool-down puzzles: `mateIn1 @ 550–700` **ALL** `short` (slightly harder one-movers). Pool ~92k in
     `mateIn1`@600–800: abundant. Fallback `mate @ 550–700`.

**Chapter 3 TEST (12 questions): blueprint**
- **Multiple-choice key-idea (3):**
  1. "You are not in check but have no legal move. The result is:" → *stalemate: a draw.*
  2. "To check whether a move is checkmate, you confirm the enemy king cannot:" → *move, block, or capture (all
     three).*
  3. "Which is true?" → *any piece (even a pawn) can deliver checkmate.*
- **Board questions (9):**
  - **(×4) Deliver mate-in-one:** four positions across piece types (queen, rook/back-rank, minor, pawn); *play
    the move that is checkmate.* From `mateIn1 @ 399–650`.
  - **(×1) Mate, not stalemate:** two candidate moves shown in a winning position; *play the one that mates*
    (the other stalemates). Authored.
  - **(×1) Spot the stalemate:** two finished positions; *click the one that is a draw by stalemate* (vs. a
    checkmate). Authored.
  - **(×2) Is it mate?** a board + claim; *judge* "is this checkmate?". One yes, one no (the king has an escape
    / can capture the checker). Board judgment.
  - **(×1) Judge the opponent's move (correct-or-blunder):** the opponent had a mate-in-one and instead played a
    non-mating move → **blunder** (missed mate); or correctly delivered the mate → **correct**.

---

### CHAPTER 4: Piece Values & Never Hang a Piece · internal Elo 280–420 *(INTERNAL-ONLY, never shown)*

**Assumes you already know:** *Chapters 1–3*. Full legal play, the special moves, the end states, and how to
deliver mate-in-one. (We now add **material**: what pieces are worth, how to win free material, and how never to
give it away.)

**Theme:** Material literacy and the single most important practical-strength skill below ~1000. **don't give
pieces away, and take the ones your opponent gives you.** Point values, good vs. bad trades, the "is it
defended?" reflex, and saving your own attacked pieces. *Foundation/safety* chapter. Goal: *I never hang a piece
for free, and I always grab a free one.*

> Data note: `hangingPiece` is the true floor tactic. ~10.4k at 399–600, ~13.5k at 600–800, ~20k at 800–1000.
> Abundant for this whole chapter. `defensiveMove` is **thin at the floor** (63 under 600, ~800 at 600–800) and
> only rich at 1400+, so "save your piece" leans on **authored** positions + `hangingPiece` reframes here; the
> real `defensiveMove` drilling comes much later (ch 27, 34).

**Lessons (5):**

1. **"What the Pieces Are Worth" (warm-up / concept)**, *type: warmup.*
   Teaches: the point values (**pawn 1, knight 3, bishop 3, rook 5, queen 9, king ∞**) and the meaning of a
   **good trade** (give less, get more) vs. a **bad trade** (give more, get less). The bishop-pair nuance is
   mentioned lightly (two bishops are a touch better than 3+3 suggests) but kept simple. Drills: *which capture
   wins the most material?*; *is rook-for-bishop a good trade for you?* (no; you lose 2 points).
   - Warm-up puzzles: `hangingPiece @ 399–550` (take the free piece, primes "material matters").
   - Cool-down puzzles: `hangingPiece @ 500–650`. Fallback `crushing @ 500–650` **ALL** `oneMove`.

2. **"Take the Free Piece" (tactics)**, *type: tactics.*
   Teaches: scanning every enemy piece and asking **"is it defended?"** If an **undefended** enemy piece is in
   your range, **take it**. Distinguish *truly* free from **bait** (a piece a pawn defends; taking with your
   queen walks into a recapture). Show: a hanging knight you simply win; a "free" pawn that is actually defended
   (don't grab it with the queen). 4 model captures + traps.
   - Warm-up puzzles: `hangingPiece @ 399–600`.
   - Cool-down puzzles: `hangingPiece @ 550–700` **ALL** `oneMove`/`short`. Big pool.

3. **"Good Trade, Bad Trade, Exchanges" (tactics/positional)**, *type: positional.*
   Teaches: evaluating an **exchange** before you make it. Am I trading like value for like, or winning/losing
   points? When trading is good (you're ahead, or removing a dangerous attacker) and when it's bad (giving up
   your good piece for their bad one, or losing material outright). Show a favourable trade, an equal trade, and
   a losing one.
   - Warm-up puzzles: `hangingPiece @ 500–700`.
   - Cool-down puzzles: `advantage @ 600–800` **ALL** `oneMove`/`short` (one move nets material via a clean
     capture/trade). Fallback `hangingPiece @ 600–800`.

4. **"Don't Hang Your Own: Defend or Move to Safety" (tactics/defense)**, *type: tactics/defensive.*
   Teaches: the mirror skill. When **your** piece is attacked you have **three saves**: **defend** it (add a
   defender), **move** it to safety, or **counter-attack** (make a bigger threat). Recognise the threat *before*
   it lands by asking, each turn, "what does my opponent's move attack?" Show: a knight attacked by a pawn (move
   it); a bishop you save by adding a defender; a piece saved by a bigger counter-threat.
   - Warm-up puzzles: `hangingPiece @ 500–700` (reframed: *"is YOURS safe before you grab theirs?"*).
   - Cool-down puzzles: **authored "save your attacked piece" positions** (primary: `defensiveMove` is too thin
     here) + fallback `hangingPiece @ 600–800`.

5. **"Free Material: Mixed Drill" (tactics)**, *type: tactics.*
   Teaches: integrate it. Every move, *scan for their hanging pieces AND check yours are safe.* The two-sided
   material habit. Mixed drill: some positions you win a free piece, some you must first save your own, a few are
   "don't take the bait." This is the chapter's payoff and the practical core of sub-1000 chess.
   - Warm-up puzzles: `hangingPiece @ 550–700`.
   - Cool-down puzzles: `hangingPiece @ 650–800` (OR `crushing @ 650–800` **ALL** `short` for variety).
     Abundant.

**Chapter 4 TEST (12 questions): blueprint**
- **Multiple-choice key-idea (3):**
  1. "Your opponent leaves a knight (3) undefended in your bishop's range. You should:" → *take it.*
  2. "A pawn you could capture is defended by another pawn. Capturing it with your queen would:" → *lose
     material: don't (bad trade).*
  3. "Your bishop is attacked. Which is NOT one of the three ways to save it?" → *(answer: promote a pawn; the
     three real saves are defend, move, counter-attack).*
- **Board questions (9):**
  - **(×3) Win the free piece:** three positions; *capture the undefended piece.* From `hangingPiece @ 399–650`.
  - **(×2) Safe-capture judgment:** *is this capture safe?* One yes (take it), one no (it's defended, you'd
    lose material). Board + two-option judge.
  - **(×2) Save your piece:** your piece is attacked; *play the move that saves it* (one by moving, one by
    defending). Authored / `hangingPiece` reframe.
  - **(×1) Best trade:** three capture options; *play the one that wins the most material* (or declines a bad
    trade). From `advantage @ 600–800` or authored.
  - **(×1) Judge the opponent's move (correct-or-blunder):** opponent leaves a piece *en prise* → **blunder**
    (free); or correctly defends/retreats an attacked piece → **correct**.

---

### CHAPTER 5: Board Vision: Is It Defended? · internal Elo 420–560 *(INTERNAL-ONLY, never shown)*

**Assumes you already know:** *Chapters 1–4*. Legal play, mate-in-one, piece values, and the basic "take the
free piece / don't hang yours" reflex. (We now sharpen that into real **board vision**: systematic scanning and
attacker-vs-defender **counting** on a square, the skill every tactic later depends on.)

**Theme:** the perceptual foundation under all tactics: **see the whole board, and count.** A systematic scan
(checks, captures, threats; for both sides), and the **attackers-vs-defenders count** on a contested square so
you know whether a capture *really* wins. This is the bridge from "don't hang pieces" to "win material with
tactics" (ch 8+). *Foundation/safety* chapter. Goal: *Before every move I scan the board and I can count a
capture sequence to know if it wins.*

> Data note: this chapter still rides the rich `hangingPiece` pool (and `mateIn1` for the "see every check"
> drill). It deliberately does **not** yet introduce fork/pin/skewer. Those pools are near-empty here and, more
> importantly, the learner needs counting and scanning **first**. `capturingDefender` is small at the floor
> (~48 at 600–800) and is previewed only lightly with an authored anchor.

**Lessons (5):**

1. **"Scan the Board: Checks, Captures, Threats" (warm-up + method)**, *type: warmup/positional.*
   Teaches: the move-by-move **scan**: *(1) what checks are available (mine and theirs)? (2) what captures? (3)
   what threats (a piece about to be won, a mate idea)?* For **both** sides. This single habit prevents most
   beginner blunders and finds most beginner wins. Drills: *list every capture in this position*; *which enemy
   piece is about to attack something of yours?*
   - Warm-up puzzles: `hangingPiece @ 450–600` (a scan immediately reveals the free piece).
   - Cool-down puzzles: `mateIn1 @ 450–600` (the scan-for-checks pays off; find the mating check). Big pool.

2. **"Counting Attackers & Defenders" (tactics/positional)**, *type: positional.*
   Teaches: before capturing on a square, **count your attackers vs. their defenders.** If you have *more*
   attackers than they have defenders (and you don't lose value along the way) the capture wins. Show a pawn
   attacked twice / defended once (win it); a pawn attacked twice / defended twice (it holds). Introduce that
   **order matters** (next lesson).
   - Warm-up puzzles: `hangingPiece @ 500–700` (the count is 1-attacker-vs-0-defenders; the simplest case).
   - Cool-down puzzles: `crushing @ 600–800` **ALL** `oneMove`/`short` (a single capture that nets material
     because the count favours you). Fallback `hangingPiece @ 600–800`.

3. **"Capture Order, Least Valuable First" (tactics/positional)**, *type: positional.*
   Teaches: when several of your pieces attack a square, **capture with the least valuable attacker first**, so a
   recapture costs you the least. Show the textbook error: taking first with the queen into a pawn-defended
   square (you lose the queen for a pawn) vs. taking first with the pawn (you win the exchange sequence). The
   "don't lead with your big piece" rule.
   - Warm-up puzzles: `hangingPiece @ 550–700`.
   - Cool-down puzzles: `advantage @ 650–850` **ALL** `short` (win material via the correct capture sequence).
     Fallback `crushing @ 650–850` **ALL** `short`.

4. **"Loose Pieces & Safe Squares" (tactics)**, *type: tactics.*
   Teaches: **"loose pieces drop off"**, an undefended ("loose") piece is a future tactic waiting to happen, so
   (a) hunt the opponent's loose pieces and (b) keep your own pieces defended or on safe squares. The first
   bridge to tactics: a loose enemy piece is what a fork/pin (ch 8–9) will exploit. Show a position riddled with
   loose enemy pieces and the move that wins one; show tidying up your own loose piece.
   - Warm-up puzzles: `hangingPiece @ 600–800` (the loosest piece is simply hanging).
   - Cool-down puzzles: `hangingPiece @ 650–850` (OR `crushing @ 650–850` **ALL** `short`). Abundant.

5. **"The Safety Checklist: Don't Blunder" (judgment + drill)**, *type: positional/judgment.*
   Teaches: the pre-move discipline that ties the foundation together. *before you release a piece, ask: does
   this move hang anything? does it leave a piece loose? does it allow a check or capture I missed?* Run the full
   scan, then move. Mixed drill: some positions you win material, some you must avoid a self-blunder, some you
   spot the opponent's hanging piece. The capstone of the foundation's safety arc.
   - Warm-up puzzles: `hangingPiece @ 550–700`.
   - Cool-down puzzles: `hangingPiece @ 700–900` (OR `advantage @ 700–900` **ALL** `short`), slightly above
     band to consolidate under pressure. Abundant. Authored "spot the self-blunder" pairs supplement.

**Chapter 5 TEST (13 questions): blueprint**
- **Multiple-choice key-idea (3):**
  1. "A square has 2 of your attackers and 1 enemy defender, with no value lost on the way. The capture:" →
     *wins material. Take it.*
  2. "When several of your pieces can capture on a square, you should capture first with your:" → *least valuable
     attacker.*
  3. "Why hunt the opponent's 'loose' (undefended) pieces?" → *they are what tactics like forks and pins win.*
- **Board questions (10):**
  - **(×2) Count and capture:** *is this capture winning?* Play it when the count favours you; decline when it
    doesn't. From `crushing`/`advantage @ 600–850` + authored counting boards.
  - **(×2) Right capture order:** *play the capture that wins material* (lead with the least valuable piece).
    From `advantage @ 650–850 short` or authored.
  - **(×2) Win the loose piece:** two positions; *take the undefended enemy piece.* From `hangingPiece @
    550–800`.
  - **(×2) Don't blunder:** two candidate moves; *play the one that does NOT hang a piece* (the other drops
    material). Authored.
  - **(×1) Find the only check / threat:** *play the move that wins material or gives a forcing check* the scan
    reveals. From `mateIn1`/`hangingPiece @ 600–800`.
  - **(×1) Judge the opponent's move (correct-or-blunder):** opponent makes a move that leaves a piece loose /
    walks into a winning capture → **blunder**; or correctly tucks a piece onto a safe, defended square →
    **correct**.

---

## 3. PUZZLE-POOL VALIDATION (measured against the bundled DB this session)

All counts queried this session from `resources/data/puzzles.sqlite` (4,699,980 puzzles; junction
`puzzle_themes(Theme, Rating, PuzzleId)` with covering index `idx_pt`). Re-query for a chapter's exact lo–hi
rather than trusting these counts, and prefer high-`Popularity`, adequate-`NbPlays` rows.

### 3.1 Foundation themes (chapters 1–7 ride these)

| Theme | 399–600 | 600–800 | 800–1000 | 1000–1200 | Verdict for the foundation |
|---|---:|---:|---:|---:|---|
| `mate` | 155,784 | 199,379 | 345,863 | 288,711 | abundant: ch 2,3,6,7 |
| `mateIn1` / `oneMove` | ~101,000 | ~136,000 | ~190,000 | ~117,000 | abundant: ch 3 |
| `mateIn2` | 51,950 | 57,525 | 134,869 | 137,220 | abundant: ch 7 |
| `backRankMate` | 40,867 | 23,915 | 29,205 | 21,181 | rich, **skews low**: ch 3 (intro), ch 7 |
| `hangingPiece` | 10,406 | 13,477 | 20,321 | 19,864 | the **true floor tactic**, ch 4,5 |
| `short` | (rich) | ~114,000 | ~346,000 | ~410,000 | abundant: every chapter |
| `promotion` | 3,441 | 5,218 | 11,388 | 15,717 | modest at floor: ch 2 (with `advancedPawn` fallback) |
| `castling` / `enPassant` | ~0 | ~0 | ~0 | ~30 | **essentially empty, author** these (ch 2) |

### 3.2 Core-tactics themes (chapters 8–10: the re-placement is data-backed)

| Theme | 399–600 | 600–800 | 800–1000 | 1000–1200 | 1200–1400 | Verdict |
|---|---:|---:|---:|---:|---:|---|
| `fork` | 2,479 | 29,021 | **111,586** | **109,944** | 80,563 | thin <800; **rich 800–1400** ⇒ ch 8 |
| `skewer` | 186 | 5,738 | 19,440 | 19,801 | 14,327 | thin <800; **rich 800–1200** ⇒ ch 9 |
| `pin` | 196 | 1,541 | 13,409 | **36,757** | 40,008 | thin <800; **rich 1000–1400** ⇒ ch 9 |
| `discoveredAttack` | 293 | 4,999 | 24,900 | **42,190** | 36,806 | thin <800; **rich 1000–1400** ⇒ ch 10 |
| `doubleCheck` | 65 | 548 | 1,449 | 3,067 | 3,398 | medium ≥1000: ch 10 (+ authored anchors) |

### 3.3 Mid/upper themes (the logarithmic expansion: measured this session)

These are the pools the **new** middle/upper chapters ride. The right-hand columns are the headline: **tactics,
endgames, calculation, and defence stay rich (and several themes *grow*) all the way through 2000+.** This is
the empirical proof that the upper tiers are not "empty"; the material is densest there.

| Theme | 1200–1400 | 1400–1600 | 1600–1800 | 1800–2000 | 2000–2200 | 2200+ | Used in (ch) |
|---|---:|---:|---:|---:|---:|---:|---|
| `fork` | 80,563 | 82,751 | 69,245 | 52,498 | 35,852 | 44,638 | 8, recurs everywhere |
| `pin` | 40,008 | 45,753 | 43,505 | 36,852 | 29,225 | 45,572 | 9, recurs |
| `discoveredAttack` | 36,806 | 36,572 | 32,464 | 26,619 | 19,505 | 24,855 | 10, recurs |
| `deflection` | 32,884 | 32,603 | 28,452 | 24,536 | 19,028 | 26,413 | 16, 27 |
| `attraction` | 26,515 | 36,391 | 32,686 | 26,825 | 20,744 | 25,506 | 16, 27 |
| `clearance` | 5,540 | 7,927 | 8,829 | 9,058 | 8,517 | 16,903 | 16, 39 *(grows)* |
| `capturingDefender` | 5,660 | 7,354 | 5,973 | 4,421 | 2,989 | 3,490 | 16 |
| `interference` | 2,162 | 2,948 | 2,948 | 2,674 | 2,073 | 2,975 | 16, 27 *(thin, authored anchors)* |
| `intermezzo` | 7,238 | 11,079 | 10,750 | 8,494 | 6,433 | 9,122 | 16, 23 |
| `trappedPiece` | 6,972 | 12,066 | 12,339 | 9,212 | 5,703 | 5,700 | 27 |
| `quietMove` | 7,951 | 14,575 | 20,482 | 25,428 | 29,289 | 85,461 | 27, 34, 39 *(grows steeply)* |
| `xRayAttack` | 3,085 | 3,479 | 2,264 | 1,622 | 994 | 1,127 | 27 *(thin high, authored anchors)* |
| `sacrifice` | 39,116 | 56,342 | 56,927 | 49,877 | 41,149 | 61,758 | 23, 32, 39 |
| `kingsideAttack` | 46,206 | 42,898 | 37,215 | 29,162 | 22,012 | 27,282 | 15, 32 |
| `queensideAttack` | 8,804 | 8,034 | 6,980 | 5,844 | 4,454 | 5,629 | 32 |
| `exposedKing` | 15,139 | 20,794 | 22,001 | 22,092 | 19,374 | 34,196 | 32 *(grows)* |
| `advancedPawn` | 33,844 | 38,354 | 37,758 | 35,580 | 31,853 | 55,104 | 19, 36 |
| `defensiveMove` | 17,291 | 24,891 | 32,480 | 40,998 | 46,244 | 101,915 | 27, 34 *(grows steeply)* |
| `pawnEndgame` | 14,602 | 17,752 | 19,467 | 21,833 | 23,572 | 49,971 | 19, 36 *(grows)* |
| `rookEndgame` | 28,147 | 27,337 | 24,728 | 22,659 | 20,196 | 33,798 | 26, 36 |
| `bishopEndgame` | 6,288 | 7,503 | 7,767 | 7,883 | 8,133 | 15,640 | 31 *(grows)* |
| `knightEndgame` | 3,525 | 4,113 | 4,436 | 4,641 | 4,755 | 9,482 | 31 *(grows)* |
| `queenEndgame` | 6,652 | 7,498 | 6,907 | 5,069 | 4,540 | 6,785 | 33 |
| `queenRookEndgame` | 3,566 | 2,912 | 2,235 | 1,666 | 1,239 | 2,043 | 33 *(thin: authored anchors)* |
| `zugzwang` | 3,734 | 4,288 | 5,294 | 7,753 | 7,967 | 16,952 | 31, 35 *(grows steeply)* |
| `mateIn2` | 87,230 | 66,085 | 43,670 | 23,361 | 8,595 | 2,424 | 7, 15 *(falls, a beginner theme)* |
| `mateIn3` | 25,364 | 24,791 | 20,844 | 15,349 | 8,851 | 4,961 | 15, 32 |
| `mateIn4` | 3,155 | 4,601 | 4,594 | 4,382 | 3,491 | 3,376 | 40 |
| `mateIn5` | 368 | 435 | 728 | 1,035 | 1,137 | 2,277 | 40 *(grows, top-tier)* |
| `veryLong` | 20,338 | 31,703 | 41,334 | 52,804 | 60,950 | 167,378 | 34, 40 *(grows steeply)* |
| `long` | 138,448 | 183,918 | 195,497 | 186,607 | 157,007 | 229,736 | 34, 40 |

**Named-mate themes (chapter 15: measured; they skew to 1200–1600, so place the chapter there):**

| Theme | 1200–1400 | 1400–1600 | 1600–1800 | 1800+ | Verdict |
|---|---:|---:|---:|---:|---|
| `smotheredMate` | 2,502 | 1,357 | 506 | 129 | rich ~1200–1500 ⇒ ch 15 (+ authored high) |
| `anastasiaMate` | 1,237 | 1,942 | 266 | 173 | rich ~1300–1500 ⇒ ch 15 |
| `arabianMate` | 892 | 678 | 396 | 393 | medium ⇒ ch 15 (+ authored) |
| `hookMate` | 1,929 | 1,335 | 779 | 670 | medium ⇒ ch 15 |
| `bodenMate` | 329 | 223 | 118 | 86 | thin: authored anchors, ch 15 |
| `killBoxMate` / `vukovicMate` | 865 / 395 | 820 / 514 | 872 / 577 | 920 / 436 | medium ⇒ ch 15/32 |

> **This block is the empirical justification for the logarithmic reweight (§0.1).** Beginner themes
> (`mateIn2`, named mates) *fall* with rating; advanced themes (`quietMove`, `defensiveMove`, `zugzwang`,
> `veryLong`, `clearance`, `exposedKing`, the minor-piece endgames) *rise*, several steeply, past 2000. There is
> **more** drillable material at the top, not less, so the top tiers must carry **more** chapters and lessons.

### 3.4 Opening pools (`OpeningTags`): every named system has a measured pool

963,839 puzzles carry `OpeningTags`. Family totals (substring match on the tag), queried this session:

| Opening family | Puzzles | Chapter | Opening family | Puzzles | Chapter |
|---|---:|--:|---|---:|--:|
| Sicilian (all) | 149,680 | 25, 30 | Ruy Lopez | 28,745 | 24 |
| Queen's Pawn / London | 58,982 | 12, 22 | Scotch Game | 27,142 | 17 |
| French Defence | 63,534 | 20 | Nimzo-Indian | 28,228 | 28 |
| Caro-Kann | 55,535 | 18 | Petrov / Russian | 21,411 | 17 |
| Italian Game | 54,519 | 11 | Vienna + Bishop's | 18,068 | 14 |
| Scandinavian | 42,600 | 13 | Four Knights | 14,557 | 17 |
| Queen's Gambit Declined | 35,930 | 22 | King's Indian | 13,791 | 28 |
| English Opening | 30,600 | 37 | Kings_Pawn (misc) | 13,247 | 11 |
| Slav Defence | 12,808 | 22 | Modern/Pirc | 28,762 | (context) |
| Queen's Gambit Accepted | 9,849 | 22 | Benoni | 9,504 | 37 |
| Kings_Indian sub | 8,943 | 28 | Grünfeld | 4,410 | 37 |
| | | | Catalan | 1,769 | 37 |

Sicilian sub-variations (for the two Sicilian chapters): **Najdorf 8,072 · Dragon 10,094 · Alapin 10,162 ·
Closed 10,165 · Smith-Morra 6,111 · Taimanov 5,180.** Every chapter opening above has a four-figure-or-larger
pool of arising-tactics puzzles: enough to drill each opening's tactics. Thin families (Catalan, Grünfeld) ride
their host chapter (37) with `OpeningTags`-filtered puzzles **plus** the generic middlegame/`crushing`/
`advantage` pools and authored model lines.

### 3.5 Consequences baked into the arc
- **Ch 1–7** ride the huge `mate`/`mateIn1`/`mateIn2`/`backRankMate`/`hangingPiece` pools + **authored**
  positions for piece movement, special moves (`castling`/`enPassant` empty as tags), and elementary mates.
- **Ch 8 (fork)** pulls drill volume from **800–1200**; **ch 9 (pins/skewers)** and **ch 10 (discovered/double)**
  from **1000–1400**; the easiest pins/skewers/discoveries use authored anchors (floor pools thin).
- **Ch 11–28 (openings)** each filter `OpeningTags` for arising tactics (§3.4) and supplement with the generic
  tactical pools; opening lines themselves are **authored, play-tested PGN** (no DB needed for the moves).
- **Ch 15** uses the named-mate themes at **1200–1600** (where they're rich) + authored anchors for `bodenMate`
  and the high end.
- **Ch 19/26/31/33/36 (endgames)** ride `pawnEndgame`/`rookEndgame`/`bishopEndgame`/`knightEndgame`/
  `queenEndgame` (all four-figure-plus at every upper band) + authored theoretical positions (Lucena, Philidor,
  opposition, wrong-rook-pawn: exact positions the DB won't reliably hold).
- **Ch 27/34/39 (advanced tactics/calc)** ride the themes that *grow* with Elo (`quietMove`, `defensiveMove`,
  `clearance`, `veryLong`, `long`): abundant exactly where these chapters sit.
- **Ch 40 (summit)** rides `mateIn4`/`mateIn5`/`veryLong` at **1800+** (rich there) + authored long-mate studies.
- Every chapter with a sparse tag lists explicit **fallbackThemes** + an **authored-positions** escape hatch, per
  SCHOOL-SPEC §2/§8 and content-coaching §1.

---

## 4. CROSS-CHECK AGAINST SCHOOL-SPEC.md

| Spec requirement (SCHOOL-SPEC §) | This curriculum (draft 3) |
|---|---|
| **Logarithmic depth: weight chapters AND lessons toward higher Elo; upper half must never look sparse; top tiers carry the most; even distribution is WRONG (§2.2a, NEW BINDING)** | **Satisfied and central.** Chapters-per-100-Elo rise **0.85 → 1.67 → 4.00 → 3.53** across tiers A→D; the advanced tier D (ch 29–40) carries the **most lessons (102)** and the **deepest chapters (8.5 avg)**, and ties tier C for the **most chapters (12)**, vs the foundation's **7**; avg lessons/chapter climb monotonically **4.9 → 6.0 → 7.0 → 8.5**; tiers C+D hold **60 % of chapters and 68 % of lessons**. §0.3 + §3.3 ground it in measured pools (advanced themes *grow* past 2000). The old roughly-even arc is explicitly replaced. |
| Beginner → 2000; "~20" chapters, ~100-Elo bands (§2.2, "~", "SOFT") | **40 chapters**, 0→2000+. "~20 / one-band-each" is **intentionally exceeded** (the spec's "no cap; create more if the material needs it" + the new logarithmic principle govern). Internal bands still order/gate the arc (§1). Justified §0.3. |
| Keep the 7-chapter foundation intact (USER) | Ch 1–7 **unchanged** in substance; Batch-1 plans preserved (§2). The expansion is entirely **above** the foundation. |
| One coherent theme per chapter; **no** rigid open→mid→end (§2.2) | Every chapter is a single theme (foundation / a mate family / a tactic family / one opening system / one endgame family / positional / calculation). Explicitly **not** phase-segmented. |
| 3–6 lessons per chapter, **SOFT, higher-Elo may need more** (§2.2) | Lessons climb with Elo: **4–5 foundation → 6 core/early-openings → 7 upper-middle → 8–10 summit** (**274 lessons total**). Uses the spec's explicit "higher-Elo topics may need more." |
| Lessons are NOT all openings (§2.1) | Lessons span warmup, tactics, positional, endgame, calculation, rules/judgment. Opening chapters put the system at lesson 1, then **variations** + arising tactics. |
| Variations are *super important*: go deep (§2.1, §2.2) | Opening chapters dedicate multiple lessons to variations (Italian: Two Knights/Fried Liver; Sicilian split across **two** chapters for Open vs Alapin/Closed then Najdorf/Dragon/Scheveningen; Ruy: Morphy/Marshall/Berlin/Exchange; QGD/Slav/QGA; KID/Nimzo; the d4 Indian/flank complex). |
| Warm-up AND cool-down puzzles, Elo-appropriate (§2.1) | Every lesson lists a **warm-up** (below target) and **cool-down** (at/above band) with a real theme+window (or authored, tagged). Validated §3. |
| Named openings placed by difficulty; earliest bands = foundations/mates/tactics, not named systems (§2.3, §6) | Ch 1–10 foundations/mates/core-tactics (no named systems). Italian 11, London 12, Scandinavian 13, Vienna 14; then Scotch/open games 17, Caro-Kann 18, French 20, QG complex 22, Ruy Lopez 24, Sicilian 25 & 30, Indian defences 28, d4 Indian/flank 37. **Bong Cloud** = labeled curiosity at ch 38. |
| **Fundamentals are fundamental**: don't pin the fork to 300–400 (USER) | Fork = **ch 8** (internal ≈820+), pins/skewers ch 9, basic mates ch 6, mating nets ch 7. Each a full chapter where the DB is rich and the learner is ready. |
| **Progressive / cumulative**: each chapter assumes all earlier ones (USER) | Every chapter states an explicit **"assumes you already know …"** line; the arc is ordered so no concept is used before it's taught. §1.5 traces the spine. |
| **Elo is internal grouping only, never shown** (USER) | Each chapter carries an **INTERNAL-ONLY** band (unlock/grouping per SCHOOL-SPEC §1); the table and every plan mark it "never shown." The user sees the **NAME** + a progress ring. |
| Test: 10–15 Q, ≥70 %, 2 attempts, hidden-on-fail, fail-both ⇒ retake, anytime (§4) | Global contract (§0.2); each Batch-1 test is **10–13 Q**; higher chapters trend to **13–15 Q** (deeper material). |
| Test: 2–4 MC "key idea" + remainder board Qs (play opening out / exploit / judge correct-or-blunder) (§4) | Each blueprint has **3 MC** key-idea Qs and the rest board Qs incl. explicit **judge-correct-or-blunder** items. |
| Master curriculum first, then chapters written against it and cross-checked in **batches of 5** (§6, §7) | This is that backbone; Batch-1 (1–5) detailed; **40 chapters ⇒ 8 batches** (§5), each appended with full plans as it begins. |
| Puzzle themes are §2 taxonomy keys; windows are real DB slices (content-coaching §1) | All themes are taxonomy keys; all windows validated against the real DB (§3, queried this session). |

**Open items deferred to the user (SCHOOL-SPEC §8):** (a) **chapter count 40** is settled; the
logarithmic-depth principle + "no cap / create more if the material needs it" landed the arc on 40 (was 26)
and 40 chapters shipped. (b) Bong-cloud framing (drafted as *curiosity*, ch 38). (c) Exact Elo→engine-level
placement mapping. (d) Final opening-to-chapter sign-off.

---

## 5. WHAT THE NEXT BATCHES WILL CONTAIN (preview, detailed when authored)

40 chapters ⇒ **eight batches** (1–5, 6–10, 11–15, 16–20, 21–25, 26–30, 31–35, 36–40). Each chapter is expanded
to Batch-1 depth (per-lesson teaches/warm-up/cool-down + a 10–15 Q test blueprint + an explicit "assumes you
already know" line) at the **start of its batch**, then authored and cross-checked back against this doc.

- **Batch 2 (ch 6–10): finish the foundation, then the core tactics.** Elementary mates (6); mating nets &
  mate-in-2 (7); the fork (8); pins & skewers (9); discovered & double attacks (10). *Each assumes all prior.*
- **Batch 3 (ch 11–15): first repertoire + the attack.** Opening principles + Italian (11); the London (12);
  the Scandinavian + 1.e4 traps (13); the Vienna + Gambit (14); mating patterns & attacking the king (15).
- **Batch 4 (ch 16–20): combinations, more open games, the first endgame & defence.** Removing-the-guard
  combinations (16); the Scotch & open games: Scotch/Four Knights/Petrov (17); the Caro-Kann (18); **King &
  Pawn endgames** (19); the French (20).
- **Batch 5 (ch 21–25): positional foundations + the heavy openings begin.** Pawn structure & weak squares
  (21); the Queen's Gambit & d4 closed games: QGD/Slav/QGA (22); the sacrifice & Greek gift (23); the Ruy Lopez
  (24); the Sicilian: foundations, Open vs Alapin/Closed (25).
- **Batch 6 (ch 26–30): endgame technique + advanced tactics + the deep openings.** Rook endgames
  (Lucena/Philidor/7th) (26); advanced tactics: quiet moves & x-rays (27); the Indian defences: KID & Nimzo
  (28); prophylaxis & positional mastery (29); the Sicilian: main lines, Najdorf/Dragon/Scheveningen (30).
- **Batch 7 (ch 31–35): the endgame catalogue + mastery layer.** Minor-piece endgames (31);
  opposite-side-castling attacks (32); queen & complex endgames (33); deep calculation & defence (34);
  conversion: winning won positions (35).
- **Batch 8 (ch 36–40): the summit.** Endgame theory: theoretical draws & wins (36); the d4 Indian complex &
  flank openings: Grünfeld/Benoni/Catalan/English (37); advanced opening theory & the **Bong Cloud** (38);
  strategic mastery: the complete middlegame (39); long calculation & mate-in-4/5 (40). *Assumes all 1–39.*
