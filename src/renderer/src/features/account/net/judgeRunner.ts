// A6 M5 Lane L-t1: the Tier-1 anticheat runner (spec §8 Tier-1, ACCOUNTS-SPEC
// §8).
//
// The last mile of a signed, witnessed, RATED game on the ANTICHEAT side: after
// the game settles, run the PINNED canonical judge (content-hash-gated WASM, a
// judge-dedicated Worker on every platform) over the game transcript to produce
// the canonical JudgeOutput, fold that into the per-game Tier1Record (the §8
// Tier-1 forensic signals: ACPL fit, engine match, clock forensics), and hand
// the signals to the trust/escalation SINK. Both players AND the game's witness
// run this independently over the SAME signed transcript; the pinned binary +
// the bare-FEN transcript surface make the judgeOutputDigest / tier1Digest
// BIT-IDENTICAL on every honest machine (that identity is the whole point; a
// verdict input that split between honest verifiers would be the A4-04 false-
// fraud consensus-split class). It also carries the A5-17 SIGNING-TIME
// DISCIPLINE of the commit-reveal window salt: when a rated game closes a Regan
// window, it collects the anchored salt grants from the canonical witness set
// (clientRequestSaltGrant) and assembles the verified SaltReveal that the Tier-2
// aggregation (Lane L-t2) partitions windows with.
//
// It COMPOSES the built substrate, re-implementing NO crypto and NO judge math:
//   newWebJudgeEngine (src/web/engines/judge.ts): the pinned Worker (INJECTED so
//                                          this module stays DOM-free + headless-
//                                          testable; the boot passes it in)
//   transcriptToJudgePositions (judge.ts): the NORMATIVE bare-FEN verdict surface
//   judgeGame (judge.ts):                   drive the §8 sequence → JudgeOutput
//   tier1Record / tier1Digest (tier1.ts):   the canonical per-game Tier-1 record
//   windowAnchor / consensusSaltOpts (embed.ts): the A5-17/A5-18 salt wiring
//   clientRequestSaltGrant (protocol.ts):   the anchored, signing-time-disciplined
//                                          salt grant round-trip to each witness
//   verifySaltReveal (tier2.ts):            re-derive windowSalt from the grants
//
// Honest degradation (C-10, no dead judge): a non-chess game (the pinned judge is
// standard Stockfish), an unreplayable/illegal transcript, a judge Worker that
// won't start, or too few reachable witnesses for the salt threshold ALL resolve
// to a typed no-op: never a crash, never a fabricated signal. This is only ever
// invoked for a RATED game between two signed-in players; casual/unwitnessed play
// never reaches here, so v5/v6 casual stays byte-identical.
//
// Renderer-hosted (it drives a live FabricEndpoint + a browser Worker) but every
// byte of judge/salt math is A5 crypto from @shared; `src/shared/accounts` stays
// pure. The judge-engine factory, the fabric, persistence and the trust sink are
// all INJECTED, so the whole path folds under a headless MockFabric + a fake (or
// the Node) judge engine exactly as it runs in the browser
// (scripts/test-accounts-judge-runner.mjs).

import { chessOnlineAdapter } from '../../play/online/chessAdapter'
import {
  PARAMS_A5,
  consensusSaltOpts,
  judgeConfigForTier,
  judgeGame,
  judgeOutputDigest,
  tier1Digest,
  tier1Record,
  transcriptToJudgePositions,
  verifySaltReveal,
  windowAnchor,
  type JudgeEngine,
  type JudgeOutput,
  type SaltReveal,
  type Side,
  type Tier1Record,
  type TranscriptMove,
} from '@shared/accounts/judge'
import {
  PARAMS_A2,
  clientRequestSaltGrant,
  type FabricEndpoint,
  type LeaseGrant,
  type NodeId,
} from '@shared/accounts/witness'
import { ladderId, timeCategory } from '@shared/accounts/ratings'
import { verifySegmentEvent } from '@shared/accounts/segment'
import type { B64u, Chain } from '@shared/accounts'
import type { SegmentPayload } from '@shared/accounts/storage/types'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One transcript ply Tier-1 judges. `mp.getSignedGame().moves` (SignedMove[])
 *  is assignable, the extra `sig` is ignored; the move is UCI long-algebraic
 *  (chess codec), the clocks are the mover's post-move snapshot (segment.ts). */
export type Tier1Move = TranscriptMove

/** The completed rated game as the boot hands it over (from the SignedGameOutcome
 *  the segment publisher already assembled). */
export interface Tier1GameView {
  /** The host-minted global game key both sides verified identical (§3). */
  gameKey: B64u
  /** Both players' account roots by color (segment.players). */
  players: { w: B64u; b: B64u }
  /** The ladder kind: the pinned judge is standard Stockfish, so ONLY 'chess'
   *  is judged; any other kind is an honest no-op (no dead judge). */
  kind: string
  /** The A4 ladder time control (§6); its `incMs` is the witness-signed Fischer
   *  increment the clock-forensic think-time derivation credits back (A5-15). */
  tc: { baseMs: number; incMs: number }
  /** The full interleaved signed transcript (mp.getSignedGame().moves). */
  moves: readonly Tier1Move[]
  /** The game's first mover (chess ⇒ always 'w'); default 'w'. */
  firstMover?: Side
}

/** The Tier-1 signals one judged game produced, the SINK payload. Everything a
 *  trust re-weight or a Tier-2 escalation trigger needs to consume this game. */
export interface Tier1Signals {
  gameKey: B64u
  /** ladderId(kind, tc). The ladder the game rated on (the Tier-1 record ladder). */
  ladder: string
  /** The canonical per-game Tier1Record: BOTH sides' §8 forensic signals. */
  record: Tier1Record
  /** tier1Digest(record). The cross-platform Tier-1 parity unit. */
  tier1Digest: B64u
  /** judgeOutputDigest(out). The cross-platform JudgeOutput parity unit. */
  judgeDigest: B64u
}

/**
 * THE HOOK the boot wires to feed Tier-1 signals onward. The signals feed T
 * (the §7/§8 forensic re-weight: its calibrated weight is deferred to the
 * J4/J6 refit, so today's consumer is Lane L-t2's deterministic escalation
 * trigger + any trust-store projection) and the anticheat UI. The runner
 * `await`s it and swallows a throw to a log. A sink error never fails the
 * judge pass. Both players and the witness fire an IDENTICAL record for the
 * same game (the parity property), so a consumer can cross-check across the
 * three independent passes.
 */
export type Tier1Sink = (signals: Tier1Signals) => void | Promise<void>

/** The optional commit-reveal window-salt step (A5-17 signing-time discipline).
 *  Supplied by the boot from the signed-in account context; absent ⇒ the runner
 *  is Tier-1 only (no salt collection). */
export interface Tier1SaltDeps {
  /** The live account fabric (peer.fabric). */
  fabric: FabricEndpoint
  /** THIS signed-in account's root (the salt subject). */
  subjectRoot: B64u
  /** THIS account's own chain, read LAZILY at salt time. The window-close
   *  detection + windowAnchor read the ladder's rated-game list off it. A getter
   *  (not a snapshot) so it observes the just-played segment AFTER it lands: the
   *  judge pass runs for seconds first, by which point the async append has
   *  advanced the boot's chain holder (a not-yet-landed append simply shows no
   *  new window ⇒ an honest salt no-op). */
  chain: () => Chain
  /** The canonical witness set the salt grants are gathered from (the same set
   *  the lease/segment append used. The boot supplies it from the overlay). */
  witnessSet: readonly NodeId[]
  /** Grant threshold; default PARAMS_A2.tLease (effective threshold floors to
   *  max(1, min(tLease, |witnessSet|)), lease.ts's small-population rule). */
  tLease?: number
}

export interface RunTier1Deps {
  /** The pinned judge engine factory: a FRESH judge-dedicated instance per
   *  call. Production passes `() => newWebJudgeEngine()` (src/web/engines/judge.ts,
   *  the content-hash-gated single-thread Worker); tests pass the Node adapter or
   *  a fake JudgeEngine. Kept INJECTED so this module never imports the DOM. */
  newJudgeEngine: () => Promise<JudgeEngine>
  /** The trust/escalation sink (see Tier1Sink). Absent ⇒ signals are returned
   *  only. */
  sink?: Tier1Sink
  /** This account's PRIOR-game acpl window per color (oldest→newest, EXCLUDING
   *  this game). Enables the A5-36 strength-trajectory slope in the record. */
  priorAcplMicros?: { readonly w?: readonly number[]; readonly b?: readonly number[] }
  /** The FEN-before-each-ply builder over the transcript, default: replay the
   *  UCI moves through the SAME chess adapter the live game used (byte-identical
   *  positions). Returns null on an unreplayable/illegal/variant transcript. */
  fenBefore?: (moves: readonly Tier1Move[]) => readonly string[] | null
  /** The A5-17 window-salt step; absent ⇒ Tier-1 only. */
  salt?: Tier1SaltDeps
  /** Diagnostics sink. */
  log?: (msg: string) => void
}

export type RunTier1Result =
  | {
      ok: true
      signals: Tier1Signals
      record: Tier1Record
      tier1Digest: B64u
      judgeDigest: B64u
      out: JudgeOutput
      /** The A5-17 window-salt outcome, present iff a salt step was supplied AND
       *  a window closed on this game (else undefined; the common per-game case). */
      salt?: WindowSaltResult
    }
  | { ok: false; reason: string }

// ---------------------------------------------------------------------------
// FEN-before replay (the default transcript → positions surface)
// ---------------------------------------------------------------------------

/**
 * Replay the transcript's UCI moves through the SAME standard-chess adapter the
 * live game validated them with (chessops under the hood), returning the FEN the
 * mover FACED before each ply: exactly the `fenBeforeOf` that
 * transcriptToJudgePositions consumes. Because it is the identical replay the
 * game used, every honest re-deriver (both players + the witness) reconstructs
 * BYTE-IDENTICAL positions from the signed moves alone. Returns null the instant
 * a move is illegal/unreplayable (a non-chess or corrupt transcript). A
 * fail-closed honest skip, never a partial or fabricated position list.
 */
export function replayFensBefore(moves: readonly Tier1Move[]): string[] | null {
  let fen = chessOnlineAdapter.init()
  const fens: string[] = []
  for (const m of moves) {
    fens.push(fen) // the FEN faced BEFORE this ply
    if (typeof m.move !== 'string') return null
    const next = chessOnlineAdapter.play(fen, m.move)
    if (next === null) return null // illegal / variant / corrupt: honest skip
    fen = next
  }
  return fens
}

// ---------------------------------------------------------------------------
// The Tier-1 pass
// ---------------------------------------------------------------------------

/**
 * Run the Tier-1 judge pass for one completed rated game and feed the signals to
 * the sink. Judges the WHOLE transcript (both sides) through the pinned Worker,
 * mints the canonical Tier1Record, computes the parity digests, and. When a
 * salt step is supplied and this game closed a Regan window, collects the
 * anchored window salt (A5-17). Returns the signals + record, or a typed no-op
 * reason (never throws): 'not-chess' | 'unrated' | 'empty-transcript' |
 * 'replay-failed' | 'positions:…' | 'judge-start:…' | 'judge:…' | 'record:…'.
 */
export async function runTier1ForGame(game: Tier1GameView, deps: RunTier1Deps): Promise<RunTier1Result> {
  const log = deps.log ?? ((): void => {})

  // --- gate: standard chess, rated, non-empty (honest no-op otherwise) --------
  if (game.kind !== 'chess') {
    log(`tier1 skipped: kind '${game.kind}' is not judged (the pinned judge is standard chess)`)
    return { ok: false, reason: 'not-chess' }
  }
  if (timeCategory(game.tc) === 'Unlimited') {
    log('tier1 skipped: unlimited time control is unrated (§6), no timing forensics')
    return { ok: false, reason: 'unrated' }
  }
  if (!Array.isArray(game.moves) || game.moves.length === 0) {
    log('tier1 skipped: empty transcript')
    return { ok: false, reason: 'empty-transcript' }
  }

  // --- transcript → the NORMATIVE bare-FEN verdict surface --------------------
  const fens = (deps.fenBefore ?? replayFensBefore)(game.moves)
  if (!fens || fens.length !== game.moves.length) {
    log('tier1 skipped: transcript did not replay to a full position set')
    return { ok: false, reason: 'replay-failed' }
  }
  let positions
  try {
    positions = transcriptToJudgePositions(game.moves, (i) => fens[i])
  } catch (err) {
    return { ok: false, reason: `positions:${errMsg(err)}` }
  }

  // --- drive the pinned judge Worker over the positions -----------------------
  // ALWAYS the fixed Tier-1 config (t1Nodes/t1MultiPv/hashMb). The only config
  // tier1Record will accept and the exact config the §8 anchors were fit at.
  const config = judgeConfigForTier(1)
  let engine: JudgeEngine
  try {
    engine = await deps.newJudgeEngine()
  } catch (err) {
    return { ok: false, reason: `judge-start:${errMsg(err)}` }
  }
  let out: JudgeOutput
  try {
    out = await judgeGame(engine, positions, config)
  } catch (err) {
    return { ok: false, reason: `judge:${errMsg(err)}` }
  } finally {
    // A judge-dedicated instance is torn down after every game (never pooled).
    await engine.close().catch(() => {})
  }

  // --- fold into the canonical Tier1Record ------------------------------------
  const ladder = ladderId(game.kind, game.tc)
  const firstMover: Side = game.firstMover ?? 'w'
  let record: Tier1Record
  try {
    record = tier1Record(game.gameKey, ladder, out, game.moves, firstMover, game.tc.incMs, deps.priorAcplMicros)
  } catch (err) {
    return { ok: false, reason: `record:${errMsg(err)}` }
  }

  const signals: Tier1Signals = {
    gameKey: game.gameKey,
    ladder,
    record,
    tier1Digest: tier1Digest(record),
    judgeDigest: judgeOutputDigest(out),
  }

  // --- feed the trust/escalation sink (a sink error never fails the pass) ------
  try {
    await deps.sink?.(signals)
  } catch (err) {
    log(`tier1 sink error (ignored): ${errMsg(err)}`)
  }

  // --- A5-17: if this game CLOSED a window, collect its anchored salt ----------
  let salt: WindowSaltResult | undefined
  if (deps.salt) {
    salt = await maybeCollectClosedWindowSalt(ladder, deps.salt, log)
  }

  log(`tier1 landed: ${game.gameKey.slice(0, 8)}… on ${ladder} (${game.moves.length} plies)`)
  return { ok: true, signals, record, tier1Digest: signals.tier1Digest, judgeDigest: signals.judgeDigest, out, ...(salt ? { salt } : {}) }
}

// ---------------------------------------------------------------------------
// A5-17 commit-reveal window salt (signing-time discipline)
// ---------------------------------------------------------------------------

export type WindowSaltResult =
  | {
      ok: true
      /** The window whose salt was revealed. */
      window: number
      /** The A5-17 post-game anchor (windowAnchor) folded into every grant. */
      anchor: B64u
      /** The assembled, threshold-proving reveal. */
      reveal: SaltReveal
      /** b64u(windowSalt). The 32 salt bytes the Tier-2 partition consumes. */
      salt: B64u
      /** Valid distinct grantors collected. */
      grantors: number
    }
  | { ok: false; reason: string }

/**
 * The ladder's chain-ordered RATED-GAME KEY LIST: ordinals 0,1,2,… in
 * witnessed chain order (embed.ts windowAnchor's membership definition). Mirrors
 * fold.ts's rated gate exactly: a witnessed-lane `segment` that verifies
 * (verifySegmentEvent === null: the full §3 gate incl. the atomic rated
 * binding), carries kind+tc, is not Unlimited (§6), and rates on `ladder`. Each
 * game key appears once (a game rates once); order is height (= chain) order.
 * Pure + total (never throws): an unverifiable/foreign segment contributes
 * nothing, exactly like the fold's pass-through.
 */
export function ratedGameKeysForLadder(chain: Chain, ladder: string): B64u[] {
  const out: B64u[] = []
  const seen = new Set<string>()
  const segs = chain.events
    .filter((e) => e.body.lane === 'w' && e.body.type === 'segment')
    .sort((a, b) => a.body.height - b.body.height)
  for (const ev of segs) {
    try {
      if (verifySegmentEvent(ev) !== null) continue
      const p = ev.body.payload as unknown as SegmentPayload
      if (p.kind === undefined || p.tc === undefined) continue // unbound = legacy/unrated
      if (timeCategory(p.tc) === 'Unlimited') continue // §6 unrated
      if (ladderId(p.kind, p.tc) !== ladder) continue
      if (seen.has(p.game)) continue
      seen.add(p.game)
      out.push(p.game)
    } catch {
      // Adversarial payload engineered to crash a deeper layer. Skip it.
    }
  }
  return out
}

/**
 * The window (if any) that CLOSED at `ratedGameCount` rated games. The window
 * whose salt the canonical witnesses will now grant (their A5-17 gate:
 * grant window w iff the subject's rated ordinal ≥ (w+1)·K − 1, protocol.ts).
 * A boundary is crossed exactly when count is a multiple of K, closing window
 * w = count/K − 1. Returns null when no boundary was just crossed OR the closed
 * window is 0. Window 0 has no jittered boundary and no salt (windowAnchor
 * requires windowIndex ≥ 1). Pure.
 */
export function closedWindowIndex(ratedGameCount: number): number | null {
  const K = PARAMS_A5.reganK
  if (!Number.isSafeInteger(ratedGameCount) || ratedGameCount <= 0) return null
  if (ratedGameCount % K !== 0) return null
  const w = ratedGameCount / K - 1
  return w >= 1 ? w : null
}

export interface CollectWindowSaltDeps {
  fabric: FabricEndpoint
  /** The salt subject root. */
  root: B64u
  ladder: string
  /** The canonical witness set to gather grants from. */
  witnessSet: readonly NodeId[]
  /** The ladder's chain-ordered rated-game key list (ratedGameKeysForLadder). */
  ratedGameKeys: readonly string[]
  /** Grant threshold; default PARAMS_A2.tLease. */
  tLease?: number
  log?: (msg: string) => void
}

/**
 * Collect the A5-17 anchored salt grants for `windowIndex` from the canonical
 * witness set and assemble the verified SaltReveal, the client half of the
 * signing-time discipline. Derives the post-game anchor (windowAnchor: a
 * domain-separated digest of the rated game at ordinal windowIndex·K−1, fixed
 * only after that game is chained), requests an anchored grant from EVERY
 * witness (each enforces the discipline server-side: anchor required, rated
 * ordinal ≥ the window's close, its own wts), assembles the reveal, and
 * re-derives windowSalt under the CONSENSUS opts (consensusSaltOpts pins the
 * canonical threshold subset AND requires the anchor, A5-18/A5-17). Honest
 * degradation (C-10): too few reachable/eligible witnesses ⇒ a typed
 * 'salt-insufficient-grants' | 'salt-verify:…', never a fabricated salt.
 */
export async function collectWindowSalt(windowIndex: number, deps: CollectWindowSaltDeps): Promise<WindowSaltResult> {
  const log = deps.log ?? ((): void => {})
  const tLease = deps.tLease ?? PARAMS_A2.tLease

  // The A5-17 post-game anchor: uncomputable before the games preceding the
  // window boundary are chained; a swap invalidates every grant.
  let anchor: B64u
  try {
    anchor = windowAnchor(deps.ratedGameKeys, windowIndex)
  } catch (err) {
    return { ok: false, reason: `salt-anchor:${errMsg(err)}` }
  }

  // Request an ANCHORED grant from every witness (the witness signs only when
  // its own chain view shows the window closed. The signing-time discipline).
  const grants: LeaseGrant[] = []
  const seen = new Set<NodeId>()
  for (const w of deps.witnessSet) {
    try {
      const res = await clientRequestSaltGrant(deps.fabric, w, deps.root, deps.ladder, windowIndex, anchor)
      if (!res.grant) continue
      const g = res.grant
      if (g.w !== w || seen.has(g.w)) continue // grant must come from the asked witness, once
      seen.add(g.w)
      grants.push(g)
    } catch {
      // Unreachable witness: honest degradation handles any shortfall below.
    }
  }
  if (grants.length === 0) {
    log(`salt window ${windowIndex}: no witness granted (rated write still degrades honestly)`)
    return { ok: false, reason: 'salt-insufficient-grants' }
  }

  const reveal: SaltReveal = {
    v: 1,
    scheme: PARAMS_A5.saltScheme,
    root: deps.root,
    ladder: deps.ladder,
    window: windowIndex,
    anchor,
    grants,
  }
  // Re-derive the salt under the consensus opts (requireAnchor + canonical
  // witnessSet pin). A shortfall or a non-canonical subset fails here with the
  // exact reason: never a silently-weaker salt. consensusSaltOpts throws on a
  // malformed witnessSet (empty / >64 / non-NodeId), so it is guarded: a broken
  // set degrades to a typed no-op, never an exception into the game-over path.
  try {
    const verify = verifySaltReveal(reveal, consensusSaltOpts(deps.witnessSet, tLease))
    if (!verify.ok || verify.salt === undefined) {
      return { ok: false, reason: `salt-verify:${verify.errors.join(';')}` }
    }
    return { ok: true, window: windowIndex, anchor, reveal, salt: verify.salt, grantors: grants.length }
  } catch (err) {
    return { ok: false, reason: `salt-opts:${errMsg(err)}` }
  }
}

/** After a rated segment lands: if it closed a Regan window, collect that
 *  window's anchored salt; else a no-op (the common per-game case → undefined). */
async function maybeCollectClosedWindowSalt(
  ladder: string,
  salt: Tier1SaltDeps,
  log: (msg: string) => void,
): Promise<WindowSaltResult | undefined> {
  const keys = ratedGameKeysForLadder(salt.chain(), ladder)
  const windowIndex = closedWindowIndex(keys.length)
  if (windowIndex === null) return undefined // no window closed on this game
  return collectWindowSalt(windowIndex, {
    fabric: salt.fabric,
    root: salt.subjectRoot,
    ladder,
    witnessSet: salt.witnessSet,
    ratedGameKeys: keys,
    ...(salt.tLease !== undefined ? { tLease: salt.tLease } : {}),
    log,
  })
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
