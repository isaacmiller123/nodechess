import { getAppDb } from '../db/database'
import { conceptToChapter, getChapter } from './school.repo'
import { recordConcept } from './mastery.repo'
import { localDay } from '../util/day'
import { newCard, scheduleNext, type SrsCard } from '../rating/fsrs'
import type { DueConcept, ConceptReview, ChapterConcept } from '../../shared/types'

// ============================================================================
// FEATURE 3: Spaced repetition (SM-2-lite) of concepts.  ★ BUILDER SLICE 3 ★
//
// All read/write logic for the concept_srs table (one card per taught concept;
// created at user_version=6). SM-2-LITE: simple, ship-fast: NOT full FSRS. The
// scheduler math lives in the sibling src/main/rating/fsrs.ts (also slice 3);
// this repo owns the SQL + the IPC-facing functions.
//
// Table (concept_srs, user_version 6):
//   concept_id PK, due, stability, difficulty, reps, lapses, state, last_review
//   + idx_concept_srs_due
//
// Coherence with the rest of School:
//   • Every graded review also feeds the rolling concept_mastery via
//     recordConcept() (mastery.repo) so the "what you know" estimate and the SRS
//     schedule never drift apart.
//   • A review counts as a "study action today": we OR `review_done=1` into today's
//     LOCAL-day school_day row (same table the daily/streak slice owns). We write it
//     directly here: an idempotent ON CONFLICT(ymd) upsert that composes with the
//     daily slice's own writer, so the streak stays coherent regardless of build
//     order. (See verify notes.)
// ============================================================================

/** Raw concept_srs row (DB column shape). */
interface SrsRow {
  concept_id: string
  due: number
  stability: number | null
  difficulty: number | null
  reps: number
  lapses: number
  state: number
  last_review: number | null
}

function rowToCard(r: SrsRow): SrsCard {
  return {
    due: r.due,
    stability: r.stability,
    difficulty: r.difficulty,
    reps: r.reps,
    lapses: r.lapses,
    state: r.state,
    last_review: r.last_review
  }
}

function getRow(conceptId: string): SrsRow | undefined {
  return getAppDb()
    .prepare(
      'SELECT concept_id, due, stability, difficulty, reps, lapses, state, last_review FROM concept_srs WHERE concept_id=?'
    )
    .get(conceptId) as unknown as SrsRow | undefined
}

/** Write a card to concept_srs (insert or full update) for a concept id. */
function writeCard(conceptId: string, card: SrsCard): void {
  getAppDb()
    .prepare(
      `INSERT INTO concept_srs(concept_id, due, stability, difficulty, reps, lapses, state, last_review)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(concept_id) DO UPDATE SET
         due=excluded.due,
         stability=excluded.stability,
         difficulty=excluded.difficulty,
         reps=excluded.reps,
         lapses=excluded.lapses,
         state=excluded.state,
         last_review=excluded.last_review`
    )
    .run(
      conceptId,
      card.due,
      card.stability,
      card.difficulty,
      card.reps,
      card.lapses,
      card.state,
      card.last_review
    )
}

/** Look up a concept's display fields ({name, short}) from the chapter JSON it
 *  lives in. Returns null when the concept id isn't in any chapter (stale row). */
function conceptMeta(
  conceptId: string
): { name: string; short: string; chapterId: string; chapterTitle: string } | null {
  const link = conceptToChapter().get(conceptId)
  if (!link) return null
  const chapter = getChapter(link.chapterId)
  const concept = chapter?.concepts?.find((c: ChapterConcept) => c.id === conceptId)
  return {
    name: concept?.name ?? conceptId,
    short: concept?.short ?? '',
    chapterId: link.chapterId,
    chapterTitle: link.title
  }
}

/**
 * Seed or advance a concept's SRS card.
 *
 * Two call shapes:
 *   • upsertSchedule({ conceptId }),                   SEED: first time a concept is
 *     taught, create a NEW card due now (so its first refresher can surface today).
 *     No-op if a card already exists (never resets an in-flight schedule).
 *   • upsertSchedule({ conceptId, correct }),          ADVANCE: run the SM-2-lite
 *     step (fsrs.ts) over the existing card (seeding one first if missing) and write
 *     the rescheduled card. Returns the written card.
 *
 * This is an implementation detail of the slice (not an IPC channel itself): the
 * school:recordConcept handler calls the seed form whenever a concept is taught
 * (so every taught concept enters the review queue); reviewConcept() below calls
 * the advance form.
 */
export function upsertSchedule(args: { conceptId: string; correct?: boolean }): SrsCard {
  const { conceptId } = args
  const now = Date.now()
  const existing = getRow(conceptId)

  // Pure SEED (no grade): only create if absent; otherwise leave the schedule be.
  if (args.correct === undefined) {
    if (existing) return rowToCard(existing)
    const seeded = newCard(now)
    writeCard(conceptId, seeded)
    return seeded
  }

  // ADVANCE: grade the prior card (seed one in-memory if this concept was never
  // scheduled) through the SM-2-lite step and persist the result.
  const prior = existing ? rowToCard(existing) : newCard(now)
  const next = scheduleNext(prior, args.correct, now)
  writeCard(conceptId, next)
  return next
}

/**
 * Concepts owed a review right now (due <= now), MOST OVERDUE FIRST. Each is joined
 * to the chapter that teaches it (via conceptToChapter()) and to that chapter's JSON
 * concept for the display name + one-line `short`, so the Today surface can render a
 * refresher card and deep-link back to where it was taught.
 *
 * Stale rows (a concept id no longer present in any chapter) are skipped rather than
 * surfaced, so a curriculum edit can't strand an un-openable review.
 */
export function getDueConcepts(opts?: { limit?: number }): DueConcept[] {
  const now = Date.now()
  const db = getAppDb()
  const rows = db
    .prepare(
      'SELECT concept_id, due FROM concept_srs WHERE due <= ? ORDER BY due ASC, concept_id ASC'
    )
    .all(now) as unknown as { concept_id: string; due: number }[]

  const out: DueConcept[] = []
  const limit = opts?.limit
  for (const r of rows) {
    const meta = conceptMeta(r.concept_id)
    if (!meta) continue // stale concept id: skip
    out.push({
      conceptId: r.concept_id,
      conceptName: meta.name,
      short: meta.short,
      chapterId: meta.chapterId,
      chapterTitle: meta.chapterTitle,
      due: r.due
    })
    if (limit !== undefined && out.length >= limit) break
  }
  return out
}

/** Count of concepts still owed right now (drives the Today "N left" badge).
 *  Reuses getDueConcepts() so stale concept ids (removed from the curriculum) are
 *  filtered exactly like the drill list is. The badge and the list can never
 *  disagree (a raw COUNT(*) would say "N left" over an empty drill forever). */
function remainingDueCount(): number {
  return getDueConcepts().length
}

/**
 * Mark today's LOCAL day as "studied via a review". This OR-s review_done=1 into the
 * school_day row keyed by the user's LOCAL 'YYYY-MM-DD' (src/main/util/day.ts): the
 * same table + columns the daily/streak slice owns. Written directly (idempotent
 * ON CONFLICT(ymd) upsert) so an SRS review counts the day toward the streak even if
 * the daily slice's recordSchoolDay() writer is built separately; both writers
 * target the identical table and compose.
 */
function markReviewDay(): void {
  const ymd = localDay()
  getAppDb()
    .prepare(
      `INSERT INTO school_day(ymd, lesson_done, review_done, created_at)
       VALUES (?, 0, 1, ?)
       ON CONFLICT(ymd) DO UPDATE SET review_done=1`
    )
    .run(ymd, Date.now())
}

/**
 * Grade one concept review (SM-2-lite) and return the new schedule.
 *
 *   1. advance the card via the SM-2-lite step (fsrs.ts) and persist it,
 *   2. feed the rolling concept_mastery (recordConcept, mastery.repo) so SRS and
 *      mastery stay coherent,
 *   3. count the day toward the streak (review_done for today's LOCAL day),
 *   4. return the new {due, reps, lapses, state} + remainingDue (concepts still owed
 *      now, for the Today badge).
 */
export function reviewConcept(args: { conceptId: string; correct: boolean }): ConceptReview {
  const card = upsertSchedule({ conceptId: args.conceptId, correct: args.correct })

  // Keep the rolling mastery estimate in step with the review outcome.
  recordConcept(args.conceptId, args.correct)
  // A review is a "study action today". Count the LOCAL day toward the streak.
  markReviewDay()

  return {
    conceptId: args.conceptId,
    due: card.due,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    remainingDue: remainingDueCount()
  }
}
