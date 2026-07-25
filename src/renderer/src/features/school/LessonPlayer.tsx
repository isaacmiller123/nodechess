import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { ArrowLeft, ChevronRight, GraduationCap } from 'lucide-react'
import type { LessonSegment, SchoolLesson } from '@shared/types'
import { ViktorPanel } from './ViktorPanel'
import {
  BossSegment,
  GuidedSegment,
  ModelSegment,
  PuzzleSegment,
  TeachSegment,
  type BoardEnv
} from './segments'

export interface LessonPlayerProps {
  chapterId: string
  lesson: SchoolLesson
  env: BoardEnv
  /** Chapter title shown in the top bar. */
  chapterTitle: string
  /** Back to the chapter overview without recording completion. */
  onBack: () => void
  /** All segments finished: lesson recorded; return to the overview. */
  onComplete: () => void
  /** Deep link to Settings → Datasets (puzzle segments' install notice). */
  onOpenSettings?: () => void
}

/**
 * Walks one lesson's segments in order. Each segment calls its onDone when the
 * learner finishes it; we advance to the next. After the final segment we record
 * the lesson as complete and hand control back to the overview.
 *
 * All hooks run before any early return (React #300 guard).
 */
export function LessonPlayer({
  chapterId,
  lesson,
  env,
  chapterTitle,
  onBack,
  onComplete,
  onOpenSettings
}: LessonPlayerProps): JSX.Element {
  const segments = lesson.segments
  const [segIdx, setSegIdx] = useState(0)
  const [finished, setFinished] = useState(false)

  const total = Math.max(1, segments.length)
  const progress = useMemo(
    () => Math.min(1, Math.max(0, finished ? 1 : segIdx / total)),
    [segIdx, total, finished]
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

  // ---- Top bar (shared across all states) ----
  const topbar = (
    <header className="lesson-top">
      <button className="lesson-back" onClick={onBack}>
        <ArrowLeft size={16} /> Lessons
      </button>
      <div
        className="lesson-progress"
        role="progressbar"
        aria-valuenow={Math.round(progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${lesson.title} progress`}
      >
        <div
          className="lesson-progress-fill"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      <span className="lesson-top-label">{chapterTitle}</span>
    </header>
  )

  // ---- Lesson finished: a clean completion card ----
  if (finished) {
    return (
      <div className="lesson-player">
        {topbar}
        <div className="school-stage school-stage-single">
          <div className="lesson-complete-card">
            <span className="lesson-complete-icon" aria-hidden>
              <GraduationCap size={28} />
            </span>
            <h2 className="lesson-complete-title">Lesson complete</h2>
            <p className="lesson-complete-sub">
              {lesson.title} is done. Viktor has noted your progress.
            </p>
            <button className="btn school-primary lesson-complete-btn" onClick={onComplete}>
              Back to chapter <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ---- No segments (defensive): let the learner finish out. ----
  if (!seg) {
    return (
      <div className="lesson-player">
        {topbar}
        <div className="school-stage school-stage-single">
          <ViktorPanel text="This lesson has no content yet.">
            <button className="btn school-primary" onClick={finishLesson}>
              Mark complete <ChevronRight size={16} />
            </button>
          </ViktorPanel>
        </div>
      </div>
    )
  }

  // ---- Render the active segment by kind ----
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

  return (
    <div className="lesson-player">
      {topbar}
      <div className="lesson-segment-rail" aria-hidden>
        {segments.map((s, i) => (
          <span
            key={i}
            className={`lesson-seg-dot${i < segIdx ? ' is-done' : ''}${
              i === segIdx ? ' is-active' : ''
            }`}
            title={s.title}
          />
        ))}
      </div>
      {body}
    </div>
  )
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
  return <div className="school-stage" aria-hidden />
}

export default LessonPlayer
