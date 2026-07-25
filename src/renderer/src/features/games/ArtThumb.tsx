import type { JSX } from 'react'

/**
 * Elegant vector art placeholders for coming-soon library cards. Each game
 * gets a hand-drawn motif in its own hue, never a gray box. Colors are
 * self-contained (dark-glass cards) with the hue as the only variable, so
 * the art reads well on every app theme.
 */

function Grid({
  n,
  size,
  inset = 10,
  stroke,
  intersections = false
}: {
  n: number
  size: number
  inset?: number
  stroke: string
  intersections?: boolean
}): JSX.Element {
  const span = size - inset * 2
  const cells = intersections ? n - 1 : n
  const step = span / cells
  const lines: JSX.Element[] = []
  for (let i = 0; i <= cells; i++) {
    const p = inset + i * step
    lines.push(<line key={`h${i}`} x1={inset} y1={p} x2={inset + span} y2={p} stroke={stroke} strokeWidth={1} />)
    lines.push(<line key={`v${i}`} x1={p} y1={inset} x2={p} y2={inset + span} stroke={stroke} strokeWidth={1} />)
  }
  return <g opacity={0.55}>{lines}</g>
}

/** Board intersection → pixel coordinate for an n-line intersection grid. */
function pt(i: number, n: number, size: number, inset = 10): number {
  return inset + (i * (size - inset * 2)) / (n - 1)
}

function Stones({
  spots,
  n,
  size,
  r = 6.5
}: {
  spots: [number, number, 'b' | 'w'][]
  n: number
  size: number
  r?: number
}): JSX.Element {
  return (
    <g>
      {spots.map(([x, y, c], i) => (
        <circle
          key={i}
          cx={pt(x, n, size)}
          cy={pt(y, n, size)}
          r={r}
          fill={c === 'b' ? '#1d2126' : '#f3f0e8'}
          stroke={c === 'b' ? '#000' : '#c9c4b6'}
          strokeWidth={0.8}
        />
      ))}
    </g>
  )
}

const S = 120 // viewBox side

function frame(hue: number): JSX.Element {
  return (
    <>
      <defs>
        <radialGradient id={`glow${hue}`} cx="30%" cy="20%" r="90%">
          <stop offset="0%" stopColor={`hsl(${hue} 55% 32%)`} />
          <stop offset="100%" stopColor={`hsl(${hue} 45% 14%)`} />
        </radialGradient>
      </defs>
      <rect width={S} height={S} rx={10} fill={`url(#glow${hue})`} />
    </>
  )
}

export function ArtThumb({ kind }: { kind: string }): JSX.Element {
  const line = 'rgba(255,255,255,0.75)'
  const soft = 'rgba(255,255,255,0.4)'
  let hue = 210
  let body: JSX.Element

  switch (kind) {
    case 'xiangqi':
    case 'janggi': {
      hue = kind === 'xiangqi' ? 8 : 205
      body = (
        <>
          <Grid n={8} size={S} stroke={soft} intersections />
          {/* palace diagonals */}
          <path d={`M${pt(2, 8, S)} ${pt(0, 8, S)} L${pt(4, 8, S)} ${pt(2, 8, S)} M${pt(4, 8, S)} ${pt(0, 8, S)} L${pt(2, 8, S)} ${pt(2, 8, S)}`} stroke={line} strokeWidth={1.2} fill="none" />
          {[[1, 3, '將'], [3, 1, '車'], [5, 4, '炮']].map(([x, y, ch], i) => (
            <g key={i}>
              <circle cx={pt(x as number, 8, S)} cy={pt(y as number, 8, S)} r={11} fill="#f5ecd7" stroke={`hsl(${hue} 70% 40%)`} strokeWidth={2} />
              <text x={pt(x as number, 8, S)} y={pt(y as number, 8, S) + 4} textAnchor="middle" fontSize={11} fill={`hsl(${hue} 75% 32%)`} fontWeight={700}>{ch}</text>
            </g>
          ))}
        </>
      )
      break
    }
    case 'shogi': {
      hue = 35
      const wedge = (x: number, y: number, s: number, ch: string): JSX.Element => (
        <g transform={`translate(${x} ${y}) scale(${s})`}>
          <path d="M0 -13 L9 -7 L11 11 L-11 11 L-9 -7 Z" fill="#f0e3c0" stroke="#a3874f" strokeWidth={1.4} />
          <text x={0} y={6} textAnchor="middle" fontSize={12} fill="#4a3418" fontWeight={700}>{ch}</text>
        </g>
      )
      body = (
        <>
          <Grid n={9} size={S} stroke={soft} />
          {wedge(42, 50, 1.35, '王')}
          {wedge(84, 76, 1.1, '歩')}
          {wedge(30, 92, 1.0, '銀')}
        </>
      )
      break
    }
    case 'makruk': {
      hue = 45
      body = (
        <>
          <Grid n={8} size={S} stroke={soft} />
          {[[30, 42], [66, 54], [54, 84]].map(([x, y], i) => (
            <g key={i}>
              <ellipse cx={x} cy={y + 8} rx={9} ry={3.5} fill="rgba(0,0,0,0.35)" />
              <path d={`M${x - 8} ${y + 8} Q${x - 7} ${y - 8} ${x} ${y - 11} Q${x + 7} ${y - 8} ${x + 8} ${y + 8} Z`} fill={i % 2 ? '#2b2318' : '#e8d9b8'} stroke={i % 2 ? '#0f0b06' : '#b7a071'} strokeWidth={1} />
            </g>
          ))}
        </>
      )
      break
    }
    case 'checkers':
    case 'checkers-intl': {
      hue = kind === 'checkers' ? 0 : 350
      const n = kind === 'checkers' ? 8 : 10
      const step = (S - 20) / n
      const squares: JSX.Element[] = []
      for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++)
          if ((r + c) % 2 === 1)
            squares.push(<rect key={`${r}-${c}`} x={10 + c * step} y={10 + r * step} width={step} height={step} fill="rgba(0,0,0,0.35)" />)
      const disc = (r: number, c: number, dark: boolean): JSX.Element => (
        <g key={`d${r}${c}`}>
          <circle cx={10 + (c + 0.5) * step} cy={10 + (r + 0.5) * step} r={step * 0.36} fill={dark ? '#7c2222' : '#efe6d8'} stroke={dark ? '#4d1111' : '#c0b39c'} strokeWidth={1.2} />
          <circle cx={10 + (c + 0.5) * step} cy={10 + (r + 0.5) * step} r={step * 0.2} fill="none" stroke={dark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.15)'} strokeWidth={1} />
        </g>
      )
      body = (
        <>
          <rect x={10} y={10} width={S - 20} height={S - 20} fill="rgba(255,255,255,0.12)" rx={3} />
          {squares}
          {disc(0, 1, true)}
          {disc(1, 2, true)}
          {disc(n - 1, n - 2, false)}
          {disc(n - 2, n - 3, false)}
          {disc(n - 2, n - 1, false)}
        </>
      )
      break
    }
    case 'go':
    case 'gomoku': {
      hue = kind === 'go' ? 30 : 268
      body = (
        <>
          <rect x={6} y={6} width={S - 12} height={S - 12} rx={4} fill={kind === 'go' ? '#c9a35f' : 'rgba(255,255,255,0.1)'} opacity={kind === 'go' ? 0.9 : 1} />
          <Grid n={9} size={S} stroke={kind === 'go' ? 'rgba(40,25,5,0.6)' : soft} intersections />
          {kind === 'go' ? (
            <Stones n={9} size={S} spots={[[2, 2, 'b'], [6, 2, 'w'], [3, 4, 'b'], [4, 3, 'w'], [5, 5, 'b'], [2, 6, 'w'], [6, 6, 'b']]} />
          ) : (
            <Stones n={9} size={S} spots={[[2, 6, 'b'], [3, 5, 'b'], [4, 4, 'b'], [5, 3, 'b'], [6, 2, 'b'], [3, 3, 'w'], [5, 5, 'w'], [2, 4, 'w']]} />
          )}
        </>
      )
      break
    }
    case 'othello': {
      hue = 150
      const step = (S - 24) / 4
      const cells: JSX.Element[] = []
      for (let i = 0; i <= 4; i++) {
        cells.push(<line key={`h${i}`} x1={12} y1={12 + i * step} x2={S - 12} y2={12 + i * step} stroke="rgba(0,0,0,0.4)" strokeWidth={1} />)
        cells.push(<line key={`v${i}`} x1={12 + i * step} y1={12} x2={12 + i * step} y2={S - 12} stroke="rgba(0,0,0,0.4)" strokeWidth={1} />)
      }
      const d = (c: number, r: number, black: boolean): JSX.Element => (
        <circle key={`o${c}${r}`} cx={12 + (c + 0.5) * step} cy={12 + (r + 0.5) * step} r={step * 0.38} fill={black ? '#16181c' : '#f2efe8'} stroke={black ? '#000' : '#c8c3b5'} strokeWidth={1} />
      )
      body = (
        <>
          <rect x={12} y={12} width={S - 24} height={S - 24} fill="#1d7a46" rx={3} />
          {cells}
          {d(1, 1, true)}
          {d(2, 2, true)}
          {d(2, 1, false)}
          {d(1, 2, false)}
          {d(3, 1, true)}
        </>
      )
      break
    }
    case 'hex': {
      hue = 190
      const hexAt = (cx: number, cy: number, r: number, fill: string): JSX.Element => {
        const pts = Array.from({ length: 6 }, (_, i) => {
          const a = Math.PI / 6 + (i * Math.PI) / 3
          return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`
        }).join(' ')
        return <polygon points={pts} fill={fill} stroke="rgba(255,255,255,0.5)" strokeWidth={1} key={`${cx}-${cy}`} />
      }
      const hexes: JSX.Element[] = []
      const r = 11
      for (let row = 0; row < 5; row++)
        for (let col = 0; col < 5; col++) {
          const cx = 22 + col * r * 1.74 + row * r * 0.87
          const cy = 22 + row * r * 1.5
          if (cx < S - 8) {
            const mark = (row === 2 && col >= 1 && col <= 3) || (row === 1 && col === 2)
            hexes.push(hexAt(cx, cy, r, mark ? 'hsl(190 70% 55% / 0.85)' : 'rgba(255,255,255,0.08)'))
          }
        }
      body = <>{hexes}</>
      break
    }
    case 'connect4': {
      hue = 220
      const holes: JSX.Element[] = []
      const step = (S - 28) / 6
      const colors = ['none', '#e8c33a', '#d84b40']
      const fillMap = [
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
        [0, 0, 2, 0, 0, 0],
        [0, 1, 1, 2, 0, 0],
        [2, 2, 1, 1, 2, 1]
      ]
      for (let r = 0; r < 5; r++)
        for (let c = 0; c < 6; c++) {
          const f = fillMap[r][c]
          holes.push(
            <circle key={`${r}${c}`} cx={17 + (c + 0.5) * step} cy={20 + (r + 0.5) * step} r={step * 0.36} fill={f ? colors[f] : 'hsl(220 45% 10%)'} stroke="rgba(0,0,0,0.4)" strokeWidth={1} />
          )
        }
      body = (
        <>
          <rect x={10} y={14} width={S - 20} height={S - 24} rx={8} fill="hsl(222 65% 45%)" />
          {holes}
        </>
      )
      break
    }
    case 'morris': {
      hue = 28
      const sq = (r: number): JSX.Element => <rect key={r} x={S / 2 - r} y={S / 2 - r} width={r * 2} height={r * 2} fill="none" stroke={line} strokeWidth={1.4} />
      body = (
        <>
          {sq(44)}
          {sq(29)}
          {sq(14)}
          <path d={`M${S / 2} ${S / 2 - 44} V${S / 2 - 14} M${S / 2} ${S / 2 + 14} V${S / 2 + 44} M${S / 2 - 44} ${S / 2} H${S / 2 - 14} M${S / 2 + 14} ${S / 2} H${S / 2 + 44}`} stroke={line} strokeWidth={1.4} />
          {[[S / 2 - 44, S / 2 - 44, 'w'], [S / 2, S / 2 - 29, 'b'], [S / 2 + 44, S / 2, 'w'], [S / 2 - 14, S / 2 + 14, 'b']].map(([x, y, c], i) => (
            <circle key={i} cx={x as number} cy={y as number} r={6.5} fill={c === 'b' ? '#1d2126' : '#f3f0e8'} stroke={c === 'b' ? '#000' : '#c9c4b6'} strokeWidth={0.8} />
          ))}
        </>
      )
      break
    }
    case 'tictactoe': {
      hue = 330
      body = (
        <>
          <path d="M46 22 V98 M74 22 V98 M22 46 H98 M22 74 H98" stroke={line} strokeWidth={3} strokeLinecap="round" />
          <path d="M28 28 L40 40 M40 28 L28 40" stroke="hsl(330 80% 66%)" strokeWidth={3.4} strokeLinecap="round" />
          <circle cx={60} cy={60} r={8} fill="none" stroke="hsl(200 85% 65%)" strokeWidth={3.4} />
          <path d="M80 80 L92 92 M92 80 L80 92" stroke="hsl(330 80% 66%)" strokeWidth={3.4} strokeLinecap="round" />
        </>
      )
      break
    }
    case 'custom-editor': {
      hue = 262
      body = (
        <>
          <Grid n={6} size={S} stroke={soft} />
          <path d="M40 78 L70 48 L78 56 L48 86 L38 88 Z" fill="hsl(262 70% 72%)" stroke="hsl(262 60% 40%)" strokeWidth={1.4} />
          <path d="M70 48 L78 56" stroke="hsl(262 60% 40%)" strokeWidth={1.4} />
          <g fill="rgba(255,255,255,0.85)">
            <path d="M88 24 l2.4 5.4 5.4 2.4 -5.4 2.4 -2.4 5.4 -2.4 -5.4 -5.4 -2.4 5.4 -2.4 Z" />
            <path d="M30 30 l1.6 3.6 3.6 1.6 -3.6 1.6 -1.6 3.6 -1.6 -3.6 -3.6 -1.6 3.6 -1.6 Z" />
          </g>
        </>
      )
      break
    }
    default: {
      body = <Grid n={8} size={S} stroke={soft} />
    }
  }

  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="art-thumb" role="img" aria-label={kind}>
      {frame(hue)}
      {body}
    </svg>
  )
}
