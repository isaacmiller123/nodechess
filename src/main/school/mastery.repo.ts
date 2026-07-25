import type { DatabaseSync } from 'node:sqlite'
import { getAppDb } from '../db/database'
import { getChapter } from './school.repo'
import { MAX_ATTEMPTS } from '../../shared/types'
import type {
  ConceptMastery,
  ChapterProgressRow,
  SchoolMastery,
  TestRecordResult
} from '../../shared/types'

// Chess School persistence: per-concept rolling mastery + per-chapter progress.
// Tables (concept_mastery, chapter_progress) exist at user_version 2 (see
// db/database.ts migrate()). All writes are upserts so the renderer can record
// freely without first reading. Mastery is a deterministic rolling estimate, NOT
// an engine call. Viktor uses it to reference what the learner already knows.

interface ConceptRow {
  concept_id: string
  mastery: number
  seen: number
  correct: number
}
interface ChapterRow {
  chapter_id: string
  segments_done: number
  completed: number
  boss_won: number
}
interface LessonRow {
  chapter_id: string
  lesson_id: string
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/**
 * Append one study-log row to progress_event (kind/ref/value/created_at). This is
 * the LOCAL-DAY-bucketable record of School activity: the daily/streak builder
 * buckets these rows by local day (src/main/util/day.ts) to know which days the
 * user actually studied. Every concrete study action (a concept attempt, a lesson
 * completion, a recorded test) appends one row.
 *
 *   kind:  'concept' | 'lesson' | 'test'
 *   ref:   the concept/lesson/chapter id it refers to
 *   value: a small numeric payload (mastery for concepts, score for tests, 1 for
 *          lessons). Purely informational for now.
 */
export function appendProgressEvent(kind: string, ref: string, value: number): void {
  getAppDb()
    .prepare('INSERT INTO progress_event(kind, ref, value, created_at) VALUES (?,?,?,?)')
    .run(kind, ref, value, Date.now())
}

/** Full mastery snapshot: every tracked concept + every chapter's progress. */
export function getMastery(): SchoolMastery {
  const db = getAppDb()
  const conceptRows = db
    .prepare('SELECT concept_id, mastery, seen, correct FROM concept_mastery')
    .all() as unknown as ConceptRow[]
  const chapterRows = db
    .prepare(
      'SELECT chapter_id, segments_done, completed, boss_won FROM chapter_progress'
    )
    .all() as unknown as ChapterRow[]
  // Read lesson_progress back (it was previously write-only; done-state never
  // survived a remount/restart). Only rows actually marked done.
  const lessonRows = db
    .prepare('SELECT chapter_id, lesson_id FROM lesson_progress WHERE done=1')
    .all() as unknown as LessonRow[]

  const concepts: ConceptMastery[] = conceptRows.map((r) => ({
    conceptId: r.concept_id,
    mastery: r.mastery,
    seen: r.seen,
    correct: r.correct
  }))
  const chapters: ChapterProgressRow[] = chapterRows.map((r) => ({
    chapterId: r.chapter_id,
    segmentsDone: r.segments_done,
    completed: r.completed === 1,
    bossWon: r.boss_won === 1
  }))
  const lessons = lessonRows.map((r) => ({ chapterId: r.chapter_id, lessonId: r.lesson_id }))
  return { concepts, chapters, lessons }
}

/**
 * Record one concept attempt and return the updated rolling mastery.
 * new = clamp(old + (correct ? +0.34 : -0.22), 0, 1); seen++; correct++ if right.
 */
export function recordConcept(conceptId: string, correct: boolean): { mastery: number } {
  const db = getAppDb()
  const existing = db
    .prepare('SELECT concept_id, mastery, seen, correct FROM concept_mastery WHERE concept_id=?')
    .get(conceptId) as unknown as ConceptRow | undefined

  const oldMastery = existing?.mastery ?? 0
  const newMastery = clamp01(oldMastery + (correct ? 0.34 : -0.22))
  const seen = (existing?.seen ?? 0) + 1
  const correctCount = (existing?.correct ?? 0) + (correct ? 1 : 0)
  const now = Date.now()

  db.prepare(
    `INSERT INTO concept_mastery(concept_id, mastery, seen, correct, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(concept_id) DO UPDATE SET
       mastery=excluded.mastery,
       seen=excluded.seen,
       correct=excluded.correct,
       updated_at=excluded.updated_at`
  ).run(conceptId, newMastery, seen, correctCount, now)

  appendProgressEvent('concept', conceptId, newMastery)
  return { mastery: newMastery }
}

/** Advance a chapter's segment progress (monotonic; never moves backwards). */
export function recordSegment(chapterId: string, segmentsDone: number): void {
  const db = getAppDb()
  const existing = db
    .prepare('SELECT segments_done FROM chapter_progress WHERE chapter_id=?')
    .get(chapterId) as unknown as { segments_done: number } | undefined
  const next = Math.max(existing?.segments_done ?? 0, segmentsDone)
  const now = Date.now()

  db.prepare(
    `INSERT INTO chapter_progress(chapter_id, segments_done, completed, boss_won, auto_completed, updated_at)
     VALUES (?,?,0,0,0,?)
     ON CONFLICT(chapter_id) DO UPDATE SET
       segments_done=?,
       auto_completed=0,
       updated_at=excluded.updated_at`
  ).run(chapterId, next, now, next)
}

/**
 * Mark a chapter completed. boss_won is sticky: once won it stays won, and a
 * win on this pass sets it even if it wasn't before. An EARNED completion,
 * auto_completed=0 (also reclaims a placement-auto row: once the learner truly
 * completes it, a placement reset must not take it away).
 */
export function completeChapter(chapterId: string, bossWon: boolean): void {
  const db = getAppDb()
  const existing = db
    .prepare('SELECT boss_won FROM chapter_progress WHERE chapter_id=?')
    .get(chapterId) as unknown as { boss_won: number } | undefined
  const won = bossWon || (existing?.boss_won ?? 0) === 1 ? 1 : 0
  const now = Date.now()

  db.prepare(
    `INSERT INTO chapter_progress(chapter_id, segments_done, completed, boss_won, auto_completed, updated_at)
     VALUES (?,0,1,?,0,?)
     ON CONFLICT(chapter_id) DO UPDATE SET
       completed=1,
       boss_won=?,
       auto_completed=0,
       updated_at=excluded.updated_at`
  ).run(chapterId, won, now, won)
}

/** Mark one lesson of a chapter done (idempotent upsert). An EARNED completion,
 *  auto_completed=0 (also reclaims a placement-auto row: a lesson the learner
 *  actually did must survive a placement reset). */
export function recordLesson(chapterId: string, lessonId: string): void {
  const db = getAppDb()
  const now = Date.now()
  db.prepare(
    `INSERT INTO lesson_progress(chapter_id, lesson_id, done, auto_completed, updated_at)
     VALUES (?,?,1,0,?)
     ON CONFLICT(chapter_id, lesson_id) DO UPDATE SET
       done=1,
       auto_completed=0,
       updated_at=excluded.updated_at`
  ).run(chapterId, lessonId, now)

  appendProgressEvent('lesson', lessonId, 1)
}

/**
 * Placement pre-completion: RECONCILES the placement-derived completions to
 * exactly `entries`: marks every given chapter fully complete (all its lessons
 * done + the chapter itself completed, auto_completed=1) and PRUNES auto rows for
 * chapters NOT in the set, so a re-placement that lands LOWER retracts the
 * completions the higher estimate granted (an empty set retracts them all).
 * Rows the learner earned manually (auto_completed=0: recordLesson /
 * completeChapter / recordSegment) are never deleted, and the ON CONFLICT
 * updates leave an existing row's provenance alone so an auto pass can't claim
 * them. Idempotent + one transaction. boss_won is left untouched (they didn't
 * beat the boss).
 */
export function bulkCompleteChapters(
  entries: { chapterId: string; lessonIds: string[] }[]
): void {
  const db = getAppDb()
  const now = Date.now()
  const keep = entries.map((e) => e.chapterId)
  const notKept = keep.length > 0 ? ` AND chapter_id NOT IN (${keep.map(() => '?').join(',')})` : ''
  const insLesson = db.prepare(
    `INSERT INTO lesson_progress(chapter_id, lesson_id, done, auto_completed, updated_at)
     VALUES (?,?,1,1,?)
     ON CONFLICT(chapter_id, lesson_id) DO UPDATE SET done=1, updated_at=excluded.updated_at`
  )
  const upChapter = db.prepare(
    `INSERT INTO chapter_progress(chapter_id, segments_done, completed, boss_won, auto_completed, updated_at)
     VALUES (?,0,1,0,1,?)
     ON CONFLICT(chapter_id) DO UPDATE SET completed=1, updated_at=excluded.updated_at`
  )
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM chapter_progress WHERE auto_completed=1${notKept}`).run(...keep)
    db.prepare(`DELETE FROM lesson_progress WHERE auto_completed=1${notKept}`).run(...keep)
    for (const e of entries) {
      for (const lid of e.lessonIds) insLesson.run(e.chapterId, lid, now)
      upChapter.run(e.chapterId, now)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * Reset a chapter for a full retake (spec: fail BOTH attempts ⇒ retake the whole
 * chapter). One transaction: wipe the chapter's lesson_progress, zero its
 * chapter_progress (segments/completed/boss), and zero the chapter_test attempts +
 * passed. best_pct is KEPT (the learner's high-water mark survives a retake). The
 * concept_mastery rolling estimate is intentionally left alone. It's a separate,
 * slowly-decaying signal, not part of the chapter's per-pass progress.
 */
export function resetChapterForRetake(chapterId: string): void {
  const db = getAppDb()
  db.exec('BEGIN')
  try {
    resetChapterStatements(db, chapterId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** The retake reset's statements WITHOUT a transaction, so a caller that is
 *  already inside one (recordTest) can include them atomically. SQLite can't
 *  nest BEGIN. */
function resetChapterStatements(db: DatabaseSync, chapterId: string): void {
  db.prepare('DELETE FROM lesson_progress WHERE chapter_id=?').run(chapterId)
  db.prepare(
    `UPDATE chapter_progress
       SET segments_done=0, completed=0, boss_won=0, updated_at=?
     WHERE chapter_id=?`
  ).run(Date.now(), chapterId)
  // Zero attempts + passed so the learner starts the test fresh after redoing the
  // lessons; keep best_pct.
  db.prepare(
    'UPDATE chapter_test SET attempts=0, passed=0, updated_at=? WHERE chapter_id=?'
  ).run(Date.now(), chapterId)
}

/**
 * Record a chapter-test attempt: SERVER-AUTHORITATIVE. The client sends only the
 * raw score (plus the attempt number it THINKS it's on; accepted as advisory
 * telemetry, never used to derive state); the server:
 *   1. recomputes passed = scorePct >= chapter.test.passThreshold (the client's
 *      opinion is never trusted),
 *   2. advances the stored attempt counter itself: every failing submission is
 *      one more attempt, capped at MAX_ATTEMPTS, so a stale or tampered client
 *      attemptNo can't pin the counter below the cap,
 *   3. on a FRESH pass marks the chapter itself completed (completeChapter; the
 *      completion authority for new-model chapters; the legacy segments flow has
 *      its own school:completeChapter IPC),
 *   4. detects a TRUE second fail (not passed AND attempts have reached
 *      MAX_ATTEMPTS) and, on it, calls resetChapterForRetake() to force the whole
 *      chapter to be redone,
 * and returns the authoritative {passed, attempts, mustRetake, bestPct}. passed is
 * sticky (stays passed); best_pct keeps the max ever (survives a retake reset).
 */
export function recordTest(
  chapterId: string,
  scorePct: number,
  _attemptNo: number
): TestRecordResult {
  const db = getAppDb()
  const existing = db
    .prepare('SELECT attempts, passed, best_pct FROM chapter_test WHERE chapter_id=?')
    .get(chapterId) as unknown as
    | { attempts: number; passed: number; best_pct: number }
    | undefined

  // (1) Recompute pass/fail from the authoritative chapter threshold. A missing
  // chapter/test falls back to the spec default (0.7) so a bogus id can't pass.
  const threshold = getChapter(chapterId)?.test?.passThreshold ?? 0.7
  const wasPassed = (existing?.passed ?? 0) === 1
  const passedNow = scorePct >= threshold

  // (2) Server-derived attempt counter. Once already passed, the lockout doesn't
  // apply (practice re-takes don't burn attempts); otherwise every recorded
  // submission is one more attempt, capped at MAX_ATTEMPTS.
  const attempts = wasPassed
    ? existing?.attempts ?? 0
    : Math.min(MAX_ATTEMPTS, (existing?.attempts ?? 0) + 1)

  const passedFlag = passedNow || wasPassed ? 1 : 0
  const bestPct = Math.max(existing?.best_pct ?? 0, scorePct)
  const now = Date.now()

  // (4) True second fail: not (now or previously) passed AND we've hit the cap.
  const mustRetake = !passedNow && !wasPassed && attempts >= MAX_ATTEMPTS

  // All writes of one recorded attempt land atomically (house BEGIN/COMMIT
  // idiom): the chapter_test upsert, the study-log row, a fresh pass's chapter
  // completion, and a second-fail retake reset can never be torn apart by a
  // crash mid-sequence. appendProgressEvent/completeChapter run on the same
  // singleton connection, so their statements join this transaction.
  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO chapter_test(chapter_id, attempts, passed, best_pct, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(chapter_id) DO UPDATE SET
         attempts=?,
         passed=?,
         best_pct=?,
         updated_at=excluded.updated_at`
    ).run(chapterId, attempts, passedFlag, bestPct, now, attempts, passedFlag, bestPct)

    appendProgressEvent('test', chapterId, scorePct)

    // (3) Fresh pass ⇒ the chapter itself is complete (chapter_progress.completed;
    // new-model chapters have no other completion path). bossWon=false keeps
    // boss_won sticky: a prior win is never cleared, and none is claimed here.
    if (passedNow && !wasPassed) completeChapter(chapterId, false)

    if (mustRetake) {
      // The retake reset zeroes attempts/passed/progress (keeps best_pct) so the
      // learner redoes the chapter. We just wrote attempts=2; the reset clears it.
      // Transaction-free variant: we're already inside BEGIN.
      resetChapterStatements(db, chapterId)
    }

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return {
    passed: passedFlag === 1,
    attempts: mustRetake ? 0 : attempts,
    mustRetake,
    bestPct
  }
}

/** Current chapter-test state (zeroed if never attempted). */
export function getTestState(chapterId: string): {
  attempts: number
  passed: boolean
  bestPct: number
} {
  const db = getAppDb()
  const row = db
    .prepare('SELECT attempts, passed, best_pct FROM chapter_test WHERE chapter_id=?')
    .get(chapterId) as unknown as
    | { attempts: number; passed: number; best_pct: number }
    | undefined
  return {
    attempts: row?.attempts ?? 0,
    passed: (row?.passed ?? 0) === 1,
    bestPct: row?.best_pct ?? 0
  }
}
