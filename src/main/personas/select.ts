// Style-weighted move selection for GM-style personas (docs/feature-addendum.md §2b).
//
// Pipeline:
//   1. Spawn a Stockfish capped near the persona's peakElo (UCI_LimitStrength +
//      UCI_Elo, clamped to the engine's 1320..3190 band).
//   2. Search the position with MultiPV 6 at a bounded depth/movetime; collect the
//      top lines (move + eval, mover POV).
//   3. Keep lines within an eval TOLERANCE of the best move (tolerance widens with
//      aggression/risk: sharp personas accept giving up a little eval for fire).
//   4. Score each surviving candidate by persona style: aggressive personas reward
//      captures, checks, sacrifices, and king-attacking moves; solid personas reward
//      the safest / most consolidating move. Pick the highest-scoring candidate.
//
// Real opening books from a player's games are a later add (feature-addendum §2b
// step 1); repertoire bias is intentionally omitted here.
//
// Built on chessops (the project's rules library). No chess.js. Engine access is
// the arms-length UciEngine UCI subprocess.

import { Chess } from 'chessops/chess'
import { parseFen, makeFen } from 'chessops/fen'
import { parseUci, opposite } from 'chessops/util'
import type { Color, Move, Role } from 'chessops/types'
import { UciEngine, type InfoLine } from '../engine/UciEngine'
import { stockfishPath } from '../engine/paths'
import { getPersona, type Persona } from './personas'
import { bookMove } from './book'

// ---- Engine strength band (feature-addendum §1) ----------------------------------

const ELO_MIN = 1320
const ELO_MAX = 3190

function clampElo(elo: number): number {
  return Math.max(ELO_MIN, Math.min(ELO_MAX, Math.round(elo)))
}

// ---- Public shapes ---------------------------------------------------------------

export interface SelectMoveArgs {
  /** Position the persona must move in. */
  fen: string
  /** Persona id (see personas.ts). */
  personaId: string
  /** Override search depth (default scales with peakElo). */
  depth?: number
  /** Override search movetime in ms (used instead of depth when given). */
  movetimeMs?: number
}

export interface SelectMoveResult {
  /** The chosen move in UCI (e.g. "g1f3", "e7e8q"); 'engine bestmove' on fallback. */
  bestmove: string
  /** Eval of the chosen line, mover POV, if known. */
  lineEval?: { cp?: number | null; mate?: number | null }
}

// ---- Piece values for sacrifice / capture scoring --------------------------------

const VALUE: Record<Role, number> = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
  king: 0
}

// ---- One MultiPV search ----------------------------------------------------------

interface Candidate {
  /** First move of the line, UCI. */
  uci: string
  /** Eval of the line, mover POV. */
  cp: number | null
  mate: number | null
  /** multipv rank (1 = best). */
  rank: number
  /** PV (uci moves) for sacrifice inspection. */
  pv: string[]
}

/**
 * Run a single MultiPV search and resolve with the latest line per multipv index
 * once `bestmove` arrives. The engine's reported bestmove is returned too as a
 * guaranteed-legal fallback. Every exit path (bestmove / timeout / engine exit /
 * engine error) detaches all listeners so nothing leaks onto the shared persona
 * engine, and a wedged engine can never hang the persona's turn forever.
 */
function searchLines(
  engine: UciEngine,
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

function infoToCandidate(rank: number, info: InfoLine): Candidate | null {
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

// ---- Eval normalization to a single comparable scalar (mover POV) ----------------

/** Collapse cp/mate into a comparable centipawn-ish scalar (mover POV). */
function evalScalar(c: { cp: number | null; mate: number | null }): number {
  if (c.mate != null) return Math.sign(c.mate) * (100000 - Math.abs(c.mate))
  return c.cp ?? 0
}

// ---- Move classification (captures / checks / sacrifices / attack) ----------------

function posFromFen(fen: string): Chess | null {
  const setup = parseFen(fen)
  if (setup.isErr) return null
  const pos = Chess.fromSetup(setup.unwrap())
  if (pos.isErr) return null
  return pos.unwrap()
}

interface MoveTraits {
  isCapture: boolean
  isCheck: boolean
  /** Captures or promotes to queen. Generally forcing/material-positive. */
  isPromotion: boolean
  /** Net material the mover concedes immediately after this move + best reply, in pawns
   *  (> 0 means the mover is giving material away; a speculative sac). */
  immediateSacPawns: number
  /** Heuristic: this move increases pressure on the enemy king zone. */
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

/**
 * Classify a candidate move's tactical/positional texture from the position before
 * it. Falls back to neutral traits if the move can't be parsed/played.
 */
function classifyMove(beforeFen: string, uci: string): MoveTraits {
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
    if ((move.from & 7) !== (move.to & 7)) isCapture = true // diagonal pawn move w/o target = ep
  }
  const isPromotion = 'promotion' in move && move.promotion != null

  // Play the move on a clone to inspect the resulting position.
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
    // Direct attack on the king square itself also counts.
    if (!attacksKingZone && after.kingAttackers(enemyKing, mover, after.board.occupied).has(move.to)) {
      attacksKingZone = true
    }
  }

  // Immediate sacrifice estimate: if, after our move, the enemy's lowest-value
  // attacker can win the piece we just moved to `to` and it is not adequately
  // defended, count the net material we are conceding (mover POV). This is a cheap
  // SEE-lite that catches romantic-era piece sacs and exchange sacs.
  const immediateSacPawns = sacPawns(after, move.to, mover, isCapture ? captureValue(pos, move) : 0)

  return {
    isCapture,
    isCheck,
    isPromotion,
    immediateSacPawns,
    attacksKingZone
  }
}

/** Pawn value gained by a capture move (for net-sac accounting). */
function captureValue(beforePos: Chess, move: Move): number {
  if (!('to' in move)) return 0
  const target = beforePos.board.get(move.to)
  if (target) return VALUE[target.role]
  // en passant
  if ('from' in move) {
    const from = beforePos.board.get(move.from)
    if (from?.role === 'pawn' && (move.from & 7) !== (move.to & 7)) return VALUE.pawn
  }
  return 0
}

/**
 * Cheap static-exchange-lite: material (pawns) the mover risks conceding on `sq`
 * after the move, netting out what the move already captured. Positive = the mover
 * is offering material (a sacrifice); 0 = safe.
 */
function sacPawns(afterPos: Chess, sq: number, mover: Color, gained: number): number {
  const piece = afterPos.board.get(sq)
  if (!piece || piece.color !== mover) return 0
  const enemy = opposite(mover)
  const ourValue = VALUE[piece.role]

  const attackers = afterPos.kingAttackers(sq, enemy, afterPos.board.occupied)
  if (attackers.isEmpty()) return 0

  // Lowest-value enemy attacker.
  let minAttacker = Infinity
  for (const aSq of attackers) {
    const ap = afterPos.board.get(aSq)
    if (!ap || ap.role === 'king') continue
    minAttacker = Math.min(minAttacker, VALUE[ap.role])
  }
  if (!Number.isFinite(minAttacker)) return 0

  // Defended by us? (any own attacker of the square excluding the piece itself).
  const defenders = afterPos.kingAttackers(sq, mover, afterPos.board.occupied)
  const defended = defenders.size() > 0

  if (!defended) {
    // Fully hanging: we lose the whole piece value (minus what we already won).
    return Math.max(0, ourValue - gained)
  }
  // Defended but a cheaper piece can initiate: approximate net loss of the exchange.
  if (minAttacker < ourValue) {
    return Math.max(0, ourValue - minAttacker - gained)
  }
  return 0
}

// ---- Style scoring ---------------------------------------------------------------

/**
 * Score a candidate for a persona. Higher = more in-character. The score blends:
 *  - eval proximity to best (always matters, scaled DOWN for aggressive personas),
 *  - attacking texture (captures/checks/king-zone/sacs) weighted by aggression+risk,
 *  - solidity (no material conceded, lower rank) weighted for solid personas.
 */
function styleScore(persona: Persona, c: Candidate, best: Candidate, traits: MoveTraits): number {
  const { aggression, risk, prefersAttack, prefersSolid } = persona.style

  // Eval delta vs best (pawns the candidate is worse by; >= 0).
  const evalLossPawns = Math.max(0, evalScalar(best) - evalScalar(c)) / 100

  // Aggressive personas weigh raw eval less; solid personas weigh it heavily.
  const evalWeight = 1.4 - 0.7 * aggression // ~0.7 (Tal) .. ~1.4 (Petrosian)
  let score = -evalLossPawns * evalWeight

  // Attacking rewards (only meaningful for personas that like attacking).
  const attackBias = (aggression + (prefersAttack ? 0.4 : 0)) / 1.4
  if (traits.isCheck) score += 0.5 * attackBias
  if (traits.isCapture) score += 0.25 * attackBias
  if (traits.attacksKingZone) score += 0.6 * attackBias
  if (traits.isPromotion) score += 0.3 * attackBias

  // Sacrifices: rewarded in proportion to risk appetite, penalized for cautious ones.
  if (traits.immediateSacPawns > 0) {
    const sacReward = (risk - 0.5) * 0.55 * Math.min(traits.immediateSacPawns, 9)
    score += sacReward // positive for risk>0.5, negative for risk<0.5
  }

  // Solidity rewards: prefer the engine's own top line and keeping material intact.
  if (prefersSolid) {
    score -= traits.immediateSacPawns * 0.5
    score += (6 - c.rank) * 0.04 // gentle pull toward the best lines
  }

  return score
}

// ---- Search budget ---------------------------------------------------------------

/** Depth scales mildly with peak strength (capped so play stays responsive). */
function defaultDepth(peakElo: number): number {
  const clamped = clampElo(peakElo)
  // 1320 -> 8, 3190 -> ~16.
  return Math.round(8 + ((clamped - ELO_MIN) / (ELO_MAX - ELO_MIN)) * 8)
}

/** Eval tolerance (pawns) within which lines are considered "good enough" to style-pick. */
function evalTolerancePawns(persona: Persona): number {
  // Solid personas tolerate ~0.2 pawns; the wildest ~1.2 pawns of eval to get fire.
  const { aggression, risk } = persona.style
  return 0.2 + 1.0 * Math.max(aggression, risk)
}

// ---- Shared persona engine ---------------------------------------------------------
//
// One long-lived Stockfish reused across persona moves (previously a brand-new
// process was spawned PER MOVE. Constant spawn/teardown churn and possible
// concurrent spawns). Mirrors the engine:play discipline in
// src/main/ipc/engine.ipc.ts: a single pooled process, a serialization chain so
// two calls can never interleave their option/search writes, and stop() before
// each search. It stays arms-length from the analysis/play pool (StockfishPool)
// so a persona game never starves analysis. The process is disposed after a
// short idle window: game over or persona deselected means no more moves, so
// the engine goes away by itself, and lazily respawned on the next move. A
// crashed or wedged engine is dropped immediately so the next move respawns
// cleanly instead of writing to a dead process.

const PERSONA_ENGINE_IDLE_MS = 60_000
/** Hard per-search ceiling (movetime path is <= 10s by the ipc schema; the
 *  depth path for a 3190 persona is seconds). The renderer additionally falls
 *  back to a random legal move if this rejects, so the turn never hangs. */
const PERSONA_SEARCH_TIMEOUT_MS = 30_000

let personaEngine: UciEngine | null = null
let personaIdleTimer: NodeJS.Timeout | null = null

// personas:move calls all share the one engine. Serialize them (own chain,
// independent of engine.ipc.ts's queues) exactly like serializePlay there.
let personaChain: Promise<unknown> = Promise.resolve()
function serializePersona<T>(fn: () => Promise<T>): Promise<T> {
  const run = personaChain.then(fn, fn)
  personaChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function getPersonaEngine(): Promise<UciEngine> {
  if (personaIdleTimer) {
    clearTimeout(personaIdleTimer)
    personaIdleTimer = null
  }
  if (personaEngine) return personaEngine
  const engine = new UciEngine(stockfishPath())
  await engine.start()
  engine.setOption('Threads', 1)
  engine.setOption('Hash', 64)
  await engine.isready()
  // A process that dies on its own must not be handed to the next move.
  engine.once('exit', () => {
    if (personaEngine === engine) personaEngine = null
  })
  personaEngine = engine
  return engine
}

/** Drop the pooled engine (crash/timeout or idle end-of-game) and kill the process. */
function dropPersonaEngine(engine: UciEngine): void {
  if (personaEngine === engine) personaEngine = null
  void engine.quit().catch(() => engine.kill())
}

/** After each move, (re)arm the idle disposal, the "returned on game end" path. */
function schedulePersonaIdleDisposal(): void {
  if (personaIdleTimer) clearTimeout(personaIdleTimer)
  personaIdleTimer = setTimeout(() => {
    personaIdleTimer = null
    if (personaEngine) dropPersonaEngine(personaEngine)
  }, PERSONA_ENGINE_IDLE_MS)
  // Never keep a headless process alive just for the disposal timer.
  personaIdleTimer.unref?.()
}

// ---- Main entry ------------------------------------------------------------------

/**
 * Select a style-weighted move for the given persona in the given position.
 * Runs on the shared persona engine (see above; pooled + serialized, arms-length
 * from the analysis/play pool so a persona game never starves analysis), caps
 * strength near the persona's MODERN-era Elo estimate (a 2700 from 1900 is far
 * weaker than a 2700 today: the bot should play at the honest present-day
 * strength the detail card advertises; peakElo remains the historical display
 * number), and returns the chosen UCI move plus its line eval.
 */
export async function selectMove(args: SelectMoveArgs): Promise<SelectMoveResult> {
  const persona = getPersona(args.personaId)
  if (!persona) throw new Error(`Unknown persona: ${args.personaId}`)
  const strengthElo = persona.modernElo ?? persona.peakElo

  // Validate the position up front so we fail fast on garbage input.
  const pos = posFromFen(args.fen)
  if (!pos) throw new Error('Invalid FEN')
  // Normalize the FEN the engine sees (defensive against odd whitespace).
  const fen = makeFen(pos.toSetup())

  // Opening book: while in this persona's real repertoire, play their move and
  // skip the engine entirely, so Tal plays Tal's openings, Fischer plays 1.e4, etc.
  const booked = bookMove(args.personaId, fen)
  if (booked) return { bestmove: booked }

  return serializePersona(async () => {
    const engine = await getPersonaEngine()
    try {
      // Drain any abandoned search to idle before touching options. Same
      // discipline as engine:play in engine.ipc.ts.
      await engine.stop()
      engine.setOption('UCI_LimitStrength', true)
      engine.setOption('UCI_Elo', clampElo(strengthElo))
      return await selectOnEngine(engine, persona, fen, args)
    } catch (err) {
      // Wedged/crashed engine: kill + drop so the next move respawns cleanly
      // (KatagoPool discipline). The caller surfaces the error; the renderer
      // falls back to a random legal move so the turn never hangs.
      dropPersonaEngine(engine)
      throw err instanceof Error ? err : new Error(String(err))
    } finally {
      schedulePersonaIdleDisposal()
    }
  })
}

async function selectOnEngine(
  engine: UciEngine,
  persona: Persona,
  fen: string,
  args: SelectMoveArgs
): Promise<SelectMoveResult> {
  const strengthElo = persona.modernElo ?? persona.peakElo
  const limit =
    args.movetimeMs !== undefined
      ? ({ kind: 'movetime', value: Math.max(50, Math.round(args.movetimeMs)) } as const)
      : ({ kind: 'depth', value: Math.max(4, args.depth ?? defaultDepth(strengthElo)) } as const)

  const { lines, bestmove } = await searchLines(engine, fen, 6, limit)

  // Assemble candidates ordered by multipv rank.
  const candidates: Candidate[] = []
  for (let rank = 1; rank <= 6; rank++) {
    const info = lines.get(rank)
    if (!info) continue
    const cand = infoToCandidate(rank, info)
    if (cand) candidates.push(cand)
  }

  // Fallback: if MultiPV produced nothing usable, trust the engine's bestmove.
  if (candidates.length === 0) {
    return { bestmove }
  }

  const best = candidates.reduce((a, b) => (evalScalar(b) > evalScalar(a) ? b : a))
  const bestScalar = evalScalar(best)
  const tolCp = evalTolerancePawns(persona) * 100

  // Keep lines within tolerance of best (always keep best itself).
  const eligible = candidates.filter((c) => bestScalar - evalScalar(c) <= tolCp)
  const pool = eligible.length > 0 ? eligible : [best]

  // Style-score each eligible candidate and pick the highest. Ties resolve toward
  // the higher-eval (lower-rank) line for stability.
  let chosen = pool[0]
  let chosenScore = -Infinity
  for (const c of pool) {
    const traits = classifyMove(fen, c.uci)
    const s = styleScore(persona, c, best, traits)
    if (s > chosenScore || (s === chosenScore && c.rank < chosen.rank)) {
      chosen = c
      chosenScore = s
    }
  }

  return {
    bestmove: chosen.uci,
    lineEval: { cp: chosen.cp, mate: chosen.mate }
  }
}
