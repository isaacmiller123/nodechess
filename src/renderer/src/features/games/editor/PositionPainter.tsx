import { useState, type JSX } from 'react'
import { Eraser, Paintbrush, Swords, Trash2, FlipVertical2 } from 'lucide-react'
import {
  cellIndex,
  classicArmies,
  emptyBoard,
  PIECE_PALETTE,
  type BoardCells,
  type PieceLetter
} from './model'
import { PieceGlyph } from './PieceGlyph'

type Brush = { kind: 'piece'; color: 'white' | 'black'; letter: PieceLetter } | { kind: 'erase' }

const FILE_LABELS = 'abcdefghijkl'

/**
 * Click-to-place start-position painter. Pick a brush from the two piece
 * palettes (or the eraser), then paint squares; clicking a square that already
 * holds the brushed piece erases it (fast toggling). Drag-painting works too.
 * Squares paint on mouseover while the button is held.
 */
export function PositionPainter({
  files,
  ranks,
  board,
  onChange,
  disabled,
  disabledNote
}: {
  files: number
  ranks: number
  board: BoardCells
  onChange(next: BoardCells): void
  disabled?: boolean
  /** Shown over the board when disabled (parent-locked variants). */
  disabledNote?: string
}): JSX.Element {
  const [brush, setBrush] = useState<Brush>({ kind: 'piece', color: 'white', letter: 'p' })
  const [painting, setPainting] = useState(false)

  const applyBrush = (file: number, rank: number, toggle: boolean): void => {
    const i = cellIndex(files, ranks, file, rank)
    const cur = board[i]
    let next: BoardCells | null = null
    if (brush.kind === 'erase') {
      if (cur) {
        next = board.slice()
        next[i] = null
      }
    } else {
      const same = cur && cur.color === brush.color && cur.letter === brush.letter
      if (same && toggle) {
        next = board.slice()
        next[i] = null
      } else if (!same) {
        next = board.slice()
        next[i] = { color: brush.color, letter: brush.letter }
      }
    }
    if (next) onChange(next)
  }

  const mirrorToBlack = (): void => {
    const next = board.slice()
    // wipe black, then mirror white across the horizontal axis
    for (let i = 0; i < next.length; i++) if (next[i]?.color === 'black') next[i] = null
    for (let rank = 0; rank < ranks; rank++) {
      for (let file = 0; file < files; file++) {
        const cell = board[cellIndex(files, ranks, file, rank)]
        if (cell?.color === 'white') {
          next[cellIndex(files, ranks, file, ranks - 1 - rank)] = {
            color: 'black',
            letter: cell.letter
          }
        }
      }
    }
    onChange(next)
  }

  const paletteRow = (color: 'white' | 'black'): JSX.Element => (
    <div className="vl-palette-row" role="group" aria-label={`${color} pieces`}>
      {PIECE_PALETTE.map((def) => {
        const active =
          brush.kind === 'piece' && brush.color === color && brush.letter === def.letter
        return (
          <button
            key={def.letter}
            type="button"
            className={`vl-palette-piece${active ? ' is-active' : ''}${def.betza ? ' is-fairy' : ''}`}
            title={`${def.name}: ${def.moves}${def.betza ? ` (Betza ${def.betza})` : ''}`}
            onClick={() => setBrush({ kind: 'piece', color, letter: def.letter })}
            disabled={disabled}
          >
            <PieceGlyph letter={def.letter} color={color} size={30} />
          </button>
        )
      })}
    </div>
  )

  const squares: JSX.Element[] = []
  for (let rank = ranks - 1; rank >= 0; rank--) {
    for (let file = 0; file < files; file++) {
      const dark = (file + rank) % 2 === 0
      const piece = board[cellIndex(files, ranks, file, rank)]
      squares.push(
        <button
          key={`${file}-${rank}`}
          type="button"
          tabIndex={-1}
          className={`vl-sq ${dark ? 'is-dark' : 'is-light'}`}
          aria-label={`${FILE_LABELS[file]}${rank + 1}`}
          disabled={disabled}
          onMouseDown={(e) => {
            if (e.button !== 0) return
            setPainting(true)
            applyBrush(file, rank, true)
          }}
          onMouseEnter={() => {
            if (painting) applyBrush(file, rank, false)
          }}
        >
          {file === 0 && <span className="vl-coord vl-coord-rank">{rank + 1}</span>}
          {rank === 0 && <span className="vl-coord vl-coord-file">{FILE_LABELS[file]}</span>}
          {piece && <PieceGlyph letter={piece.letter} color={piece.color} />}
        </button>
      )
    }
  }

  return (
    <div className="vl-painter" onMouseUp={() => setPainting(false)} onMouseLeave={() => setPainting(false)}>
      {paletteRow('black')}
      <div className="vl-board-frame">
        <div
          className={`vl-board${disabled ? ' is-locked' : ''}`}
          style={{ gridTemplateColumns: `repeat(${files}, 1fr)`, aspectRatio: `${files} / ${ranks}` }}
        >
          {squares}
        </div>
        {disabled && disabledNote && (
          <div className="vl-board-lock" role="note">
            <Swords size={18} aria-hidden />
            {disabledNote}
          </div>
        )}
      </div>
      {paletteRow('white')}
      <div className="vl-painter-tools">
        <button
          type="button"
          className={`vl-tool${brush.kind === 'erase' ? ' is-active' : ''}`}
          onClick={() => setBrush({ kind: 'erase' })}
          disabled={disabled}
        >
          <Eraser size={14} aria-hidden /> Eraser
        </button>
        <button
          type="button"
          className="vl-tool"
          onClick={() => onChange(classicArmies(files, ranks))}
          disabled={disabled}
          title="Fill both sides with the classic army for this board size"
        >
          <Paintbrush size={14} aria-hidden /> Classic armies
        </button>
        <button
          type="button"
          className="vl-tool"
          onClick={mirrorToBlack}
          disabled={disabled}
          title="Rebuild Black as a mirror of White's setup"
        >
          <FlipVertical2 size={14} aria-hidden /> Mirror to Black
        </button>
        <button
          type="button"
          className="vl-tool is-danger"
          onClick={() => onChange(emptyBoard(files, ranks))}
          disabled={disabled}
        >
          <Trash2 size={14} aria-hidden /> Clear
        </button>
      </div>
    </div>
  )
}
