// A6 M1–M4 — LEAD INTEGRATION boot: wire the live account net into the running app.
//
// This is the renderer-only side-effect module the online-game boot imports (next
// to onlineStore.setSoundSink, useOnlineGame.ts). It does several guarded things,
// each an honest NO-OP when signed out so casual/unsigned play stays byte-identical:
//
//   1. Register the signed-in device's signing-key PROVIDER on the store
//      (onlineStore.setSigningKeyProvider(mpSigningKey)) — the store offers this
//      device's key to `mp` only for a RATED game (mpClient.mpSigningKey()).
//   2. Register the segment PUBLISHER (onlineStore.setSegmentPublisher(glue)) —
//      a finished, witnessed rated game's SignedGameOutcome → the countersigned
//      segment appended to this player's own chain (segmentPublisher.ts → Lane E),
//      landing at the M2 lease runner's live monotonic epoch (getLeaseRunner).
//   3. Start the per-client ACCOUNT PEER on sign-in (createBrowserFabric over
//      native WebRTC + trystero, openKvStore for persistence, a presence
//      heartbeat, identity = deviceSigningKey()) and stop it on sign-out. The
//      peer hosts the overlay, serves as an eligible witness/committee member,
//      and serves this player's pre-game snapshot to opponents + the game witness.
//   4. Expose a dev/ops witness surface (window.__chessWitness) so a signed-in
//      idle instance CAN witness a room it is asked to (the M1 dev flow; M2
//      matchmaking auto-assigns). Mirrors window.__chessAccounts — reachable from
//      the console + CI drivers, no dead buttons.
//
//   --- M2 (overlay-backed matchmaking + live write-lease) ---
//   5. Mint ONE live write-lease runner per signed-in account (createLeaseRunner
//      over the peer fabric) and feed it to BOTH the segment publisher (so the
//      post-game 'segment' lands at the same fencing epoch) and the pre-game prep.
//   6. Wire the matchmaking → game HANDOFF (configureMatchmaking): the HOST opens
//      a rated mp room via the online store (host = white) and returns the minted
//      code; the GUEST joins that exact code pinned to the opponent (no room code
//      typed by a human); the assigned WITNESS attaches via witnessControl. On a
//      struck rated match, before move 1, BOTH players acquire the live lease at a
//      monotonic epoch AND anchor the REAL witnessed 'pairing' event in their own
//      chain (createRatedGamePrep → §3/§4/§8). Insufficient witness / playing
//      elsewhere ⇒ the search HONESTLY WAITS (C-10), never a fake game.
//   7. IDLE/OPERATOR WITNESS: a signed-in instance offers to witness matchmade
//      games it is the canonical third machine for (matchmakingStore.offerWitnessing),
//      so a two-player table finds its witness. The always-on operator peer
//      (server/operator/peer.ts, same witnessServe) joins the SAME pool rooms.
//
//   --- M3 (live storage: shard duty / publish-on-write / repair) ---
//   8. Build the overlay STORE-ACCEPT gate (makeStorageDutyGate) over the fabric
//      directory BEFORE the peer and pass its validator + merge in, so every
//      overlay store is shard-capacity + pointer-duty verified (§5); open the KV
//      store at the platform §11 budget. On each landed 'segment'/'pairing',
//      publish-on-write the event onto the guaranteed floor and — throttled, per
//      game / on tab-hide / on sign-out, NEVER per move — finalSync the whole
//      chain into shard space (the §5 owner-gone reconstruction guarantee). Run
//      the background repair loop (eviction=churn=healed) + a write-time
//      shard-pointer index cadence; stop both on teardown.
//
//   --- M4 (live PIN committee + social presence / mailbox / friends) ---
//   9. Register the account-ROOT signer (rootSigningKey) both live clients need,
//      then on sign-in start the PIN committee client (tOPRF over memberServe;
//      record/fuse persist through the KV keyed by root) and the social client
//      (presence + mailbox relay + §3 friend request→consent edges over the
//      overlay). A friend edge lands on our OWN witnessed lane (no third witness
//      needed — the peer's countersignature is its authority). Both singletons
//      stop on teardown. Un-fixtured PIN dialogs + PeopleTab read their live state.
//
// The heavy peer stack activates ONLY on sign-in; a signed-out user never joins
// the accounts fabric. Every failure degrades honestly (rated write waits, PIN /
// social surface an honest wait), never a crash. src/shared/accounts stays pure —
// all hosting lives here.

import { clientAppendWitnessed, makeRootSession, nodeIdOf } from '@shared/accounts/witness'
import type { FuseRecord, NodeId, SignedPinRecord, TakeoverAuth } from '@shared/accounts/witness'
import { KEY_PURPOSE, appendWitnessed, certsProving, deriveChild } from '@shared/accounts'
import type { B64u, CanonicalObject, Chain, FriendPayload, Identity, SignedEvent } from '@shared/accounts'
import { sha256, toB64u, utf8 } from '@shared/accounts/hash'
import { a4Fold, ladderId, ladderInit } from '@shared/accounts/ratings'
import { PARAMS_A5 } from '@shared/accounts/judge'
import type { LadderGameRef, Tier1Record, Tier2VerdictRecord, WindowEntry } from '@shared/accounts/judge'
import type { ProfileSnapshot, SegmentPayload } from '@shared/accounts/storage/types'
import type { MpGameConfig } from '@shared/types'
import {
  deviceSigningKey,
  keyring,
  loadOwnChain,
  rootSigningKey,
  setChainRestoreProvider,
  getState as webGetState,
} from '../../../../../web/accounts'
import { accountsUiStore } from '../mock/store'
import { createRtcTransport } from '../../play/online/rtcTransport'
import { mp, mpSigningKey } from '../../play/online/mpClient'
import { onlineStore } from '../../play/online/onlineStore'
import { createBrowserFabric } from './browserFabric'
import { budgetBytesForPlatform, openKvStore, type KvStore } from './kvStore'
import { createLeaseRunner, type LeaseRunner } from './leaseRunner'
import {
  configureMatchmaking,
  createTrysteroMatchPool,
  matchmakingStore,
  type MatchAssignment,
  type MatchPool,
} from './matchmaking'
import {
  defaultCapsFor,
  detectPlatform,
  getAccountPeer,
  startAccountPeer,
  startAccountPeerSingleton,
  stopAccountPeerSingleton,
  type AccountPeer,
} from './peerService'
import {
  createRatedGamePrep,
  createSegmentPublisher,
  installPreGameServing,
  type ChainHolder,
  type FinishedRatedGame,
  type RatedGameStart,
} from './segmentPublisher'
import {
  finalSyncOwnChain,
  makeStorageDutyGate,
  publishHeldShardPointers,
  publishWitnessedWrite,
  startShardRepairLoop,
  type StorageDutyGate,
} from './shardDuty'
import {
  getPinClientState,
  secureRng,
  setPinRootSignerProvider,
  startPinClientFromProvider,
  stopPinClientSingleton,
} from './pinClient'
import {
  setSocialRootSignerProvider,
  startSocialClientFromProvider,
  stopSocialClientSingleton,
} from './socialClient'
import { resolveAccountView, viewAccountForPeer } from './viewerClient'
import { summarizeNetStatus } from './accountNetStatus'
import { requestPreGameSnapshot } from './preGame'
import { startWitnessing } from './witnessController'
import type { WitnessRunnerGameInit, WitnessRunnerHandle } from './witnessRunner'
// M5 anticheat — Lane L-t1 (Tier-1 judge runner) + Lane L-t2 (verdict client).
import { runTier1ForGame, type Tier1GameView, type Tier1Signals } from './judgeRunner'
import {
  getVerdictClient,
  guardWitnessedAppend,
  makeVerdictDutyGate,
  startVerdictClientSingleton,
  stopVerdictClientSingleton,
  type LadderAudit,
  type SelfBanBuild,
  type VerdictSigner,
} from './verdictClient'
// The pinned judge Worker factory (content-hash-gated WASM; DOM-only). Injected
// into runTier1ForGame so the runner itself stays headless-testable.
import { newWebJudgeEngine } from '../../../../../web/engines'

/** Re-announce presence every 60 s — presence is ephemeral (§4/§11) and a live
 *  tab must refresh it well within the fabric's stale horizon
 *  (peerService staleAfterMs = leaseTtlMs·4 = 480 s). */
const PRESENCE_HEARTBEAT_MS = 60_000

/** M4 — re-publish SOCIAL presence + drain the mailbox on this cadence while a
 *  tab is live (§10 ephemeral presence / store-and-forward mail). Distinct from
 *  the fabric presence heartbeat above (that keeps the OVERLAY node reachable;
 *  this keeps the social surface fresh). */
const SOCIAL_HEARTBEAT_MS = 60_000
const SOCIAL_SYNC_MS = 45_000

/** M3 — the §5 write-time shard-pointer index refresh cadence. Cheap when this
 *  node carries no rows yet (gate.subjects() empty ⇒ a no-op tick); once it is a
 *  duty carrier for others it re-publishes the authenticated 'shard' pointers so
 *  viewers keep enumerating the real carriers. Far shorter than the 6 h repair
 *  scan (that heals eviction; this just keeps the contact sheet current). */
const SHARD_POINTER_CADENCE_MS = 3 * 60_000

/** M5 — re-run the deterministic §8 escalation self-audit on this cadence while a
 *  tab is live: it re-checks every ladder, RETRIES an owed self-ban that could not
 *  be witnessed at game-over (C-10), re-publishes the conviction row, and runs the
 *  self suppression scan. Post-game is the primary trigger; this is the safety net
 *  for a ban that had no reachable witness when its game settled. Far longer than a
 *  game (the judge already ran per game) — this never re-judges, only re-assesses. */
const VERDICT_AUDIT_CADENCE_MS = 5 * 60_000

// ---------------------------------------------------------------------------
// 1 + 2. Store registrations (once, at module load — inert until a rated game).
// ---------------------------------------------------------------------------

onlineStore.setSigningKeyProvider(mpSigningKey)

// M4 — register the account-ROOT signer both the PIN committee client and the
// social client sign their root-bound records with (spec §1 PIN record; §3/§10
// presence/mailbox/friend halves). `rootSigningKey` returns null when signed out,
// so the singletons stay in an HONEST signer-unavailable state until sign-in
// resolves it (startPinClientFromProvider / startSocialClientFromProvider below,
// once the peer is up). Registered once; the accessor reads the live session.
setPinRootSignerProvider(rootSigningKey)
setSocialRootSignerProvider(rootSigningKey)

/** How long a cross-device restore waits for the overlay to find anyone before
 *  giving up. A new device has to join relays and fill a bucket from cold, so
 *  this is deliberately patient — but bounded, because the honest answer when
 *  nothing answers is "not found", not a hung sign-in. */
const RESTORE_REACHABILITY_TIMEOUT_MS = 20_000
const RESTORE_POLL_MS = 500

/**
 * CROSS-DEVICE SIGN-IN (§5 the network is the storage, §10 sign in anywhere).
 *
 * Resolve the account's own chain from the overlay on a machine that has never
 * seen it. Runs BEFORE any session exists, so it stands up its own short-lived
 * peer and tears it down again; reconcilePeer starts the real one moments later
 * once sign-in completes.
 *
 * The transient peer runs as device index 0, whose key is DERIVED from the seed
 * and is therefore already ours on every machine that can derive the identity —
 * and whose cert is already inside the very chain we are fetching, so a verifier
 * that resolves us reaches the same conclusion. The freshly enrolled per-machine
 * device key (accounts.adoptFromNetwork) is a separate, higher index.
 *
 * Never throws: any failure is an honest null, which surfaces as "not found".
 */
setChainRestoreProvider(async (identity: Identity): Promise<Chain | null> => {
  const root = toB64u(identity.rootPub)
  const device = deriveChild(identity.seed, KEY_PURPOSE.device, 0)
  let peer: AccountPeer | null = null
  let kv: KvStore | null = null
  try {
    const platform = detectPlatform()
    kv = await openKvStore({ budgetBytes: budgetBytesForPlatform(platform), requestPersist: false })
    const fabric = createBrowserFabric({ nodeId: nodeIdOf(root) })
    peer = await startAccountPeer({
      identity: { root, key: toB64u(device.pub), priv: device.priv },
      fabric,
      kv,
      announceIntervalMs: PRESENCE_HEARTBEAT_MS,
    })

    // A cold overlay knows nobody yet; resolving against an empty directory just
    // returns the empty floor. Wait for at least one reachable node first.
    const deadline = Date.now() + RESTORE_REACHABILITY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (summarizeNetStatus(peer, Date.now()).peersReachable > 0) break
      await new Promise((r) => setTimeout(r, RESTORE_POLL_MS))
    }

    const live = peer
    const view = await resolveAccountView(live.overlay, root, {
      directory: live.fabric.directory(),
      nowMs: Date.now(),
    })
    // Only a FULL reconstruction is adoptable. The 'floor' path is a union of
    // surviving segments — real data, but not a verified chain, and adopting it
    // would silently truncate history on the new device.
    return view.status === 'expected' && view.chain ? view.chain : null
  } catch {
    return null
  } finally {
    try {
      await peer?.stop()
    } catch {
      /* teardown is best-effort — the restore verdict already stands */
    }
    try {
      await kv?.close?.()
    } catch {
      /* ditto */
    }
  }
})

/**
 * Mint the session that authorizes THIS device to take the write lease at
 * `epoch` — the step that lets an account move to a second machine.
 *
 * Lane, per spec §1 / lease.verifyTakeover:
 *  - PIN provisioned ('set' | 'banned') ⇒ null. The PIN key is only recoverable
 *    through a committee evaluation of the user's actual PIN, so an unattended
 *    mint is impossible by construction; the UI prompts instead.
 *  - No PIN record ⇒ sign with the account root, which sign-in already derived.
 *    One factor, matching what the sign-in copy promises: whoever holds the
 *    password holds the account.
 */
async function mintTakeoverSession(deviceKey: B64u, epoch: number): Promise<TakeoverAuth | null> {
  const signer = rootSigningKey()
  if (!signer) return null
  const phase = getPinClientState().phase
  if (phase === 'set' || phase === 'banned') return null
  try {
    const session = makeRootSession(
      {
        v: 1,
        root: signer.root,
        device: deviceKey,
        purpose: 'lease-takeover',
        evalNonce: toB64u(secureRng()(32)),
        wts: Date.now(),
        epoch,
      },
      signer.rootPriv,
      signer.root,
    )
    return { kind: 'root', session }
  } catch {
    // A malformed body or a signer/root disagreement is an honest refusal, not a
    // crash: acquire() falls back to 'playing-elsewhere'.
    return null
  }
}

/** The signed-in account's own chain, kept in memory so the pre-game snapshot
 *  provider can read the current head SYNCHRONOUSLY (servePreGame answers inline)
 *  and a landed segment advances it for the next game. */
let ownChain: Chain | null = null
const chainHolder: ChainHolder = {
  get(): Chain {
    if (!ownChain) throw new Error('account-net: no own chain loaded (signed out?)')
    return ownChain
  },
  set(c: Chain): void {
    ownChain = c
  },
}

/** M2 — the live write-lease runner for the signed-in account, or null when no
 *  peer is up. ONE runner per account (minted in reconcilePeer, released on
 *  teardown). Fed to the segment publisher AND the pre-game prep so a rated
 *  game's 'pairing' (pre-move-1) and 'segment' (post-game) land at the SAME
 *  monotonic epoch — one fencing run, spec §4. */
let leaseRunner: LeaseRunner | null = null

/** M2 — the stop handle for this instance's idle witness offer (offerWitnessing),
 *  or null. Started when the peer goes live, stopped on teardown. */
let stopWitnessOffer: (() => void) | null = null

/** M2 — the gameKey of the rated game we most recently acquired a lease for, or
 *  null. Lets the store observer release the lease when that game leaves live
 *  play without producing a segment (aborted / unwitnessed), so the heartbeat
 *  never renews past a settled game (the segment publisher releases on its own
 *  path; this is the idempotent backstop). */
let preppedGameKey: string | null = null

// --- M3 storage-duty + M4 PIN/social live-on-sign-in state ------------------

/** M3 — the composed overlay store-accept gate (shard capacity + pointer duty)
 *  for the live peer, or null when none is up. Built BEFORE the peer (its
 *  validator/merge gate every overlay store); its subjects() is the repair
 *  worklist + the shard-pointer index worklist. */
let storageGate: StorageDutyGate | null = null

/** M3 — the live overlay storage gate for the signed-in peer (usedBytes() = the
 *  live §11 byte accounting; subjects() = the accounts we carry rows for), or null
 *  when signed out. The DataTab / net-status surfaces read the REAL figures here
 *  rather than a fixture. */
export function getStorageGate(): StorageDutyGate | null {
  return storageGate
}

/** M3 — the DEVICE signing identity the live peer runs as, captured at start so
 *  the §5 duty operations (publish-on-write / final sync / held-shard pointers)
 *  keep working through a sign-out teardown even after the web session clears
 *  (deviceSigningKey would already read null). Nulled after the sign-out sync. */
let peerSigning: { root: string; key: string; priv: Uint8Array } | null = null

/** M3/M4 — the persistent CanonicalObject store for THIS session (opened at the
 *  §11 platform budget). Backs the peer's overlay accounting AND the PIN record /
 *  fuse persistence (keyed by root). Closed after the peer that used it is down. */
let accountKv: KvStore | null = null

/** M3 — stop handles for the background repair loop + the write-time shard-pointer
 *  cadence, started when the peer goes live and stopped on teardown. */
let stopRepairLoop: (() => void) | null = null
let stopShardPointerCadence: (() => void) | null = null

/** M3 — guards against overlapping §5 final syncs (a slow re-shard must never
 *  stack behind a rapid second game / a tab-hide firing mid-sync). */
let finalSyncInFlight = false

// --- M5 anticheat live state (Tier-1 record projection + verdict cadence) ----

/** M5 §8 — the trust-store PROJECTION: gameKey → the canonical Tier1Record the
 *  pinned judge produced for OUR own rated games. It is the L-t2 escalation
 *  trigger's record input (assessEscalation needs a record for EVERY game in a
 *  window — an unjudged rated game is §8 non-compliance and the check fails
 *  CLOSED). Hydrated from the account KV on sign-in and written on every judged
 *  game, so a long career's trailing-K window stays fully judged across restarts.
 *  Cleared on teardown (1:1 with the signed-in identity). */
const tier1Records = new Map<string, Tier1Record>()

/** M5 — the stop handle for the periodic verdict self-audit cadence, or null. */
let stopVerdictAuditCadence: (() => void) | null = null

/** M5 — serialize the post-game judge passes: two rapid rated finishes must not
 *  spawn two pinned judge Workers (memory) or two overlapping self-audits — a
 *  second landing queues behind the first. */
let judgeChain: Promise<void> = Promise.resolve()

/** OUR profile snapshot for the pre-game exchange + embedded-per-segment (§5).
 *  M1 uses the name only (matches the slice proof); bio/country/flair are an
 *  additive M2 polish. Name comes from the SIGNED session (never a fixture). */
function ownProfileSnapshot(): ProfileSnapshot {
  const name = accountsUiStore.getState().account?.displayName ?? webGetState().displayName ?? 'Player'
  return { name }
}

onlineStore.setSegmentPublisher(
  createSegmentPublisher({
    getPeer: getAccountPeer,
    chain: chainHolder,
    signing: deviceSigningKey,
    // M2: the post-game 'segment' lands at the SAME live lease epoch the pre-game
    // 'pairing' was anchored under; the runner is released once the game settles.
    getLeaseRunner: () => leaseRunner,
    saveChain: (root, chain) => keyring().saveChain(root, chain),
    // M3 §5: the instant the countersigned 'segment' lands, replicate it onto the
    // guaranteed floor (publish-on-write) and — throttled, per game, never per
    // move — leave the whole chain in shard space so it reconstructs owner-gone.
    // M5 §8: the SAME landing is the anticheat trigger — judge the finished game's
    // signed transcript (Tier-1) and run the deterministic Tier-2 escalation.
    onPublished: ({ chain, event, game }) => {
      void afterWitnessedWrite(chain, event)
      void afterRatedSegmentJudged(game)
    },
  }),
)

// ---------------------------------------------------------------------------
// 3. Account-peer lifecycle — start on sign-in, stop on sign-out.
// ---------------------------------------------------------------------------

/** The account root the LIVE peer runs as, or null when none is up. */
let peerRoot: string | null = null
/** Serialize reconciles so rapid store notifications can't race the peer up/down
 *  (the account UI store fires on many state changes; only root TRANSITIONS act). */
let reconcileChain: Promise<void> = Promise.resolve()

function signedInRoot(): string | null {
  return accountsUiStore.getState().account?.rootPub ?? null
}

function scheduleReconcile(): void {
  if (signedInRoot() === peerRoot) return // no transition pending — cheap guard
  reconcileChain = reconcileChain.then(reconcilePeer).catch((err) => {
    console.warn('[account-net] peer reconcile failed:', err)
  })
}

async function reconcilePeer(): Promise<void> {
  const target = signedInRoot()
  if (target === peerRoot) return

  // Tear down the current peer first (sign-out OR account switch).
  if (peerRoot !== null) {
    // M3 §5: leave the freshest chain in shard space BEFORE we go offline, while
    // the overlay is still up and peerSigning still holds the device key (the web
    // session may already be cleared on a sign-out reconcile).
    await runFinalSync('sign-out')
    // M4: stop the social + PIN singletons (each 1:1 with the signed-in identity).
    stopSocialClientSingleton()
    stopPinClientSingleton()
    // M5: stop the verdict-client self-audit cadence + singleton, and drop the
    // in-memory Tier-1 record projection (all 1:1 with the signed-in identity).
    stopVerdictAuditCadence?.()
    stopVerdictAuditCadence = null
    stopVerdictClientSingleton()
    tier1Records.clear()
    // M3: stop the background repair loop + the write-time shard-pointer cadence.
    stopRepairLoop?.()
    stopRepairLoop = null
    stopShardPointerCadence?.()
    stopShardPointerCadence = null
    storageGate = null

    peerRoot = null
    ownChain = null
    peerSigning = null
    // M2: drop the write lease + stop offering to witness before the peer/fabric
    // goes away (both are 1:1 with the signed-in identity).
    stopWitnessOffer?.()
    stopWitnessOffer = null
    leaseRunner?.release()
    leaseRunner = null
    preppedGameKey = null
    await stopAccountPeerSingleton()
    // Close the persistent store AFTER the peer that used it is down.
    if (accountKv) {
      try {
        await accountKv.close()
      } catch {
        /* best-effort — a store that won't close is dropped on GC */
      }
      accountKv = null
    }
  }
  if (target === null) return // signed out — honest no-op

  // Mint the peer for the signed-in identity. deviceSigningKey reads the web
  // session; guard against a sign-out that raced in mid-reconcile.
  const signing = deviceSigningKey()
  if (!signing || signing.root !== target) return

  // M3 §11: the persistent store at the platform's advertised shard budget, with
  // durable storage requested (desktop 200 MB / desktop-browser 50 MB + persist()
  // / mobile 15 MB). Eviction over the floor is tolerated churn that repair heals.
  const platform = detectPlatform()
  const kv = await openKvStore({ budgetBytes: budgetBytesForPlatform(platform), requestPersist: true })
  accountKv = kv
  const fabric = createBrowserFabric({ nodeId: nodeIdOf(signing.root) })
  // M3 §5: build the overlay STORE-ACCEPT gate over THIS fabric's live directory
  // BEFORE the peer, so its composed validator (shard capacity + pointer duty) and
  // merge gate every store the overlay makes. Held in module scope: subjects() is
  // the repair + shard-pointer worklist; usedBytes() the live §11 accounting.
  const gate = makeStorageDutyGate({
    shardMb: defaultCapsFor(platform).shardMb,
    directory: () => fabric.directory(),
    nowMs: () => Date.now(),
  })
  storageGate = gate
  // M5 §8: compose the verdict-row STORE gate OVER the M3 storage gate so ONE
  // validator/merge gates EVERY kind — shard/events/pointers, generic 'record'
  // (incl. the §1 fuse row), and now the kind-'record' Tier-2 verdict rows (each
  // context-free-verified + accused-slot-bound). Non-verdict values fall straight
  // through to the storage gate, so M1–M4 store behavior is byte-identical.
  const verdictGate = makeVerdictDutyGate({ base: gate.validator, baseMerge: gate.merge })
  const peer = await startAccountPeerSingleton({
    identity: { root: signing.root, key: signing.key, priv: signing.priv },
    fabric,
    kv,
    announceIntervalMs: PRESENCE_HEARTBEAT_MS,
    validator: verdictGate.validator,
    overlay: { merge: verdictGate.merge },
  })
  // Capture the device identity the peer runs as — the §5 duty ops use it through
  // a sign-out teardown even after the web session clears.
  peerSigning = { root: signing.root, key: signing.key, priv: signing.priv }
  ownChain = await loadOwnChain()
  installPreGameServing({
    peer,
    chain: chainHolder,
    signing,
    profile: ownProfileSnapshot,
  })

  // M2: mint the live write-lease runner for this account over the peer fabric.
  // Its chain view reads the SAME in-memory holder the pre-game snapshot + the
  // segment writer advance, so acquire()/probe() see the current head.
  leaseRunner = createLeaseRunner({
    fabric: peer.fabric,
    identity: { root: signing.root, key: signing.key, priv: signing.priv },
    chain: () => chainHolder.get(),
    mintTakeover: (epoch) => mintTakeoverSession(signing.key, epoch),
  })

  peerRoot = signing.root

  // M2: offer to WITNESS matchmade games this instance is the canonical third
  // machine for (the idle/always-on posture — so a two-player table finds its
  // witness). The operator peer runs the equivalent by joining the same pool
  // rooms (server/operator/peer.ts). Stopped on teardown.
  stopWitnessOffer = matchmakingStore.offerWitnessing()

  // M3 §5: start the background repair loop (eviction=churn=healed) + the
  // write-time shard-pointer index cadence, both over the live overlay. Both are
  // stopped on teardown; both are cheap no-ops until this node carries rows.
  stopRepairLoop = startShardRepairLoop({
    node: peer.overlay,
    gate,
    directory: () => peer.fabric.directory(),
    nowMs: () => Date.now(),
  })
  stopShardPointerCadence = startShardPointerCadence(peer, gate)

  // M4: start the live PIN committee client (tOPRF over the peer's memberServe).
  // The PIN record + fuse persist through the account KV keyed by root; publishFuse
  // is the M5 overlay/shard-space hook (a no-op stub for now). Honest 'no-committee'
  // when < pinN committee-capable machines are reachable — the wizard waits.
  startPinClientFromProvider({
    loadRecord: loadPinRecord,
    saveRecord: savePinRecord,
    loadFuse: loadPinFuse,
    publishFuse: publishPinFuse,
  })

  // M4: start the live social client (presence + mailbox relay + §3 friends over
  // the overlay). appendFriendEdge lands the countersigned edge on our own
  // witnessed lane (it works in the honest 2-user case — the peer's
  // countersignature is its authority, no third witness needed); chainOf/resolveName
  // are best-effort (honest empties otherwise). Stopped on teardown.
  startSocialClientFromProvider({
    getPeer: getAccountPeer,
    loadChain: async () => ownChain,
    appendFriendEdge,
    chainOf: () => null,
    resolveName,
    heartbeatMs: SOCIAL_HEARTBEAT_MS,
    syncMs: SOCIAL_SYNC_MS,
  })

  // M5 §8: start the live Tier-2 verdict client — the deterministic escalation
  // trigger on OUR chain-derived rated-game windows → 5σ conviction → the §8
  // self-ban appended BEFORE any further witnessed event → the reproducible
  // verdict row published over the overlay. Its window inputs are the a4 fold's
  // seed-pinned ladders (byte-identical across verifiers) + the Tier-1 records the
  // judge runner folds in — hydrated from the KV first so a long career's
  // trailing-K window is fully-judged across restarts. It NEVER fabricates a ban
  // (only a 5σ self-audit convicts; every scarcity degrades to an honest wait).
  await hydrateTier1Records(signing.root)
  startVerdictClientSingleton({
    root: signing.root,
    getNode: () => getAccountPeer()?.overlay ?? null,
    signer: verdictSignerOf,
    ladderAudits: ourLadderAudits,
    appendSelfBan: appendSelfBanWitnessed,
    hasSelfBan: (ladder) => (ownChain ? foldSelfBanLadders(ownChain).has(ladder) : false),
    log: (m) => console.info(`[account-net] verdict: ${m}`),
  })
  stopVerdictAuditCadence = startVerdictAuditCadence()

  console.info(`[account-net] account peer live (node ${peer.nodeId.slice(0, 8)}…)`)
}

accountsUiStore.subscribe(scheduleReconcile)
// Kick once: a remembered-seed session may have resumed before this module loaded.
scheduleReconcile()

// ---------------------------------------------------------------------------
// 4. Dev/ops witness surface (M1 flow: room + participants handed in out of band).
// ---------------------------------------------------------------------------

let activeWitness: WitnessRunnerHandle | null = null

/** Start/stop witnessing one room — reachable from the console + CI drivers, the
 *  same dev-surface pattern as window.__chessAccounts. In production the always-on
 *  operator peer (server/operator/peer.ts, same witnessServe) is the reliable
 *  third machine; M2 matchmaking auto-assigns the witness from the pool. */
export const witnessControl = {
  /** Witness `roomCode` for one game. `gameInit`: both players' {root, device
   *  key} in `participants`, and for RATED play kind/tc + pairing:'embedder
   *  -verified'. Returns true if the runner started (signed in + peer live). */
  start(roomCode: string, gameInit: WitnessRunnerGameInit): boolean {
    activeWitness?.stop()
    activeWitness = startWitnessing(roomCode, gameInit, {
      getPeer: getAccountPeer,
      signing: deviceSigningKey,
      makeTransport: createRtcTransport,
    })
    return activeWitness !== null
  },
  /** Stop the active witness (idempotent). */
  stop(): void {
    activeWitness?.stop()
    activeWitness = null
  },
  /** Whether a witness runner is currently live. */
  active(): boolean {
    return activeWitness !== null
  },
}

declare global {
  interface Window {
    __chessWitness?: typeof witnessControl
  }
}

if (typeof window !== 'undefined') window.__chessWitness = witnessControl

// ---------------------------------------------------------------------------
// 5. Matchmaking → game HANDOFF + the pre-game lease/pairing prep (M2).
//
// configureMatchmaking wires the three live seams the matchmaking engine calls
// when it strikes a match over the pool (matchmaking.ts owns the pool + pairing
// + witness-assignment; the lead owns the mp/witness singletons). Every seam is
// only ever entered for a RATED search between two signed-in accounts — casual /
// link play never reaches here and stays byte-identical.
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The guest waits this long after accepting the offer before it joins the mp
 *  room, so the assigned WITNESS has time to attach + take its seat first. The
 *  host mirrors the signed `start` exactly ONCE — when the guest's hello arrives
 *  — and mpSession does NOT resend it to a witness seated later (onWitnessHello),
 *  so a witness that hellos after `start` never initializes its WitnessCore and
 *  never countersigns. Seating the witness before the guest joins avoids that.
 *  (See notesForLead: the durable fix is mpSession resending start/resync to a
 *  late-seated witness, which would let this delay drop to ~0.) */
const WITNESS_SEAT_DELAY_MS = 9_000

/** The mp game config for a matchmade rated game: the ladder's time control, the
 *  host seated as WHITE (mp seats the host white; the matchmaker set color 'w'
 *  for the host, 'b' for the guest), and the ladder kind (chess). */
function hostConfigFor(a: MatchAssignment): MpGameConfig {
  return {
    tc: { initialMs: a.tc.baseMs, incrementMs: a.tc.incMs },
    hostColor: 'white',
    game: { kind: a.kind },
  }
}

/** Seed the players' CURRENT heads into THIS peer's witnessServe attest cache so
 *  their pre-game witnessed 'pairing' appends get our non-player attestation. The
 *  head is game-independent, so a placeholder game key (derived from the room) is
 *  enough to fetch each player's signed head snapshot. Best-effort + retried — a
 *  player not yet reachable over the fabric simply seeds a beat later (the
 *  players' prep retries meanwhile). */
async function seedWitnessHeads(code: string, participants: ReadonlyArray<{ root: string }>): Promise<void> {
  const peer = getAccountPeer()
  const signing = deviceSigningKey()
  if (!peer || !signing) return
  const seedGame = toB64u(sha256(utf8(`mm-witness-seed:${code}`)))
  for (const p of participants) {
    for (let i = 0; i < 8; i++) {
      const snap = await requestPreGameSnapshot({
        fabric: peer.fabric,
        opp: nodeIdOf(p.root),
        game: seedGame,
        selfRoot: signing.root,
        expectOppRoot: p.root,
      })
      if (snap.ok) {
        await peer.witness.seedHead(p.root, { id: snap.snapshot.body.head, height: snap.snapshot.body.height })
        break
      }
      await sleep(1_000)
    }
  }
}

/** The M2 pre-game hook: acquire the live write lease at the correct monotonic
 *  epoch AND anchor OUR witnessed 'pairing' event before move 1 (both players run
 *  it for their own chain). Honest degradation surfaces the reason (no witness /
 *  playing elsewhere) — the rated write waits, casual play is unaffected. */
const ratedGamePrep = createRatedGamePrep({
  getPeer: getAccountPeer,
  chain: chainHolder,
  signing: deviceSigningKey,
  getLeaseRunner: () => leaseRunner,
  saveChain: (root, chain) => keyring().saveChain(root, chain),
  log: (m) => console.info(`[account-net] ${m}`),
})

/** Wait (bounded) until the live signed session mints (host) / adopts (guest) the
 *  gameKey for THIS matchmade game. The gameKey is minted at runtime with a random
 *  nonce (mpSession.setupSignedGame), so it cannot be known before the game starts;
 *  we read it once the session is signed. An opponent that never offers identity
 *  (a casual game) never signs ⇒ this returns null and prep is a no-op (the game
 *  is a normal casual game; nothing breaks). */
async function waitForSignedGame(
  oppRoot: string,
  timeoutMs = 30_000,
): Promise<{ gameKey: string; players: { w: string; b: string } } | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const g = mp.getSignedGame()
    if (g && (g.players.w === oppRoot || g.players.b === oppRoot))
      return { gameKey: g.gameKey, players: g.players }
    if (Date.now() > deadline) return null
    await sleep(250)
  }
}

/** Fire-and-forget from the host/guest handoff: once the matchmade game is signed,
 *  acquire the lease + anchor the pairing. Records the gameKey on success so the
 *  lease is released when that game settles (backstop observer below). */
async function runRatedPrep(a: MatchAssignment): Promise<void> {
  const signed = await waitForSignedGame(a.opponent.root)
  if (!signed) {
    console.info('[account-net] rated prep skipped: game never became signed (opponent casual / unreachable)')
    return
  }
  // M5 §8: before anchoring OUR witnessed 'pairing', discharge any owed self-ban
  // FIRST — a 5σ conviction obliges the self-ban to be the NEXT witnessed event.
  // guardWitnessedAppend re-runs the self-audit AND attempts the owed append, so
  // this both retries the ban and reports whether we remain blocked; if it cannot
  // be witnessed yet, hold the rated pairing (honest wait, C-10) — casual play is
  // never affected (it does not reach here).
  const banGuard = await guardWitnessedAppend()
  if (banGuard.blocked) {
    console.warn(`[account-net] rated prep held: §8 self-ban owed on ${banGuard.pending.join(', ')} — rated write waits (C-10)`)
    return
  }
  const start: RatedGameStart = {
    game: signed.gameKey,
    players: signed.players,
    color: a.color,
    kind: a.kind,
    tc: { baseMs: a.tc.baseMs, incMs: a.tc.incMs },
    atWts: a.atWts,
  }
  const res = await ratedGamePrep(start)
  if (res.ok) {
    preppedGameKey = signed.gameKey
    console.info(`[account-net] rated prep OK (${a.color}) — lease epoch ${res.epoch}, witnessed pairing anchored`)
    // M3 §5 publish-on-write: replicate the just-anchored 'pairing' head onto the
    // guaranteed floor now (the post-game 'segment' final sync will re-shard the
    // whole chain including it; this makes the pairing recoverable immediately).
    void replicateWitnessedHead('pairing')
  } else {
    console.warn(`[account-net] rated prep degraded: ${res.reason} — rated write waits (C-10); casual play unaffected`)
  }
}

/**
 * Wrap a MatchPool so OUR OWN publish never wakes OUR OWN subscribers — only a
 * REMOTE message does. Without this, the live search loops forever: the engine
 * subscribes `poll` to the pool AND `poll` publishes a fresh (higher-epoch) seek,
 * whose local echo synchronously notifies subscribers → poll → publish → notify →
 * … (a self-publish re-entrancy; the headless suite never hits it because it
 * drives poll() manually). The engine reads list() right after it publishes, so
 * suppressing the self-notify loses nothing; the heartbeat + remote messages
 * still drive the cadence. (Lead workaround — see notesForLead: the root fix
 * belongs in matchmaking.ts's pool adapters, which notify on self-publish.)
 */
function nonReentrantPool(inner: MatchPool): MatchPool {
  let selfPublishing = false
  const subs = new Set<() => void>()
  inner.subscribe(() => {
    if (!selfPublishing) subs.forEach((f) => f())
  })
  return {
    publish(m): void {
      selfPublishing = true
      try {
        inner.publish(m)
      } finally {
        selfPublishing = false
      }
    },
    list: () => inner.list(),
    retract: (root) => inner.retract(root),
    subscribe(cb): () => void {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    },
    close: () => inner.close(),
  }
}

configureMatchmaking({
  // The (kind, ladder) pool transport — the real trystero room, wrapped so a
  // self-publish can't re-enter the poll loop (see nonReentrantPool).
  poolFactory: (kind, ladderId): MatchPool => nonReentrantPool(createTrysteroMatchPool({ kind, ladderId })),
  // HOST: open a rated mp room via the online store; the minted code (getState().
  // code) is what the engine publishes as the signed offer. host = white. Kick the
  // pre-game lease+pairing prep once the code is out (non-blocking — the engine is
  // waiting on the code to publish the offer). Returns null on a host failure, which
  // the engine reflects honestly (opponent + witness found, room open pending).
  openRoom: async (a: MatchAssignment): Promise<string | null> => {
    try {
      await onlineStore.host(hostConfigFor(a), { rated: true })
    } catch (err) {
      console.warn(`[account-net] matchmaking host failed: ${String(err)}`)
      return null
    }
    const code = onlineStore.getState().code
    if (code) void runRatedPrep(a)
    return code
  },
  // GUEST: join the host's EXACT room, pinned to the opponent root (no code typed
  // by a human — the pool + signed offer carried it). guest = black. Kick prep.
  // The join is delayed so the witness seats first (WITNESS_SEAT_DELAY_MS).
  joinRoom: (a: MatchAssignment): void => {
    setTimeout(() => {
      void onlineStore.join(a.code, { rated: true, oppRoot: a.opponent.root })
      void runRatedPrep(a)
    }, WITNESS_SEAT_DELAY_MS)
  },
  // WITNESS: attach to a matchmade game we self-assigned to witness. The mp gameKey
  // is minted at runtime (random nonce) and is NOT known at attach time, so the
  // WitnessCore move-gate follows as 'embedder-verified' (as in M1). The REAL
  // witnessed 'pairing' events still anchor in BOTH chains via the players' prep
  // above — that is the M2 §3/§8 substrate deliverable, independent of this gate.
  startWitness: (a): void => {
    witnessControl.start(a.code, {
      participants: a.participants,
      kind: a.kind,
      tc: a.tc,
      pairing: 'embedder-verified',
    })
    // The witness's own pre-game head seed (witnessController.seedHeadsFor) is
    // gated on a known gameKey — which the runtime mints only once the game
    // starts — so it is skipped here. Seed the players' CURRENT heads directly
    // so their pre-game 'pairing' appends get this non-player witness's
    // attestation (admitEvent rejects a height-1 event against an un-seeded root).
    // The head is game-independent, so a placeholder game key suffices to fetch it.
    void seedWitnessHeads(a.code, a.participants)
  },
})

// Backstop: release the write lease when a prepped rated game leaves live play
// without producing a segment (aborted / unwitnessed / left), so the heartbeat
// never renews past a settled game. The segment publisher already releases on its
// own path (idempotent); this covers the no-segment cases. Cheap when idle
// (guarded on preppedGameKey) and never touches casual play.
onlineStore.subscribe(() => {
  if (preppedGameKey === null) return
  if (onlineStore.getState().phase !== 'game') {
    leaseRunner?.release()
    preppedGameKey = null
  }
})

// ---------------------------------------------------------------------------
// 6. M3 §5 live storage duty — publish-on-write, throttled final sync, the
//    write-time shard-pointer index. All guarded on a live peer + signing; a
//    signed-out tab never enters any of it (casual play stays byte-identical).
// ---------------------------------------------------------------------------

/** The highest-height witnessed-lane event of a chain (the countersigned head),
 *  or null — the event publish-on-write / final sync commit against. */
function witnessedHeadEventOf(chain: Chain): SignedEvent | null {
  let best: SignedEvent | null = null
  for (const ev of chain.events) {
    if (ev.body.lane !== 'w') continue
    if (!best || ev.body.height > best.body.height) best = ev
  }
  return best
}

/**
 * A rated 'segment' just landed: replicate it onto the guaranteed floor
 * (publish-on-write, §5 "witnessed events replicate at creation") and — throttled
 * — leave the whole chain in shard space. The throttle is PER GAME (one 'segment'
 * per game, never per move); a rated game is minutes apart, so re-sharding per
 * game is cheap and guarantees a hard-killed node already left a fresh, chain-
 * pointer-pinned snapshot for the §5 owner-gone reconstruction. Never throws.
 */
async function afterWitnessedWrite(chain: Chain, event: SignedEvent): Promise<void> {
  const peer = getAccountPeer()
  const signing = peerSigning
  if (peer && signing) {
    try {
      await publishWitnessedWrite(peer.overlay, signing, chain, event)
    } catch {
      /* honest no-op — no reachable carrier yet; repair + final sync catch up */
    }
  }
  await runFinalSync('post-game')
}

/** Publish-on-write the current witnessed head IFF it is of `expectType`
 *  (pairing / friend) — the just-anchored event replicated onto the §5 floor.
 *  Best-effort; a chain whose head has already advanced past it simply skips. */
async function replicateWitnessedHead(expectType: string): Promise<void> {
  const peer = getAccountPeer()
  const signing = peerSigning
  const chain = ownChain
  if (!peer || !signing || !chain) return
  const head = witnessedHeadEventOf(chain)
  if (!head || head.body.type !== expectType) return
  try {
    await publishWitnessedWrite(peer.overlay, signing, chain, head)
  } catch {
    /* honest no-op */
  }
}

/**
 * The §5 FINAL SYNC of OUR own chain: erasure-code it to distance-assigned
 * carriers + pin a self chain-pointer whose embedded countersigned head survives
 * us going offline. Non-overlapping (a slow re-shard never stacks) and total (a
 * root-signed / genesis-only head is 'head-not-signable' — an honest skip, not a
 * crash). Triggered per game, on tab-hide, and on sign-out — NEVER per move.
 */
async function runFinalSync(trigger: string): Promise<void> {
  if (finalSyncInFlight) return
  const peer = getAccountPeer()
  const signing = peerSigning
  const chain = ownChain
  if (!peer || !signing || !chain) return
  finalSyncInFlight = true
  try {
    const res = await finalSyncOwnChain(peer.overlay, signing, chain)
    if (res.ok)
      console.info(
        `[account-net] final sync (${trigger}): ${res.liveRows} shard rows live, chain pointer ${res.chainPointerStored > 0 ? 'pinned' : 'pending'}`,
      )
    else console.info(`[account-net] final sync (${trigger}) skipped: ${res.reason}`)
  } catch (err) {
    console.warn(`[account-net] final sync (${trigger}) error (ignored):`, err)
  } finally {
    finalSyncInFlight = false
  }
}

/**
 * The write-time shard-pointer index on a cadence (§5 "the index is built at
 * write time; viewing never searches"): for every shard row THIS node holds and
 * is a duty carrier of, publish an authenticated 'shard' pointer naming us as
 * holder. A cheap no-op until this node carries rows for others (gate.subjects()
 * empty); once it does, it keeps the subjects' contact sheets current. Returns a
 * stop handle for teardown. Never throws (a directory-lag row is skipped).
 */
function startShardPointerCadence(peer: AccountPeer, gate: StorageDutyGate): () => void {
  const tick = async (): Promise<void> => {
    const signing = peerSigning
    const chain = ownChain
    if (!signing || !chain) return
    const subjects = gate.subjects()
    if (subjects.length === 0) return
    try {
      await publishHeldShardPointers(peer.overlay, signing, chain, {
        directory: peer.fabric.directory(),
        nowMs: Date.now(),
        subjects,
      })
    } catch {
      /* honest — a row we cannot prove duty for is skipped, never fatal */
    }
  }
  const timer = setInterval(() => void tick(), SHARD_POINTER_CADENCE_MS)
  return (): void => clearInterval(timer)
}

// ---------------------------------------------------------------------------
// 7. M4 live PIN + social hooks the singletons call (all honest no-ops signed
//    out). PIN persistence routes through the account KV keyed by root; the
//    friend-edge write lands on our own witnessed lane; name resolution is a
//    best-effort viewer reconstruction.
// ---------------------------------------------------------------------------

const PIN_RECORD_PREFIX = 'pin-record|'
const PIN_FUSE_PREFIX = 'pin-fuse|'

/** Load this account's persisted PIN record from the account KV (null when none
 *  stored / no store / a corrupt row — the client redraws a live committee). */
async function loadPinRecord(root: string): Promise<SignedPinRecord | null> {
  if (!accountKv) return null
  try {
    const v = await accountKv.get(PIN_RECORD_PREFIX + root)
    return (v as unknown as SignedPinRecord) ?? null
  } catch {
    return null
  }
}

/** Persist the account's PIN record to the account KV (best-effort — a denied /
 *  over-budget write is honest churn; the committee still holds the shares). */
async function savePinRecord(root: string, rec: SignedPinRecord): Promise<void> {
  if (!accountKv) return
  try {
    await accountKv.put(PIN_RECORD_PREFIX + root, rec as unknown as CanonicalObject)
  } catch {
    /* honest no-op */
  }
}

/** Load a persisted (expired) fuse — sets the next cycle's floor (§1). Null until
 *  the M5 hook persists one; the live committee count re-derives an active ban. */
async function loadPinFuse(root: string): Promise<FuseRecord | null> {
  if (!accountKv) return null
  try {
    const v = await accountKv.get(PIN_FUSE_PREFIX + root)
    return (v as unknown as FuseRecord) ?? null
  } catch {
    return null
  }
}

/**
 * Publish a tripped §1 fuse into real shard/pointer space (the M5 hook, no longer
 * inert). A fuse is a public signed fact any verifier can check (pin.ts) — its
 * committee ≥ pinT co-signature is its authority, so publishing it is safe even
 * though the committee's replicated counter stays the live source of truth:
 *   1. PERSIST it through the account KV under the SAME key loadPinFuse reads, so
 *      the tripped ban survives a restart and sets the next cycle's floor (§1) —
 *      previously nothing wrote it, so every refresh re-tripped from the counter.
 *   2. REPLICATE it onto the overlay under a deterministic per-root slot (kind
 *      'record' — the composed store gate accepts a generic signed record), so a
 *      verifier that is not on the committee can still discover it. Best-effort:
 *      no reachable carrier ⇒ an honest no-op, exactly like §5 publish-on-write.
 * There is NO local ban shortcut here — this only publishes what the committee
 * already co-signed.
 */
async function publishPinFuse(root: string, fr: FuseRecord): Promise<void> {
  if (accountKv) {
    try {
      await accountKv.put(PIN_FUSE_PREFIX + root, fr as unknown as CanonicalObject)
    } catch {
      /* honest no-op — an over-budget/denied write is tolerated churn */
    }
  }
  const peer = getAccountPeer()
  if (peer) {
    try {
      await peer.overlay.put(fuseSlotKey(root), 'record', fr as unknown as CanonicalObject)
    } catch {
      /* honest no-op — no reachable carrier yet */
    }
  }
}

/** The deterministic overlay slot a root's §1 fuse row replicates under (kind
 *  'record'; domain-separated from every other per-root row). */
function fuseSlotKey(root: B64u): B64u {
  return toB64u(sha256(utf8(`pin-fuse-row:${root}`)))
}

/**
 * Land a countersigned §3 friend edge on OUR OWN witnessed lane (the M4 friend
 * write hook). Unlike a rated game the edge needs NO third-machine witness — its
 * authority is the peer's countersignature already carried in `payload` (the
 * mailbox consent handshake), so it lands in the honest 2-user case too. The
 * DEVICE key authors the event (the same key the M2 pairing/segment appends use,
 * keeping the head finalSync-signable); it rides the account's live single-writer
 * lane (the leaseRunner epoch is the fence a concurrent rated game already holds).
 * Advances the in-memory chain holder so the friends fold + the next pre-game
 * snapshot see it, persists it, and replicates it onto the §5 floor. Honest false
 * on any failure ⇒ the UI shows "writes when a witness is reachable" (no dead
 * button); the consent half was still mailed, so the peer can complete its side.
 */
async function appendFriendEdge(payload: FriendPayload, _peerRoot: string): Promise<boolean> {
  const signing = peerSigning ?? deviceSigningKey()
  const chain = ownChain
  if (!signing || !chain) return false
  // M5 §8: a friend edge is a witnessed-lane append — it must never precede an
  // owed self-ban. Honest false (the UI shows "writes when a witness is
  // reachable"); the consent half was already mailed, so the peer completes later.
  if ((await guardWitnessedAppend()).blocked) return false
  try {
    const next = appendWitnessed(chain, signing.priv, signing.key, 'friend', payload, Date.now())
    await keyring().saveChain(next.root, next)
    ownChain = next
    const peer = getAccountPeer()
    const head = witnessedHeadEventOf(next)
    if (peer && head) {
      try {
        await publishWitnessedWrite(peer.overlay, signing, next, head)
      } catch {
        /* honest — the floor catches up on the next final sync + repair */
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * Best-effort display-name resolution over the live overlay (viewer
 * reconstruction). Non-blocking + deduped/cached by the social client; a name
 * that does not resolve keeps the short-root label (never a fabricated handle).
 * Uses `view.name` (the root-signed genesis name), null when nothing verified.
 */
async function resolveName(root: string): Promise<string | null> {
  const peer = getAccountPeer()
  if (!peer) return null
  try {
    const res = await viewAccountForPeer(peer, root, { gamesLimit: 0 })
    const name = res.view.name ?? null
    return typeof name === 'string' && name.length > 0 ? name : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 10. M5 live anticheat — Tier-1 judge per rated game (Lane L-t1) + the
//     deterministic Tier-2 escalation / self-ban / verdict publish (Lane L-t2).
//     All guarded on a live peer + signing (a signed-out / casual game never
//     enters any of it) and every scarcity degrades to an honest no-op (§0/C-10);
//     a self-ban is grounded ONLY by the deterministic 5σ self-audit, never here.
// ---------------------------------------------------------------------------

/** OUR judged Tier1Records persist under a per-ROOT KV prefix (the account KV is a
 *  single shared IndexedDB, so rows are root-scoped exactly like the PIN records —
 *  a second account on the same device never reads the first's projection). */
const TIER1_RECORD_PREFIX = 'tier1-record|'
function tier1KeyPrefix(root: B64u): string {
  return `${TIER1_RECORD_PREFIX}${root}|`
}

/**
 * A rated 'segment' just LANDED for a game THIS instance played: run the pinned
 * canonical judge (a judge-dedicated Worker via newWebJudgeEngine) over the
 * finished game's SIGNED transcript to mint the per-game Tier1Record (Tier-1),
 * fold it into the trust-store projection, then run the deterministic Tier-2
 * escalation self-audit (which publishes the reproducible verdict row + appends
 * the §8 self-ban on a 5σ conviction). BOTH players run this independently on
 * their own instances over the SAME signed transcript, so the tier1Digest is
 * bit-identical across them — the §8 parity property. Serialized (judgeChain) so
 * two rapid finishes never run two Workers at once, and never throws: a rated
 * game that can't be judged degrades honestly; casual play never reaches here.
 */
async function afterRatedSegmentJudged(game: FinishedRatedGame): Promise<void> {
  // Cheap pre-gate: the pinned judge is standard chess only (runTier1ForGame
  // re-checks, but this avoids even queueing a Worker for a non-chess game).
  if (game.kind !== 'chess') return
  const run = judgeChain
    .then(() => judgeAndAudit(game))
    .catch((err) => console.warn('[account-net] tier-1 judge/audit error (ignored):', err))
  judgeChain = run
  await run
}

async function judgeAndAudit(game: FinishedRatedGame): Promise<void> {
  const peer = getAccountPeer()
  const signing = peerSigning ?? deviceSigningKey()
  if (!peer || !signing) return // signed out mid-flight — honest no-op
  const view: Tier1GameView = {
    gameKey: game.game,
    players: game.players,
    kind: game.kind,
    tc: game.tc,
    moves: game.moves,
  }
  // Tier-1: drive the pinned Worker over the bare-FEN verdict surface. Absent salt
  // block ⇒ Tier-1 only (the A5-17 window-salt / lifetime arm needs the canonical
  // witness set threaded from the lease + the per-window z assembly — deferred; its
  // absence only removes conviction PATHS, never grounds a false one).
  const res = await runTier1ForGame(view, {
    newJudgeEngine: newWebJudgeEngine,
    sink: recordTier1Signals,
    log: (m) => console.info(`[account-net] ${m}`),
  })
  if (!res.ok) {
    console.info(`[account-net] tier-1 no-op for ${game.game.slice(0, 8)}…: ${res.reason}`)
    return
  }
  // Feed Lane L-t2: the record is now in the projection, so re-run OUR
  // deterministic §8 escalation over the trailing-K window. A 5σ conviction
  // publishes the reproducible verdict row + appends the §8 self-ban FIRST.
  await getVerdictClient()?.runSelfAudit()
}

/** The Tier1Sink: fold the judged record into the trust-store projection (memory
 *  + KV) so the escalation trigger + the verdict re-verification read it. A
 *  persistence failure never fails the judge pass. */
function recordTier1Signals(signals: Tier1Signals): void {
  tier1Records.set(signals.gameKey, signals.record)
  void persistTier1Record(signals.gameKey, signals.record)
}

async function persistTier1Record(game: B64u, record: Tier1Record): Promise<void> {
  if (!accountKv || !peerRoot) return
  try {
    await accountKv.put(tier1KeyPrefix(peerRoot) + game, record as unknown as CanonicalObject)
  } catch {
    /* honest no-op — the in-memory projection still serves this session */
  }
}

/** Hydrate OUR persisted Tier1Records into the in-memory projection on sign-in,
 *  so the trailing-K escalation window is fully judged across restarts (a career's
 *  older games were judged in a prior session). Best-effort; a fresh account
 *  simply starts empty. */
async function hydrateTier1Records(root: B64u): Promise<void> {
  tier1Records.clear()
  if (!accountKv) return
  const prefix = tier1KeyPrefix(root)
  try {
    for (const e of await accountKv.entries(prefix)) {
      tier1Records.set(e.key.slice(prefix.length), e.value as unknown as Tier1Record)
    }
  } catch {
    /* honest — an unreadable store leaves the projection empty (fail-closed) */
  }
}

/**
 * Walk OUR chain through the TESTED a4 fold and, for each rated game, capture the
 * chain-derived strength ENTERING it — exactly the LadderGameRef the §8 trigger
 * consumes. Uses the fold's own seed-pinned `ladders` (the byte-identical floor
 * every verifier recomputes — NOT a per-roster vouched read, which would not
 * reproduce on an adopter) and the fold's `seen`-at-this-height rating rule, so
 * the rated set matches the fold with ZERO drift (mirrors ratingEvidenceOf). Pure
 * + total: an adversarial payload fails closed exactly where the fold does.
 */
function ladderGameRefsOf(chain: Chain): Map<string, LadderGameRef[]> {
  const byLadder = new Map<string, LadderGameRef[]>()
  const w = chain.events.filter((e) => e.body.lane === 'w').sort((a, b) => a.body.height - b.body.height)
  let s = a4Fold.init(chain.root)
  for (const ev of w) {
    const pre = s
    const s2 = a4Fold.step(s, ev)
    try {
      if (ev.body.type === 'segment') {
        const p = ev.body.payload as unknown as SegmentPayload
        // Rated exactly now ⇔ the fold recorded this game key AT this height.
        if (
          p.kind !== undefined &&
          p.tc !== undefined &&
          Object.prototype.hasOwnProperty.call(s2.seen, p.game) &&
          s2.seen[p.game] === ev.body.height
        ) {
          const lid = ladderId(p.kind, p.tc)
          const own = pre.ladders[lid] ?? ladderInit() // strength ENTERING the game
          const refs = byLadder.get(lid) ?? []
          refs.push({ game: p.game, side: p.color, elo: Math.trunc(own.r / 1_000_000), rdMicro: own.rd })
          byLadder.set(lid, refs)
        }
      }
    } catch {
      /* fold-parity: an adversarial payload never advances the ref list */
    }
    s = s2
  }
  return byLadder
}

/**
 * Build the chain-derived Tier-2 window inputs for each of OUR rated ladders (the
 * verdict client's `ladderAudits` seam). A ladder is audited ONLY when EVERY one
 * of its rated games is judged (a record in the projection): an unjudged rated
 * game makes the §8 check non-evaluable (unjudged is itself non-compliance, §8),
 * so we skip it as an honest no-op rather than feed a partial window (fail-closed).
 * Ladders below a full reganK window can never convict on the trailing-K arm (the
 * only arm wired today — the lifetime arm needs salted closed-window zs, deferred),
 * so they are skipped cheaply.
 */
function ourLadderAudits(): LadderAudit[] {
  const chain = ownChain
  const root = peerSigning?.root ?? peerRoot
  if (!chain || !root) return []
  const audits: LadderAudit[] = []
  for (const [ladder, games] of ladderGameRefsOf(chain)) {
    if (games.length < PARAMS_A5.reganK) continue
    const records = new Map<string, Tier1Record>()
    let fullyJudged = true
    for (const g of games) {
      const rec = tier1Records.get(g.game)
      if (!rec) {
        fullyJudged = false
        break
      }
      records.set(g.game, rec)
    }
    if (fullyJudged) audits.push({ root, ladder, games, records })
  }
  return audits
}

/** Rebuild a verdict record's window entries from OUR chain-derived refs + judged
 *  records — the adopt / suppression re-verification input. Null when we cannot
 *  reproduce the window (a game we did not judge), so the record is REJECTED, never
 *  adopted unverified (§0). Reproducible for a subject whose games WE judged (always
 *  true for OUR own self-audit rows). */
function entriesForOwnWindow(rec: Tier2VerdictRecord): readonly WindowEntry[] | null {
  const chain = ownChain
  if (!chain) return null
  const refs = ladderGameRefsOf(chain).get(rec.body.ladder)
  if (!refs) return null
  const refByGame = new Map(refs.map((r) => [r.game, r] as const))
  const entries: WindowEntry[] = []
  for (const g of rec.body.games) {
    const ref = refByGame.get(g)
    const t1 = tier1Records.get(g)
    if (!ref || !t1) return null
    entries.push(
      ref.rdMicro === undefined
        ? { rec: t1, side: ref.side, elo: ref.elo }
        : { rec: t1, side: ref.side, elo: ref.elo, rdMicro: ref.rdMicro },
    )
  }
  return entries
}

/** The set of ladders OUR chain already carries a folded self-ban for (the a4
 *  fold's `bans`) — so the verdict client never re-appends a self-ban a prior
 *  session already witnessed (restart-idempotent, A5-22). */
function foldSelfBanLadders(chain: Chain): Set<string> {
  const w = chain.events.filter((e) => e.body.lane === 'w').sort((a, b) => a.body.height - b.body.height)
  let s = a4Fold.init(chain.root)
  for (const ev of w) s = a4Fold.step(s, ev)
  return new Set(Object.keys(s.bans))
}

/** OUR verdict signer (the commend pattern): the account ROOT identity, signed by
 *  the live DEVICE key with the root-signed certs proving it (empty when the head
 *  is root-signed). Null when signed out. */
function verdictSignerOf(): VerdictSigner | null {
  const signing = peerSigning ?? deviceSigningKey()
  const chain = ownChain
  if (!signing || !chain) return null
  const certs = signing.key === signing.root ? [] : certsProving(signing.root, chain.events, [signing.key])
  return { root: signing.root, key: signing.key, priv: signing.priv, ...(certs.length > 0 ? { certs } : {}) }
}

/**
 * The §8 self-ban WITNESSED append seam the verdict client drives on a 5σ
 * conviction: acquire the live write lease (its canonical witness set), append the
 * schema-validated 'selfban' event under a non-player attestation (exactly like
 * the segment / pairing appends), advance + persist OUR chain, and replicate the
 * ban onto the §5 floor. A self-ban has NO game players, so ANY witness counts as
 * the required non-player attester. Honest failure (no peer / lease / reachable
 * witness) leaves the ban OWED — the verdict client keeps it pending and the §8
 * guard holds further witnessed writes until it lands (C-10). Never throws.
 */
async function appendSelfBanWitnessed(build: SelfBanBuild): Promise<{ ok: boolean; reason?: string }> {
  const peer = getAccountPeer()
  const signing = peerSigning ?? deviceSigningKey()
  const chain = ownChain
  const runner = leaseRunner
  if (!peer || !signing || !chain || !runner) return { ok: false, reason: 'no-account-peer' }
  const acq = await runner.acquire()
  if (!acq.ok) return { ok: false, reason: acq.reason }
  try {
    const res = await clientAppendWitnessed({
      fabric: peer.fabric,
      chain,
      lease: acq.lease,
      deviceKey: signing.key,
      devicePriv: signing.priv,
      type: 'selfban',
      payload: build.payload as unknown as CanonicalObject,
      ts: Date.now(),
      epoch: acq.epoch,
      witnessSet: acq.witnessSet,
      players: new Set<NodeId>(), // a self-ban has no game players — any witness is non-player
      minWitnesses: 1,
    })
    if (!res.ok) return { ok: false, reason: res.reason }
    await keyring().saveChain(res.chain.root, res.chain)
    ownChain = res.chain
    // §5 publish-on-write: replicate the just-anchored self-ban head immediately.
    void replicateWitnessedHead('selfban')
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    runner.release()
  }
}

/**
 * The periodic §8 self-audit + self suppression scan (the safety net for a ban
 * that had no reachable witness at game-over). Each tick re-runs the deterministic
 * escalation self-audit (retrying an owed self-ban + re-publishing the verdict
 * row) and runs suppressionScan over OUR OWN chain — surfacing a conviction whose
 * self-ban we never appended so the L-ui shows it honestly. Cheap when clear (a
 * fully-honest career assesses in one fold walk). Returns a stop handle.
 */
function startVerdictAuditCadence(): () => void {
  const tick = async (): Promise<void> => {
    const client = getVerdictClient()
    if (!client) return
    try {
      await client.runSelfAudit()
    } catch (err) {
      console.warn('[account-net] verdict self-audit tick error (ignored):', err)
      return
    }
    // Self suppression scan over the live overlay: fetch + adopt OUR published row
    // (judge-pinned, re-verified from our own inputs) and run the §8 chain-side
    // absence scan on OUR chain. Best-effort; a shortfall is an honest no-op.
    try {
      const chain = ownChain
      const root = peerSigning?.root ?? peerRoot
      if (!chain || !root) return
      const ev = await client.banEvidenceFor({
        subjectRoot: root,
        entriesFor: entriesForOwnWindow,
        chainEvents: chain.events,
      })
      if (ev.evidence && Object.values(ev.evidence.ladders).some((l) => l?.suppressed))
        console.warn('[account-net] verdict: self suppression detected — an owed §8 self-ban is missing from our chain')
    } catch {
      /* honest no-op */
    }
  }
  const timer = setInterval(() => void tick(), VERDICT_AUDIT_CADENCE_MS)
  return (): void => clearInterval(timer)
}

// M3 §5: a backgrounded tab throttles → it is about to look offline (§11), so
// leave the freshest chain in shard space on the way out. Guarded on a live peer
// (signed-out / no-peer = no-op); registered once, mirrors the presence keepalive.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void runFinalSync('tab-hidden')
  })
}
