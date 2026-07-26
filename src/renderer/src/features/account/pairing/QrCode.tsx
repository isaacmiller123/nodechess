import { useMemo, type JSX } from 'react'
import { qrDrawing } from './qrSvg'

/**
 * The code itself. Inline SVG, so it is crisp at whatever size the panel gives
 * it and costs one element.
 *
 * Deliberately black on white in both themes: a scanner's whole job is
 * contrast, and an inverted code is one some phone cameras will not read. The
 * white plate IS the quiet zone, not a decoration.
 */
export function QrCode({ text, label }: { text: string; label: string }): JSX.Element {
  const drawing = useMemo(() => qrDrawing(text), [text])
  return (
    <svg
      className="pair-qr"
      viewBox={`0 0 ${drawing.size} ${drawing.size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect x="0" y="0" width={drawing.size} height={drawing.size} fill="#ffffff" />
      <path d={drawing.path} fill="#000000" />
    </svg>
  )
}
