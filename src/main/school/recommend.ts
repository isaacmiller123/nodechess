import type { RecommendedChapter, ChapterConcept } from '../../shared/types'
import { getMastery, getTestState } from './mastery.repo'
import { allChapters, chapterMetas, conceptToChapter } from './school.repo'

// ============================================================================
// FEATURE 2: Weakness-driven next-chapter recommendation.  ★ BUILDER SLICE 1 ★
//
// recommendNextChapter() picks the chapter Viktor should steer the learner to
// next, derived from per-concept mastery. The contract:
//   - Read mastery (concept_mastery via getMastery() in mastery.repo) + the
//     curriculum order (allChapters() in school.repo) + which chapters are
//     unlocked (chapterMetas() in school.repo: respects placement/Elo gating).
//   - Score each NOT-yet-passed, UNLOCKED chapter by how weak the learner is on
//     its concepts (low mastery / unseen concepts pull a chapter up).
//   - Return the best one with a NAME-BASED `reason` sentence (NEVER an internal
//     Elo or band number: spec §2.2a) and the display names of the concepts that
//     drove it (`weakConcepts`).
//   - Return null when nothing sensible to recommend (all caught up / all locked).
// ============================================================================

/** A concept whose mastery a NEVER-seen concept is treated as: fully weak. An
 *  unseen concept (no concept_mastery row) is the strongest possible pull. The
 *  learner has demonstrably not touched it yet. */
const UNSEEN_MASTERY = 0

/** Per-concept weakness above which a concept is considered a real gap worth
 *  naming/recommending. mastery 0..1; a concept at/above this is "solid enough"
 *  and contributes ~nothing. 0.6 ≈ "answered it right roughly twice net". */
const SOLID_MASTERY = 0.6

/** A concept's weakness in [0,1]: how far below "solid" its mastery sits, scaled
 *  so an unseen/zero concept = 1 (max pull) and a >=SOLID concept = 0 (no pull). */
function weakness(mastery: number): number {
  if (mastery >= SOLID_MASTERY) return 0
  return (SOLID_MASTERY - mastery) / SOLID_MASTERY
}

interface Scored {
  chapterId: string
  title: string
  subtitle: string
  order: number
  band: string
  /** Total weakness summed across the chapter's OWN (taught-here) concepts. */
  score: number
  /** This chapter's concepts that drove the score, weakest-first. */
  weak: { name: string; weakness: number }[]
}

/**
 * The next chapter to steer the learner to, derived purely from per-concept
 * mastery + curriculum order + unlock gating. Deterministic, no engine call.
 *
 * Strategy:
 *   1. Build a conceptId -> mastery (0..1) lookup from getMastery(); a concept
 *      with no row is UNSEEN (weakness 1; the strongest pull).
 *   2. Walk every chapter; skip the locked ones (chapterMetas() owns the
 *      placement/Elo gate) and the already-passed ones (test passed is sticky).
 *   3. Score a candidate by the summed weakness of the concepts it TEACHES
 *      (conceptToChapter() credits each concept to the chapter that introduces
 *      it, so a later chapter that merely references an earlier idea isn't pulled
 *      up by a gap that an earlier chapter owns).
 *   4. Pick the highest score; ties break toward the earlier chapter in
 *      curriculum order (knowledge strictly builds, spec §2.2a, fix the
 *      foundation first). The earliest unlocked-not-passed chapter is the natural
 *      fallback when the learner is fresh (everything unseen ⇒ all equal-ish, so
 *      curriculum order wins).
 *   5. Build a NAME-BASED reason from the chapter + its weakest concepts. Never
 *      mentions an internal Elo or band number (spec §2.2a).
 */
export function recommendNextChapter(): RecommendedChapter | null {
  const mastery = getMastery()
  const masteryById = new Map<string, number>()
  for (const c of mastery.concepts) masteryById.set(c.conceptId, c.mastery)

  // Locked-state lookup from the meta layer (it owns placement/Elo gating). If no
  // chapter is unlocked at all (e.g. before placement) we have nothing to suggest.
  const lockedById = new Map<string, boolean>()
  for (const m of chapterMetas()) lockedById.set(m.id, m.locked === true)

  // Which chapter "owns" each concept (the one that teaches it first). A concept
  // only contributes to the chapter that introduces it, never to a later chapter
  // that merely reuses it.
  const owner = conceptToChapter()

  const candidates: Scored[] = []
  for (const chapter of allChapters()) {
    // Skip locked chapters (gate is name-based to the user; the Elo behind it is
    // never surfaced). A chapter with no meta row defaults to locked=false.
    if (lockedById.get(chapter.id) === true) continue
    // Skip chapters the learner has already passed the test for (sticky pass).
    if (getTestState(chapter.id).passed) continue

    const concepts: ChapterConcept[] = chapter.concepts ?? []
    let score = 0
    const weak: { name: string; weakness: number }[] = []
    for (const concept of concepts) {
      // Credit a concept's weakness to this chapter only if this chapter is the
      // one that teaches it (otherwise an earlier owner already carries that gap).
      const ownedHere = owner.get(concept.id)?.chapterId === chapter.id
      if (!ownedHere) continue
      const m = masteryById.has(concept.id) ? masteryById.get(concept.id)! : UNSEEN_MASTERY
      const w = weakness(m)
      score += w
      if (w > 0) weak.push({ name: concept.name, weakness: w })
    }

    // A chapter with no own-concept weakness (fully solid / all its concepts are
    // owned elsewhere) is not worth recommending. Drop it.
    if (score <= 0) continue

    weak.sort((a, b) => b.weakness - a.weakness)
    candidates.push({
      chapterId: chapter.id,
      title: chapter.title,
      subtitle: chapter.subtitle,
      order: chapter.order,
      band: chapter.band,
      score,
      weak
    })
  }

  if (candidates.length === 0) return null

  // Highest weakness wins; on a tie, the earlier chapter in curriculum order
  // (band then order: the canonical sequence) so foundations are fixed first.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.band !== b.band) return a.band < b.band ? -1 : 1
    return a.order - b.order
  })

  const best = candidates[0]
  const weakNames = best.weak.map((w) => w.name)
  return {
    chapterId: best.chapterId,
    title: best.title,
    subtitle: best.subtitle,
    reason: buildReason(best.title, weakNames),
    // Cap the named concepts so the card stays readable; the full set still drove
    // the score. Three is plenty for a "because you're shaky on X, Y and Z" line.
    weakConcepts: weakNames.slice(0, 3)
  }
}

/**
 * A warm, NAME-BASED reason sentence in Viktor's voice. Names the chapter and the
 * one-to-few concepts that pulled it up. NEVER an internal Elo or band (spec
 * §2.2a: the band is invisible to the learner). Degrades gracefully when there are
 * no specific concept names (recommend the chapter on its own merits).
 */
function buildReason(title: string, weakNames: string[]): string {
  const names = weakNames.slice(0, 3)
  if (names.length === 0) {
    return `“${title}” is the next step in your training. Let's build on it.`
  }
  return `You're still shaky on ${joinNames(names)}: “${title}” drills exactly that, so let's tackle it next.`
}

/** Oxford-style join: "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
