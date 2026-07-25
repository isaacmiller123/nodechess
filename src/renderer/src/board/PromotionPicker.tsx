import type { Role } from 'chessops/types'
import type { Color } from '../chess/chess'
import { PieceIcon } from './PieceIcon'

/** Promotion choices, strongest first (chess.com/lichess order). */
const ROLES = ['queen', 'rook', 'bishop', 'knight'] as const

/**
 * Modal promotion chooser over the board. Click a piece to promote (buttons
 * are natively keyboard-operable: Tab + Enter/Space); clicking the dimmed
 * overlay cancels. Choices render the real artwork of the active piece set
 * via PieceIcon: no unicode glyphs.
 */
export function PromotionPicker({
  color,
  onSelect,
  onCancel
}: {
  color: Color
  onSelect: (role: Role) => void
  onCancel: () => void
}) {
  return (
    <div className="promo-overlay" onClick={onCancel}>
      <div className="promo-card" onClick={(e) => e.stopPropagation()}>
        {ROLES.map((r) => (
          <button key={r} className="promo-choice" onClick={() => onSelect(r)} aria-label={`Promote to ${r}`}>
            <PieceIcon role={r} color={color} size={44} />
          </button>
        ))}
      </div>
    </div>
  )
}
