import { useCallback, useEffect, useState, type JSX } from 'react'
import type { SchoolDaily, DailyStreak, DueConcept } from '@shared/types'
import { Icon } from './SchoolScene'

// ============================================================================
// The one "Today" surface on the School index: today's lesson, the local-day
// study streak, and the spaced-review queue folded into the same section. Reads:
//   window.api.school.daily()   -> SchoolDaily (lesson + doneToday + reviewsDue)
//   window.api.school.streak()  -> { streak: DailyStreak }  (calendar + flame)
//
// Surfaces, in order of "what should I do now":
//   • not done, lesson queued  -> the lesson as a row you can open
//   • reviews due (any state)  -> a row that opens the INLINE review drill
//   • drill open               -> a card per DueConcept; grade each via
//                                 window.api.school.reviewConcept({conceptId,correct}).
//                                 A review counts the day server-side, so on exit we
//                                 re-pull daily()+streak() and the section flips to rest.
//   • done today               -> the rest state
// The calendar of the last local days sits at the foot of the panel always.
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

  // Re-pull daily + streak (after a review counts the day, the section must flip).
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
  // keeps the terminal "All caught up" state from flashing while the IPC resolves
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

  // Close the drill and reconcile the section (a review counts the day server-side).
  const closeDrill = useCallback(async (): Promise<void> => {
    setDrillOpen(false)
    setQueue([])
    setIdx(0)
    setRevealed(false)
    await refresh()
  }, [refresh])

  // Grade the current card, advance, and fold the new remainingDue back into the
  // count so closing mid-drill leaves an accurate number.
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

  const card = queue[idx]
  const drillDone = drillOpen && queue.length > 0 && idx >= queue.length
  // Only a RESOLVED empty queue means "all caught up". Never the loading gap.
  const drillEmpty = drillOpen && !drillLoading && queue.length === 0

  const count = drillOpen
    ? card
      ? `${idx + 1} of ${queue.length}`
      : 'Review'
    : current > 0
      ? `${current} day streak`
      : 'No streak yet'

  const reviewRow = (
    <button className="go" type="button" onClick={openDrill}>
      <span>
        <span className="go-name">Spaced review</span>
        <span className="go-sub">
          {reviewsDue} concept{reviewsDue === 1 ? '' : 's'} due · a quick refresh counts for today
        </span>
      </span>
      <Icon id="i-arrow" className="icon go-arrow" />
    </button>
  )

  return (
    <section className="sec" aria-busy={!loaded}>
      <div className="sec-head">
        <h2 className="lbl">Today</h2>
        <span className="sec-count">{count}</span>
      </div>

      <div className="panel">
        {drillOpen ? (
          drillLoading ? (
            <div className="empty">
              <p className="empty-line">Gathering what is due.</p>
            </div>
          ) : drillEmpty || drillDone ? (
            <>
              <div className="empty">
                <p className="empty-line">
                  {drillEmpty ? 'Nothing is due for review right now.' : 'Review complete.'}
                </p>
                <p className="empty-line">
                  {drillEmpty
                    ? 'Viktor will resurface concepts as they fade.'
                    : `${results.got} of ${results.total} recalled. Today counts, so your streak is safe.`}
                </p>
              </div>
              <div className="panel-foot">
                <button className="btn is-quiet" type="button" onClick={closeDrill}>
                  Back to today
                </button>
              </div>
            </>
          ) : card ? (
            <>
              <div className="row" key={card.conceptId}>
                <span className="lbl">{card.chapterTitle}</span>
                <p className="go-name">{card.conceptName}</p>
                <p className="go-sub">
                  {revealed ? card.short : 'Recall this idea, then reveal it to check yourself.'}
                </p>
              </div>
              <div className="row">
                <div className="chips">
                  {!revealed ? (
                    <button className="btn" type="button" onClick={() => setRevealed(true)}>
                      Show refresher
                    </button>
                  ) : (
                    <>
                      <button
                        className="btn"
                        type="button"
                        onClick={() => grade(false)}
                        disabled={grading}
                      >
                        Missed it
                      </button>
                      <button
                        className="btn is-primary"
                        type="button"
                        onClick={() => grade(true)}
                        disabled={grading}
                      >
                        Got it
                      </button>
                    </>
                  )}
                  <button className="btn is-quiet" type="button" onClick={closeDrill}>
                    Close
                  </button>
                </div>
              </div>
            </>
          ) : null
        ) : !loaded ? (
          <div className="empty" aria-hidden>
            <p className="empty-line">Loading today.</p>
          </div>
        ) : (
          <>
            {doneToday ? (
              <div className="empty">
                <p className="empty-line">Studied today.</p>
                <p className="empty-line">
                  {current > 1
                    ? `That is ${current} days running. Come back tomorrow to keep it alive.`
                    : 'Come back tomorrow to build your streak.'}
                </p>
              </div>
            ) : hasLesson ? (
              <button
                className="go row is-here"
                type="button"
                onClick={() => daily?.chapterId && onOpenChapter?.(daily.chapterId)}
              >
                <span>
                  <span className="go-name">{daily?.lessonTitle}</span>
                  <span className="go-sub">{daily?.chapterTitle ?? 'Today’s lesson'}</span>
                </span>
                <Icon id="i-arrow" className="icon go-arrow" />
              </button>
            ) : (
              <div className="empty">
                <p className="empty-line">No lesson queued.</p>
                <p className="empty-line">
                  {reviewsDue > 0
                    ? 'You are ahead of the curriculum. Keep it sharp with a review.'
                    : 'You have cleared every unlocked lesson. Pass a chapter test to open the next band.'}
                </p>
              </div>
            )}

            {reviewsDue > 0 && reviewRow}

            {strip.length > 0 && (
              <>
                <div className="row is-dense">
                  <span className="lbl">
                    {`Last ${strip.length} days${best > 0 ? ` · best ${best}` : ''}`}
                  </span>
                </div>
                <div className="sch-days">
                  {strip.map((day) => (
                    <span
                      className="sch-day"
                      key={day.ymd}
                      title={`${day.ymd}: ${day.solved ? 'studied' : 'no study'}`}
                    >
                      <span
                        className={`sch-day-dot${day.solved ? ' is-studied' : ''}${
                          day.ymd === todayYmd ? ' is-today' : ''
                        }`}
                      />
                      <span className="lbl">{weekdayLabel(day.ymd)}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </section>
  )
}

export default TodayCard
