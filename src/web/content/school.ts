// Curriculum content, read from the static content tree instead of
// school:chapters / school:chapter.
//
// The chapter FILES are the same JSON the desktop main process reads. What the
// desktop does on top of them (decide which chapters are unlocked) is
// reproduced here from src/main/school/school.repo.ts chapterMetas(), because
// that decision is progress-dependent and progress now lives on the client.
//
// SPEC NOTE (docs/SCHOOL-SPEC.md §2.2a): a chapter's internal `eloFloor` gates
// unlocks and is never shown or sent to the renderer. Computing the gate in the
// browser means the number has to REACH the browser: it rides in the chapter
// index and is used only by the comparison below. `getChapter()` strips it
// before returning, exactly as the desktop IPC handler does, so nothing
// renderable ever holds it.

import type { SchoolChapter, SchoolChapterMeta } from '@shared/types'
import { loadContent } from './fetchContent'

/** One index row: a chapter card plus the internal floor the gate needs. */
export interface ChapterIndexEntry {
  id: string
  band: string
  order: number
  title: string
  subtitle: string
  estMinutes: number
  conceptCount: number
  lessonCount: number
  eloFloor: number
}

/** What the unlock rule needs to know about the learner. The web app has no
 *  server to ask, so the caller (webApi) assembles this from whatever local
 *  progress exists, today: placement is the gate and nothing is placed. */
export interface SchoolProgressView {
  placed: boolean
  estimatedElo: number | null
  /** Chapter ids completed (boss won / pre-completed by placement). */
  completed: ReadonlySet<string>
  /** Chapter ids whose chapter test was passed. */
  testPassed: ReadonlySet<string>
  /** Chapter id -> lessons marked done. */
  doneLessons: ReadonlyMap<string, number>
}

export const NO_SCHOOL_PROGRESS: SchoolProgressView = {
  placed: false,
  estimatedElo: null,
  completed: new Set(),
  testPassed: new Set(),
  doneLessons: new Map()
}

function index(): Promise<ChapterIndexEntry[]> {
  return loadContent<{ chapters?: ChapterIndexEntry[] }>('school/chapters.json').then((f) =>
    Array.isArray(f.chapters) ? f.chapters : []
  )
}

/** The raw index, curriculum order, INCLUDING each chapter's internal eloFloor.
 *  Only the progress store may read this: the floor drives placement's unlock
 *  and pre-completion and must never reach a renderable shape (spec §2.2a). */
export function chapterIndex(): Promise<ChapterIndexEntry[]> {
  return index()
}

/**
 * Chapter cards in curriculum order, with the desktop's unlock rule applied.
 *
 * A chapter is UNLOCKED when the learner is placed AND either its eloFloor is
 * within the placement estimate, OR the PREVIOUS chapter is itself within the
 * estimate and cleared, so finishing your top chapter opens the next one, one
 * step above your placement. "Cleared" = completed, or its test passed, or all
 * its lessons done. Keep this in lockstep with school.repo.chapterMetas(): the
 * chain-link's within-estimate condition is load-bearing (spec §1), not an
 * optimisation.
 */
export async function chapterMetas(progress: SchoolProgressView): Promise<SchoolChapterMeta[]> {
  const chapters = await index()
  const estElo = progress.estimatedElo ?? 0

  const cleared = (c: ChapterIndexEntry): boolean => {
    if (progress.completed.has(c.id) || progress.testPassed.has(c.id)) return true
    return c.lessonCount > 0 && (progress.doneLessons.get(c.id) ?? 0) >= c.lessonCount
  }

  return chapters.map((c, i) => {
    const prev = i > 0 ? chapters[i - 1] : null
    const chainFromPrev = prev != null && prev.eloFloor <= estElo && cleared(prev)
    const unlocked = progress.placed && (c.eloFloor <= estElo || chainFromPrev)
    return {
      id: c.id,
      band: c.band,
      order: c.order,
      title: c.title,
      subtitle: c.subtitle,
      estMinutes: c.estMinutes,
      conceptCount: c.conceptCount,
      lessonCount: c.lessonCount,
      locked: !unlocked,
      lockReason: !unlocked ? (!progress.placed ? 'placement' : 'elo') : undefined
    }
  })
}

/** Full chapter by id (segments, steps, coach lines), or null when unknown.
 *  eloFloor is stripped. Spec §2.2a. */
export async function getChapter(id: string): Promise<SchoolChapter | null> {
  const known = await index()
  if (!known.some((c) => c.id === id)) return null
  const chapter = await loadContent<SchoolChapter & { eloFloor?: number }>(
    `school/chapter/${encodeURIComponent(id)}.json`
  )
  const { eloFloor: _hidden, ...safe } = chapter
  return safe
}
