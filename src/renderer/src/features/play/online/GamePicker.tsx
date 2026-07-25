// Host-card game picker (spec §Library UI: "Online reuses OnlineTab machinery
// parameterized by kind"). A compact custom select over the kernel registry:
// the trigger shows the chosen game's icon + name; the popup lists every
// registered game grouped by family. Chess stays the default. Picking it
// keeps the wire config byte-identical to pre-v4 hosts.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { GameFamily, GameKind } from '../../../games/kernel'
import { listGames } from '../../../games/registry'

// ---------------------------------------------------------------------------
// Compact per-kind icons, 22px vector glyphs. Chess family renders the piece
// glyph most iconic for the variant on a mini checker tile; the other families
// get miniature versions of their library-card art language (discs, stones,
// grids). All self-contained SVG, no emoji, currentColor-friendly chrome.
// ---------------------------------------------------------------------------

const CHESS_GLYPH: Partial<Record<GameKind, string>> = {
  chess: '♞',
  chess960: '♚',
  crazyhouse: '♟',
  atomic: '♛',
  antichess: '♙',
  kingofthehill: '♔',
  threecheck: '♕',
  horde: '♙',
  racingkings: '♖',
  placement: '♗'
}

const KIND_HUE: Record<GameFamily, number> = { chess: 210, draughts: 4, go: 32, grid: 262 }

export function GameIcon({ kind, family }: { kind: string; family: GameFamily }): JSX.Element {
  const hue = KIND_HUE[family]
  let body: JSX.Element
  switch (kind) {
    case 'xiangqi':
    case 'janggi':
      body = (
        <>
          <circle cx={11} cy={11} r={7.5} fill="#f3e9d2" stroke={`hsl(${kind === 'xiangqi' ? 8 : 205} 65% 42%)`} strokeWidth={1.6} />
          <text x={11} y={14.4} textAnchor="middle" fontSize={9.5} fontWeight={700} fill={`hsl(${kind === 'xiangqi' ? 8 : 205} 70% 34%)`}>
            {kind === 'xiangqi' ? '將' : '漢'}
          </text>
        </>
      )
      break
    case 'shogi':
      body = (
        <>
          <path d="M11 3.2 L16 6.6 L17.2 17.4 L4.8 17.4 L6 6.6 Z" fill="#f0e3c0" stroke="#a3874f" strokeWidth={1.3} />
          <text x={11} y={14.2} textAnchor="middle" fontSize={8.5} fontWeight={700} fill="#4a3418">
            王
          </text>
        </>
      )
      break
    case 'go':
    case 'gomoku': {
      const grid: JSX.Element[] = []
      for (let i = 0; i < 4; i++) {
        grid.push(
          <line key={`h${i}`} x1={3} y1={4.5 + i * 4.4} x2={19} y2={4.5 + i * 4.4} stroke="rgba(60,38,8,0.55)" strokeWidth={0.8} />,
          <line key={`v${i}`} x1={4.5 + i * 4.4} y1={3} x2={4.5 + i * 4.4} y2={19} stroke="rgba(60,38,8,0.55)" strokeWidth={0.8} />
        )
      }
      body = (
        <>
          <rect x={2} y={2} width={18} height={18} rx={2.5} fill="#e0b96f" />
          {grid}
          {kind === 'go' ? (
            <>
              <circle cx={8.9} cy={8.9} r={3.1} fill="#1c1c1e" />
              <circle cx={13.3} cy={13.3} r={3.1} fill="#f4f4f2" stroke="rgba(0,0,0,0.25)" strokeWidth={0.6} />
            </>
          ) : (
            <>
              <circle cx={4.5} cy={13.3} r={2.2} fill="#1c1c1e" />
              <circle cx={8.9} cy={13.3} r={2.2} fill="#1c1c1e" />
              <circle cx={13.3} cy={13.3} r={2.2} fill="#1c1c1e" />
              <circle cx={8.9} cy={8.9} r={2.2} fill="#f4f4f2" stroke="rgba(0,0,0,0.25)" strokeWidth={0.6} />
              <circle cx={13.3} cy={4.5} r={2.2} fill="#f4f4f2" stroke="rgba(0,0,0,0.25)" strokeWidth={0.6} />
            </>
          )}
        </>
      )
      break
    }
    case 'checkers':
    case 'checkers-intl': {
      const n = kind === 'checkers' ? 4 : 5
      const step = 18 / n
      const cells: JSX.Element[] = []
      for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++)
          if ((r + c) % 2 === 1) cells.push(<rect key={`${r}${c}`} x={2 + c * step} y={2 + r * step} width={step} height={step} fill="rgba(0,0,0,0.38)" />)
      body = (
        <>
          <rect x={2} y={2} width={18} height={18} rx={2.5} fill={`hsl(${kind === 'checkers' ? 0 : 350} 30% 72%)`} />
          {cells}
          <circle cx={2 + step * 1.5} cy={2 + step * 0.5} r={step * 0.36} fill="#8c2727" stroke="#571313" strokeWidth={0.7} />
          <circle cx={2 + step * (n - 1.5)} cy={2 + step * (n - 0.5)} r={step * 0.36} fill="#f1e8da" stroke="#b8ab93" strokeWidth={0.7} />
        </>
      )
      break
    }
    case 'othello':
      body = (
        <>
          <rect x={2} y={2} width={18} height={18} rx={2.5} fill="#1e6b43" />
          <line x1={11} y1={2} x2={11} y2={20} stroke="rgba(0,0,0,0.3)" strokeWidth={0.8} />
          <line x1={2} y1={11} x2={20} y2={11} stroke="rgba(0,0,0,0.3)" strokeWidth={0.8} />
          <circle cx={6.8} cy={6.8} r={3} fill="#161618" />
          <circle cx={15.2} cy={6.8} r={3} fill="#f2f2ef" />
          <circle cx={6.8} cy={15.2} r={3} fill="#f2f2ef" />
          <circle cx={15.2} cy={15.2} r={3} fill="#161618" />
        </>
      )
      break
    case 'connect4':
      body = (
        <>
          <rect x={2} y={3.5} width={18} height={15.5} rx={2.5} fill="#2456a8" />
          {[0, 1, 2].map((c) =>
            [0, 1].map((r) => (
              <circle
                key={`${c}${r}`}
                cx={6 + c * 5}
                cy={8 + r * 5.6}
                r={2.1}
                fill={(c + r) % 2 ? '#e8c73a' : '#c8372f'}
              />
            ))
          )}
        </>
      )
      break
    case 'hex':
      body = (
        <>
          <path d="M11 2.6 L18.4 6.8 L18.4 15.2 L11 19.4 L3.6 15.2 L3.6 6.8 Z" fill="hsl(262 40% 40%)" stroke="hsl(262 55% 66%)" strokeWidth={1.4} />
          <circle cx={8.4} cy={9.4} r={2} fill="#f2f2ef" />
          <circle cx={13.6} cy={12.6} r={2} fill="#161618" />
        </>
      )
      break
    case 'morris':
      body = (
        <>
          <rect x={3} y={3} width={16} height={16} rx={1.5} fill="none" stroke="rgba(200,180,140,0.9)" strokeWidth={1.2} />
          <rect x={7.5} y={7.5} width={7} height={7} fill="none" stroke="rgba(200,180,140,0.7)" strokeWidth={1} />
          <line x1={11} y1={3} x2={11} y2={7.5} stroke="rgba(200,180,140,0.7)" strokeWidth={1} />
          <line x1={11} y1={14.5} x2={11} y2={19} stroke="rgba(200,180,140,0.7)" strokeWidth={1} />
          <circle cx={3} cy={3} r={2} fill="#e8dcc0" />
          <circle cx={19} cy={3} r={2} fill="#e8dcc0" />
          <circle cx={11} cy={19} r={2} fill="#3a3a3c" />
        </>
      )
      break
    case 'tictactoe':
      body = (
        <>
          <path d="M8.2 2.5 V19.5 M13.8 2.5 V19.5 M2.5 8.2 H19.5 M2.5 13.8 H19.5" stroke="rgba(220,220,230,0.6)" strokeWidth={1.3} strokeLinecap="round" />
          <path d="M3.6 3.6 L6.8 6.8 M6.8 3.6 L3.6 6.8" stroke="hsl(200 80% 62%)" strokeWidth={1.6} strokeLinecap="round" />
          <circle cx={16.8} cy={16.8} r={2} fill="none" stroke="hsl(6 80% 62%)" strokeWidth={1.6} />
        </>
      )
      break
    case 'makruk':
      body = (
        <>
          <rect x={2} y={2} width={18} height={18} rx={2.5} fill="hsl(45 35% 62%)" />
          <ellipse cx={11} cy={16} rx={5.4} ry={1.8} fill="rgba(0,0,0,0.3)" />
          <path d="M5.8 16 Q6.6 6.8 11 4.6 Q15.4 6.8 16.2 16 Z" fill="#efe2c2" stroke="#a68d5c" strokeWidth={1.1} />
        </>
      )
      break
    default: {
      // Chess family: mini checker tile + the variant's piece glyph.
      body = (
        <>
          <rect x={2} y={2} width={18} height={18} rx={2.5} fill={`hsl(${hue} 22% 30%)`} />
          <rect x={2} y={2} width={9} height={9} fill="rgba(255,255,255,0.10)" />
          <rect x={11} y={11} width={9} height={9} fill="rgba(255,255,255,0.10)" />
          <text x={11} y={17} textAnchor="middle" fontSize={15} fill="#f0f0f4" style={{ fontFamily: 'serif' }}>
            {CHESS_GLYPH[kind as GameKind] ?? '♟'}
          </text>
        </>
      )
    }
  }
  return (
    <svg viewBox="0 0 22 22" className="gamepick-icon" aria-hidden focusable="false">
      {body}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

const FAMILY_LABEL: Record<GameFamily, string> = {
  chess: 'Chess & variants',
  draughts: 'Draughts',
  go: 'Go',
  grid: 'Classics'
}
const FAMILY_ORDER: GameFamily[] = ['chess', 'draughts', 'go', 'grid']

export interface GamePickerProps {
  value: GameKind
  onChange: (kind: GameKind) => void
  disabled?: boolean
}

export function GamePicker({ value, onChange, disabled }: GamePickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Close on outside click / Escape (standard custom-select behavior).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = useCallback(
    (kind: GameKind) => {
      onChange(kind)
      setOpen(false)
    },
    [onChange]
  )

  const games = listGames()
  const current = games.find((g) => g.spec.kind === value) ?? games[0]

  return (
    <div className="gamepick" ref={rootRef}>
      <button
        type="button"
        className={`gamepick-trigger${open ? ' is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Game: ${current.spec.title}`}
      >
        <GameIcon kind={current.spec.kind} family={current.spec.family} />
        <span className="gamepick-name">{current.spec.title}</span>
        <ChevronDown size={15} className={`gamepick-chevron${open ? ' is-open' : ''}`} aria-hidden />
      </button>

      {open && (
        <div className="gamepick-pop" role="listbox" aria-label="Choose a game">
          {FAMILY_ORDER.map((family) => {
            const members = games.filter((g) => g.spec.family === family)
            if (members.length === 0) return null
            return (
              <div key={family} className="gamepick-group">
                <span className="gamepick-group-title">{FAMILY_LABEL[family]}</span>
                <div className="gamepick-options">
                  {members.map((g) => (
                    <button
                      key={g.spec.kind}
                      type="button"
                      role="option"
                      aria-selected={g.spec.kind === value}
                      className={`gamepick-option${g.spec.kind === value ? ' is-selected' : ''}`}
                      title={g.spec.tagline}
                      onClick={() => pick(g.spec.kind)}
                    >
                      <GameIcon kind={g.spec.kind} family={g.spec.family} />
                      <span className="gamepick-option-name">{g.spec.title}</span>
                      {g.spec.kind === value && <Check size={13} className="gamepick-check" aria-hidden />}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
