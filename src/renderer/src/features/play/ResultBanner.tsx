import { Trophy, Flag, Handshake, Search, Repeat, RotateCcw } from 'lucide-react'
import type { GameResult } from '../../chess/chess'

export interface ResultBannerProps {
  result: GameResult
  reason: string
  outcomeForUser: 'win' | 'loss' | 'draw'
  /** Overrides the headline (Over-the-board has no "you", e.g. "White wins").
   *  When omitted, the default You won/lost/Draw copy for `outcomeForUser`. */
  title?: string
  /** vs-bot rating change (signed). */
  delta?: number
  newRating?: number
  /** Post-game accuracy %, 0–100 (reserved slot; renders when provided). */
  accuracy?: number
  onNewGame: () => void
  /** Open the just-finished game in the Analysis board (when it was saved). */
  onAnalyze?: () => void
  /** Start another game immediately with the same settings. */
  onRematch?: () => void
}

const OUTCOME: Record<
  ResultBannerProps['outcomeForUser'],
  { title: string; icon: typeof Trophy }
> = {
  win: { title: 'You won', icon: Trophy },
  loss: { title: 'You lost', icon: Flag },
  draw: { title: 'Draw', icon: Handshake }
}

function formatDelta(delta: number): string {
  const rounded = Math.round(delta)
  return rounded > 0 ? `+${rounded}` : `${rounded}`
}

export function ResultBanner({
  result,
  reason,
  outcomeForUser,
  title: titleOverride,
  delta,
  newRating,
  accuracy,
  onNewGame,
  onAnalyze,
  onRematch
}: ResultBannerProps) {
  const { title: defaultTitle, icon: MedalIcon } = OUTCOME[outcomeForUser]
  const title = titleOverride ?? defaultTitle

  return (
    <section
      className={`result-banner is-${outcomeForUser}`}
      role="status"
      aria-label={`Game over: ${title}, ${result} by ${reason}`}
    >
      <span className="banner-medal" aria-hidden>
        <MedalIcon size={20} />
      </span>

      <div className="banner-text">
        <span className="banner-title">{title}</span>
        <span className="banner-reason">
          by {reason} <span className="banner-score num">{result}</span>
        </span>
      </div>

      {(delta !== undefined || accuracy !== undefined) && (
        <div className="banner-stats">
          {delta !== undefined && (
            <div className="banner-stat">
              <span className={`eval-chip ${delta >= 0 ? 'pos' : 'neg'}`}>{formatDelta(delta)}</span>
              <span className="banner-stat-label">
                vs-bot rating{newRating !== undefined ? ` ${Math.round(newRating)}` : ''}
              </span>
            </div>
          )}
          {/* Accuracy teaser slot: fed by a future post-game quick review. */}
          {accuracy !== undefined && (
            <div className="banner-stat">
              <span className="eval-chip banner-accuracy num">{accuracy.toFixed(1)}%</span>
              <span className="banner-stat-label">accuracy</span>
            </div>
          )}
        </div>
      )}

      <div className="banner-actions">
        {onAnalyze && (
          <button className="btn ghost banner-analyze" onClick={onAnalyze}>
            <Search size={14} /> Analyze
          </button>
        )}
        {onRematch && (
          <button className="btn ghost banner-rematch" onClick={onRematch}>
            <Repeat size={14} /> Rematch
          </button>
        )}
        <button className="btn banner-new" onClick={onNewGame}>
          <RotateCcw size={14} /> New game
        </button>
      </div>
    </section>
  )
}
