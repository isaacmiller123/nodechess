// Over-the-board setup: two humans sharing one machine. No engine, no
// assistance: just the two players' names, a shared clock, and the auto-flip
// option (spin the board to whoever is on move). Lives inside the Local tab.
// Controlled by PlayView; tokens + namespaced .otb- classes only.

import type { JSX } from 'react'
import { RefreshCw, Users } from 'lucide-react'
import { TimeControlPicker } from './TimeControlPicker'
import type { TimeControl } from './timeControl'

export interface OtbSetupProps {
  whiteName: string
  blackName: string
  timeControl: TimeControl
  /** Spin the board to the side to move after every move. */
  autoFlip: boolean
  onWhiteName: (name: string) => void
  onBlackName: (name: string) => void
  onTimeControl: (tc: TimeControl) => void
  onAutoFlip: (on: boolean) => void
  onStart: () => void
}

const NAME_MAX = 40

export function OtbSetup({
  whiteName,
  blackName,
  timeControl,
  autoFlip,
  onWhiteName,
  onBlackName,
  onTimeControl,
  onAutoFlip,
  onStart
}: OtbSetupProps): JSX.Element {
  return (
    <section className="psetup-panel otb" aria-label="Over the board setup">
      <header className="qm-head">
        <span className="otb-head-icon" aria-hidden>
          <Users size={22} />
        </span>
        <div className="qm-head-meta">
          <h2>Over the board</h2>
          <span className="muted small">
            Two players, one screen. Pass-and-play with a shared clock.
          </span>
        </div>
      </header>

      <div className="psetup-field">
        <span className="psetup-label">Players</span>
        <div className="otb-players">
          <label className="otb-player">
            <span className="otb-player-side">
              <span className="otb-disc is-white" aria-hidden>
                ♔
              </span>
              White
            </span>
            <input
              className="otb-name-input"
              type="text"
              value={whiteName}
              maxLength={NAME_MAX}
              placeholder="White"
              aria-label="White player name"
              onChange={(e) => onWhiteName(e.target.value)}
            />
          </label>
          <label className="otb-player">
            <span className="otb-player-side">
              <span className="otb-disc is-black" aria-hidden>
                ♚
              </span>
              Black
            </span>
            <input
              className="otb-name-input"
              type="text"
              value={blackName}
              maxLength={NAME_MAX}
              placeholder="Black"
              aria-label="Black player name"
              onChange={(e) => onBlackName(e.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="psetup-field">
        <span className="psetup-label">Time control</span>
        <TimeControlPicker value={timeControl} onChange={onTimeControl} />
      </div>

      <div className="psetup-field">
        <button
          type="button"
          className={`otb-flip-toggle${autoFlip ? ' on' : ''}`}
          role="switch"
          aria-checked={autoFlip}
          onClick={() => onAutoFlip(!autoFlip)}
        >
          <span className="otb-flip-icon" aria-hidden>
            <RefreshCw size={16} />
          </span>
          <span className="otb-flip-text">
            <span className="otb-flip-title">Auto-flip board</span>
            <span className="otb-flip-sub muted">
              Turn the board to face whoever is on move.
            </span>
          </span>
          <span className="otb-switch" aria-hidden>
            <span className="otb-switch-knob" />
          </span>
        </button>
      </div>

      <button type="button" className="btn psetup-start" onClick={onStart}>
        <span className="psetup-start-main">Start game</span>
        <span className="psetup-start-sub num">
          {whiteName || 'White'} vs {blackName || 'Black'}
          {timeControl.baseMs > 0 ? ` · ${timeControl.label}` : ' · Unlimited'}
        </span>
      </button>
    </section>
  )
}

export default OtbSetup
