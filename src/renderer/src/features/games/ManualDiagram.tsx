import { lazy, Suspense, useMemo, type JSX } from 'react'
import { pieceSetClass } from '../../board/pieceSets'
import { useSettings } from '../../state/settings'
import { isRegisteredGame } from '../../games/registry'
import type { CatalogEntry } from './catalog'

// Manual board diagrams: renders the ```position fences of the authored
// manuals (resources/manuals/*.md) as real, rulebook-grade figures:
//   • FEN payloads (chess family) → the game's own 2D board, read-only.
//   • coordinate-DSL payloads (size/black/white/points/next) → a small SVG
//     in the same visual language as the live board (boards.css palette).
// Diagrams are decorative figures: no interaction, no coordinates chrome.

const ChessFamilyBoard = lazy(() => import('../../games/boards/ChessFamilyBoard'))

// ---------------------------------------------------------------------------
// payload parsing

interface DslPos {
  files: number
  ranks: number
  black: string[]
  white: string[]
  blackMen: string[]
  whiteMen: string[]
  points: string[]
  next: 'black' | 'white' | null
}

/** "c4" → zero-based {x, y} with y counted from the BOTTOM rank (rank 1). */
function sq(name: string): { x: number; y: number } | null {
  const m = /^([a-z])(\d+)$/.exec(name)
  if (!m) return null
  return { x: m[1].charCodeAt(0) - 97, y: Number(m[2]) - 1 }
}

function parseDsl(payload: string): DslPos | null {
  const pos: DslPos = {
    files: 0,
    ranks: 0,
    black: [],
    white: [],
    blackMen: [],
    whiteMen: [],
    points: [],
    next: null
  }
  for (const raw of payload.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const m = /^([a-z-]+):\s*(.*)$/.exec(line)
    if (!m) return null
    const val = m[2].trim()
    switch (m[1]) {
      case 'size': {
        const s = /^(\d+)x(\d+)$/.exec(val)
        if (!s) return null
        pos.files = Number(s[1])
        pos.ranks = Number(s[2])
        break
      }
      case 'black':
        pos.black = val.split(/\s+/).filter(Boolean)
        break
      case 'white':
        pos.white = val.split(/\s+/).filter(Boolean)
        break
      case 'black-men':
        pos.blackMen = val.split(/\s+/).filter(Boolean)
        break
      case 'white-men':
        pos.whiteMen = val.split(/\s+/).filter(Boolean)
        break
      case 'points':
        pos.points = val.split(/\s+/).filter(Boolean)
        break
      case 'next':
        pos.next = val === 'black' ? 'black' : val === 'white' ? 'white' : null
        break
      default:
        break
    }
  }
  return pos.files > 0 && pos.ranks > 0 ? pos : null
}

function captionOf(next: 'black' | 'white' | null, entry: CatalogEntry): string | null {
  if (!next) return null
  // Games where the sides have thematic names keep generic Black/White. The
  // manuals themselves use Black/White throughout.
  void entry
  return next === 'black' ? 'Black to play' : 'White to play'
}

// ---------------------------------------------------------------------------
// SVG diagram renderers (visual language mirrors boards.css)

const STONE_B = { fill: 'url(#mdStoneB)', stroke: 'rgba(0,0,0,0.7)' }
const STONE_W = { fill: 'url(#mdStoneW)', stroke: '#b9b2a2' }

function StoneDefs(): JSX.Element {
  return (
    <defs>
      <radialGradient id="mdStoneB" cx="35%" cy="30%" r="80%">
        <stop offset="0%" stopColor="#4c5158" />
        <stop offset="100%" stopColor="#16181c" />
      </radialGradient>
      <radialGradient id="mdStoneW" cx="35%" cy="30%" r="80%">
        <stop offset="0%" stopColor="#ffffff" />
        <stop offset="100%" stopColor="#d8d4c8" />
      </radialGradient>
      <radialGradient id="mdManW" cx="35%" cy="28%" r="80%">
        <stop offset="0%" stopColor="#fff9ea" />
        <stop offset="100%" stopColor="#cdbb92" />
      </radialGradient>
      <radialGradient id="mdManB" cx="35%" cy="28%" r="80%">
        <stop offset="0%" stopColor="#57524d" />
        <stop offset="100%" stopColor="#17130f" />
      </radialGradient>
    </defs>
  )
}

/** go / gomoku: stones on a wooden intersection grid. */
function GoDiagram({ pos }: { pos: DslPos }): JSX.Element {
  const n = pos.files
  const cell = 24
  const inset = cell
  const size = inset * 2 + (n - 1) * cell
  const at = (p: { x: number; y: number }): { cx: number; cy: number } => ({
    cx: inset + p.x * cell,
    cy: inset + (n - 1 - p.y) * cell
  })
  const lines: JSX.Element[] = []
  for (let i = 0; i < n; i++) {
    const p = inset + i * cell
    lines.push(
      <line key={`h${i}`} x1={inset} y1={p} x2={size - inset} y2={p} stroke="rgba(50,32,10,0.75)" strokeWidth={1} />,
      <line key={`v${i}`} x1={p} y1={inset} x2={p} y2={size - inset} stroke="rgba(50,32,10,0.75)" strokeWidth={1} />
    )
  }
  const stone = (name: string, black: boolean, i: number): JSX.Element | null => {
    const p = sq(name)
    if (!p) return null
    const { cx, cy } = at(p)
    const c = black ? STONE_B : STONE_W
    return <circle key={`${black ? 'b' : 'w'}${i}`} cx={cx} cy={cy} r={cell * 0.46} fill={c.fill} stroke={c.stroke} strokeWidth={0.8} />
  }
  return (
    <svg className="manual-diagram" viewBox={`0 0 ${size} ${size}`} role="img">
      <StoneDefs />
      <rect width={size} height={size} rx={6} fill="#dcb35c" />
      {lines}
      {pos.black.map((s, i) => stone(s, true, i))}
      {pos.white.map((s, i) => stone(s, false, i))}
    </svg>
  )
}

/** othello: discs on green felt cells. */
function OthelloDiagram({ pos }: { pos: DslPos }): JSX.Element {
  const n = pos.files
  const cell = 26
  const size = n * cell + 8
  const lines: JSX.Element[] = []
  for (let i = 0; i <= n; i++) {
    const p = 4 + i * cell
    lines.push(
      <line key={`h${i}`} x1={4} y1={p} x2={size - 4} y2={p} stroke="rgba(0,40,20,0.5)" strokeWidth={1} />,
      <line key={`v${i}`} x1={p} y1={4} x2={p} y2={size - 4} stroke="rgba(0,40,20,0.5)" strokeWidth={1} />
    )
  }
  const disc = (name: string, black: boolean, i: number): JSX.Element | null => {
    const p = sq(name)
    if (!p) return null
    const c = black ? STONE_B : STONE_W
    return (
      <circle
        key={`${black ? 'b' : 'w'}${i}`}
        cx={4 + (p.x + 0.5) * cell}
        cy={4 + (n - 1 - p.y + 0.5) * cell}
        r={cell * 0.4}
        fill={c.fill}
        stroke={c.stroke}
        strokeWidth={0.8}
      />
    )
  }
  return (
    <svg className="manual-diagram" viewBox={`0 0 ${size} ${size}`} role="img">
      <StoneDefs />
      <rect width={size} height={size} rx={6} fill="#0f7a4d" />
      {lines}
      {pos.black.map((s, i) => disc(s, true, i))}
      {pos.white.map((s, i) => disc(s, false, i))}
    </svg>
  )
}

/** checkers: men on the wooden checkerboard. */
function CheckersDiagram({ pos }: { pos: DslPos }): JSX.Element {
  const n = pos.files
  const cell = 26
  const size = n * cell
  const squares: JSX.Element[] = []
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      // (0,0) is a1 (dark on draughts boards): dark when x+y is even.
      const dark = (c + (n - 1 - r)) % 2 === 0
      squares.push(
        <rect key={`${r}-${c}`} x={c * cell} y={r * cell} width={cell} height={cell} fill={dark ? '#7d4a24' : '#ecd6ab'} />
      )
    }
  }
  const man = (name: string, black: boolean, i: number): JSX.Element | null => {
    const p = sq(name)
    if (!p) return null
    return (
      <g key={`${black ? 'b' : 'w'}${i}`}>
        <circle
          cx={(p.x + 0.5) * cell}
          cy={(n - 1 - p.y + 0.5) * cell}
          r={cell * 0.38}
          fill={black ? 'url(#mdManB)' : 'url(#mdManW)'}
          stroke={black ? '#0c0a07' : '#a5906a'}
          strokeWidth={1}
        />
        <circle
          cx={(p.x + 0.5) * cell}
          cy={(n - 1 - p.y + 0.5) * cell}
          r={cell * 0.24}
          fill="none"
          stroke={black ? 'rgba(255,255,255,0.16)' : 'rgba(110,85,40,0.3)'}
          strokeWidth={1}
        />
      </g>
    )
  }
  return (
    <svg className="manual-diagram" viewBox={`0 0 ${size} ${size}`} role="img">
      <StoneDefs />
      {squares}
      <rect x={0.5} y={0.5} width={size - 1} height={size - 1} fill="none" stroke="rgba(60,34,12,0.6)" strokeWidth={1} rx={3} />
      {pos.blackMen.map((s, i) => man(s, true, i))}
      {pos.whiteMen.map((s, i) => man(s, false, i))}
    </svg>
  )
}

/** connect four: the blue frame with punched holes. */
function Connect4Diagram({ pos }: { pos: DslPos }): JSX.Element {
  const cell = 30
  const w = pos.files * cell + 12
  const h = pos.ranks * cell + 12
  const holes: JSX.Element[] = []
  const stoneAt = new Map<string, 'b' | 'w'>()
  for (const s of pos.black) stoneAt.set(s, 'b')
  for (const s of pos.white) stoneAt.set(s, 'w')
  for (let x = 0; x < pos.files; x++) {
    for (let y = 0; y < pos.ranks; y++) {
      const name = `${String.fromCharCode(97 + x)}${y + 1}`
      const v = stoneAt.get(name)
      const cx = 6 + (x + 0.5) * cell
      const cy = 6 + (pos.ranks - 1 - y + 0.5) * cell
      holes.push(
        <circle
          key={name}
          cx={cx}
          cy={cy}
          r={cell * 0.36}
          fill={v === 'b' ? '#d84b40' : v === 'w' ? '#e8c33a' : '#141b2e'}
          stroke="rgba(0,0,10,0.45)"
          strokeWidth={1}
        />
      )
    }
  }
  return (
    <svg className="manual-diagram" viewBox={`0 0 ${w} ${h}`} role="img">
      <rect width={w} height={h} rx={8} fill="#2b62c4" />
      {holes}
    </svg>
  )
}

/** hex: the two-colored parallelogram grid. */
function HexDiagram({ pos }: { pos: DslPos }): JSX.Element {
  const n = pos.files
  const r = 13
  const stepX = r * Math.sqrt(3)
  const stepY = r * 1.5
  const w = stepX * n + stepX * (n - 1) * 0.5 + r * 2
  const h = stepY * (n - 1) + r * 2 + 8
  const at = (p: { x: number; y: number }): { cx: number; cy: number } => {
    const row = n - 1 - p.y // row 0 at top = highest rank
    return { cx: r + stepX / 2 + p.x * stepX + row * (stepX / 2), cy: r + 4 + row * stepY }
  }
  const hexPts = (cx: number, cy: number): string =>
    Array.from({ length: 6 }, (_, i) => {
      const a = Math.PI / 6 + (i * Math.PI) / 3
      return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`
    }).join(' ')
  const cells: JSX.Element[] = []
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const { cx, cy } = at({ x, y })
      cells.push(<polygon key={`${x}-${y}`} points={hexPts(cx, cy)} fill="#e9e4d8" stroke="#59524a" strokeWidth={1.1} />)
    }
  }
  const stone = (name: string, black: boolean, i: number): JSX.Element | null => {
    const p = sq(name)
    if (!p) return null
    const { cx, cy } = at(p)
    return (
      <circle
        key={`${black ? 'b' : 'w'}${i}`}
        cx={cx}
        cy={cy}
        r={r * 0.62}
        fill={black ? '#c0392b' : '#2a6fb8'}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth={1}
      />
    )
  }
  // Border strokes: red = left/right players' edges (rows), blue = top/bottom.
  const first = at({ x: 0, y: n - 1 })
  const lastTop = at({ x: n - 1, y: n - 1 })
  const firstBot = at({ x: 0, y: 0 })
  const lastBot = at({ x: n - 1, y: 0 })
  return (
    <svg className="manual-diagram" viewBox={`0 0 ${w} ${h}`} role="img">
      <line x1={first.cx - stepX / 2} y1={first.cy - r} x2={lastTop.cx + stepX / 2} y2={lastTop.cy - r} stroke="#c0392b" strokeWidth={3} />
      <line x1={firstBot.cx - stepX / 2} y1={firstBot.cy + r} x2={lastBot.cx + stepX / 2} y2={lastBot.cy + r} stroke="#c0392b" strokeWidth={3} />
      <line x1={first.cx - stepX / 2 - 2} y1={first.cy - r} x2={firstBot.cx - stepX / 2 - 2} y2={firstBot.cy + r} stroke="#2a6fb8" strokeWidth={3} />
      <line x1={lastTop.cx + stepX / 2 + 2} y1={lastTop.cy - r} x2={lastBot.cx + stepX / 2 + 2} y2={lastBot.cy + r} stroke="#2a6fb8" strokeWidth={3} />
      {cells}
      {pos.black.map((s, i) => stone(s, true, i))}
      {pos.white.map((s, i) => stone(s, false, i))}
    </svg>
  )
}

/** nine men's morris: the classic three-square line board. */
function MorrisDiagram({ pos }: { pos: DslPos }): JSX.Element {
  const size = 200
  const c = size / 2
  const rings = [81, 54, 27] // exact thirds of the outer ring → grid maps cleanly
  const at = (p: { x: number; y: number }): { cx: number; cy: number } => ({
    // 7x7 grid: a1 bottom-left … g7 top-right, mapped onto the square rings.
    cx: c + ((p.x - 3) / 3) * rings[0],
    cy: c - ((p.y - 3) / 3) * rings[0]
  })
  const lines: JSX.Element[] = []
  rings.forEach((r, i) =>
    lines.push(<rect key={`r${i}`} x={c - r} y={c - r} width={r * 2} height={r * 2} fill="none" stroke="#3d2a10" strokeWidth={2.4} />)
  )
  lines.push(
    <path
      key="cross"
      d={`M${c} ${c - rings[0]} V${c - rings[2]} M${c} ${c + rings[2]} V${c + rings[0]} M${c - rings[0]} ${c} H${c - rings[2]} M${c + rings[2]} ${c} H${c + rings[0]}`}
      stroke="#3d2a10"
      strokeWidth={2.4}
      fill="none"
    />
  )
  const nodes = pos.points
    .map((name, i) => {
      const p = sq(name)
      if (!p) return null
      const { cx, cy } = at(p)
      return <circle key={`n${i}`} cx={cx} cy={cy} r={4} fill="#3d2a10" />
    })
    .filter(Boolean)
  const man = (name: string, black: boolean, i: number): JSX.Element | null => {
    const p = sq(name)
    if (!p) return null
    const { cx, cy } = at(p)
    return (
      <circle
        key={`${black ? 'b' : 'w'}${i}`}
        cx={cx}
        cy={cy}
        r={9.5}
        fill={black ? 'url(#mdManB)' : 'url(#mdManW)'}
        stroke="rgba(20,12,2,0.55)"
        strokeWidth={1}
      />
    )
  }
  return (
    <svg className="manual-diagram" viewBox={`0 0 ${size} ${size}`} role="img">
      <StoneDefs />
      <rect width={size} height={size} rx={8} fill="#a9803f" stroke="#6d4c1e" strokeWidth={2} />
      {lines}
      {nodes}
      {pos.black.map((s, i) => man(s, true, i))}
      {pos.white.map((s, i) => man(s, false, i))}
    </svg>
  )
}

/** tic-tac-toe: strokes on the familiar grid (black = X, white = O). */
function TttDiagram({ pos }: { pos: DslPos }): JSX.Element {
  const size = 160
  const cell = size / 3
  const marks: JSX.Element[] = []
  const at = (p: { x: number; y: number }): { cx: number; cy: number } => ({
    cx: (p.x + 0.5) * cell,
    cy: (2 - p.y + 0.5) * cell
  })
  pos.black.forEach((name, i) => {
    const p = sq(name)
    if (!p) return
    const { cx, cy } = at(p)
    marks.push(
      <path
        key={`x${i}`}
        d={`M${cx - 13} ${cy - 13} L${cx + 13} ${cy + 13} M${cx + 13} ${cy - 13} L${cx - 13} ${cy + 13}`}
        stroke="#e2574c"
        strokeWidth={5}
        strokeLinecap="round"
        fill="none"
      />
    )
  })
  pos.white.forEach((name, i) => {
    const p = sq(name)
    if (!p) return
    const { cx, cy } = at(p)
    marks.push(<circle key={`o${i}`} cx={cx} cy={cy} r={14} fill="none" stroke="#4c9be2" strokeWidth={5} />)
  })
  return (
    <svg className="manual-diagram" viewBox={`0 0 ${size} ${size}`} role="img">
      <path
        d={`M${cell} 10 V${size - 10} M${cell * 2} 10 V${size - 10} M10 ${cell} H${size - 10} M10 ${cell * 2} H${size - 10}`}
        stroke="var(--border-strong, #666)"
        strokeWidth={5}
        strokeLinecap="round"
        fill="none"
      />
      {marks}
    </svg>
  )
}

// ---------------------------------------------------------------------------

function DslFigure({ entry, pos }: { entry: CatalogEntry; pos: DslPos }): JSX.Element | null {
  switch (entry.family) {
    case 'go':
      return <GoDiagram pos={pos} />
    case 'draughts':
      return <CheckersDiagram pos={pos} />
    case 'grid':
      switch (entry.kind) {
        case 'othello':
          return <OthelloDiagram pos={pos} />
        case 'connect4':
          return <Connect4Diagram pos={pos} />
        case 'hex':
          return <HexDiagram pos={pos} />
        case 'morris':
          return <MorrisDiagram pos={pos} />
        case 'tictactoe':
          return <TttDiagram pos={pos} />
        case 'gomoku':
          return <GoDiagram pos={pos} />
        default:
          return null
      }
    default:
      return null
  }
}

export function ManualDiagram({ entry, payload }: { entry: CatalogEntry; payload: string }): JSX.Element | null {
  const { settings } = useSettings()
  const text = payload.trim()
  const isFen = text.split(/\r?\n/).length === 1 && text.includes('/') && !text.includes(':')
  const dsl = useMemo(() => (isFen ? null : parseDsl(text)), [isFen, text])
  const fenState = useMemo(() => (isFen ? { fen: text, moves: [] as string[] } : null), [isFen, text])

  if (isFen && fenState && entry.family === 'chess' && isRegisteredGame(entry.kind)) {
    const caption = text.split(' ')[1] === 'b' ? 'Black to play' : 'White to play'
    return (
      <figure className="manual-figure is-board">
        <div className={`manual-cfb board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`}>
          <Suspense fallback={<div className="manual-diagram-loading" aria-hidden />}>
            <ChessFamilyBoard
              kind={entry.kind}
              state={fenState}
              orientation="white"
              interactive={false}
              onMove={() => undefined}
            />
          </Suspense>
        </div>
        <figcaption>{caption}</figcaption>
      </figure>
    )
  }

  if (dsl) {
    const fig = <DslFigure entry={entry} pos={dsl} />
    if (fig) {
      const caption = captionOf(dsl.next, entry)
      return (
        <figure className="manual-figure">
          {fig}
          {caption && <figcaption>{caption}</figcaption>}
        </figure>
      )
    }
  }

  // Unrenderable payload: keep the manual clean. No raw text dumps.
  return null
}
