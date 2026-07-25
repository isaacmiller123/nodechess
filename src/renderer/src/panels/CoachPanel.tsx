import { ArrowUpRight } from 'lucide-react'
import type { ReviewMoveEval } from '@shared/types'
import { displaySan } from '../chess/notation'
import { badgeHeadline, badgeMeta } from '../features/analysis/badges'

export interface CoachPanelProps {
  /** Review eval for the move that LED to the current board position (null at root). */
  moveEval: ReviewMoveEval | null
  figurineMode: boolean
  /**
   * Optional board hook for the "best was …" affordance: called with the best
   * move's UCI to preview it as an arrow on the board, and with null to clear
   * the preview. Without it the best move renders as plain text. (Wire from
   * AnalysisView by merging a green DrawShape for the UCI into the board
   * shapes.)
   */
  onPreviewBest?: (uci: string | null) => void
}

/**
 * Chess.com-style move verdict panel. Purely presentational over the review
 * data: colored "Qxb2 is a blunder" headline + the FACTUAL review comment
 * computed in main at review time (ReviewMoveEval.comment). No coach/NLG IPC:
 * the motif prose was wrong too often, and review data needs no loading state.
 */
export function CoachPanel({ moveEval, figurineMode, onPreviewBest }: CoachPanelProps) {
  const meta = moveEval ? badgeMeta(moveEval.badge) : null

  return (
    <section className="panel coach-panel" aria-label="Coach">
      <div className="panel-head">
        <span className="panel-title">Coach</span>
        {moveEval && meta && (
          <span className={`coach-badge tone-${meta.tone}`}>
            <span className={`bchip bchip-${meta.tone}`} aria-hidden>
              {meta.glyph}
            </span>
            {meta.label}
          </span>
        )}
      </div>
      <div className="coach-body">
        {!moveEval || !meta ? (
          <p className="muted small">
            Step to a reviewed move to see why it works, or where it goes wrong.
          </p>
        ) : (
          <>
            <div className={`coach-headline tone-${meta.tone}`}>
              <span className={`bchip bchip-${meta.tone} coach-headline-chip`} aria-hidden>
                {meta.glyph}
              </span>
              <span className="coach-headline-text">
                <span className="num">{displaySan(moveEval.san, figurineMode)}</span>{' '}
                {badgeHeadline(moveEval.badge)}
              </span>
            </div>

            {/* comment is optional only for rows cached before the field existed;
                the badge sentence keeps those old reviews readable. */}
            <p className="coach-text">{moveEval.comment ?? fallbackComment(moveEval)}</p>

            {!moveEval.isBest &&
              (onPreviewBest ? (
                <button
                  type="button"
                  className="coach-best-btn"
                  title="Show the best move on the board"
                  onClick={() => onPreviewBest(moveEval.bestUci)}
                  onMouseEnter={() => onPreviewBest(moveEval.bestUci)}
                  onMouseLeave={() => onPreviewBest(null)}
                  onFocus={() => onPreviewBest(moveEval.bestUci)}
                  onBlur={() => onPreviewBest(null)}
                >
                  <ArrowUpRight size={13} aria-hidden />
                  best was <span className="num">{displaySan(moveEval.bestSan, figurineMode)}</span>
                </button>
              ) : (
                <span className="coach-best muted small">
                  best was <span className="num">{displaySan(moveEval.bestSan, figurineMode)}</span>
                </span>
              ))}
          </>
        )}
      </div>
    </section>
  )
}

// Factual, badge-derived stand-in for reviews cached before ReviewMoveEval
// gained `comment`. Matches the chip the user is looking at; no motif guessing.
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
