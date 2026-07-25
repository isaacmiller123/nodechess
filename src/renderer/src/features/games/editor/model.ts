// Variant Lab — editor model + variants.ini generator (PURE module: no React,
// no window; bundled headless by scripts/test-custom-variants.mjs).
//
// The builder edits an EditorModel; generateIni() turns it into the
// Fairy-Stockfish variants.ini text that games/customVariants.ts loads through
// ffish. The ini text is what gets persisted — the model is reconstructed from
// it on edit (parseFenBoard + the saved def's dims), and raw-mode power users
// can bypass the model entirely.

// ---------------------------------------------------------------------------
// Piece palette

export type PieceLetter = 'p' | 'n' | 'b' | 'r' | 'q' | 'k' | 'a' | 'c' | 'h'

export interface PaletteDef {
  letter: PieceLetter
  name: string
  /** Betza notation for fairy pieces (emitted as customPiece lines). */
  betza?: string
  /** Friendly reading of the movement, shown in the palette. */
  moves: string
  /** Base standard piece the fairy glyph composes from. */
  baseGlyph: 'pawn' | 'knight' | 'bishop' | 'rook' | 'queen' | 'king'
  /** Badge letter over the base glyph for fairy pieces. */
  badge?: string
}

export const PIECE_PALETTE: readonly PaletteDef[] = [
  { letter: 'k', name: 'King', moves: 'One step, any direction', baseGlyph: 'king' },
  { letter: 'q', name: 'Queen', moves: 'Slides any direction', baseGlyph: 'queen' },
  { letter: 'r', name: 'Rook', moves: 'Slides straight', baseGlyph: 'rook' },
  { letter: 'b', name: 'Bishop', moves: 'Slides diagonally', baseGlyph: 'bishop' },
  { letter: 'n', name: 'Knight', moves: 'Jumps in an L', baseGlyph: 'knight' },
  { letter: 'p', name: 'Pawn', moves: 'Forward one, captures diagonally', baseGlyph: 'pawn' },
  {
    letter: 'a',
    name: 'Amazon',
    betza: 'QN',
    moves: 'Queen + knight in one piece',
    baseGlyph: 'queen',
    badge: 'N'
  },
  {
    letter: 'c',
    name: 'Chancellor',
    betza: 'RN',
    moves: 'Rook + knight in one piece',
    baseGlyph: 'rook',
    badge: 'N'
  },
  {
    letter: 'h',
    name: 'Archbishop',
    betza: 'BN',
    moves: 'Bishop + knight in one piece',
    baseGlyph: 'bishop',
    badge: 'N'
  }
] as const

export function paletteDef(letter: string): PaletteDef | undefined {
  return PIECE_PALETTE.find((p) => p.letter === letter.toLowerCase())
}

// ---------------------------------------------------------------------------
// Parents

export type ParentVariant =
  | 'chess'
  | 'atomic'
  | 'crazyhouse'
  | 'kingofthehill'
  | 'antichess'
  | 'placement'
  | 'grand'

export interface ParentDef {
  id: ParentVariant
  label: string
  note: string
  /** Painter disabled — the parent's start position is part of its identity. */
  lockBoard?: boolean
  files: number
  ranks: number
  startFen: string
}

const STD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export const PARENTS: readonly ParentDef[] = [
  { id: 'chess', label: 'Chess', note: 'Classic rules base', files: 8, ranks: 8, startFen: STD },
  {
    id: 'atomic',
    label: 'Atomic',
    note: 'Captures explode the 3×3 around them (pawns shielded)',
    files: 8,
    ranks: 8,
    startFen: STD
  },
  {
    id: 'crazyhouse',
    label: 'Crazyhouse',
    note: 'Captured pieces switch sides — drop them back',
    files: 8,
    ranks: 8,
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1'
  },
  {
    id: 'kingofthehill',
    label: 'King of the Hill',
    note: 'Reach the four center squares with your king to win',
    files: 8,
    ranks: 8,
    startFen: STD
  },
  {
    id: 'antichess',
    label: 'Antichess',
    note: 'Captures are forced — lose everything to win',
    files: 8,
    ranks: 8,
    startFen: STD
  },
  {
    id: 'placement',
    label: 'Placement',
    note: 'Both sides place their back rank before play',
    lockBoard: true,
    files: 8,
    ranks: 8,
    startFen: '8/pppppppp/8/8/8/8/PPPPPPPP/8[KQRRBBNNkqrrbbnn] w - - 0 1'
  },
  {
    id: 'grand',
    label: 'Grand Chess',
    note: '10×10 with Archbishop and Chancellor',
    lockBoard: true,
    files: 10,
    ranks: 10,
    startFen: 'r8r/1nbqkcabn1/pppppppppp/10/10/10/10/PPPPPPPPPP/1NBQKCABN1/R8R w - - 0 1'
  }
] as const

export function parentDef(id: ParentVariant): ParentDef {
  return PARENTS.find((p) => p.id === id) ?? PARENTS[0]
}

// ---------------------------------------------------------------------------
// Editor model

export interface BoardPiece {
  color: 'white' | 'black'
  letter: PieceLetter
}

/** Board cells in FEN order: index = (ranks - 1 - rank) * files + file. */
export type BoardCells = (BoardPiece | null)[]

export interface EditorModel {
  name: string
  description: string
  parent: ParentVariant
  files: number
  ranks: number
  /** Ignored (and hidden) when parentDef(parent).lockBoard. */
  board: BoardCells
  royal: 'checkmate' | 'king-capture'
  castling: boolean
  doubleStep: boolean
  /** Promotion choices, palette letters. */
  promotion: PieceLetter[]
}

export function cellIndex(files: number, ranks: number, file: number, rank: number): number {
  return (ranks - 1 - rank) * files + file
}

export function emptyBoard(files: number, ranks: number): BoardCells {
  return new Array<BoardPiece | null>(files * ranks).fill(null)
}

/**
 * Symmetric classic back-rank for an arbitrary width: edge=rook, next=knight,
 * inner=bishop, king just right of center with the queen beside it. Width 8
 * yields exactly r n b q k b n r; width 6 yields Los Alamos' r n q k n r.
 */
export function classicBackRank(files: number): PieceLetter[] {
  const ring: PieceLetter[] = ['r', 'n', 'b']
  const row = new Array<PieceLetter>(files)
  for (let f = 0; f < files; f++) {
    const distFromEdge = Math.min(f, files - 1 - f)
    row[f] = ring[Math.min(distFromEdge, ring.length - 1)]
  }
  const k = files >> 1
  row[k] = 'k'
  if (k - 1 >= 0) row[k - 1] = 'q'
  return row
}

/** Fill a board with the classic two-army setup for its size. */
export function classicArmies(files: number, ranks: number): BoardCells {
  const board = emptyBoard(files, ranks)
  const back = classicBackRank(files)
  for (let f = 0; f < files; f++) {
    board[cellIndex(files, ranks, f, 0)] = { color: 'white', letter: back[f] }
    board[cellIndex(files, ranks, f, 1)] = { color: 'white', letter: 'p' }
    board[cellIndex(files, ranks, f, ranks - 1)] = { color: 'black', letter: back[f] }
    board[cellIndex(files, ranks, f, ranks - 2)] = { color: 'black', letter: 'p' }
  }
  return board
}

/** Resize preserving piece placement anchored to the white side + a-file. */
export function resizeBoard(
  board: BoardCells,
  fromFiles: number,
  fromRanks: number,
  toFiles: number,
  toRanks: number
): BoardCells {
  const next = emptyBoard(toFiles, toRanks)
  for (let rank = 0; rank < Math.min(fromRanks, toRanks); rank++) {
    for (let file = 0; file < Math.min(fromFiles, toFiles); file++) {
      next[cellIndex(toFiles, toRanks, file, rank)] =
        board[cellIndex(fromFiles, fromRanks, file, rank)]
    }
  }
  return next
}

// ---------------------------------------------------------------------------
// FEN <-> board

/** Board part of a FEN (multi-digit empty runs, fairy-style). */
export function boardToFenBody(board: BoardCells, files: number, ranks: number): string {
  const rows: string[] = []
  for (let rank = ranks - 1; rank >= 0; rank--) {
    let row = ''
    let empties = 0
    for (let file = 0; file < files; file++) {
      const cell = board[cellIndex(files, ranks, file, rank)]
      if (!cell) {
        empties++
        continue
      }
      if (empties > 0) {
        row += String(empties)
        empties = 0
      }
      row += cell.color === 'white' ? cell.letter.toUpperCase() : cell.letter
    }
    if (empties > 0) row += String(empties)
    rows.push(row)
  }
  return rows.join('/')
}

/** Parse a FEN's board part into cells (pockets/suffix fields ignored).
 *  Returns null when the FEN does not fit the given dimensions. */
export function parseFenBoard(fen: string, files: number, ranks: number): BoardCells | null {
  const body = fen.split(' ')[0].split('[')[0]
  const rows = body.split('/')
  if (rows.length !== ranks) return null
  const board = emptyBoard(files, ranks)
  for (let r = 0; r < ranks; r++) {
    const rank = ranks - 1 - r
    let file = 0
    let digits = ''
    const flushDigits = (): void => {
      if (digits.length > 0) {
        file += parseInt(digits, 10)
        digits = ''
      }
    }
    for (const ch of rows[r]) {
      if (ch >= '0' && ch <= '9') {
        digits += ch
        continue
      }
      flushDigits()
      if (ch === '+' || ch === '~') continue // fairy promoted-piece markers
      if (file >= files) return null
      const lower = ch.toLowerCase() as PieceLetter
      board[cellIndex(files, ranks, file, rank)] = {
        color: ch === lower ? 'black' : 'white',
        letter: lower
      }
      file++
    }
    flushDigits()
    if (file !== files) return null
  }
  return board
}

// ---------------------------------------------------------------------------
// ini generation

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug.length > 0 ? slug : 'variant'
}

/** Castling rights string derived from the painted position (8-wide, classic squares only). */
function castlingRights(model: EditorModel): string {
  if (!model.castling || model.royal === 'king-capture' || model.files !== 8) return '-'
  const { board, files, ranks } = model
  const at = (f: number, r: number): BoardPiece | null => board[cellIndex(files, ranks, f, r)]
  const side = (color: 'white' | 'black', rank: number, ks: string, qs: string): string => {
    const king = at(4, rank)
    if (!king || king.letter !== 'k' || king.color !== color) return ''
    let s = ''
    const hRook = at(7, rank)
    if (hRook && hRook.letter === 'r' && hRook.color === color) s += ks
    const aRook = at(0, rank)
    if (aRook && aRook.letter === 'r' && aRook.color === color) s += qs
    return s
  }
  const rights = side('white', 0, 'K', 'Q') + side('black', ranks - 1, 'k', 'q')
  return rights.length > 0 ? rights : '-'
}

/** Letters used on the board (both colors), for customPiece emission. */
function lettersInUse(model: EditorModel): Set<PieceLetter> {
  const used = new Set<PieceLetter>()
  for (const cell of model.board) if (cell) used.add(cell.letter)
  for (const p of model.promotion) used.add(p)
  return used
}

/**
 * The full startFen for a painted board (parent-aware: crazyhouse-family
 * parents carry an empty pocket suffix).
 */
export function startFenOf(model: EditorModel): string {
  const body = boardToFenBody(model.board, model.files, model.ranks)
  const pockets = model.parent === 'crazyhouse' ? '[]' : ''
  return `${body}${pockets} w ${castlingRights(model)} - 0 1`
}

/**
 * EditorModel → variants.ini text. Deterministic, human-readable, always at
 * least one key per section (an empty section crashes the WASM engine — see
 * games/customVariants.ts header).
 */
export function generateIni(model: EditorModel): string {
  const parent = parentDef(model.parent)
  const slug = slugify(model.name)
  const lines: string[] = []
  lines.push(`# ${model.name.trim() || 'Untitled variant'} — built in the nodechess Variant Lab`)
  if (model.description.trim()) lines.push(`# ${model.description.trim()}`)
  lines.push(`[${slug}:${parent.id}]`)

  if (parent.lockBoard) {
    // Parent-defined identity (placement/grand): inherit its board + rules,
    // but the section still needs one key — restate the promotion set.
    lines.push(`promotionPieceTypes = ${model.promotion.join('')}`)
    return lines.join('\n') + '\n'
  }

  if (model.files !== 8) lines.push(`maxFile = ${model.files}`)
  if (model.ranks !== 8) lines.push(`maxRank = ${model.ranks}`)

  // Fairy pieces on the board get their betza definitions.
  const used = lettersInUse(model)
  let customN = 0
  for (const def of PIECE_PALETTE) {
    if (def.betza && used.has(def.letter)) {
      customN++
      lines.push(`customPiece${customN} = ${def.letter}:${def.betza}`)
    }
  }

  if (model.royal === 'king-capture') {
    // Capture-the-king: the king stops being royal (a commoner wearing the
    // crown) and losing every "king" loses the game. Checks are not enforced.
    lines.push('king = -')
    lines.push('commoner = k')
    lines.push('extinctionValue = loss')
    lines.push('extinctionPieceTypes = k')
  }

  lines.push(`startFen = ${startFenOf(model)}`)
  if (model.ranks !== 8) lines.push(`promotionRank = ${model.ranks}`)
  lines.push(`promotionPieceTypes = ${model.promotion.join('')}`)
  if (!model.doubleStep) lines.push('doubleStep = false')
  if (!model.castling || model.royal === 'king-capture' || model.files !== 8) {
    lines.push('castling = false')
  }
  return lines.join('\n') + '\n'
}

/** The startFen recorded in an ini text, else the parent's, else null. */
export function displayFenOfIni(iniText: string): string | null {
  const m = /^\s*startFen\s*=\s*(.+)$/m.exec(iniText)
  if (m) return m[1].trim()
  const head = /^\s*\[[A-Za-z0-9_-]+:([A-Za-z0-9_-]+)\]\s*$/m.exec(iniText)
  if (head) {
    const parent = PARENTS.find((p) => p.id === head[1])
    if (parent) return parent.startFen
  }
  return null
}

// ---------------------------------------------------------------------------
// ini → model (round-trips generateIni output; hand-edited inis fall to raw mode)

/** Keys generateIni can emit — anything else marks the ini as hand-edited. */
const GENERATED_KEYS = new Set([
  'maxfile',
  'maxrank',
  'king',
  'commoner',
  'extinctionvalue',
  'extinctionpiecetypes',
  'startfen',
  'promotionrank',
  'promotionpiecetypes',
  'doublestep',
  'castling'
])

export interface ModelFromIni {
  model: EditorModel
  /** False when the ini carries structure the builder cannot express —
   *  the editor then opens in raw mode to avoid destroying the user's text. */
  exact: boolean
}

/**
 * Best-effort reconstruction of an EditorModel from saved ini text. Returns
 * null when there is no usable [section] header at all.
 */
export function modelFromIni(
  iniText: string,
  meta: { name: string; description: string; files: number; ranks: number }
): ModelFromIni | null {
  const head = /^\s*\[([A-Za-z0-9_-]+)(?::([A-Za-z0-9_-]+))?\]\s*$/m.exec(iniText)
  if (!head) return null
  const parentId = (head[2] ?? 'chess') as ParentVariant
  const parent = PARENTS.find((p) => p.id === parentId)

  let exact = parent !== undefined
  const keys = new Map<string, string>()
  for (const line of iniText.split(/\r?\n/)) {
    const t = line.trim()
    if (t.length === 0 || t.startsWith('#') || t.startsWith(';') || t.startsWith('[')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim().toLowerCase()
    keys.set(key, t.slice(eq + 1).trim())
    if (!GENERATED_KEYS.has(key) && !/^custompiece\d+$/.test(key)) exact = false
  }

  const startFen = keys.get('startfen')
  const board = startFen ? parseFenBoard(startFen, meta.files, meta.ranks) : null
  const locked = parent?.lockBoard ?? false
  if (!locked && !board) exact = false

  // customPiece lines must match the palette betzas exactly to round-trip.
  for (const [key, value] of keys) {
    if (!/^custompiece\d+$/.test(key)) continue
    const m = /^([a-z]):(.+)$/i.exec(value)
    const def = m ? paletteDef(m[1]) : undefined
    if (!def || !def.betza || def.betza.toLowerCase() !== m![2].trim().toLowerCase()) exact = false
  }

  const promotion = (keys.get('promotionpiecetypes') ?? 'nbrq')
    .toLowerCase()
    .split('')
    .filter((ch): ch is PieceLetter => paletteDef(ch) !== undefined)

  const model: EditorModel = {
    name: meta.name,
    description: meta.description,
    parent: parent ? parentId : 'chess',
    files: meta.files,
    ranks: meta.ranks,
    board: board ?? emptyBoard(meta.files, meta.ranks),
    royal: keys.get('king') === '-' && keys.get('commoner') === 'k' ? 'king-capture' : 'checkmate',
    castling: keys.get('castling') !== 'false',
    doubleStep: keys.get('doublestep') !== 'false',
    promotion
  }
  // generateIni forces castling=false for non-8-file boards; reflect the
  // builder toggle's real meaning when reconstructing.
  if (model.files !== 8) model.castling = false
  return { model, exact }
}
