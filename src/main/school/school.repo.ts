import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { SchoolChapter, SchoolChapterMeta } from '../../shared/types'
import { getPlacementState } from './placement.repo'
import { getAppDb } from '../db/database'

// Chess School chapters: one SchoolChapter per JSON file under
// resources/curriculum/chapters/*.json. Loaded once and cached for the process,
// mirroring the resource-load pattern in curriculum.repo.ts: in dev __dirname is
// <root>/out/main and ../../resources resolves to the repo's resources dir; in a
// packaged build the JSON ships under process.resourcesPath/curriculum/chapters.
// A missing/corrupt dir must never crash the UI. It degrades to an empty index.

let chapters: Map<string, SchoolChapter> | null = null

function chaptersDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'curriculum', 'chapters')
    : path.join(__dirname, '../../resources/curriculum/chapters')
}

function load(): Map<string, SchoolChapter> {
  if (chapters) return chapters
  const map = new Map<string, SchoolChapter>()
  try {
    const dir = chaptersDir()
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'))
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf-8')
        const chapter = JSON.parse(raw) as SchoolChapter
        if (chapter && typeof chapter.id === 'string' && chapter.id.length > 0) {
          map.set(chapter.id, chapter)
        }
      } catch {
        // Skip a single bad file rather than failing the whole index.
      }
    }
  } catch {
    // Missing dir (lean install): treat as an empty curriculum.
  }
  chapters = map
  return chapters
}

/**
 * Lightweight chapter cards for the school index, in curriculum order.
 *
 * A chapter is UNLOCKED when the learner is placed AND either (a) its internal
 * eloFloor is within the placement estimate (the placement prefix), OR (b) the
 * PREVIOUS chapter is WITHIN the estimate AND cleared, so completing your
 * current (top-of-estimate) chapter unlocks the next one, one step above your
 * placement level. "Cleared" = the chapter is completed (boss won / placement
 * pre-completed) OR its test passed OR all its lessons are done.
 *
 * The chain-link deliberately requires the previous chapter to sit within the
 * CURRENT estimate (spec §1: chapters unlock up to the estimated Elo; higher
 * chapters stay locked until you climb). Climbing that one-above chapter is done
 * by passing its test, which raises the estimate to its band (bumpPlacementFloor,
 * spec §4 mis-placement correction) and thereby extends the chain. Without the
 * within-estimate condition, a RE-PLACEMENT that lands LOWER would still walk the
 * chain up through the previous epoch's surviving EARNED completions (earned rows
 * intentionally survive resetPlacement. See placement.repo.resetPlacement) and
 * leave chapters far above the fresh estimate unlocked.
 *
 * The Elo numbers are NEVER put on the meta. Only the boolean + a name-based
 * reason (spec §2.2a: the band is an internal grouping).
 */
export function chapterMetas(): SchoolChapterMeta[] {
  const placement = getPlacementState()
  const estElo = placement.estimatedElo ?? 0
  const chapters = allChapters()

  // Completion signals for progression unlock: read directly (a mastery.repo
  // import would be circular, since mastery.repo imports getChapter from here).
  const db = getAppDb()
  const completedSet = new Set(
    (
      db.prepare('SELECT chapter_id FROM chapter_progress WHERE completed=1').all() as {
        chapter_id: string
      }[]
    ).map((r) => r.chapter_id)
  )
  const testPassedSet = new Set(
    (
      db.prepare('SELECT chapter_id FROM chapter_test WHERE passed=1').all() as {
        chapter_id: string
      }[]
    ).map((r) => r.chapter_id)
  )
  const doneLessonCount = new Map<string, number>()
  for (const r of db
    .prepare('SELECT chapter_id, COUNT(*) c FROM lesson_progress WHERE done=1 GROUP BY chapter_id')
    .all() as { chapter_id: string; c: number }[]) {
    doneLessonCount.set(r.chapter_id, r.c)
  }
  const cleared = (c: SchoolChapter): boolean => {
    if (completedSet.has(c.id) || testPassedSet.has(c.id)) return true
    const total = c.lessons?.length ?? 0
    return total > 0 && (doneLessonCount.get(c.id) ?? 0) >= total
  }

  return chapters.map((c, i) => {
    const floor = c.eloFloor ?? 0
    const prev = i > 0 ? chapters[i - 1] : null
    // Chain-link ONLY from a chapter inside the current estimate: a cleared
    // chapter ABOVE the estimate (e.g. an earned completion surviving a lower
    // re-placement) must not unlock its successor (spec §1).
    const chainFromPrev = prev != null && (prev.eloFloor ?? 0) <= estElo && cleared(prev)
    const unlocked = placement.placed && (floor <= estElo || chainFromPrev)
    return {
      id: c.id,
      band: c.band,
      order: c.order,
      title: c.title,
      subtitle: c.subtitle,
      estMinutes: c.estMinutes,
      conceptCount: c.concepts.length,
      lessonCount: c.lessons?.length ?? 0,
      locked: !unlocked,
      lockReason: !unlocked ? (!placement.placed ? 'placement' : 'elo') : undefined
    }
  })
}

/** The internal eloFloor for a chapter (0 if unknown): used by the test-pass
 *  mis-placement correction to know which band to unlock. NEVER sent to the UI. */
export function chapterEloFloor(id: string): number {
  return load().get(id)?.eloFloor ?? 0
}

/** Full chapter (with segments, steps, coach lines) by stable id, or null. */
export function getChapter(id: string): SchoolChapter | null {
  return load().get(id) ?? null
}

/** Every chapter, ordered by band then order: the canonical curriculum sequence
 *  (used by the recommender to walk to the "next" chapter). */
export function allChapters(): SchoolChapter[] {
  return [...load().values()].sort((a, b) =>
    a.band === b.band ? a.order - b.order : a.band < b.band ? -1 : 1
  )
}

/**
 * After placement, the chapters to auto-complete: every UNLOCKED chapter EXCEPT
 * the single highest one (the learner's current starting chapter). I.e. "every
 * lesson up to the 2nd-highest unlocked chapter is fully complete". The learner
 * has tested out of that material. Each entry carries its lesson ids so both
 * lesson_progress and chapter_progress can be marked. Returns [] when only one
 * (or zero) chapter is unlocked (nothing below the current one).
 */
export function chaptersToAutocomplete(
  estElo: number
): { chapterId: string; lessonIds: string[] }[] {
  const unlocked = allChapters().filter((c) => (c.eloFloor ?? 0) <= estElo)
  if (unlocked.length <= 1) return []
  return unlocked.slice(0, -1).map((c) => ({
    chapterId: c.id,
    lessonIds: (c.lessons ?? []).map((l) => l.id)
  }))
}

let conceptIndex: Map<string, { chapterId: string; title: string }> | null = null

/**
 * Reverse index conceptId -> { chapterId, title } built from the loaded chapter
 * JSON (each chapter's concepts[]). Lets the SRS/recommendation/daily code map a
 * bare concept id back to the chapter that teaches it (e.g. to deep-link a due
 * review, or to name the weak concepts behind a recommendation). Cached for the
 * process; if two chapters declare the same concept id the FIRST in curriculum
 * order wins (concepts are taught once, then merely referenced later).
 */
export function conceptToChapter(): Map<string, { chapterId: string; title: string }> {
  if (conceptIndex) return conceptIndex
  const map = new Map<string, { chapterId: string; title: string }>()
  for (const c of allChapters()) {
    for (const concept of c.concepts ?? []) {
      if (!map.has(concept.id)) map.set(concept.id, { chapterId: c.id, title: c.title })
    }
  }
  conceptIndex = map
  return conceptIndex
}
