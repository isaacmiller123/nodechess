import { useCallback, useRef, type CSSProperties, type PointerEvent } from 'react'

/* The quorum mark. A lattice of nodes whose density describes a rook: the field
   thins to dust at the rim, thickens through the body, and the three crown
   nodes sit above it. Geometry is copied verbatim from the approved sheet at
   design-lab/v1/brand.html and is never recomputed here.

   Two forms ship. The lattice is the mark. The rook is the favicon derivative,
   the same object with the field, the links and the dust removed, and it is
   what survives 16px in a dock, a taskbar or a browser tab. Keep the rook in
   sync with the copy inlined in scripts/make-icon.cjs, which renders the
   shipped app icon.

   Motion is ported from design-lab/v1/brand.css: the wave crosses on hover, the
   ripple leaves the pointer. Both are transforms laid over the untouched
   drawing, and both stop dead under prefers-reduced-motion. */

const EDGES: readonly (readonly number[])[] = [
  [27.2, 36.82, 39.8, 36.82, 1.5],
  [27.2, 36.82, 33.5, 47.74, 1.5],
  [39.8, 36.82, 52.4, 36.82, 1.5],
  [39.8, 36.82, 33.5, 47.74, 1.5],
  [39.8, 36.82, 46.1, 47.74, 1.5],
  [52.4, 36.82, 65, 36.82, 1.5],
  [52.4, 36.82, 46.1, 47.74, 1.5],
  [52.4, 36.82, 58.7, 47.74, 1.5],
  [65, 36.82, 58.7, 47.74, 1.5],
  [33.5, 47.74, 46.1, 47.74, 1.5],
  [33.5, 47.74, 39.8, 58.65, 1.5],
  [46.1, 47.74, 58.7, 47.74, 1.5],
  [46.1, 47.74, 39.8, 58.65, 1.5],
  [46.1, 47.74, 52.4, 58.65, 1.5],
  [58.7, 47.74, 52.4, 58.65, 1.5],
  [58.7, 47.74, 65, 58.65, 1.5],
  [39.8, 58.65, 52.4, 58.65, 1.5],
  [39.8, 58.65, 33.5, 69.56, 1.5],
  [39.8, 58.65, 46.1, 69.56, 1.5],
  [52.4, 58.65, 65, 58.65, 1.5],
  [52.4, 58.65, 46.1, 69.56, 1.5],
  [52.4, 58.65, 58.7, 69.56, 1.5],
  [65, 58.65, 58.7, 69.56, 1.5],
  [65, 58.65, 71.3, 69.56, 1.5],
  [33.5, 69.56, 46.1, 69.56, 1.5],
  [33.5, 69.56, 27.2, 80.47, 1.5],
  [33.5, 69.56, 39.8, 80.47, 1.5],
  [46.1, 69.56, 58.7, 69.56, 1.5],
  [46.1, 69.56, 39.8, 80.47, 1.5],
  [46.1, 69.56, 52.4, 80.47, 1.5],
  [58.7, 69.56, 71.3, 69.56, 1.5],
  [58.7, 69.56, 52.4, 80.47, 1.5],
  [58.7, 69.56, 65, 80.47, 1.5],
  [71.3, 69.56, 65, 80.47, 1.5],
  [71.3, 69.56, 77.6, 80.47, 1.5],
  [27.2, 80.47, 39.8, 80.47, 1.5],
  [39.8, 80.47, 52.4, 80.47, 1.5],
  [52.4, 80.47, 65, 80.47, 1.5],
  [65, 80.47, 77.6, 80.47, 1.5],
  [39.8, 36.82, 33.5, 25.91, 0.75],
  [39.8, 36.82, 46.1, 25.91, 0.75],
  [65, 36.82, 58.7, 25.91, 0.75],
  [65, 36.82, 71.3, 25.91, 0.75],
  [65, 36.82, 77.6, 36.82, 0.75],
  [65, 36.82, 71.3, 47.74, 0.75],
  [39.8, 58.65, 27.2, 58.65, 0.75],
  [65, 58.65, 71.3, 47.74, 0.75],
  [32.5, 21.5, 27.2, 36.82, 1.5],
  [50, 21.5, 52.4, 36.82, 1.5],
  [67.5, 21.5, 65, 36.82, 1.5]
]

const NODES: readonly (readonly number[])[] = [
  [2, 15, 0.7],
  [14.6, 15, 1.15],
  [27.2, 15, 1.15],
  [39.8, 15, 1.15],
  [52.4, 15, 1.15],
  [65, 15, 1.15],
  [77.6, 15, 1.15],
  [90.2, 15, 0.7],
  [8.3, 25.91, 1.15],
  [20.9, 25.91, 2.1],
  [33.5, 25.91, 2.1],
  [46.1, 25.91, 2.1],
  [58.7, 25.91, 2.1],
  [71.3, 25.91, 2.1],
  [83.9, 25.91, 1.15],
  [96.5, 25.91, 0.7],
  [2, 36.82, 0.7],
  [14.6, 36.82, 1.15],
  [27.2, 36.82, 4.9],
  [39.8, 36.82, 4.9],
  [52.4, 36.82, 4.9],
  [65, 36.82, 4.9],
  [77.6, 36.82, 2.1],
  [90.2, 36.82, 1.15],
  [8.3, 47.74, 1.15],
  [20.9, 47.74, 1.15],
  [33.5, 47.74, 4.9],
  [46.1, 47.74, 4.9],
  [58.7, 47.74, 4.9],
  [71.3, 47.74, 2.1],
  [83.9, 47.74, 1.15],
  [96.5, 47.74, 0.7],
  [2, 58.65, 0.7],
  [14.6, 58.65, 1.15],
  [27.2, 58.65, 2.1],
  [39.8, 58.65, 4.9],
  [52.4, 58.65, 4.9],
  [65, 58.65, 4.9],
  [77.6, 58.65, 1.15],
  [90.2, 58.65, 1.15],
  [8.3, 69.56, 1.15],
  [20.9, 69.56, 2.1],
  [33.5, 69.56, 4.9],
  [46.1, 69.56, 4.9],
  [58.7, 69.56, 4.9],
  [71.3, 69.56, 4.9],
  [83.9, 69.56, 1.15],
  [96.5, 69.56, 1.15],
  [2, 80.47, 1.15],
  [14.6, 80.47, 2.1],
  [27.2, 80.47, 4.9],
  [39.8, 80.47, 4.9],
  [52.4, 80.47, 4.9],
  [65, 80.47, 4.9],
  [77.6, 80.47, 4.9],
  [90.2, 80.47, 2.1],
  [8.3, 91.38, 1.15],
  [20.9, 91.38, 2.1],
  [33.5, 91.38, 2.1],
  [46.1, 91.38, 2.1],
  [58.7, 91.38, 2.1],
  [71.3, 91.38, 2.1],
  [83.9, 91.38, 2.1],
  [96.5, 91.38, 1.15],
  [32.5, 21.5, 6.3],
  [50, 21.5, 6.3],
  [67.5, 21.5, 6.3]
]

const ROOK_CIRCLES: readonly (readonly number[])[] = [
  [4.4, 2.4, 1.35],
  [8, 2.4, 1.35],
  [11.6, 2.4, 1.35]
]

const ROOK_PATH = 'M3.4 5 H12.6 V6.6 L10.6 7.6 V11 L13 13 V15.6 H3 V13 L5.4 11 V7.6 L3.4 6.6 Z'

/* The drawing is 100 x 100 user units, so a lift stated in px is a lift in
   those units once transform-box puts the element in the viewBox. All five
   constants below are the sheet's, unchanged. */
const VIEW = 100 /* the lattice is drawn in a 100 x 100 box */
const WAVE_SWEEP = 0.8 /* seconds for the crest to cross the mark */
const RIPPLE_REACH = 62 /* user units the ripple carries before it dies */
const RIPPLE_LAG = 0.78 /* seconds the far edge trails the origin */
const RIPPLE_AMP = 2.2 /* user units of lift at the origin */
const RIPPLE_PERIOD = 0.9 /* matches --nc-ripple-period in app.css */
const SETTLE = 460 /* matches the --nc-ripple-gain transition */

/** 'lattice' is the mark. 'rook' is the reduced form for small sizes. */
export type LogoVariant = 'lattice' | 'rook'
/** Motion the mark is allowed to make. The rook form never moves: with the
 *  field and the links gone there is no surface left to flex. */
export type LogoMotion = 'none' | 'wave' | 'ripple' | 'both'

/** Below this the lattice stops resolving and the reduced rook reads better. */
const LATTICE_FLOOR = 24

/* An edge answers for its midpoint, which keeps it welded to the two nodes it
   joins while the surface flexes. A node sits at its centre. */
const edgeMid = (e: readonly number[]): [number, number] => [(e[0] + e[2]) / 2, (e[1] + e[3]) / 2]

export function Logo({
  size = 28,
  title = 'nodechess',
  variant,
  motion = 'none'
}: {
  size?: number
  title?: string
  /** Defaults to the lattice above 24px and the reduced rook at or below it. */
  variant?: LogoVariant
  motion?: LogoMotion
}) {
  const form: LogoVariant = variant ?? (size > LATTICE_FLOOR ? 'lattice' : 'rook')
  const svgRef = useRef<SVGSVGElement | null>(null)
  const frame = useRef(0)
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const live = form === 'lattice' && motion !== 'none'
  const wants = (m: LogoMotion) => live && (motion === m || motion === 'both')

  /* The ripple origin is wherever the pointer is, not the centre and not the
     edge. Each part's lift and delay are rewritten from its distance to that
     point, so the crest leaves the cursor, arrives later the further out it
     goes, and dies as it travels. */
  const onPointerMove = useCallback((ev: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const box = svg.getBoundingClientRect()
    if (!box.width || !box.height) return
    const ox = ((ev.clientX - box.left) / box.width) * VIEW
    const oy = ((ev.clientY - box.top) / box.height) * VIEW
    if (frame.current) return
    frame.current = window.requestAnimationFrame(() => {
      frame.current = 0
      const parts = svg.querySelectorAll<SVGElement>('.nc-e, .nc-n')
      parts.forEach((el) => {
        const px = Number(el.dataset.cx)
        const py = Number(el.dataset.cy)
        const dx = px - ox
        const dy = py - oy
        const reach = Math.min(Math.sqrt(dx * dx + dy * dy) / RIPPLE_REACH, 1)
        const fall = 1 - reach
        el.style.setProperty('--nc-ripple-fall', fall.toFixed(3))
        el.style.setProperty('--nc-ripple-amp', `${(fall * RIPPLE_AMP).toFixed(3)}px`)
        el.style.setProperty(
          '--nc-ripple-delay',
          `${(reach * RIPPLE_LAG - RIPPLE_PERIOD).toFixed(3)}s`
        )
      })
    })
  }, [])

  const onPointerEnter = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    clearTimeout(settle.current)
    svg.classList.remove('nc-is-settling')
    svg.classList.add('nc-is-live')
  }, [])

  /* nc-is-settling keeps the cycle alive for one fade after the pointer leaves,
     so the water goes flat instead of being switched off. */
  const onPointerLeave = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    svg.classList.remove('nc-is-live')
    svg.classList.add('nc-is-settling')
    settle.current = setTimeout(() => svg.classList.remove('nc-is-settling'), SETTLE)
  }, [])

  const cls = [
    'nc-mark',
    wants('wave') ? 'nc-mark--wave' : '',
    wants('ripple') ? 'nc-mark--ripple' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const common = {
    ref: svgRef,
    className: cls,
    width: size,
    height: size,
    role: 'img' as const,
    'aria-label': title,
    fill: 'currentColor',
    xmlns: 'http://www.w3.org/2000/svg',
    style: { '--nc-mark-size': `${size}px` } as CSSProperties
  }

  if (form === 'rook') {
    return (
      <svg {...common} viewBox="0 0 16 16">
        <title>{title}</title>
        {ROOK_CIRCLES.map(([cx, cy, r]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
        ))}
        <path d={ROOK_PATH} />
      </svg>
    )
  }

  return (
    <svg
      {...common}
      viewBox="0 0 100 100"
      onPointerMove={wants('ripple') ? onPointerMove : undefined}
      onPointerEnter={wants('ripple') ? onPointerEnter : undefined}
      onPointerLeave={wants('ripple') ? onPointerLeave : undefined}
    >
      <title>{title}</title>
      {/* Links first: the nodes below cover their ends, so there are no joins
          to tune. --nc-wave-delay is derived once from the part's own x, and it
          is the only thing that differs between a hundred identical cycles. */}
      {EDGES.map((e, i) => {
        const [mx, my] = edgeMid(e)
        return (
          <line
            key={`e${i}`}
            className="nc-e"
            x1={e[0]}
            y1={e[1]}
            x2={e[2]}
            y2={e[3]}
            stroke="currentColor"
            strokeWidth={e[4]}
            data-cx={mx}
            data-cy={my}
            style={{ '--nc-wave-delay': `${((mx / VIEW) * WAVE_SWEEP).toFixed(3)}s` } as CSSProperties}
          />
        )
      })}
      {NODES.map(([cx, cy, r], i) => (
        <circle
          key={`n${i}`}
          className="nc-n"
          cx={cx}
          cy={cy}
          r={r}
          data-cx={cx}
          data-cy={cy}
          style={{ '--nc-wave-delay': `${((cx / VIEW) * WAVE_SWEEP).toFixed(3)}s` } as CSSProperties}
        />
      ))}
    </svg>
  )
}

export default Logo
