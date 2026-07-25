import type { JSX, ReactNode } from 'react'
import {
  ArrowLeft,
  BookOpen,
  Castle,
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Crosshair,
  Flame,
  GraduationCap,
  Layers,
  Lock,
  RotateCcw,
  Snowflake,
  Swords,
  Target,
  Trophy
} from 'lucide-react'
import { MAX_ATTEMPTS } from '@shared/types'
import type { SchoolChapter, SchoolLesson, SchoolLessonKind } from '@shared/types'

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

/**
 * Shared circular progress indicator (also used by the School index hero card;
 * this file is the import leaf, so SchoolView can pull it without a cycle).
 * Pure SVG on design tokens; label defaults to the rounded percentage.
 */
export function ProgressRing({
  pct,
  size = 72,
  stroke = 6,
  label
}: {
  pct: number
  size?: number
  stroke?: number
  label?: ReactNode
}): JSX.Element {
  const clamped = Math.min(1, Math.max(0, pct))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <span
      className="school-ring"
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          className="school-ring-track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
        />
        <circle
          className="school-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - clamped)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="school-ring-label">{label ?? `${Math.round(clamped * 100)}%`}</span>
    </span>
  )
}

/**
 * Chapter overview. A rich hero (progress ring + concept chips) above the
 * lesson TIMELINE: each lesson is a node on a connected vertical path (done →
 * check, next → highlighted, later → locked until the one before is finished),
 * capped by the Chapter Test as a distinct capstone card. The test stays
 * takeable at any time (per spec it only LOOKS gated until the lessons are done).
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
  const pct = lessons.length > 0 ? doneCount / lessons.length : 0
  // Sequential unlock: the completed lessons plus the FIRST not-yet-done lesson are
  // open; everything after that is locked until you finish the one before it.
  const firstIncomplete = lessons.findIndex((l) => !doneLessonIds.has(l.id))

  const concepts = chapter.concepts ?? []
  const shownConcepts = concepts.slice(0, 8)
  const extraConcepts = concepts.length - shownConcepts.length
  const threshold = Math.round((chapter.test?.passThreshold ?? 0.7) * 100)

  return (
    <div className="chapter-overview">
      <header className="lesson-top">
        <button className="lesson-back" onClick={onBack}>
          <ArrowLeft size={16} /> Chapters
        </button>
        <div className="lesson-progress" aria-hidden>
          <div className="lesson-progress-fill" style={{ width: `${Math.round(pct * 100)}%` }} />
        </div>
        <span className="lesson-top-label">
          {doneCount} / {lessons.length} lessons
        </span>
      </header>

      {/* ---------------- Hero: identity + facts + concepts + progress ring ---------------- */}
      <div className="chapter-hero">
        <div className="chapter-hero-main">
          <span className="chapter-hero-eyebrow">Chapter {chapter.order}</span>
          <h1 className="chapter-hero-title">{chapter.title}</h1>
          <p className="chapter-hero-sub">{chapter.subtitle}</p>
          <div className="chapter-hero-facts">
            <span className="chapter-hero-fact">
              <BookOpen size={15} /> {lessons.length} lesson{lessons.length === 1 ? '' : 's'}
            </span>
            <span className="chapter-hero-fact">
              <Clock size={15} /> ~{chapter.estMinutes} min
            </span>
            {test.passed && (
              <span className="chapter-hero-fact is-passed">
                <ClipboardCheck size={15} /> Test passed
              </span>
            )}
          </div>
          {shownConcepts.length > 0 && (
            <div className="chapter-hero-concepts" aria-label="Concepts taught in this chapter">
              {shownConcepts.map((c) => (
                <span key={c.id} className="concept-chip" title={c.short}>
                  <GraduationCap size={12} aria-hidden /> {c.name}
                </span>
              ))}
              {extraConcepts > 0 && <span className="concept-chip is-more">+{extraConcepts} more</span>}
            </div>
          )}
        </div>
        <div className="chapter-hero-ring">
          <ProgressRing pct={pct} size={96} stroke={8} />
          <span className="chapter-hero-ring-caption num">
            {doneCount} / {lessons.length} lessons
          </span>
        </div>
      </div>

      {/* ---------------- Lesson timeline ---------------- */}
      <ol className="lesson-list">
        {lessons.map((lesson, i) => {
          const done = doneLessonIds.has(lesson.id)
          const isNext = i === firstIncomplete
          const locked = firstIncomplete !== -1 && i > firstIncomplete
          const nodeClass = `lesson-node${done ? ' is-done' : ''}${isNext ? ' is-next' : ''}${
            locked ? ' is-locked' : ''
          }`

          // ----- Locked: finish the previous lesson first. Not interactive. -----
          if (locked) {
            return (
              <li key={lesson.id} className={nodeClass}>
                <span className="lesson-node-marker" aria-hidden>
                  <Lock size={13} />
                </span>
                <div className="lesson-row is-locked" aria-disabled>
                  <span className="lesson-row-body">
                    <span className="lesson-row-titleline">
                      <span className="lesson-row-title">{lesson.title}</span>
                      <KindChip kind={lesson.kind} />
                    </span>
                    <span className="lesson-row-summary">Finish the previous lesson to unlock.</span>
                  </span>
                  <span className="lesson-row-cta is-muted">
                    <Lock size={14} />
                  </span>
                </div>
              </li>
            )
          }

          return (
            <li key={lesson.id} className={nodeClass}>
              <span className="lesson-node-marker" aria-hidden>
                {done ? <Check size={15} /> : i + 1}
              </span>
              <button
                type="button"
                className={`lesson-row${done ? ' is-done' : ''}${isNext ? ' is-next' : ''}`}
                onClick={() => onOpenLesson(lesson)}
              >
                <span className="lesson-row-body">
                  <span className="lesson-row-titleline">
                    {isNext && <span className="lesson-next-chip">Up next</span>}
                    <span className="lesson-row-title">{lesson.title}</span>
                    <KindChip kind={lesson.kind} />
                  </span>
                  {lesson.summary && <span className="lesson-row-summary">{lesson.summary}</span>}
                </span>
                <span className="lesson-row-cta">
                  {done ? 'Review' : 'Start'} <ChevronRight size={16} />
                </span>
              </button>
            </li>
          )
        })}

        {/* Capstone: the chapter test. Always takeable; styled gated until lessons done. */}
        {chapter.test && (
          <li className={`lesson-node is-capstone${test.passed ? ' is-passed' : ''}`}>
            <span className="lesson-node-marker" aria-hidden>
              {test.passed ? <Check size={15} /> : <Trophy size={14} />}
            </span>
            <div className="capstone-wrap">
              <button
                type="button"
                className={`capstone-card${test.passed ? ' is-passed' : allDone ? ' is-ready' : ''}`}
                onClick={onOpenTest}
              >
                <span className="capstone-head">
                  <span className="capstone-titles">
                    <span className="capstone-eyebrow">Capstone</span>
                    <span className="capstone-title">Chapter Test</span>
                  </span>
                  {test.bestPct > 0 && (
                    <span className={`capstone-best num${test.passed ? ' is-passed' : ''}`}>
                      Best {Math.round(test.bestPct * 100)}%
                    </span>
                  )}
                </span>
                <span className="capstone-sub">
                  {test.passed
                    ? 'Passed. Viktor is satisfied. Retake it any time to keep the ideas sharp.'
                    : test.attempts > 0
                      ? `${test.attempts} of ${MAX_ATTEMPTS} attempts used. Fail both and you retake the whole chapter.`
                      : allDone
                        ? 'Every lesson is done. Prove the chapter to Viktor.'
                        : 'Takeable at any time, but the lessons are the preparation.'}
                </span>
                <span className="capstone-facts">
                  <span className="capstone-fact">
                    <Target size={13} /> {chapter.test.questions.length} questions
                  </span>
                  <span className="capstone-fact">
                    <ClipboardCheck size={13} /> {threshold}% to pass
                  </span>
                  <span className="capstone-fact">
                    <Layers size={13} /> {MAX_ATTEMPTS} attempts
                  </span>
                </span>
                <span className="capstone-cta">
                  {test.passed ? (
                    <>
                      <RotateCcw size={15} /> Retake test
                    </>
                  ) : (
                    <>
                      <Swords size={15} /> Take the test
                    </>
                  )}
                </span>
              </button>
              {!allDone && !test.passed && (
                <p className="test-hint muted small">
                  Finish the lessons first for the best shot, but you may sit the test whenever
                  you like.
                </p>
              )}
            </div>
          </li>
        )}
      </ol>
    </div>
  )
}

const KIND_META: Record<SchoolLessonKind, { label: string; icon: JSX.Element }> = {
  warmup: { label: 'Warm-up', icon: <Flame size={12} /> },
  concept: { label: 'Concept', icon: <GraduationCap size={12} /> },
  opening: { label: 'Opening', icon: <BookOpen size={12} /> },
  variation: { label: 'Variation', icon: <Layers size={12} /> },
  tactics: { label: 'Tactics', icon: <Crosshair size={12} /> },
  positional: { label: 'Positional', icon: <Target size={12} /> },
  endgame: { label: 'Endgame', icon: <Castle size={12} /> },
  practice: { label: 'Practice', icon: <Swords size={12} /> },
  cooldown: { label: 'Cool-down', icon: <Snowflake size={12} /> }
}

function KindChip({ kind }: { kind: SchoolLessonKind }): JSX.Element {
  const meta = KIND_META[kind] ?? { label: kind, icon: <BookOpen size={12} /> }
  return (
    <span className={`kind-chip kind-${kind}`}>
      {meta.icon} {meta.label}
    </span>
  )
}

export default ChapterOverview
