import { useState, type FormEvent, type JSX } from 'react'
import { X, Swords, Puzzle, GraduationCap, type LucideIcon } from 'lucide-react'
import { OverlayDialog } from './OverlayDialog'
import { isWebBuild } from '../platform'
import { useSettings } from '../state/settings'
import type { ViewKey } from './Layout'

export interface OnboardingProps {
  onClose: () => void
  onNavigate: (view: ViewKey) => void
}

const TOUR: { view: ViewKey; title: string; body: string; Icon: LucideIcon }[] = [
  { view: 'play', title: 'Play', body: 'Face Stockfish at any strength, or grandmaster-style personas.', Icon: Swords },
  { view: 'puzzles', title: 'Puzzles', body: 'Train tactics with a personal rating that adapts to you.', Icon: Puzzle },
  { view: 'school', title: 'School', body: 'Learn with Viktor, a guided course from the basics to 2000.', Icon: GraduationCap }
]

export function Onboarding({ onClose, onNavigate }: OnboardingProps): JSX.Element {
  const { settings, update } = useSettings()
  const [name, setName] = useState(settings.username === 'User' ? '' : settings.username)

  const commitName = (): void => {
    const trimmed = name.trim()
    if (trimmed && trimmed !== settings.username) update({ username: trimmed.slice(0, 24) })
  }

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    commitName()
    onClose()
  }

  const goTo = (view: ViewKey): void => {
    commitName()
    onNavigate(view)
    onClose()
  }

  return (
    <OverlayDialog onClose={onClose} placement="center" className="shell-modal" labelledBy="onboarding-title">
      <div className="shell-modal-head">
        <h2 id="onboarding-title">Welcome to nodechess</h2>
        <button type="button" className="shell-modal-close" aria-label="Close" onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      </div>
      <div className="shell-modal-body">
        <p className="onboarding-lead">
          {/* Web: it's served over the internet with an optional account. Only the
              desktop app can honestly claim "no account, no internet". */}
          {isWebBuild
            ? 'Set a name to personalize your profile, then dive in.'
            : 'Everything runs locally: no account, no internet. Set a name to personalize your profile, then dive in.'}
        </p>
        <form onSubmit={onSubmit}>
          <label className="onboarding-field">
            <span>Your name</span>
            <input
              className="text-input"
              type="text"
              value={name}
              maxLength={24}
              placeholder="Player"
              aria-label="Your name"
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
            />
          </label>
        </form>
        <ul className="onboarding-tour">
          {TOUR.map(({ view, title, body, Icon }) => (
            <li key={view}>
              <span className="onboarding-tour-icon">
                <Icon size={20} aria-hidden />
              </span>
              <span className="onboarding-tour-text">
                <strong>{title}</strong>
                <span>{body}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="shell-modal-foot">
        <button type="button" className="btn ghost" onClick={onClose}>
          Skip for now
        </button>
        <button type="button" className="btn" onClick={() => goTo('play')}>
          Start playing
        </button>
      </div>
    </OverlayDialog>
  )
}
