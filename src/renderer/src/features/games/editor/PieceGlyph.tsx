import { createElement, type CSSProperties, type JSX } from 'react'
import { pieceSetClass } from '../../../board/pieceSets'
import { useSettings } from '../../../state/settings'
import { paletteDef } from './model'

/**
 * Any piece the Variant Lab can show, drawn with the ACTIVE board piece set.
 * Standard letters render the real artwork; fairy pieces compose the base
 * artwork with a small "knight-powers" badge (amazon = queen+N, chancellor =
 * rook+N, archbishop = bishop+N); unknown letters (raw-mode customs) fall back
 * to an elegant lettered medallion.
 *
 * Renders the same minimal DOM as board/PieceIcon (a `pieces-<set>` wrapper >
 * `.cg-wrap` > `<piece class="<color> <role>">`, geometry neutralised by
 * piece-icon.css) but sized by the PARENT when `size` is omitted. Painter
 * squares and mini-boards are fluid, so the glyph must fill its box.
 */
export function PieceGlyph({
  letter,
  color,
  size
}: {
  letter: string
  color: 'white' | 'black'
  /** Square edge in px; omit to fill the parent box. */
  size?: number
}): JSX.Element {
  const { settings } = useSettings()
  const def = paletteDef(letter)
  const style: CSSProperties =
    size === undefined ? { width: '100%', height: '100%' } : { width: size, height: size }

  if (!def) {
    return (
      <span className={`vl-medallion is-${color}`} style={style} aria-hidden>
        {letter.toUpperCase()}
      </span>
    )
  }

  const art = (
    <span className={`piece-icon ${pieceSetClass(settings.pieceSet)}`} style={style} aria-hidden>
      <span className="cg-wrap">
        {createElement('piece', { className: `${color} ${def.baseGlyph}` })}
      </span>
    </span>
  )
  if (!def.badge) return art
  return (
    <span className="vl-fairy" style={style} aria-hidden>
      {/* inner art fills the fairy wrapper */}
      <span className={`piece-icon ${pieceSetClass(settings.pieceSet)} vl-fairy-art`}>
        <span className="cg-wrap">
          {createElement('piece', { className: `${color} ${def.baseGlyph}` })}
        </span>
      </span>
      <span className={`vl-fairy-badge is-${color}`}>{def.badge}</span>
    </span>
  )
}
