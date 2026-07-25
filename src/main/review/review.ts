// Full-game review: walk a game's mainline, analyze each position once with a
// single Stockfish at a fixed depth (MultiPV 2), and compute per-move Win% /
// Accuracy / classification, per-side accuracy + ACPL, an estimated-Elo band, and
// a coach hook for each critical move. Results are cached to app.sqlite.
//
// Depth scales with game length (short games afford deeper searches): <=40 plies
// -> 20, <=80 -> 18, else 16. An explicit opts.depth overrides the scaling.
//
// content-coaching.md is authoritative for all formulas/thresholds; architecture.md
// §6 for the engine contract. This module owns its own DB tables (game_review,
// move_eval) created lazily with CREATE TABLE IF NOT EXISTS. It does NOT touch the
// shared migration. It stays decoupled from the coach: it returns enough per-move
// data for the renderer to call coach:explainMove later (or for a coach module to
// consume directly), rather than importing the coach itself.

import { Chess } from 'chessops/chess'
import { parseFen, makeFen, INITIAL_FEN } from 'chessops/fen'
import { makeSan, parseSan } from 'chessops/san'
import { parseUci, makeUci } from 'chessops/util'
import { parsePgn, startingPosition } from 'chessops/pgn'
import { UciEngine, type InfoLine } from '../engine/UciEngine'
import { stockfishPath } from '../engine/paths'
import { getAppDb } from '../db/database'
import {
  winPercent,
  winChances,
  moveAccuracy,
  gameAccuracy,
  acpl,
  classifyBadge,
  computeIsBest,
  canonicalUci,
  sanLine,
  BOOK_MAX_PLY,
  type ReviewVerdict,
  type MoveBadge,
  type EvalScore
} from '../analysis/accuracy'
import { lookupByFen } from '../openings/openings.repo'
import { estimateElo, type EloBand } from '../analysis/estElo'

// ---- Public input/output shapes -------------------------------------------------

/** A mainline move as supplied by the renderer (or derived from a PGN). */
export interface ReviewMoveInput {
  san: string
  uci: string
  /** FEN of the position BEFORE this move (the position the mover faced). */
  fen: string
}

export interface RunReviewOptions {
  /** Pre-parsed mainline moves. Provide this OR `pgn`. */
  moves?: ReviewMoveInput[]
  /** A PGN string; the mainline is extracted and analyzed. */
  pgn?: string
  /** Fixed analysis depth. Omitted => length-scaled default (see reviewDepthFor). */
  depth?: number
  /** Persist under this game id (enables review:get caching). */
  gameId?: number
  /** Progress callback: fired per analyzed ply. */
  onProgress?: (ply: number, total: number) => void
  /**
   * Optional abort signal (review:cancel). Checked between engine searches; a
   * fired signal also stops the in-flight search so cancellation is prompt. An
   * aborted run rejects with 'review cancelled' and persists nothing.
   */
  signal?: AbortSignal
}

/** Engine eval at a position, from the side-to-move POV. */
export interface PovEval {
  cp: number | null
  mate: number | null
}

/** Per-move analysis result (mover POV throughout). */
export interface MoveEval {
  ply: number // 1-based half-move index
  color: 'white' | 'black'
  san: string
  uci: string
  fenBefore: string
  fenAfter: string
  bestUci: string
  bestSan: string
  /** Best line PV (uci moves), from the position before the move. */
  bestPv: string[]
  /** Second-best line first move (uci), if MultiPV>=2 produced one. */
  secondUci: string | null
  /** Engine eval of the best move, mover POV. */
  bestEval: PovEval
  /** Engine eval after the played move, mover POV. */
  playedEval: PovEval
  /** Win% before the move (best line), mover POV, 0..100. */
  winBefore: number
  /** Win% after the played move, mover POV, 0..100. */
  winAfter: number
  /** Per-move accuracy 0..100. */
  accuracy: number
  /** Centipawn loss (mover POV, capped per move). */
  cpLoss: number
  /** Win% drop on the 0..1 chances scale (POV-signed). */
  winChancesDrop: number
  /** Review verdict bucket. */
  verdict: ReviewVerdict
  /** Rich badge label. */
  badge: MoveBadge
  /** Factual per-move comment (engine data only; absent on old cached rows). */
  comment?: string
  /** Whether the played move was the engine's best. */
  isBest: boolean
  /** Critical = a move worth a coach comment (inaccuracy+, or a notable badge). */
  critical: boolean
}

export interface SideSummary {
  accuracy: number
  acpl: number
  moves: number
  inaccuracies: number
  mistakes: number
  blunders: number
  best: number
}

export interface GameReview {
  gameId: number | null
  depth: number
  totalPlies: number
  white: SideSummary
  black: SideSummary
  whiteElo: EloBand
  blackElo: EloBand
  moveEvals: MoveEval[]
}

// ---- chessops helpers -----------------------------------------------------------

function posFromFen(fen: string): Chess {
  const setup = parseFen(fen).unwrap()
  return Chess.fromSetup(setup).unwrap()
}

function turnColor(pos: Chess): 'white' | 'black' {
  return pos.turn
}

/** Build the mainline move list (san/uci/fenBefore) from a PGN string. */
export function movesFromPgn(pgn: string): ReviewMoveInput[] {
  const games = parsePgn(pgn)
  if (games.length === 0) return []
  const game = games[0]
  const pos = startingPosition(game.headers).unwrap() as Chess
  const out: ReviewMoveInput[] = []
  let node = game.moves
  while (node.children.length > 0) {
    const child = node.children[0]
    const fenBefore = makeFen(pos.toSetup())
    const move = parseSan(pos, child.data.san)
    if (!move) break
    const uci = makeUci(move)
    const san = makeSan(pos, move)
    out.push({ san, uci, fen: fenBefore })
    pos.play(move)
    node = child
  }
  return out
}

// ---- Engine analysis of one position -------------------------------------------

interface MultiPvSnapshot {
  /** latest InfoLine per multipv index (1-based). */
  lines: Map<number, InfoLine>
}

/**
 * Analyze a single FEN to fixed depth with MultiPV 2; resolve once `bestmove`
 * arrives with the latest line per multipv index.
 */
function analyzeFen(engine: UciEngine, fen: string, depth: number, multipv: number): Promise<MultiPvSnapshot> {
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
    const onBest = (): void => {
      if (done) return
      done = true
      cleanup()
      resolve({ lines })
    }
    const fail = (e: Error): void => {
      if (done) return
      done = true
      cleanup()
      reject(e)
    }
    const onExit = (): void => fail(new Error('engine exited during review'))
    const onErr = (err: Error): void =>
      fail(err instanceof Error ? err : new Error('engine error during review'))
    // Depth-scaled hard ceiling so a crashed or stuck search can never hang the
    // whole review forever: that used to wedge the single-flight `reviewing` flag
    // (review.ipc.ts) until an app restart. Generous: ~2.5s/depth, floored at 20s.
    const timer = setTimeout(
      () => fail(new Error('engine analysis timeout')),
      Math.max(20000, depth * 2500)
    )
    engine.on('info', onInfo)
    engine.once('bestmove', onBest)
    engine.once('exit', onExit)
    engine.once('engineError', onErr)
    void engine.search(fen, { kind: 'depth', value: depth }, multipv)
  })
}

function infoToEval(info: InfoLine | undefined): PovEval {
  if (!info) return { cp: 0, mate: null }
  if (info.mate !== undefined) return { cp: null, mate: info.mate }
  return { cp: info.scoreCp ?? 0, mate: null }
}

/** Negate a side-to-move eval to express it from the opponent's POV. */
function negateEval(e: PovEval): PovEval {
  return {
    cp: e.cp != null ? -e.cp : null,
    mate: e.mate != null ? -e.mate : null
  }
}

function evalToScore(e: PovEval): EvalScore {
  return { cp: e.cp, mate: e.mate }
}

function evalWinPercent(e: PovEval): number {
  return winPercent(e.cp, e.mate)
}

// ---- Factual per-move comment (chess.com style) -----------------------------------
// Derived ONLY from engine data: played/best SAN, mate distances, the punishing PV
// line, and the Brilliant sacrifice detector's role. No motif guessing.

const ROLE_NAME: Record<string, string> = {
  pawn: 'pawn',
  knight: 'knight',
  bishop: 'bishop',
  rook: 'rook',
  queen: 'queen',
  king: 'king'
}

function buildComment(a: {
  badge: MoveBadge
  playedSan: string
  bestSan: string
  bestMate: number | null
  playedMate: number | null
  /** SANs of the opponent's punishing continuation, from fenAfter. */
  refutation: string[]
  sacrificedRole: string | null
}): string {
  const { badge, playedSan, bestSan } = a
  const ref = a.refutation.join(' ')
  const allowsMate =
    a.playedMate != null && a.playedMate < 0 ? ` This allows mate in ${-a.playedMate}.` : ''
  const missedMate =
    a.bestMate != null && a.bestMate > 0 ? ` ${bestSan} forced mate in ${a.bestMate}.` : ''
  switch (badge) {
    case 'Brilliant':
      return `${playedSan} is brilliant! Giving up ${
        a.sacrificedRole ? `the ${ROLE_NAME[a.sacrificedRole] ?? 'piece'}` : 'material'
      } is the strongest move here.`
    case 'Great':
      return `${playedSan} is a great find. The only good move in the position.`
    case 'Best':
      return `${playedSan} is the best move.`
    case 'Excellent':
      return `${playedSan} is an excellent move.`
    case 'Good':
      return `${playedSan} is a good move. ${bestSan} was the engine's first choice.`
    case 'Book':
      return `${playedSan} is opening theory.`
    case 'Forced':
      return `${playedSan} was forced.`
    case 'Inaccuracy':
      return `${playedSan} is an inaccuracy. ${bestSan} was best.${allowsMate}`
    case 'Miss':
      return `${playedSan} misses the chance: ${bestSan} was much stronger.${missedMate}`
    case 'Mistake':
      return `${playedSan} is a mistake. ${bestSan} was best.${allowsMate}${
        ref ? ` The problem: ${ref}.` : ''
      }`
    case 'Blunder':
      return `${playedSan} is a blunder. ${bestSan} was best.${allowsMate}${
        ref ? ` Now ${ref} punishes it.` : ''
      }`
    default:
      return `${playedSan}.`
  }
}

// ---- Critical-move detection ----------------------------------------------------

const CRITICAL_VERDICTS: ReviewVerdict[] = ['inaccuracy', 'mistake', 'blunder']
const NOTABLE_BADGES: MoveBadge[] = ['Brilliant', 'Great', 'Miss']

function isCritical(verdict: ReviewVerdict, badge: MoveBadge): boolean {
  return CRITICAL_VERDICTS.includes(verdict) || NOTABLE_BADGES.includes(badge)
}

// ---- Depth scaling ----------------------------------------------------------------

/**
 * Length-scaled review depth: short games get the deepest search, long games a
 * still-strong one so total review time stays bounded. The analyzeFen timeout
 * (~2.5s/depth, 20s floor) scales off whatever depth this returns, so the
 * hard-ceiling stays consistent with the deeper defaults.
 */
export function reviewDepthFor(totalPlies: number): number {
  if (totalPlies <= 40) return 20
  if (totalPlies <= 80) return 18
  return 16
}

// ---- Main entry -----------------------------------------------------------------

/**
 * Run a full-game review. Starts ONE Stockfish, analyzes every mainline position to
 * fixed depth with MultiPV 2, computes per-move metrics + per-side summaries + an
 * estimated-Elo band, caches to DB (if gameId given), and streams progress.
 */
export async function runReview(opts: RunReviewOptions): Promise<GameReview> {
  initReviewTables()

  const moves = opts.moves ?? (opts.pgn ? movesFromPgn(opts.pgn) : [])
  const total = moves.length
  const depth = opts.depth ?? reviewDepthFor(total)

  const engine = new UciEngine(stockfishPath())
  const moveEvals: MoveEval[] = []

  const signal = opts.signal
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new Error('review cancelled')
  }
  // A fired abort interrupts whichever search is in flight (UCI `stop` makes its
  // `bestmove` arrive immediately); the throwIfAborted checks below then exit the
  // loop before another search starts. The signal only ever fires once.
  const onAbort = (): void => {
    void engine.stop().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    throwIfAborted()
    await engine.start()
    engine.setOption('UCI_LimitStrength', false)
    engine.setOption('Threads', 1)
    engine.setOption('Hash', 128)
    engine.setOption('MultiPV', 2)
    await engine.newGame()

    // Book tracking: theory only while EVERY prior move was theory (unbroken prefix).
    let stillInBook = true

    for (let i = 0; i < total; i++) {
      throwIfAborted()
      const m = moves[i]
      const fenBefore = m.fen
      const beforePos = posFromFen(fenBefore)
      const color = turnColor(beforePos)

      // 1) Analyze the position the mover faced (mover POV = side-to-move).
      const snap = await analyzeFen(engine, fenBefore, depth, 2)
      const best = snap.lines.get(1)
      const second = snap.lines.get(2)
      const bestEval = infoToEval(best) // mover POV
      const bestPv = best?.pv ?? []
      const bestUci = bestPv[0] ?? m.uci
      const secondUci = second?.pv?.[0] ?? null

      // bestSan / fenAfter (after PLAYED move)
      const playedMove = parseUci(m.uci)
      let fenAfter = fenBefore
      let bestSan = bestUci
      try {
        const tmp = posFromFen(fenBefore)
        const bm = parseUci(bestUci)
        if (bm) bestSan = makeSan(tmp, bm)
      } catch {
        /* keep uci fallback */
      }

      // Canonicalised UCIs (castling e1g1 vs e1h1) so best/second matching is exact.
      const playedC = canonicalUci(fenBefore, m.uci)
      const bestC = canonicalUci(fenBefore, bestUci)
      const secondC = secondUci ? canonicalUci(fenBefore, secondUci) : null
      const secondEval: PovEval | null = second ? infoToEval(second) : null

      // 2) Eval AFTER the played move. Matching PV1 reuses bestEval; matching PV2
      //    reuses PV2's eval from the SAME fenBefore search (no fresh opposite-
      //    parity search -> no phantom drop, and co-best moves can earn Best).
      //    Only a move outside both lines pays for a second search.
      let playedEval: PovEval
      let playedPv: string[] = bestPv
      let isBest = false
      if (playedMove && beforePos.isLegal(playedMove)) {
        const afterPos = beforePos.clone()
        afterPos.play(playedMove)
        fenAfter = makeFen(afterPos.toSetup())
        if (afterPos.isCheckmate()) {
          // mover delivered mate: by definition the best practical outcome, even
          // when the engine's PV preferred a different (e.g. faster-mate) move.
          playedEval = { cp: null, mate: 1 }
          playedPv = [m.uci]
          isBest = true
        } else if (playedC === bestC) {
          isBest = true
          playedEval = bestEval
          playedPv = bestPv
        } else if (secondC != null && playedC === secondC && secondEval) {
          isBest = computeIsBest(
            playedC,
            bestC,
            secondC,
            evalToScore(bestEval),
            evalToScore(secondEval)
          )
          playedEval = secondEval
          playedPv = second?.pv ?? [m.uci]
        } else {
          // Second search of this ply: bail here too so an abort fired during the
          // first search (already stopped by onAbort) can't launch a fresh one.
          throwIfAborted()
          const afterSnap = await analyzeFen(engine, fenAfter, depth, 1)
          const afterBest = afterSnap.lines.get(1)
          // afterBest is from the OPPONENT's POV (they are to move) -> negate.
          playedEval = negateEval(infoToEval(afterBest))
          playedPv = [m.uci, ...(afterBest?.pv ?? [])]
        }
      } else {
        // Illegal/unparseable played move: fall back to best (defensive).
        playedEval = bestEval
        fenAfter = fenBefore
      }

      // 3) Win% + accuracy (all mover POV).
      const winBefore = evalWinPercent(bestEval)
      const winAfter = evalWinPercent(playedEval)
      const accuracy = moveAccuracy(winBefore, winAfter)

      const chancesBefore = winChances(bestEval.cp, bestEval.mate)
      const chancesAfter = winChances(playedEval.cp, playedEval.mate)
      const winChancesDrop = chancesBefore - chancesAfter

      // cp loss (mover POV), capped per move at 1000.
      // 'mate 0' means the POV side is already mated => losing extreme (-1000), NOT
      // equal (Math.sign(0) === 0 would mis-score a decided position as 0 cp).
      const mateToCpSide = (mate: number): number => (mate === 0 ? -1000 : Math.sign(mate) * 1000)
      const cpBefore = bestEval.mate != null ? mateToCpSide(bestEval.mate) : (bestEval.cp ?? 0)
      const cpAfter = playedEval.mate != null ? mateToCpSide(playedEval.mate) : (playedEval.cp ?? 0)
      const cpLoss = Math.max(0, Math.min(1000, cpBefore - cpAfter))

      // Book: an unbroken openings-DB prefix. This move is theory only while every
      // move before it was, the resulting position is still in the book, and we are
      // within the book ply window.
      const inBook = stillInBook && i + 1 <= BOOK_MAX_PLY && lookupByFen(fenAfter) != null
      if (!inBook) stillInBook = false

      // The opponent's immediately preceding move's FINAL badge (Great G3 / Miss).
      const prevOppFinalBadge = moveEvals.length > 0 ? moveEvals[moveEvals.length - 1].badge : null

      // 4) Classification (REVIEW-SPEC S1-S9) + the derived verdict, so the badge
      //    chip and the verdict counters can never disagree.
      const { badge, verdict, sacrificedRole } = classifyBadge({
        fenBefore,
        fenAfter,
        playedUci: playedC,
        playedSan: m.san,
        isBest,
        bestEval: evalToScore(bestEval),
        playedEval: evalToScore(playedEval),
        secondEval: secondEval ? evalToScore(secondEval) : null,
        inBook,
        prevOppFinalBadge
      })

      // 5) Factual comment (engine data only: no motif guessing).
      const comment = buildComment({
        badge,
        playedSan: m.san,
        bestSan,
        bestMate: bestEval.mate ?? null,
        playedMate: playedEval.mate ?? null,
        refutation: sanLine(fenAfter, playedPv.slice(1), 3),
        sacrificedRole: sacrificedRole ?? null
      })

      const me: MoveEval = {
        ply: i + 1,
        color,
        san: m.san,
        uci: m.uci,
        fenBefore,
        fenAfter,
        bestUci,
        bestSan,
        bestPv,
        secondUci,
        bestEval,
        playedEval,
        winBefore,
        winAfter,
        accuracy,
        cpLoss,
        winChancesDrop,
        verdict,
        badge,
        comment,
        isBest,
        critical: isCritical(verdict, badge)
      }
      moveEvals.push(me)

      opts.onProgress?.(i + 1, total)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await engine.quit().catch(() => engine.kill())
  }

  const review = summarize(moveEvals, depth, opts.gameId ?? null)
  if (opts.gameId != null) persistReview(opts.gameId, review)
  return review
}


// ---- Summaries ------------------------------------------------------------------

function summarize(moveEvals: MoveEval[], depth: number, gameId: number | null): GameReview {
  const whiteWin: number[] = []
  const blackWin: number[] = []
  // POV-relative Win% for the volatility window: store white-POV Win% per ply.
  const whitePovWin: number[] = []
  const blackPovWin: number[] = []
  const whiteIdx: number[] = []
  const blackIdx: number[] = []

  const whiteAcc: number[] = []
  const blackAcc: number[] = []
  const whiteLoss: number[] = []
  const blackLoss: number[] = []

  moveEvals.forEach((m, i) => {
    // winAfter is mover POV; white-POV value is winAfter (white) or 100-winAfter (black).
    const whitePov = m.color === 'white' ? m.winAfter : 100 - m.winAfter
    whitePovWin.push(whitePov)
    blackPovWin.push(100 - whitePov)
    if (m.color === 'white') {
      whiteAcc.push(m.accuracy)
      whiteLoss.push(m.cpLoss)
      whiteIdx.push(i)
      whiteWin.push(m.winAfter)
    } else {
      blackAcc.push(m.accuracy)
      blackLoss.push(m.cpLoss)
      blackIdx.push(i)
      blackWin.push(m.winAfter)
    }
  })

  const white = sideSummary(moveEvals, 'white', whiteAcc, whiteLoss, whitePovWin, whiteIdx)
  const black = sideSummary(moveEvals, 'black', blackAcc, blackLoss, blackPovWin, blackIdx)

  return {
    gameId,
    depth,
    totalPlies: moveEvals.length,
    white,
    black,
    // Blend accuracy with ACPL: accuracy anchors alone overrate short games.
    whiteElo: estimateElo(white.accuracy, white.moves, white.acpl),
    blackElo: estimateElo(black.accuracy, black.moves, black.acpl),
    moveEvals
  }
}

function sideSummary(
  all: MoveEval[],
  color: 'white' | 'black',
  accs: number[],
  losses: number[],
  povWin: number[],
  idx: number[]
): SideSummary {
  const own = all.filter((m) => m.color === color)
  return {
    accuracy: Math.round(gameAccuracy(accs, povWin, idx) * 10) / 10,
    acpl: Math.round(acpl(losses)),
    moves: own.length,
    inaccuracies: own.filter((m) => m.verdict === 'inaccuracy').length,
    mistakes: own.filter((m) => m.verdict === 'mistake').length,
    blunders: own.filter((m) => m.verdict === 'blunder').length,
    best: own.filter((m) => m.isBest).length
  }
}

// ---- DB cache (own tables, CREATE TABLE IF NOT EXISTS) ---------------------------

let tablesReady = false

export function initReviewTables(): void {
  if (tablesReady) return
  ensureReviewTables()
  tablesReady = true
}

/**
 * Create the review cache tables on the CURRENT app DB, idempotent DDL with NO
 * module flag. The desktop path uses initReviewTables() (one process-singleton
 * DB, so the flag short-circuit is safe); the web server (docs/WEB-PORT-SPEC.md
 * W3) reroutes getAppDb() to a DIFFERENT per-user DB per request via
 * setDbOverride, where a process-wide flag would skip table creation for every
 * user after the first, so the server calls this, per user DB, instead.
 */
export function ensureReviewTables(): void {
  getAppDb().exec(`
    CREATE TABLE IF NOT EXISTS game_review(
      game_id INTEGER PRIMARY KEY,
      depth INTEGER NOT NULL,
      total_plies INTEGER NOT NULL,
      accuracy_white REAL, accuracy_black REAL,
      acpl_white INTEGER, acpl_black INTEGER,
      white_inacc INTEGER, white_mist INTEGER, white_blun INTEGER, white_best INTEGER,
      black_inacc INTEGER, black_mist INTEGER, black_blun INTEGER, black_best INTEGER,
      est_elo_white INTEGER, est_elo_white_low INTEGER, est_elo_white_high INTEGER,
      est_elo_black INTEGER, est_elo_black_low INTEGER, est_elo_black_high INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS move_eval(
      game_id INTEGER NOT NULL,
      ply INTEGER NOT NULL,
      color TEXT NOT NULL,
      san TEXT NOT NULL,
      uci TEXT NOT NULL,
      fen_before TEXT NOT NULL,
      fen_after TEXT NOT NULL,
      best_uci TEXT, best_san TEXT, best_pv TEXT, second_uci TEXT,
      best_cp INTEGER, best_mate INTEGER,
      played_cp INTEGER, played_mate INTEGER,
      win_before REAL, win_after REAL,
      accuracy REAL, cp_loss INTEGER, win_chances_drop REAL,
      verdict TEXT, badge TEXT, is_best INTEGER, critical INTEGER,
      PRIMARY KEY (game_id, ply)
    );
    CREATE INDEX IF NOT EXISTS idx_move_eval_game ON move_eval(game_id);
  `)
}

/**
 * Persist a fully computed review under `gameId` on the CURRENT app DB. The
 * desktop persists inside runReview(); the web server stores client-computed
 * reviews via POST /api/review/save, which calls this under its per-user DB
 * override (docs/WEB-PORT-SPEC.md W3). Same transactional DELETE+INSERT as the
 * desktop path. The two share persistReview().
 */
export function saveReviewCache(gameId: number, review: GameReview): void {
  ensureReviewTables()
  persistReview(gameId, review)
}

function persistReview(gameId: number, r: GameReview): void {
  const db = getAppDb()
  const now = Date.now()
  // One transaction for the whole DELETE+INSERT rewrite of both cache tables: a
  // crash mid-write must never leave a game_review row without its move_eval
  // rows (or a half-deleted previous review). Same BEGIN/COMMIT/ROLLBACK idiom
  // as db/database.ts migrate().
  db.exec('BEGIN')
  try {
    persistReviewStatements(db, gameId, r, now)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function persistReviewStatements(
  db: ReturnType<typeof getAppDb>,
  gameId: number,
  r: GameReview,
  now: number
): void {
  db.prepare('DELETE FROM game_review WHERE game_id=?').run(gameId)
  db.prepare('DELETE FROM move_eval WHERE game_id=?').run(gameId)

  db.prepare(
    `INSERT INTO game_review(
       game_id,depth,total_plies,accuracy_white,accuracy_black,acpl_white,acpl_black,
       white_inacc,white_mist,white_blun,white_best,
       black_inacc,black_mist,black_blun,black_best,
       est_elo_white,est_elo_white_low,est_elo_white_high,
       est_elo_black,est_elo_black_low,est_elo_black_high,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    gameId,
    r.depth,
    r.totalPlies,
    r.white.accuracy,
    r.black.accuracy,
    r.white.acpl,
    r.black.acpl,
    r.white.inaccuracies,
    r.white.mistakes,
    r.white.blunders,
    r.white.best,
    r.black.inaccuracies,
    r.black.mistakes,
    r.black.blunders,
    r.black.best,
    r.whiteElo.est,
    r.whiteElo.low,
    r.whiteElo.high,
    r.blackElo.est,
    r.blackElo.low,
    r.blackElo.high,
    now
  )

  const ins = db.prepare(
    `INSERT INTO move_eval(
       game_id,ply,color,san,uci,fen_before,fen_after,best_uci,best_san,best_pv,second_uci,
       best_cp,best_mate,played_cp,played_mate,win_before,win_after,accuracy,cp_loss,
       win_chances_drop,verdict,badge,is_best,critical)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  for (const m of r.moveEvals) {
    ins.run(
      gameId,
      m.ply,
      m.color,
      m.san,
      m.uci,
      m.fenBefore,
      m.fenAfter,
      m.bestUci,
      m.bestSan,
      m.bestPv.join(' '),
      m.secondUci,
      m.bestEval.cp,
      m.bestEval.mate,
      m.playedEval.cp,
      m.playedEval.mate,
      m.winBefore,
      m.winAfter,
      m.accuracy,
      m.cpLoss,
      m.winChancesDrop,
      m.verdict,
      m.badge,
      m.isBest ? 1 : 0,
      m.critical ? 1 : 0
    )
  }
}

interface GameReviewDbRow {
  game_id: number
  depth: number
  total_plies: number
  accuracy_white: number | null
  accuracy_black: number | null
  acpl_white: number | null
  acpl_black: number | null
  white_inacc: number
  white_mist: number
  white_blun: number
  white_best: number
  black_inacc: number
  black_mist: number
  black_blun: number
  black_best: number
  est_elo_white: number
  est_elo_white_low: number
  est_elo_white_high: number
  est_elo_black: number
  est_elo_black_low: number
  est_elo_black_high: number
}

interface MoveEvalDbRow {
  ply: number
  color: string
  san: string
  uci: string
  fen_before: string
  fen_after: string
  best_uci: string | null
  best_san: string | null
  best_pv: string | null
  second_uci: string | null
  best_cp: number | null
  best_mate: number | null
  played_cp: number | null
  played_mate: number | null
  win_before: number | null
  win_after: number | null
  accuracy: number | null
  cp_loss: number | null
  win_chances_drop: number | null
  verdict: string | null
  badge: string | null
  is_best: number
  critical: number
}

/** Load a cached review for a game (review + per-move evals), or null. */
export function getCachedReview(
  gameId: number
): { review: GameReview; moveEvals: MoveEval[] } | null {
  initReviewTables()
  const db = getAppDb()
  const row = db
    .prepare('SELECT * FROM game_review WHERE game_id=?')
    .get(gameId) as unknown as GameReviewDbRow | undefined
  if (!row) return null

  const rows = db
    .prepare('SELECT * FROM move_eval WHERE game_id=? ORDER BY ply')
    .all(gameId) as unknown as MoveEvalDbRow[]

  const moveEvals: MoveEval[] = rows.map((r) => ({
    ply: r.ply,
    color: r.color === 'black' ? 'black' : 'white',
    san: r.san,
    uci: r.uci,
    fenBefore: r.fen_before,
    fenAfter: r.fen_after,
    bestUci: r.best_uci ?? '',
    bestSan: r.best_san ?? '',
    bestPv: r.best_pv ? r.best_pv.split(' ').filter(Boolean) : [],
    secondUci: r.second_uci,
    bestEval: { cp: r.best_cp, mate: r.best_mate },
    playedEval: { cp: r.played_cp, mate: r.played_mate },
    winBefore: r.win_before ?? 0,
    winAfter: r.win_after ?? 0,
    accuracy: r.accuracy ?? 0,
    cpLoss: r.cp_loss ?? 0,
    winChancesDrop: r.win_chances_drop ?? 0,
    verdict: (r.verdict ?? 'ok') as ReviewVerdict,
    badge: (r.badge ?? 'Good') as MoveBadge,
    isBest: r.is_best === 1,
    critical: r.critical === 1
  }))

  const review: GameReview = {
    gameId,
    depth: row.depth,
    totalPlies: row.total_plies,
    white: {
      accuracy: row.accuracy_white ?? 0,
      acpl: row.acpl_white ?? 0,
      moves: moveEvals.filter((m) => m.color === 'white').length,
      inaccuracies: row.white_inacc,
      mistakes: row.white_mist,
      blunders: row.white_blun,
      best: row.white_best
    },
    black: {
      accuracy: row.accuracy_black ?? 0,
      acpl: row.acpl_black ?? 0,
      moves: moveEvals.filter((m) => m.color === 'black').length,
      inaccuracies: row.black_inacc,
      mistakes: row.black_mist,
      blunders: row.black_blun,
      best: row.black_best
    },
    whiteElo: {
      est: row.est_elo_white,
      low: row.est_elo_white_low,
      high: row.est_elo_white_high,
      accuracy: row.accuracy_white ?? 0,
      kind: 'estimate'
    },
    blackElo: {
      est: row.est_elo_black,
      low: row.est_elo_black_low,
      high: row.est_elo_black_high,
      accuracy: row.accuracy_black ?? 0,
      kind: 'estimate'
    },
    moveEvals
  }
  return { review, moveEvals }
}

// Re-export so the IPC layer can use this without reaching into chess helpers.
export { INITIAL_FEN }
