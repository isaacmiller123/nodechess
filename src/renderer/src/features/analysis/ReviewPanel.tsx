import { useMemo } from 'react'
import { Sparkles } from 'lucide-react'
import type { EloBand, GameReview } from '@shared/types'
import { EvalGraph } from '../../panels/EvalGraph'
import { badgeMeta, countBadges, BADGE_TABLE_ORDER, type ReviewBadge } from './badges'

export interface ReviewPanelProps {
  review: GameReview | null
  running: boolean
  /** 0..1 progress while a review is in flight. */
  progress: number
  /** Disabled when there are no mainline moves to review. */
  canReview: boolean
  error: string | null
  currentPly: number
  onRun: () => void
  onSeek: (ply: number) => void
}

export function ReviewPanel({
  review,
  running,
  progress,
  canReview,
  error,
  currentPly,
  onRun,
  onSeek
}: ReviewPanelProps) {
  return (
    <div className="panel review-panel">
      <div className="panel-head">
        <span className="panel-title">Game review</span>
        {review && <span className="muted small num">depth {review.depth}</span>}
      </div>

      <div className="review-body">
        {!review && !running && (
          <>
            <p className="muted small review-intro">
              Analyze every move with the engine: accuracy, classifications, and an estimated
              playing strength for the game.
            </p>
            <button className="btn review-run" onClick={onRun} disabled={!canReview}>
              <Sparkles size={15} /> Review game
            </button>
            {!canReview && <p className="muted small">Play through some moves first.</p>}
            {error && <p className="review-error small">{error}</p>}
          </>
        )}

        {running && (
          <div className="review-progress">
            <div className="review-progress-head small">
              <span>Analyzing…</span>
              <span className="num">{Math.round(progress * 100)}%</span>
            </div>
            <div className="review-bar">
              <span className="review-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          </div>
        )}

        {review && !running && (
          <>
            <SummaryTable review={review} />

            <p className="review-elo-note muted small">
              Performance estimate for this game, separate from your Glicko rating.
            </p>

            <div className="review-graph-wrap">
              <EvalGraph moveEvals={review.moveEvals} currentPly={currentPly} onSeek={onSeek} />
            </div>

            <button className="btn ghost review-rerun" onClick={onRun} disabled={!canReview}>
              Re-run review
            </button>
            {/* A failed re-run must not look like a silent no-op over the old review. */}
            {error && <p className="review-error small">{error}</p>}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Chess.com-style review sidebar table: per-side accuracy (big), estimated
 * performance band, ACPL, then one row per badge class with the colored icon
 * and each side's count.
 */
function SummaryTable({ review }: { review: GameReview }) {
  const whiteCounts = useMemo(() => countBadges(review.moveEvals, 'white'), [review.moveEvals])
  const blackCounts = useMemo(() => countBadges(review.moveEvals, 'black'), [review.moveEvals])

  // Fixed chess.com rows; Forced is appended only when it actually occurred.
  const rows: ReviewBadge[] = useMemo(() => {
    const base = [...BADGE_TABLE_ORDER]
    if ((whiteCounts.get('Forced') ?? 0) + (blackCounts.get('Forced') ?? 0) > 0) {
      base.push('Forced')
    }
    return base
  }, [whiteCounts, blackCounts])

  return (
    <div className="rv-table" role="table" aria-label="Review summary by side">
      <div className="rv-row rv-players" role="row">
        <span className="rv-cell rv-player" role="columnheader">
          White
        </span>
        <span className="rv-cell" role="columnheader" aria-hidden />
        <span className="rv-cell rv-player" role="columnheader">
          Black
        </span>
      </div>

      <div className="rv-row rv-accuracy-row" role="row">
        <span className="rv-cell rv-acc rv-acc-white num" role="cell">
          {review.white.accuracy.toFixed(1)}
        </span>
        <span className="rv-cell rv-label" role="cell">
          Accuracy
        </span>
        <span className="rv-cell rv-acc rv-acc-black num" role="cell">
          {review.black.accuracy.toFixed(1)}
        </span>
      </div>

      <div className="rv-row" role="row">
        <EloCell band={review.whiteElo} />
        {/* An accuracy-derived ESTIMATE (EloBand), not a rating: the band range
            below the point value is mandatory, and the label must say so. */}
        <span className="rv-cell rv-label" role="cell">
          Est. performance
        </span>
        <EloCell band={review.blackElo} />
      </div>

      <div className="rv-row rv-acpl-row" role="row">
        <span className="rv-cell num" role="cell">
          {review.white.acpl}
        </span>
        <span className="rv-cell rv-label" role="cell">
          Avg. CP loss
        </span>
        <span className="rv-cell num" role="cell">
          {review.black.acpl}
        </span>
      </div>

      {rows.map((badge) => {
        const meta = badgeMeta(badge)
        const w = whiteCounts.get(badge) ?? 0
        const b = blackCounts.get(badge) ?? 0
        // Chess.com keeps every class visible; rows nobody hit just dim.
        const zero = w === 0 && b === 0
        return (
          <div className={`rv-row rv-badge-row${zero ? ' rv-row-zero' : ''}`} role="row" key={badge}>
            <span className={`rv-cell rv-count num${w > 0 ? ` tone-${meta.tone}` : ' rv-zero'}`} role="cell">
              {w}
            </span>
            <span className={`rv-cell rv-badge-label tone-${meta.tone}`} role="cell">
              <span className={`bchip bchip-${meta.tone}`} aria-hidden>
                {meta.glyph}
              </span>
              {meta.label}
            </span>
            <span className={`rv-cell rv-count num${b > 0 ? ` tone-${meta.tone}` : ' rv-zero'}`} role="cell">
              {b}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function EloCell({ band }: { band: EloBand }) {
  return (
    <span className="rv-cell rv-elo" role="cell">
      <span className="rv-elo-est num">~{Math.round(band.est)}</span>
      <span className="rv-elo-range small muted num">
        {Math.round(band.low)}–{Math.round(band.high)}
      </span>
    </span>
  )
}
