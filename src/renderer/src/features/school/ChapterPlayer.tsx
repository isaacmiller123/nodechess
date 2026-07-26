import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { SchoolChapter, SchoolLesson, SchoolSegment } from '@shared/types'
import { pieceSetClass } from '../../board/pieceSets'
import { useSettings } from '../../state/settings'
import { CoachCard, LessonChromeProvider, type BoardEnv } from './SchoolScene'
import { ChapterOverview } from './ChapterOverview'
import { LessonPlayer } from './LessonPlayer'
import { ChapterTestView } from './ChapterTest'
import { BossSegment, GuidedSegment, TeachSegment, type BossConfig } from './segments'

export interface ChapterPlayerProps {
  chapterId: string
  onExit: () => void
  /** Deep link to Settings → Datasets (threaded to puzzle segments' notice). */
  onOpenSettings?: () => void
}

type TestState = { attempts: number; passed: boolean; bestPct: number }

/**
 * Chapter player. Loads a chapter and routes by model:
 *   • new model (chapter.lessons present): a view machine. Overview → a lesson
 *     player (walks that lesson's segments) → the chapter test.
 *   • legacy model (single chapter.segments, e.g. the Knight Forks demo): walk the
 *     segments in order, exactly as before.
 *
 * It is also the data hub: the chapter, the completed-lesson set and the test
 * state all live here, and the lesson player needs all three to draw v1's head
 * and its "This chapter" list.
 *
 * Every hook runs before any early return (React #300 guard).
 */
export function ChapterPlayer({
  chapterId,
  onExit,
  onOpenSettings
}: ChapterPlayerProps): JSX.Element {
  const { settings } = useSettings()
  const boardClass = `board-wrap board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`
  const env: BoardEnv = useMemo(
    () => ({
      boardClass,
      coordinates: settings.coordinates,
      animation: settings.animation,
      showDests: settings.showLegal
    }),
    [boardClass, settings.coordinates, settings.animation, settings.showLegal]
  )

  const [chapter, setChapter] = useState<SchoolChapter | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing'>('loading')

  // New-model navigation: which lesson is open, or the test, else the overview.
  const [openLessonId, setOpenLessonId] = useState<string | null>(null)
  const [testOpen, setTestOpen] = useState(false)

  // Completed lesson ids + chapter-test state (kept fresh as the learner works).
  const [doneLessonIds, setDoneLessonIds] = useState<Set<string>>(() => new Set())
  const [testState, setTestState] = useState<TestState>({
    attempts: 0,
    passed: false,
    bestPct: 0
  })

  // ---- Load chapter + test state ----
  useEffect(() => {
    const api = window.api?.school
    if (!api) {
      setLoadState('missing')
      return
    }
    let cancelled = false
    setLoadState('loading')
    api
      .chapter(chapterId)
      .then((r) => {
        if (cancelled) return
        if (r?.chapter) {
          setChapter(r.chapter)
          setLoadState('ready')
        } else {
          setLoadState('missing')
        }
      })
      .catch(() => {
        if (!cancelled) setLoadState('missing')
      })
    // Seed completed-lesson state from persisted progress so done-badges survive a
    // remount/restart (lesson_progress is now read back by school:mastery). Seed
    // unconditionally: a forced retake wipes lesson_progress server-side, so the
    // set must be able to come back EMPTY, not only grow.
    void api
      .mastery()
      .then((m) => {
        if (cancelled || !m?.lessons) return
        const mine = m.lessons.filter((l) => l.chapterId === chapterId).map((l) => l.lessonId)
        setDoneLessonIds(new Set(mine))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [chapterId])

  // Refresh test state from the bridge (call after a test attempt).
  const refreshTestState = useCallback(() => {
    void window.api?.school
      ?.testState({ chapterId })
      .then((s) => s && setTestState(s))
      .catch(() => {})
  }, [chapterId])

  // Re-pull persisted lesson completion. Unconditional re-seed: a second failed
  // test attempt resets the chapter server-side (lesson_progress wiped), so the
  // done-set must be able to SHRINK back to empty.
  const refreshDoneLessons = useCallback(() => {
    void window.api?.school
      ?.mastery()
      .then((m) => {
        if (!m?.lessons) return
        const mine = m.lessons.filter((l) => l.chapterId === chapterId).map((l) => l.lessonId)
        setDoneLessonIds(new Set(mine))
      })
      .catch(() => {})
  }, [chapterId])

  // Leaving the test by ANY route (result screen or the foot's back button) must
  // reconcile attempts/pass state AND lesson completion, or the overview shows
  // stale attempt counts and phantom checkmarks after a forced retake.
  const exitTest = useCallback(() => {
    refreshTestState()
    refreshDoneLessons()
    setTestOpen(false)
  }, [refreshTestState, refreshDoneLessons])

  useEffect(() => {
    refreshTestState()
  }, [refreshTestState])

  const markLessonDone = useCallback((lessonId: string) => {
    setDoneLessonIds((prev) => {
      if (prev.has(lessonId)) return prev
      const next = new Set(prev)
      next.add(lessonId)
      return next
    })
  }, [])

  // ---- Loading / missing states ----
  if (loadState === 'loading') {
    return (
      <div className="col-single" aria-busy="true">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Chapter</h2>
          </div>
          <div className="well">
            <div className="empty">
              <p className="empty-line">Loading the chapter.</p>
              <p className="empty-line">Viktor is fetching the lessons and your progress.</p>
            </div>
          </div>
        </section>
      </div>
    )
  }

  if (loadState === 'missing' || !chapter) {
    return (
      <CoachCard
        title="Chapter"
        said={[
          'This chapter could not be loaded. Connect to the desktop app, or pick another chapter.'
        ]}
        foot={
          <div className="lesson-foot">
            <button className="btn is-primary" type="button" onClick={onExit}>
              Back to chapters
            </button>
          </div>
        }
      />
    )
  }

  // ===========================================================================
  // NEW MODEL, chapter.lessons present.
  // ===========================================================================
  if (chapter.lessons && chapter.lessons.length > 0) {
    const lessons = chapter.lessons
    const openLesson: SchoolLesson | undefined = openLessonId
      ? lessons.find((l) => l.id === openLessonId)
      : undefined

    if (testOpen && chapter.test) {
      return (
        <ChapterTestView
          chapterId={chapterId}
          chapterTitle={chapter.title}
          chapterOrder={chapter.order}
          test={chapter.test}
          env={env}
          priorAttempts={testState.attempts}
          alreadyPassed={testState.passed}
          onBack={exitTest}
          onFinished={exitTest}
        />
      )
    }

    if (openLesson) {
      return (
        <LessonPlayer
          chapterId={chapterId}
          lesson={openLesson}
          env={env}
          chapterOrder={chapter.order}
          chapterTitle={chapter.title}
          lessons={lessons}
          doneLessonIds={doneLessonIds}
          hasTest={Boolean(chapter.test)}
          onBack={() => setOpenLessonId(null)}
          onComplete={() => {
            markLessonDone(openLesson.id)
            setOpenLessonId(null)
          }}
          onOpenSettings={onOpenSettings}
        />
      )
    }

    return (
      <ChapterOverview
        chapter={chapter}
        doneLessonIds={doneLessonIds}
        test={testState}
        onBack={onExit}
        onOpenLesson={(l) => setOpenLessonId(l.id)}
        onOpenTest={() => setTestOpen(true)}
      />
    )
  }

  // ===========================================================================
  // LEGACY MODEL: single chapter.segments (Knight Forks demo).
  // ===========================================================================
  return <LegacySegmentsFlow chapter={chapter} chapterId={chapterId} env={env} onExit={onExit} />
}

// ===========================================================================
// Legacy single-`segments` flow. Walks teach/guided/boss in order, recording
// segment progress and chapter completion exactly as the original player did.
// ===========================================================================

function LegacySegmentsFlow({
  chapter,
  chapterId,
  env,
  onExit
}: {
  chapter: SchoolChapter
  chapterId: string
  env: BoardEnv
  onExit: () => void
}): JSX.Element {
  const segments = chapter.segments ?? []
  const [segIdx, setSegIdx] = useState(0)

  const segment: SchoolSegment | undefined = segments[segIdx]
  const total = Math.max(1, segments.length)

  const advance = useCallback(
    (doneCount: number) => {
      void window.api?.school?.recordSegment({ chapterId, segmentsDone: doneCount })
      setSegIdx((i) => i + 1)
    },
    [chapterId]
  )

  const chrome = {
    head: (
      <div className="sch-head board-under">
        <div className="lbl">{chapter.title}</div>
        <h1 className="sch-title">{segment?.title ?? chapter.title}</h1>
        {chapter.subtitle && <p className="sec-note">{chapter.subtitle}</p>}
      </div>
    ),
    side: (
      <div className="lesson-foot">
        <button className="btn is-quiet" type="button" onClick={onExit}>
          Leave chapter
        </button>
      </div>
    ),
    trace: Math.min(1, segIdx / total)
  }

  if (!segment) {
    return (
      <CoachCard
        title={chapter.title}
        said={['That is the whole chapter. Well done.']}
        foot={
          <div className="lesson-foot">
            <button className="btn is-primary" type="button" onClick={onExit}>
              Back to chapters
            </button>
          </div>
        }
      />
    )
  }

  const boss: BossConfig = {
    bossFen: segment.bossFen,
    bossEngineElo: segment.bossEngineElo,
    bossUserColor: segment.bossUserColor,
    bossIntro: segment.bossIntro
  }

  return (
    <LessonChromeProvider chrome={chrome}>
      {segment.kind === 'teach' && (
        <TeachSegment
          key={`teach-${segIdx}`}
          steps={segment.steps}
          title={segment.title}
          env={env}
          onDone={() => advance(segIdx + 1)}
        />
      )}
      {segment.kind === 'guided' && (
        <GuidedSegment
          key={`guided-${segIdx}`}
          steps={segment.steps}
          title={segment.title}
          env={env}
          onDone={() => advance(segIdx + 1)}
        />
      )}
      {segment.kind === 'boss' && (
        <BossSegment
          key={`boss-${segIdx}`}
          chapterId={chapterId}
          boss={boss}
          title={segment.title}
          env={env}
          onDone={(won) => {
            void window.api?.school?.completeChapter({ chapterId, bossWon: won })
            onExit()
          }}
        />
      )}
    </LessonChromeProvider>
  )
}

export default ChapterPlayer
