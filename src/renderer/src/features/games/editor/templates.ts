// Variant Lab: start-from templates (PURE module, headless-testable).
//
// Each template is a complete EditorModel: picking one drops the user into the
// builder with a live, valid variant they can immediately play or riff on.

import {
  cellIndex,
  classicArmies,
  emptyBoard,
  type BoardCells,
  type EditorModel,
  type PieceLetter
} from './model'

export interface VariantTemplate {
  id: string
  title: string
  blurb: string
  model: EditorModel
}

function put(
  board: BoardCells,
  files: number,
  ranks: number,
  color: 'white' | 'black',
  letter: PieceLetter,
  squares: [number, number][]
): void {
  for (const [file, rank] of squares) {
    board[cellIndex(files, ranks, file, rank)] = { color, letter }
  }
}

function standardModel(): EditorModel {
  return {
    name: 'My Variant',
    description: 'Classic chess, ready to bend.',
    parent: 'chess',
    files: 8,
    ranks: 8,
    board: classicArmies(8, 8),
    royal: 'checkmate',
    castling: true,
    doubleStep: true,
    promotion: ['n', 'b', 'r', 'q']
  }
}

function pawnArmyModel(): EditorModel {
  const files = 8
  const ranks = 8
  const board = emptyBoard(files, ranks)
  // White: one king and THIRTY pawns. Ranks 2–4 full, six more on rank 5.
  put(board, files, ranks, 'white', 'k', [[4, 0]])
  const pawns: [number, number][] = []
  for (let f = 0; f < files; f++) for (let r = 1; r <= 3; r++) pawns.push([f, r])
  for (const f of [0, 1, 2, 5, 6, 7]) pawns.push([f, 4])
  put(board, files, ranks, 'white', 'p', pawns)
  // Black: the classic army.
  const classic = classicArmies(files, ranks)
  for (let i = 0; i < classic.length; i++) {
    const cell = classic[i]
    if (cell && cell.color === 'black') board[i] = cell
  }
  return {
    name: '30 Pawns Army',
    description: 'One king, thirty pawns: pure zerg rush against a classic army.',
    parent: 'chess',
    files,
    ranks,
    board,
    royal: 'checkmate',
    castling: true,
    doubleStep: true,
    promotion: ['n', 'b', 'r', 'q']
  }
}

function amazonModel(): EditorModel {
  const board = classicArmies(8, 8)
  // Queens become Amazons (queen + knight, betza QN).
  put(board, 8, 8, 'white', 'a', [[3, 0]])
  put(board, 8, 8, 'black', 'a', [[3, 7]])
  return {
    name: 'Amazon Queen',
    description: 'Your queen also moves like a knight. Terrifying. (Betza: QN)',
    parent: 'chess',
    files: 8,
    ranks: 8,
    board,
    royal: 'checkmate',
    castling: true,
    doubleStep: true,
    promotion: ['n', 'b', 'r', 'a']
  }
}

function nukeModel(): EditorModel {
  return {
    name: 'Nuclear Chess',
    description: 'Every capture detonates the 3×3 around it (pawns are blast-proof).',
    parent: 'atomic',
    files: 8,
    ranks: 8,
    board: classicArmies(8, 8),
    royal: 'checkmate',
    castling: true,
    doubleStep: true,
    promotion: ['n', 'b', 'r', 'q']
  }
}

function setupModel(): EditorModel {
  return {
    name: 'Setup Chess',
    description: 'Place your own back rank piece by piece, then play.',
    parent: 'placement',
    files: 8,
    ranks: 8,
    board: emptyBoard(8, 8), // parent-locked: placement's pocket start is its identity
    royal: 'checkmate',
    castling: true,
    doubleStep: true,
    promotion: ['n', 'b', 'r', 'q']
  }
}

function tinyModel(): EditorModel {
  return {
    name: 'Tiny Chess',
    description: '6×6 blitz brain: no bishops, no double step, straight to the fight.',
    parent: 'chess',
    files: 6,
    ranks: 6,
    board: classicArmies(6, 6),
    royal: 'checkmate',
    castling: false,
    doubleStep: false,
    promotion: ['n', 'r', 'q']
  }
}

function grandModel(): EditorModel {
  return {
    name: 'Grand Arena',
    description: '10×10 Grand Chess: Archbishops and Chancellors join the royal court.',
    parent: 'grand',
    files: 10,
    ranks: 10,
    board: emptyBoard(10, 10), // parent-locked
    royal: 'checkmate',
    castling: false,
    doubleStep: true,
    promotion: ['n', 'b', 'r', 'q']
  }
}

export const TEMPLATES: readonly VariantTemplate[] = [
  { id: 'standard', title: 'Standard Chess', blurb: 'The classic start, tweak anything.', model: standardModel() },
  { id: 'pawn-army', title: '30 Pawns Army', blurb: 'A king and thirty pawns vs the world.', model: pawnArmyModel() },
  { id: 'amazon', title: 'Amazon Queen', blurb: 'Queens that jump like knights.', model: amazonModel() },
  { id: 'nuke', title: 'Nuclear Chess', blurb: 'Captures explode, atomic rules.', model: nukeModel() },
  { id: 'setup', title: 'Setup Chess', blurb: 'Draft your own back rank first.', model: setupModel() },
  { id: 'tiny', title: 'Tiny 6×6', blurb: 'Los Alamos chess: small board, fast blood.', model: tinyModel() },
  { id: 'grand', title: 'Grand 10×10', blurb: 'The big board with fairy officers.', model: grandModel() }
] as const

export function templateById(id: string): VariantTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id)
}
