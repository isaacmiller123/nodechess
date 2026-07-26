import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { LessonSegment, SchoolLesson } from '@shared/types'
import { CoachCard, Icon, LessonChromeProvider, pad, type BoardEnv } from './SchoolScene'
import {
  BossSegment,
  GuidedSegment,
  ModelSegment,
  PuzzleSegment,
  TeachSegment
} from './segments'

export interface LessonPlayerProps {
  chapterId: string
  lesson: SchoolLesson
  env: BoardEnv
  /** The chapter this lesson belongs to: its number, its name, its lessons. */
  chapterOrder: number
  chapterTitle: string
  lessons: SchoolLesson[]
  /** Lesson ids already finished, for the chapter list and the trace. */
  doneLessonIds: Set<string>
  /** True when the chapter carries a test, which the foot note reports. */
  hasTest: boolean
  /** Back to the chapter overview without recording completion. */
  onBack: () => void
  /** All segments finished: lesson recorded; return to the overview. */
  onComplete: () => void
  /** Deep link to Settings → Datasets (puzzle segments' install notice). */
  onOpenSettings?: () => void
}

/**
 * One lesson, as design-lab/v1/school.html draws it.
 *
 * This component owns the two things on that page that belong to the LESSON
 * rather than to the step you happen to be on: the head over the board (chapter
 * number, chapter name, "Lesson 3 of 5", the lesson's name and its question),
 * and the aside's foot (the chapter's lesson list and the way out). It hands
 * both to the segment through LessonChrome and then gets out of the way, so the
 * screen never changes shape between a teach step and a boss game.
 *
 * The readout's trace is the chapter's own proportion: how many of its lessons
 * are behind you. That is the ratio v1 draws under the strip.
 *
 * All hooks run before any early return (React #300 guard).
 */
export function LessonPlayer({
  chapterId,
  lesson,
  env,
  chapterOrder,
  chapterTitle,
  lessons,
  doneLessonIds,
  hasTest,
  onBack,
  onComplete,
  onOpenSettings
}: LessonPlayerProps): JSX.Element {
  const segments = lesson.segments
  const [segIdx, setSegIdx] = useState(0)
  const [finished, setFinished] = useState(false)

  const lessonIdx = useMemo(() => lessons.findIndex((l) => l.id === lesson.id), [lessons, lesson.id])
  const doneCount = useMemo(
    () => lessons.filter((l) => doneLessonIds.has(l.id)).length,
    [lessons, doneLessonIds]
  )
  // Sequential unlock, exactly as the chapter overview derives it: everything
  // after the first unfinished lesson is closed until the one before it is done.
  const firstIncomplete = useMemo(
    () => lessons.findIndex((l) => !doneLessonIds.has(l.id)),
    [lessons, doneLessonIds]
  )

  const finishLesson = useCallback(() => {
    setFinished(true)
    void window.api?.school?.recordLesson({ chapterId, lessonId: lesson.id })
  }, [chapterId, lesson.id])

  const onSegDone = useCallback(() => {
    // Side effects stay OUT of the setSegIdx updater. Updaters must be pure
    // (StrictMode double-invokes them in dev, which would duplicate the
    // recordLesson IPC write). Compute "last segment" from state instead.
    if (segIdx + 1 >= segments.length) {
      finishLesson()
    } else {
      setSegIdx(segIdx + 1)
    }
  }, [segIdx, segments.length, finishLesson])

  const seg: LessonSegment | undefined = segments[segIdx]

  // ---- The head over the board: where you are, and what this lesson asks. ----
  const head = (
    <div className="sch-head board-under">
      <div className="lbl">
        {`Ch ${pad(chapterOrder)} · ${chapterTitle}`}
        {lessonIdx >= 0 && ` · Lesson ${lessonIdx + 1} of ${lessons.length}`}
      </div>
      <h1 className="sch-title">{lesson.title}</h1>
      {lesson.summary && <p className="sec-note">{lesson.summary}</p>}
    </div>
  )

  // ---- The aside's foot: the chapter's lessons, and the way out. ----
  const leave = (
    <div className="lesson-foot">
      {hasTest && <p className="foot-note">The chapter test is open at any time.</p>}
      <button className="btn is-quiet" type="button" onClick={onBack}>
        Leave lesson
      </button>
    </div>
  )

  const side = (
    <>
      {lessons.length > 0 && (
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">This chapter</h2>
            <span className="sec-count">
              {doneCount} of {lessons.length} done
            </span>
          </div>
          <div className="panel lessons">
            {lessons.map((l, i) => {
              const done = doneLessonIds.has(l.id)
              const current = l.id === lesson.id
              const locked = !done && !current && firstIncomplete !== -1 && i > firstIncomplete
              return (
                <div
                  key={l.id}
                  className={`ls${current ? ' is-current' : ''}${locked ? ' is-locked' : ''}`}
                  aria-current={current ? 'true' : undefined}
                >
                  <span className="ls-no">{pad(i + 1)}</span>
                  <span>{l.title}</span>
                  {current ? (
                    <span className="lbl">Now</span>
                  ) : done ? (
                    <span className="ls-mark">
                      <Icon id="i-check" />
                      <span className="vh">Finished</span>
                    </span>
                  ) : locked ? (
                    <span className="lbl">Locked</span>
                  ) : (
                    <span />
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}
      {leave}
    </>
  )

  const chrome = {
    head,
    side,
    trace: lessons.length > 0 ? doneCount / lessons.length : null
  }

  // ---- Lesson finished. v1 has no completion screen, so this is the coach
  //      saying so, on the same column measure the board stood on. ----
  if (finished) {
    return (
      <CoachCard
        title="Lesson complete"
        said={[`${lesson.title} is done. I have noted your progress.`]}
        foot={
          <div className="lesson-foot">
            {hasTest && <p className="foot-note">The chapter test is open at any time.</p>}
            <button className="btn is-primary" type="button" onClick={onComplete}>
              Back to chapter
            </button>
          </div>
        }
      />
    )
  }

  // ---- No segments (defensive): let the learner finish out. ----
  if (!seg) {
    return (
      <CoachCard
        title={lesson.title}
        said={['This lesson has no content yet.']}
        foot={
          <div className="lesson-foot">
            <button className="btn is-quiet" type="button" onClick={onBack}>
              Leave lesson
            </button>
            <button className="btn is-primary" type="button" onClick={finishLesson}>
              Mark complete
            </button>
          </div>
        }
      />
    )
  }

  // ---- The active segment, inside the lesson's chrome ----
  // key={segIdx} fully remounts each segment so its internal step/puzzle state resets.
  let body: JSX.Element
  switch (seg.kind) {
    case 'teach':
      body = (
        <TeachSegment
          key={segIdx}
          steps={seg.steps ?? []}
          title={seg.title}
          env={env}
          onDone={onSegDone}
        />
      )
      break
    case 'guided':
      body = (
        <GuidedSegment
          key={segIdx}
          steps={seg.steps ?? []}
          title={seg.title}
          env={env}
          onDone={onSegDone}
        />
      )
      break
    case 'model':
      body = (
        <ModelSegment
          key={segIdx}
          startFen={modelStartFen(seg)}
          line={seg.line ?? []}
          title={seg.title}
          intro={seg.intro}
          env={env}
          onDone={onSegDone}
        />
      )
      break
    case 'puzzle':
      body = seg.puzzle ? (
        <PuzzleSegment
          key={segIdx}
          query={seg.puzzle}
          title={seg.title}
          intro={seg.intro}
          env={env}
          onDone={onSegDone}
          onOpenSettings={onOpenSettings}
        />
      ) : (
        <SkipImmediately key={segIdx} onDone={onSegDone} />
      )
      break
    case 'boss':
      body = (
        <BossSegment
          key={segIdx}
          chapterId={chapterId}
          boss={seg}
          title={seg.title}
          env={env}
          onDone={() => onSegDone()}
        />
      )
      break
    default:
      body = <SkipImmediately key={segIdx} onDone={onSegDone} />
  }

  return <LessonChromeProvider chrome={chrome}>{body}</LessonChromeProvider>
}

/** A model segment plays from its first move's implied start; if the line's first
 *  entry has no preceding board, we fall back to the standard initial position via
 *  a teach-style intro. We derive the start FEN from an explicit field when present;
 *  model segments in the curriculum carry their start in the first coach step's fen
 *  via the `bossFen` slot when needed, else the standard opening. */
function modelStartFen(seg: LessonSegment): string {
  // Authoring convention: a model segment may reuse the bossFen field to carry a
  // start position; otherwise it begins from the standard opening.
  return seg.bossFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
}

function SkipImmediately({ onDone }: { onDone: () => void }): JSX.Element {
  // Render nothing and advance once on mount. The ref guard makes this survive
  // StrictMode's dev double effect-fire (refs persist across the simulated
  // remount): firing onDone twice would skip a real segment.
  const firedRef = useRef(false)
  useEffect(() => {
    if (firedRef.current) return
    firedRef.current = true
    onDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div className="lesson" aria-hidden />
}

export default LessonPlayer
