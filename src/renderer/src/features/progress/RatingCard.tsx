import type { JSX } from 'react'
import { Puzzle, Swords, type LucideIcon } from 'lucide-react'
import type { ProgressSummary, RatingValue } from '../../../../shared/types'
import { ratingBand } from './format'

export interface RatingCardProps {
  puzzle: RatingValue | null
  vsBot: RatingValue | null
  /** Fallback figures from the progress summary if a ratings channel failed. */
  fallback: ProgressSummary | null
}

// rd above this is treated as a provisional (low-confidence) rating.
const PROVISIONAL_RD = 110
// Used to scale the confidence bar fill.
const MAX_RD = 350

interface ResolvedRating {
  rating: number
  rd: number
}

function resolve(
  primary: RatingValue | null,
  fbRating: number | undefined,
  fbRd: number | undefined
): ResolvedRating | null {
  if (primary && Number.isFinite(primary.rating)) {
    return { rating: primary.rating, rd: Number.isFinite(primary.rd) ? primary.rd : 0 }
  }
  if (fbRating != null && Number.isFinite(fbRating)) {
    return { rating: fbRating, rd: fbRd != null && Number.isFinite(fbRd) ? fbRd : 0 }
  }
  return null
}

function RatingRow({
  label,
  Icon,
  value
}: {
  label: string
  Icon: LucideIcon
  value: ResolvedRating | null
}): JSX.Element {
  if (!value) {
    return (
      <div className="rating-row">
        <div className="rating-head">
          <Icon size={16} aria-hidden />
          <span className="rating-label">{label}</span>
        </div>
        <div className="rating-figures">
          <span className="rating-num muted">·</span>
          <span className="rating-band muted small">Not rated yet</span>
        </div>
        <div className="rd-bar" role="presentation">
          <span className="rd-fill" style={{ width: '4%' }} />
        </div>
      </div>
    )
  }

  const band = ratingBand(value.rating, value.rd)
  const provisional = value.rd >= PROVISIONAL_RD || value.rd <= 0
  const confidence = Math.max(0.04, Math.min(1, 1 - value.rd / MAX_RD))

  return (
    <div className="rating-row">
      <div className="rating-head">
        <Icon size={16} aria-hidden />
        <span className="rating-label">{label}</span>
      </div>
      <div className="rating-figures">
        <span className="rating-num">{band.center}</span>
        <span className="rating-band small">
          {band.pm > 0 ? `± ${band.pm}` : 'stable'}
          {provisional && <span className="muted rating-prov"> · provisional</span>}
        </span>
      </div>
      <div className="rd-bar" role="presentation" title={`Likely range ${band.lo}–${band.hi}`}>
        <span className="rd-fill" style={{ width: `${Math.round(confidence * 100)}%` }} />
      </div>
      <div className="rating-range small muted">
        Likely {band.lo}–{band.hi}
      </div>
    </div>
  )
}

export default function RatingCard({ puzzle, vsBot, fallback }: RatingCardProps): JSX.Element {
  const puzzleVal = resolve(puzzle, fallback?.puzzleRating, fallback?.puzzleRd)
  const vsBotVal = resolve(vsBot, fallback?.vsBotRating, fallback?.vsBotRd)

  return (
    <section className="card progress-card rating-card">
      <h3 className="card-title">Ratings</h3>
      <div className="rating-rows">
        <RatingRow label="Puzzles" Icon={Puzzle} value={puzzleVal} />
        <RatingRow label="Games (vs bots)" Icon={Swords} value={vsBotVal} />
      </div>
    </section>
  )
}
