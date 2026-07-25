/**
 * Viktor: the Chess School coach's voice. A terse, exacting old-school master.
 * Direct about mistakes, precise, generous with EARNED praise, always says WHY.
 *
 * This is a VOICE LAYER over the existing local coaching engine (./index.ts).
 * It does not re-classify anything: explainMove() does the work (verdict, motif,
 * eval swing), and we rewrite its result into Viktor's register and attach the
 * on-board annotations the renderer paints while he speaks. Fully deterministic,
 * offline: no LLM. The debrief uses the shared analysis engine (the pool) only
 * to fill in missing evals, with bounded depth and a hard cap on positions.
 */

import { Chess } from 'chessops/chess'
import { parseFen, makeFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseUci } from 'chessops/util'
import type { NormalMove } from 'chessops/types'

import { explainMove, type ExplainMoveResult } from './index'
import { winPercent, type PovScore } from './winrate'
import { StockfishPool } from '../engine/StockfishPool'
import type { InfoLine } from '../engine/UciEngine'
import type {
  CoachLine,
  BoardAnnotation,
  AnnotationColor,
  CoachEngineEval,
  SchoolNarrateReq,
  SchoolDebriefMove,
  SchoolDebrief
} from '../../shared/types'

// One shared pool for school debriefs (its own analysis engine, lazily started).
const pool = new StockfishPool()

// ---- Concept mapping --------------------------------------------------------
// A detected motif maps to a canonical concept id + a one-line summary Viktor
// gives the first time the learner meets the idea. Chapters that teach these use
// the SAME ids in their concepts[] so mastery references line up; when a learner
// already knows the concept (id in knownConceptIds) Viktor skips the primer.

interface ConceptInfo {
  id: string
  short: string
}
const MOTIF_CONCEPT: Record<string, ConceptInfo> = {
  fork: { id: 'fork', short: 'A fork is one piece attacking two targets at once. He cannot save both.' },
  pin: { id: 'pin', short: 'A pin freezes a piece: it cannot move without exposing something worse behind it.' },
  skewer: { id: 'skewer', short: 'A skewer is a pin reversed. The greater piece is in front and must step aside, losing the lesser one behind.' },
  discoveredAttack: { id: 'discovered-attack', short: 'A discovered attack: one piece moves and unmasks the attack of another.' },
  discoveredCheck: { id: 'discovered-check', short: 'A discovered check: the moving piece unveils a check from behind it.' },
  doubleCheck: { id: 'double-check', short: 'A double check attacks the king with two pieces at once. Only the king may move.' },
  hangingPiece: { id: 'hanging-piece', short: 'A hanging piece is undefended and attacked. It is yours for the taking.' },
  backRankMate: { id: 'back-rank-mate', short: 'A back-rank mate: the king is trapped on its own first rank by its own pawns.' },
  mate: { id: 'mate', short: 'A forced mate: a sequence the opponent cannot escape.' },
  deflection: { id: 'deflection', short: 'A deflection drags a defender off its duty so what it guarded falls.' },
  interference: { id: 'interference', short: 'Interference plants a piece between a defender and what it guards, cutting the line.' },
  overloaded: { id: 'overloaded-piece', short: 'An overloaded piece guards two things at once. Load it past breaking and one must fall.' },
  capturingDefender: { id: 'removing-the-defender', short: 'Remove the defender, and the piece it guarded hangs.' },
  xRay: { id: 'x-ray', short: 'An x-ray attacks through a piece along the same line.' }
}

// Motifs whose relevant squares are worth circling for emphasis.
const CIRCLE_MOTIFS: ReadonlySet<string> = new Set(['fork', 'doubleCheck', 'backRankMate'])

// ---- chessops helpers -------------------------------------------------------

function posFromFen(fen: string): Chess | null {
  const setup = parseFen(fen)
  if (setup.isErr) return null
  const pos = Chess.fromSetup(setup.unwrap())
  if (pos.isErr) return null
  return pos.unwrap()
}

function legalMove(pos: Chess, uci: string): NormalMove | null {
  const m = parseUci(uci)
  if (!m || !('from' in m)) return null
  return pos.isLegal(m) ? m : null
}

/** SAN for a UCI move from a FEN, or the UCI itself when it can't be rendered. */
function sanOf(fen: string, uci: string): string {
  const pos = posFromFen(fen)
  if (!pos) return uci
  const m = legalMove(pos, uci)
  return m ? makeSan(pos, m) : uci
}

/** Split a UCI move into its from/to square strings (drops promotion suffix). */
function squaresOf(uci: string): { from: string; to: string } | null {
  if (uci.length < 4) return null
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) }
}

// ---- Eval / POV helpers -----------------------------------------------------

function toPov(e: CoachEngineEval, flip: boolean): PovScore {
  let cp = e.cp ?? null
  let mate = e.mate ?? null
  if (flip) {
    if (mate != null) mate = -mate
    if (cp != null) cp = -cp
  }
  if (mate != null) cp = null
  return { cp, mate }
}

function hasEval(e: CoachEngineEval | null | undefined): boolean {
  return !!e && (e.cp != null || e.mate != null)
}

// ---- Verdict buckets --------------------------------------------------------

type Bucket = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder'

function bucketOf(verdict: string): Bucket {
  switch (verdict) {
    case 'best':
      return 'best'
    case 'good':
      return 'good'
    case 'inaccuracy':
      return 'inaccuracy'
    case 'mistake':
      return 'mistake'
    case 'blunder':
      return 'blunder'
    default:
      return verdict === 'ok' ? 'good' : 'blunder'
  }
}

function isGoodBucket(b: Bucket): boolean {
  return b === 'best' || b === 'good'
}

// ---- Viktor's voice ---------------------------------------------------------
// We keep explainMove's analytical content (the motif/eval reasoning) but recast
// the framing into Viktor's exacting register. Deterministic: framing is chosen
// from the verdict alone, never randomly.

const PRAISE_BEST = [
  'Good.',
  'Yes.',
  'Precisely.',
  'Good. You saw it yourself.',
  'Precisely. I have nothing to add.'
]
const PRAISE_GOOD = [
  'Acceptable.',
  'Sound enough.',
  'Playable. I have seen worse.',
  'Reasonable. You are learning.'
]
const REBUKE_INACC = [
  'Careless.',
  'Not the cleanest.',
  'Hm. You can do better than that.'
]
const REBUKE_MISTAKE = [
  'No.',
  'A mistake.',
  'You were not watching the whole board.'
]
const REBUKE_BLUNDER = [
  'No: look again.',
  'That is a blunder.',
  'Stop. Count the attackers before you touch a piece.'
]

/** Strip the engine's leading verdict word; we supply our own framing. */
function stripVerdictPrefix(text: string): string {
  return text
    .replace(/^\([^)]*\)\s*/, '') // drop a leading "(+3.1 → +0.2) "
    .replace(/^(Blunder|Mistake|Inaccuracy|Good|Best)[.!]?\s*/, '')
    .trim()
}

/** Deterministic pick keyed off the FEN+move so wording is stable per position. */
function pick<T>(arr: T[], key: string): T {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return arr[(h >>> 0) % arr.length]
}

function framing(b: Bucket, key: string): string {
  switch (b) {
    case 'best':
      return pick(PRAISE_BEST, key)
    case 'good':
      return pick(PRAISE_GOOD, key)
    case 'inaccuracy':
      return pick(REBUKE_INACC, key)
    case 'mistake':
      return pick(REBUKE_MISTAKE, key)
    case 'blunder':
      return pick(REBUKE_BLUNDER, key)
  }
}

/** Recast an explainMove result into one Viktor sentence (analysis preserved). */
function viktorize(res: ExplainMoveResult, key: string, bestSan: string): string {
  const b = bucketOf(res.verdict)
  const body = stripVerdictPrefix(res.text)
  const lead = framing(b, key)
  if (body.length === 0) {
    return isGoodBucket(b) ? `${lead} ${bestSan} was the move.` : `${lead} ${bestSan} was called for.`
  }
  return `${lead} ${body}`
}

// ---- Annotation building ----------------------------------------------------

function moveColor(b: Bucket): AnnotationColor {
  return isGoodBucket(b) ? 'good' : 'bad'
}

/**
 * Annotations for one judged move:
 *   - highlight the played from+to (good/bad by verdict),
 *   - when not best, an arrow from->to of the BEST move (good) labelled best SAN,
 *   - when a fork/double-check/back-rank motif fired, circle the from-square.
 */
function buildAnnotations(
  played: string,
  best: string,
  bucket: Bucket,
  motif: string | null,
  bestSan: string
): BoardAnnotation[] {
  const out: BoardAnnotation[] = []
  const playedSq = squaresOf(played)
  if (playedSq) {
    const c = moveColor(bucket)
    out.push({ kind: 'highlight', square: playedSq.from, color: c })
    out.push({ kind: 'highlight', square: playedSq.to, color: c })
  }
  const playedIsBest = played.length > 0 && played === best
  const bestSq = squaresOf(best)
  if (!playedIsBest && bestSq) {
    out.push({
      kind: 'arrow',
      from: bestSq.from,
      to: bestSq.to,
      color: 'good',
      label: bestSan
    })
  }
  if (motif && CIRCLE_MOTIFS.has(motif)) {
    // Circle where the work happens: the destination of the move that fired it.
    const focusSq = playedIsBest || isGoodBucket(bucket) ? bestSq : playedSq
    if (focusSq) out.push({ kind: 'circle', square: focusSq.to, color: 'focus' })
  }
  return out
}

// ---- narrate ----------------------------------------------------------------

/**
 * Viktor narrates a just-played move (proactive coaching). Reuses explainMove()
 * for the verdict/motif/eval, recasts it into Viktor's voice, builds board cues,
 * and (when the move's motif is a concept the learner does NOT yet know)
 * prepends a one-sentence primer on the idea.
 */
export function narrate(req: SchoolNarrateReq): CoachLine {
  const res = explainMove({
    fenBefore: req.fenBefore,
    played: req.played,
    best: req.best,
    pv: req.pv,
    evalBefore: req.evalBefore,
    evalAfter: req.evalAfter,
    ply: req.ply
  })

  const bucket = bucketOf(res.verdict)
  const motif = res.motifs.length > 0 ? res.motifs[0] : null
  const bestSan = sanOf(req.fenBefore, req.best)
  const key = `${req.fenBefore}|${req.played}`

  let text = viktorize(res, key, bestSan)
  const annotations = buildAnnotations(req.played, req.best, bucket, motif, bestSan)

  // Concept handling: if a motif maps to a concept the learner doesn't know yet,
  // teach the idea in one sentence FIRST, and tag the line with that concept.
  let conceptId: string | undefined
  if (motif && MOTIF_CONCEPT[motif]) {
    const info = MOTIF_CONCEPT[motif]
    conceptId = info.id
    const known = new Set(req.knownConceptIds)
    if (!known.has(info.id)) {
      text = `${info.short} ${text}`
    }
  }

  // Pin the line to the position it discusses so the renderer can show the
  // right board while Viktor speaks (annotations land on occupied squares).
  const line: CoachLine = { text, fen: req.fenBefore }
  if (annotations.length > 0) line.annotations = annotations
  if (conceptId) line.conceptId = conceptId
  return line
}

// ---- debrief: bounded engine analysis ---------------------------------------

const DEBRIEF_DEPTH = 12
const MAX_POSITIONS = 24

/** Latest InfoLine per multipv index once `bestmove` arrives. */
function analyzeFen(
  engine: import('../engine/UciEngine').UciEngine,
  fen: string,
  depth: number
): Promise<InfoLine | undefined> {
  return new Promise((resolve) => {
    let best: InfoLine | undefined
    const onInfo = (info: InfoLine): void => {
      if (info.pv && info.pv.length > 0 && (info.multipv ?? 1) === 1) best = info
    }
    const onBest = (): void => {
      engine.off('info', onInfo)
      resolve(best)
    }
    engine.on('info', onInfo)
    engine.once('bestmove', onBest)
    void engine.search(fen, { kind: 'depth', value: depth }, 1)
  })
}

function infoToEval(info: InfoLine | undefined): CoachEngineEval {
  if (!info) return { cp: 0, mate: null }
  if (info.mate !== undefined) return { cp: null, mate: info.mate }
  return { cp: info.scoreCp ?? 0, mate: null }
}

function negate(e: CoachEngineEval): CoachEngineEval {
  return {
    cp: e.cp != null ? -e.cp : null,
    mate: e.mate != null ? -e.mate : null
  }
}

function safeFen(fen: string): string | null {
  const setup = parseFen(fen)
  if (setup.isErr) return null
  return makeFen(setup.value)
}

// A user move enriched with everything we need to coach it.
interface EnrichedMove {
  src: SchoolDebriefMove
  best: string
  pv: string[]
  evalBefore: CoachEngineEval
  evalAfter: CoachEngineEval
  bestSan: string
  result: ExplainMoveResult
  bucket: Bucket
  motif: string | null
  /** Win% the mover lost on this move (0..100); larger = more instructive. */
  drop: number
}

/**
 * Viktor's post-boss debrief. For each USER move with missing evals we compute
 * them with the pool's analysis engine (bounded depth, MultiPV 1), capped at
 * MAX_POSITIONS. Then we classify every user move, surface the 2-4 sharpest
 * moments (largest Win% drops), bracket them with an opening orientation line
 * and a closing verdict tied to the boss result, and report which taught
 * concepts the learner actually executed.
 */
export async function debrief(req: {
  chapterId: string
  userColor: 'white' | 'black'
  moves: SchoolDebriefMove[]
}): Promise<SchoolDebrief> {
  const userMoves = req.moves.filter((m) => m.byUser)

  // Decide which user moves still need engine work (missing before/after evals).
  let budget = MAX_POSITIONS
  let engine: import('../engine/UciEngine').UciEngine | null = null

  const enriched: EnrichedMove[] = []
  for (const m of userMoves) {
    let best = m.best
    let pv = m.pv && m.pv.length ? m.pv : m.best ? [m.best] : []
    let evalBefore = m.evalBefore
    let evalAfter = m.evalAfter

    const needBefore = !hasEval(evalBefore) || !best
    const needAfter = !hasEval(evalAfter)
    const fenBefore = safeFen(m.fenBefore)

    if (fenBefore && (needBefore || needAfter) && budget > 0) {
      try {
        if (!engine) {
          engine = await pool.getAnalysis()
          engine.setOption('MultiPV', 1)
          engine.setOption('UCI_LimitStrength', false)
        }
        if (needBefore && budget > 0) {
          const info = await analyzeFen(engine, fenBefore, DEBRIEF_DEPTH)
          budget--
          evalBefore = infoToEval(info) // mover POV
          if (info?.pv && info.pv.length) {
            pv = info.pv
            best = info.pv[0]
          }
        }
        // Eval AFTER the played move: reuse before-eval if the played move was
        // best, else analyze the resulting position and flip to the mover's POV.
        if (needAfter && budget > 0) {
          const pos = posFromFen(fenBefore)
          const playedMove = pos ? legalMove(pos, m.played) : null
          if (pos && playedMove) {
            const after = pos.clone()
            after.play(playedMove)
            if (after.isCheckmate()) {
              evalAfter = { cp: null, mate: 1 } // user delivered mate
            } else if (m.played === best) {
              evalAfter = evalBefore
            } else {
              const fenAfter = makeFen(after.toSetup())
              const info = await analyzeFen(engine, fenAfter, DEBRIEF_DEPTH)
              budget--
              evalAfter = negate(infoToEval(info)) // opp POV -> mover POV
            }
          }
        }
      } catch {
        // Engine unavailable mid-debrief: fall back to whatever evals we have.
      }
    }

    if (!hasEval(evalBefore)) evalBefore = { cp: 0, mate: null }
    if (!hasEval(evalAfter)) evalAfter = { cp: 0, mate: null }
    if (!best) best = m.played

    const result = explainMove({
      fenBefore: m.fenBefore,
      played: m.played,
      best,
      pv,
      evalBefore,
      evalAfter,
      ply: m.ply
    })
    const bucket = bucketOf(result.verdict)
    const motif = result.motifs.length ? result.motifs[0] : null

    // Win% drop on the mover's scale (0..100), used to rank instructiveness.
    const before = toPov(evalBefore, false)
    const after = toPov(evalAfter, true)
    const drop = Math.max(0, winPercent(before) - winPercent(after))

    enriched.push({
      src: m,
      best,
      pv,
      evalBefore,
      evalAfter,
      bestSan: sanOf(m.fenBefore, best),
      result,
      bucket,
      motif,
      drop
    })
  }

  // ---- Concepts the learner actually executed (a good/best move that fired a
  // taught motif). These are the ids Viktor will say "you used" in the debrief.
  const usedConcepts: string[] = []
  const usedSet = new Set<string>()
  for (const e of enriched) {
    if (isGoodBucket(e.bucket) && e.motif && MOTIF_CONCEPT[e.motif]) {
      const id = MOTIF_CONCEPT[e.motif].id
      if (!usedSet.has(id)) {
        usedSet.add(id)
        usedConcepts.push(id)
      }
    }
  }

  // ---- Build the coached lines: opening orientation, the sharp moments, close.
  const lines: CoachLine[] = []
  lines.push(openingLine(req.userColor, enriched.length, req.moves))

  // The 2-4 most instructive moments: prefer real errors (largest Win% drops);
  // if the game was clean, fall back to the best executed concept(s).
  const errors = enriched
    .filter((e) => !isGoodBucket(e.bucket))
    .sort((a, b) => b.drop - a.drop)
  let moments = errors.slice(0, 4)
  if (moments.length < 2) {
    const wins = enriched
      .filter((e) => isGoodBucket(e.bucket) && e.motif)
      .sort((a, b) => b.drop - a.drop)
    for (const w of wins) {
      if (moments.length >= 2) break
      if (!moments.includes(w)) moments.push(w)
    }
  }
  // Keep chronological order so the debrief reads as a narrative.
  moments = moments.sort((a, b) => a.src.ply - b.src.ply).slice(0, 4)

  for (const e of moments) {
    lines.push(momentLine(e))
  }

  // ---- Closing verdict, tied to the boss result implied by the final move.
  const verdict = closingVerdict(req.moves, req.userColor, enriched, usedConcepts)
  lines.push({ text: verdict })

  return { lines, usedConcepts, verdict }
}

/** Orientation line at the start of the debrief. Carries the game's starting
 *  position so the board REWINDS while Viktor sets the scene, then walks the
 *  moments chronologically. */
function openingLine(
  userColor: 'white' | 'black',
  n: number,
  moves: SchoolDebriefMove[]
): CoachLine {
  const startFen = moves.length > 0 ? moves[0].fenBefore : undefined
  if (n === 0) {
    return {
      text: 'You made no moves of your own. Watch, then play it yourself.',
      fen: startFen
    }
  }
  const openers = [
    `Let us go through your game with ${userColor}. I will show you where it turned.`,
    `Sit. We will replay your game with ${userColor} together. I have marked the moments that matter.`
  ]
  return { text: pick(openers, `${userColor}|${n}`), fen: startFen }
}

/** One coached "moment" line: Viktor's voice + board cues for that move.
 *  `fen` is the position BEFORE the move under discussion. The renderer must
 *  show THAT board, or the highlights/arrows land on empty squares of the
 *  final position (the blank-square bug). */
function momentLine(e: EnrichedMove): CoachLine {
  const key = `${e.src.fenBefore}|${e.src.played}`
  const moveNo = Math.ceil(e.src.ply / 2)
  const text = `Move ${moveNo}. ${viktorize(e.result, key, e.bestSan)}`
  const annotations = buildAnnotations(e.src.played, e.best, e.bucket, e.motif, e.bestSan)
  const line: CoachLine = { text, fen: e.src.fenBefore }
  if (annotations.length > 0) line.annotations = annotations
  if (e.motif && MOTIF_CONCEPT[e.motif]) line.conceptId = MOTIF_CONCEPT[e.motif].id
  return line
}

/**
 * Did the user win the boss? The game's final position tells us: checkmate
 * delivered by the user, or the opponent left in a hopeless position. We infer
 * from the last move and its mover.
 */
function userWon(moves: SchoolDebriefMove[], userColor: 'white' | 'black'): boolean | null {
  if (moves.length === 0) return null
  const last = moves[moves.length - 1]
  const pos = posFromFen(last.fenBefore)
  if (!pos) return null
  const m = legalMove(pos, last.played)
  if (!m) return null
  const after = pos.clone()
  after.play(m)
  if (after.isCheckmate()) {
    // The side to move in `after` is the mated side; the user won iff that side
    // is NOT the user's colour (i.e. Viktor's engine got mated).
    return after.turn !== userColor
  }
  if (after.isStalemate() || after.isInsufficientMaterial()) return null // draw-ish
  return null // undecided from the moves alone
}

/** Closing verdict tied to the boss result + what the learner showed. */
function closingVerdict(
  moves: SchoolDebriefMove[],
  userColor: 'white' | 'black',
  enriched: EnrichedMove[],
  usedConcepts: string[]
): string {
  const blunders = enriched.filter((e) => e.bucket === 'blunder').length
  const mistakes = enriched.filter((e) => e.bucket === 'mistake').length
  const won = userWon(moves, userColor)

  const conceptPhrase =
    usedConcepts.length > 0
      ? ` You found the ${conceptNames(usedConcepts)}. That is the lesson, and you used it.`
      : ''

  if (won === true) {
    if (blunders === 0 && mistakes === 0) {
      return `A clean win. You gave him nothing.${conceptPhrase}`
    }
    return `The win is yours, but it was untidy. Tighten up, and he will not survive next time.${conceptPhrase}`
  }
  if (blunders > 0) {
    return `You lost the thread. ${blunders === 1 ? 'One blunder' : `${blunders} blunders`} decided it. Study them; do not repeat them.${conceptPhrase}`
  }
  if (mistakes > 0) {
    return `Close, but the mistakes added up. Precision wins these games, not hope.${conceptPhrase}`
  }
  return `Solid play. Keep it up and the results will come.${conceptPhrase}`
}

/** Pretty-print concept ids as readable names for the closing line. */
function conceptNames(ids: string[]): string {
  const names = ids.map((id) => {
    for (const key of Object.keys(MOTIF_CONCEPT)) {
      if (MOTIF_CONCEPT[key].id === id) return key.replace(/([A-Z])/g, ' $1').toLowerCase()
    }
    return id
  })
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
