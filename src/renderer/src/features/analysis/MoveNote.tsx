import type { JSX } from 'react'
import type { ReviewMoveEval } from '@shared/types'
import { displaySan } from '../../chess/notation'
import { formatScore, toWhite } from '../../chess/scores'
import { badgeMeta, markClass } from './badges'

export interface MoveNoteProps {
  /** Review eval for the move that LED to the position on the board. */
  moveEval: ReviewMoveEval | null
  /** True once a review exists, so the empty state can say the right thing. */
  hasReview: boolean
  figurine: boolean
}

/** "11… b5". White's moves take the number, Black's take the ellipsis. */
function movePrefix(ply: number): string {
  return `${Math.ceil(ply / 2)}${ply % 2 === 1 ? '.' : '…'}`
}

/** Both PovEvals in a ReviewMoveEval are MOVER-POV; every number on this page
 *  is White-POV. */
function whiteScore(m: ReviewMoveEval, which: 'best' | 'played'): string {
  const pov = which === 'best' ? m.bestEval : m.playedEval
  return formatScore(
    toWhite({ cp: pov.cp ?? undefined, mate: pov.mate ?? undefined }, m.color)
  )
}

/**
 * What the move on the board did. One classification, the engine's own factual
 * sentence about it, and the move it would have preferred.
 */
export function MoveNote({ moveEval, hasReview, figurine }: MoveNoteProps): JSX.Element {
  const meta = moveEval ? badgeMeta(moveEval.badge) : null

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">This move</h2>
        {moveEval && (
          <span className="sec-count">
            {whiteScore(moveEval, 'best')} → {whiteScore(moveEval, 'played')}
          </span>
        )}
      </div>

      <div className="panel">
        {!moveEval || !meta ? (
          <div className="empty">
            <p className="empty-line">
              {hasReview
                ? 'Step to a reviewed move to see why it works, or where it goes wrong.'
                : 'Nothing has been said about this move yet.'}
            </p>
            {!hasReview && <p className="empty-line">Review the game and every move gets a verdict.</p>}
          </div>
        ) : (
          <div className="an-note">
            <div className="an-note-head">
              <span className="an-note-move">
                {movePrefix(moveEval.ply)} {displaySan(moveEval.san, figurine)}
              </span>
              <span className={`an-mk ${markClass(moveEval.badge)}`} aria-hidden>
                {meta.glyph}
              </span>
              <span className={`an-note-class ${markClass(moveEval.badge)}`}>{meta.label}</span>
            </div>
            <p className="an-note-text">{moveEval.comment ?? fallbackComment(moveEval)}</p>
            {!moveEval.isBest && (
              <div className="an-note-best">
                <span className="lbl">Better</span>
                {movePrefix(moveEval.ply)} {displaySan(moveEval.bestSan, figurine)}
                <span className="an-ev">{whiteScore(moveEval, 'best')}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

// Factual, badge-derived stand-in for reviews cached before ReviewMoveEval
// gained `comment`. Matches the mark the user is looking at; no motif guessing.
function fallbackComment(m: ReviewMoveEval): string {
  switch (m.badge as string) {
    case 'Brilliant':
      return 'A sound sacrifice the engine fully approves.'
    case 'Great':
      return 'This was the only good move here.'
    case 'Best':
      return 'The engine agrees: this is the top move.'
    case 'Excellent':
      return 'Almost nothing given away.'
    case 'Good':
      return 'A solid, sound choice.'
    case 'Book':
      return 'A known book move, still in theory.'
    case 'Forced':
      return 'There was nothing else.'
    case 'Miss':
      return 'Your opponent slipped, and the punishment was not taken.'
    case 'Inaccuracy':
      return 'There was a clearly better continuation.'
    case 'Mistake':
      return 'This hands the opponent the initiative.'
    case 'Blunder':
      return 'This loses significant winning chances.'
    default:
      return m.isBest ? 'The engine agrees: a top move.' : 'A solid, sound choice.'
  }
}
