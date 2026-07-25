// ============================================================================
// SM-2-lite spaced-repetition scheduler (pure math).        ★ BUILDER SLICE 3 ★
//
// Deliberately a *lite* SM-2: simple and ship-fast: NOT full FSRS, despite the
// filename living next to the rating code. Given a concept's prior schedule
// (stability/difficulty/reps/lapses/state/last_review) and a single binary grade
// (correct / incorrect), it returns the next card plus the next due epoch-ms.
//
// We keep the classic SM-2 fields but reinterpret them for a two-button
// (correct / again) flow, since a concept refresher only ever asks "did you still
// know it?":
//   • difficulty  -> the SM-2 *ease factor* (EF). Starts at 2.5, drifts down on a
//                    lapse and up a touch on success, clamped to [1.3, 3.0].
//   • stability   -> the current inter-repetition *interval in days* (the I(n) of
//                    SM-2). The next interval is round(prevInterval * EF) once the
//                    card graduates out of the short learning steps.
//   • reps        -> count of consecutive successful reviews (the SM-2 n). Reset to
//                    0 on a lapse so the card walks back through the learning steps.
//   • lapses      -> lifetime count of "again" answers (failures). Monotonic.
//   • state       -> 0 NEW (never scheduled), 1 LEARNING (in the sub-day steps), 2
//                    REVIEW (graduated; intervals grow by EF).
//   • last_review -> epoch-ms of the grade that produced this card (the "now").
//
// This module is intentionally side-effect free and clock-injectable (pass `now`)
// so it is trivially unit-testable; the SQL/IO lives in src/main/school/srs.repo.ts.
// ============================================================================

/** Card-lifecycle state stored in concept_srs.state. */
export const SrsState = {
  NEW: 0,
  LEARNING: 1,
  REVIEW: 2
} as const

const MS_PER_DAY = 86_400_000
const MS_PER_MINUTE = 60_000

// --- Tunables (SM-2-lite) ---------------------------------------------------
/** Ease factor (stored in `difficulty`) bounds + start. Classic SM-2 floors EF at
 *  1.3; we cap the ceiling at 3.0 so a long correct streak can't explode intervals. */
const EF_START = 2.5
const EF_MIN = 1.3
const EF_MAX = 3.0
/** EF nudge per grade. SM-2's q-based delta for a clean recall (q=5) is +0.1; a
 *  lapse (q≤2) costs roughly -0.2. We use those fixed deltas for the binary flow. */
const EF_GAIN_ON_PASS = 0.1
const EF_DROP_ON_LAPSE = 0.2

/** Learning steps, in MINUTES, walked before a card graduates to REVIEW. A freshly
 *  seeded card sits at step 0; the first correct review schedules it ~10m out
 *  (within-session reinforcement), the second graduates it to the day ladder. */
const LEARNING_STEPS_MIN = [10, 1440] // 10 minutes, then 1 day
/** Interval (days) the card graduates to on leaving the learning steps. */
const GRADUATING_INTERVAL_DAYS = 1
/** Interval (days) for the *first* REVIEW step after graduation. */
const FIRST_REVIEW_INTERVAL_DAYS = 3
/** On a lapse the card drops back to LEARNING; this is the post-lapse interval (the
 *  first learning step) and the interval seed it rebuilds from. */
const LAPSE_STEP_MIN = LEARNING_STEPS_MIN[0]
/** Hard cap so a runaway EF streak can't push a refresher absurdly far out. */
const MAX_INTERVAL_DAYS = 365

/** A persisted/seeded SM-2-lite card. Mirrors the concept_srs columns 1:1 (minus
 *  the concept_id key). `stability` is the current interval in DAYS; `difficulty`
 *  is the EF. Nullable numerics tolerate a freshly-CREATEd row whose optional
 *  columns were never written. */
export interface SrsCard {
  due: number
  /** Current interval in DAYS (SM-2 I(n)). Null/0 for a new card. */
  stability: number | null
  /** Ease factor / EF (SM-2). Null for a new card -> treated as EF_START. */
  difficulty: number | null
  reps: number
  lapses: number
  state: number
  last_review: number | null
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** Round up to whole minutes worth of ms, so sub-day learning steps land cleanly. */
function minutesFromNow(now: number, minutes: number): number {
  return now + Math.round(minutes) * MS_PER_MINUTE
}

function daysFromNow(now: number, days: number): number {
  return now + Math.round(days * MS_PER_DAY)
}

/**
 * A brand-new card for a concept being seeded (first taught / first scheduled).
 * It is due immediately (`now`) so the very first refresher can surface in the
 * Today queue, EF at the SM-2 start, no interval/streak yet, state NEW.
 */
export function newCard(now: number): SrsCard {
  return {
    due: now,
    stability: 0,
    difficulty: EF_START,
    reps: 0,
    lapses: 0,
    state: SrsState.NEW,
    last_review: null
  }
}

/**
 * Pure SM-2-lite step. Given the prior card + a binary grade, return the next card.
 * `now` is injected (epoch-ms) for deterministic tests; defaults to Date.now().
 *
 * Correct:
 *   NEW/LEARNING -> advance through LEARNING_STEPS_MIN; the last step graduates the
 *     card to REVIEW at GRADUATING_INTERVAL_DAYS, then FIRST_REVIEW_INTERVAL_DAYS.
 *   REVIEW -> nextInterval = round(prevInterval * EF), clamped to MAX_INTERVAL_DAYS;
 *     EF nudges up by EF_GAIN_ON_PASS; reps++.
 * Incorrect (lapse):
 *   lapses++; reps reset to 0; EF drops by EF_DROP_ON_LAPSE (floored at EF_MIN); the
 *   card returns to LEARNING and is re-shown after LAPSE_STEP_MIN minutes; its
 *   interval seed resets so it rebuilds the day ladder from the bottom.
 */
export function scheduleNext(prior: SrsCard, correct: boolean, now: number = Date.now()): SrsCard {
  const ef = clampEf(prior.difficulty ?? EF_START)
  const prevInterval = prior.stability && prior.stability > 0 ? prior.stability : 0

  if (!correct) {
    // Lapse: walk the card back to the first learning step, decay EF, bump lapses.
    const nextEf = clampEf(ef - EF_DROP_ON_LAPSE)
    return {
      due: minutesFromNow(now, LAPSE_STEP_MIN),
      stability: GRADUATING_INTERVAL_DAYS, // interval seed it rebuilds from once it re-graduates
      difficulty: nextEf,
      reps: 0,
      lapses: prior.lapses + 1,
      state: SrsState.LEARNING,
      last_review: now
    }
  }

  // --- Correct -------------------------------------------------------------
  const nextEf = clampEf(ef + EF_GAIN_ON_PASS)
  const nextReps = prior.reps + 1

  if (prior.state === SrsState.REVIEW) {
    // Graduated card: grow the interval geometrically by EF.
    const grownInterval = clamp(Math.round(prevInterval * nextEf), 1, MAX_INTERVAL_DAYS)
    return {
      due: daysFromNow(now, grownInterval),
      stability: grownInterval,
      difficulty: nextEf,
      reps: nextReps,
      lapses: prior.lapses,
      state: SrsState.REVIEW,
      last_review: now
    }
  }

  // NEW or LEARNING: advance through the short learning steps. `reps` here doubles
  // as the index of the NEXT learning step to schedule (0 -> first step, etc.).
  const stepIndex = prior.reps
  if (stepIndex < LEARNING_STEPS_MIN.length) {
    return {
      due: minutesFromNow(now, LEARNING_STEPS_MIN[stepIndex]),
      stability: GRADUATING_INTERVAL_DAYS,
      difficulty: nextEf,
      reps: nextReps,
      lapses: prior.lapses,
      state: SrsState.LEARNING,
      last_review: now
    }
  }

  // Past the learning steps -> graduate to REVIEW. First review sits a few days out.
  const firstInterval = clamp(FIRST_REVIEW_INTERVAL_DAYS, 1, MAX_INTERVAL_DAYS)
  return {
    due: daysFromNow(now, firstInterval),
    stability: firstInterval,
    difficulty: nextEf,
    reps: nextReps,
    lapses: prior.lapses,
    state: SrsState.REVIEW,
    last_review: now
  }
}

function clampEf(ef: number): number {
  // Guard against NaN/garbage persisted EF; fall back to the SM-2 start.
  return Number.isFinite(ef) ? clamp(ef, EF_MIN, EF_MAX) : EF_START
}
