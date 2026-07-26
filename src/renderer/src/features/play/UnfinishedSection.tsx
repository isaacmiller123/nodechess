// UNFINISHED, from design-lab/v1/play.html (#s-resume).
//
// v1 promises that a game you leave part way through sits here until you come
// back. One kind of game actually does: an online session, which lives in a
// module-level store for the app's whole lifetime, so an open table survives
// walking off this screen. A local game does not: the board is component
// state and the view is unmounted on every navigation, and games:save refuses
// anything without a result, so nothing is parked anywhere to list.
//
// So the section keeps v1's shape, its columns and its first line, and its
// second line promises only the thing that is true.

import type { JSX } from 'react'
import { timeControlLabel } from './timeControl'
import type { OnlineState } from './online/onlineStore'

export interface UnfinishedSectionProps {
  online: OnlineState
  /** Take the user back to the Online section, where the table is. */
  onReturn: () => void
}

export function UnfinishedSection({ online, onReturn }: UnfinishedSectionProps): JSX.Element {
  const open = online.phase === 'hosting' || online.phase === 'connecting'
  const tc = online.config?.tc

  return (
    <section className="sec play-resume" id="s-resume">
      <div className="sec-head">
        <h2 className="lbl">Unfinished</h2>
        <span className="sec-count">{open ? 1 : 0}</span>
      </div>
      <div className="well">
        <div className="empty-head">
          <span className="lbl">Opponent</span>
          <span className="lbl">Clock</span>
          <span className="lbl">Moves</span>
          <span className="lbl">When</span>
        </div>
        {open ? (
          <button className="play-row" type="button" onClick={onReturn}>
            <span className="play-row-name">
              {online.phase === 'connecting' ? 'Connecting' : 'Nobody yet'}
            </span>
            <span className="play-row-cell">
              {/* A joiner has no config until the host's start arrives; the
                  clock is theirs to set, so there is nothing to report yet. */}
              {tc ? timeControlLabel(tc.initialMs, tc.incrementMs) : 'Theirs'}
            </span>
            <span className="play-row-cell">{online.plyCount}</span>
            <span className="play-row-cell">Open</span>
          </button>
        ) : (
          <div className="empty">
            <p className="empty-line">No game is waiting for you.</p>
            <p className="empty-line">
              An online table you walk away from sits here until you come back.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
