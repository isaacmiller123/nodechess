// botTime: the bot's clock brain for Play. Bots genuinely live on their clock:
// the time a bot "thinks" is real wall time (its clock ticks through it), and
// the allocation below decides how much of that time each move deserves.
//
// LAYOUT (load-bearing for the headless sim):
//   1. PURE CORE: budgeting, complexity multipliers, clock personalities,
//      noise, panic. No DOM, no window, no engine. scripts/sim-bot-time.mjs
//      esbuild-bundles this file and stress-tests exactly these functions.
//   2. INTEGRATION HELPERS: chess-derived signals (forced-move classes via
//      chessops) and the one-shot complexity probe over the ANALYSIS engine
//      channel. Only PlayView calls these; they touch window.api inside
//      function bodies only, so importing this module under Node stays safe.
//
// CORE PRINCIPLE: the bot's move latency and its clock deduction are the same
// real thing. PlayView allocates T via planThink, gives the engine a movetime
// slice of T, then waits out any remainder. It never replies early and never
// bills fake time. Unlimited time control bypasses all of this (fixed
// settings.playThinkMs behavior, unchanged).

import { checkColor, destsFor } from '../../chess/chess'

// ---------------------------------------------------------------------------
// 1. PURE CORE
// ---------------------------------------------------------------------------

/** Clock personality id: mirrors Persona.timeStyle in shared/types.ts. */
export type TimeStyle = 'blitzer' | 'steady' | 'tanker'

export interface TimePersonality {
  /** Multiplier on the base per-move budget (blitzers bank time, tankers dip). */
  targetMul: number
  /** Log-normal sigma for human noise (higher = more erratic move-to-move). */
  sigma: number
  /** Chance a complex (multiplier >= 1.2) move becomes a genuine tank. */
  tankChance: number
  /** Extra multiplier applied when the tank tail fires. */
  tankMul: number
  /**
   * Pace bias exponent for the fixed bands (instant / book / panic): rng() is
   * raised to this power, so >1 skews fast (blitzer) and <1 skews slow (tanker)
   * while every sample stays inside the band.
   */
  bias: number
}

/** The three named clock personalities (persona.timeStyle). */
export const TIME_PERSONALITIES: Record<TimeStyle, TimePersonality> = {
  blitzer: { targetMul: 0.6, sigma: 0.26, tankChance: 0.03, tankMul: 1.9, bias: 1.35 },
  steady: { targetMul: 1.0, sigma: 0.34, tankChance: 0.07, tankMul: 2.4, bias: 1.0 },
  tanker: { targetMul: 1.35, sigma: 0.4, tankChance: 0.15, tankMul: 2.8, bias: 0.8 }
}

/** UI copy for the PersonaDetail "Clock style" row. */
export const TIME_STYLE_COPY: Record<TimeStyle, { name: string; line: string }> = {
  blitzer: { name: 'Blitzer', line: 'moves fast, banks time, and squeezes you in the scramble.' },
  steady: { name: 'Steady', line: 'spends time evenly and is rarely rushed.' },
  tanker: {
    name: 'Tanker',
    line: 'sinks long thinks into the critical moments, and can drift into real time trouble.'
  }
}

/**
 * Plain-engine clock personalities by target Elo: weak bots are erratic (huge
 * sigma: snap moves and random stares), strong bots efficient (fast, tight).
 */
export function personalityForElo(elo: number): TimePersonality {
  if (elo < 900) return { targetMul: 0.9, sigma: 0.65, tankChance: 0.1, tankMul: 2.6, bias: 1.0 }
  if (elo < 1500) return { targetMul: 1.0, sigma: 0.5, tankChance: 0.08, tankMul: 2.5, bias: 1.0 }
  if (elo < 2100) return { targetMul: 1.0, sigma: 0.38, tankChance: 0.06, tankMul: 2.2, bias: 1.0 }
  if (elo < 2600) return { targetMul: 0.85, sigma: 0.3, tankChance: 0.05, tankMul: 2.0, bias: 1.15 }
  return { targetMul: 0.7, sigma: 0.24, tankChance: 0.04, tankMul: 1.8, bias: 1.3 }
}

/**
 * timeStyle for every shipped persona, from their real clock reputations.
 * SOURCE OF TRUTH is resources/personas/personas.json (Persona.timeStyle); this
 * map is the renderer-side fallback because the main-process catalog loader
 * (src/main/personas/personas.ts, not owned here) does not yet pass the field
 * through: see the integrator note. Keep the two in sync.
 */
export const PERSONA_TIME_STYLE: Record<string, TimeStyle> = {
  morphy: 'blitzer', // famously played at lightning speed while opponents burned hours
  anderssen: 'steady',
  steinitz: 'tanker', // deliberate, stubborn defender of cramped positions
  lasker: 'steady',
  capablanca: 'steady', // effortless speed: the "chess machine" was never rushed
  alekhine: 'tanker', // deep combinational digs
  rubinstein: 'steady',
  botvinnik: 'steady',
  tal: 'tanker', // the legendary sacrificial tanks
  petrosian: 'steady', // prophylaxis first, time trouble almost never
  smyslov: 'steady',
  spassky: 'steady',
  fischer: 'blitzer', // played fast, near-zero time trouble, blitz destroyer
  karpov: 'steady', // efficient practicality
  kasparov: 'steady',
  polgar: 'blitzer', // rapid attacking tactician
  anand: 'blitzer', // the Lightning Kid
  kramnik: 'steady',
  carlsen: 'blitzer',
  nakamura: 'blitzer',
  caruana: 'steady',
  ding: 'tanker', // deep thinker, chronic clock pressure
  gukesh: 'tanker', // marathon calculation stretches
  gotham: 'tanker' // tanks, then blunders anyway: relatable
}

/** Resolve a persona's clock style: catalog field first, then the fallback map. */
export function timeStyleForPersona(p: { id: string; timeStyle?: TimeStyle | null }): TimeStyle {
  return p.timeStyle ?? PERSONA_TIME_STYLE[p.id] ?? 'steady'
}

// ---- Budget ----------------------------------------------------------------

/** Hard floor for any allocation (spec: 0.35s). */
export const HARD_FLOOR_MS = 350
/** Absolute allocation ceiling (spec: 90s). */
export const HARD_CEIL_MS = 90_000
/** Fraction-of-remaining ceiling (spec: 25%). */
export const CEIL_FRACTION = 0.25
/** Allocation >= this shows the "thinking deeply" chip variant (spec: ~8s). */
export const DEEP_THINK_MS = 8_000

/** Engine movetime slice bounds within an allocation (integration constants). */
export const ENGINE_SLICE_MIN_MS = 120
/**
 * Cap on the engine's movetime slice. The LATENCY still runs the full
 * allocation (we sleep the remainder); capping the actual search keeps the
 * serialized play-engine queue responsive after a cancel (takeback / new game)
 * and costs nothing at capped Elo.
 */
export const ENGINE_SLICE_MAX_MS = 12_000
/** IPC + apply overhead assumed when carving the engine slice out of T. */
export const ENGINE_OVERHEAD_MS = 150

/**
 * Expected moves left (H) from the fullmove number and material phase, clamped
 * to 12..40. Openings (~full material, low move number) read ~38; late endings
 * clamp to 12 so the bot still budgets a cushion.
 */
export function expectedMovesLeft(moveNumber: number, materialPhase: number): number {
  const est = Math.round(14 + 24 * materialPhase + -0.2 * (moveNumber - 1))
  return Math.max(12, Math.min(40, est))
}

/**
 * Material phase from the FEN board field alone (pure string parse; no chess
 * lib so the sim bundles clean). 1 = full starting piece set, 0 = bare kings.
 * Pieces only (standard phase weights: N/B=1, R=2, Q=4; 24 total).
 */
export function materialPhaseFromFen(fen: string): number {
  const board = fen.split(' ')[0] ?? ''
  let sum = 0
  for (const ch of board) {
    const c = ch.toLowerCase()
    if (c === 'n' || c === 'b') sum += 1
    else if (c === 'r') sum += 2
    else if (c === 'q') sum += 4
  }
  return Math.max(0, Math.min(1, sum / 24))
}

/** Fullmove number from a FEN (field 6), defensively defaulting to 1. */
export function fullmoveOf(fen: string): number {
  const n = Number(fen.split(' ')[5])
  return Number.isFinite(n) && n >= 1 ? n : 1
}

/** Time trouble threshold (spec: remaining < max(15s, 8 * increment)). */
export function isPanic(remainingMs: number, incrementMs: number): boolean {
  return remainingMs < Math.max(15_000, 8 * incrementMs)
}

// ---- Complexity ------------------------------------------------------------

/** Signals distilled from the depth-8 MultiPV-3 probe (all mover POV). */
export interface ComplexitySignals {
  /** cp gap between the best and 2nd-best lines (>= 0); null if only one line. */
  gapCp: number | null
  /** Best move changed between the shallow (depth <= 5) and final read. */
  unstable: boolean
  /** Final best-line eval in cp, mate mapped to +-1000; null when unknown. */
  bestCp: number | null
  /** Opponent left the expected script (not in our previous PV / eval swing >= 70cp). */
  surprise: boolean
}

export const NO_SIGNALS: ComplexitySignals = {
  gapCp: null,
  unstable: false,
  bestCp: null,
  surprise: false
}

/**
 * Fold probe signals into a think-time multiplier, clamped to 0.3x..4x.
 *  - close candidates (small top1-top2 gap) => up; a runaway gap => down a bit
 *  - shallow/final best-move disagreement => up (the position is "moving")
 *  - eval near a decision boundary (|cp| in 50..150) => up
 *  - a surprising opponent move ("the human tank") => big up
 *  - |cp| >= 400 either way => way down (autopilot: conversion or freefall)
 */
export function complexityMultiplier(sig: ComplexitySignals): number {
  let m = 1
  if (sig.gapCp !== null) {
    if (sig.gapCp < 15) m *= 1.8
    else if (sig.gapCp < 40) m *= 1.45
    else if (sig.gapCp < 90) m *= 1.15
    else if (sig.gapCp >= 250) m *= 0.8
  }
  if (sig.unstable) m *= 1.5
  const abs = sig.bestCp === null ? null : Math.abs(sig.bestCp)
  if (abs !== null && abs >= 50 && abs <= 150) m *= 1.3
  if (sig.surprise) m *= 1.9
  if (abs !== null && abs >= 400) m *= 0.45
  return Math.max(0.3, Math.min(4, m))
}

/**
 * Calibration: the multiplier distribution is hot-mean by design (up-factors
 * stack multiplicatively so genuinely sharp positions reach 3-4x), which over a
 * typical game averages ~1.35, not 1.0. The budget divides by this so an
 * average game still spends ~T_base per move. Complex moves get their
 * multiples of routine time without the whole game systematically overspending.
 */
export const COMPLEXITY_NEUTRAL = 1.35

// ---- The plan --------------------------------------------------------------

/** How a move was classified before budgeting. */
export type ThinkClass = 'instant' | 'book' | 'panic' | 'normal'

export interface ThinkPlanInput {
  /** Bot's remaining clock ms at decision time. */
  remainingMs: number
  incrementMs: number
  /** Fullmove number of the position (fullmoveOf). */
  moveNumber: number
  /** materialPhaseFromFen. */
  materialPhase: number
  personality: TimePersonality
  /** Pre-budget classification: forced/theory/normal. Panic is derived here. */
  cls: 'instant' | 'book' | 'normal'
  /** complexityMultiplier output for 'normal' moves (defaults to 1). */
  complexity?: number
  /** Injectable RNG (the sim seeds this). Defaults to Math.random. */
  rng?: () => number
}

export interface ThinkPlan {
  /** Total think latency to enforce (and therefore real clock spend), ms. */
  totalMs: number
  /** Final class after panic resolution. */
  cls: ThinkClass
  /** True when the bot is in time trouble (drives the strength collapse). */
  panic: boolean
  /** The complexity multiplier that shaped the budget (1 for non-probed). */
  complexity: number
}

/** Standard-normal sample via Box-Muller. */
function gauss(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12)
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/** Sample inside [lo, lo+span] with the personality pace bias. */
function bandSample(rng: () => number, bias: number, lo: number, span: number): number {
  return lo + Math.pow(rng(), bias) * span
}

/**
 * Allocate the think time for one bot move. Pure: everything it needs comes
 * in through the input (see ThinkPlanInput).
 *
 * Order of precedence: panic > instant > book > normal budget. Panic wins even
 * over instant/book so a lost-on-time scramble never books a leisurely 3s.
 */
export function planThink(input: ThinkPlanInput): ThinkPlan {
  const rng = input.rng ?? Math.random
  const p = input.personality
  const remaining = Math.max(0, input.remainingMs)
  const complexity = input.complexity ?? 1
  const panic = isPanic(remaining, input.incrementMs)

  // TIME TROUBLE: 0.4-1.2s bashes, shading toward the 0.4s floor as the clock
  // truly empties. (Strength collapses too: the caller passes the shrunken
  // movetime to the engine and the panic flag to the weak path.)
  if (panic) {
    const depthOfTrouble = Math.max(0.25, Math.min(1, remaining / 15_000))
    const total = Math.max(400, bandSample(rng, Math.max(1, p.bias), 400, 800) * depthOfTrouble)
    return { totalMs: Math.round(total), cls: 'panic', panic: true, complexity: 1 }
  }

  // INSTANT CLASS: forced-ish moves (one legal reply / forced check evasion /
  // the lone recapture) get banged out in 0.4-1.5s.
  if (input.cls === 'instant') {
    const total = bandSample(rng, p.bias, 400, 1100)
    return { totalMs: Math.round(total), cls: 'instant', panic: false, complexity: 1 }
  }

  // THEORY: still "in book": 0.5-3s with variance, skewed fast.
  if (input.cls === 'book') {
    const total = bandSample(rng, 1.2 + p.bias, 500, 2500)
    return { totalMs: Math.round(total), cls: 'book', panic: false, complexity: 1 }
  }

  // NORMAL BUDGET: T_base = remaining/H + 0.8*increment, then personality x
  // (mean-calibrated) complexity x mean-corrected log-normal noise, then the
  // fat tank tail (only ever on genuinely complex moves, so tanks correlate
  // with complexity instead of being pure noise).
  const h = expectedMovesLeft(input.moveNumber, input.materialPhase)
  const tBase = remaining / h + 0.8 * input.incrementMs
  let t = tBase * p.targetMul * (complexity / COMPLEXITY_NEUTRAL)
  t *= Math.exp(p.sigma * gauss(rng) - (p.sigma * p.sigma) / 2)
  if (complexity >= 1.2 && rng() < p.tankChance) t *= p.tankMul

  // Floors/ceilings + the safety reserve, so routine allocation can't self-flag:
  // never more than 25% of the clock, never within `reserve` of flagging.
  const reserve = Math.min(remaining * 0.5, Math.max(1200, input.incrementMs))
  const cap = Math.max(
    HARD_FLOOR_MS,
    Math.min(remaining * CEIL_FRACTION, HARD_CEIL_MS, remaining - reserve)
  )
  const total = Math.max(HARD_FLOOR_MS, Math.min(t, cap))
  return { totalMs: Math.round(total), cls: 'normal', panic: false, complexity }
}

// ---------------------------------------------------------------------------
// 2. INTEGRATION HELPERS (renderer only: PlayView)
// ---------------------------------------------------------------------------

/** Forced-move classes that skip the probe and think 0.4-1.5s. */
export type InstantKind = 'one-legal' | 'check-forced' | 'recapture'

/**
 * Classify the position as an instant-class decision for the side to move:
 *   - exactly ONE legal move, or
 *   - in check with <= 2 legal replies, or
 *   - the opponent just captured and there is exactly one move onto that
 *     square (the single same-square recapture humans bang out).
 * Returns null when the position deserves a real think.
 */
export function instantClassOf(
  fen: string,
  prevMove: { uci: string; capture: boolean } | null
): InstantKind | null {
  let dests: ReturnType<typeof destsFor>
  try {
    dests = destsFor(fen)
  } catch {
    return null
  }
  let count = 0
  dests.forEach((tos) => {
    count += tos.length
  })
  if (count === 1) return 'one-legal'
  try {
    if (checkColor(fen) !== undefined && count <= 2) return 'check-forced'
  } catch {
    /* unparseable fen: treat as normal */
  }
  if (prevMove?.capture && prevMove.uci.length >= 4) {
    const sq = prevMove.uci.slice(2, 4)
    let onto = 0
    dests.forEach((tos) => {
      for (const t of tos) if (t === sq) onto++
    })
    if (onto === 1) return 'recapture'
  }
  return null
}

// ---- Complexity probe over the analysis engine channel ---------------------

export const PROBE_DEPTH = 8
export const PROBE_MULTIPV = 3
/** The shallow read used for the stability check (best at depth <= this). */
export const PROBE_EARLY_DEPTH = 5
/** Wall cap: a stolen/wedged probe resolves with whatever it has by then. */
export const PROBE_TIMEOUT_MS = 2_500

/** One candidate line from the probe (mover POV; mate mapped to +-1000). */
export interface ProbeLine {
  uci: string
  cp: number
  /** First few PV moves (for next-turn expectations). */
  pv: string[]
}

export interface ProbeReading {
  fen: string
  /** Lines by MultiPV rank (index 0 = best). May be empty on a starved probe. */
  lines: ProbeLine[]
  /** Best move seen at depth <= PROBE_EARLY_DEPTH (latest such), if any. */
  earlyBest: string | null
  /** Best move of the final read. */
  finalBest: string | null
  /** Final best-line eval, mover POV cp. */
  bestCp: number | null
}

/** What the bot remembers of its last probed think, for the surprise signal. */
export interface ProbeMemo {
  /** Position the bot moved FROM (bot to move). */
  fen: string
  /** Expected opponent replies: pv[1] of every probe line whose pv[0] was the
   *  move the bot actually chose. Empty = no expectation (bot left the top 3). */
  expectedReplies: string[]
  /** Best-line eval at probe time (bot POV; comparable with the next probe). */
  cp: number | null
}

// Minimal structural mirrors of the engine push payloads (avoids importing
// @shared/types so the sim bundle stays dependency-light).
interface ProbeInfoLine {
  handleId: number
  depth?: number
  multipv?: number
  scoreCp?: number
  mate?: number
  pv?: string[]
}
interface ProbeBestmove {
  handleId: number
  bestmove: string
}

function lineCpOf(l: ProbeInfoLine): number {
  if (l.mate !== undefined) return l.mate > 0 ? 1000 : -1000
  return Math.max(-1000, Math.min(1000, l.scoreCp ?? 0))
}

/**
 * One quick engine.analyze read of `fen` (depth 8, MultiPV 3) on the ANALYSIS
 * channel. Never engine:play, so the bot's own search is untouched. Mirrors
 * useAnalysis' safe-stream discipline: results are tagged by handleId (never
 * attributed across positions), the handle is always stopped, and listeners
 * are always detached. Timeout, steal (another analyze evicting ours), or
 * completion all clean up the same way. Returns null when the engine is
 * unavailable or nothing streamed in time (caller treats it as multiplier 1).
 */
export async function runComplexityProbe(fen: string): Promise<ProbeReading | null> {
  const engine = typeof window !== 'undefined' ? window.api?.engine : undefined
  if (!engine) return null

  let handleId: number | null = null
  const byRank = new Map<number, ProbeInfoLine>()
  let earlyBest: string | null = null

  let settle: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })

  const offLine = engine.onLine((l: ProbeInfoLine) => {
    if (handleId === null || l.handleId !== handleId) return
    if (!l.pv || l.pv.length === 0) return
    const rank = l.multipv ?? 1
    byRank.set(rank, l)
    if (rank === 1 && (l.depth ?? 0) <= PROBE_EARLY_DEPTH) earlyBest = l.pv[0]
  })
  const offBest = engine.onBestmove((bm: ProbeBestmove) => {
    if (handleId === null || bm.handleId !== handleId) return
    settle()
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const res = await engine.analyze({
      fen,
      multipv: PROBE_MULTIPV,
      limit: { kind: 'depth', value: PROBE_DEPTH }
    })
    handleId = res.handleId
    await Promise.race([
      done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PROBE_TIMEOUT_MS)
      })
    ])
  } catch {
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    offLine()
    offBest()
    // Stop a still-running (timed-out/stolen) search; stale ids are a no-op.
    if (handleId !== null) void engine.stop(handleId)
  }

  const lines: ProbeLine[] = []
  for (let rank = 1; rank <= PROBE_MULTIPV; rank++) {
    const l = byRank.get(rank)
    if (!l || !l.pv || l.pv.length === 0) continue
    lines.push({ uci: l.pv[0], cp: lineCpOf(l), pv: l.pv.slice(0, 4) })
  }
  if (lines.length === 0) return null
  return {
    fen,
    lines,
    earlyBest,
    finalBest: lines[0].uci,
    bestCp: lines[0].cp
  }
}

/**
 * The "human tank" detector: true when the opponent's actual move was NOT among
 * the replies we expected after our last probed move, or the eval swung >= 70cp
 * against the expectation (both probes are bot-to-move, so cp compares clean).
 */
export function surpriseSignal(
  memo: ProbeMemo | null,
  oppMoveUci: string | null,
  currentBestCp: number | null
): boolean {
  if (!memo || !oppMoveUci) return false
  if (memo.expectedReplies.length > 0 && !memo.expectedReplies.includes(oppMoveUci)) return true
  if (memo.cp !== null && currentBestCp !== null && Math.abs(currentBestCp - memo.cp) >= 70)
    return true
  return false
}

/** Distill a finished probe (+ last-turn memo + the opponent's actual move)
 *  into the multiplier signals. Starved probe => neutral signals. */
export function signalsFromProbe(
  probe: ProbeReading | null,
  memo: ProbeMemo | null,
  oppMoveUci: string | null
): ComplexitySignals {
  if (!probe || probe.lines.length === 0) return NO_SIGNALS
  return {
    gapCp: probe.lines.length >= 2 ? Math.max(0, probe.lines[0].cp - probe.lines[1].cp) : null,
    unstable:
      probe.earlyBest !== null && probe.finalBest !== null && probe.earlyBest !== probe.finalBest,
    bestCp: probe.bestCp,
    surprise: surpriseSignal(memo, oppMoveUci, probe.bestCp)
  }
}

/**
 * Remember what this think expected, for next turn's surprise signal. Returns
 * null when no probe ran (instant/book/panic) or the chosen move wasn't in the
 * probe's candidate set (no reliable expectation).
 */
export function memoAfterMove(probe: ProbeReading | null, chosenUci: string): ProbeMemo | null {
  if (!probe) return null
  const expected: string[] = []
  for (const l of probe.lines) {
    if (l.uci === chosenUci && l.pv.length >= 2) expected.push(l.pv[1])
  }
  if (expected.length === 0 && !probe.lines.some((l) => l.uci === chosenUci)) return null
  return { fen: probe.fen, expectedReplies: expected, cp: probe.bestCp }
}
