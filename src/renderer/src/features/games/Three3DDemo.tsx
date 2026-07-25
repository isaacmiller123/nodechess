// Dev harness for the shared 3D tabletop renderer (games/three/**).
//
// Reached ONLY via the `?three=<kind>` query flag (see main.tsx). Nothing in
// the app shell links here, and GamePage wiring is wave-2's. Renders static
// demo positions with fake-but-plausible interactions so every contract
// surface is visually verifiable now: drag+snap, click-to-place (spawn),
// capture lift-fade, othello flips, camera presets, orientation, art loader.
//
// Preview pattern: build renderer → serve out/renderer over http.server with a
// games-art copy alongside → open index.html?three=go&art=./games-art

import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import { advance } from '@react-three/fiber'
import type { GameKind } from '../../games/kernel'
import {
  Tabletop3D,
  type Tabletop3DHandle,
  type TabletopBoardShape,
  type TabletopColor,
  type TabletopPiece,
  type TabletopPos
} from '../../games/three'

interface Demo {
  kind: GameKind
  title: string
  board: TabletopBoardShape
  pieces: TabletopPiece[]
  /** Square-click behavior. */
  place?: 'stone' | 'othello' | 'drop'
  drag?: boolean
  flip?: boolean
}

let seq = 0
function P(file: number, rank: number, color: TabletopColor, type = 'stone'): TabletopPiece {
  return { id: `demo-${type}-${seq++}`, pos: { file, rank }, type, color }
}

function goDemo(): TabletopPiece[] {
  const B: Array<[number, number]> = [
    [3, 3], [2, 5], [4, 2], [4, 3], [16, 5], [16, 8], [15, 15], [13, 16], [16, 15],
    [15, 16], [16, 17], [5, 16], [3, 9], [2, 9], [9, 9], [9, 3], [6, 2], [14, 2],
    [10, 16], [7, 16], [16, 11]
  ]
  const W: Array<[number, number]> = [
    [5, 2], [5, 3], [8, 2], [15, 3], [12, 2], [16, 13], [16, 16], [17, 15], [17, 16],
    [17, 14], [3, 15], [2, 13], [3, 16], [13, 3], [14, 16], [15, 17], [10, 2], [2, 2],
    [16, 2], [9, 15]
  ]
  return [...B.map(([f, r]) => P(f, r, 'black')), ...W.map(([f, r]) => P(f, r, 'white'))]
}

function checkersDemo(): TabletopPiece[] {
  const white: Array<[number, number, string]> = [
    [2, 0, 'man'], [6, 0, 'man'], [1, 1, 'man'], [5, 1, 'man'], [2, 2, 'man'],
    [4, 2, 'man'], [3, 3, 'man'], [5, 5, 'king']
  ]
  const black: Array<[number, number, string]> = [
    [7, 7, 'man'], [3, 7, 'man'], [0, 6, 'man'], [4, 6, 'man'], [1, 5, 'man'],
    [6, 6, 'man'], [2, 4, 'man'], [6, 2, 'king']
  ]
  return [
    ...white.map(([f, r, t]) => P(f, r, 'white', t as string)),
    ...black.map(([f, r, t]) => P(f, r, 'black', t as string))
  ]
}

function othelloDemo(): TabletopPiece[] {
  const spots: Array<[number, number, TabletopColor]> = [
    [3, 3, 'white'], [4, 3, 'black'], [5, 3, 'black'], [2, 3, 'black'], [3, 2, 'white'],
    [4, 2, 'black'], [5, 2, 'black'], [2, 4, 'black'], [3, 4, 'black'], [4, 4, 'black'],
    [5, 4, 'white'], [3, 5, 'white'], [4, 5, 'black'], [5, 5, 'white'], [6, 4, 'white'],
    [4, 6, 'black']
  ]
  return spots.map(([f, r, c]) => P(f, r, c, 'disc'))
}

function connect4Demo(): TabletopPiece[] {
  const spots: Array<[number, number, TabletopColor]> = [
    [2, 0, 'white'], [2, 1, 'black'], [3, 0, 'black'], [3, 1, 'white'], [3, 2, 'white'],
    [3, 3, 'black'], [4, 0, 'white'], [4, 1, 'black'], [4, 2, 'white'], [5, 0, 'black'],
    [1, 0, 'black'], [6, 0, 'white']
  ]
  return spots.map(([f, r, c]) => P(f, r, c, 'disc'))
}

function gomokuDemo(): TabletopPiece[] {
  const B: Array<[number, number]> = [[7, 7], [8, 8], [9, 7], [6, 8], [10, 6], [8, 7]]
  const W: Array<[number, number]> = [[7, 8], [6, 6], [8, 6], [9, 9], [9, 8]]
  return [...B.map(([f, r]) => P(f, r, 'black')), ...W.map(([f, r]) => P(f, r, 'white'))]
}

function shogiDemo(): TabletopPiece[] {
  const pieces: TabletopPiece[] = []
  const back = ['l', 'n', 's', 'g', 'k', 'g', 's', 'n', 'l']
  back.forEach((t, f) => {
    pieces.push(P(f, 0, 'white', t))
    pieces.push(P(f, 8, 'black', t))
  })
  pieces.push(P(1, 1, 'white', 'b'), P(7, 1, 'white', 'r'))
  pieces.push(P(7, 7, 'black', 'b'), P(1, 7, 'black', 'r'))
  for (let f = 0; f < 9; f++) {
    if (f !== 2) pieces.push(P(f, 2, 'white', 'p'))
    if (f !== 6) pieces.push(P(f, 6, 'black', 'p'))
  }
  pieces.push(P(2, 3, 'white', 'p'), P(6, 5, 'black', '+p'))
  return pieces
}

function chessDemo(): TabletopPiece[] {
  // Italian Game middlegame: mixed material, both castled kings visible.
  const fen = 'r1bq1rk1/1pp2ppp/p1np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1'
  const pieces: TabletopPiece[] = []
  fen.split('/').forEach((row, i) => {
    let file = 0
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch)
        continue
      }
      pieces.push(
        P(file, 7 - i, ch === ch.toUpperCase() ? 'white' : 'black', ch.toLowerCase())
      )
      file++
    }
  })
  return pieces
}

function xiangqiDemo(): TabletopPiece[] {
  const pieces: TabletopPiece[] = []
  const back = ['r', 'n', 'b', 'a', 'k', 'a', 'b', 'n', 'r']
  back.forEach((t, f) => {
    pieces.push(P(f, 0, 'white', t))
    pieces.push(P(f, 9, 'black', t))
  })
  pieces.push(P(1, 2, 'white', 'c'), P(7, 2, 'white', 'c'))
  pieces.push(P(1, 7, 'black', 'c'), P(7, 7, 'black', 'c'))
  for (const f of [0, 2, 4, 6, 8]) {
    pieces.push(P(f, 3, 'white', 'p'))
    pieces.push(P(f, 6, 'black', 'p'))
  }
  return pieces
}

function makeDemos(): Record<string, Demo> {
  return {
    chess: {
      kind: 'chess',
      title: 'Chess (Poly Haven set)',
      board: { layout: 'cells', files: 8, ranks: 8 },
      pieces: chessDemo(),
      drag: true
    },
    go: {
      kind: 'go',
      title: 'Go 19×19',
      board: { layout: 'intersections', files: 19, ranks: 19 },
      pieces: goDemo(),
      place: 'stone',
      drag: true
    },
    checkers: {
      kind: 'checkers',
      title: 'Checkers 8×8',
      board: { layout: 'cells', files: 8, ranks: 8 },
      pieces: checkersDemo(),
      drag: true
    },
    othello: {
      kind: 'othello',
      title: 'Othello',
      board: { layout: 'cells', files: 8, ranks: 8 },
      pieces: othelloDemo(),
      place: 'othello',
      flip: true
    },
    connect4: {
      kind: 'connect4',
      title: 'Connect Four',
      board: { layout: 'holes', files: 7, ranks: 6 },
      pieces: connect4Demo(),
      place: 'drop'
    },
    gomoku: {
      kind: 'gomoku',
      title: 'Gomoku 15×15',
      board: { layout: 'intersections', files: 15, ranks: 15 },
      pieces: gomokuDemo(),
      place: 'stone',
      drag: true
    },
    shogi: {
      kind: 'shogi',
      title: 'Shogi (wedges)',
      board: { layout: 'cells', files: 9, ranks: 9 },
      pieces: shogiDemo(),
      drag: true
    },
    xiangqi: {
      kind: 'xiangqi',
      title: 'Xiangqi (tokens)',
      board: { layout: 'intersections', files: 9, ranks: 10 },
      pieces: xiangqiDemo(),
      drag: true
    }
  }
}

const BTN: CSSProperties = {
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 8,
  color: '#e8e2d6',
  padding: '6px 12px',
  font: '500 13px/1.2 Inter, system-ui, sans-serif',
  cursor: 'pointer'
}

export default function Three3DDemo({ kindParam }: { kindParam: string }): JSX.Element {
  const demos = useMemo(makeDemos, [])
  const demo = demos[kindParam] ?? demos.go
  // `&probe=f,r[;f,r…]` replaces the demo position with marker pieces at exact
  // squares: alignment/parity ground truth when eyeballing screenshots.
  const initialPieces = useMemo(() => {
    const probe = new URLSearchParams(window.location.search).get('probe')
    if (!probe) return demo.pieces
    return probe.split(';').map((pair, i) => {
      const [f, r] = pair.split(',').map(Number)
      return P(f, r, i % 2 === 0 ? 'black' : 'white', demo.pieces[0]?.type ?? 'stone')
    })
  }, [demo])
  const [pieces, setPieces] = useState<TabletopPiece[]>(initialPieces)
  const [topDown, setTopDown] = useState(false)
  const [orientation, setOrientation] = useState<TabletopColor>('white')
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [status, setStatus] = useState('drag a piece · click the board · orbit with the mouse')
  const handle = useRef<Tabletop3DHandle>(null)
  const nextColor = useRef<TabletopColor>('black')

  const artBase = useMemo(() => {
    const q = new URLSearchParams(window.location.search).get('art')
    return q === 'none' ? null : (q ?? './games-art')
  }, [])

  // Headless-verification hook: hidden tabs get no rAF, so R3F never draws.
  // Automated checks call window.__tabletopAdvance(performance.now()) in a
  // spin-wait loop to force frames (real-time deltas). Harness-only.
  useEffect(() => {
    const w = window as unknown as { __tabletopAdvance?: (t: number) => void }
    w.__tabletopAdvance = (t) => advance(t, true)
    return () => {
      delete w.__tabletopAdvance
    }
  }, [])

  const onSquareClick = (pos: TabletopPos): void => {
    setStatus(`click → file ${pos.file}, rank ${pos.rank}`)
    if (!demo.place) return
    setPieces((cur) => {
      if (demo.place === 'drop') {
        const inCol = cur.filter((p) => p.pos.file === pos.file)
        const rank = inCol.length
        if (rank >= demo.board.ranks) return cur
        const color = nextColor.current
        nextColor.current = color === 'black' ? 'white' : 'black'
        return [...cur, P(pos.file, rank, color, 'disc')]
      }
      if (cur.some((p) => p.pos.file === pos.file && p.pos.rank === pos.rank)) return cur
      const color = nextColor.current
      nextColor.current = color === 'black' ? 'white' : 'black'
      if (demo.place === 'othello') {
        // Demo-only pseudo-rule: flip orthogonal neighbours of the other color.
        const next = cur.map((p) => {
          const df = Math.abs(p.pos.file - pos.file)
          const dr = Math.abs(p.pos.rank - pos.rank)
          if (df + dr === 1 && p.color !== color) return { ...p, color }
          return p
        })
        return [...next, P(pos.file, pos.rank, color, 'disc')]
      }
      return [...cur, P(pos.file, pos.rank, color, 'stone')]
    })
  }

  const onPieceDrag = (id: string, from: TabletopPos, to: TabletopPos): void => {
    setStatus(`drag ${id}: ${from.file},${from.rank} → ${to.file},${to.rank}`)
    if (!demo.drag) return
    setPieces((cur) => {
      if (cur.some((p) => p.pos.file === to.file && p.pos.rank === to.rank && p.id !== id)) {
        return cur // occupied → renderer glides the piece back home
      }
      return cur.map((p) => (p.id === id ? { ...p, pos: to } : p))
    })
  }

  const captureOne = (): void => {
    setPieces((cur) => {
      if (cur.length === 0) return cur
      const idx = Math.floor(Math.random() * cur.length)
      setStatus(`captured ${cur[idx].id}`)
      return cur.filter((_, i) => i !== idx)
    })
  }

  const flipOne = (): void => {
    setPieces((cur) => {
      if (cur.length === 0) return cur
      const idx = Math.floor(Math.random() * cur.length)
      setStatus(`flipped ${cur[idx].id}`)
      return cur.map((p, i) =>
        i === idx ? { ...p, color: p.color === 'black' ? 'white' : 'black' } : p
      )
    })
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'radial-gradient(120% 90% at 50% 10%, #23201b 0%, #14120f 60%, #0c0b09 100%)',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '10px 14px',
          flexWrap: 'wrap',
          borderBottom: '1px solid rgba(255,255,255,0.07)'
        }}
      >
        <strong style={{ color: '#f0ead9', font: '600 14px Inter, system-ui, sans-serif' }}>
          Tabletop3D: {demo.title}
        </strong>
        {Object.keys(demos).map((k) => (
          <a
            key={k}
            href={`?three=${k}`}
            style={{
              ...BTN,
              textDecoration: 'none',
              opacity: k === kindParam || (demo === demos.go && k === 'go') ? 1 : 0.6
            }}
          >
            {k}
          </a>
        ))}
        <span style={{ flex: 1 }} />
        <button style={BTN} onClick={() => setTopDown((v) => !v)}>
          {topDown ? 'tilt view' : 'top-down'}
        </button>
        <button style={BTN} onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}>
          seat: {orientation}
        </button>
        <button style={BTN} onClick={captureOne}>
          capture one
        </button>
        {demo.flip ? (
          <button style={BTN} onClick={flipOne}>
            flip one
          </button>
        ) : null}
        <button style={BTN} onClick={() => setPieces(initialPieces)}>
          reset
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {unavailable ? (
          <div
            style={{
              color: '#d8ccb4',
              font: '400 15px Inter, system-ui, sans-serif',
              padding: 40,
              textAlign: 'center'
            }}
          >
            3D unavailable ({unavailable}). The app would fall back to the 2D board here.
          </div>
        ) : (
          <Tabletop3D
            ref={handle}
            kind={demo.kind}
            board={demo.board}
            pieces={pieces}
            orientation={orientation}
            interactive
            topDown={topDown}
            artBaseUrl={artBase}
            onSquareClick={onSquareClick}
            onPieceDrag={onPieceDrag}
            onUnavailable={(reason) => setUnavailable(reason)}
          />
        )}
      </div>
      <div
        style={{
          color: 'rgba(232,226,214,0.55)',
          font: '400 12px Inter, system-ui, sans-serif',
          padding: '8px 14px',
          borderTop: '1px solid rgba(255,255,255,0.05)'
        }}
      >
        {status} · art base: {artBase ?? 'procedural only'}
      </div>
    </div>
  )
}
