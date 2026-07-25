import { useMemo, type JSX } from 'react'
import { parseFenBoard, cellIndex, type BoardCells } from './model'
import { PieceGlyph } from './PieceGlyph'

/**
 * Read-only mini board for gallery cards and template tiles. Renders any
 * FEN body at any board size with the active piece set. Decorative.
 */
export function MiniBoard({
  fen,
  files,
  ranks,
  board
}: {
  fen?: string | null
  files: number
  ranks: number
  /** Pre-parsed cells win over `fen`. */
  board?: BoardCells | null
}): JSX.Element {
  const cells = useMemo<BoardCells | null>(() => {
    if (board) return board
    if (fen) return parseFenBoard(fen, files, ranks)
    return null
  }, [board, fen, files, ranks])

  const squares: JSX.Element[] = []
  for (let rank = ranks - 1; rank >= 0; rank--) {
    for (let file = 0; file < files; file++) {
      const dark = (file + rank) % 2 === 0
      const piece = cells ? cells[cellIndex(files, ranks, file, rank)] : null
      squares.push(
        <span key={`${file}-${rank}`} className={`vl-mini-sq ${dark ? 'is-dark' : 'is-light'}`}>
          {piece && <PieceGlyph letter={piece.letter} color={piece.color} />}
        </span>
      )
    }
  }

  return (
    <span
      className="vl-mini-board"
      style={{
        gridTemplateColumns: `repeat(${files}, 1fr)`,
        aspectRatio: `${files} / ${ranks}`
      }}
      aria-hidden
    >
      {squares}
    </span>
  )
}
