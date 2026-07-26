// PLAY → LOCAL BOARD, transcribed from design-lab/v1/play.html (#s-local).
//
// Two people, one screen, no engine and no network. Everything v1 draws here
// is real: the names are the ones the board and the saved game carry, "Flip
// each turn" is the auto-flip the page already performs after every move, and
// the go-note is literally true, because this path never calls newGame and
// never reports a result.

import { useState, type JSX } from 'react'
import { ClockChips, Segmented } from './SetupControls'
import { timeControlById, type TimeControl } from './timeControl'
import type { StartSpec } from './setupTypes'

export interface LocalSectionProps {
  onStart: (spec: StartSpec) => void
}

export function LocalSection({ onStart }: LocalSectionProps): JSX.Element {
  // Empty, not "Player 1"/"Player 2": v1 puts White and Black in the
  // placeholders, and an unnamed side falls back to its colour at start.
  const [whiteName, setWhiteName] = useState('')
  const [blackName, setBlackName] = useState('')
  const [autoFlip, setAutoFlip] = useState(false)
  const [tc, setTc] = useState<TimeControl>(() => timeControlById('unlimited'))

  return (
    <section className="sec" id="s-local">
      <div className="sec-head">
        <h2 className="lbl">Local board</h2>
        <span className="sec-count">2 players</span>
      </div>

      <div className="panel">
        <div className="play-field">
          <span className="lbl">Players</span>
          <div className="play-inputs">
            <input
              className="play-name"
              type="text"
              placeholder="White"
              aria-label="White player"
              value={whiteName}
              onChange={(e) => setWhiteName(e.target.value)}
            />
            <input
              className="play-name"
              type="text"
              placeholder="Black"
              aria-label="Black player"
              value={blackName}
              onChange={(e) => setBlackName(e.target.value)}
            />
          </div>
        </div>

        <div className="play-field">
          <span className="lbl">Clock</span>
          <ClockChips value={tc} onChange={setTc} customId="local-custom" />
        </div>

        <div className="play-field">
          <span className="lbl">Board</span>
          <div>
            <Segmented
              label="Board"
              value={autoFlip ? 'flip' : 'foot'}
              options={[
                { key: 'foot', label: 'White at foot' },
                { key: 'flip', label: 'Flip each turn' }
              ]}
              onChange={(v) => setAutoFlip(v === 'flip')}
            />
            <span className="play-qual">
              Flip each turn keeps the player to move at the foot.
            </span>
          </div>
        </div>
      </div>

      <div className="play-go">
        <button
          className="btn is-primary"
          type="button"
          onClick={() => onStart({ kind: 'otb', whiteName, blackName, autoFlip, tc })}
        >
          Open board
        </button>
        <span className="play-go-note">Nothing here needs an account.</span>
      </div>
    </section>
  )
}
