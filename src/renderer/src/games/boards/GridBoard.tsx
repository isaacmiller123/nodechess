// Grid-family boards: ONE polished component parameterized per kind
// (docs/GAMES-PLATFORM-SPEC.md P2 wave 2):
//
//   othello    8x8 felt board, two-faced discs, flip-cascade animation
//              (delay grows with distance from the placement), legal-move
//              dots tinted by the side to move, live disc counts.
//   connect4   perforated blue frame, column hover + drop lane ghost,
//              gravity drop animation (fall time scales with depth), winning
//              four highlighted.
//   hex        11x11 SVG hexagon rhombus, red (White, left-right) vs blue
//              (Black, top-bottom) shaded edges, hover ghost stone, winning
//              chain glow.
//   morris     nine men's morris line-graph, three phases with a live phase
//              hint strip (placing / moving / flying / mill capture),
//              in-hand trays, mill flash, sliding men.
//   tictactoe  clean animated strokes (draw-on X/O, gold strike line).
//
// All idioms propose moves through the spec codecs and never validate rules
// beyond membership in spec.legalMoves. Orientation is ignored for every kind
// except morris (flipPolicy 'rotate': the board is symmetric, so OTB flips
// rotate the point layout 180°). Sounds ride useBoardSound (discFlip /
// discDrop / discPlace / penStroke).

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import './boards.css'
import type { GameBoardProps } from '../registry'
import { useBoardSound } from './useBoardSound'
import { OTHELLO_SPEC, othelloName, popcount, type OthelloState } from '../small/othello'
import { CONNECT4_SPEC, type Connect4State } from '../small/connect4'
import { HEX_N, HEX_SPEC, hexName, type HexState } from '../small/hex'
import { MORRIS_MILLS, MORRIS_POINTS, MORRIS_SPEC, type MorrisState } from '../small/morris'
import { TICTACTOE_SPEC, tttName, type TicTacToeState } from '../small/tictactoe'
import { MOR_S, MOR_STEP, morXY } from './orient'

/** One-ply advance from `prev` to `next` (same game, exactly one new move)? */
function isOnePly(prev: readonly string[] | null, next: readonly string[]): boolean {
  if (!prev || next.length !== prev.length + 1) return false
  return prev.length === 0 || next[prev.length - 1] === prev[prev.length - 1]
}

// ===========================================================================
// Othello
// ===========================================================================

interface OthAnim {
  /** bit index → flip transition delay (ms). */
  delays: ReadonlyMap<number, number>
  /** bit index of the disc just placed (scale-in), or null. */
  placed: number | null
}

const OTH_NO_ANIM: OthAnim = { delays: new Map(), placed: null }

function computeOthAnim(prev: OthelloState | null, s: OthelloState): OthAnim {
  if (!prev || !isOnePly(prev.moves, s.moves)) return OTH_NO_ANIM
  const last = s.moves[s.moves.length - 1]
  if (last === 'pass') return OTH_NO_ANIM
  const placedBit = (last.charCodeAt(1) - 49) * 8 + (last.charCodeAt(0) - 97)
  const px = placedBit % 8
  const py = placedBit >> 3
  const delays = new Map<number, number>()
  for (let i = 0; i < 64; i++) {
    const bit = 1n << BigInt(i)
    const was = (prev.black & bit) !== 0n ? 1 : (prev.white & bit) !== 0n ? -1 : 0
    const now = (s.black & bit) !== 0n ? 1 : (s.white & bit) !== 0n ? -1 : 0
    if (was !== 0 && now !== 0 && was !== now) {
      const dist = Math.max(Math.abs((i % 8) - px), Math.abs((i >> 3) - py))
      delays.set(i, dist * 55)
    }
  }
  return { delays, placed: placedBit }
}

function OthelloBoard({ state, interactive, onMove }: GameBoardProps): JSX.Element {
  const s = state as OthelloState
  const model = useRef<{ state: OthelloState | null; anim: OthAnim }>({ state: null, anim: OTH_NO_ANIM })
  if (model.current.state !== s) model.current = { state: s, anim: computeOthAnim(model.current.state, s) }
  const anim = model.current.anim

  const legal = useMemo(() => {
    if (!interactive) return new Set<string>()
    return new Set(OTHELLO_SPEC.legalMoves(s).filter((m) => m !== 'pass'))
  }, [s, interactive])

  const last = s.moves[s.moves.length - 1]
  const lastBit = last && last !== 'pass' ? (last.charCodeAt(1) - 49) * 8 + (last.charCodeAt(0) - 97) : -1
  const turnClass = s.turn === 0 ? 'turn-black' : 'turn-white'

  const cells: JSX.Element[] = []
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const bit = (7 - r) * 8 + c
      const mask = 1n << BigInt(bit)
      const color = (s.black & mask) !== 0n ? 'black' : (s.white & mask) !== 0n ? 'white' : null
      const name = othelloName(bit)
      const canPlay = color === null && legal.has(name)
      cells.push(
        <div
          key={bit}
          className={`oth-cell${canPlay ? ' is-legal' : ''}${bit === lastBit ? ' is-last' : ''}`}
          onClick={canPlay ? () => onMove(name) : undefined}
        >
          {color !== null && (
            <div
              className={`oth-disc is-${color}${anim.placed === bit ? ' is-placed' : ''}`}
              style={{ '--fd': `${anim.delays.get(bit) ?? 0}ms` } as CSSProperties}
            >
              <div className="oth-face is-black" />
              <div className="oth-face is-white" />
            </div>
          )}
        </div>
      )
    }
  }

  return (
    <div className="gboard is-othello">
      <div className={`otb-othello ${turnClass}`}>{cells}</div>
      <div className="oth-count" aria-live="polite">
        <span>
          <span className="goboard-dot is-black" aria-hidden /> {popcount(s.black)}
        </span>
        <span>
          <span className="goboard-dot is-white" aria-hidden /> {popcount(s.white)}
        </span>
      </div>
    </div>
  )
}

// ===========================================================================
// Connect Four
// ===========================================================================

function c4At(s: Connect4State, col: number, row: number): 0 | 1 | null {
  const bit = 1n << BigInt(col * 7 + row)
  if ((s.bb[0] & bit) !== 0n) return 0
  if ((s.bb[1] & bit) !== 0n) return 1
  return null
}

/** Winning four (as col*7+row bit indexes) or null. */
function c4WinCells(s: Connect4State): Set<number> | null {
  for (const side of [0, 1] as const) {
    const b = s.bb[side]
    for (const d of [1n, 7n, 6n, 8n]) {
      for (let i = 0; i < 49; i++) {
        const bit = 1n << BigInt(i)
        if (
          (b & bit) !== 0n &&
          (b & (bit << d)) !== 0n &&
          (b & (bit << (2n * d))) !== 0n &&
          (b & (bit << (3n * d))) !== 0n
        ) {
          const dd = Number(d)
          return new Set([i, i + dd, i + 2 * dd, i + 3 * dd])
        }
      }
    }
  }
  return null
}

function Connect4Board({ state, interactive, onMove }: GameBoardProps): JSX.Element {
  const s = state as Connect4State
  const [hoverCol, setHoverCol] = useState<number | null>(null)

  // one-ply reconciler: which disc just dropped
  const model = useRef<{ state: Connect4State | null; dropped: number }>({ state: null, dropped: -1 })
  if (model.current.state !== s) {
    let dropped = -1
    const prev = model.current.state
    if (prev && isOnePly(prev.moves, s.moves)) {
      const col = Number(s.moves[s.moves.length - 1]) - 1
      dropped = col * 7 + (s.heights[col] - 1)
    }
    model.current = { state: s, dropped }
  }
  const dropped = model.current.dropped

  const over = useMemo(() => CONNECT4_SPEC.result(s) !== null, [s])
  const win = useMemo(() => c4WinCells(s), [s])
  const turnColor = s.turn === 0 ? 'is-red' : 'is-yellow'

  const discs: JSX.Element[] = []
  for (let col = 0; col < 7; col++) {
    for (let row = 0; row < s.heights[col]; row++) {
      const bit = col * 7 + row
      const side = c4At(s, col, row)
      if (side === null) continue
      const rTop = 5 - row // rendered row from the top
      const isDrop = bit === dropped
      discs.push(
        <div
          key={bit}
          className={`c4-disc ${side === 0 ? 'is-red' : 'is-yellow'}${isDrop ? ' is-dropped' : ''}${
            win?.has(bit) ? ' is-win' : ''
          }`}
          style={
            {
              left: `calc(${(col * 100) / 7}% + 0.9%)`,
              top: `calc(${(rTop * 100) / 6}% + 1%)`,
              width: `${100 / 7 - 1.8}%`,
              height: `${100 / 6 - 2}%`,
              '--fall': `${(rTop + 1.2) * 100}%`,
              '--dropms': `${240 + rTop * 45}ms`
            } as CSSProperties
          }
        />
      )
    }
  }

  return (
    <div className="gboard is-connect4">
      <div className="c4-wrap">
        <div className="c4-lane" aria-hidden>
          {Array.from({ length: 7 }, (_, col) => (
            <div key={col} className="c4-lane-cell">
              <div
                className={`c4-lane-disc c4-disc ${turnColor}${
                  interactive && !over && hoverCol === col && s.heights[col] < 6 ? ' is-visible' : ''
                }`}
              />
            </div>
          ))}
        </div>
        <div className="c4-frame">
          <div className="c4-discs">{discs}</div>
          <div className="c4-holes" aria-hidden>
            {Array.from({ length: 42 }, (_, i) => (
              <div key={i} className="c4-hole" />
            ))}
          </div>
          <div className="c4-sheen" aria-hidden />
          <div className="c4-cols">
            {Array.from({ length: 7 }, (_, col) => (
              <div
                key={col}
                className={`c4-col${s.heights[col] >= 6 || over ? ' is-full' : ''}`}
                onMouseEnter={() => setHoverCol(col)}
                onMouseLeave={() => setHoverCol((h) => (h === col ? null : h))}
                onClick={
                  interactive && !over && s.heights[col] < 6 ? () => onMove(String(col + 1)) : undefined
                }
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ===========================================================================
// Hex
// ===========================================================================

const HEX_R = 19 // circumradius (pointy-top)
const HEX_W = Math.sqrt(3) * HEX_R
const HEX_PAD = 26

function hexCenter(row: number, col: number): { x: number; y: number } {
  return {
    x: HEX_PAD + HEX_W / 2 + (col + row * 0.5) * HEX_W,
    y: HEX_PAD + HEX_R + (HEX_N - 1 - row) * HEX_R * 1.5
  }
}

const HEX_POINTS = Array.from({ length: 6 }, (_, i) => {
  const a = Math.PI / 6 + (i * Math.PI) / 3
  return [Math.cos(a) * HEX_R * 0.96, Math.sin(a) * HEX_R * 0.96]
})

function hexPolygon(cx: number, cy: number): string {
  return HEX_POINTS.map(([dx, dy]) => `${(cx + dx).toFixed(1)},${(cy + dy).toFixed(1)}`).join(' ')
}

/** Cells of the winning chain (connected to both of the winner's edges). */
function hexWinCells(s: HexState): Set<number> | null {
  const res = HEX_SPEC.result(s)
  if (!res || res.winner === null) return null
  const player = res.winner === 'white' ? 1 : 2
  const reach = (fromStart: boolean): Set<number> => {
    const seen = new Set<number>()
    const stack: number[] = []
    for (let i = 0; i < HEX_N; i++) {
      const idx =
        player === 1
          ? (fromStart ? 0 : HEX_N - 1) + i * HEX_N // left/right column
          : (fromStart ? 0 : (HEX_N - 1) * HEX_N) + i // bottom/top row
      if (s.cells[idx] === player) {
        seen.add(idx)
        stack.push(idx)
      }
    }
    while (stack.length > 0) {
      const idx = stack.pop()!
      const row = Math.floor(idx / HEX_N)
      const col = idx % HEX_N
      for (const [dr, dc] of [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
        [-1, 1],
        [1, -1]
      ] as const) {
        const r = row + dr
        const c = col + dc
        if (r < 0 || r >= HEX_N || c < 0 || c >= HEX_N) continue
        const n = r * HEX_N + c
        if (s.cells[n] === player && !seen.has(n)) {
          seen.add(n)
          stack.push(n)
        }
      }
    }
    return seen
  }
  const a = reach(true)
  const b = reach(false)
  return new Set([...a].filter((i) => b.has(i)))
}

function HexBoard({ state, interactive, onMove }: GameBoardProps): JSX.Element {
  const s = state as HexState
  const [hover, setHover] = useState<number | null>(null)

  const over = useMemo(() => HEX_SPEC.result(s) !== null, [s])
  const winCells = useMemo(() => hexWinCells(s), [s])
  const lastIdx = useMemo(() => {
    const last = s.moves[s.moves.length - 1]
    if (!last || last === 'swap') return -1
    const m = /^([a-k])(1[01]|[1-9])$/.exec(last)
    return m ? (Number(m[2]) - 1) * HEX_N + (m[1].charCodeAt(0) - 97) : -1
  }, [s])

  const width = HEX_PAD * 2 + HEX_W * (HEX_N + (HEX_N - 1) * 0.5)
  const height = HEX_PAD * 2 + HEX_R * 2 + (HEX_N - 1) * HEX_R * 1.5

  // Straight border lines just outside the four sides (red = White l/r).
  const edge = (row: number, col: number): { x: number; y: number } => hexCenter(row, col)
  const off = HEX_W / 2 + 5
  const offY = HEX_R + 4
  const p00 = edge(0, 0)
  const p0k = edge(0, HEX_N - 1)
  const pk0 = edge(HEX_N - 1, 0)
  const pkk = edge(HEX_N - 1, HEX_N - 1)

  const cells: JSX.Element[] = []
  const stones: JSX.Element[] = []
  for (let row = 0; row < HEX_N; row++) {
    for (let col = 0; col < HEX_N; col++) {
      const idx = row * HEX_N + col
      const v = s.cells[idx]
      const { x, y } = hexCenter(row, col)
      const empty = v === 0
      const canPlay = interactive && !over && empty
      cells.push(
        <polygon
          key={idx}
          className={`hex-cell${empty ? ' is-empty' : ''}${canPlay ? ' is-clickable' : ''}`}
          points={hexPolygon(x, y)}
          onClick={canPlay ? () => onMove(hexName(idx)) : undefined}
          onMouseEnter={canPlay ? () => setHover(idx) : undefined}
          onMouseLeave={canPlay ? () => setHover((h) => (h === idx ? null : h)) : undefined}
        />
      )
      if (!empty) {
        stones.push(
          <g key={`s${idx}`} className={winCells?.has(idx) ? 'hex-win' : undefined} pointerEvents="none">
            <circle cx={x} cy={y + 1} r={HEX_R * 0.62} fill="rgba(20,10,0,0.35)" />
            <circle cx={x} cy={y} r={HEX_R * 0.62} className={v === 1 ? 'hex-stone-red' : 'hex-stone-blue'} />
            {idx === lastIdx && (
              <circle cx={x} cy={y} r={HEX_R * 0.3} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth={2.2} />
            )}
          </g>
        )
      } else if (hover === idx && canPlay) {
        stones.push(
          <circle
            key={`g${idx}`}
            cx={x}
            cy={y}
            r={HEX_R * 0.62}
            className={s.turn === 1 ? 'hex-stone-red' : 'hex-stone-blue'}
            opacity={0.45}
            pointerEvents="none"
          />
        )
      }
    }
  }

  return (
    <div className="gboard is-hex">
      <svg className="gb-svg" viewBox={`0 0 ${width.toFixed(0)} ${height.toFixed(0)}`}>
        <defs>
          <radialGradient id="hexRed" cx="35%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#ff8a7a" />
            <stop offset="100%" stopColor="#c0392b" />
          </radialGradient>
          <radialGradient id="hexBlue" cx="35%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#7ab8ff" />
            <stop offset="100%" stopColor="#2a6fb8" />
          </radialGradient>
        </defs>
        {/* edge shading: red = White (left ↔ right), blue = Black (top ↔ bottom) */}
        <line x1={pk0.x - off} y1={pk0.y - offY} x2={p00.x - off} y2={p00.y + offY} stroke="#c0392b" strokeWidth={7} strokeLinecap="round" opacity={0.8} />
        <line x1={pkk.x + off} y1={pkk.y - offY} x2={p0k.x + off} y2={p0k.y + offY} stroke="#c0392b" strokeWidth={7} strokeLinecap="round" opacity={0.8} />
        <line x1={p00.x - off + 8} y1={p00.y + offY + 3} x2={p0k.x + off - 8} y2={p0k.y + offY + 3} stroke="#2a6fb8" strokeWidth={7} strokeLinecap="round" opacity={0.8} />
        <line x1={pk0.x - off + 8} y1={pk0.y - offY - 3} x2={pkk.x + off - 8} y2={pkk.y - offY - 3} stroke="#2a6fb8" strokeWidth={7} strokeLinecap="round" opacity={0.8} />
        {cells}
        {stones}
      </svg>
    </div>
  )
}

// ===========================================================================
// Nine Men's Morris
// ===========================================================================

interface MorLegal {
  str: string
  from: number | null
  to: number
  cap: number | null
}

const MOR_INDEX = new Map(MORRIS_POINTS.map((p, i) => [p, i]))
const MOR_RE = /^([a-g][1-7])(?:-([a-g][1-7]))?(?:x([a-g][1-7]))?$/

function parseMorris(str: string): MorLegal {
  const m = MOR_RE.exec(str)!
  const a = MOR_INDEX.get(m[1])!
  const to = m[2] !== undefined ? MOR_INDEX.get(m[2])! : a
  return {
    str,
    from: m[2] !== undefined ? a : null,
    to,
    cap: m[3] !== undefined ? MOR_INDEX.get(m[3])! : null
  }
}

interface MorRenderMan {
  id: number
  point: number
  player: 1 | 2
  captured: boolean
}

function MorrisBoard({ state, orientation, interactive, onMove }: GameBoardProps): JSX.Element {
  const s = state as MorrisState
  const rotated = orientation === 'black'
  const [sel, setSel] = useState<{ from: number | null; to: number } | null>(null)
  useEffect(() => setSel(null), [state, interactive])

  const legals = useMemo<MorLegal[]>(
    () => (interactive ? MORRIS_SPEC.legalMoves(s).map(parseMorris) : []),
    [s, interactive]
  )
  const placing = s.inHand[s.turn - 1] > 0
  const over = legals.length === 0 && interactive

  // ---- men reconciler (stable ids → cx/cy slide transitions) ----
  const model = useRef<{
    state: unknown
    moves: readonly string[]
    men: MorRenderMan[]
    nextId: number
  } | null>(null)
  const men = ((): MorRenderMan[] => {
    const m = model.current
    if (m && m.state === s) return m.men
    let nextId = m?.nextId ?? 0
    let out: MorRenderMan[]
    if (m && isOnePly(m.moves, s.moves)) {
      const mv = parseMorris(s.moves[s.moves.length - 1])
      out = []
      for (const man of m.men) {
        if (man.captured) continue
        if (mv.cap !== null && man.point === mv.cap) out.push({ ...man, captured: true })
        else if (mv.from !== null && man.point === mv.from) out.push({ ...man, point: mv.to })
        else out.push(man)
      }
      if (mv.from === null) out.push({ id: nextId++, point: mv.to, player: (3 - s.turn) as 1 | 2, captured: false })
    } else {
      out = []
      for (let i = 0; i < 24; i++) {
        if (s.board[i] !== 0) out.push({ id: nextId++, point: i, player: s.board[i] as 1 | 2, captured: false })
      }
    }
    model.current = { state: s, moves: s.moves, men: out, nextId }
    return out
  })()

  // ---- selection model over the codec ----
  // sel null:            click own man (movement) or empty point (placement)
  // sel {from,to}:       mill formed → choose the capture target
  const pending = sel === null ? [] : legals.filter((l) => l.from === sel.from && l.to === sel.to)
  const captureMode = pending.length > 0
  const [selFrom, setSelFrom] = useState<number | null>(null)
  useEffect(() => setSelFrom(null), [state, interactive])

  const moveTargets = useMemo(() => {
    if (captureMode) return new Set<number>()
    if (placing) return new Set(legals.map((l) => l.to))
    if (selFrom === null) return new Set<number>()
    return new Set(legals.filter((l) => l.from === selFrom).map((l) => l.to))
  }, [legals, placing, selFrom, captureMode])
  const capTargets = useMemo(
    () => new Set(pending.map((l) => l.cap).filter((c): c is number => c !== null)),
    [pending]
  )
  const ownMovable = useMemo(
    () => (placing ? new Set<number>() : new Set(legals.map((l) => l.from).filter((f): f is number => f !== null))),
    [legals, placing]
  )

  const finish = (l: MorLegal): void => {
    setSel(null)
    setSelFrom(null)
    onMove(l.str)
  }

  const clickPoint = (idx: number): void => {
    if (!interactive) return
    if (captureMode) {
      const hit = pending.find((l) => l.cap === idx)
      if (hit) finish(hit)
      return
    }
    const occupant = s.board[idx]
    if (placing) {
      if (occupant !== 0) return
      const cands = legals.filter((l) => l.from === null && l.to === idx)
      if (cands.length === 0) return
      if (cands.length === 1 && cands[0].cap === null) return finish(cands[0])
      setSel({ from: null, to: idx }) // mill on placement → pick a capture
      return
    }
    if (selFrom !== null && moveTargets.has(idx)) {
      const cands = legals.filter((l) => l.from === selFrom && l.to === idx)
      if (cands.length === 1 && cands[0].cap === null) return finish(cands[0])
      setSel({ from: selFrom, to: idx })
      return
    }
    if (ownMovable.has(idx)) {
      setSelFrom(selFrom === idx ? null : idx)
      return
    }
    setSelFrom(null)
  }

  // mill flash: the mill(s) through the destination of a just-played capture
  const millFlash = useMemo<readonly (readonly [number, number, number])[]>(() => {
    const last = s.moves[s.moves.length - 1]
    if (!last || !last.includes('x')) return []
    const mv = parseMorris(last)
    const player = s.board[mv.to]
    return MORRIS_MILLS.filter(([a, b, c]) => {
      if (![a, b, c].includes(mv.to)) return false
      return s.board[a] === player && s.board[b] === player && s.board[c] === player
    })
  }, [s])

  const flying = !placing && legals.length > 0 && s.board.filter((v) => v === s.turn).length === 3
  const hint = !interactive
    ? ''
    : over
      ? ''
      : captureMode
        ? 'Mill! Take an enemy man'
        : placing
          ? `Place a man (${s.inHand[s.turn - 1]} left in hand)`
          : flying
            ? 'Three men left: fly anywhere'
            : 'Move a man along a line'

  // board lines (three rings + connectors), rotated with the points
  const ring = (r: number): string => {
    const a = morXY(MOR_INDEX.get(r === 0 ? 'a1' : r === 1 ? 'b2' : 'c3')!, rotated)
    const b = morXY(MOR_INDEX.get(r === 0 ? 'g7' : r === 1 ? 'f6' : 'e5')!, rotated)
    const x0 = Math.min(a.x, b.x)
    const y0 = Math.min(a.y, b.y)
    const w = Math.abs(b.x - a.x)
    return `M${x0} ${y0} h${w} v${w} h${-w} Z`
  }
  const conn = (p: string, q: string): string => {
    const a = morXY(MOR_INDEX.get(p)!, rotated)
    const b = morXY(MOR_INDEX.get(q)!, rotated)
    return `M${a.x} ${a.y} L${b.x} ${b.y}`
  }

  return (
    <div className="gboard is-morris">
      <svg className="gb-svg" viewBox={`0 0 ${MOR_S} ${MOR_S}`}>
        <defs>
          <radialGradient id="morW" cx="35%" cy="28%" r="80%">
            <stop offset="0%" stopColor="#fff9ea" />
            <stop offset="100%" stopColor="#cdbb92" />
          </radialGradient>
          <radialGradient id="morB" cx="35%" cy="28%" r="80%">
            <stop offset="0%" stopColor="#57524d" />
            <stop offset="100%" stopColor="#17130f" />
          </radialGradient>
        </defs>
        <rect x={4} y={4} width={MOR_S - 8} height={MOR_S - 8} rx={10} className="mor-wood" />
        <g className="mor-lines">
          <path d={`${ring(0)} ${ring(1)} ${ring(2)}`} />
          <path d={`${conn('d1', 'd3')} ${conn('d5', 'd7')} ${conn('a4', 'c4')} ${conn('e4', 'g4')}`} />
        </g>
        {millFlash.map((mill, i) => {
          const a = morXY(mill[0], rotated)
          const c = morXY(mill[2], rotated)
          return (
            <line key={`m${i}`} className="mor-mill" x1={a.x} y1={a.y} x2={c.x} y2={c.y} />
          )
        })}
        {MORRIS_POINTS.map((_, idx) => {
          const { x, y } = morXY(idx, rotated)
          const target = captureMode ? capTargets.has(idx) : moveTargets.has(idx)
          const clickable =
            interactive && (target || (captureMode ? false : placing ? false : ownMovable.has(idx)))
          return (
            <g key={idx}>
              <circle className="mor-node" cx={x} cy={y} r={5} />
              {target && !captureMode && s.board[idx] === 0 && (
                <circle className="mor-hint-dot" cx={x} cy={y} r={8} />
              )}
              <circle
                className={`mor-point${s.board[idx] === 0 ? ' is-empty' : ''}${clickable ? ' is-clickable' : ''}`}
                cx={x}
                cy={y}
                r={MOR_STEP * 0.42}
                onClick={() => clickPoint(idx)}
              />
            </g>
          )
        })}
        {/* key={rotated}: an orientation flip remounts the men so the cx/cy
            slide transitions never lerp them across the board. */}
        <g key={rotated ? 'rot' : 'std'}>
        {men.map((man) => {
          const { x, y } = morXY(man.point, rotated)
          const isSel = selFrom === man.point && !man.captured
          const isCap = captureMode && capTargets.has(man.point) && !man.captured
          return (
            <circle
              key={man.id}
              className={`mor-man${man.captured ? ' is-captured' : ''}${isSel ? ' is-selected' : ''}${
                isCap ? ' is-capturable' : ''
              }`}
              cx={x}
              cy={y}
              r={MOR_STEP * 0.34}
              fill={man.player === 1 ? 'url(#morW)' : 'url(#morB)'}
            />
          )
        })}
        </g>
        {/* in-hand trays */}
        {([1, 2] as const).map((player) =>
          Array.from({ length: s.inHand[player - 1] }, (_, i) => (
            <circle
              key={`h${player}-${i}`}
              className="mor-hand"
              cx={player === 1 ? 14 : MOR_S - 14}
              cy={MOR_S / 2 + (i - (s.inHand[player - 1] - 1) / 2) * 16}
              r={6}
              fill={player === 1 ? 'url(#morW)' : 'url(#morB)'}
            />
          ))
        )}
      </svg>
      <div className={`gb-hint${captureMode ? ' is-mill' : ''}`} role="status">
        {hint}
      </div>
    </div>
  )
}

// ===========================================================================
// Tic-tac-toe
// ===========================================================================

const TTT_S = 300
const TTT_LINES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
]

function tttXY(index: number): { x: number; y: number } {
  const col = index % 3
  const row = Math.floor(index / 3) // rank-1 (0 = bottom)
  return { x: 50 + col * 100, y: 50 + (2 - row) * 100 }
}

function TicTacToeBoard({ state, interactive, onMove }: GameBoardProps): JSX.Element {
  const s = state as TicTacToeState
  const [hover, setHover] = useState<number | null>(null)

  const legal = useMemo(
    () => (interactive ? new Set(TICTACTOE_SPEC.legalMoves(s)) : new Set<string>()),
    [s, interactive]
  )
  const winLine = useMemo(() => {
    for (const line of TTT_LINES) {
      const [a, b, c] = line
      if (s.cells[a] !== 0 && s.cells[a] === s.cells[b] && s.cells[b] === s.cells[c]) return line
    }
    return null
  }, [s])

  const mark = (idx: number, player: number, ghost = false): JSX.Element => {
    const { x, y } = tttXY(idx)
    const cls = ghost ? '' : ' ttt-draw'
    if (player === 1) {
      return (
        <g key={`m${idx}${ghost ? 'g' : ''}`} opacity={ghost ? 0.28 : 1}>
          <path className={`ttt-stroke ttt-x${cls}`} strokeWidth={9} d={`M${x - 26} ${y - 26} L${x + 26} ${y + 26}`} />
          <path className={`ttt-stroke ttt-x${cls}`} strokeWidth={9} d={`M${x + 26} ${y - 26} L${x - 26} ${y + 26}`} />
        </g>
      )
    }
    return (
      <circle
        key={`m${idx}${ghost ? 'g' : ''}`}
        className={`ttt-stroke ttt-o${cls}`}
        strokeWidth={9}
        cx={x}
        cy={y}
        r={30}
        opacity={ghost ? 0.28 : 1}
      />
    )
  }

  return (
    <div className="gboard is-tictactoe">
      <svg className="gb-svg" viewBox={`0 0 ${TTT_S} ${TTT_S}`}>
        <g className="ttt-grid">
          <path d="M104 18 V282 M196 18 V282 M18 104 H282 M18 196 H282" />
        </g>
        {s.cells.map((v, idx) => (v !== 0 ? mark(idx, v) : null))}
        {hover !== null && s.cells[hover] === 0 && legal.has(tttName(hover)) && mark(hover, s.turn, true)}
        {winLine &&
          ((): JSX.Element => {
            const a = tttXY(winLine[0])
            const b = tttXY(winLine[2])
            const dx = Math.sign(b.x - a.x) * 16
            const dy = Math.sign(b.y - a.y) * 16
            return (
              <path
                className="ttt-stroke ttt-win"
                d={`M${a.x - dx} ${a.y - dy} L${b.x + dx} ${b.y + dy}`}
              />
            )
          })()}
        {s.cells.map((v, idx) => {
          const { x, y } = tttXY(idx)
          const canPlay = interactive && v === 0 && legal.has(tttName(idx))
          return (
            <rect
              key={`c${idx}`}
              className={`ttt-cell${canPlay ? ' is-empty' : ''}`}
              x={x - 46}
              y={y - 46}
              width={92}
              height={92}
              rx={10}
              onClick={canPlay ? () => onMove(tttName(idx)) : undefined}
              onMouseEnter={canPlay ? () => setHover(idx) : undefined}
              onMouseLeave={canPlay ? () => setHover((h) => (h === idx ? null : h)) : undefined}
            />
          )
        })}
      </svg>
    </div>
  )
}

// ===========================================================================
// Dispatcher
// ===========================================================================

export default function GridBoard(props: GameBoardProps): JSX.Element {
  useBoardSound(props.kind, props.state)
  switch (props.kind) {
    case 'othello':
      return <OthelloBoard {...props} />
    case 'connect4':
      return <Connect4Board {...props} />
    case 'hex':
      return <HexBoard {...props} />
    case 'morris':
      return <MorrisBoard {...props} />
    default:
      return <TicTacToeBoard {...props} />
  }
}
