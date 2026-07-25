import { useCallback, useRef, useState } from 'react'
import type { Key } from 'chessground/types'
import type { Color } from '../../chess/chess'

// User board annotations (right-click arrows + circles), modelled after
// chessground's drawable but owned by the feature so they can be persisted
// per game-tree node and survive navigation. Board.tsx is frozen and does not
// expose chessground's drawable shapes, so we render + manage them ourselves
// as an overlay (mirrors the existing puzzle HintArrow approach).

/** The four right-click brushes, matching chessground / our --brush-* tokens. */
export type BrushColor = 'green' | 'red' | 'blue' | 'yellow'

export interface Annotation {
  /** Origin square. */
  orig: Key
  /** Destination square. Present for arrows, absent for circles. */
  dest?: Key
  brush: BrushColor
}

/** CSS custom property holding each brush color (see styles/tokens.css). */
export const BRUSH_VAR: Record<BrushColor, string> = {
  green: 'var(--brush-green)',
  red: 'var(--brush-red)',
  blue: 'var(--brush-blue)',
  yellow: 'var(--brush-yellow)'
}

const FILES = 'abcdefgh'

/** True when two annotations describe the same shape (square or arrow). */
function sameShape(a: Annotation, b: Annotation): boolean {
  return a.orig === b.orig && a.dest === b.dest
}

/**
 * Toggle an annotation into a list (chessground semantics): drawing the exact
 * same shape twice removes it; re-drawing with a different brush recolors it.
 */
export function toggleAnnotation(list: Annotation[], next: Annotation): Annotation[] {
  const existing = list.find((s) => sameShape(s, next))
  if (existing) {
    return existing.brush === next.brush
      ? list.filter((s) => !sameShape(s, next)) // identical -> erase
      : list.map((s) => (sameShape(s, next) ? next : s)) // recolor
  }
  return [...list, next]
}

/** Square key -> centre in an 8x8 grid, honouring board orientation. */
export function squareCenter(key: Key, orientation: Color): { cx: number; cy: number } | null {
  const f = FILES.indexOf(key[0])
  const r = Number.parseInt(key[1], 10) - 1
  if (f < 0 || !Number.isFinite(r) || r < 0 || r > 7) return null
  return orientation === 'white'
    ? { cx: f + 0.5, cy: 7.5 - r }
    : { cx: 7.5 - f, cy: r + 0.5 }
}

/**
 * Map a pointer position (relative to the board's top-left, in px) to a square
 * key, honouring orientation. Returns null when outside the board.
 */
export function keyAtBoardPos(
  x: number,
  y: number,
  size: number,
  orientation: Color
): Key | null {
  if (size <= 0 || x < 0 || y < 0 || x >= size || y >= size) return null
  const col = Math.floor((x / size) * 8)
  const row = Math.floor((y / size) * 8)
  if (col < 0 || col > 7 || row < 0 || row > 7) return null
  const file = orientation === 'white' ? col : 7 - col
  const rank = orientation === 'white' ? 7 - row : row
  return `${FILES[file]}${rank + 1}` as Key
}

export interface AnnotationStore {
  /** Annotations for the currently-selected node. */
  current: Annotation[]
  /** Replace the current node's annotations. */
  set: (next: Annotation[]) => void
  /** Toggle a single shape on the current node. */
  toggle: (shape: Annotation) => void
  /** Remove all annotations from the current node. */
  clear: () => void
  /** True when the current node has at least one annotation. */
  hasAny: boolean
}

/**
 * Per-node annotation store. Keyed by game-tree node id so drawings persist
 * while navigating the line (and across re-renders) without leaking to other
 * positions. Lives only in memory for the session.
 */
export function useAnnotations(nodeId: string): AnnotationStore {
  const mapRef = useRef<Map<string, Annotation[]>>(new Map())
  const [, bump] = useState(0)
  const rerender = useCallback(() => bump((n) => n + 1), [])

  const current = mapRef.current.get(nodeId) ?? []

  const set = useCallback(
    (next: Annotation[]) => {
      if (next.length === 0) mapRef.current.delete(nodeId)
      else mapRef.current.set(nodeId, next)
      rerender()
    },
    [nodeId, rerender]
  )

  const toggle = useCallback(
    (shape: Annotation) => {
      const list = mapRef.current.get(nodeId) ?? []
      const next = toggleAnnotation(list, shape)
      if (next.length === 0) mapRef.current.delete(nodeId)
      else mapRef.current.set(nodeId, next)
      rerender()
    },
    [nodeId, rerender]
  )

  const clear = useCallback(() => {
    if (mapRef.current.delete(nodeId)) rerender()
  }, [nodeId, rerender])

  return { current, set, toggle, clear, hasAny: current.length > 0 }
}
