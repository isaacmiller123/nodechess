import type { JSX } from 'react'
import { MAX_ATTEMPTS } from '@shared/types'
import type { SchoolChapter, SchoolLesson, SchoolLessonKind } from '@shared/types'
import { useReadoutSlot } from '../../components/Layout'
import { Icon, pad } from './SchoolScene'

export interface ChapterOverviewProps {
  chapter: SchoolChapter
  /** Lesson ids the learner has completed. */
  doneLessonIds: Set<string>
  /** Chapter-test state from window.api.school.testState. */
  test: { attempts: number; passed: boolean; bestPct: number }
  onBack: () => void
  onOpenLesson: (lesson: SchoolLesson) => void
  onOpenTest: () => void
}

const KIND_LABEL: Record<SchoolLessonKind, string> = {
  warmup: 'Warm-up',
  concept: 'Concept',
  opening: 'Opening',
  variation: 'Variation',
  tactics: 'Tactics',
  positional: 'Positional',
  endgame: 'Endgame',
  practice: 'Practice',
  cooldown: 'Cool-down'
}

/**
 * The chapter, before you are inside a lesson. v1 never drew this screen, so it
 * is built out of the same parts its lesson page is: the .sch-head that names
 * the thing, a list of rows on the left, and the chapter's own facts on the
 * right. A lesson is a .go row, because a row that takes you somewhere is what
 * .go is; its state is written in the same .lbl v1 uses for Now and Locked.
 *
 * The test is takeable at any point in the chapter (SCHOOL-SPEC §1 and §4), so
 * nothing here gates it and no copy claims it opens later.
 */
export function ChapterOverview({
  chapter,
  doneLessonIds,
  test,
  onBack,
  onOpenLesson,
  onOpenTest
}: ChapterOverviewProps): JSX.Element {
  const lessons = chapter.lessons ?? []
  const doneCount = lessons.filter((l) => doneLessonIds.has(l.id)).length
  const allDone = lessons.length > 0 && doneCount === lessons.length
  // Sequential unlock: the completed lessons plus the FIRST not-yet-done lesson are
  // open; everything after that is locked until you finish the one before it.
  const firstIncomplete = lessons.findIndex((l) => !doneLessonIds.has(l.id))
  const nextLesson = firstIncomplete >= 0 ? lessons[firstIncomplete] : undefined

  const concepts = chapter.concepts ?? []
  const shownConcepts = concepts.slice(0, 8)
  const extraConcepts = concepts.length - shownConcepts.length
  const threshold = Math.round((chapter.test?.passThreshold ?? 0.7) * 100)

  useReadoutSlot(
    nextLesson
      ? `${doneCount > 0 ? 'Continue' : 'Start'} with ${nextLesson.title}`
      : chapter.test && !test.passed
        ? 'Take the chapter test'
        : null,
    lessons.length > 0 ? doneCount / lessons.length : null
  )

  return (
    <div className="home">
      <div>
        <div className="sch-head">
          <div className="lbl">
            {`Ch ${pad(chapter.order)} · ${lessons.length} lesson${lessons.length === 1 ? '' : 's'} · ~${chapter.estMinutes} min`}
          </div>
          <h1 className="sch-title">{chapter.title}</h1>
          {chapter.subtitle && <p className="sec-note">{chapter.subtitle}</p>}
        </div>

        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Lessons</h2>
            <span className="sec-count">
              {doneCount} of {lessons.length} done
            </span>
          </div>
          <div className="panel golist">
            {lessons.map((lesson, i) => {
              const done = doneLessonIds.has(lesson.id)
              const isNext = i === firstIncomplete
              const locked = firstIncomplete !== -1 && i > firstIncomplete
              const kind = KIND_LABEL[lesson.kind] ?? lesson.kind
              const sub = locked
                ? 'Finish the lesson before it to open this one.'
                : lesson.summary
                  ? `${kind} · ${lesson.summary}`
                  : kind

              if (locked) {
                return (
                  <div className="go" key={lesson.id} aria-disabled>
                    <span>
                      <span className="go-name">
                        {pad(i + 1)} {lesson.title}
                      </span>
                      <span className="go-sub">{sub}</span>
                    </span>
                    <span className="lbl">Locked</span>
                  </div>
                )
              }

              return (
                <button
                  className={`go${isNext ? ' row is-here' : ''}`}
                  type="button"
                  key={lesson.id}
                  onClick={() => onOpenLesson(lesson)}
                >
                  <span>
                    <span className="go-name">
                      {pad(i + 1)} {lesson.title}
                    </span>
                    <span className="go-sub">{sub}</span>
                  </span>
                  {done ? (
                    <span className="lbl">Done</span>
                  ) : (
                    <Icon id="i-arrow" className="icon go-arrow" />
                  )}
                </button>
              )
            })}
          </div>
        </section>
      </div>

      <aside className="side">
        {chapter.test && (
          <section className="sec">
            <div className="sec-head">
              <h2 className="lbl">Chapter test</h2>
              {test.bestPct > 0 && (
                <span className="sec-count">Best {Math.round(test.bestPct * 100)}%</span>
              )}
            </div>
            <p className="sec-note">
              {test.passed
                ? 'Passed. Viktor is satisfied. Retake it any time to keep the ideas sharp.'
                : test.attempts > 0
                  ? `${test.attempts} of ${MAX_ATTEMPTS} attempts used. Fail both and you retake the whole chapter.`
                  : allDone
                    ? 'Every lesson is done. Prove the chapter to Viktor.'
                    : 'Takeable at any time, but the lessons are the preparation.'}
            </p>
            <div className="panel">
              <div className="facts">
                <div className="fact">
                  <span>Questions</span>
                  <span className="fact-value num">{chapter.test.questions.length}</span>
                </div>
                <div className="fact">
                  <span>To pass</span>
                  <span className="fact-value num">{threshold}%</span>
                </div>
                <div className="fact">
                  <span>Attempts</span>
                  <span className="fact-value num">
                    {test.attempts} of {MAX_ATTEMPTS}
                  </span>
                </div>
              </div>
              <div className="panel-foot">
                <button className="btn is-primary" type="button" onClick={onOpenTest}>
                  {test.passed ? 'Retake test' : 'Take the test'}
                </button>
              </div>
            </div>
          </section>
        )}

        {shownConcepts.length > 0 && (
          <section className="sec">
            <div className="sec-head">
              <h2 className="lbl">Concepts</h2>
              <span className="sec-count">{concepts.length}</span>
            </div>
            <div className="chips">
              {shownConcepts.map((c) => (
                <span key={c.id} className="chip" title={c.short}>
                  {c.name}
                </span>
              ))}
              {extraConcepts > 0 && <span className="chip">+{extraConcepts} more</span>}
            </div>
          </section>
        )}

        <div className="lesson-foot">
          <button className="btn is-quiet" type="button" onClick={onBack}>
            All chapters
          </button>
        </div>
      </aside>
    </div>
  )
}

export default ChapterOverview
