import { useEffect, useState, type JSX } from 'react'
import type { RecommendedChapter } from '@shared/types'
import { CoachBody, Icon } from './SchoolScene'

// ============================================================================
// Viktor's weakness-driven "Recommended next".
//
// Reads window.api.school.recommend() -> { recommended: RecommendedChapter | null }
// and puts it where the design puts everything Viktor says: in his own coach
// block, with the chapter under it as a row you can open. The `reason` is
// name-based and human (NEVER an internal Elo); the weak concepts that pulled
// the chapter up are chips beneath it, so the learner sees *why* it is next.
//
// Renders nothing when there's no recommendation (all caught up / all locked / no
// desktop bridge): the index simply omits the section rather than showing a shell.
// ============================================================================

export interface RecommendedNextCardProps {
  onOpenChapter: (chapterId: string) => void
}

export function RecommendedNextCard({
  onOpenChapter
}: RecommendedNextCardProps): JSX.Element | null {
  const [rec, setRec] = useState<RecommendedChapter | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const api = window.api?.school
    if (!api?.recommend) {
      setLoaded(true)
      return
    }
    let cancelled = false
    api
      .recommend()
      .then((r) => {
        if (cancelled) return
        setRec(r.recommended)
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // No recommendation (all caught up, all locked, or no bridge). Render nothing.
  if (!loaded || !rec) return null

  // Cap the visible weak-concept chips so the side column never sprawls.
  const weak = rec.weakConcepts.slice(0, 3)
  const extraWeak = rec.weakConcepts.length - weak.length

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Recommended next</h2>
      </div>
      <div className="panel">
        <CoachBody said={[rec.reason]} />
        <button className="go" type="button" onClick={() => onOpenChapter(rec.chapterId)}>
          <span>
            <span className="go-name">{rec.title}</span>
            {rec.subtitle && <span className="go-sub">{rec.subtitle}</span>}
          </span>
          <Icon id="i-arrow" className="icon go-arrow" />
        </button>
        {weak.length > 0 && (
          <div className="row is-dense">
            <span className="lbl">Shores up</span>
            <div className="chips">
              {weak.map((name) => (
                <span key={name} className="chip">
                  {name}
                </span>
              ))}
              {extraWeak > 0 && <span className="chip">+{extraWeak} more</span>}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export default RecommendedNextCard
