import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { SchoolChapter, SchoolLesson, SchoolSegment } from '@shared/types'
import { pieceSetClass } from '../../board/pieceSets'
import { useSettings } from '../../state/settings'
import { ViktorPanel } from './ViktorPanel'
import { ChapterOverview } from './ChapterOverview'
import { LessonPlayer } from './LessonPlayer'
import { ChapterTestView } from './ChapterTest'
import {
  BossSegment,
  GuidedSegment,
  TeachSegment,
  type BoardEnv,
  type BossConfig
} from './segments'

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
 *     player (walks that lesson's segments) → the chapter test. All sharing the
 *     chess.com look and the top progress bar.
 *   • legacy model (single chapter.segments, e.g. the Knight Forks demo): walk the
 *     segments in order, exactly as before.
 *
 * Every hook runs before any early return (React #300 guard).
 */
export function ChapterPlayer({ chapterId, onExit, onOpenSettings }: ChapterPlayerProps): JSX.Element {
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

  // Leaving the test by ANY route (result screen or the topbar back button) must
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
      <div className="lesson-player" aria-busy="true">
        <header className="lesson-top">
          <button className="lesson-back" onClick={onExit}>
            <ArrowLeft size={16} /> Chapters
          </button>
          <div className="lesson-progress" aria-hidden>
            <div className="lesson-progress-fill" style={{ width: '8%' }} />
          </div>
          <span className="lesson-top-label">Loading…</span>
        </header>
        {/* Skeleton of the chapter overview (hero + lesson rows) while the JSON loads. */}
        <div className="chapter-skeleton" aria-hidden>
          <div className="school-skel skel-hero" />
          <div className="school-skel skel-row" />
          <div className="school-skel skel-row" />
          <div className="school-skel skel-row" />
          <div className="school-skel skel-row" />
        </div>
      </div>
    )
  }

  if (loadState === 'missing' || !chapter) {
    return (
      <div className="lesson-player">
        <header className="lesson-top">
          <button className="lesson-back" onClick={onExit}>
            <ArrowLeft size={16} /> Chapters
          </button>
          <div className="lesson-progress" aria-hidden />
          <span className="lesson-top-label">Unavailable</span>
        </header>
        <div className="panel pad school-missing">
          <p className="muted">
            This chapter could not be loaded. Connect to the desktop app, or pick another chapter.
          </p>
          <button className="btn" onClick={onExit}>
            <ArrowLeft size={16} /> Back to chapters
          </button>
        </div>
      </div>
    )
  }

  // ===========================================================================
  // NEW MODEL, chapter.lessons present.
  // ===========================================================================
  if (chapter.lessons && chapter.lessons.length > 0) {
    const openLesson: SchoolLesson | undefined = openLessonId
      ? chapter.lessons.find((l) => l.id === openLessonId)
      : undefined

    if (testOpen && chapter.test) {
      return (
        <ChapterTestView
          chapterId={chapterId}
          chapterTitle={chapter.title}
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
          chapterTitle={chapter.title}
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
  return (
    <LegacySegmentsFlow chapter={chapter} chapterId={chapterId} env={env} onExit={onExit} />
  )
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
  const progress = Math.min(1, Math.max(0, segIdx / total))

  const advance = useCallback(
    (doneCount: number) => {
      void window.api?.school?.recordSegment({ chapterId, segmentsDone: doneCount })
      setSegIdx((i) => i + 1)
    },
    [chapterId]
  )

  const topbar = (
    <header className="lesson-top">
      <button className="lesson-back" onClick={onExit}>
        <ArrowLeft size={16} /> Chapters
      </button>
      <div
        className="lesson-progress"
        role="progressbar"
        aria-valuenow={Math.round(progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${chapter.title} progress`}
      >
        <div className="lesson-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <span className="lesson-top-label">{chapter.title}</span>
    </header>
  )

  if (!segment) {
    return (
      <div className="lesson-player">
        {topbar}
        <div className="school-stage school-stage-single">
          <ViktorPanel text="That is the whole chapter. Well done.">
            <button className="btn school-primary" onClick={onExit}>
              <ArrowLeft size={16} /> Back to chapters
            </button>
          </ViktorPanel>
        </div>
      </div>
    )
  }

  const boss: BossConfig = {
    bossFen: segment.bossFen,
    bossEngineElo: segment.bossEngineElo,
    bossUserColor: segment.bossUserColor,
    bossIntro: segment.bossIntro
  }

  return (
    <div className="lesson-player">
      {topbar}
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
    </div>
  )
}

export default ChapterPlayer
