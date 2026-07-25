import { useCallback, useEffect, useState, type JSX } from 'react'
import {
  CalendarCheck,
  Flame,
  GraduationCap,
  ChevronRight,
  RotateCcw,
  Layers,
  X,
  CheckCircle2,
  BookOpen
} from 'lucide-react'
import type { SchoolDaily, DailyStreak, DueConcept } from '@shared/types'
import './school-home.css'

// ============================================================================
// FEATURE 4 surface: the single "Today" card on the School home.
//
// ONE Today surface: today's recommended lesson + the LOCAL-day study streak, with
// the SRS review queue folded in (no separate Reviews screen). Reads:
//   window.api.school.daily()   -> SchoolDaily (lesson + doneToday + reviewsDue)
//   window.api.school.streak()  -> { streak: DailyStreak }  (calendar + flame)
//
// Surfaces, in order of "what should I do now":
//   • not done, lesson queued  -> a big green "Start today's lesson" CTA
//   • reviews due (any state)  -> a tappable row that opens the INLINE review drill
//   • drill open               -> flashcard per DueConcept; grade each via
//                                 window.api.school.reviewConcept({conceptId,correct}).
//                                 A review counts the day server-side, so on exit we
//                                 re-pull daily()+streak() and the card flips to rest.
//   • done today               -> "studied: come back tomorrow" rest state
// A calendar strip of the last days (from streak.recent) sits at the foot always.
//
// Renders nothing only when the desktop bridge is absent (web/dev). Otherwise it
// always shows a valid Today surface (even an empty curriculum is valid).
// ============================================================================

export interface TodayCardProps {
  /** Open the chapter that owns today's lesson (also used to deep-link reviews). */
  onOpenChapter?: (chapterId: string) => void
}

const WEEKDAY = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

/** 'YYYY-MM-DD' -> a 2-letter local weekday label for the calendar strip. */
function weekdayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10))
  if (!y || !m || !d) return ''
  return WEEKDAY[new Date(y, m - 1, d).getDay()] ?? ''
}

export function TodayCard({ onOpenChapter }: TodayCardProps): JSX.Element | null {
  const [daily, setDaily] = useState<SchoolDaily | null>(null)
  const [streak, setStreak] = useState<DailyStreak | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Inline review-drill state.
  const [drillOpen, setDrillOpen] = useState(false)
  const [drillLoading, setDrillLoading] = useState(false)
  const [queue, setQueue] = useState<DueConcept[]>([])
  const [idx, setIdx] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [grading, setGrading] = useState(false)
  const [results, setResults] = useState<{ got: number; total: number }>({ got: 0, total: 0 })

  // Re-pull daily + streak (after a review counts the day, the card must flip).
  const refresh = useCallback(async (): Promise<void> => {
    const api = window.api?.school
    if (!api?.daily) return
    const [d, s] = await Promise.all([
      api.daily().catch(() => null),
      api.streak?.().then((r) => r.streak).catch(() => null) ?? Promise.resolve(null)
    ])
    if (d) setDaily(d)
    if (s) setStreak(s)
  }, [])

  useEffect(() => {
    const api = window.api?.school
    if (!api?.daily) {
      setLoaded(true)
      return
    }
    let cancelled = false
    Promise.all([
      api.daily().catch(() => null),
      api.streak?.().then((r) => r.streak).catch(() => null) ?? Promise.resolve(null)
    ]).then(([d, s]) => {
      if (cancelled) return
      setDaily(d)
      setStreak(s)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Open the inline drill: pull the due queue, reset progress. The loading flag
  // keeps the terminal "All caught up" card from flashing while the IPC resolves
  // (queue is still [] until then).
  const openDrill = useCallback(async (): Promise<void> => {
    const api = window.api?.school
    if (!api?.dueReviews) return
    setDrillOpen(true)
    setDrillLoading(true)
    setIdx(0)
    setRevealed(false)
    setResults({ got: 0, total: 0 })
    const r = await api.dueReviews({ limit: 30 }).catch(() => ({ due: [] as DueConcept[] }))
    setQueue(r.due)
    setDrillLoading(false)
  }, [])

  // Close the drill and reconcile the card (a review counts the day server-side).
  const closeDrill = useCallback(async (): Promise<void> => {
    setDrillOpen(false)
    setQueue([])
    setIdx(0)
    setRevealed(false)
    await refresh()
  }, [refresh])

  // Grade the current card, advance, and fold the new remainingDue back into the
  // card's reviewsDue so closing mid-drill leaves an accurate count.
  const grade = useCallback(
    async (correct: boolean): Promise<void> => {
      const api = window.api?.school
      const card = queue[idx]
      if (!api?.reviewConcept || !card || grading) return
      setGrading(true)
      try {
        const res = await api.reviewConcept({ conceptId: card.conceptId, correct })
        setResults((r) => ({ got: r.got + (correct ? 1 : 0), total: r.total + 1 }))
        setDaily((d) => (d ? { ...d, reviewsDue: res.remainingDue, doneToday: true } : d))
      } catch {
        // Still advance on a transient failure so the learner isn't stuck.
        setResults((r) => ({ got: r.got + (correct ? 1 : 0), total: r.total + 1 }))
      } finally {
        setGrading(false)
        setRevealed(false)
        setIdx((i) => i + 1)
      }
    },
    [queue, idx, grading]
  )

  // ---- Bridge absent (web/dev): render nothing rather than an empty shell. ----
  if (loaded && !daily) return null

  const doneToday = daily?.doneToday ?? false
  const reviewsDue = daily?.reviewsDue ?? 0
  const hasLesson = Boolean(daily?.lessonTitle && daily?.chapterId)
  const recent = streak?.recent ?? []
  // Oldest -> newest for a left-to-right strip; cap to keep it tidy.
  const strip = [...recent].reverse().slice(-10)
  const todayYmd = daily?.ymd
  const current = streak?.current ?? 0
  const best = streak?.best ?? 0

  const drillCard = queue[idx]
  const drillDone = drillOpen && queue.length > 0 && idx >= queue.length
  // Only a RESOLVED empty queue means "all caught up". Never the loading gap.
  const drillEmpty = drillOpen && !drillLoading && queue.length === 0

  return (
    <section className="school-today-card" aria-busy={!loaded}>
      <header className="school-today-head">
        <div className="school-today-titlewrap">
          <span className="school-today-eyebrow" aria-hidden>
            <CalendarCheck size={18} />
          </span>
          <div>
            <h3 className="school-today-title">Today</h3>
            {todayYmd && <span className="school-today-date">{todayYmd}</span>}
          </div>
        </div>
        <span className={`school-today-streak${current === 0 ? ' is-cold' : ''}`}>
          <Flame size={14} aria-hidden /> {current} day{current === 1 ? '' : 's'}
        </span>
      </header>

      {/* -------- Inline review drill (takes over the body when open) -------- */}
      {drillOpen ? (
        drillLoading ? (
          <div className="school-today-body">
            <p className="muted small">Gathering what&rsquo;s due…</p>
          </div>
        ) : drillEmpty ? (
          <div className="school-drill-done">
            <span className="school-drill-done-icon" aria-hidden>
              <CheckCircle2 size={28} />
            </span>
            <h4 className="school-drill-done-title">All caught up</h4>
            <p className="school-drill-done-sub">
              Nothing is due for review right now. Viktor will resurface concepts as they fade.
            </p>
            <button type="button" className="btn ghost" onClick={closeDrill}>
              Back to Today
            </button>
          </div>
        ) : drillDone ? (
          <div className="school-drill-done">
            <span className="school-drill-done-icon" aria-hidden>
              <CheckCircle2 size={28} />
            </span>
            <h4 className="school-drill-done-title">Review complete</h4>
            <p className="school-drill-done-score">
              <b>{results.got}</b>
              <span className="muted">/ {results.total} recalled</span>
            </p>
            <p className="school-drill-done-sub">
              Today counts. Your streak is safe.
            </p>
            <button type="button" className="btn ghost" onClick={closeDrill}>
              Back to Today
            </button>
          </div>
        ) : drillCard ? (
          <div className="school-drill">
            <div className="school-drill-head">
              <div className="school-drill-progress" aria-hidden>
                <div
                  className="school-drill-progress-fill"
                  style={{ width: `${(idx / queue.length) * 100}%` }}
                />
              </div>
              <span className="school-drill-count">
                {idx + 1} / {queue.length}
              </span>
              <button
                type="button"
                className="school-drill-close"
                onClick={closeDrill}
                aria-label="Close review"
              >
                <X size={15} aria-hidden />
              </button>
            </div>

            <div className="school-drill-card" key={drillCard.conceptId}>
              <span className="school-drill-chapter">
                <BookOpen size={12} aria-hidden /> {drillCard.chapterTitle}
              </span>
              <h4 className="school-drill-concept">{drillCard.conceptName}</h4>
              {revealed ? (
                <p className="school-drill-refresher">{drillCard.short}</p>
              ) : (
                <span className="school-drill-prompt">
                  Do you remember this idea? Recall it, then reveal to check.
                </span>
              )}
            </div>

            <div className="school-drill-actions">
              {!revealed ? (
                <button
                  type="button"
                  className="school-drill-reveal"
                  onClick={() => setRevealed(true)}
                >
                  Show refresher
                </button>
              ) : (
                <>
                  <div className="school-drill-grade">
                    <button
                      type="button"
                      className="school-drill-grade-btn is-missed"
                      onClick={() => grade(false)}
                      disabled={grading}
                    >
                      <RotateCcw size={16} aria-hidden /> Missed it
                    </button>
                    <button
                      type="button"
                      className="school-drill-grade-btn is-got"
                      onClick={() => grade(true)}
                      disabled={grading}
                    >
                      <CheckCircle2 size={16} aria-hidden /> Got it
                    </button>
                  </div>
                  <p className="school-drill-hint muted small">
                    Honest grades make the schedule work. “Missed it” brings it back sooner.
                  </p>
                </>
              )}
            </div>
          </div>
        ) : null
      ) : !loaded ? (
        /* Loading skeleton: mirrors the lesson block + CTA shape to avoid jump. */
        <div className="school-today-body" aria-hidden>
          <div className="school-skel skel-line is-sm" />
          <div className="school-skel skel-line is-lg" />
          <div className="school-skel skel-cta" />
        </div>
      ) : (
        /* -------------------- Normal Today body -------------------- */
        <div className="school-today-body">
          {doneToday ? (
            <div className="school-today-rest">
              <span className="school-today-rest-icon" aria-hidden>
                <CheckCircle2 size={20} />
              </span>
              <div className="school-today-rest-body">
                <span className="school-today-rest-title">Studied today</span>
                <span className="school-today-rest-sub">
                  {current > 1
                    ? `That's ${current} days running. Come back tomorrow to keep it alive.`
                    : 'Come back tomorrow to build your streak.'}
                </span>
                {reviewsDue > 0 && (
                  <button type="button" className="school-today-rest-more" onClick={openDrill}>
                    <Layers size={14} aria-hidden /> Review {reviewsDue} concept
                    {reviewsDue === 1 ? '' : 's'} anyway
                  </button>
                )}
              </div>
            </div>
          ) : hasLesson ? (
            <>
              <div className="school-today-lesson">
                <span className="school-today-lesson-eyebrow">
                  <GraduationCap size={13} aria-hidden /> Today&rsquo;s lesson
                </span>
                <h4 className="school-today-lesson-title">{daily?.lessonTitle}</h4>
                {daily?.chapterTitle && (
                  <span className="school-today-lesson-chapter">{daily.chapterTitle}</span>
                )}
              </div>
              <button
                type="button"
                className="school-today-cta"
                onClick={() => daily?.chapterId && onOpenChapter?.(daily.chapterId)}
              >
                Start lesson <ChevronRight size={18} aria-hidden />
              </button>
            </>
          ) : (
            <div className="school-today-empty">
              <span className="school-today-empty-title">No lesson queued</span>
              <span className="muted small">
                {reviewsDue > 0
                  ? 'You’re ahead of the curriculum. Keep your knowledge sharp with a review below.'
                  : 'You’ve cleared every unlocked lesson. Pass a chapter test to open the next band.'}
              </span>
            </div>
          )}

          {/* Reviews-due row: folded into the one Today surface. Shown unless we
              already offered "review anyway" inside the rest state. */}
          {reviewsDue > 0 && !doneToday && (
            <button type="button" className="school-today-reviews" onClick={openDrill}>
              <span className="school-today-reviews-icon" aria-hidden>
                <Layers size={18} />
              </span>
              <span className="school-today-reviews-body">
                <span className="school-today-reviews-title">Spaced review</span>
                <span className="school-today-reviews-sub">
                  {reviewsDue} concept{reviewsDue === 1 ? '' : 's'} due. A quick refresh counts for
                  today.
                </span>
              </span>
              <span className="school-today-reviews-count">{reviewsDue}</span>
            </button>
          )}

          {/* Calendar strip: last local days. */}
          {strip.length > 0 && (
            <div className="school-today-strip">
              <div className="school-today-strip-label">
                <span className="school-today-strip-title">Last {strip.length} days</span>
                {best > 0 && <span className="school-today-strip-best">Best {best}</span>}
              </div>
              <div className="school-today-cells">
                {strip.map((day) => {
                  const isToday = day.ymd === todayYmd
                  return (
                    <span
                      key={day.ymd}
                      className="school-today-cell"
                      title={`${day.ymd}: ${day.solved ? 'studied' : 'no study'}`}
                    >
                      <span
                        className={`school-today-cell-dot${day.solved ? ' is-studied' : ''}${
                          isToday ? ' is-today' : ''
                        }`}
                      />
                      <span className="school-today-cell-day">{weekdayLabel(day.ymd)}</span>
                    </span>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export default TodayCard
