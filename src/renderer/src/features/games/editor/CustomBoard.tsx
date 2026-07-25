import { useMemo, useState, type CSSProperties, type JSX } from 'react'
import type { GameBoardProps } from '../../../games/registry'
import { getGame } from '../../../games/registry'
import type { GameKind } from '../../../games/kernel'
import type { CustomVariantState } from '../../../games/customVariants'
import { cellIndex, parseFenBoard, paletteDef } from './model'
import { PieceGlyph } from './PieceGlyph'

const FILE_LABELS = 'abcdefghijkl'

// ffish UCI for custom variants: drops 'P@e4' (letter always uppercase) and
// from-to with an optional promotion suffix ('q' letter or shogi-style '+').
// Two-digit rank 10 MUST come before [1-9] in the alternation, and files run
// a–l (12-wide largeboard limit). See games/customVariants.ts SQ.
const MOVE_PARTS = /^(?:([A-Z+]?)@([a-l](?:10|[1-9]))|([a-l](?:10|[1-9]))([a-l](?:10|[1-9]))([a-z+]?))$/

export interface ParsedMove {
  raw: string
  drop?: { letter: string; to: string }
  from?: string
  to?: string
  suffix?: string
}

// parseMove/squareName are pure and exported for scripts/test-custom-board-keys.mjs.
// They are the Variant Lab board's ONLY square/move codec (full UCI names
// like 'a10'; no chessgroundx keys here, this board renders its own grid).
export function parseMove(raw: string): ParsedMove | null {
  const m = MOVE_PARTS.exec(raw)
  if (!m) return null
  if (m[2]) return { raw, drop: { letter: m[1] || 'P', to: m[2] } }
  return { raw, from: m[3], to: m[4], suffix: m[5] || '' }
}

export function squareName(file: number, rank: number): string {
  return `${FILE_LABELS[file]}${rank + 1}`
}

type Selection = { type: 'square'; sq: string } | { type: 'pocket'; letter: string } | null

/**
 * Interactive 2D board for Variant Lab games: any size the engine supports,
 * any piece letter (fairy glyph composition + medallion fallback), click-move
 * with legal-destination dots, drop trays for pocket parents (crazyhouse /
 * placement) and a promotion picker when one from-to has several codas.
 * Presentation only per GameBoardProps: proposes onMove(uci), never validates.
 */
export default function CustomBoard({
  kind,
  state,
  orientation,
  interactive,
  onMove
}: GameBoardProps): JSX.Element {
  const s = state as CustomVariantState
  const spec = getGame(kind as GameKind)?.spec
  const files = spec?.board.files ?? 8
  const ranks = spec?.board.ranks ?? 8

  const [selected, setSelected] = useState<Selection>(null)
  const [promo, setPromo] = useState<{ from: string; to: string; options: ParsedMove[] } | null>(null)

  const board = useMemo(() => parseFenBoard(s.fen, files, ranks), [s.fen, files, ranks])
  const turn: 'white' | 'black' = s.fen.split(' ')[1] === 'b' ? 'black' : 'white'

  const legal = useMemo<ParsedMove[]>(() => {
    if (!spec || !interactive) return []
    const moves: ParsedMove[] = []
    for (const raw of spec.legalMoves(s)) {
      const p = parseMove(raw)
      if (p) moves.push(p)
    }
    return moves
  }, [spec, s, interactive])

  const pockets = useMemo(() => {
    const m = /\[([A-Za-z]*)\]/.exec(s.fen.split(' ')[0])
    if (!m) return null
    const white: string[] = []
    const black: string[] = []
    for (const ch of m[1]) {
      if (ch === ch.toUpperCase()) white.push(ch.toLowerCase())
      else black.push(ch)
    }
    return { white, black }
  }, [s.fen])

  /** Any legal drops at all? (placement starts pocket-only) */
  const hasDrops = useMemo(() => legal.some((p) => p.drop), [legal])

  const dests = useMemo(() => {
    const out = new Set<string>()
    if (!selected) return out
    for (const p of legal) {
      if (selected.type === 'square' && p.from === selected.sq) out.add(p.to!)
      if (selected.type === 'pocket' && p.drop && p.drop.letter.toLowerCase() === selected.letter) {
        out.add(p.drop.to)
      }
    }
    return out
  }, [legal, selected])

  const lastMove = useMemo(() => {
    const raw = s.moves.at(-1)
    if (!raw) return null
    const p = parseMove(raw)
    if (!p) return null
    return p.drop ? { from: null, to: p.drop.to } : { from: p.from!, to: p.to! }
  }, [s.moves])

  const clearSelection = (): void => {
    setSelected(null)
    setPromo(null)
  }

  const clickSquare = (file: number, rank: number): void => {
    if (!interactive || !board) return
    const sq = squareName(file, rank)
    const piece = board[cellIndex(files, ranks, file, rank)]

    if (selected && dests.has(sq)) {
      if (selected.type === 'pocket') {
        const mv = legal.find(
          (p) => p.drop && p.drop.letter.toLowerCase() === selected.letter && p.drop.to === sq
        )
        clearSelection()
        if (mv) onMove(mv.raw)
        return
      }
      const candidates = legal.filter((p) => p.from === selected.sq && p.to === sq)
      if (candidates.length === 1) {
        clearSelection()
        onMove(candidates[0].raw)
        return
      }
      // several codas (promotion letters / '+'), let the player choose
      setPromo({ from: selected.sq, to: sq, options: candidates })
      return
    }

    if (piece && piece.color === turn) {
      setSelected(selected?.type === 'square' && selected.sq === sq ? null : { type: 'square', sq })
      setPromo(null)
      return
    }
    clearSelection()
  }

  const flip = orientation === 'black'
  const squares: JSX.Element[] = []
  for (let row = 0; row < ranks; row++) {
    const rank = flip ? row : ranks - 1 - row
    for (let col = 0; col < files; col++) {
      const file = flip ? files - 1 - col : col
      const sq = squareName(file, rank)
      const dark = (file + rank) % 2 === 0
      const piece = board ? board[cellIndex(files, ranks, file, rank)] : null
      const isSel = selected?.type === 'square' && selected.sq === sq
      const isDest = dests.has(sq)
      const isLast = lastMove !== null && (lastMove.from === sq || lastMove.to === sq)
      squares.push(
        <button
          key={sq}
          type="button"
          tabIndex={-1}
          className={[
            'vl-sq',
            dark ? 'is-dark' : 'is-light',
            isSel ? 'is-selected' : '',
            isDest ? (piece ? 'is-capture-dest' : 'is-dest') : '',
            isLast ? 'is-last' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => clickSquare(file, rank)}
          aria-label={sq}
        >
          {col === 0 && <span className="vl-coord vl-coord-rank">{rank + 1}</span>}
          {row === ranks - 1 && <span className="vl-coord vl-coord-file">{FILE_LABELS[file]}</span>}
          {piece && <PieceGlyph letter={piece.letter} color={piece.color} />}
        </button>
      )
    }
  }

  const tray = (color: 'white' | 'black'): JSX.Element | null => {
    if (!pockets || (!hasDrops && pockets.white.length === 0 && pockets.black.length === 0)) {
      return null
    }
    const letters = pockets[color]
    // aggregate counts per letter
    const counts = new Map<string, number>()
    for (const l of letters) counts.set(l, (counts.get(l) ?? 0) + 1)
    return (
      <div className={`vl-tray is-${color}`} aria-label={`${color} pieces in hand`}>
        {counts.size === 0 && <span className="vl-tray-empty">no pieces in hand</span>}
        {[...counts.entries()].map(([letter, n]) => {
          const active = selected?.type === 'pocket' && selected.letter === letter && turn === color
          return (
            <button
              key={letter}
              type="button"
              className={`vl-tray-piece${active ? ' is-active' : ''}`}
              disabled={!interactive || turn !== color}
              onClick={() => {
                setPromo(null)
                setSelected(active ? null : { type: 'pocket', letter })
              }}
              title={paletteDef(letter)?.name ?? letter.toUpperCase()}
            >
              <PieceGlyph letter={letter} color={color} size={30} />
              {n > 1 && <span className="vl-tray-count">{n}</span>}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    // --vl-files/--vl-ranks let the play layout cap the board's width by its
    // aspect ratio (editor.css .vl-play .vl-play-board height budget).
    <div
      className="vl-play-board"
      style={{ '--vl-files': files, '--vl-ranks': ranks } as CSSProperties}
    >
      {tray(flip ? 'white' : 'black')}
      <div className="vl-board-frame">
        <div
          className="vl-board is-live"
          style={{ gridTemplateColumns: `repeat(${files}, 1fr)`, aspectRatio: `${files} / ${ranks}` }}
        >
          {squares}
        </div>
        {promo && (
          <div className="vl-promo" role="dialog" aria-label="Choose promotion">
            {promo.options.map((opt) => (
              <button
                key={opt.raw}
                type="button"
                className="vl-promo-choice"
                onClick={() => {
                  clearSelection()
                  onMove(opt.raw)
                }}
              >
                {opt.suffix && opt.suffix !== '+' ? (
                  <PieceGlyph letter={opt.suffix} color={turn} size={34} />
                ) : (
                  <span className="vl-promo-label">{opt.suffix === '+' ? 'promote' : 'keep'}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      {tray(flip ? 'black' : 'white')}
    </div>
  )
}
