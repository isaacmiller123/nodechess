import { z } from 'zod'
import { parseFen, makeFen } from 'chessops/fen'
import { handle } from './util'
import { chapterMetas, getChapter, chapterEloFloor, chaptersToAutocomplete } from '../school/school.repo'
import {
  getMastery,
  recordConcept,
  recordSegment,
  completeChapter,
  recordLesson,
  recordTest,
  getTestState,
  bulkCompleteChapters
} from '../school/mastery.repo'
import {
  getPlacementState,
  recordPlacementGame,
  resetPlacement,
  bumpPlacementFloor,
  PLACEMENT_ENGINE_ELO
} from '../school/placement.repo'
import { recommendNextChapter } from '../school/recommend'
import { getDueConcepts, reviewConcept, upsertSchedule } from '../school/srs.repo'
import { pickDailyLesson, recordSchoolDay, schoolStreak } from '../school/daily.repo'
import { narrate, debrief } from '../coach/viktor'
import type {
  SchoolNarrateReq,
  SchoolDebriefMove,
  TestRecordResult,
  RecommendedChapter,
  DueConcept,
  ConceptReview,
  SchoolDaily,
  DailyStreak
} from '../../shared/types'

/**
 * Chess School IPC (Viktor). Eight channels, all gated by the shared handle()
 * helper (origin + zod). Chapters/mastery come from the repos; concept/segment/
 * completion writes go through mastery.repo; narrate is a synchronous Viktor call
 * (no engine), debrief awaits Viktor's bounded engine pass.
 *
 *   school:chapters        {}                         -> { chapters }
 *   school:chapter         { id }                      -> { chapter }
 *   school:mastery         {}                          -> SchoolMastery
 *   school:recordConcept   { conceptId, correct }      -> { mastery }
 *   school:recordSegment   { chapterId, segmentsDone } -> { ok }
 *   school:completeChapter { chapterId, bossWon }      -> { ok }
 *   school:narrate         SchoolNarrateReq            -> { line }
 *   school:debrief         { chapterId, userColor, moves } -> SchoolDebrief
 */

// Parse + re-serialize a FEN before it can reach the engine, exactly as
// engine.ipc.ts does, so a malicious renderer payload can't smuggle newlines or
// extra UCI commands into the engine's stdin. Throws on an invalid FEN.
function safeFen(fen: string): string {
  const setup = parseFen(fen)
  if (setup.isErr) throw new Error('school: invalid FEN')
  return makeFen(setup.value)
}

const engineEvalSchema = z
  .object({
    cp: z.number().nullable().optional(),
    mate: z.number().int().nullable().optional()
  })
  .strict()

// Wire bounds (mirroring server/review.ts): these channels are served to
// anonymous callers by the web bridge, so every array/string is capped. The
// caps only need to (a) sit safely ABOVE the largest payload the desktop
// renderer legitimately sends and (b) be bounded. The 1 MiB body limit + any
// low-thousands cap already defeats the mutex-stall DoS, so the generous
// headroom below costs nothing on the security axis and can never reject a
// real payload. A FEN is ≤~90 chars, a UCI move ≤5. An engine principal
// variation can run deep (CoachHint forwards the raw analysis PV), so pv is
// capped well above any real search depth. knownConceptIds sits above the full
// curriculum concept catalog (~266 today).
const fenField = z.string().min(1).max(128)
const uciField = z.string().min(1).max(8)
const pvField = z.array(uciField).max(256).default([])

const narrateSchema = z
  .object({
    fenBefore: fenField,
    played: uciField,
    best: uciField,
    pv: pvField,
    evalBefore: engineEvalSchema,
    evalAfter: engineEvalSchema,
    knownConceptIds: z.array(z.string().max(64)).max(1024).default([]),
    ply: z.number().int().optional()
  })
  .strict()

const debriefMoveSchema = z
  .object({
    ply: z.number().int(),
    fenBefore: fenField,
    played: uciField,
    best: z.string().max(8),
    pv: pvField,
    evalBefore: engineEvalSchema,
    evalAfter: engineEvalSchema,
    byUser: z.boolean()
  })
  .strict()

const debriefSchema = z
  .object({
    chapterId: z.string().min(1).max(64),
    userColor: z.enum(['white', 'black']),
    moves: z.array(debriefMoveSchema).max(1024)
  })
  .strict()

export function registerSchool(): void {
  handle('school:chapters', z.object({}).strict(), () => ({ chapters: chapterMetas() }))

  handle('school:chapter', z.object({ id: z.string().min(1) }).strict(), ({ id }) => {
    const ch = getChapter(id)
    if (!ch) return { chapter: null }
    // Spec §2.2a: the internal Elo band gates unlocks but is NEVER sent to the
    // renderer: strip it here exactly as chapterMetas() strips it from the cards.
    const { eloFloor: _hidden, ...safe } = ch
    return { chapter: safe }
  })

  handle('school:mastery', z.object({}).strict(), () => getMastery())

  handle(
    'school:recordConcept',
    z.object({ conceptId: z.string().min(1), correct: z.boolean() }).strict(),
    ({ conceptId, correct }) => {
      const result = recordConcept(conceptId, correct)
      // Seed the concept's SRS card the first time it is taught (no-op when a card
      // already exists. An in-flight schedule is never reset) so taught concepts
      // actually enter the review queue. Seeded HERE rather than inside
      // mastery.repo.recordConcept to avoid a mastery.repo <-> srs.repo import
      // cycle (srs.repo already imports recordConcept for its review path).
      upsertSchedule({ conceptId })
      return result
    }
  )

  handle(
    'school:recordSegment',
    z.object({ chapterId: z.string().min(1), segmentsDone: z.number().int().min(0) }).strict(),
    ({ chapterId, segmentsDone }) => {
      recordSegment(chapterId, segmentsDone)
      return { ok: true }
    }
  )

  handle(
    'school:completeChapter',
    z.object({ chapterId: z.string().min(1), bossWon: z.boolean() }).strict(),
    ({ chapterId, bossWon }) => {
      completeChapter(chapterId, bossWon)
      return { ok: true }
    }
  )

  handle('school:narrate', narrateSchema, (args) => {
    // SAFE-FEN the position before any engine-adjacent work (explainMove replays
    // it through chessops; normalizing here keeps the contract with the engine).
    const req: SchoolNarrateReq = { ...args, fenBefore: safeFen(args.fenBefore) }
    return { line: narrate(req) }
  })

  handle('school:debrief', debriefSchema, (args) => {
    // SAFE-FEN every supplied position before Viktor hands any of them to the
    // analysis engine. An invalid FEN throws (validated payload, surfaced to UI).
    const moves: SchoolDebriefMove[] = args.moves.map((m) => ({
      ...m,
      fenBefore: safeFen(m.fenBefore)
    }))
    return debrief({ chapterId: args.chapterId, userColor: args.userColor, moves })
  })

  handle(
    'school:recordLesson',
    z.object({ chapterId: z.string().min(1), lessonId: z.string().min(1) }).strict(),
    ({ chapterId, lessonId }) => {
      recordLesson(chapterId, lessonId)
      // Completing any lesson is a study action: count today (the LOCAL day,
      // recordSchoolDay defaults to it) toward the school streak. Written here so
      // there is exactly ONE lesson_done writer. The renderer never calls
      // school:recordDaily itself.
      recordSchoolDay({ lesson: true })
      return { ok: true }
    }
  )

  handle(
    'school:recordTest',
    // Client no longer asserts pass/fail. The server recomputes it from the
    // chapter's threshold (server-authoritative). Only the raw score + the attempt
    // number the client thinks it's on are accepted.
    z
      .object({
        chapterId: z.string().min(1),
        scorePct: z.number(),
        attemptNo: z.number().int().min(0)
      })
      .strict(),
    ({ chapterId, scorePct, attemptNo }): TestRecordResult => {
      const result = recordTest(chapterId, scorePct, attemptNo)
      // Mis-placement correction (spec §1/§4): passing a chapter's test proves the
      // user belongs at least at that chapter's internal band, so raise the
      // estimate to its floor (never lowers; only meaningful once placed). Gated on
      // the SERVER-recomputed verdict, not the client's claim.
      if (result.passed) bumpPlacementFloor(chapterEloFloor(chapterId))
      return result
    }
  )

  handle(
    'school:testState',
    z.object({ chapterId: z.string().min(1) }).strict(),
    ({ chapterId }) => getTestState(chapterId)
  )

  handle('school:placementState', z.object({}).strict(), () => getPlacementState())

  handle(
    'school:recordPlacementGame',
    z
      .object({
        engineElo: z.number().int().min(0),
        accuracy: z.number().min(0).max(100),
        moveCount: z.number().int().min(1)
      })
      .strict(),
    ({ engineElo, accuracy, moveCount }) => {
      const state = recordPlacementGame(engineElo, accuracy, moveCount)
      // Placement pre-completes everything up to the 2nd-highest unlocked chapter:
      // the learner has tested out of that material, so it shows as fully finished
      // (all lessons done + chapter completed). The highest unlocked chapter is
      // left as their current starting point. bulkCompleteChapters RECONCILES: it
      // also prunes auto-completions outside the new set, so a game that lowers
      // the blended estimate retracts what the higher one granted.
      bulkCompleteChapters(chaptersToAutocomplete(state.estimatedElo ?? 0))
      return state
    }
  )

  handle('school:resetPlacement', z.object({}).strict(), () => resetPlacement())

  // Surface the fixed placement calibration level to the renderer so it doesn't
  // hardcode it (and stays within engine.play's uciElo>=1320 floor).
  handle('school:placementConfig', z.object({}).strict(), () => ({
    engineElo: PLACEMENT_ENGINE_ELO
  }))

  // -------------------------------------------------------------------------
  // School "next steps" surface: weakness-driven recommendation (Feature 2),
  // spaced repetition of concepts (Feature 3), daily lesson + local-day streak
  // (Feature 4). Each delegates to a repo function owned by a builder slice
  // (recommend.ts / srs.repo.ts / daily.repo.ts), thin IPC, zod-validated.
  //
  //   school:recommend      {}                   -> { recommended }
  //   school:dueReviews     { limit? }           -> { due }
  //   school:reviewConcept  { conceptId, correct }-> ConceptReview
  //   school:daily          {}                   -> SchoolDaily
  //   school:recordDaily    { ymd }              -> { streak }
  //   school:streak         {}                   -> { streak }
  // -------------------------------------------------------------------------

  handle('school:recommend', z.object({}).strict(), (): { recommended: RecommendedChapter | null } => ({
    recommended: recommendNextChapter()
  }))

  handle(
    'school:dueReviews',
    z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(),
    (req): { due: DueConcept[] } => ({ due: getDueConcepts(req) })
  )

  handle(
    'school:reviewConcept',
    z.object({ conceptId: z.string().min(1), correct: z.boolean() }).strict(),
    (req): ConceptReview => reviewConcept(req)
  )

  handle('school:daily', z.object({}).strict(), (): SchoolDaily => pickDailyLesson())

  handle(
    'school:recordDaily',
    z.object({ ymd: z.string().min(1) }).strict(),
    ({ ymd }): { streak: DailyStreak } => ({ streak: recordSchoolDay({ ymd }) })
  )

  handle('school:streak', z.object({}).strict(), (): { streak: DailyStreak } => ({
    streak: schoolStreak()
  }))
}
