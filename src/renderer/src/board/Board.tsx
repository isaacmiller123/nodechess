import { useEffect, useRef } from 'react'
import { Chessground } from 'chessground'
import type { Api } from 'chessground/api'
import type { Config } from 'chessground/config'
import type { Key } from 'chessground/types'
import type { DrawBrush, DrawBrushes, DrawShape } from 'chessground/draw'
import type { Color } from '../chess/chess'

export interface BoardProps {
  fen: string
  orientation: Color
  turnColor: Color
  dests: Map<Key, Key[]>
  lastMove?: [Key, Key]
  check?: Color
  movableColor?: Color | 'both'
  viewOnly?: boolean
  showDests?: boolean
  animation?: boolean
  coordinates?: boolean
  /** Programmatic shapes (e.g. engine top-line arrows). Rendered as chessground
   *  auto-shapes: they never interfere with, and are not erased by, the user's
   *  own right-click drawings. */
  shapes?: DrawShape[]
  /** Extra draw brushes, deep-merged OVER chessground's defaults (configure()
   *  merges plain objects key-by-key, so stock green/red/pale* survive). Any
   *  shape referencing a non-default brush key MUST have it registered here or
   *  chessground's SVG defs sync crashes. Pass a module-level constant (e.g.
   *  SCHOOL_BRUSHES). Identity is not diffed. */
  brushes?: Record<string, DrawBrush>
  /** Bump to force the board to re-sync to `fen` even when fen is unchanged (e.g. cancelled promotion / illegal move). */
  syncNonce?: number
  onMove?: (orig: Key, dest: Key) => void
}

/** Stable signature for an auto-shape list so the sync effect only fires when it changes. */
function shapesKey(shapes?: DrawShape[]): string {
  if (!shapes || shapes.length === 0) return ''
  return shapes.map((s) => `${s.orig}${s.dest ?? ''}${s.brush ?? ''}`).join('|')
}

// Preview-harness only: the browser test harness (opened with `?mock`) drives the
// board with synthetic events, which chessground rejects by default (isTrusted).
// This NEVER activates in the packaged app: its URL has no `?mock`.
const TRUST_ALL_EVENTS =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock')

export function Board(props: BoardProps) {
  const elRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<Api | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  const config = (): Config => {
    const p = propsRef.current
    const interactive = !(p.viewOnly ?? false)
    return {
      fen: p.fen,
      orientation: p.orientation,
      turnColor: p.turnColor,
      coordinates: p.coordinates ?? true,
      // IMPORTANT: never create the board as chessground-`viewOnly`. chessground
      // only binds its drag/click listeners ONCE, at creation, and skips them when
      // viewOnly is true (events.ts: `if (s.viewOnly) return`). A board that mounts
      // view-only (e.g. a puzzle while loading) would then stay dead even after we
      // flip it interactive via set(). Instead we keep the board "live" and gate
      // interaction through movable/draggable/selectable, which chessground honours
      // at event time. This is what fixes "can't move pieces in puzzles".
      viewOnly: false,
      trustAllEvents: TRUST_ALL_EVENTS,
      check: p.check,
      lastMove: p.lastMove,
      highlight: { lastMove: true, check: true },
      animation: { enabled: p.animation ?? true, duration: 200 },
      movable: {
        free: false,
        color: interactive ? (p.movableColor ?? p.turnColor) : undefined,
        dests: interactive ? p.dests : new Map(),
        showDests: p.showDests ?? true,
        events: {
          after: (orig, dest) => propsRef.current.onMove?.(orig as Key, dest as Key)
        }
      },
      draggable: { enabled: interactive },
      selectable: { enabled: interactive },
      // eraseOnClick: a plain left-click clears the user's own drawings (lichess
      // behaviour). autoShapes carry engine arrows and are managed separately.
      // NOTE: `brushes` is only included when provided. An undefined value in
      // the config would REPLACE (wipe) chessground's default brush map.
      drawable: {
        enabled: true,
        visible: true,
        eraseOnClick: true,
        autoShapes: p.shapes ?? [],
        // Cast: chessground's DrawBrushes TYPE demands the four stock keys, but
        // configure() deep-merges partial maps over the defaults at runtime
        // (verified in chessground/src/config.ts), so extra-keys-only is safe.
        ...(p.brushes ? { brushes: p.brushes as DrawBrushes } : {})
      }
    }
  }

  useEffect(() => {
    if (!elRef.current) return
    apiRef.current = Chessground(elRef.current, config())
    return () => {
      apiRef.current?.destroy()
      apiRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    apiRef.current?.set(config())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.fen,
    props.orientation,
    props.turnColor,
    props.movableColor,
    props.viewOnly,
    props.showDests,
    props.coordinates,
    props.check,
    props.dests,
    props.lastMove?.join(''),
    shapesKey(props.shapes),
    props.syncNonce
  ])

  // Announce the board as an interactive region. The label reflects orientation
  // and, when playable, whose turn it is, so color is never the only signal.
  const label = props.viewOnly
    ? `Chess board, ${props.orientation} to play, view only`
    : `Chess board, ${props.orientation} side, ${props.turnColor} to move`

  return (
    <div
      className="cg-wrap"
      ref={elRef}
      role="group"
      aria-label={label}
      aria-roledescription="interactive chess board"
    />
  )
}
