// A5 J1. The judged-game protocol (spec §8): drives ANY JudgeEngine adapter
// through the mandated sequence and parses the engine's UCI output into the
// canonical JudgeOutput, whose canonicalHash digest is the unit of
// cross-platform verdict parity.
//
// Mandated sequence per judged game (spec §8 + PARAMS_A5.ttReset='per-game'):
//   stop                                  (defensive: reject stray prior output)
//   isready barrier                       (drain any aborted search's lines)
//   setoption name Threads value 1        (single-thread on EVERY platform)
//   setoption name Hash value <hashMb>    (pinned ≤ 16 MB)
//   setoption name MultiPV value <multiPv>
//   ucinewgame
//   setoption name Clear Hash value true  (mandated TT clear)
//   isready barrier
//   per position, in transcript order:
//     position fen <fen> [moves ...]
//     go nodes <N>                        (fixed nodes, NEVER depth/time)
//
// EXACT PARSE RULE (normative; both adapters, every platform):
//   During one `go nodes N`, an info line is a CANDIDATE RECORD for rank r iff
//   it contains all of ` multipv r`, ` score cp <int>` or ` score mate <int>`,
//   and a non-empty ` pv <moves>`. For each rank, the LAST candidate record
//   seen before the `bestmove` line wins (last-wins, no depth tiebreak; the
//   single-thread engine's emission order is itself deterministic, so "last"
//   is well-defined and identical everywhere). The canonical JudgeLine is
//   { move: first pv token, cp | mate: the reported integer }. Aspiration
//   upper/lower-bound flags are ignored; the score is recorded as reported.
//   FAIL-CLOSED at bestmove time: `bestmove (none)` (terminal position), zero
//   recorded ranks, ranks not exactly contiguous {1..K}, K > multiPv, or a
//   recorded move that is not UCI-shaped ⇒ JudgeParseError and judgeGame
//   rejects with NO partial output. (K < multiPv is legal: positions with
//   fewer legal moves than multiPv yield exactly one rank per legal move.)

import { canonicalHash, type CanonicalObject } from '../codec'
import { toB64u } from '../hash'
import { PARAMS_A5, PARAMS_A5_DIGEST } from './params'
import {
  JudgeConfigError,
  JudgeEngineError,
  JudgeParseError,
  type JudgeConfig,
  type JudgeEngine,
  type JudgeLine,
  type JudgeOutput,
  type JudgePosition,
  type JudgeTier,
  type JudgedPosition,
} from './types'

/** Spec §8: pinned Hash is ≤ 16 MB (same pin as server/judge/nodeEngine.ts). */
export const JUDGE_MAX_HASH_MB = 16

/** UCI long-algebraic move shape (also blocks command injection via `moves`). */
const UCI_MOVE_RE = /^[a-h][1-8][a-h][1-8][nbrq]?$/

/** One FEN field: piece placement / side / castling / ep / counters charset. */
const FEN_FIELD_RE = /^[A-Za-z0-9/-]+$/

/**
 * The judge config for a tier, derived from PARAMS_A5 (the lead-authored,
 * provisional-until-calibrated parameter set).
 */
export function judgeConfigForTier(tier: JudgeTier): JudgeConfig {
  if (tier !== 1 && tier !== 2) throw new JudgeConfigError(`unknown judge tier: ${String(tier)}`)
  return tier === 1
    ? {
        tier: 1,
        nodes: PARAMS_A5.t1Nodes,
        multiPv: PARAMS_A5.t1MultiPv,
        hashMb: PARAMS_A5.hashMb,
        ttReset: PARAMS_A5.ttReset,
      }
    : {
        tier: 2,
        nodes: PARAMS_A5.t2Nodes,
        multiPv: PARAMS_A5.t2MultiPv,
        hashMb: PARAMS_A5.hashMb,
        ttReset: PARAMS_A5.ttReset,
      }
}

/**
 * canonicalHash of the canonical output, base64url, THE unit of
 * cross-platform verdict parity: same transcript + same config + the pinned
 * binary ⇒ the same digest on every platform.
 */
export function judgeOutputDigest(out: JudgeOutput): string {
  return toB64u(canonicalHash(out as CanonicalObject))
}

/**
 * THE canonical transcript→positions builder. The single NORMATIVE
 * Tier-1/verdict judging surface (spec §8: same transcript ⇒ same verdict
 * bits). For a transcript of n moves it returns EXACTLY
 * `[{ ply: i, fen: fenBeforeOf(i) }]` for i = 0..n−1: EVERY transcript ply,
 * each encoded as the bare FEN the mover of ply i faced. NO tail position
 * after the final move, NEVER the `position fen <start> moves …` path
 * encoding. (The TT evolves across positions within a judged game, so any
 * ply-set or encoding drift perturbs every later position's bits ⇒ split
 * judgeOutputDigest between honest verifiers ⇒ the A4-04 false-fraud
 * consensus-split class.) This is exactly the surface TIER2_ANCHORS_JUDGE
 * was measured on (gen-cheater-corpus recordGame), so pinning it re-judges
 * nothing. `fenBeforeOf(i)` is caller-supplied: the caller already holds
 * each ply's fen-before from its game state; board replay is deliberately
 * NOT in the shared core. tier1Record enforces this surface fail-closed at
 * verification (full contiguous coverage, bare-FEN); every verdict-path
 * producer MUST build its positions here. NON-verdict residual: the
 * gen-judge-corpus fenBefore+tail surface feeds ONLY the JUDGE_ELO_FIT
 * estElo fit, never Tier-1/Tier-2 verdicts: tier1Record already rejects
 * its tail via the judged-ply ≥ moves.length check.
 */
export function transcriptToJudgePositions(
  moves: readonly { readonly ply: number }[],
  fenBeforeOf: (ply: number) => string
): JudgePosition[] {
  if (!Array.isArray(moves) || moves.length === 0)
    throw new JudgeConfigError('transcriptToJudgePositions: transcript is empty')
  const positions: JudgePosition[] = []
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i] as { ply?: unknown } | null
    if (typeof m !== 'object' || m === null || m.ply !== i)
      throw new JudgeConfigError(
        `transcriptToJudgePositions: transcript plies not contiguous from 0 (index ${i})`
      )
    positions.push({ ply: i, fen: fenBeforeOf(i) })
  }
  return positions
}

function validateConfig(config: JudgeConfig): void {
  const bad = (msg: string): never => {
    throw new JudgeConfigError(msg)
  }
  if (config.tier !== 1 && config.tier !== 2) bad(`tier must be 1 or 2, got ${String(config.tier)}`)
  if (!Number.isSafeInteger(config.nodes) || config.nodes <= 0)
    bad(`nodes must be a positive integer, got ${String(config.nodes)}`)
  if (!Number.isSafeInteger(config.multiPv) || config.multiPv <= 0)
    bad(`multiPv must be a positive integer, got ${String(config.multiPv)}`)
  if (!Number.isSafeInteger(config.hashMb) || config.hashMb <= 0 || config.hashMb > JUDGE_MAX_HASH_MB)
    bad(`hashMb must be an integer in 1..${JUDGE_MAX_HASH_MB}, got ${String(config.hashMb)}`)
  if (config.ttReset !== 'per-game')
    bad(`ttReset must be 'per-game', got ${String(config.ttReset)}`)
}

function validatePositions(positions: readonly JudgePosition[]): void {
  const bad = (msg: string): never => {
    throw new JudgeConfigError(msg)
  }
  if (positions.length === 0) bad('a judged game needs at least one position')
  let prevPly = -1
  for (const p of positions) {
    if (!Number.isSafeInteger(p.ply) || p.ply < 0)
      bad(`ply must be a non-negative integer, got ${String(p.ply)}`)
    if (p.ply <= prevPly) bad(`plies must be strictly increasing (${p.ply} after ${prevPly})`)
    prevPly = p.ply
    const fields = p.fen.split(' ')
    if (fields.length !== 6 || !fields.every((f) => f.length > 0 && FEN_FIELD_RE.test(f)))
      bad(`fen is not a 6-field FEN string at ply ${p.ply}: ${JSON.stringify(p.fen)}`)
    for (const m of p.moves ?? []) {
      if (!UCI_MOVE_RE.test(m)) bad(`not a UCI move at ply ${p.ply}: ${JSON.stringify(m)}`)
    }
  }
}

/** `isready` barrier: resolves on the engine's `readyok`. */
function barrier(engine: JudgeEngine, onFatal: (cb: (err: Error) => void) => () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const offErr = onFatal((err) => {
      off()
      reject(err)
    })
    const off = engine.onLine((line) => {
      if (line === 'readyok') {
        off()
        offErr()
        resolve()
      }
    })
    engine.send('isready')
  })
}

/** Parse one candidate record per the normative rule above; null = not a record. */
function parseCandidate(line: string): { rank: number; rec: JudgeLine } | null {
  if (!line.startsWith('info ')) return null
  const mpv = / multipv (\d+)/.exec(line)
  const score = / score (cp|mate) (-?\d+)/.exec(line)
  const pv = / pv (\S+)/.exec(line)
  if (!mpv || !score || !pv) return null
  const rank = Number(mpv[1])
  const move = pv[1]
  const value = Number(score[2])
  if (!Number.isSafeInteger(rank) || !Number.isSafeInteger(value)) return null
  const rec: JudgeLine = score[1] === 'cp' ? { move, cp: value } : { move, mate: value }
  return { rank, rec }
}

function analyseOne(
  engine: JudgeEngine,
  pos: JudgePosition,
  config: JudgeConfig,
  onFatal: (cb: (err: Error) => void) => () => void
): Promise<JudgedPosition> {
  return new Promise((resolve, reject) => {
    const byRank = new Map<number, JudgeLine>()
    let done = false
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      off()
      offErr()
      fn()
    }
    const offErr = onFatal((err) => finish(() => reject(err)))
    const off = engine.onLine((line) => {
      if (done) return
      const cand = parseCandidate(line)
      if (cand) {
        byRank.set(cand.rank, cand.rec) // last-wins per rank
        return
      }
      if (!line.startsWith('bestmove')) return
      finish(() => {
        if (line.startsWith('bestmove (none)')) {
          reject(new JudgeParseError('terminal position (bestmove (none)): nothing to judge', pos.ply))
          return
        }
        const k = byRank.size
        if (k === 0) {
          reject(new JudgeParseError('no MultiPV candidate records before bestmove', pos.ply))
          return
        }
        if (k > config.multiPv) {
          reject(new JudgeParseError(`${k} ranks recorded, > multiPv ${config.multiPv}`, pos.ply))
          return
        }
        const lines: JudgeLine[] = []
        for (let r = 1; r <= k; r++) {
          const rec = byRank.get(r)
          if (!rec) {
            reject(new JudgeParseError(`ranks not contiguous: missing multipv ${r} of ${k}`, pos.ply))
            return
          }
          if (!UCI_MOVE_RE.test(rec.move)) {
            reject(
              new JudgeParseError(`recorded move is not UCI-shaped: ${JSON.stringify(rec.move)}`, pos.ply)
            )
            return
          }
          lines.push(rec)
        }
        resolve({ ply: pos.ply, lines })
      })
    })
    const moves = pos.moves ?? []
    engine.send(
      moves.length > 0 ? `position fen ${pos.fen} moves ${moves.join(' ')}` : `position fen ${pos.fen}`
    )
    engine.send(`go nodes ${config.nodes}`)
  })
}

/**
 * Judge a game: drive `engine` through the mandated spec-§8 sequence over
 * `positions` (transcript order) at `config`, and return the canonical
 * JudgeOutput. Deterministic: any prior use of the instance is erased by the
 * per-game ucinewgame + TT clear, so a replay: warm or on a fresh instance,
 * on any platform: yields the identical judgeOutputDigest. Rejects
 * fail-closed (JudgeConfigError / JudgeParseError / JudgeEngineError) with no
 * partial output.
 */
export async function judgeGame(
  engine: JudgeEngine,
  positions: readonly JudgePosition[],
  config: JudgeConfig
): Promise<JudgeOutput> {
  validateConfig(config)
  validatePositions(positions)

  // One fatal-error subscription surface for the whole game (optional on the
  // adapter; without it a dead engine hangs its caller, so adapters SHOULD
  // implement onError).
  const onFatal = (cb: (err: Error) => void): (() => void) =>
    engine.onError
      ? engine.onError((err) => cb(new JudgeEngineError(`judge engine failed mid-game: ${err.message}`)))
      : () => {}

  // Defensive drain: if a caller left a search running, stop it and let its
  // tail output (info/bestmove) land BEFORE we start collecting.
  engine.send('stop')
  await barrier(engine, onFatal)

  // Pinned options + mandated per-game TT reset, behind an isready barrier.
  engine.send('setoption name Threads value 1')
  engine.send(`setoption name Hash value ${config.hashMb}`)
  engine.send(`setoption name MultiPV value ${config.multiPv}`)
  engine.send('ucinewgame')
  engine.send('setoption name Clear Hash value true')
  await barrier(engine, onFatal)

  const judged: JudgedPosition[] = []
  for (const pos of positions) {
    judged.push(await analyseOne(engine, pos, config, onFatal))
  }

  return {
    v: 1,
    config: {
      nodes: config.nodes,
      multiPv: config.multiPv,
      hashMb: config.hashMb,
      params: PARAMS_A5_DIGEST,
    },
    positions: judged,
  }
}
