// "While you wait", from design-lab/v1/play.html: two rows under a running
// search, so the wait is not dead time.
//
// v1 labels them "4.7M positions, by theme" and "CH 07, LESSON 3 OF 5". Both
// are mock numbers. No IPC returns a puzzle-position count, and on a fresh
// install the puzzle database is not even on disk, so this asks the two
// channels that do exist (puzzles:themes, school:daily) and says what they
// answer, including when the answer is "nothing here yet".

import { useEffect, useState, type JSX } from 'react'
import type { SchoolDaily } from '@shared/types'
import type { ViewKey } from '../../components/Layout'
import { usePuzzlesReady } from '../../hooks/useEngineReady'
import { leavePlay } from './leavePlay'

export interface WhileYouWaitProps {
  /** Navigate away from Play. The shell does not hand Play one, so without it
   *  the rows press the rail themselves (leavePlay). Either way they go. */
  onNavigate?: (view: ViewKey) => void
}

export function WhileYouWait({ onNavigate }: WhileYouWaitProps): JSX.Element {
  const { ready: puzzlesReady } = usePuzzlesReady(true)
  const [themeCount, setThemeCount] = useState<number | null>(null)
  const [daily, setDaily] = useState<SchoolDaily | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api?.puzzles
      ?.themes()
      .then((r) => {
        if (!cancelled) setThemeCount(r.themes.length)
      })
      .catch(() => undefined)
    void window.api?.school
      ?.daily()
      .then((d) => {
        if (!cancelled) setDaily(d)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const go = onNavigate ?? leavePlay

  const puzzleSub =
    puzzlesReady === false
      ? 'The puzzle set is not on this machine yet'
      : themeCount !== null
        ? `${themeCount} themes`
        : 'By theme'

  const schoolSub = daily?.lessonTitle
    ? `${daily.chapterTitle ?? 'Today'} · ${daily.lessonTitle}`
    : daily && daily.reviewsDue > 0
      ? `${daily.reviewsDue} ${daily.reviewsDue === 1 ? 'review' : 'reviews'} due`
      : daily
        ? 'Nothing scheduled today'
        : 'Lessons and reviews'

  return (
    <section className="sec play-wait">
      <div className="sec-head">
        <h2 className="lbl">While you wait</h2>
      </div>
      <div className="panel golist">
        <button className="go" type="button" onClick={() => go('puzzles')}>
          <span>
            <span className="go-name">Puzzles</span>
            <span className="go-sub">{puzzleSub}</span>
          </span>
          <svg className="icon go-arrow" aria-hidden focusable="false">
            <use href="#i-arrow" />
          </svg>
        </button>
        <button className="go" type="button" onClick={() => go('school')}>
          <span>
            <span className="go-name">School</span>
            <span className="go-sub">{schoolSub}</span>
          </span>
          <svg className="icon go-arrow" aria-hidden focusable="false">
            <use href="#i-arrow" />
          </svg>
        </button>
      </div>
    </section>
  )
}
