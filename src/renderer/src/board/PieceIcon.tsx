import { createElement, type CSSProperties } from 'react'
import type { Role } from 'chessops/types'
import type { Color } from '../chess/chess'
import { pieceSetClass } from './pieceSets'
import { useSettings } from '../state/settings'
import './piece-icon.css'

export interface PieceIconProps {
  role: Role
  color: Color
  /** Square edge in px (the artwork fills it edge to edge). */
  size?: number
  /** Extra class(es) on the root, for consumer-side layout. */
  className?: string
}

/**
 * Inline chess piece rendered with the SAME artwork as the board's active
 * piece set, never a unicode glyph.
 *
 * How it works: the bundled sets (styles/pieces.css) deliver artwork through
 * selectors of the shape `.pieces-<set> .cg-wrap piece.<role>.<color>
 * { background-image: … }`, and the default cburnett set ships as chessground's
 * global `.cg-wrap piece.<role>.<color>` rules (chessground.cburnett.css,
 * loaded in main.tsx). This component recreates the minimal DOM both shapes
 * match: a `pieces-<set>` wrapper around a `.cg-wrap` element around a
 * `<piece class="<color> <role>">` child, so EVERY set, including the
 * default, resolves exactly as it does on the board. piece-icon.css then
 * overrides chessground's board geometry (12.5% absolute square) so the
 * artwork fills this icon instead.
 *
 * The active set is read from settings, so icons follow the board when the
 * user switches sets. Decorative by design (aria-hidden): callers carry the
 * accessible text.
 */
export function PieceIcon({ role, color, size = 24, className }: PieceIconProps) {
  const { settings } = useSettings()
  const cls = ['piece-icon', pieceSetClass(settings.pieceSet), className].filter(Boolean).join(' ')
  const style: CSSProperties = { width: size, height: size }
  return (
    <span className={cls} style={style} aria-hidden>
      <span className="cg-wrap">
        {/* chessground's custom <piece> element: created without JSX so the
            app's IntrinsicElements are not widened for one internal node. */}
        {createElement('piece', { className: `${color} ${role}` })}
      </span>
    </span>
  )
}
