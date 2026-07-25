# CHESS SCHOOL: BINDING SPEC (source of truth)

> This document is authoritative. All School work (curriculum, lessons, tests, placement, UI, build
> process) MUST conform to it. Do not stray. If a conflict arises between this doc and any code, comment,
> memory, or prior plan, THIS DOC WINS. Changes require explicit user approval. Owner: Isaac.
> Status: locked 2026-06-27. Coach persona = **Viktor** (exacting old-school master).

---

## 0. Definition of done
A real, full-fledged chess school (beginner → 2000 Elo) that **looks genuinely polished** (not merely
"consistent"), with placement-based Elo estimation, Elo-gated unlocking, dense content (openings + scenarios
+ warm-up/cool-down puzzles), per-chapter graded tests, and a curriculum that is play-tested against its
own plan and cross-checked against the master curriculum before it counts as done (§7).

---

## 1. Placement & Elo estimation
- Lessons are **locked** until the user completes **placement game(s)**.
- Placement **estimates the user's Elo from accuracy vs. engine level** (behavior-matched to how chess.com
  estimates strength. chess.com's exact method is proprietary, so we approximate: play vs. a known engine
  level, measure accuracy/ACPL, map to an Elo estimate; may use more than one game to converge).
- Lessons/chapters **unlock up to the user's estimated Elo** (you can access everything at or below your
  level; higher chapters stay locked until you climb).
- The test (see §4) can be taken at any point in a chapter, partly to correct **mis-placements**.

## 2. Structure: Lesson → Chapter
### 2.1 A LESSON (the atom): flexible, NOT always an opening
A lesson is a focused teaching unit. It is **NOT required to be a new opening.** A lesson can be any of:
- a **new opening / system**,
- a **variation of the chapter's opening** (variations are *super important*; go deep),
- a **tactics** lesson,
- a **positional / middlegame** lesson,
- an **endgame scenario** lesson,
- a **warm-up** lesson,
- or whatever else is genuinely important for that level (use judgment).

Where it fits, a lesson includes **scenarios + how to exploit them** and **Elo-appropriate warm-up and
cool-down puzzles**. Depth matters: "this goes pretty far". Don't be shallow.

### 2.2 A CHAPTER: one coherent theme
- A chapter = a coherent themed set of lessons. **Count is 40, logarithmically weighted** (274 lessons):
  Foundation ch1–7, Core+1st repertoire ch8–16, Upper-middle ch17–28, Advanced/Summit ch29–40. Density rises
  with level (chapters-per-100-Elo 0.85→1.67→4.0→3.5; lessons/chapter 5→6→7→8–9); the upper half (ch17–40)
  is 60% of chapters and 68% of lessons. Core tactics sit where the DB supports drilling (Fork = ch8, NOT a
  300–400 tactic). Internal Elo bands order/gate but are never shown to the user. See
  `docs/school-curriculum.md` for the full arc + the measured distribution proof.
- **3–6 lessons per chapter** (SOFT: higher-Elo topics may need more; not hard caps).
- A chapter is built around **one coherent theme**, e.g.:
  - **an opening/system** (often the chapter itself, especially at higher Elo): lesson 1 = the
    opening/system, then lessons on its **variations**, the **tactics/positions that arise from it**, and
    **how to exploit** common responses; OR
  - a **pure tactics** chapter; OR a **positional / middlegame** chapter; OR an **endgame-scenarios**
    chapter. The first lesson may also be a **warm-up**.
- The opening/system, when present, is **most likely the FIRST lesson**; following lessons expand the theme.
- **DO NOT** force a rigid opening→middlegame→endgame structure per chapter. The user explicitly rejected
  it, because it would require multiple chapters per 100-Elo band. One theme per band.
- Content density target: **a lot**. Many lessons, scenarios, and puzzles. Do not be sparse.

### 2.2a Curriculum principles (binding, added 2026-06-27)
- **Cumulative / progressive:** every chapter assumes the learner has mastered **everything in all earlier
  chapters** (ch 17 assumes ch 1–16). Order so knowledge strictly builds; never use a concept before it's
  taught. The foundation is *extremely important*. Do not rush it.
- **No chapter cap:** the count follows the material, not a round number. ~20 was the opening estimate; the
  logarithmic reweight settled the arc at 40 (§2.2). If reaching a true 2000 with real information +
  training needs more, create them; equally, don't pad.
- **Chapters are identified by NAME**, and the name reflects the chapter's lessons/content.
- **Fundamentals are fundamental:** forks, pins, basic mates, etc. are core skills placed where the learner
  needs them. Not arbitrarily pinned to an Elo number.
- **Elo is INTERNAL grouping ONLY.** It orders/groups chapters and gates unlocks; it is **NEVER shown to the
  user** anywhere in the school UI. (Cards/headers show the NAME and progress, never an Elo band.)
- **Logarithmic depth (binding, added 2026-06-27):** improvement is **logarithmic, not linear**. The higher
  the level, the MORE there is to learn. The curriculum MUST weight both **chapters and lessons toward the
  higher Elos**: more chapters per rating band and more lessons per chapter as you climb. The upper half must
  NEVER look sparse. The top tiers (≈1400→2000) should carry the most chapters and the deepest lessons
  (openings + many variations, middlegame plans, the full endgame catalogue, calculation). A roughly-even
  chapter-per-band distribution is WRONG.

### 2.3 Named openings/strategies explicitly requested
London System, Bong Cloud, Vienna: "and other similar strategies." Assigned across the 40 chapters by
difficulty in the master curriculum (§6). (Named systems land at the Elo where they're appropriate; the
earliest beginner bands are foundations/tactics/mates, not named systems.)

## 3. (reserved)

## 4. Chapter test
Every chapter has a **test**:
- **10–15 questions.**
- **Passing grade ≥ 70%.**
- **2 attempts.**
- If you **don't pass, correct answers are NOT shown.**
- **Fail both attempts ⇒ retake the ENTIRE chapter.**
- The test is **available at any point during the chapter** (in case of mis-placement).

Test composition:
- **Multiple-choice section: 2–4 questions on key ideas** (e.g. "take the center", "get your queen to X").
- **The remainder are board questions:** the user must **play the full opening out**, **exploit the moves
  explained** in the lesson, and **judge whether the opponent's move was correct or a blunder.**

## 5. UI / Look (TOP PRIORITY; current UI is unacceptable)
- **TARGET (locked 2026-06-27): MATCH chess.com Lessons.** Big board center/left-stage; a clean
  instruction card beside it with bold headings; the coach (Viktor) identity at the top of that panel; a
  progress bar across the top of the lesson; strong primary action button; clear interactive feedback
  ("Correct!" green / "Try again" red) with a short explanation; a chaptered lessons list; chapter cards in
  a grid with progress bars/rings; generous whitespace, rounded cards, product-grade polish.
- Adapt chess.com's LAYOUT + polish to the app's existing dark theme + design tokens (tokens.css). Board can
  use the green board theme (chess.com-like). Don't merely reuse shared classes. It must look genuinely good.
- Verify the result by screenshot before declaring done; iterate until it reads as chess.com-grade.

## 6. Master curriculum (the backbone to cross-check against)
A single master curriculum defines the 40 chapters: each chapter's **Elo band**, **opening/strategy focus**,
**lesson list** (intro + expansions), **puzzle theme/rating windows** (warm-up/cool-down), and **test
blueprint**. This is the spec each chapter is written against AND later cross-checked against. It is drafted
and approved **before** any chapter content is authored, because a chapter written against no backbone
cannot be checked for gaps or overlap with its neighbours.

## 7. When a chapter counts as done (NON-NEGOTIABLE)
1. **Played through end to end**, not just read: every position legal, every opening line sound, every
   scenario reachable, every puzzle solvable as claimed, the test internally coherent.
2. **Conforms to its master-curriculum entry** (§6): Elo band, opening/strategy focus, lesson list, puzzle
   theme/rating windows, test blueprint. A deviation means one of the two documents is wrong; fix it, don't
   ship the mismatch.
3. **Cross-checked in batches of 5** against the master curriculum and against each other, so gaps, repeats,
   and difficulty cliffs across chapter boundaries surface before the next batch is written.

## 8. Open decisions to confirm with the user (defaults noted, change on request)
- UI visual reference/direction (§5).
- Elo→engine-level mapping table for placement (§1).
- Exact assignment of openings to the 40 chapters (§6): drafted in the master curriculum, user-approved.
- Whether Bong Cloud/meme lines are taught as serious lines or labeled curiosities (default: included,
  framed honestly).
