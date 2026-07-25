import type { Color } from '../chess/chess'
import { formatScore, whiteWinPercent, type Score } from '../chess/scores'

// Vertical eval bar: white's win-expectancy fills from white's side. Flips with
// board orientation. Label sits on the leading side. A null score (engine off or
// before the first line) renders a neutral, dimmed half-bar with no number, so
// the UI never shows a confident "+0.00".
export function EvalBar({ score, orientation }: { score: Score | null; orientation: Color }) {
  if (!score) {
    return (
      <div
        className={`eval-bar eval-${orientation} eval-empty`}
        aria-label="Evaluation unavailable"
      >
        <div className="eval-fill-white" style={{ height: '50%' }} />
      </div>
    )
  }
  const whitePct = whiteWinPercent(score)
  const label = formatScore(score)
  const whiteLeads = whitePct >= 50
  return (
    <div className={`eval-bar eval-${orientation}`} aria-label={`Evaluation ${label}`}>
      <div className="eval-fill-white" style={{ height: `${whitePct}%` }} />
      <span className={`eval-label ${whiteLeads ? 'on-white' : 'on-black'} num`}>{label}</span>
    </div>
  )
}
