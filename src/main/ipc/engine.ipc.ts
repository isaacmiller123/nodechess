import { app, type WebContents } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { parseFen, makeFen } from 'chessops/fen'
import { handle } from './util'
import { ENGINE_ELO_FLOOR, FAIRY_VARIANT_KINDS, type EvalVariantResult } from '../../shared/types'
import { StockfishPool } from '../engine/StockfishPool'
import { MaiaPool } from '../engine/MaiaPool'
import { FairyStockfishPool } from '../engine/FairyPool'
import { KatagoPool } from '../engine/KatagoPool'
import { maiaAvailable } from '../datasets/maia'
import { fairyEngineInstalled } from '../datasets/fairyStockfish'
import { katagoAvailable, katagoNetInstalled } from '../datasets/katago'
import { getCustomVariant } from '../db/customVariants.repo'
import type { BestMove, InfoLine, UciEngine } from '../engine/UciEngine'

const pool = new StockfishPool()
const maiaPool = new MaiaPool()
const fairyPool = new FairyStockfishPool()
const katagoPool = new KatagoPool()

// Parse + re-serialize any FEN before it reaches the engine, so a malicious
// renderer payload can't smuggle newlines/extra UCI commands into stdin.
function safeFen(fen: string): string {
  const setup = parseFen(fen)
  if (setup.isErr) throw new Error('engine: invalid FEN')
  return makeFen(setup.value)
}

const limitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('depth'), value: z.number().int().positive() }),
  z.object({ kind: z.literal('movetime'), value: z.number().int().positive() }),
  z.object({ kind: z.literal('nodes'), value: z.number().int().positive() }),
  z.object({ kind: z.literal('infinite') })
])

const analyzeSchema = z
  .object({
    fen: z.string().min(1),
    multipv: z.number().int().min(1).max(10).default(3),
    limit: limitSchema
  })
  .strict()

const playSchema = z
  .object({
    fen: z.string().min(1),
    level: z.object({
      uciElo: z.number().int().min(ENGINE_ELO_FLOOR).max(3190).optional(),
      skill: z.number().int().min(0).max(20).optional(),
      // Target Elo at ANY strength. Takes precedence over the legacy knobs:
      // >= 1320 -> native UCI_Elo; below -> MultiPV-softmax weak play (above).
      elo: z.number().int().min(100).max(3190).optional(),
      // Time-trouble knob from the bot time manager (renderer botStrength.ts
      // BotPlayLevel). Only the sub-floor weak path reads it: shallower search,
      // hotter softmax, doubled blunder chance: strength genuinely collapses
      // in a scramble. At 1320+ the caller's small movetime IS the collapse.
      panic: z.boolean().optional(),
      // "Human" style: play the maia-<level> lc0 net at nodes=1. Wins over every
      // other knob (shared/types.ts PlayLevel contract). The literal union keeps
      // the value inside MAIA_LEVELS with no runtime lookup.
      maia: z
        .union([
          z.literal(1100),
          z.literal(1300),
          z.literal(1500),
          z.literal(1700),
          z.literal(1900)
        ])
        .optional()
    }),
    limit: limitSchema
  })
  .strict()

// ---- Variant bots (games platform, spec §Bots) -------------------------------------
//
// Fairy-Stockfish plays every chess-family kind except standard chess (which
// keeps the Stockfish path above). One long-lived engine (FairyStockfishPool)
// is re-targeted per request via UCI_Variant; strength is a 1..5 level row
// mapped to UCI_LimitStrength/UCI_Elo (Fairy-SF's floor is 500; no sub-floor
// weak model needed for variants) plus a per-level movetime.

/** kind → the engine's UCI_Variant id ('chess960' is 'chess' + UCI_Chess960). */
const FAIRY_UCI_VARIANT: Record<(typeof FAIRY_VARIANT_KINDS)[number], string> = {
  chess960: 'chess',
  crazyhouse: 'crazyhouse',
  atomic: 'atomic',
  antichess: 'antichess',
  kingofthehill: 'kingofthehill',
  threecheck: '3check',
  horde: 'horde',
  racingkings: 'racingkings',
  xiangqi: 'xiangqi',
  shogi: 'shogi',
  janggi: 'janggi',
  makruk: 'makruk',
  placement: 'placement'
}

/** Level 1..5 → engine strength. Elo values sit inside Fairy-SF's native
 *  UCI_Elo range (500..2850); mirror games/bots.ts CHESS_LEVEL_ELO. */
const FAIRY_LEVELS = [
  { elo: 600, movetime: 150 },
  { elo: 1000, movetime: 250 },
  { elo: 1400, movetime: 350 },
  { elo: 1850, movetime: 500 },
  { elo: 2300, movetime: 700 }
] as const

// Variant FENs can't be chessops-validated (xiangqi/shogi/janggi dialects), so
// the anti-smuggling guard is a character allowlist: one line, FEN alphabet
// only (board letters/digits, '/', pockets '[]', shogi '+', check counts,
// castling '-', spaces). The engine itself is the rules authority, a bogus
// FEN yields 'bestmove (none)' or an ignored position, never extra commands.
const VARIANT_FEN_RE = /^[A-Za-z0-9/\[\]+~.\- ]{1,160}$/

const playVariantSchema = z
  .object({
    kind: z.enum(FAIRY_VARIANT_KINDS),
    fen: z.string().regex(VARIANT_FEN_RE),
    level: z.number().int().min(1).max(5),
    movetimeMs: z.number().int().min(20).max(10000).optional()
  })
  .strict()

// ---- Replay-viewer eval (engine:evalVariant) ---------------------------------
//
// One bounded single-line Fairy-Stockfish search for the Library replay
// viewer's eval bar: any chess-family kind. Standard chess, the 13 routed
// variants, or a Variant Lab custom ('custom-<id>'). Customs are resolved by
// loading the SAVED variants.ini onto the engine via VariantPath (written to a
// per-id file under userData; the ini's first [section] is the UCI_Variant).

const evalVariantSchema = z
  .object({
    // Built-in kinds or a custom slug. The resolver below is the authority.
    kind: z.string().min(1).max(64),
    fen: z.string().regex(VARIANT_FEN_RE),
    movetimeMs: z.number().int().min(50).max(2000).optional()
  })
  .strict()

/** Mirrors renderer games/customVariants.ts SECTION_RE (first ini section =
 *  the variant the engine must select). Kept in sync by test-replay-pipe. */
const INI_SECTION_RE = /^\s*\[([A-Za-z0-9_-]+)(?::([A-Za-z0-9_-]+))?\]\s*$/m

/** kind → { engine UCI_Variant id, chess960 flag, VariantPath for customs }.
 *  Throws on unknown kinds. The schema's string passthrough is NOT trust. */
function resolveEvalVariant(kind: string): {
  variant: string
  chess960: boolean
  variantPath?: string
} {
  if (kind === 'chess') return { variant: 'chess', chess960: false }
  if ((FAIRY_VARIANT_KINDS as readonly string[]).includes(kind)) {
    const k = kind as (typeof FAIRY_VARIANT_KINDS)[number]
    return { variant: FAIRY_UCI_VARIANT[k], chess960: kind === 'chess960' }
  }
  if (kind.startsWith('custom-')) {
    const id = kind.slice('custom-'.length)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id.length > 48) {
      throw new Error(`evalVariant: bad custom variant id '${id}'`)
    }
    const row = getCustomVariant(id)
    if (!row) throw new Error(`evalVariant: unknown custom variant '${id}'`)
    const head = INI_SECTION_RE.exec(row.iniText)
    if (!head) throw new Error(`evalVariant: custom variant '${id}' has no [section] header`)
    return { variant: head[1], chess960: false, variantPath: writeVariantIni(id, row.iniText) }
  }
  throw new Error(`evalVariant: unsupported kind '${kind}'`)
}

/** Write (content-diffed) the custom variant's ini under userData so the
 *  NATIVE engine can load it; returns the file path for VariantPath. */
const variantIniCache = new Map<string, string>() // id → last written iniText
function writeVariantIni(id: string, iniText: string): string {
  const dir = join(app.getPath('userData'), 'variant-lab')
  const file = join(dir, `${id}.ini`)
  if (variantIniCache.get(id) !== iniText) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, iniText, 'utf-8')
    variantIniCache.set(id, iniText)
  }
  return file
}

/**
 * One bounded single-line search; resolves with the LAST scored info line
 * (side-to-move relative, UCI convention). Terminal positions ('bestmove
 * (none)', no info) resolve to {}. Every exit path detaches its listeners.
 * Same discipline as collectCandidates above.
 */
function evalOnce(eng: UciEngine, fen: string, movetimeMs: number): Promise<EvalVariantResult> {
  return new Promise((resolve, reject) => {
    let last: InfoLine | null = null
    let done = false
    const onInfo = (info: InfoLine): void => {
      if (info.scoreCp !== undefined || info.mate !== undefined) last = info
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      eng.off('info', onInfo)
      eng.off('bestmove', onBest)
      eng.off('exit', onExit)
      eng.off('engineError', onErr)
    }
    const onBest = (): void => {
      if (done) return
      done = true
      cleanup()
      if (!last) resolve({})
      else if (last.mate !== undefined) resolve({ mate: last.mate })
      else resolve({ cp: last.scoreCp })
    }
    const fail = (e: Error): void => {
      if (done) return
      done = true
      cleanup()
      reject(e)
    }
    const onExit = (): void => fail(new Error('engine exited during eval'))
    const onErr = (err: Error): void =>
      fail(err instanceof Error ? err : new Error('engine error during eval'))
    // Hard ceiling well above any movetime the schema admits.
    const timer = setTimeout(() => fail(new Error('eval timeout')), 15000)
    eng.on('info', onInfo)
    eng.once('bestmove', onBest)
    eng.once('exit', onExit)
    eng.once('engineError', onErr)
    void eng.search(fen, { kind: 'movetime', value: movetimeMs }, 1)
  })
}

// ---- Go bots (games platform, spec §Bots: go → KataGo GTP ipc) ---------------
//
// The request carries the whole game (GTP replays move-by-move), in the go
// codec that doubles as GTP's own vertex convention ('d4', 'i' skipped, rank 1
// at the bottom, plus 'pass'); black moves first. The vertex regex is the
// anti-smuggling guard. No free-form strings ever reach the engine's stdin.
const GO_VERTEX_RE = /^(?:pass|[a-hj-t](?:1[0-9]|[1-9]))$/

const playGoSchema = z
  .object({
    size: z.union([z.literal(9), z.literal(13), z.literal(19)]),
    // Full float komi range seen in practice; the value is number-validated so
    // interpolation into the GTP command line is injection-safe.
    komi: z.number().min(-361).max(361),
    // Pre-placed black handicap stones (games/go.ts handicapPlacement); when
    // non-empty, WHITE owns moves[0] and the even plies thereafter.
    handicap: z.array(z.string().regex(GO_VERTEX_RE)).max(9).optional(),
    moves: z.array(z.string().regex(GO_VERTEX_RE)).max(1000),
    level: z.number().int().min(1).max(5)
  })
  .strict()

// ---- Sub-floor ("weak play") model -----------------------------------------------
//
// Stockfish's own weakening (UCI_LimitStrength/UCI_Elo, Skill Level) bottoms out
// around 1320. Below that we weaken the CHOICE, not the search: run a short
// full-strength MultiPV search, then pick among the engine's own candidate moves
// with an Elo-scaled softmax over their centipawn scores, plus a small Elo-scaled
// chance of a "human blunder" (a pick from the bottom half of the candidates).
// Every move a weak bot plays is therefore a move the engine actually considered.
// Misplaced pieces and missed tactics, not the old uniform-random shuffles that
// hung the queen one move and found a GM move the next.

// NOTE: the pick model below (weakDepth/weakMultiPv/weakTemperature/
// weakBlunderChance/blunderGapWindow/gapKnee/opening boost/pickWeakMove) is
// mirrored in scripts/lib/weak-model.mjs: shared by the calibration harness
// (scripts/calibrate-weak.mjs) that measured these constants and the Elo-corpus
// generator (scripts/gen-elo-corpus.mjs). Keep the two in sync when tuning.
// TODO(P2): extract the pure pick model to src/main/engine/weakModel.ts and
// import it from the harness via tsx so there is a single source of truth.

/** Linear interpolation over an Elo interval, clamped at both ends. */
function lerpByElo(elo: number, e0: number, v0: number, e1: number, v1: number): number {
  const t = Math.max(0, Math.min(1, (elo - e0) / (e1 - e0)))
  return v0 + t * (v1 - v0)
}

/** Piecewise-linear curve over (elo, value) points, clamped at both ends. */
function curveByElo(elo: number, points: ReadonlyArray<readonly [number, number]>): number {
  if (elo <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    if (elo <= points[i][0]) {
      return lerpByElo(elo, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])
    }
  }
  return points[points.length - 1][1]
}

/** Search depth for a sub-floor bot: 4 (Elo ~100) up to 7 (~1250+).
 *  Calibrated: depth 8 + cold softmax measured ~1500-1600 implied at band 1200
 *  vs the 1320 anchor; 7 plies still sees every short tactic. */
function weakDepth(elo: number): number {
  return Math.round(lerpByElo(elo, 100, 4, 1250, 7))
}

/** Candidate-line count: weaker bots consider more (and worse) options. */
function weakMultiPv(elo: number): number {
  return elo < 600 ? 8 : elo < 1000 ? 7 : 6
}

/**
 * Softmax base temperature in centipawns: ~650 at Elo 100 (near-uniform over
 * the candidates, real mistakes included) tapering to ~60 by 1250 (mostly
 * top-2). The eval-gap knee (below) does the rest of the strength shaping.
 */
function weakTemperature(elo: number): number {
  // Calibration (scripts/calibrate-weak.mjs, 2026-07-06): 60cp at the top end
  // measured ~1600 implied vs the 1320 anchor (83% score at band 1200); 110cp
  // measured ~1511; 170cp (+ depth 7) brings the 1200 band toward its label.
  return lerpByElo(elo, 100, 650, 1250, 170)
}

/**
 * Eval-gap knee (cp): softmax weight is exp(-(gap/T) * (1 + gap/knee)), so a
 * candidate that hangs material (large gap) is punished QUADRATICALLY, and the
 * knee shrinks with Elo: an 800 bot still drifts into -150cp moves but almost
 * never plays the -600cp free-piece line the flat softmax used to allow, while
 * a 200 bot (huge knee) barely notices the difference.
 */
function gapKnee(elo: number): number {
  return curveByElo(elo, [
    [100, 4000],
    [600, 1200],
    [1000, 500],
    [1300, 250]
  ])
}

/**
 * Per-band blunder-rate targets: the chance per move of an INTENTIONAL mistake
 * pick (see blunderGapWindow for how bad it is allowed to be). Calibrated so
 * 400 hangs something most games while 1200 only rarely gifts a tactic.
 */
function weakBlunderChance(elo: number): number {
  return curveByElo(elo, [
    [100, 0.3],
    [400, 0.22],
    [600, 0.15],
    [800, 0.1],
    [1000, 0.06],
    [1200, 0.04],
    [1319, 0.025]
  ])
}

/**
 * Blunder severity window [minGap, maxGap] in cp below the best candidate.
 * A blunder pick is drawn uniformly from candidates inside the window:
 *  - low bands: window is wide open upward (hanging the queen / mate-in-1 is in
 *    character for 400);
 *  - high bands: a "blunder" is a real mistake (~1-2 pawns / a tactic missed),
 *    not a free queen: 1200s lose games to pressure, not to q-hangs each game.
 */
function blunderGapWindow(elo: number): [number, number] {
  const min = lerpByElo(elo, 100, 60, 1300, 150)
  const max = elo < 700 ? Number.POSITIVE_INFINITY : lerpByElo(elo, 700, 1200, 1300, 400)
  return [min, max]
}

/** Opening phase length (fullmoves) during which choice is deliberately varied. */
function openingFullmoves(elo: number): number {
  return Math.round(lerpByElo(elo, 100, 8, 1300, 4))
}

/** Fullmove number from a normalized FEN (defaults to 1 on malformed input). */
function fenFullmove(fen: string): number {
  const n = Number(fen.split(' ')[5])
  return Number.isFinite(n) && n >= 1 ? n : 1
}

/** Bounded side-to-move cp for a candidate line (mate maps to ±1000, as in review). */
function lineCp(info: InfoLine): number {
  if (info.mate !== undefined) return info.mate > 0 ? 1000 : -1000
  return Math.max(-1000, Math.min(1000, info.scoreCp ?? 0))
}

interface WeakCandidate {
  uci: string
  cp: number
}

/**
 * Eval-gap-aware softmax pick over candidates (sorted best-first): weight is
 * exp(-(gap/T) * (1 + gap/knee)): a flat softmax near the top, quadratically
 * steeper for candidates that hang material (see gapKnee).
 */
function softmaxPick(cands: WeakCandidate[], temperature: number, knee: number): string {
  const maxCp = cands[0].cp
  const weights = cands.map((c) => {
    const gap = maxCp - c.cp
    return Math.exp(-(gap / temperature) * (1 + gap / knee))
  })
  const total = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * total
  for (let i = 0; i < cands.length; i++) {
    r -= weights[i]
    if (r <= 0) return cands[i].uci
  }
  return cands[cands.length - 1].uci
}

/**
 * The full sub-floor pick model over sorted-best-first candidates. Pure:
 * mirrored verbatim in scripts/lib/weak-model.mjs.
 *  1. Opening phase (fullmove small, position near-balanced): hotter softmax,
 *     no blunder roll: varied openings without instant self-destruction.
 *  2. Blunder roll at the band's target rate: uniform pick from candidates
 *     inside the band's severity window.
 *  3. Otherwise: eval-gap-aware softmax.
 */
function pickWeakMove(cands: WeakCandidate[], elo: number, fullmove: number, panic: boolean): string {
  const inOpening = fullmove <= openingFullmoves(elo) && Math.abs(cands[0].cp) < 120
  const knee = gapKnee(elo)
  if (inOpening && !panic) {
    return softmaxPick(cands, weakTemperature(elo) * 1.8, knee)
  }
  const blunderChance = Math.min(0.5, weakBlunderChance(elo) * (panic ? 2 : 1))
  if (cands.length >= 2 && Math.random() < blunderChance) {
    const [minGap, maxGap] = blunderGapWindow(elo)
    const best = cands[0].cp
    const window = cands.filter((c) => best - c.cp >= minGap && best - c.cp <= maxGap)
    if (window.length > 0) return window[Math.floor(Math.random() * window.length)].uci
    // No candidate in the window (quiet position): fall through to the softmax.
  }
  return softmaxPick(cands, weakTemperature(elo) * (panic ? 1.7 : 1), knee)
}

/**
 * One bounded MultiPV search on the play engine; resolves with the latest info
 * line per multipv index plus the engine's own bestmove. Mirrors review.ts
 * analyzeFen: every exit path (bestmove / timeout / engine exit / engine error)
 * detaches all listeners so nothing leaks onto the long-lived play engine.
 */
function collectCandidates(
  eng: UciEngine,
  fen: string,
  depth: number,
  multipv: number,
  movetimeMs: number
): Promise<{ lines: Map<number, InfoLine>; best: BestMove }> {
  return new Promise((resolve, reject) => {
    const lines = new Map<number, InfoLine>()
    let done = false
    const onInfo = (info: InfoLine): void => {
      const idx = info.multipv ?? 1
      if (info.pv && info.pv.length > 0) lines.set(idx, info)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      clearTimeout(softStop)
      eng.off('info', onInfo)
      eng.off('bestmove', onBest)
      eng.off('exit', onExit)
      eng.off('engineError', onErr)
    }
    const onBest = (bm: BestMove): void => {
      if (done) return
      done = true
      cleanup()
      resolve({ lines, best: bm })
    }
    const fail = (e: Error): void => {
      if (done) return
      done = true
      cleanup()
      reject(e)
    }
    const onExit = (): void => fail(new Error('engine exited during weak-play search'))
    const onErr = (err: Error): void =>
      fail(err instanceof Error ? err : new Error('engine error during weak-play search'))
    // Depth ≤ 8 finishes in well under a second on decent hardware; 20s stays as
    // a hard crash ceiling so a wedged engine can never hang the bot's turn (and
    // the renderer) forever.
    const timer = setTimeout(() => fail(new Error('weak-play search timeout')), 20000)
    // The caller's movetime budget is a SOFT cap: at the budget, `stop` the
    // search: the engine answers with bestmove immediately and the pick runs
    // over whatever completed candidate lines exist by then. On fast hardware
    // the depth search finishes first and nothing changes (calibration intact);
    // on slow hardware a sub-1320 bot no longer blows its clock on one move.
    const softStop = setTimeout(() => void eng.stop(), movetimeMs)
    eng.on('info', onInfo)
    eng.once('bestmove', onBest)
    eng.once('exit', onExit)
    eng.once('engineError', onErr)
    void eng.search(fen, { kind: 'depth', value: depth }, multipv)
  })
}

/** Fallback weak-model budget when the caller sent a non-movetime limit. */
const WEAK_DEFAULT_MOVETIME_MS = 400

/** Resolve a sub-floor bot move. Same response shape as eng.bestMove().
 *  `panic` = the bot time manager's time-trouble collapse: 2 plies shallower
 *  (floor 3), softmax ~1.7x hotter, blunder chance doubled (capped at 50%).
 *  `movetimeMs` = the caller's per-move budget; the Elo-scaled depth search is
 *  stopped at the budget (see collectCandidates). Exported for the headless
 *  timing proof (scripts bundle this module with an electron stub). */
export async function weakPlay(
  eng: UciEngine,
  fen: string,
  elo: number,
  panic = false,
  movetimeMs = WEAK_DEFAULT_MOVETIME_MS
): Promise<BestMove> {
  // Full-strength search: honest candidate evals; the weakening is in the pick.
  // (Skill Level explicitly reset in case a legacy `skill` request lowered it.)
  eng.setOption('UCI_LimitStrength', false)
  eng.setOption('Skill Level', 20)
  const depth = panic ? Math.max(3, weakDepth(elo) - 2) : weakDepth(elo)
  const budget = Math.max(50, Math.round(movetimeMs))
  const { lines, best } = await collectCandidates(eng, fen, depth, weakMultiPv(elo), budget)
  const cands: WeakCandidate[] = []
  for (const info of lines.values()) {
    const uci = info.pv?.[0]
    if (uci) cands.push({ uci, cp: lineCp(info) })
  }
  // No usable lines (terminal position / odd output): the engine's own answer.
  if (cands.length === 0) return best
  cands.sort((a, b) => b.cp - a.cp)
  return { bestmove: pickWeakMove(cands, elo, fenFullmove(fen), panic) }
}

let nextHandle = 1
// One analysis engine -> one active streaming subscription at a time.
let active: {
  handleId: number
  eng: UciEngine
  onInfo: (i: InfoLine) => void
  onBest: (b: BestMove) => void
} | null = null

function clearActive(): void {
  if (active) {
    active.eng.off('info', active.onInfo)
    active.eng.off('bestmove', active.onBest)
    active = null
  }
}

// Every position change fires a stop + a re-analyze on the SAME shared analysis
// engine. Run them through one serial queue so they can never interleave (which
// is what let a stale search's bestmove tear down the next subscription).
let opChain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn)
  opChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

// engine:play calls all share one long-lived play engine. Serialize them (own
// chain, independent of the analysis queue) so one call's stop/option/search
// writes (and its temporarily attached info/bestmove listeners) can never
// interleave with another call's and swallow the wrong bestmove.
let playChain: Promise<unknown> = Promise.resolve()
function serializePlay<T>(fn: () => Promise<T>): Promise<T> {
  const run = playChain.then(fn, fn)
  playChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

// engine:playVariant shares one long-lived Fairy-Stockfish engine. Same
// serialization discipline, own chain so variant bots never block chess bots.
let fairyChain: Promise<unknown> = Promise.resolve()
function serializeFairy<T>(fn: () => Promise<T>): Promise<T> {
  const run = fairyChain.then(fn, fn)
  fairyChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

// engine:playGo replays whole games onto stateful GTP processes. Serialize so
// two concurrent requests can never interleave their replays on one engine.
let goChain: Promise<unknown> = Promise.resolve()
function serializeGo<T>(fn: () => Promise<T>): Promise<T> {
  const run = goChain.then(fn, fn)
  goChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export function registerEngine(): void {
  handle('engine:status', z.object({}).strict(), () => ({
    analysisReady: pool.hasAnalysis(),
    playReady: pool.hasPlay(),
    // "Can the Human style play right now": lc0 binary + >=1 maia weight on disk.
    lc0Ready: maiaAvailable(),
    // Variant bots: Fairy-Stockfish on disk (bundled on mac, imported on win).
    fairyReady: fairyEngineInstalled(),
    // Go bots: KataGo + at least one standard net on disk.
    katagoReady: katagoAvailable(),
    // The optional Human-SL net: go levels play the human rank ladder.
    katagoHumanReady: katagoNetInstalled('b18-human')
  }))

  handle(
    'engine:newGame',
    z.object({ instance: z.enum(['analysis', 'play']) }).strict(),
    async ({ instance }) => {
      const eng = instance === 'analysis' ? await pool.getAnalysis() : await pool.getPlay()
      await eng.newGame()
      return { ok: true }
    }
  )

  handle('engine:analyze', analyzeSchema, ({ fen, multipv, limit }, e) =>
    serialize(async () => {
      const safe = safeFen(fen) // validate/normalize before any allocation
      const eng = await pool.getAnalysis()
      clearActive()
      // Drain any in-flight (infinite) search to idle BEFORE attaching this
      // search's listeners. Otherwise the previous search's stop-bestmove is
      // caught by our once('bestmove') below and immediately tears the new
      // subscription down: the bug that froze analysis after the first move.
      await eng.stop()
      const handleId = nextHandle++
      const sender: WebContents = e.sender
      const onInfo = (info: InfoLine): void => {
        if (!sender.isDestroyed()) sender.send('engine:line', { handleId, ...info })
      }
      const onBest = (bm: BestMove): void => {
        if (!sender.isDestroyed()) sender.send('engine:bestmove', { handleId, ...bm })
        clearActive()
      }
      active = { handleId, eng, onInfo, onBest }
      eng.on('info', onInfo)
      eng.once('bestmove', onBest)
      await eng.search(safe, limit, multipv)
      return { handleId }
    })
  )

  handle('engine:stop', z.object({ handleId: z.number() }).strict(), ({ handleId }) =>
    serialize(async () => {
      // Only stop the search the caller actually started (a stale id is a no-op).
      if (active && active.handleId === handleId) {
        await active.eng.stop()
        clearActive()
      }
      return { ok: true }
    })
  )

  handle('engine:play', playSchema, ({ fen, level, limit }) =>
    serializePlay(async () => {
      const safe = safeFen(fen)
      if (level.maia !== undefined) {
        // "Human" style: maia-<level> net at nodes=1. The policy head IS the
        // player, so the caller's limit is ignored on purpose (a deeper search
        // would make Maia SUPERhuman-shaped, defeating the point). Runs on its
        // own per-level lc0 process; the Stockfish play engine stays untouched.
        // TODO(P2): micro-humanizer (small move-delay model + resign logic).
        const maiaEng = await maiaPool.get(level.maia)
        await maiaEng.stop()
        return maiaEng.bestMove(safe, { kind: 'nodes', value: 1 })
      }
      const eng = await pool.getPlay()
      // Drain any abandoned search (e.g. one whose waiter timed out) to idle
      // BEFORE attaching new listeners / starting a new search, so a stale
      // bestmove can't be mistaken for ours. Same discipline as engine:analyze.
      await eng.stop()
      // `elo` wins over the legacy knobs when present (shared/types.ts contract).
      if (level.elo !== undefined && level.elo < ENGINE_ELO_FLOOR) {
        // Below Stockfish's floor: engine-driven weakening. An Elo-scaled depth
        // search picks the candidates, but the CALLER's movetime is honored as
        // a cap (soft-stop) so a sub-1320 bot can't blow its clock on slow
        // hardware. `level.panic` (bot time manager) is the other knob: weakPlay.
        const budget = limit.kind === 'movetime' ? limit.value : WEAK_DEFAULT_MOVETIME_MS
        return weakPlay(eng, safe, level.elo, level.panic === true, budget)
      }
      eng.setOption('MultiPV', 1)
      if (level.elo !== undefined) {
        eng.setOption('UCI_LimitStrength', true)
        eng.setOption('UCI_Elo', level.elo)
      } else if (level.uciElo !== undefined) {
        eng.setOption('UCI_LimitStrength', true)
        eng.setOption('UCI_Elo', level.uciElo)
      } else if (level.skill !== undefined) {
        eng.setOption('UCI_LimitStrength', false)
        eng.setOption('Skill Level', level.skill)
      } else {
        // Neither given: never answer at full strength. Cap to a club default.
        eng.setOption('UCI_LimitStrength', true)
        eng.setOption('UCI_Elo', 1500)
      }
      return eng.bestMove(safe, limit)
    })
  )

  handle('engine:playVariant', playVariantSchema, ({ kind, fen, level, movetimeMs }) =>
    serializeFairy(async () => {
      if (!fairyEngineInstalled()) {
        throw new Error('Fairy-Stockfish is not installed, import the engines dataset first.')
      }
      const eng = await fairyPool.get(FAIRY_UCI_VARIANT[kind], kind === 'chess960')
      // Drain any abandoned search to idle before touching options. Same
      // discipline as engine:play above.
      await eng.stop()
      const cfg = FAIRY_LEVELS[level - 1]
      eng.setOption('UCI_LimitStrength', true)
      eng.setOption('UCI_Elo', cfg.elo)
      // The schema's character allowlist already blocked command smuggling;
      // the engine itself is the rules authority for the variant FEN dialect.
      return eng.bestMove(fen, { kind: 'movetime', value: movetimeMs ?? cfg.movetime })
    })
  )

  handle('engine:playGo', playGoSchema, (req) =>
    serializeGo(async () => {
      if (!katagoAvailable()) {
        throw new Error('KataGo is not installed. Download the Go engine in Settings → Datasets.')
      }
      return { move: await katagoPool.play(req) }
    })
  )

  // Replay-viewer eval bar (chess family incl. customs). Shares the fairy
  // chain so an eval can never interleave with a variant bot's search on the
  // one long-lived engine.
  handle('engine:evalVariant', evalVariantSchema, ({ kind, fen, movetimeMs }) =>
    serializeFairy(async (): Promise<EvalVariantResult> => {
      if (!fairyEngineInstalled()) {
        throw new Error('Fairy-Stockfish is not installed, import the engines dataset first.')
      }
      const target = resolveEvalVariant(kind)
      const eng = await fairyPool.get(target.variant, target.chess960, target.variantPath)
      await eng.stop() // drain any abandoned search: same discipline as playVariant
      // Full strength for an honest eval (playVariant may have weakened it).
      eng.setOption('UCI_LimitStrength', false)
      return evalOnce(eng, fen, movetimeMs ?? 300)
    })
  )

  // One-shot go estimate (winrate/lead/ownership). Same GTP chain as playGo:
  // the estimate engine is its own process, but the chain keeps pool spawns +
  // replays strictly ordered.
  handle(
    'engine:estimateGo',
    z
      .object({
        size: z.union([z.literal(9), z.literal(13), z.literal(19)]),
        komi: z.number().min(-361).max(361),
        handicap: z.array(z.string().regex(GO_VERTEX_RE)).max(9).optional(),
        moves: z.array(z.string().regex(GO_VERTEX_RE)).max(1000)
      })
      .strict(),
    (req) =>
      serializeGo(async () => {
        if (!katagoAvailable()) {
          throw new Error('KataGo is not installed. Download the Go engine in Settings → Datasets.')
        }
        return katagoPool.estimate(req)
      })
  )

  // Windows-safe lifecycle: kill all engine children when the app quits.
  app.on('will-quit', () => {
    pool.killAll()
    maiaPool.killAll()
    fairyPool.killAll()
    katagoPool.killAll()
  })
}
