// Reputation: public conduct standing, separate from rating. A deterministic
// fold over witnessed conduct events, visible from game 1 (only competitive
// rating hides). Shared by the own-profile preview (ProfileTab) and the viewer
// page (ProfilePage). The panel shows a score, a tier, and what moved them.
// It does not explain how the fold works.

import { type JSX } from 'react'
import { AlertCircle, Check, ThumbsUp } from 'lucide-react'
import type { UiReputation } from '../mock/types'

const TIER_CLASS: Record<UiReputation['tier'], string> = {
  Exemplary: 'is-exemplary',
  Solid: 'is-solid',
  Mixed: 'is-mixed',
  Poor: 'is-poor'
}

export function ReputationPanel({ reputation }: { reputation: UiReputation }): JSX.Element {
  const tierClass = TIER_CLASS[reputation.tier]
  return (
    <div className="aprof-rep">
      <div className="aprof-rep-top">
        <span className="aprof-rep-score num">{reputation.score}</span>
        <div className="aprof-rep-scoremeta">
          <span className={`aprof-tier ${tierClass}`}>{reputation.tier}</span>
          <span className="muted small">conduct score · 0–100</span>
        </div>
        <span
          className="aprof-commend num"
          title="Good game commendations from opponents"
        >
          <ThumbsUp size={13} aria-hidden /> {reputation.commendations.toLocaleString()}
        </span>
      </div>

      <div
        className="aprof-rep-meter"
        role="img"
        aria-label={`Conduct score ${reputation.score} of 100, ${reputation.tier}`}
      >
        <span className={`aprof-rep-fill ${tierClass}`} style={{ width: `${reputation.score}%` }} />
      </div>

      <ul className="aprof-rep-breakdown">
        {reputation.components.map((c) => (
          <li key={c.label}>
            <span className={`aprof-rep-mark${c.positive ? '' : ' is-neg'}`} aria-hidden>
              {c.positive ? <Check size={13} /> : <AlertCircle size={13} />}
            </span>
            <span className="aprof-rep-label">{c.label}</span>
            <span className="aprof-rep-value num">{c.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
