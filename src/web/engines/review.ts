// Client-side full-game review. The web port of src/main/review/review.ts
// minus the DB: same mainline walk, same MultiPV-2 fixed-depth analysis per
// position (on the shared ANALYSIS instance), same mover-POV Win%/accuracy/
// classification/comment pipeline, same per-side summaries and Elo bands.
// Persistence goes through the injected ReviewStore (localStorage logged out,
// HTTP logged in: the client agent's stores).
//
// The math/classification modules are imported DIRECTLY from the desktop
// source: src/main/analysis/accuracy.ts and estElo.ts are electron-free by
// design ("no engine, no DB, no Electron"), so web and desktop reviews can
// never drift. Only the orchestration (this file) is re-implemented, because
// desktop review.ts imports UciEngine (child_process) and the DB.
//
// The analysis step is injected (AnalyzeFn) so the headless suite can drive
// the whole pipeline over canned evals with zero WASM.

import { Chess } from 'chessops/chess'
import { parseFen, makeFen } from 'chessops/fen'
import { makeSan, parseSan } from 'chessops/san'
import { parseUci, makeUci } from 'chessops/util'
import { parsePgn, startingPosition } from 'chessops/pgn'
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
} from '../../main/analysis/accuracy'
import { estimateElo } from '../../main/analysis/estElo'
import type {
  Api,
  GameReview,
  OpeningInfo,
  ReviewMoveEval,
  ReviewProgress,
  ReviewSideSummary
} from '@shared/types'
import type { ReviewStore } from './index'
import { webEngineSupported } from './assets'
import { pool, serializeAnalysis } from './pools'
import type { WebUciEngine } from './WebUciEngine'
import type { InfoLine } from './uci'

// ---- Public input shapes (desktop parity) -----------------------------------------

/** A mainline move (san/uci/fen-before), as derived from the PGN. */
export interface ReviewMoveInput {
  san: string
  uci: string
  fen: string
}

/** Engine eval at a position, from the side-to-move POV. */
interface PovEval {
  cp: number | null
  mate: number | null
}

// ---- chessops helpers (desktop verbatim) --------------------------------------------

function posFromFen(fen: string): Chess {
  const setup = parseFen(fen).unwrap()
  return Chess.fromSetup(setup).unwrap()
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

// ---- Injected analysis -------------------------------------------------------------

export interface MultiPvSnapshot {
  /** latest InfoLine per multipv index (1-based). */
  lines: Map<number, InfoLine>
}

/** How the pipeline reaches an engine: (fen, depth, multipv) → snapshot. */
export type AnalyzeFn = (fen: string, depth: number, multipv: number) => Promise<MultiPvSnapshot>

/**
 * Analyze a single FEN to fixed depth; resolve once `bestmove` arrives with
 * the latest line per multipv index: desktop analyzeFen verbatim, including
 * the depth-scaled hard ceiling so a wedged search can never hang the review.
 */
export function analyzeFen(
  engine: WebUciEngine,
  fen: string,
  depth: number,
  multipv: number
): Promise<MultiPvSnapshot> {
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

// ---- Factual per-move comment (desktop review.ts buildComment verbatim) -------------

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

// ---- Critical-move detection + depth scaling (desktop verbatim) ---------------------

const CRITICAL_VERDICTS: ReviewVerdict[] = ['inaccuracy', 'mistake', 'blunder']
const NOTABLE_BADGES: MoveBadge[] = ['Brilliant', 'Great', 'Miss']

function isCritical(verdict: ReviewVerdict, badge: MoveBadge): boolean {
  return CRITICAL_VERDICTS.includes(verdict) || NOTABLE_BADGES.includes(badge)
}

/** Length-scaled review depth: <=40 plies → 20, <=80 → 18, else 16. */
export function reviewDepthFor(totalPlies: number): number {
  if (totalPlies <= 40) return 20
  if (totalPlies <= 80) return 18
  return 16
}

// ---- Openings book (same table + EPD normalization as desktop/webApi) ---------------

let openingsTable: Promise<Record<string, OpeningInfo>> | null = null

function loadOpenings(): Promise<Record<string, OpeningInfo>> {
  if (!openingsTable) {
    // Same module id webApi.ts lazy-loads: vite dedupes it into one chunk.
    openingsTable = import('../../../resources/openings/openings.json')
      .then((m) => (m.default ?? m) as Record<string, OpeningInfo>)
      .catch(() => ({}))
  }
  return openingsTable
}

async function inOpeningBook(fen: string): Promise<boolean> {
  const setup = parseFen(fen)
  if (setup.isErr) return false
  const epd = makeFen(setup.value, { epd: true })
  return (await loadOpenings())[epd] !== undefined
}

// ---- The pipeline ------------------------------------------------------------------

export interface ReviewGameOptions {
  moves: ReviewMoveInput[]
  /** Fixed analysis depth. Omitted => length-scaled default. */
  depth?: number
  gameId?: number | null
  analyze: AnalyzeFn
  /** Book test for a position (injectable for the headless suite). */
  isBook?: (fenAfter: string) => Promise<boolean> | boolean
  onProgress?: (ply: number, total: number) => void
  signal?: AbortSignal
}

/**
 * Run the full review pipeline over pre-parsed mainline moves. Desktop
 * runReview's loop verbatim (steps 1-5 per ply), with the engine reached
 * through opts.analyze and the book through opts.isBook.
 */
export async function reviewGame(opts: ReviewGameOptions): Promise<GameReview> {
  const moves = opts.moves
  const total = moves.length
  const depth = opts.depth ?? reviewDepthFor(total)
  const isBook = opts.isBook ?? inOpeningBook
  const moveEvals: ReviewMoveEval[] = []

  const signal = opts.signal
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new Error('review cancelled')
  }

  // Book tracking: theory only while EVERY prior move was theory.
  let stillInBook = true

  for (let i = 0; i < total; i++) {
    throwIfAborted()
    const m = moves[i]
    const fenBefore = m.fen
    const beforePos = posFromFen(fenBefore)
    const color = beforePos.turn

    // 1) Analyze the position the mover faced (mover POV = side-to-move).
    const snap = await opts.analyze(fenBefore, depth, 2)
    const best = snap.lines.get(1)
    const second = snap.lines.get(2)
    const bestEval = infoToEval(best) // mover POV
    const bestPv = best?.pv ?? []
    const bestUci = bestPv[0] ?? m.uci
    const secondUci = second?.pv?.[0] ?? null

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

    // 2) Eval AFTER the played move (PV1/PV2 reuse; outside both lines pays for
    //    a second search of the after-position, opponent POV negated).
    let playedEval: PovEval
    let playedPv: string[] = bestPv
    let isBest = false
    if (playedMove && beforePos.isLegal(playedMove)) {
      const afterPos = beforePos.clone()
      afterPos.play(playedMove)
      fenAfter = makeFen(afterPos.toSetup())
      if (afterPos.isCheckmate()) {
        // mover delivered mate. The best practical outcome by definition.
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
        throwIfAborted()
        const afterSnap = await opts.analyze(fenAfter, depth, 1)
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

    // cp loss (mover POV), capped per move at 1000; 'mate 0' = losing extreme.
    const mateToCpSide = (mate: number): number => (mate === 0 ? -1000 : Math.sign(mate) * 1000)
    const cpBefore = bestEval.mate != null ? mateToCpSide(bestEval.mate) : (bestEval.cp ?? 0)
    const cpAfter = playedEval.mate != null ? mateToCpSide(playedEval.mate) : (playedEval.cp ?? 0)
    const cpLoss = Math.max(0, Math.min(1000, cpBefore - cpAfter))

    // Book: an unbroken openings-DB prefix within the book ply window.
    const inBook = stillInBook && i + 1 <= BOOK_MAX_PLY && (await isBook(fenAfter)) === true
    if (!inBook) stillInBook = false

    // The opponent's immediately preceding move's FINAL badge (Great G3 / Miss).
    const prevOppFinalBadge = moveEvals.length > 0 ? moveEvals[moveEvals.length - 1].badge : null

    // 4) Classification (REVIEW-SPEC S1-S9) + the derived verdict.
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

    moveEvals.push({
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
    })

    opts.onProgress?.(i + 1, total)
  }

  return summarize(moveEvals, depth, opts.gameId ?? null)
}

// ---- Summaries (desktop verbatim) ----------------------------------------------------

function summarize(moveEvals: ReviewMoveEval[], depth: number, gameId: number | null): GameReview {
  const whitePovWin: number[] = []
  const blackPovWin: number[] = []
  const whiteIdx: number[] = []
  const blackIdx: number[] = []
  const whiteAcc: number[] = []
  const blackAcc: number[] = []
  const whiteLoss: number[] = []
  const blackLoss: number[] = []

  moveEvals.forEach((m, i) => {
    const whitePov = m.color === 'white' ? m.winAfter : 100 - m.winAfter
    whitePovWin.push(whitePov)
    blackPovWin.push(100 - whitePov)
    if (m.color === 'white') {
      whiteAcc.push(m.accuracy)
      whiteLoss.push(m.cpLoss)
      whiteIdx.push(i)
    } else {
      blackAcc.push(m.accuracy)
      blackLoss.push(m.cpLoss)
      blackIdx.push(i)
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
  all: ReviewMoveEval[],
  color: 'white' | 'black',
  accs: number[],
  losses: number[],
  povWin: number[],
  idx: number[]
): ReviewSideSummary {
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

// ---- The Api factories ----------------------------------------------------------------

/** Analysis over the SHARED analysis instance, through the analysis chain so
 *  review searches and engine:analyze/stop ops can never interleave. Also the
 *  eval source for the School debrief enricher (debrief.ts). */
export const engineAnalyze: AnalyzeFn = (fen, depth, multipv) =>
  serializeAnalysis(async () => {
    const eng = await pool.getAnalysis()
    // Drain any in-flight (e.g. infinite analysis-board) search first. Same
    // discipline as engine:analyze; the board re-issues its search afterwards.
    await eng.stop()
    return analyzeFen(eng, fen, depth, multipv)
  })

/** Resolve a stored game's PGN via the installed web Api (localStorage archive
 *  logged out, server bridge logged in): the web stand-in for desktop's
 *  games.repo getGame. */
async function pgnForGame(gameId: number): Promise<string> {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.games) throw new Error(`review:run: game ${gameId} not found`)
  const { game } = await api.games.get(gameId)
  if (!game) throw new Error(`review:run: game ${gameId} not found`)
  if (game.game_kind !== 'chess') {
    throw new Error(
      `review:run: game ${gameId} is a '${game.game_kind}' game: the chess review engine only reviews standard chess`
    )
  }
  return game.pgn
}

export function buildReviewApi(store: ReviewStore): Api['review'] {
  if (!webEngineSupported()) {
    // Same construction-time gate as the engine factory: engineless
    // environments fall back to webApi's W1 coming-online copy.
    throw new Error('web review layer unavailable: no Worker/WebAssembly in this environment')
  }
  // Only one review at a time (shared analysis engine, heavy CPU). Desktop
  // review.ipc.ts single-flight semantics, message-compatible (PlacementFlow
  // matches 'already in progress' by substring).
  let reviewing = false
  let reviewAbort: AbortController | null = null
  const progressSubs = new Set<(p: ReviewProgress) => void>()

  return {
    run: async ({ gameId, pgn, depth }) => {
      if (reviewing) throw new Error('review:run: a review is already in progress')
      if (gameId === undefined && pgn === undefined) {
        throw new Error('review:run requires gameId or pgn')
      }
      if (depth !== undefined && (!Number.isInteger(depth) || depth < 6 || depth > 30)) {
        throw new Error('review:run: depth out of range')
      }

      let pgnText = pgn
      const resolvedGameId: number | null = gameId ?? null
      if (pgnText === undefined && gameId !== undefined) {
        pgnText = await pgnForGame(gameId)
      }
      if (pgnText === undefined) throw new Error('review:run: no PGN to review')

      const moves = movesFromPgn(pgnText)
      if (moves.length === 0) throw new Error('review:run: PGN has no mainline moves')

      reviewing = true
      const abort = new AbortController()
      reviewAbort = abort
      try {
        const review = await reviewGame({
          moves,
          depth,
          gameId: resolvedGameId,
          analyze: engineAnalyze,
          signal: abort.signal,
          onProgress: (ply, total) => {
            const p: ReviewProgress = { gameId: resolvedGameId, ply, total }
            for (const cb of [...progressSubs]) cb(p)
          }
        })
        // Persist through the store (it also marks per-side accuracy on the
        // game row: both web store implementations do, mirroring desktop's
        // setGameAccuracy). A pgn-only review is ephemeral, like desktop.
        let reviewId: number | null = resolvedGameId
        if (resolvedGameId != null) {
          const saved = await store.save(resolvedGameId, review)
          reviewId = saved.reviewId ?? resolvedGameId
        }
        return { reviewId, review }
      } finally {
        // The single-flight flag clears ONLY when the run settles (including an
        // aborted one): never out-of-band.
        reviewing = false
        if (reviewAbort === abort) reviewAbort = null
      }
    },

    get: (gameId) => store.load(gameId),

    cancel: async () => {
      reviewAbort?.abort()
      return { ok: true }
    },

    onProgress: (cb) => {
      progressSubs.add(cb)
      return () => {
        progressSubs.delete(cb)
      }
    }
  }
}

// ---- perf.estimate (desktop review.ipc.ts perf:estimate port) ------------------------

export function buildPerfApi(store: ReviewStore): Api['perf'] {
  return {
    estimate: async ({ gameId, accuracy }) => {
      if (gameId === undefined && accuracy === undefined) {
        throw new Error('perf:estimate requires gameId or accuracy')
      }
      // Direct accuracy estimate.
      if (accuracy !== undefined) {
        if (!(accuracy >= 0 && accuracy <= 100)) {
          throw new Error('perf:estimate: accuracy out of range')
        }
        const band = estimateElo(accuracy)
        return { est: band.est, low: band.low, high: band.high, accuracy: band.accuracy }
      }
      const cached = await store.load(gameId as number)
      if (!cached.review) throw new Error(`perf:estimate: no cached review for game ${gameId}`)
      const { white, black } = cached.review
      // Desktop prefers the game row's user_color; the web store has no game
      // row access, so this uses desktop's own fallback: whichever side
      // actually has analyzed moves (white first). Documented divergence.
      const side = white.moves > 0 ? white : black
      const band = estimateElo(side.accuracy, Math.max(1, side.moves), side.acpl)
      return { est: band.est, low: band.low, high: band.high, accuracy: band.accuracy }
    }
  }
}
