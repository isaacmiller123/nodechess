// A5 J1: canonical judge core types (spec §8, §11). Platform-neutral: no
// node: imports, no DOM globals. The canonical shapes below are cjson-v1
// values (integers only, no null/undefined members serialized) so JudgeOutput
// hashes identically on every platform: that hash IS the unit of
// cross-platform verdict parity.
//
// Shapes are declared as type aliases (not interfaces) on purpose: aliases
// get TypeScript's implicit index signature, so they are directly assignable
// to CanonicalObject for canonicalHash without casts.

/** Judge analysis tiers (spec §8): 1 = every rated game, 2 = deep escalation. */
export type JudgeTier = 1 | 2

/**
 * A fully explicit judged-game configuration. Derive from PARAMS_A5 via
 * judgeConfigForTier(); tests may trim `nodes` ONLY (never PARAMS_A5 itself).
 * Node counts, never depth/time (spec §8).
 */
export type JudgeConfig = {
  tier: JudgeTier
  /** fixed node cap per analyzed position (`go nodes N`). */
  nodes: number
  /** fixed MultiPV. */
  multiPv: number
  /** pinned Hash in MB, ≤ 16 (allocatable on the weakest supported device). */
  hashMb: number
  /** TT reset granularity: 'per-game' is the only spec §8 mode. */
  ttReset: 'per-game'
}

/**
 * One position of a judged game. `fen` is the base position; `moves` (UCI
 * long-algebraic) are applied on top via `position fen <fen> moves ...`.
 * `ply` identifies the transcript ply this position sits at; plies must be
 * strictly increasing across a judged game (the analysis ORDER is part of the
 * deterministic surface: the TT evolves across positions within a game).
 */
export type JudgePosition = {
  ply: number
  fen: string
  moves?: readonly string[]
}

/**
 * One MultiPV candidate in canonical form: the line's first move plus its
 * final reported score. EXACTLY ONE of `cp` | `mate` is present. The two
 * encode distinctly in cjson (different key), so a mate can never collide
 * with a centipawn value. `cp` is centipawns, `mate` is signed mate-in-N,
 * both from the side-to-move POV as UCI reports them. Integers only.
 */
export type JudgeLine = {
  /** UCI long-algebraic move (first move of the engine's pv for this rank). */
  move: string
  cp?: number
  mate?: number
}

/** Judged analysis of one position: MultiPV candidates in rank order 1..K. */
export type JudgedPosition = {
  ply: number
  /**
   * Rank-ordered candidates. K may be < multiPv when the position has fewer
   * legal moves than multiPv; ranks are always contiguous from 1 (enforced
   * fail-closed by the parser).
   */
  lines: readonly JudgeLine[]
}

/** Config echo embedded in every JudgeOutput: the exact rule set that produced it. */
export type JudgeConfigEcho = {
  nodes: number
  multiPv: number
  hashMb: number
  /** PARAMS_A5_DIGEST. Names the full parameter set, not just the knobs above. */
  params: string
}

/**
 * The canonical judged-game output: a cjson-v1 value. Same transcript +
 * same config + the pinned engine binary ⇒ the same bytes ⇒ the same
 * judgeOutputDigest, on node, desktop, and in the browser.
 */
export type JudgeOutput = {
  v: 1
  config: JudgeConfigEcho
  positions: readonly JudgedPosition[]
}

/**
 * The minimal engine adapter surface the judge protocol drives. Implemented
 * by the Node adapter (server/judge/nodeAdapter.ts, over the child-process
 * harness) and the web adapter (src/web/engines/judge.ts, over a dedicated
 * Worker). Both are judge-dedicated instances. Never shared with the
 * play/analysis pools (spec §8).
 */
export interface JudgeEngine {
  /** send one raw UCI command line (no trailing newline). */
  send(cmd: string): void
  /** subscribe to engine output lines; returns an unsubscribe function. */
  onLine(cb: (line: string) => void): () => void
  /**
   * optional: subscribe to fatal engine errors (process exit, worker error)
   * so an in-flight judgeGame fails instead of hanging. Returns unsubscribe.
   */
  onError?(cb: (err: Error) => void): () => void
  /** tear the dedicated instance down. */
  close(): Promise<void>
}

/**
 * The §8 content-hash gate tripped: the engine binary's sha256 does not match
 * the pinned PARAMS_A5.judgeWasmSha256. The judge REFUSES to run. An
 * un-pinned binary can never produce verdicts.
 */
export class JudgeWasmHashError extends Error {
  override readonly name = 'JudgeWasmHashError'
  constructor(
    /** measured sha256 (lowercase hex) of the offered bytes. */
    readonly actualSha256: string,
    /** the pinned sha256 it was compared against. */
    readonly expectedSha256: string,
    /** where the bytes came from (path or URL). */
    readonly source: string
  ) {
    super(
      `judge WASM content-hash mismatch at ${source}: got sha256=${actualSha256}, ` +
        `expected sha256=${expectedSha256}: refusing to run the judge on an un-pinned binary`
    )
  }
}

/** Invalid judge input (config or positions). Fail-closed: nothing is analyzed. */
export class JudgeConfigError extends Error {
  override readonly name = 'JudgeConfigError'
}

/**
 * The engine's output for a position could not be parsed into a canonical
 * JudgedPosition (missing rank, non-contiguous ranks, terminal position,
 * malformed move). Fail-closed: judgeGame rejects with NO partial output.
 */
export class JudgeParseError extends Error {
  override readonly name = 'JudgeParseError'
  constructor(
    message: string,
    /** the transcript ply being analyzed when parsing failed, if known. */
    readonly ply?: number
  ) {
    super(ply === undefined ? message : `${message} (ply ${ply})`)
  }
}

/** The engine died (process exit / worker error) while a judged game was in flight. */
export class JudgeEngineError extends Error {
  override readonly name = 'JudgeEngineError'
}
