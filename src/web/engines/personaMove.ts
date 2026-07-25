// personas.move on the web. The port of src/main/personas/select.ts:
// style-weighted MultiPV selection with the persona's strength capped near its
// modern-era Elo. The selection math (classifyMove / styleScore / tolerance /
// pick) is ported verbatim and exported pure for the headless suite; the
// engine access runs on the SHARED play instance through the play chain
// (desktop keeps a separate idle-reaped persona process; on the web a third
// 128 MB wasm instance isn't worth it, and every play-chain caller re-asserts
// its own options before searching, so sharing is safe).
//
// The persona catalog + opening books load lazily from the SAME committed
// resources the desktop reads (resources/personas/personas.json + books.json,
// ~36 KB + ~64 KB as their own chunks). Photos (6 MB) are NOT loaded. Move
// selection only needs style/strength numbers.

import { Chess } from 'chessops/chess'
import { parseFen, makeFen } from 'chessops/fen'
import { parseUci, opposite } from 'chessops/util'
import type { Color, Move } from 'chessops/types'
import type { Api, Persona, PersonaStyle } from '@shared/types'
import { webEngineSupported } from './assets'
import { pool, serializePlay } from './pools'
import type { WebUciEngine } from './WebUciEngine'
import type { InfoLine } from './uci'

// ---- Engine strength band (desktop verbatim) ----------------------------------------

const ELO_MIN = 1320
const ELO_MAX = 3190

export function clampElo(elo: number): number {
  return Math.max(ELO_MIN, Math.min(ELO_MAX, Math.round(elo)))
}

/** Hard per-search ceiling (desktop PERSONA_SEARCH_TIMEOUT_MS): the renderer
 *  falls back to a random legal move if this rejects, so a turn never hangs. */
const PERSONA_SEARCH_TIMEOUT_MS = 30_000

// ---- Piece values (desktop verbatim; role-keyed, king 0) ------------------------------

const VALUE: Record<string, number> = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
  king: 0
}

// ---- Candidates ----------------------------------------------------------------------

export interface Candidate {
  uci: string
  cp: number | null
  mate: number | null
  rank: number
  pv: string[]
}

export function infoToCandidate(rank: number, info: InfoLine): Candidate | null {
  const pv = info.pv
  if (!pv || pv.length === 0) return null
  return {
    uci: pv[0],
    cp: info.mate !== undefined ? null : (info.scoreCp ?? 0),
    mate: info.mate ?? null,
    rank,
    pv
  }
}

/** Collapse cp/mate into a comparable centipawn-ish scalar (mover POV). */
export function evalScalar(c: { cp: number | null; mate: number | null }): number {
  if (c.mate != null) return Math.sign(c.mate) * (100000 - Math.abs(c.mate))
  return c.cp ?? 0
}

// ---- Move texture classification (desktop verbatim) -----------------------------------

function posFromFen(fen: string): Chess | null {
  const setup = parseFen(fen)
  if (setup.isErr) return null
  const pos = Chess.fromSetup(setup.unwrap())
  if (pos.isErr) return null
  return pos.unwrap()
}

export interface MoveTraits {
  isCapture: boolean
  isCheck: boolean
  isPromotion: boolean
  /** Net material the mover concedes (pawns); > 0 = a speculative sac. */
  immediateSacPawns: number
  attacksKingZone: boolean
}

/** Squares adjacent to a square (the king ring). */
function ringSquares(sq: number): number[] {
  const f = sq & 7
  const r = sq >> 3
  const out: number[] = []
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      const nf = f + df
      const nr = r + dr
      if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue
      out.push(nr * 8 + nf)
    }
  }
  return out
}

/** Classify a candidate move's tactical/positional texture. Falls back to
 *  neutral traits if the move can't be parsed/played. */
export function classifyMove(beforeFen: string, uci: string): MoveTraits {
  const neutral: MoveTraits = {
    isCapture: false,
    isCheck: false,
    isPromotion: false,
    immediateSacPawns: 0,
    attacksKingZone: false
  }
  const pos = posFromFen(beforeFen)
  if (!pos) return neutral
  const move = parseUci(uci)
  if (!move || !('to' in move) || !pos.isLegal(move)) return neutral

  const mover = pos.turn
  const enemy = opposite(mover)
  const movingPiece = 'from' in move ? pos.board.get(move.from) : undefined

  // Capture detection (including en passant).
  const captured = pos.board.get(move.to)
  let isCapture = captured != null
  if (!isCapture && movingPiece?.role === 'pawn' && 'from' in move) {
    if ((move.from & 7) !== (move.to & 7)) isCapture = true
  }
  const isPromotion = 'promotion' in move && move.promotion != null

  const after = pos.clone()
  after.play(move)
  const isCheck = after.isCheck()

  // King-zone pressure: does the moved piece (now on `to`) attack the enemy king ring?
  let attacksKingZone = false
  const enemyKing = after.board.kingOf(enemy)
  if (enemyKing !== undefined) {
    const ring = ringSquares(enemyKing)
    for (const sq of ring) {
      if (after.kingAttackers(sq, mover, after.board.occupied).has(move.to)) {
        attacksKingZone = true
        break
      }
    }
    if (
      !attacksKingZone &&
      after.kingAttackers(enemyKing, mover, after.board.occupied).has(move.to)
    ) {
      attacksKingZone = true
    }
  }

  const immediateSacPawns = sacPawns(
    after,
    move.to,
    mover,
    isCapture ? captureValue(pos, move) : 0
  )

  return { isCapture, isCheck, isPromotion, immediateSacPawns, attacksKingZone }
}

/** Pawn value gained by a capture move (for net-sac accounting). */
function captureValue(beforePos: Chess, move: Move): number {
  if (!('to' in move)) return 0
  const target = beforePos.board.get(move.to)
  if (target) return VALUE[target.role]
  if ('from' in move) {
    const from = beforePos.board.get(move.from)
    if (from?.role === 'pawn' && (move.from & 7) !== (move.to & 7)) return VALUE.pawn
  }
  return 0
}

/** Cheap static-exchange-lite: material (pawns) the mover risks conceding on
 *  `sq` after the move, netting out what the move already captured. */
function sacPawns(afterPos: Chess, sq: number, mover: Color, gained: number): number {
  const piece = afterPos.board.get(sq)
  if (!piece || piece.color !== mover) return 0
  const enemy = opposite(mover)
  const ourValue = VALUE[piece.role]

  const attackers = afterPos.kingAttackers(sq, enemy, afterPos.board.occupied)
  if (attackers.isEmpty()) return 0

  let minAttacker = Infinity
  for (const aSq of attackers) {
    const ap = afterPos.board.get(aSq)
    if (!ap || ap.role === 'king') continue
    minAttacker = Math.min(minAttacker, VALUE[ap.role])
  }
  if (!Number.isFinite(minAttacker)) return 0

  const defenders = afterPos.kingAttackers(sq, mover, afterPos.board.occupied)
  const defended = defenders.size() > 0

  if (!defended) {
    return Math.max(0, ourValue - gained)
  }
  if (minAttacker < ourValue) {
    return Math.max(0, ourValue - minAttacker - gained)
  }
  return 0
}

// ---- Style scoring (desktop verbatim) --------------------------------------------------

/** Score a candidate for a persona. Higher = more in-character. */
export function styleScore(
  style: PersonaStyle,
  c: Candidate,
  best: Candidate,
  traits: MoveTraits
): number {
  const { aggression, risk, prefersAttack, prefersSolid } = style

  const evalLossPawns = Math.max(0, evalScalar(best) - evalScalar(c)) / 100

  // Aggressive personas weigh raw eval less; solid personas weigh it heavily.
  const evalWeight = 1.4 - 0.7 * aggression
  let score = -evalLossPawns * evalWeight

  const attackBias = (aggression + (prefersAttack ? 0.4 : 0)) / 1.4
  if (traits.isCheck) score += 0.5 * attackBias
  if (traits.isCapture) score += 0.25 * attackBias
  if (traits.attacksKingZone) score += 0.6 * attackBias
  if (traits.isPromotion) score += 0.3 * attackBias

  if (traits.immediateSacPawns > 0) {
    const sacReward = (risk - 0.5) * 0.55 * Math.min(traits.immediateSacPawns, 9)
    score += sacReward
  }

  if (prefersSolid) {
    score -= traits.immediateSacPawns * 0.5
    score += (6 - c.rank) * 0.04
  }

  return score
}

/** Depth scales mildly with peak strength: 1320 → 8, 3190 → ~16. */
export function defaultDepth(peakElo: number): number {
  const clamped = clampElo(peakElo)
  return Math.round(8 + ((clamped - ELO_MIN) / (ELO_MAX - ELO_MIN)) * 8)
}

/** Eval tolerance (pawns) within which lines are "good enough" to style-pick. */
export function evalTolerancePawns(style: PersonaStyle): number {
  const { aggression, risk } = style
  return 0.2 + 1.0 * Math.max(aggression, risk)
}

/** The pure selection over assembled candidates: desktop selectOnEngine's
 *  tolerance filter + style-score argmax (ties resolve toward lower rank). */
export function pickStyledMove(
  style: PersonaStyle,
  fen: string,
  candidates: Candidate[],
  engineBestmove: string
): { bestmove: string; lineEval?: { cp?: number | null; mate?: number | null } } {
  if (candidates.length === 0) return { bestmove: engineBestmove }

  const best = candidates.reduce((a, b) => (evalScalar(b) > evalScalar(a) ? b : a))
  const bestScalar = evalScalar(best)
  const tolCp = evalTolerancePawns(style) * 100

  const eligible = candidates.filter((c) => bestScalar - evalScalar(c) <= tolCp)
  const chosenPool = eligible.length > 0 ? eligible : [best]

  let chosen = chosenPool[0]
  let chosenScore = -Infinity
  for (const c of chosenPool) {
    const traits = classifyMove(fen, c.uci)
    const s = styleScore(style, c, best, traits)
    if (s > chosenScore || (s === chosenScore && c.rank < chosen.rank)) {
      chosen = c
      chosenScore = s
    }
  }

  return { bestmove: chosen.uci, lineEval: { cp: chosen.cp, mate: chosen.mate } }
}

// ---- Persona catalog + opening books (lazy resource chunks) ----------------------------

/** personas.json rows: a Persona minus the photo fields. */
type PersonaRow = Omit<Persona, 'photo' | 'photoAttribution'>

interface PersonasFile {
  version?: number
  personas?: PersonaRow[]
}

/** The slice of a persona the selector needs. */
export interface PersonaLite {
  id: string
  peakElo: number
  modernElo: number | null
  style: PersonaStyle
}

function toPersonaLite(row: PersonaRow): PersonaLite | null {
  if (!row || typeof row.id !== 'string' || row.id.length === 0) return null
  if (typeof row.peakElo !== 'number' || !row.style) return null
  return {
    id: row.id,
    peakElo: row.peakElo,
    modernElo: row.modernElo ?? null,
    style: {
      aggression: row.style.aggression ?? 0.5,
      risk: row.style.risk ?? 0.5,
      prefersAttack: row.style.prefersAttack ?? false,
      prefersSolid: row.style.prefersSolid ?? false
    }
  }
}

let catalog: Promise<Map<string, PersonaLite>> | null = null

export function loadPersonaCatalog(): Promise<Map<string, PersonaLite>> {
  if (!catalog) {
    catalog = import('../../../resources/personas/personas.json')
      .then((m) => {
        const parsed = (m.default ?? m) as PersonasFile
        const rows = Array.isArray(parsed?.personas) ? parsed.personas : []
        const map = new Map<string, PersonaLite>()
        for (const r of rows) {
          const p = toPersonaLite(r)
          if (p) map.set(p.id, p)
        }
        return map
      })
      .catch(() => new Map<string, PersonaLite>())
  }
  return catalog
}

/** books.json: { personaId: { epd: [uci, ...] } }. Only that player's moves. */
type Book = Record<string, Record<string, string[]>>

let books: Promise<Book> | null = null

function loadBooks(): Promise<Book> {
  if (!books) {
    books = import('../../../resources/personas/books.json')
      .then((m) => (m.default ?? m) as Book)
      .catch(() => ({}) as Book)
  }
  return books
}

function epdOf(fen: string): string | null {
  try {
    return makeFen(parseFen(fen).unwrap(), { epd: true })
  } catch {
    return null
  }
}

/** Pure book lookup (desktop book.ts bookMove over an injected book). */
export function pickBookMove(
  book: Record<string, string[]> | undefined,
  fen: string,
  rng: () => number = Math.random
): string | null {
  if (!book) return null
  const epd = epdOf(fen)
  if (!epd) return null
  const candidates = book[epd]
  if (!candidates || candidates.length === 0) return null
  return candidates[Math.floor(rng() * candidates.length)]
}

// ---- One MultiPV search (desktop searchLines verbatim, over WebUciEngine) --------------

function searchLines(
  engine: WebUciEngine,
  fen: string,
  multipv: number,
  limit: { kind: 'depth'; value: number } | { kind: 'movetime'; value: number }
): Promise<{ lines: Map<number, InfoLine>; bestmove: string }> {
  return new Promise((resolve, reject) => {
    const lines = new Map<number, InfoLine>()
    let done = false
    const onInfo = (info: InfoLine): void => {
      const idx = info.multipv ?? 1
      if (info.pv && info.pv.length > 0) lines.set(idx, info)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      engine.off('info', onInfo)
      engine.off('bestmove', onBest)
      engine.off('exit', onExit)
      engine.off('engineError', onErr)
    }
    const onBest = (bm: { bestmove: string }): void => {
      if (done) return
      done = true
      cleanup()
      resolve({ lines, bestmove: bm.bestmove })
    }
    const fail = (e: Error): void => {
      if (done) return
      done = true
      cleanup()
      reject(e)
    }
    const onExit = (): void => fail(new Error('engine exited during persona search'))
    const onErr = (err: Error): void =>
      fail(err instanceof Error ? err : new Error('engine error during persona search'))
    const timer = setTimeout(
      () => fail(new Error('persona search timeout')),
      PERSONA_SEARCH_TIMEOUT_MS
    )
    engine.on('info', onInfo)
    engine.once('bestmove', onBest)
    engine.once('exit', onExit)
    engine.once('engineError', onErr)
    void engine.search(fen, limit, multipv)
  })
}

// ---- The factory ------------------------------------------------------------------------

export function buildPersonaMove(): Api['personas']['move'] {
  if (!webEngineSupported()) {
    // Same construction-time gate as the engine factory: engineless
    // environments fall back to webApi's W1 coming-online copy.
    throw new Error('web persona layer unavailable: no Worker/WebAssembly in this environment')
  }
  return async ({ fen, personaId, depth, movetimeMs }) => {
    const persona = (await loadPersonaCatalog()).get(personaId)
    if (!persona) throw new Error(`Unknown persona: ${personaId}`)
    const strengthElo = persona.modernElo ?? persona.peakElo

    // Validate the position up front so we fail fast on garbage input.
    const pos = posFromFen(fen)
    if (!pos) throw new Error('Invalid FEN')
    // Normalize the FEN the engine sees (defensive against odd whitespace).
    const safe = makeFen(pos.toSetup())

    // Opening book: while in this persona's real repertoire, play their move
    // and skip the engine entirely.
    const booked = pickBookMove((await loadBooks())[personaId], safe)
    if (booked) return { bestmove: booked }

    return serializePlay(async () => {
      const engine = await pool.getPlay()
      // Drain any abandoned search to idle before touching options. Same
      // discipline as engine:play.
      await engine.stop()
      engine.setOption('UCI_LimitStrength', true)
      engine.setOption('UCI_Elo', clampElo(strengthElo))

      const limit =
        movetimeMs !== undefined
          ? ({ kind: 'movetime', value: Math.max(50, Math.round(movetimeMs)) } as const)
          : ({ kind: 'depth', value: Math.max(4, depth ?? defaultDepth(strengthElo)) } as const)

      const { lines, bestmove } = await searchLines(engine, safe, 6, limit)

      const candidates: Candidate[] = []
      for (let rank = 1; rank <= 6; rank++) {
        const info = lines.get(rank)
        if (!info) continue
        const cand = infoToCandidate(rank, info)
        if (cand) candidates.push(cand)
      }

      return pickStyledMove(persona.style, safe, candidates, bestmove)
    })
  }
}
