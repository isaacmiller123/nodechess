import { useEffect, useState, type JSX } from 'react'
import { Compass, ChevronRight, GraduationCap, Target } from 'lucide-react'
import type { RecommendedChapter } from '@shared/types'
import './school-home.css'

// ============================================================================
// FEATURE 2 surface: Viktor's weakness-driven "Recommended next".
//
// Reads window.api.school.recommend() -> { recommended: RecommendedChapter | null }
// and renders one polished call-to-action card pointing at the chapter Viktor
// thinks you should take next. The whole card is a button: clicking opens that
// chapter via onOpenChapter(chapterId).
//
// The `reason` is name-based and human (NEVER an internal Elo). We present it as
// a quoted line from Viktor. The weak concepts that pulled the chapter up are shown
// as display-name chips beneath it, so the learner sees *why* it's next.
//
// Renders nothing when there's no recommendation (all caught up / all locked / no
// desktop bridge): the home simply omits the card rather than showing a shell.
// ============================================================================

export interface RecommendedNextCardProps {
  onOpenChapter: (chapterId: string) => void
}

export function RecommendedNextCard({ onOpenChapter }: RecommendedNextCardProps): JSX.Element | null {
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

  // Cap the visible weak-concept chips so the compact header surface never sprawls.
  const weak = rec.weakConcepts.slice(0, 3)
  const extraWeak = rec.weakConcepts.length - weak.length

  return (
    <button
      type="button"
      className="school-rec-card"
      onClick={() => onOpenChapter(rec.chapterId)}
      aria-label={`Recommended next: ${rec.title}. ${rec.reason}`}
    >
      <div className="school-rec-coach">
        <span className="school-rec-avatar" aria-hidden>
          <GraduationCap size={18} />
        </span>
        <span className="school-rec-coach-id">
          <span className="school-rec-coach-name">Viktor</span>
          <span className="school-rec-eyebrow">
            <Compass size={12} aria-hidden /> Recommended next
          </span>
        </span>
      </div>

      <div className="school-rec-body">
        <h3 className="school-rec-title">{rec.title}</h3>
        {rec.subtitle && <p className="school-rec-subtitle">{rec.subtitle}</p>}

        <div className="school-rec-reason">
          <span className="school-rec-reason-quote" aria-hidden>
            “
          </span>
          <p className="school-rec-reason-text">{rec.reason}</p>
        </div>

        {weak.length > 0 && (
          <div className="school-rec-weak">
            <span className="school-rec-weak-label">Shores up</span>
            <div className="school-rec-chips">
              {weak.map((name) => (
                <span key={name} className="school-rec-chip">
                  <Target size={12} aria-hidden /> {name}
                </span>
              ))}
              {extraWeak > 0 && (
                <span className="school-rec-chip">+{extraWeak} more</span>
              )}
            </div>
          </div>
        )}

        <span className="school-rec-cta">
          Open chapter <ChevronRight size={16} aria-hidden />
        </span>
      </div>
    </button>
  )
}

export default RecommendedNextCard
