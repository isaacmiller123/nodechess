import type { ReactNode } from 'react'
import {
  Home,
  Swords,
  Cpu,
  Puzzle,
  School as SchoolIcon,
  BookOpen,
  Dices,
  User,
  Fingerprint,
  Settings as SettingsIcon,
  type LucideIcon
} from 'lucide-react'
import { UserAvatar } from './Avatar'
import { Logo } from './Logo'
import { useSettings } from '../state/settings'

export type ViewKey =
  | 'home'
  | 'play'
  | 'games'
  | 'analysis'
  | 'puzzles'
  | 'school'
  | 'openings'
  | 'progress'
  | 'account'
  | 'settings'

export const NAV: { key: ViewKey; label: string; Icon: LucideIcon }[] = [
  { key: 'home', label: 'Home', Icon: Home },
  { key: 'play', label: 'Play', Icon: Swords },
  { key: 'games', label: 'Games', Icon: Dices },
  { key: 'analysis', label: 'Analysis', Icon: Cpu },
  { key: 'puzzles', label: 'Puzzles', Icon: Puzzle },
  { key: 'school', label: 'School', Icon: SchoolIcon },
  { key: 'openings', label: 'Openings', Icon: BookOpen },
  { key: 'progress', label: 'Progress', Icon: User },
  { key: 'account', label: 'Account', Icon: Fingerprint }
]

export function Layout({
  active,
  onNavigate,
  title,
  topRight,
  playPulse = false,
  children
}: {
  active: ViewKey
  onNavigate: (v: ViewKey) => void
  title: string
  topRight?: ReactNode
  /** Pulse a dot on the Play rail item — a live online game is running while
   *  the Play view isn't the one showing. */
  playPulse?: boolean
  children: ReactNode
}) {
  const { settings } = useSettings()
  return (
    <div className="app-shell">
      <nav className="rail" aria-label="Primary">
        <div className="rail-brand" role="img" aria-label="nodechess" title="nodechess">
          <Logo size={24} />
          <span className="rail-wordmark">nodechess</span>
        </div>
        <div className="rail-nav">
          {NAV.map(({ key, label, Icon }) => {
            const isActive = active === key
            const pulse = key === 'play' && playPulse
            return (
              <button
                key={key}
                type="button"
                className={`rail-item${isActive ? ' is-active' : ''}${pulse ? ' has-pulse' : ''}`}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onNavigate(key)}
              >
                <span className="rail-icon-wrap">
                  <Icon className="rail-icon" size={20} aria-hidden />
                  {pulse && <span className="rail-live-dot" aria-hidden />}
                </span>
                <span>{label}</span>
                {pulse && <span className="visually-hidden"> (online game in progress)</span>}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          className={`profile-chip${active === 'settings' ? ' is-active' : ''}`}
          aria-current={active === 'settings' ? 'page' : undefined}
          aria-label={`Profile and settings — ${settings.username}`}
          title="Profile & settings"
          onClick={() => onNavigate('settings')}
        >
          <UserAvatar src={settings.avatar} name={settings.username} size={32} />
          <span className="profile-name">{settings.username}</span>
          <SettingsIcon size={16} className="profile-gear" aria-hidden />
        </button>
      </nav>

      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <div className="topbar-right">{topRight}</div>
        </header>
        <main className="content" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  )
}
