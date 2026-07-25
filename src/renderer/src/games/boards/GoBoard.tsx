// Go + Gomoku board, interactive Shudan mount (P2 wave 2).
//
// @sabaki/shudan is a PREACT component. Rather than aliasing react →
// preact/compat app-wide (the app is React 19; chessground and friends must
// stay on real React), we mount a self-contained preact island: this React
// component owns a host <div> and renders a BoundedGoban into it with preact's
// own runtime (shudan imports 'preact' directly, which is installed. No
// electron.vite.config.ts alias needed; JSX in this file stays React JSX, the
// preact side uses h() calls only). The island is mounted ONCE and re-rendered
// in place on prop changes so shudan's stone-placement animation survives.
//
// kind === 'go':      full play (vertex click → onMove, hover ghost stone,
//                     last-move dot, ko square) + the SCORING PHASE UI: after
//                     two passes, taps propose `onAction('markdead <vertex>')`,
//                     dead groups render dimmed, territory is painted live and
//                     a floating strip shows the area count + a
//                     'Finalize score' button → `onAction('finalize')`.
// kind === 'gomoku':  same mount over gomokuSignMapOf with a win-line
//                     highlight when five in a row lands.
//
// Never rotated: flipPolicy 'none' for both kinds: orientation is ignored.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { h, render } from 'preact'
import { BoundedGoban } from '@sabaki/shudan'
import type { GhostStone, Marker, Vertex } from '@sabaki/shudan'
import '@sabaki/shudan/css/goban.css'
import './boards.css'
import type { GameBoardProps } from '../registry'
import {
  GO_SPEC,
  capturesOf,
  deadStonesOf,
  koVertexOf,
  pointToVertex,
  scoreDetail,
  signMapOf,
  territoryOf,
  turnOf,
  vertexToPoint,
  type GoState
} from '../go'
import { gomokuSignMapOf, turnOfGomoku, type GomokuState } from '../gomoku'
import { useBoardSound } from './useBoardSound'

type SignMap = (0 | 1 | -1)[][]

function emptyMap<T>(size: number): (T | null)[][] {
  return Array.from({ length: size }, () => new Array<T | null>(size).fill(null))
}

/** Winning five-plus run through the last move, as shudan line endpoints. */
function gomokuWinLine(s: GomokuState): { v1: Vertex; v2: Vertex } | null {
  if (s.winner === null || s.moves.length === 0) return null
  const last = vertexToPoint(s.moves[s.moves.length - 1], s.size)
  if (!last) return null
  const color = s.cells[last.y * s.size + last.x]
  for (const [dy, dx] of [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1]
  ] as const) {
    let a = { y: last.y, x: last.x }
    let b = { y: last.y, x: last.x }
    let run = 1
    for (;;) {
      const ny = a.y - dy
      const nx = a.x - dx
      if (ny < 0 || ny >= s.size || nx < 0 || nx >= s.size || s.cells[ny * s.size + nx] !== color) break
      a = { y: ny, x: nx }
      run++
    }
    for (;;) {
      const ny = b.y + dy
      const nx = b.x + dx
      if (ny < 0 || ny >= s.size || nx < 0 || nx >= s.size || s.cells[ny * s.size + nx] !== color) break
      b = { y: ny, x: nx }
      run++
    }
    if (run >= 5) return { v1: [a.x, a.y], v2: [b.x, b.y] }
  }
  return null
}

export default function GoBoard({
  kind,
  state,
  interactive,
  onMove,
  onAction,
  territory
}: GameBoardProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<Vertex | null>(null)
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 480, h: 480 })

  const isGo = kind === 'go'
  const goState = isGo ? (state as GoState) : null
  const gmState = isGo ? null : (state as GomokuState)
  const size = isGo ? goState!.size : gmState!.size

  useBoardSound(kind, state)

  // Track the stage size so BoundedGoban always fills the tile it is given.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r && r.width > 0 && r.height > 0) setBox({ w: Math.floor(r.width), h: Math.floor(r.height) })
    })
    ro.observe(el)
    return (): void => ro.disconnect()
  }, [])

  const scoring = isGo ? GO_SPEC.isScoringPhase(goState!) : false
  const finalized = isGo ? goState!.finalized : false

  // Legal placements for the hover ghost + click gate (Set for O(1) lookups).
  const legal = useMemo(() => {
    if (!interactive || scoring || finalized) return new Set<string>()
    const moves = isGo ? GO_SPEC.legalMoves(goState!) : gmState!.winner === null ? null : []
    if (moves !== null) return new Set(moves)
    // gomoku: any empty cell (cheaper than materializing spec.legalMoves)
    const out = new Set<string>()
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) if (gmState!.cells[y * size + x] === null) out.add(pointToVertex(y, x, size))
    return out
  }, [isGo, goState, gmState, size, interactive, scoring, finalized])

  const signMap = useMemo<SignMap>(
    () => (isGo ? signMapOf(goState!) : gomokuSignMapOf(gmState!)) as SignMap,
    [isGo, goState, gmState]
  )

  const turn = isGo ? (scoring || finalized ? null : turnOf(goState!)) : gmState!.winner ? null : turnOfGomoku(gmState!)

  // Markers: last move dot + (go) ko square.
  const markerMap = useMemo(() => {
    const map = emptyMap<Marker>(size)
    const moves = isGo ? goState!.moves : gmState!.moves
    const last = moves[moves.length - 1]
    if (last && last !== 'pass') {
      const p = vertexToPoint(last, size)
      if (p) map[p.y][p.x] = { type: 'point' }
    }
    if (isGo && !scoring && !finalized) {
      const ko = koVertexOf(goState!)
      if (ko) {
        const p = vertexToPoint(ko, size)
        if (p) map[p.y][p.x] = { type: 'square' }
      }
    }
    return map
  }, [isGo, goState, gmState, size, scoring, finalized])

  // Scoring phase: dim dead stones, paint live territory.
  const dimmedVertices = useMemo<Vertex[]>(() => {
    if (!isGo || (!scoring && !finalized)) return []
    return deadStonesOf(goState!)
      .map((v) => vertexToPoint(v, size))
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map((p) => [p.x, p.y] as Vertex)
  }, [isGo, goState, size, scoring, finalized])

  const paintMap = useMemo(() => {
    if (!isGo) return undefined
    if (!scoring && !finalized) {
      // Live territory-estimate overlay (owner-fed KataGo ownership): shudan
      // paints |value|·0.5 opacity, sign +1 = black fill. Our grid is
      // white-positive, so it flips. A dead-zone mutes near-neutral noise.
      if (!territory || territory.length !== size * size) return undefined
      const map = Array.from({ length: size }, (_, y) =>
        Array.from({ length: size }, (_, x) => {
          const own = territory[y * size + x]
          return Math.abs(own) < 0.2 ? 0 : Math.max(-1, Math.min(1, -own))
        })
      )
      return map as unknown as SignMap
    }
    // Scoring phase: the EXACT dead-stone territory paint (tenuki's ruling).
    const t = territoryOf(goState!)
    if (!t) return undefined
    const map: SignMap = Array.from({ length: size }, () => new Array<0 | 1 | -1>(size).fill(0))
    for (const v of t.black) {
      const p = vertexToPoint(v, size)
      if (p) map[p.y][p.x] = 1
    }
    for (const v of t.white) {
      const p = vertexToPoint(v, size)
      if (p) map[p.y][p.x] = -1
    }
    return map
  }, [isGo, goState, size, scoring, finalized, territory])

  const ghostStoneMap = useMemo(() => {
    if (!hover || !interactive || scoring || finalized || turn === null) return undefined
    const [x, y] = hover
    if (!legal.has(pointToVertex(y, x, size))) return undefined
    const map = emptyMap<GhostStone>(size)
    map[y][x] = { sign: turn === 'black' ? 1 : -1 }
    return map
  }, [hover, interactive, scoring, finalized, turn, legal, size])

  const lines = useMemo(() => {
    if (isGo) return undefined
    const win = gomokuWinLine(gmState!)
    return win ? [{ ...win, type: 'line' as const }] : undefined
  }, [isGo, gmState])

  // Mount the preact island once; re-render in place on every change.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    render(
      h(BoundedGoban as never, {
        maxWidth: box.w,
        maxHeight: box.h,
        signMap,
        markerMap,
        ghostStoneMap,
        paintMap,
        dimmedVertices,
        lines,
        showCoordinates: true,
        fuzzyStonePlacement: false,
        animateStonePlacement: true,
        onVertexClick: (_evt: MouseEvent, [x, y]: Vertex) => {
          const vertex = pointToVertex(y, x, size)
          if (scoring) {
            // Tap a stone to toggle its group's dead status.
            if (interactive && onAction && signMap[y][x] !== 0) onAction(`markdead ${vertex}`)
            return
          }
          if (interactive && !finalized && legal.has(vertex)) onMove(vertex)
        },
        onVertexMouseEnter: (_evt: MouseEvent, v: Vertex) => setHover(v),
        onVertexMouseLeave: (_evt: MouseEvent, v: Vertex) =>
          setHover((cur) => (cur && cur[0] === v[0] && cur[1] === v[1] ? null : cur))
      }),
      host
    )
  }, [
    box,
    signMap,
    markerMap,
    ghostStoneMap,
    paintMap,
    dimmedVertices,
    lines,
    size,
    scoring,
    finalized,
    interactive,
    legal,
    onMove,
    onAction
  ])

  // Unmount the preact tree only when the React component goes away.
  useEffect(
    () => (): void => {
      if (hostRef.current) render(null, hostRef.current)
    },
    []
  )

  const score = isGo && (scoring || finalized) ? scoreDetail(goState!) : null

  return (
    <div className={`goboard${isGo ? ' is-go' : ' is-gomoku'}`}>
      <div ref={stageRef} className="goboard-stage">
        <div ref={hostRef} className="goboard-host" onMouseLeave={() => setHover(null)} />
        {isGo && scoring && score && (
          <div className="goboard-score" role="status">
            <span className="goboard-score-side">
              <span className="goboard-dot is-black" aria-hidden /> Black {formatPts(score.black)}
            </span>
            <span className="goboard-score-side">
              <span className="goboard-dot is-white" aria-hidden /> White {formatPts(score.white)}
              <span className="goboard-komi">(komi {formatPts(goState!.komi)})</span>
            </span>
            <span className="goboard-score-hint">Tap groups to mark them dead</span>
            {interactive && onAction && (
              <button type="button" className="goboard-finalize" onClick={() => onAction('finalize')}>
                Finalize score
              </button>
            )}
          </div>
        )}
      </div>
      {/* Capture counts live BELOW the board (never over coordinates/stones). */}
      {isGo && !scoring && !finalized && (goState!.moves.length > 0 || null) && (
        <div className="goboard-caps" aria-hidden>
          <span className="goboard-caps-label">Captures</span>
          <span>
            <span className="goboard-dot is-black" /> {capturesOf(goState!, 'black')}
          </span>
          <span>
            <span className="goboard-dot is-white" /> {capturesOf(goState!, 'white')}
          </span>
        </div>
      )}
    </div>
  )
}

function formatPts(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
