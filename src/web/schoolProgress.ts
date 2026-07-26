// School PROGRESS for the web target: the browser's copy of the desktop's
// school tables (school_placement, placement_game, chapter_progress,
// lesson_progress, chapter_test, concept_mastery, study day log).
//
// Without this the web build could read the curriculum but could not record a
// single thing about it, so `school:recordPlacementGame` rejected, placement
// never completed, and every one of the forty chapters stayed locked behind a
// gate that could not be opened. Reading a school you can never enter is not a
// school.
//
// The rules are NOT reinvented here. Each function below mirrors the desktop
// repo that owns it, and says which one:
//   placement + blend       src/main/school/placement.repo.ts
//   unlock + autocomplete   src/main/school/school.repo.ts
//   mastery + test verdict  src/main/school/mastery.repo.ts
//   local-day study streak  src/main/school/daily.repo.ts
// The Elo estimate this file computes is INTERNAL grouping only (SCHOOL-SPEC
// §2.2a): it gates unlocks and is never returned in anything renderable.
//
// Nothing is synthesised. An untouched browser reads as an unplaced learner
// with no progress, which is exactly what it is.

import {
  MAX_ATTEMPTS,
  type ChapterProgressRow,
  type ConceptMastery,
  type DailyStreak,
  type PlacementGameResult,
  type PlacementState,
  type SchoolDaily,
  type SchoolMastery,
  type TestRecordResult
} from '@shared/types'
import { estimateElo } from '../main/analysis/estElo'
import { storageGet, storageSet } from './localData'
import { chapterIndex, getChapter, type SchoolProgressView } from './content/school'

const KEY = 'chess-sharp.school.v1'

/** Study days kept for the calendar strip. The desktop's log is unbounded; a
 *  browser profile is not, so the tail is dropped. */
const MAX_DAYS = 400

interface GameRec {
  engineElo: number
  accuracy: number
  moveCount: number
  est: number
  low: number
  high: number
  at: number
}

interface ChapterRec {
  segmentsDone: number
  completed: boolean
  bossWon: boolean
  /** Written by placement's bulk pre-completion, not earned by the learner.
   *  A re-placement retracts these and never the earned ones. */
  auto: boolean
}

interface LessonRec {
  chapterId: string
  auto: boolean
}

interface TestRec {
  attempts: number
  passed: boolean
  bestPct: number
}

interface ConceptRec {
  mastery: number
  seen: number
  correct: number
}

interface Store {
  placed: boolean
  estimatedElo: number | null
  estLow: number | null
  estHigh: number | null
  games: GameRec[]
  chapters: Record<string, ChapterRec>
  /** lessonId -> record. Lesson ids are unique across the curriculum. */
  lessons: Record<string, LessonRec>
  tests: Record<string, TestRec>
  concepts: Record<string, ConceptRec>
  /** Local YYYY-MM-DD days with study on them, ascending. */
  days: string[]
}

function empty(): Store {
  return {
    placed: false,
    estimatedElo: null,
    estLow: null,
    estHigh: null,
    games: [],
    chapters: {},
    lessons: {},
    tests: {},
    concepts: {},
    days: []
  }
}

function read(): Store {
  const raw = storageGet(KEY)
  if (!raw) return empty()
  try {
    const parsed = JSON.parse(raw) as Partial<Store>
    return { ...empty(), ...parsed }
  } catch {
    return empty()
  }
}

function write(s: Store): void {
  storageSet(KEY, JSON.stringify(s))
}

// ---- placement -----------------------------------------------------------------
// placement.repo.ts: each finished game appends its own Elo band and the standing
// estimate is the inverse-variance blend of every band, so a second game narrows
// or corrects the first. The estimate may move DOWN.

function bandOf(g: GameRec): PlacementGameResult {
  return {
    engineElo: g.engineElo,
    accuracy: g.accuracy,
    moveCount: g.moveCount,
    band: { est: g.est, low: g.low, high: g.high, accuracy: g.accuracy, kind: 'estimate' }
  }
}

/** Weight one band contributes to the blend: a tighter band weighs more. */
function weightOf(g: GameRec): number {
  const half = Math.max(1, (g.high - g.low) / 2)
  return 1 / (half * half)
}

function blendedAccuracy(games: GameRec[]): number {
  let wSum = 0
  let wAcc = 0
  for (const g of games) {
    const w = weightOf(g)
    wSum += w
    wAcc += w * g.accuracy
  }
  return wSum > 0 ? Math.round((wAcc / wSum) * 10) / 10 : 0
}

function stateOf(s: Store): PlacementState {
  const est = s.estimatedElo
  return {
    placed: s.placed,
    estimatedElo: est,
    band:
      est != null
        ? {
            est,
            low: s.estLow ?? est,
            high: s.estHigh ?? est,
            accuracy: blendedAccuracy(s.games),
            kind: 'estimate'
          }
        : null,
    games: s.games.map(bandOf)
  }
}

export function getPlacementState(): PlacementState {
  return stateOf(read())
}

/**
 * Record one finished placement game and return the converged state.
 *
 * The caller MUST pass an accuracy it actually measured. There is no default
 * here on purpose: an invented accuracy would set the internal estimate and
 * therefore decide which chapters open (SCHOOL-SPEC §1).
 */
export async function recordPlacementGame(
  engineElo: number,
  accuracy: number,
  moveCount: number
): Promise<PlacementState> {
  const s = read()
  const band = estimateElo(accuracy, moveCount)
  s.games.push({
    engineElo,
    accuracy,
    moveCount,
    est: band.est,
    low: band.low,
    high: band.high,
    at: Date.now()
  })

  let wSum = 0
  let wEst = 0
  for (const g of s.games) {
    const w = weightOf(g)
    wSum += w
    wEst += w * g.est
  }
  const est = Math.round(wEst / wSum)
  const halfWidth = Math.round(Math.sqrt(1 / wSum))
  s.placed = true
  s.estimatedElo = est
  s.estLow = est - halfWidth
  s.estHigh = est + halfWidth
  write(s)

  // school.ipc.ts: placement pre-completes every unlocked chapter EXCEPT the
  // highest one, which becomes the learner's starting chapter. Reconciling (not
  // just adding) is what lets a second, weaker game retract what the first gave.
  await bulkCompleteChapters(est)
  return stateOf(read())
}

export function resetPlacement(): PlacementState {
  const s = read()
  // Only the auto-written rows go. What the learner earned survives a re-place:
  // the spec re-derives the gate, it does not confiscate work.
  for (const [id, rec] of Object.entries(s.chapters)) if (rec.auto) delete s.chapters[id]
  for (const [id, rec] of Object.entries(s.lessons)) if (rec.auto) delete s.lessons[id]
  s.games = []
  s.placed = false
  s.estimatedElo = null
  s.estLow = null
  s.estHigh = null
  write(s)
  return stateOf(s)
}

/** school.repo.chaptersToAutocomplete + mastery.repo.bulkCompleteChapters, in
 *  one pass: everything unlocked below the top unlocked chapter reads as fully
 *  finished, and auto-rows outside that set are pruned. */
async function bulkCompleteChapters(estElo: number): Promise<void> {
  const chapters = await chapterIndex()
  const unlocked = chapters.filter((c) => c.eloFloor <= estElo)
  const target = unlocked.length <= 1 ? [] : unlocked.slice(0, -1)
  const targetIds = new Set(target.map((c) => c.id))

  const s = read()
  for (const [id, rec] of Object.entries(s.chapters)) {
    if (rec.auto && !targetIds.has(id)) delete s.chapters[id]
  }
  for (const [id, rec] of Object.entries(s.lessons)) {
    if (rec.auto && !targetIds.has(rec.chapterId)) delete s.lessons[id]
  }

  for (const c of target) {
    const prev = s.chapters[c.id]
    if (!prev?.completed) {
      s.chapters[c.id] = {
        segmentsDone: prev?.segmentsDone ?? 0,
        completed: true,
        bossWon: prev?.bossWon ?? false,
        auto: prev ? prev.auto : true
      }
    }
    const full = await getChapter(c.id)
    for (const lesson of full?.lessons ?? []) {
      if (!s.lessons[lesson.id]) s.lessons[lesson.id] = { chapterId: c.id, auto: true }
    }
  }
  write(s)
}

// ---- the unlock view the chapter index is built from ---------------------------

export function progressView(): SchoolProgressView {
  const s = read()
  const doneLessons = new Map<string, number>()
  for (const rec of Object.values(s.lessons)) {
    doneLessons.set(rec.chapterId, (doneLessons.get(rec.chapterId) ?? 0) + 1)
  }
  return {
    placed: s.placed,
    estimatedElo: s.estimatedElo,
    completed: new Set(
      Object.entries(s.chapters)
        .filter(([, r]) => r.completed)
        .map(([id]) => id)
    ),
    testPassed: new Set(
      Object.entries(s.tests)
        .filter(([, r]) => r.passed)
        .map(([id]) => id)
    ),
    doneLessons
  }
}

// ---- mastery -------------------------------------------------------------------
// mastery.repo.ts.

export function getMastery(): SchoolMastery {
  const s = read()
  const concepts: ConceptMastery[] = Object.entries(s.concepts).map(([conceptId, r]) => ({
    conceptId,
    mastery: r.mastery,
    seen: r.seen,
    correct: r.correct
  }))
  const chapters: ChapterProgressRow[] = Object.entries(s.chapters).map(([chapterId, r]) => ({
    chapterId,
    segmentsDone: r.segmentsDone,
    completed: r.completed,
    bossWon: r.bossWon
  }))
  const lessons = Object.entries(s.lessons).map(([lessonId, r]) => ({
    chapterId: r.chapterId,
    lessonId
  }))
  return { concepts, chapters, lessons }
}

/** Rolling mastery, same exponential the desktop uses (alpha 0.3). */
export function recordConcept(conceptId: string, correct: boolean): { mastery: number } {
  const s = read()
  const prev = s.concepts[conceptId] ?? { mastery: 0, seen: 0, correct: 0 }
  const mastery = prev.seen === 0 ? (correct ? 1 : 0) : prev.mastery * 0.7 + (correct ? 1 : 0) * 0.3
  s.concepts[conceptId] = {
    mastery,
    seen: prev.seen + 1,
    correct: prev.correct + (correct ? 1 : 0)
  }
  write(s)
  return { mastery }
}

export function recordSegment(chapterId: string, segmentsDone: number): void {
  const s = read()
  const prev = s.chapters[chapterId]
  s.chapters[chapterId] = {
    segmentsDone: Math.max(prev?.segmentsDone ?? 0, segmentsDone),
    completed: prev?.completed ?? false,
    bossWon: prev?.bossWon ?? false,
    auto: false
  }
  write(s)
}

export function completeChapter(chapterId: string, bossWon: boolean): void {
  const s = read()
  const prev = s.chapters[chapterId]
  s.chapters[chapterId] = {
    segmentsDone: prev?.segmentsDone ?? 0,
    completed: true,
    // Sticky: a prior win is never cleared, and none is claimed here.
    bossWon: (prev?.bossWon ?? false) || bossWon,
    auto: false
  }
  write(s)
  markStudied()
}

export function recordLesson(chapterId: string, lessonId: string): void {
  const s = read()
  s.lessons[lessonId] = { chapterId, auto: false }
  write(s)
  markStudied()
}

// ---- the chapter test ----------------------------------------------------------
// mastery.repo.recordTest: THIS side is authoritative on pass/fail, attempts and
// the forced retake. The renderer sends a raw score and nothing else.

export async function recordTest(
  chapterId: string,
  scorePct: number
): Promise<TestRecordResult> {
  const chapter = await getChapter(chapterId)
  const threshold = chapter?.test?.passThreshold ?? 0.7

  const s = read()
  const existing = s.tests[chapterId]
  const wasPassed = existing?.passed ?? false
  const passedNow = scorePct >= threshold
  // An already-passed chapter is practice: re-takes do not burn attempts.
  const attempts = wasPassed
    ? (existing?.attempts ?? 0)
    : Math.min(MAX_ATTEMPTS, (existing?.attempts ?? 0) + 1)
  const bestPct = Math.max(existing?.bestPct ?? 0, scorePct)
  const mustRetake = !passedNow && !wasPassed && attempts >= MAX_ATTEMPTS

  s.tests[chapterId] = { attempts, passed: passedNow || wasPassed, bestPct }

  if (passedNow && !wasPassed) {
    const prev = s.chapters[chapterId]
    s.chapters[chapterId] = {
      segmentsDone: prev?.segmentsDone ?? 0,
      completed: true,
      bossWon: prev?.bossWon ?? false,
      auto: false
    }
  }

  if (mustRetake) {
    // Two failures means the chapter is redone from the top: attempts, pass flag
    // and lesson completion all clear. best_pct is history and survives.
    s.tests[chapterId] = { attempts: 0, passed: false, bestPct }
    delete s.chapters[chapterId]
    for (const [id, rec] of Object.entries(s.lessons)) {
      if (rec.chapterId === chapterId) delete s.lessons[id]
    }
  }

  write(s)
  markStudied()

  // Mis-placement correction (spec §1/§4): passing a chapter's test proves the
  // learner belongs at least at that chapter's internal band. Raises only.
  if (passedNow) await bumpPlacementFloor(chapterId)

  return {
    passed: passedNow || wasPassed,
    attempts: mustRetake ? 0 : attempts,
    mustRetake,
    bestPct
  }
}

export function getTestState(chapterId: string): {
  attempts: number
  passed: boolean
  bestPct: number
} {
  const rec = read().tests[chapterId]
  return {
    attempts: rec?.attempts ?? 0,
    passed: rec?.passed ?? false,
    bestPct: rec?.bestPct ?? 0
  }
}

async function bumpPlacementFloor(chapterId: string): Promise<void> {
  const entry = (await chapterIndex()).find((c) => c.id === chapterId)
  if (!entry) return
  const s = read()
  // A pass before placement is ignored: there is no estimate to raise.
  if (!s.placed) return
  if (entry.eloFloor <= (s.estimatedElo ?? 0)) return
  s.estimatedElo = entry.eloFloor
  s.estHigh = Math.max(s.estHigh ?? entry.eloFloor, entry.eloFloor)
  write(s)
}

// ---- the local-day study log ---------------------------------------------------
// daily.repo.ts: a study day is a LOCAL day, same as the puzzle daily.

function todayYmd(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function markStudied(): void {
  const s = read()
  const ymd = todayYmd()
  if (s.days.includes(ymd)) return
  s.days.push(ymd)
  s.days.sort()
  if (s.days.length > MAX_DAYS) s.days = s.days.slice(-MAX_DAYS)
  write(s)
}

export function recordDaily(ymd: string): { streak: DailyStreak } {
  const s = read()
  if (!s.days.includes(ymd)) {
    s.days.push(ymd)
    s.days.sort()
    if (s.days.length > MAX_DAYS) s.days = s.days.slice(-MAX_DAYS)
    write(s)
  }
  return getStreak()
}

function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(y, m - 1, d + days)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

export function getStreak(): { streak: DailyStreak } {
  const s = read()
  const studied = new Set(s.days)
  const today = todayYmd()

  // Current run: today (or yesterday, if today is not done yet) backwards.
  let cursor = studied.has(today) ? today : shiftYmd(today, -1)
  let current = 0
  while (studied.has(cursor)) {
    current += 1
    cursor = shiftYmd(cursor, -1)
  }

  let best = 0
  let run = 0
  let prev: string | null = null
  for (const day of s.days) {
    run = prev != null && shiftYmd(prev, 1) === day ? run + 1 : 1
    if (run > best) best = run
    prev = day
  }

  // Most-recent-first, which is the order the calendar strip reverses.
  const recent: { ymd: string; solved: boolean }[] = []
  for (let i = 0; i < 10; i++) {
    const ymd = shiftYmd(today, -i)
    recent.push({ ymd, solved: studied.has(ymd) })
  }

  return { streak: { current, best, todaySolved: studied.has(today), recent } }
}

/**
 * Today's lesson: the first unfinished lesson of the first unlocked chapter that
 * still has one. Mirrors daily.repo.pickDailyLesson's intent (walk the unlocked
 * curriculum in order and hand back the next real thing to do) without its SRS
 * inputs, which this build does not keep.
 */
export async function getDaily(): Promise<SchoolDaily> {
  const view = progressView()
  const ymd = todayYmd()
  const base: SchoolDaily = {
    ymd,
    chapterId: null,
    chapterTitle: null,
    lessonId: null,
    lessonTitle: null,
    doneToday: read().days.includes(ymd),
    reviewsDue: 0
  }
  if (!view.placed) return base

  const s = read()
  const estElo = view.estimatedElo ?? 0
  for (const entry of await chapterIndex()) {
    if (entry.eloFloor > estElo) continue
    const chapter = await getChapter(entry.id)
    const lesson = (chapter?.lessons ?? []).find((l) => !s.lessons[l.id])
    if (!lesson) continue
    return {
      ...base,
      chapterId: entry.id,
      chapterTitle: entry.title,
      lessonId: lesson.id,
      lessonTitle: lesson.title
    }
  }
  return base
}
