import type { JSX } from 'react'
import type { SchoolChapterMeta } from '../../../../shared/types'
import type { SchoolProgress } from './format'
import type { ProgressNavTarget } from './ProgressView'

export interface SchoolSectionProps {
  chapters: SchoolChapterMeta[]
  school: SchoolProgress
  onNavigate?: (view: ProgressNavTarget) => void
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** What is left to do in the chapter that is open. */
function chapterSub(chapter: SchoolChapterMeta, done: number): string {
  if (chapter.locked) {
    return chapter.lockReason === 'placement' ? 'Placement opens this' : 'Locked for now'
  }
  const lessons = chapter.lessonCount ?? 0
  if (lessons <= 0) return chapter.subtitle
  if (done > 0 && done < lessons) return `Lesson ${done + 1} of ${lessons}`
  // Every lesson done and the chapter still open: what is left is the test.
  if (done >= lessons) return `${done} of ${lessons} lessons`
  // Every chapter closes on one test, which SCHOOL-SPEC makes mandatory, so
  // naming it is the design's own line and not a guess about this chapter.
  return `${lessons} lessons, one test`
}

/**
 * The curriculum as forty pips and the one row that goes back into it. Titles
 * are the curriculum's own; the design's chapter names were written for the
 * mock and no chapter of that name exists.
 */
export default function SchoolSection({
  chapters,
  school,
  onNavigate
}: SchoolSectionProps): JSX.Element {
  const ordered = [...chapters].sort((a, b) => a.order - b.order)
  const current = school.current

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">School</h2>
        {school.total > 0 && (
          <span className="sec-count">
            {school.completed} of {school.total} chapters
          </span>
        )}
      </div>
      <div className="well">
        {ordered.length > 0 ? (
          <>
            <div className="prg-chs" aria-hidden>
              {ordered.map((c) => {
                const done = school.doneIds.has(c.id)
                const now = !done && current?.id === c.id
                return (
                  <span
                    key={c.id}
                    className={`prg-ch${done ? ' is-done' : ''}${now ? ' is-now' : ''}`}
                  />
                )
              })}
            </div>
            <div className="panel golist">
              <button className="go" type="button" onClick={() => onNavigate?.('school')}>
                <span>
                  <span className="go-name">
                    {current
                      ? `Chapter ${pad2(current.order)}, ${current.title}`
                      : `All ${school.total} chapters done`}
                  </span>
                  <span className="go-sub">
                    {current ? chapterSub(current, school.currentDone) : 'Open any chapter again'}
                  </span>
                </span>
                <svg className="icon go-arrow" aria-hidden>
                  <use href="#i-arrow" />
                </svg>
              </button>
            </div>
          </>
        ) : (
          <div className="empty">
            <p className="empty-line">No chapters loaded.</p>
            <p className="empty-line">School opens on chapter 01.</p>
          </div>
        )}
      </div>
    </section>
  )
}
