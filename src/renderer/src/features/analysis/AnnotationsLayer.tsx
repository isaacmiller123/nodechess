import { useEffect, useRef, useState, type JSX } from 'react'
import type { Key } from 'chessground/types'
import type { Color } from '../../chess/chess'
import {
  BRUSH_VAR,
  keyAtBoardPos,
  squareCenter,
  type Annotation,
  type AnnotationStore,
  type BrushColor
} from './annotations'

export interface AnnotationsLayerProps {
  /** The .board-wrap element to attach right-click drawing to. */
  boardEl: HTMLElement | null
  orientation: Color
  store: AnnotationStore
}

/** Modifier keys pick the brush, matching chessground's right-click palette. */
function brushFor(e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): BrushColor {
  if (e.shiftKey || e.ctrlKey) return 'red'
  if (e.altKey) return 'blue'
  if (e.metaKey) return 'yellow'
  return 'green'
}

/**
 * Renders persisted user annotations (arrows + circles) on top of the board and
 * captures right-button drags to create them. Board.tsx is frozen and exposes
 * no drawable hooks, so we own the interaction here. Left-clicks pass straight
 * through to chessground (the SVG itself is pointer-events:none; we listen on
 * the board element for the right button only).
 */
export function AnnotationsLayer({ boardEl, orientation, store }: AnnotationsLayerProps): JSX.Element {
  // Live drag preview (orig set on mousedown, dest tracks the pointer).
  const [drag, setDrag] = useState<{ orig: Key; dest?: Key; brush: BrushColor } | null>(null)
  // Keep latest values available to imperative listeners without rebinding.
  const ref = useRef({ orientation, store, drag })
  ref.current = { orientation, store, drag }

  useEffect(() => {
    const el = boardEl
    if (!el) return

    const keyAt = (e: MouseEvent): Key | null => {
      const rect = el.getBoundingClientRect()
      return keyAtBoardPos(
        e.clientX - rect.left,
        e.clientY - rect.top,
        rect.width,
        ref.current.orientation
      )
    }

    let dragging = false

    // A "draw" gesture mirrors chessground: right button, or shift/ctrl + click.
    const isDrawGesture = (e: MouseEvent): boolean =>
      e.button === 2 || ((e.button === 0 || e.button === 2) && (e.shiftKey || e.ctrlKey))

    const onMouseDown = (e: MouseEvent) => {
      if (!isDrawGesture(e)) {
        // Plain left-click clears this node's drawings (lichess behaviour). The
        // event is NOT swallowed, so chessground still selects / moves the piece.
        if (e.button === 0 && ref.current.store.current.length > 0) ref.current.store.clear()
        return
      }
      const orig = keyAt(e)
      if (!orig) return
      // Capture-phase + stopPropagation so chessground's own (ephemeral) drawing
      // never starts. We own annotations and persist them per node.
      e.preventDefault()
      e.stopPropagation()
      dragging = true
      setDrag({ orig, brush: brushFor(e) })
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return
      const d = ref.current.drag
      if (!d) return
      const over = keyAt(e)
      const dest = over && over !== d.orig ? over : undefined
      if (dest !== d.dest) setDrag({ ...d, dest })
    }

    const finish = (e: MouseEvent) => {
      if (!dragging) return
      dragging = false
      const d = ref.current.drag
      setDrag(null)
      if (!d) return
      const over = keyAt(e)
      const dest = over && over !== d.orig ? over : undefined
      ref.current.store.toggle({ orig: d.orig, dest, brush: d.brush })
    }

    // Swallow the native context menu over the board (it would interrupt drags).
    const onContextMenu = (e: MouseEvent) => e.preventDefault()

    el.addEventListener('mousedown', onMouseDown, { capture: true })
    el.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', finish)
    return () => {
      el.removeEventListener('mousedown', onMouseDown, { capture: true })
      el.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', finish)
    }
  }, [boardEl])

  const shapes: Annotation[] = drag
    ? [...store.current.filter((s) => !(s.orig === drag.orig && s.dest === drag.dest)), drag]
    : store.current

  return (
    <svg className="annot-overlay" viewBox="0 0 8 8" preserveAspectRatio="none" aria-hidden>
      <defs>
        {(['green', 'red', 'blue', 'yellow'] as BrushColor[]).map((b) => (
          <marker
            key={b}
            id={`annot-head-${b}`}
            orient="auto"
            overflow="visible"
            markerWidth={4}
            markerHeight={4}
            refX={2.05}
            refY={2}
          >
            <path d="M0,0 V4 L3,2 Z" fill={BRUSH_VAR[b]} />
          </marker>
        ))}
      </defs>
      {shapes.map((s, i) => (
        <Shape key={`${s.orig}${s.dest ?? ''}${i}`} shape={s} orientation={orientation} />
      ))}
    </svg>
  )
}

function Shape({ shape, orientation }: { shape: Annotation; orientation: Color }): JSX.Element | null {
  const a = squareCenter(shape.orig, orientation)
  if (!a) return null
  const color = BRUSH_VAR[shape.brush]

  if (!shape.dest) {
    return (
      <circle
        cx={a.cx}
        cy={a.cy}
        r={0.46}
        fill="none"
        stroke={color}
        strokeWidth={0.1}
        opacity={0.9}
      />
    )
  }

  const b = squareCenter(shape.dest, orientation)
  if (!b) return null
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  // Pull both ends inward so the arrow sits neatly inside its squares.
  const x1 = a.cx + ux * 0.2
  const y1 = a.cy + uy * 0.2
  const x2 = b.cx - ux * 0.32
  const y2 = b.cy - uy * 0.32
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={color}
      strokeWidth={0.16}
      strokeLinecap="round"
      opacity={0.9}
      markerEnd={`url(#annot-head-${shape.brush})`}
    />
  )
}
