/**
 * Drawing the code. qrcode-generator (MIT, Kazuhiko Arase) turns the offer text
 * into a module grid; this turns that grid into one SVG path.
 *
 * ONE PATH, NOT N RECTS. A version-7 code is 45x45 modules, so a rect per dark
 * module is about a thousand DOM nodes for something that never animates. The
 * path is a handful of kilobytes of `d` and renders identically.
 *
 * FIXED BLACK ON WHITE, in both themes. Everything else in the app follows the
 * palette; this one surface does not, because a scanner's job is contrast and a
 * dark-theme inverted code is a code some phones will not read. The white quiet
 * zone is part of the symbol, not decoration: without four modules of margin,
 * readers lose the finder patterns against a dark page.
 */

import qrcode from 'qrcode-generator'

/** Quiet zone, in modules. Four is the minimum the QR spec asks for. */
const MARGIN = 4

export interface QrDrawing {
  /** SVG path data covering every dark module. */
  path: string
  /** Width of the symbol in modules, INCLUDING both quiet zones. */
  size: number
}

/**
 * Build the drawing for `text`. Error correction M is the usual screen-to-camera
 * choice: it survives a fingerprint on the glass without inflating the symbol
 * the way H does. Throws only if the text is too long for a version-40 symbol,
 * which our fixed-shape offer never is.
 */
export function qrDrawing(text: string): QrDrawing {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const parts: string[] = []
  for (let row = 0; row < n; row++) {
    let col = 0
    while (col < n) {
      if (!qr.isDark(row, col)) {
        col++
        continue
      }
      // Run-length: one path segment per horizontal run of dark modules.
      let run = 1
      while (col + run < n && qr.isDark(row, col + run)) run++
      parts.push(`M${col + MARGIN} ${row + MARGIN}h${run}v1h-${run}z`)
      col += run
    }
  }
  return { path: parts.join(''), size: n + MARGIN * 2 }
}
