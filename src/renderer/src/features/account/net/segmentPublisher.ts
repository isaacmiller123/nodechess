// A6 M1, LEAD INTEGRATION glue: SignedGameOutcome → the countersigned rated
// segment in THIS player's own chain (spec §3 entanglement, §4 write lease, §6
// ladders).
//
// onlineStore (Lane C) decides rated↔casual and assembles a `SignedGameOutcome`
// from the finished, witnessed game (`mp.getSignedGame()` + `mp.getWitnessIdentity()`
// + the verified terminal `wend` surfaced via `mp.onWitnessStream`). THIS module
// is the small adapter the lead wires as `onlineStore.setSegmentPublisher(...)`:
// it sources the opponent's signed pre-game snapshot over the live account fabric,
// maps the outcome onto Lane E's `PublishSegmentInput`, and calls
// `buildAndPublishSegment` (which gathers the write lease, appends under the
// witness's non-player attestation, and re-folds the a4 ladders). It also serves
// OUR own snapshot to opponents (and to the game's witness, which seeds its attest
// head-cache from it) via Lane E's `servePreGame` + `makeSnapshotProvider`.
//
// It COMPOSES the built lanes and re-implements no crypto. Every honest scarcity
//, signed out, no account peer, opponent unreachable, no seated witness, lease
// short, is a NO-OP (logged), never a crash or a dead button: casual/unwitnessed
// play is entirely unaffected (§4/C-10). Renderer-hosted (it drives a live
// FabricEndpoint); `src/shared/accounts` stays pure. Persistence + wall clock are
// INJECTED so the whole path folds headless exactly as it runs in the browser.

import { nodeIdOf } from '@shared/accounts/witness'
import type { B64u, Chain, PairingPayload, SignedEvent } from '@shared/accounts/types'
import type { ProfileSnapshot } from '@shared/accounts/storage/types'
import {
  buildAndPublishSegment,
  type OppSnapshotView,
  type PublishSegmentInput,
  type PublishSegmentResult,
} from './segmentWriter'
import {
  anchorPairing,
  makeSnapshotProvider,
  requestPreGameSnapshot,
  servePreGame,
} from './preGame'
import type { LeaseRunner } from './leaseRunner'
import type { AccountPeer } from './peerService'
// TYPE-ONLY (fully erased at bundle): the store's outcome shape. Importing it as
// a type keeps this module free of the onlineStore singleton + its transitive mp
// stack, so it stays independently bundleable/headless-testable.
import type { SignedGameOutcome } from '../../play/online/onlineStore'

/** THIS device's signing identity: exactly `accounts.deviceSigningKey()`. */
export interface DeviceSigning {
  root: B64u
  key: B64u
  priv: Uint8Array
}

/** A tiny mutable holder for THIS player's own chain: the pre-game snapshot
 *  provider reads the CURRENT witnessed head synchronously, and a landed segment
 *  advances it so the next game snapshots the new head. The boot layer owns the
 *  holder (refreshed on sign-in; updated here after a successful append). */
export interface ChainHolder {
  get(): Chain
  set(chain: Chain): void
}

// ---------------------------------------------------------------------------
// Serve OUR pre-game snapshot (opponents + the game's witness read it)
// ---------------------------------------------------------------------------

export interface PreGameServingDeps {
  peer: AccountPeer
  chain: ChainHolder
  signing: DeviceSigning
  /** OUR profile snapshot (name required; §5). */
  profile: () => ProfileSnapshot
  /** OUR newest cosigned checkpoint, or undefined (young account → §6 seeds). */
  ckpt?: () => SignedEvent | undefined
  now?: () => number
}

/**
 * Register the `pregame-snapshot` responder on the peer fabric so an opponent
 * (and the game's witness, which seeds its attest head-cache from it) can fetch
 * OUR signed head/profile/checkpoint. Idempotent per fabric (the last provider
 * wins); the boot calls it once per signed-in session.
 */
export function installPreGameServing(deps: PreGameServingDeps): void {
  servePreGame(
    deps.peer.fabric,
    makeSnapshotProvider({
      chain: () => deps.chain.get(),
      signing: deps.signing,
      profile: deps.profile,
      ...(deps.ckpt ? { ckpt: deps.ckpt } : {}),
      now: deps.now ?? ((): number => Date.now()),
    }),
  )
}

// ---------------------------------------------------------------------------
// The publisher: SignedGameOutcome → append the segment to our own chain
// ---------------------------------------------------------------------------

export interface SegmentPublisherDeps {
  /** The live account peer (getAccountPeer). Its fabric routes the opponent
   *  snapshot request + the lease/attest round-trips. Null (signed out / peer
   *  not started) ⇒ honest no-op. */
  getPeer: () => AccountPeer | null
  /** THIS player's own chain holder (current head; advanced on a landed append). */
  chain: ChainHolder
  /** THIS device's signing identity (accounts.deviceSigningKey), or null. */
  signing: () => DeviceSigning | null
  /** Persist the appended chain (keyring().saveChain). */
  saveChain: (root: B64u, chain: Chain) => Promise<void>
  /** The live write-lease runner for THIS account (M2). Present ⇒ the segment
   *  lands at the SAME monotonic epoch the pre-game 'pairing' was anchored under
   *  (leaseRunner.currentEpoch), and the lease is released once the game settles.
   *  Absent ⇒ the M1 default epoch (1). Casual back-compat, byte-identical. */
  getLeaseRunner?: () => LeaseRunner | null
  /** Wall clock (ms). Default Date.now. */
  now?: () => number
  /** Diagnostics sink. */
  log?: (msg: string) => void
  /** Fired after a segment LANDS (chain appended, ladders re-folded). The lead
   *  wires the M3 §5 publish-on-write + the M5 Tier-1 anticheat judge off this;
   *  `game` carries the finished, signed transcript + ladder binding the judge
   *  needs (the segment payload itself omits the moves). Unwired in M1. */
  onPublished?: (res: PublishedSegment) => void
}

/** The finished, signed rated game the M5 Tier-1 runner judges. Everything the
 *  post-game anticheat pass needs that the landed 'segment' event does NOT carry
 *  (the transcript + OUR played color). Structurally the judgeRunner Tier1GameView
 *  input; kept as a local shape so this module stays free of the judge import
 *  (independently bundleable/headless, like the SignedGameOutcome type import). */
export interface FinishedRatedGame {
  /** The host-minted global game key (SegmentPayload.game). */
  game: B64u
  /** Both players' account roots by color. */
  players: { w: B64u; b: B64u }
  /** OUR played color in the finished game. */
  color: 'w' | 'b'
  /** Ladder binding (§6). */
  kind: string
  tc: { baseMs: number; incMs: number }
  /** The full interleaved signed transcript (SignedGameOutcome.signed.moves,
   *  the extra per-move `sig` is ignored by the judge's bare-FEN surface). */
  moves: SignedGameOutcome['signed']['moves']
}

/** The onPublished payload: the landed chain + segment event (M3 §5), plus the
 *  finished-game view the M5 Tier-1 judge consumes (post-game anticheat). */
export interface PublishedSegment {
  chain: Chain
  event: SignedEvent
  game: FinishedRatedGame
}

/** Failures worth one short retry: the witness seeds OUR head into its attest
 *  cache at its own terminal, which can lose a race with our append. A single
 *  retry heals it (M2's witnessed 'pairing' record makes the seed deterministic).
 *  'insufficient-witnesses' is included because a witness that is still joining
 *  the fabric may become reachable a beat later. */
function isTransient(reason: string): boolean {
  return (
    reason === 'insufficient-witnesses' ||
    reason === 'no-non-player-witness' ||
    reason === 'behind' ||
    reason === 'head-mismatch'
  )
}

const RETRY_DELAY_MS = 600
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Build the `SegmentPublisher` the store calls at a finished rated game. Returns
 * a fire-and-forget function (the store's seam is `(outcome) => void`); all async
 * work is self-contained and every failure is swallowed to a log. A rated write
 * that can't complete degrades honestly, it never throws into the UI.
 */
export function createSegmentPublisher(deps: SegmentPublisherDeps): (outcome: SignedGameOutcome) => void {
  const now = deps.now ?? ((): number => Date.now())
  const log = deps.log ?? ((): void => {})
  return (outcome: SignedGameOutcome): void => {
    void publishOne(outcome, deps, now, log).catch((err) =>
      log(`segment publish error (ignored; rated write waits): ${String(err)}`),
    )
  }
}

async function publishOne(
  outcome: SignedGameOutcome,
  deps: SegmentPublisherDeps,
  now: () => number,
  log: (msg: string) => void,
): Promise<void> {
  const peer = deps.getPeer()
  if (!peer) return log('segment publish skipped: no account peer (signed out / not started)')
  const signing = deps.signing()
  if (!signing) return log('segment publish skipped: no device signing key')

  const oppColor = outcome.color === 'w' ? 'b' : 'w'
  const oppRoot = outcome.signed.players[oppColor]
  const selfRoot = outcome.signed.players[outcome.color]
  if (selfRoot !== signing.root)
    return log('segment publish skipped: signed-game seat does not match the signed-in root')

  // 1. The opponent's SIGNED pre-game snapshot over the fabric. Its start head
  //    + height + profile (+ checkpoint for an older account). Unreachable /
  //    unverifiable ⇒ honest no-op (casual play was unaffected either way).
  const snapRes = await requestPreGameSnapshot({
    fabric: peer.fabric,
    opp: nodeIdOf(oppRoot),
    game: outcome.signed.gameKey,
    selfRoot,
    expectOppRoot: oppRoot,
  })
  if (!snapRes.ok) return log(`segment publish skipped: opponent snapshot (${snapRes.reason})`)
  const b = snapRes.snapshot.body
  const opp: OppSnapshotView = {
    root: b.root,
    head: b.head,
    height: b.height,
    profile: b.profile,
    ...(b.ckpt !== undefined ? { ckpt: b.ckpt } : {}),
  }

  // 2. Build + append THIS player's rated segment under the live write lease.
  //    result/reason come from the WITNESS-ADJUDICATED wend. The exact bytes the
  //    wstream signature and the transcript digest were signed over (§3), never
  //    the store's human-readable display text. The lease EPOCH (M2 fencing
  //    token) is the leaseRunner's live epoch, so the segment lands at the SAME
  //    epoch as the pre-game 'pairing': one monotonic run, non-stale at the
  //    witness (a same-device renewal). Absent runner ⇒ the M1 default (epoch 1).
  const runner = deps.getLeaseRunner?.() ?? null
  const epoch = runner?.currentEpoch() ?? undefined
  const chain = deps.chain.get()
  const input: PublishSegmentInput = {
    fabric: peer.fabric,
    chain,
    signing,
    game: outcome.signed,
    color: outcome.color,
    result: outcome.wend.result,
    reason: outcome.wend.reason,
    kind: outcome.kind,
    tc: outcome.tc,
    wstream: { wkey: outcome.witness.key, sig: outcome.wend.sig },
    opp,
    wts: now(),
    ...(epoch !== undefined ? { epoch } : {}),
    saveChain: deps.saveChain,
  }

  try {
    let res: PublishSegmentResult = await buildAndPublishSegment(input)
    if (!res.ok && isTransient(res.reason)) {
      await sleep(RETRY_DELAY_MS)
      res = await buildAndPublishSegment({ ...input, chain: deps.chain.get(), wts: now() })
    }
    if (!res.ok)
      return log(
        `segment publish degraded: ${res.reason}. Rated write waits (a third witness); casual play unaffected`,
      )

    // Landed: advance the local head so the NEXT game snapshots the new head, and
    // notify (the fold is already re-derived inside the writer). `game` carries the
    // signed transcript + binding the M5 Tier-1 judge needs (the segment event does
    // not embed the moves), sourced from the SAME SignedGameOutcome this append was
    // built from, so the judge re-derives BYTE-IDENTICAL positions to the game.
    deps.chain.set(res.chain)
    log(`segment landed: ${outcome.kind} ${outcome.wend.result} (${outcome.wend.reason}), ladders re-folded`)
    deps.onPublished?.({
      chain: res.chain,
      event: res.event,
      game: {
        game: outcome.signed.gameKey,
        players: outcome.signed.players,
        color: outcome.color,
        kind: outcome.kind,
        tc: { baseMs: outcome.tc.baseMs, incMs: outcome.tc.incMs },
        moves: outcome.signed.moves,
      },
    })
  } finally {
    // The game is settled: drop the write lease so another device (or a later
    // game) acquires cleanly. The epoch high-water mark is retained by the
    // runner, so the next acquire never regresses (spec §4 monotonic epochs).
    runner?.release()
  }
}

// ---------------------------------------------------------------------------
// Pre-game: acquire the lease + anchor the REAL witnessed 'pairing' (M2)
// ---------------------------------------------------------------------------

export interface RatedGameStart {
  /** The host-minted global game key (both sides verified it identical, §3). */
  game: B64u
  /** Both players' roots by color (start.players). */
  players: { w: B64u; b: B64u }
  /** OUR color in the game. */
  color: 'w' | 'b'
  /** Ladder binding (§6). */
  kind: string
  tc: { baseMs: number; incMs: number }
  /** The pairing-legality witnessed timestamp (§7/A4-16): the matchmaker's
   *  single pinned instant BOTH sides evaluate pairingLegal at. */
  atWts: number
}

export type RatedGamePrepResult =
  | { ok: true; epoch: number; pairing: PairingPayload }
  | { ok: false; reason: 'playing-elsewhere' | 'insufficient-witnesses' | string }

export interface RatedGamePrepDeps {
  /** The live account peer (getAccountPeer). Null ⇒ honest no-op (casual only). */
  getPeer: () => AccountPeer | null
  /** THIS player's own chain holder (advanced when the pairing lands). */
  chain: ChainHolder
  /** THIS device's signing identity, or null. */
  signing: () => DeviceSigning | null
  /** The live write-lease runner for THIS account. */
  getLeaseRunner: () => LeaseRunner | null
  /** Persist the appended chain (keyring().saveChain). */
  saveChain: (root: B64u, chain: Chain) => Promise<void>
  /** Wall clock (ms). Default Date.now. */
  now?: () => number
  /** Diagnostics sink. */
  log?: (msg: string) => void
}

/**
 * Build the pre-game hook the store calls when a RATED match is confirmed, BEFORE
 * the first move. It (1) acquires the live write lease at the correct monotonic
 * epoch and (2) anchors THIS player's witnessed 'pairing' event under it (spec
 * §3/§4/§8): the on-chain record that turns on the witness's pairing gate. It
 * returns the anchored PairingPayload (the witness's `{ w, b }` gate input) and
 * the lease epoch, or an honest failure the UI surfaces WITHOUT a dead button:
 *   • 'playing-elsewhere':        another device of this account holds the lease;
 *   • 'insufficient-witnesses':   no third machine reachable ⇒ the rated button
 *                                 HONESTLY WAITS (casual/link play stays live).
 * Casual play never reaches here (only a rated match between two signed-in
 * players), so the v5 unwitnessed path is byte-identical.
 */
export function createRatedGamePrep(deps: RatedGamePrepDeps): (start: RatedGameStart) => Promise<RatedGamePrepResult> {
  const now = deps.now ?? ((): number => Date.now())
  const log = deps.log ?? ((): void => {})
  return async (start: RatedGameStart): Promise<RatedGamePrepResult> => {
    const peer = deps.getPeer()
    if (!peer) return { ok: false, reason: 'no-account-peer' }
    const signing = deps.signing()
    if (!signing) return { ok: false, reason: 'no-signing-key' }
    const runner = deps.getLeaseRunner()
    if (!runner) return { ok: false, reason: 'no-lease-runner' }

    const selfRoot = start.players[start.color]
    if (selfRoot !== signing.root) return { ok: false, reason: 'seat-mismatch' }
    const oppRoot = start.players[start.color === 'w' ? 'b' : 'w']
    const players = new Set([nodeIdOf(start.players.w), nodeIdOf(start.players.b)])

    // 1. Acquire the live lease (honest degradation surfaces verbatim).
    const acq = await runner.acquire()
    if (!acq.ok) {
      log(`rated prep: lease unavailable (${acq.reason}). The rated button waits`)
      return { ok: false, reason: acq.reason }
    }

    // 2. Anchor OUR witnessed pairing under it. One short retry heals a witness
    //    that is still seeding our genesis head into its attest cache.
    const anchorOnce = async (): Promise<AnchorOutcome> =>
      anchorPairing({
        fabric: peer.fabric,
        chain: deps.chain.get(),
        signing,
        lease: acq.lease,
        witnessSet: acq.witnessSet,
        game: start.game,
        opp: oppRoot,
        kind: start.kind,
        tc: start.tc,
        atWts: start.atWts,
        players,
        epoch: acq.epoch,
        ts: now(),
        saveChain: deps.saveChain,
      })

    let res = await anchorOnce()
    if (!res.ok && isTransient(res.reason)) {
      await sleep(RETRY_DELAY_MS)
      res = await anchorOnce()
    }
    if (!res.ok) {
      log(`rated prep: pairing anchor degraded (${res.reason}). The rated button waits`)
      // Drop the lease we grabbed but couldn't use. Never hold it idle.
      runner.release()
      return { ok: false, reason: res.reason }
    }

    deps.chain.set(res.chain) // the segment (post-game) chains AFTER the pairing
    log(`rated prep: pairing anchored (epoch ${acq.epoch}), witness gate armed`)
    return { ok: true, epoch: acq.epoch, pairing: res.payload }
  }
}

/** The anchorPairing return, aliased so createRatedGamePrep reads cleanly. */
type AnchorOutcome = Awaited<ReturnType<typeof anchorPairing>>
