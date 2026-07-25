// Maps Viktor's BoardAnnotation cues (from the chapter JSON / viktor.ts) onto
// chessground DrawShapes, which Board renders as autoShapes (never erased by
// user clicks).
//
// Visual language (School boards only):
//   arrow  good  -> solid green arrow, thick        (the move to play)
//          bad   -> pale red arrow, reduced opacity (the move NOT to play)
//          info  -> pale blue arrow                 (a reference line)
//          focus -> amber arrow                     (look at this)
//   circle       -> a soft ring drawn per-square via customSvg; focus rings are
//                   thicker with a faint halo so "look HERE" pops.
//   highlight    -> a rounded translucent square fill (not a circle) so the
//                   played from/to squares read as marked squares, not targets.
//
// WHY two mechanisms:
//   * Arrows use the SCHOOL_BRUSHES registered via Board's `brushes` prop
//     (same hex colors as the app's --brush-* tokens, with per-color opacity)
//     plus per-shape `modifiers.lineWidth` for weight. EVERY School board that
//     can render these shapes MUST pass `brushes={SCHOOL_BRUSHES}`. Chessground
//     crashes its SVG defs sync on unregistered brush keys.
//   * Circles / highlights / hint glows use DrawShape.customSvg: chessground
//     renders that HTML in a 100x100 box covering exactly the target square
//     (`.cg-custom-svgs`, overflow visible, scales with the board), which gives
//     us stroke widths, fills and CSS-animatable classes the stock circle
//     renderer (fixed stroke, no lineWidth) cannot do.
//
// CAVEAT (renderer contract): Board.tsx's shapesKey() only hashes
// orig/dest/brush, and customSvg shapes carry no brush. Two shape lists that
// differ only in customSvg content hash identically. Every School render site
// therefore passes a syncNonce that bumps when the line/step/hint changes.
import type { Key } from 'chessground/types'
import type { DrawBrush, DrawShape } from 'chessground/draw'
import type { AnnotationColor, BoardAnnotation } from '@shared/types'

// ---------------------------------------------------------------------------
// Palette. SVG presentation attributes cannot resolve var(--...), so these are
// literal hex values of the SAME colors as the app's board-annotation tokens
// (tokens.css --brush-green/red/blue/yellow), keeping School shapes identical
// to user-drawn arrows everywhere else in the app.
// ---------------------------------------------------------------------------
const HEX: Record<AnnotationColor, string> = {
  good: '#15781b', // --brush-green
  bad: '#882020', // --brush-red
  info: '#003088', // --brush-blue
  focus: '#e68f00' // --brush-yellow
}

/** School brush key per annotation color (arrows). These are the SCHOOL_BRUSHES
 *  keys (registered on School boards via Board's `brushes` prop), giving
 *  per-color opacity: 0.85 good / 0.55 bad / 0.5 info / 0.85 focus. */
const ARROW_BRUSH: Record<AnnotationColor, string> = {
  good: 'schoolGood', // solid. The one arrow that must dominate
  bad: 'schoolBad', // reduced opacity: "you went here: don't"
  info: 'schoolInfo',
  focus: 'schoolFocus'
}

/** Arrow weight per color (chessground lineWidth, 64ths of a square; stock 10).
 *  The good/best arrow is the thickest so the eye lands on it first. */
const ARROW_WIDTH: Record<AnnotationColor, number> = {
  good: 12,
  bad: 11,
  info: 9,
  focus: 11
}

/** Brush key for an annotation color (defaults to the neutral info brush).
 *  Kept for back-compat with existing callers. */
export function brushFor(color: AnnotationColor | undefined): string {
  return ARROW_BRUSH[color ?? 'info']
}

// ---------------------------------------------------------------------------
// customSvg builders, 0..100 box covering the target square. Elements carry
// classes so school-play.css can theme/animate them with design tokens (CSS
// properties override presentation attributes); the attrs are the fallback.
// ---------------------------------------------------------------------------

function ringSvg(color: AnnotationColor): string {
  const hex = HEX[color]
  if (color === 'focus') {
    // Amber focus ring: thicker stroke + a faint halo behind it.
    return (
      `<circle class="school-ann-halo is-${color}" cx="50" cy="50" r="43" fill="none" stroke="${hex}" stroke-width="15" opacity="0.16"/>` +
      `<circle class="school-ann-ring is-${color}" cx="50" cy="50" r="43" fill="none" stroke="${hex}" stroke-width="8" opacity="0.92" stroke-linecap="round"/>`
    )
  }
  return `<circle class="school-ann-ring is-${color}" cx="50" cy="50" r="43" fill="none" stroke="${hex}" stroke-width="6.5" opacity="0.85"/>`
}

function highlightSvg(color: AnnotationColor): string {
  const hex = HEX[color]
  return (
    `<rect class="school-ann-fill is-${color}" x="5" y="5" width="90" height="90" rx="16" ` +
    `fill="${hex}" fill-opacity="0.15" stroke="${hex}" stroke-opacity="0.8" stroke-width="5"/>`
  )
}

function glowSvg(): string {
  const hex = HEX.focus
  // Concentric discs fake a soft radial glow (no SVG filters; their ids would
  // collide across shapes). school-play.css pulses the group.
  return (
    `<g class="school-hint-glow">` +
    `<circle cx="50" cy="50" r="47" fill="${hex}" fill-opacity="0.14"/>` +
    `<circle cx="50" cy="50" r="38" fill="${hex}" fill-opacity="0.20"/>` +
    `<circle cx="50" cy="50" r="29" fill="${hex}" fill-opacity="0.24"/>` +
    `</g>`
  )
}

// ---------------------------------------------------------------------------
// Public mapping
// ---------------------------------------------------------------------------

/** Convert one BoardAnnotation into a chessground DrawShape, or null if malformed.
 *  NOTE: annotation labels are deliberately NOT passed to chessground. Its
 *  shape labels shrink multi-word text into an unreadable dot. Labels render as
 *  readable HTML pills over the board instead (see annotationLabels below). */
export function annotationToShape(a: BoardAnnotation): DrawShape | null {
  const color: AnnotationColor = a.color ?? 'info'
  if (a.kind === 'arrow') {
    if (!a.from || !a.to) return null
    return {
      orig: a.from as Key,
      dest: a.to as Key,
      brush: ARROW_BRUSH[color],
      modifiers: { lineWidth: ARROW_WIDTH[color] }
    }
  }
  if (!a.square) return null
  return {
    orig: a.square as Key,
    customSvg: { html: a.kind === 'circle' ? ringSvg(color) : highlightSvg(color) }
  }
}

/** Convert a coach line's annotation list into a clean DrawShape array. */
export function annotationsToShapes(annotations?: BoardAnnotation[]): DrawShape[] {
  if (!annotations || annotations.length === 0) return []
  const out: DrawShape[] = []
  for (const a of annotations) {
    const s = annotationToShape(a)
    if (s) out.push(s)
  }
  return out
}

// ---------------------------------------------------------------------------
// Readable HTML labels for annotations. Chessground's own shape labels scale
// text down to fit a small circle: multi-word labels become dust. Instead the
// School renders labels as absolutely-positioned pills over the board
// (BoardFrame's .school-ann-labels overlay): arrows label at their midpoint,
// circles/highlights just above their square.
// ---------------------------------------------------------------------------

export interface AnnotationLabel {
  text: string
  color: AnnotationColor
  /** Center position as a percentage of the board's width/height. */
  leftPct: number
  topPct: number
}

/** Square center in board-percentage space for a given orientation. */
function squareCenter(
  square: string,
  orientation: 'white' | 'black'
): { x: number; y: number } | null {
  if (!/^[a-h][1-8]$/.test(square)) return null
  let f = square.charCodeAt(0) - 97 // a..h -> 0..7
  let r = Number(square[1]) - 1 // 1..8 -> 0..7
  if (orientation === 'black') {
    f = 7 - f
    r = 7 - r
  }
  return { x: ((f + 0.5) / 8) * 100, y: ((7 - r + 0.5) / 8) * 100 }
}

/** Positioned, readable labels for a coach line's annotations. */
export function annotationLabels(
  annotations: BoardAnnotation[] | undefined,
  orientation: 'white' | 'black'
): AnnotationLabel[] {
  if (!annotations || annotations.length === 0) return []
  const out: AnnotationLabel[] = []
  for (const a of annotations) {
    if (!a.label) continue
    const color: AnnotationColor = a.color ?? 'info'
    if (a.kind === 'arrow' && a.from && a.to) {
      const from = squareCenter(a.from, orientation)
      const to = squareCenter(a.to, orientation)
      if (!from || !to) continue
      out.push({
        text: a.label,
        color,
        leftPct: (from.x + to.x) / 2,
        topPct: (from.y + to.y) / 2
      })
    } else if (a.square) {
      const c = squareCenter(a.square, orientation)
      if (!c) continue
      // Sit the pill just above the square so it doesn't cover the ring/piece.
      out.push({ text: a.label, color, leftPct: c.x, topPct: Math.max(3, c.y - 9) })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Hint ladder shapes (School puzzles + guided steps).
//   stage 1: the piece to move glows (pulsing amber halo)
//   stage 2: + the from-square is circled
//   stage 3: the full move arrow (glow retained so the piece stays anchored)
// ---------------------------------------------------------------------------

export type SchoolHintStage = 0 | 1 | 2 | 3

/** Shapes for one hint stage against the expected UCI move. Renders nothing at
 *  stage 0 or for a malformed move. Remember to bump the board's syncNonce when
 *  the stage changes. See the shapesKey caveat above. */
export function hintShapes(expectedUci: string, stage: SchoolHintStage): DrawShape[] {
  if (!expectedUci || expectedUci.length < 4 || stage <= 0) return []
  const from = expectedUci.slice(0, 2) as Key
  const to = expectedUci.slice(2, 4) as Key
  const glow: DrawShape = { orig: from, customSvg: { html: glowSvg() } }
  if (stage === 1) return [glow]
  if (stage === 2) return [glow, { orig: from, customSvg: { html: ringSvg('focus') } }]
  return [
    glow,
    {
      orig: from,
      dest: to,
      brush: ARROW_BRUSH.focus,
      modifiers: { lineWidth: ARROW_WIDTH.focus }
    }
  ]
}

// ---------------------------------------------------------------------------
// School arrow brushes: registered by every School board via Board's
// `brushes` prop (chessground deep-merges them over its defaults, so stock
// keys survive). ARROW_BRUSH above references these keys: a School board that
// renders annotation/hint shapes WITHOUT registering SCHOOL_BRUSHES will crash
// chessground's defs sync on the unknown key. Keep the two in lockstep.
// ---------------------------------------------------------------------------
export const SCHOOL_BRUSHES: Record<string, DrawBrush> = {
  schoolGood: { key: 'sg', color: HEX.good, opacity: 0.9, lineWidth: 12 },
  schoolBad: { key: 'sb', color: HEX.bad, opacity: 0.65, lineWidth: 11 },
  // Info arrows were washing out to grey at 0.5. Keep them clearly BLUE.
  schoolInfo: { key: 'si', color: '#2b6fc9', opacity: 0.8, lineWidth: 9 },
  schoolFocus: { key: 'sf', color: HEX.focus, opacity: 0.9, lineWidth: 11 }
}
