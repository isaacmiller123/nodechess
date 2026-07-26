import { Fragment, useMemo, type CSSProperties, type JSX } from 'react'
import type { EloBand, GameReview, ReviewMoveEval } from '@shared/types'
import { badgeMeta, countBadges, markClass, BADGE_TABLE_ORDER, type ReviewBadge } from './badges'

export interface ReviewSectionProps {
  review: GameReview | null
  running: boolean
  /** 0..1 while a review is in flight. */
  progress: number
  /** False when there are no mainline moves to review. */
  canReview: boolean
  error: string | null
  /** Ply on the board, or -1 when the board is off the mainline. */
  currentPly: number
  onRun: () => void
  onSeek: (ply: number) => void
  /** Ply of the next flagged move after the cursor, or null when there is none. */
  nextMistakePly: number | null
}

/* The graph's own space. 560 by 72 is v1's viewBox; the SVG scales to the panel,
   so these are only the numbers the path is written in. */
const GW = 560
const GH = 72

/** White's share of the board, 0..100, for one reviewed move. winAfter is
 *  mover-POV (main/review/review.ts), so Black's plies mirror. */
function whiteShare(m: ReviewMoveEval): number {
  return m.color === 'white' ? m.winAfter : 100 - m.winAfter
}

export function ReviewSection({
  review,
  running,
  progress,
  canReview,
  error,
  currentPly,
  onRun,
  onSeek,
  nextMistakePly
}: ReviewSectionProps): JSX.Element {
  const whiteCounts = useMemo(
    () => countBadges(review?.moveEvals ?? [], 'white'),
    [review?.moveEvals]
  )
  const blackCounts = useMemo(
    () => countBadges(review?.moveEvals ?? [], 'black'),
    [review?.moveEvals]
  )

  // Every class keeps its row so Blunder is always in the same place; Forced is
  // appended only when it actually happened.
  const rows: ReviewBadge[] = useMemo(() => {
    const base = [...BADGE_TABLE_ORDER]
    if ((whiteCounts.get('Forced') ?? 0) + (blackCounts.get('Forced') ?? 0) > 0) base.push('Forced')
    return base
  }, [whiteCounts, blackCounts])

  const moves = review ? Math.ceil(review.totalPlies / 2) : 0

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Game review</h2>
        {review && (
          <span className="sec-count">
            {moves} moves · depth {review.depth}
          </span>
        )}
      </div>

      <div className="panel">
        {running && (
          <>
            <div className="an-readout" role="status">
              analyzing <b>{Math.round(progress * 100)}</b>%
            </div>
            <div
              className="an-depthbar"
              style={{ '--an-w': `${Math.round(progress * 100)}%` } as CSSProperties}
            />
          </>
        )}

        {!review && !running && (
          <div className="empty">
            <p className="empty-line">
              Analyze every move with the engine: accuracy, classifications, and an estimated
              playing strength for the game.
            </p>
            {!canReview && <p className="empty-line">Play through some moves first.</p>}
            {error && (
              <p className="empty-line" role="alert">
                {error}
              </p>
            )}
          </div>
        )}

        {review && !running && (
          <>
            <div className="an-rv">
              <span className="lbl an-rv-side an-rv-head">White</span>
              <span className="lbl an-rv-mid an-rv-head">&nbsp;</span>
              <span className="lbl an-rv-side an-rv-head">Black</span>

              <span className="an-rv-side an-acc">{review.white.accuracy.toFixed(1)}</span>
              <span className="an-rv-mid">Accuracy</span>
              <span className="an-rv-side an-acc">{review.black.accuracy.toFixed(1)}</span>

              <EloSide band={review.whiteElo} />
              <span className="an-rv-mid">Est. performance</span>
              <EloSide band={review.blackElo} />

              <span className="an-rv-side">{review.white.acpl}</span>
              <span className="an-rv-mid">Avg. centipawn loss</span>
              <span className="an-rv-side">{review.black.acpl}</span>

              {rows.map((badge) => {
                const meta = badgeMeta(badge)
                const w = whiteCounts.get(badge) ?? 0
                const b = blackCounts.get(badge) ?? 0
                return (
                  <Fragment key={badge}>
                    <span className={`an-rv-side${w === 0 ? ' an-rv-zero' : ''}`}>{w}</span>
                    <span className="an-rv-mid">
                      <span className={`an-mk ${markClass(badge)}`} aria-hidden>
                        {meta.glyph}
                      </span>
                      {meta.label}
                    </span>
                    <span className={`an-rv-side${b === 0 ? ' an-rv-zero' : ''}`}>{b}</span>
                  </Fragment>
                )
              })}
            </div>

            <EvalGraph moveEvals={review.moveEvals} currentPly={currentPly} onSeek={onSeek} />

            <div className="panel-foot">
              <div className="an-foot-pair">
                <button
                  className="btn is-primary"
                  type="button"
                  disabled={nextMistakePly === null}
                  onClick={() => nextMistakePly !== null && onSeek(nextMistakePly)}
                >
                  Go to the next mistake
                  <svg className="icon" aria-hidden focusable="false">
                    <use href="#i-arrow" />
                  </svg>
                </button>
                <button className="btn is-quiet" type="button" disabled={!canReview} onClick={onRun}>
                  Re-run review
                </button>
              </div>
              {error && (
                <p className="an-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          </>
        )}

        {!running && canReview && !review && (
          <div className="panel-foot">
            <button className="btn is-primary" type="button" onClick={onRun}>
              Review game
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

function EloSide({ band }: { band: EloBand }): JSX.Element {
  return (
    <span className="an-rv-side">
      ~{Math.round(band.est)}
      <span className="an-est">
        {Math.round(band.low)}–{Math.round(band.high)}
      </span>
    </span>
  )
}

/**
 * The eval bar beside the board, unrolled along the game: White's share of the
 * height at every move. Clicking a column takes the board there, which is the
 * one thing a picture of the game cannot do.
 */
function EvalGraph({
  moveEvals,
  currentPly,
  onSeek
}: {
  moveEvals: ReviewMoveEval[]
  currentPly: number
  onSeek: (ply: number) => void
}): JSX.Element | null {
  const n = moveEvals.length
  const geometry = useMemo(() => {
    if (n === 0) return null
    const step = n > 1 ? GW / (n - 1) : 0
    const pts = moveEvals.map((m, i) => ({
      x: n > 1 ? i * step : 0,
      y: GH * (1 - whiteShare(m) / 100),
      ply: m.ply
    }))
    const fill =
      `M0,${GH} ` +
      pts.map((p) => `L${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ') +
      ` L${GW},${GH} Z`
    return { pts, fill, step: step || GW }
  }, [moveEvals, n])

  if (!geometry) return null
  const cursor = geometry.pts.find((p) => p.ply === currentPly)
  const lastMove = Math.ceil(moveEvals[n - 1].ply / 2)

  return (
    <div className="an-graph">
      <svg
        className="an-graph-svg"
        viewBox={`0 0 ${GW} ${GH}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Evaluation across the game, as White's share of the bar."
      >
        <path className="an-graph-fill" d={geometry.fill} />
        <line className="an-graph-mid" x1={0} y1={GH / 2} x2={GW} y2={GH / 2} />
        {cursor && (
          <line className="an-graph-cursor" x1={cursor.x} y1={0} x2={cursor.x} y2={GH} />
        )}
        {geometry.pts.map((p) => (
          <rect
            className="an-graph-hit"
            key={p.ply}
            x={p.x - geometry.step / 2}
            y={0}
            width={geometry.step}
            height={GH}
            onClick={() => onSeek(p.ply)}
          />
        ))}
      </svg>
      <div className="an-graph-foot">
        <span className="lbl">Move 1</span>
        <span className="lbl">Move {lastMove}</span>
      </div>
    </div>
  )
}
