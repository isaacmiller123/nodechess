import type { JSX } from 'react'
import { Puzzle, Swords, type LucideIcon } from 'lucide-react'
import type { ProgressSummary, RatingValue } from '../../../../shared/types'
import { ratingBand } from './format'

export interface StrengthCardProps {
  puzzle: RatingValue | null
  vsBot: RatingValue | null
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

function StrengthRow({
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
      <div className="strength-row">
        <div className="strength-head">
          <Icon size={16} aria-hidden />
          <span className="strength-label">{label}</span>
        </div>
        <div className="strength-num muted">·</div>
        <div className="strength-band muted small">Not rated yet</div>
      </div>
    )
  }

  const band = ratingBand(value.rating, value.rd)
  const provisional = value.rd >= PROVISIONAL_RD || value.rd <= 0
  const confidence = Math.max(0.04, Math.min(1, 1 - value.rd / MAX_RD))

  return (
    <div className="strength-row">
      <div className="strength-head">
        <Icon size={16} aria-hidden />
        <span className="strength-label">{label}</span>
      </div>
      <div className="strength-num">{Math.round(value.rating)}</div>
      <div className="strength-band small">
        {band.pm > 0 ? `±${band.pm}` : 'stable'}
        {provisional && <span className="muted strength-prov"> provisional</span>}
      </div>
      <div className="rd-bar" role="presentation">
        <span className="rd-fill" style={{ width: `${Math.round(confidence * 100)}%` }} />
      </div>
    </div>
  )
}

export default function StrengthCard({ puzzle, vsBot, fallback }: StrengthCardProps): JSX.Element {
  const puzzleVal = resolve(puzzle, fallback?.puzzleRating, fallback?.puzzleRd)
  const vsBotVal = resolve(vsBot, fallback?.vsBotRating, fallback?.vsBotRd)

  return (
    <section className="card home-card strength-card">
      <h3 className="card-title">Strength</h3>
      <div className="strength-rows">
        <StrengthRow label="Puzzle rating" Icon={Puzzle} value={puzzleVal} />
        <StrengthRow label="Playing strength (vs bots)" Icon={Swords} value={vsBotVal} />
      </div>
    </section>
  )
}
