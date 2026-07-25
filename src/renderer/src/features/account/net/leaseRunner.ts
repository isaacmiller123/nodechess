// A6 M2 — the LIVE write-lease lifecycle (spec §4 write lease, epochs, takeover).
//
// A witnessed-lane append (a 'pairing' before a rated game, a 'segment' after)
// is legal ONLY under a live lease: a record signed by a threshold T_lease of the
// account's canonical witness set, carrying a MONOTONIC epoch (the fencing token).
// The threshold intersection makes two valid overlapping-epoch leases impossible,
// so exactly one device writes at a time. This module is the client body that
// gathers + holds + renews that lease around one rated game, and enforces the
// single-writer discipline the spec names:
//
//   • acquire()  — probe the canonical set's current epoch (the `head` request),
//     gather grants at the right monotonic epoch via clientRequestLease (at
//     1-witness scale the threshold floors to 1 — C-10, honest degradation), and
//     hold the returned Lease. A FRESH account starts at epoch 1.
//   • heartbeat  — re-sign the SAME epoch with a fresh grantedWts every
//     leaseHeartbeatMs (a same-device renewal; verifyLease admits it, slash.ts
//     treats it as a crash-recovery renewal, never a double-grant), so the lease
//     never lapses mid-game.
//   • a SECOND device of the same account, seeing a different device holds the
//     current live lease, is refused 'playing-elsewhere' — the honest client
//     never grabs a conflicting same-epoch lease (that would be a slashable
//     same-epoch double-grant). It surfaces the wait instead of forking the lane.
//   • PIN-gated takeover — once the prior lease is dead (expiry frees takeover),
//     a different device acquires the NEXT epoch carrying a PIN-gated session
//     (types.ts PinSession, purpose 'lease-takeover', epoch-bound). verifyLease
//     admits a takeover only with a strictly higher epoch AND that session, so a
//     session captured at one epoch cannot be replayed at a later one.
//
// It COMPOSES the tested substrate — clientRequestLease / canonicalWitnessSet /
// pinSessionId (witness fabric), verifyLease + slash.adjudicate are the read-time
// judges the suite runs against — and re-implements no crypto. Platform-specific
// renderer hosting (it drives a live FabricEndpoint + a wall-clock heartbeat);
// `src/shared/accounts` stays pure. The fabric, chain view, clock and heartbeat
// timer are INJECTED so the whole lifecycle runs headless exactly as in the app.

import type { CanonicalObject } from '@shared/accounts/codec'
import type { B64u, Chain, SignedEvent } from '@shared/accounts/types'
import {
  PARAMS_A2,
  PARAMS_A2_DIGEST,
  canonicalWitnessSet,
  clientRequestLease,
  nodeIdOf,
} from '@shared/accounts/witness'
import type {
  ChainSummary,
  FabricEndpoint,
  Lease,
  LeaseParams,
  NodeId,
  SubjectSummary,
  TakeoverAuth,
} from '@shared/accounts/witness'

// ---------------------------------------------------------------------------
// Identity + dependencies
// ---------------------------------------------------------------------------

/** THIS device's signing identity — exactly `accounts.deviceSigningKey()`. */
export interface LeaseRunnerIdentity {
  /** Account root (b64u). `nodeId = sha256(root)`. */
  root: B64u
  /** Device signing child pubkey (the lease is granted TO this key). */
  key: B64u
  /** Device signing child private key. */
  priv: Uint8Array
}

export interface LeaseRunnerDeps {
  /** The live fabric endpoint (peerService in prod; a MockFabric endpoint in
   *  suites). Its `head` request probes the canonical set's current epoch; its
   *  `lease-grant` gathers grants. */
  fabric: FabricEndpoint
  /** THIS device's signing identity. */
  identity: LeaseRunnerIdentity
  /** THIS player's own account chain (re-read each acquire — a second device
   *  reads the SYNCED chain to see whose device wrote the current head). */
  chain: () => Chain
  /** Chain-derived witness summaries keyed by nodeId (peerService/overlay). Empty
   *  ⇒ small-population relaxation admits reachable witnesses (the 1-witness
   *  boundary, C-10). Default: empty. */
  summaries?: () => ReadonlyMap<NodeId, ChainSummary>
  /** The subject summary for eligibility (entanglement distance). Default: a
   *  minimal subject (no entangled roots) — correct for the small-population
   *  slice; M3 wires the real entanglement window. */
  subject?: () => SubjectSummary
  /** Wall clock (ms). Default Date.now. */
  now?: () => number
  /** Eligibility + threshold params. Default PARAMS_A2. */
  params?: LeaseParams
  /** Params digest embedded in the lease body. Default PARAMS_A2_DIGEST. */
  paramsDigest?: B64u
  /** Lease TTL ms. Default PARAMS_A2.leaseTtlMs. */
  ttlMs?: number
  /** Heartbeat-renew interval ms. Default PARAMS_A2.leaseHeartbeatMs. `<= 0`
   *  disables the internal timer — a headless suite drives `heartbeat()`. */
  heartbeatMs?: number
  /**
   * Mint a takeover session authorizing THIS device at `epoch`. Supplied by the
   * account layer, which knows the lane: a PIN-anchored account needs the user's
   * PIN (so this returns null and the UI prompts); an account with no PIN record
   * signs with the root key it already holds from sign-in.
   *
   * This is what makes SIGNING IN ON A SECOND DEVICE work. Without it acquire()
   * refuses forever with 'playing-elsewhere' — the first device holds the lane
   * and nothing can ever take it, so the second device can never append.
   * Returns null when no session can be minted unattended (the honest refusal).
   */
  mintTakeover?: (epoch: number) => Promise<TakeoverAuth | null>
  /** Diagnostics sink. */
  log?: (msg: string) => void
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** The current authoritative lease state, as the canonical set + the synced chain
 *  report it. `epoch` is the highest epoch a witness has admitted for the root
 *  (null ⇒ fresh account, no witnessed append yet); `writer` is the device key
 *  that authored the current witnessed head (null ⇒ only a genesis / no head). */
export interface LeaseStateView {
  epoch: number | null
  writer: B64u | null
  /** The head event's claimed ts (a coarse liveness hint for the UI). */
  headTs: number | null
}

export type AcquireResult =
  | { ok: true; lease: Lease; witnessSet: NodeId[]; epoch: number; takeover: boolean }
  | { ok: false; reason: AcquireFailReason; heldBy?: B64u; observedEpoch?: number }

/** 'playing-elsewhere' — a different device holds the live lease and no takeover
 *  was authorized (honest refusal, never a fork). 'insufficient-witnesses' — no
 *  reachable eligible witness granted (C-10 honest degradation: the rated button
 *  waits). Others surface a clientRequestLease reason verbatim. */
export type AcquireFailReason = 'playing-elsewhere' | 'insufficient-witnesses' | string

export interface AcquireOpts {
  /** A gated takeover of a dead / other-device lease (spec §4): advances the
   *  epoch and carries a session authorizing this device at that epoch (purpose
   *  'lease-takeover', epoch-bound). PIN-signed for accounts with an active PIN
   *  record, root-signed for those without. Without it, a different-device
   *  holder is refused. */
  takeover?: TakeoverAuth
  /** ADVERSARIAL ONLY (suites): bypass the playing-elsewhere guard and gather a
   *  lease at exactly this epoch/device, to prove a forced same-epoch double-grant
   *  is slashable. An honest client NEVER sets this. */
  forceEpoch?: number
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface LeaseRunner {
  /** Acquire (or resume) the live lease for the account, at the correct monotonic
   *  epoch. Idempotent while a live lease is held (returns it). */
  acquire(opts?: AcquireOpts): Promise<AcquireResult>
  /** Renew the held lease NOW (re-sign the same epoch, fresh grantedWts). Returns
   *  false when nothing is held or no witness granted. */
  heartbeat(): Promise<boolean>
  /** The epoch of the held lease, or null. Wired into the segment writer's append
   *  so a post-game 'segment' lands at the SAME fencing epoch as the pre-game
   *  'pairing' (a same-device renewal, non-stale at the witness). */
  currentEpoch(): number | null
  /** The held lease object, or null. */
  currentLease(): Lease | null
  /** The witness set the held lease was gathered from, or null. */
  currentWitnessSet(): NodeId[] | null
  /** Whether a live (non-expired) lease is currently held. */
  held(): boolean
  /** Probe the canonical set + synced chain for the current lease state (no
   *  mutation) — the UI reads this to render "playing elsewhere" honestly. */
  probe(): Promise<LeaseStateView>
  /** Drop the held lease + stop the heartbeat (game over / sign-out). Idempotent.
   *  The epoch high-water mark is retained so the next acquire never regresses. */
  release(): void
}

/**
 * Build the live write-lease runner for one signed-in device. The heartbeat timer
 * starts on the first successful `acquire()` and stops on `release()`; a headless
 * suite sets `heartbeatMs <= 0` and drives `heartbeat()` deterministically.
 */
export function createLeaseRunner(deps: LeaseRunnerDeps): LeaseRunner {
  const now = deps.now ?? ((): number => Date.now())
  const log = deps.log ?? ((): void => {})
  const params = deps.params ?? PARAMS_A2
  const paramsDigest = deps.paramsDigest ?? PARAMS_A2_DIGEST
  const ttlMs = deps.ttlMs ?? PARAMS_A2.leaseTtlMs
  const heartbeatMs = deps.heartbeatMs ?? PARAMS_A2.leaseHeartbeatMs
  const root = deps.identity.root
  const myKey = deps.identity.key

  const summariesOf = deps.summaries ?? ((): ReadonlyMap<NodeId, ChainSummary> => new Map())
  const subjectOf =
    deps.subject ??
    ((): SubjectSummary => ({
      root,
      nodeId: nodeIdOf(root),
      entangledRoots: new Set<string>(),
      secondDegreeRoots: new Set<string>(),
    }))

  let lease: Lease | null = null
  let witnessSet: NodeId[] | null = null
  let heldEpoch = 0 // monotonic high-water mark (survives release, never regresses)
  let takeoverAuth: TakeoverAuth | null = null // carried while a takeover epoch is held
  let timer: ReturnType<typeof setInterval> | null = null

  const expired = (l: Lease): boolean => now() >= l.body.grantedWts + l.body.ttlMs

  const startTimer = (): void => {
    if (timer || heartbeatMs <= 0) return
    timer = setInterval(() => {
      void heartbeat().catch((err) => log(`lease heartbeat error (ignored): ${String(err)}`))
    }, heartbeatMs)
  }
  const stopTimer = (): void => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  /** The highest-height witnessed-lane event = the current head (its `key` is the
   *  device that wrote it — how a second device sees another device is active). */
  function headEvent(chain: Chain): SignedEvent | null {
    let best: SignedEvent | null = null
    for (const ev of chain.events) {
      if (ev.body.lane !== 'w') continue
      if (!best || ev.body.height > best.body.height) best = ev
    }
    return best
  }

  /** Ask the canonical witness set for its cached head epoch; take the max any
   *  reachable witness reports (a lagging witness never lowers the fence). */
  async function probeHeadEpoch(): Promise<number | null> {
    const dir = deps.fabric.directory()
    const set = canonicalWitnessSet(subjectOf(), dir, summariesOf(), params, now())
    let max: number | null = null
    for (const w of set) {
      try {
        const res = await deps.fabric.request(w, 'head', { root } as unknown as CanonicalObject)
        const head = (res as unknown as { head?: { epoch?: number } }).head
        if (head && typeof head.epoch === 'number' && Number.isSafeInteger(head.epoch))
          max = Math.max(max ?? 0, head.epoch)
      } catch {
        // unreachable witness — skip (honest degradation)
      }
    }
    return max
  }

  async function probe(): Promise<LeaseStateView> {
    const epoch = await probeHeadEpoch()
    const head = headEvent(deps.chain())
    // Only a real witnessed append (height ≥ 1) names a lease writer; a bare
    // genesis (height 0) is not a lease record.
    const writer = head && head.body.height >= 1 ? head.body.key : null
    const headTs = head ? head.body.ts : null
    return { epoch, writer, headTs }
  }

  async function gather(epoch: number, takeover?: TakeoverAuth): Promise<AcquireResult> {
    const res = await clientRequestLease({
      fabric: deps.fabric,
      root,
      epoch,
      deviceKey: myKey,
      devicePriv: deps.identity.priv,
      grantedWts: now(),
      ttlMs,
      paramsDigest,
      subject: subjectOf(),
      summaries: summariesOf(),
      params,
      nowMs: now(),
      ...(takeover ? { takeover } : {}),
    })
    if (!res.ok) return { ok: false, reason: res.reason } // 'insufficient-witnesses' (C-10)
    lease = res.lease
    witnessSet = res.witnessSet
    heldEpoch = Math.max(heldEpoch, epoch)
    takeoverAuth = takeover ?? null
    startTimer()
    return { ok: true, lease: res.lease, witnessSet: res.witnessSet, epoch, takeover: takeover !== undefined }
  }

  /** A foreign holder whose witnessed head predates a full lease TTL cannot still
   *  hold a valid lease (verifyLease would call it expired), so takeover is free.
   *  headTs unknown ⇒ NOT stale: never guess a live holder dead. */
  function staleHolder(state: LeaseStateView): boolean {
    return state.headTs !== null && now() - state.headTs > ttlMs
  }

  async function acquire(opts?: AcquireOpts): Promise<AcquireResult> {
    // Idempotent: a live lease is reused (the "held at one epoch" steady state).
    if (lease && !expired(lease) && opts?.forceEpoch === undefined) {
      return { ok: true, lease, witnessSet: witnessSet ?? [], epoch: lease.body.epoch, takeover: takeoverAuth !== null }
    }

    // Adversarial force path (suites): gather at an exact epoch, no honest guard.
    if (opts?.forceEpoch !== undefined) {
      return gather(opts.forceEpoch, opts.takeover)
    }

    const state = await probe()

    // The live witnessed head was authored by a DIFFERENT device ⇒ that device
    // holds (or held) the current lease. Never grab a conflicting lease — a
    // same-epoch double-grant is slashable; the honest client waits.
    const foreignHolder = state.writer !== null && state.writer !== myKey
    if (foreignHolder) {
      const nextEpoch = Math.max(state.epoch ?? 0, heldEpoch) + 1
      let auth = opts?.takeover ?? null

      // "Expiry frees takeover" (§4). When the holder's lease is plainly DEAD —
      // its head is older than a full TTL — a second device may claim the lane
      // unattended, which is exactly the sign-in-elsewhere case. A LIVE holder is
      // still refused below: that is a real concurrent session, not a handoff.
      if (!auth && deps.mintTakeover && staleHolder(state)) {
        auth = await deps.mintTakeover(nextEpoch)
        if (auth) log(`lease takeover: holder's lease is stale, minting a ${auth.kind}-signed session`)
      }

      if (!auth) {
        log(`lease acquire refused: playing elsewhere (device ${state.writer!.slice(0, 8)}… holds epoch ${state.epoch})`)
        return { ok: false, reason: 'playing-elsewhere', heldBy: state.writer!, ...(state.epoch !== null ? { observedEpoch: state.epoch } : {}) }
      }

      // Advance to the next epoch and carry the session so verifyLease admits it
      // (strictly higher epoch + a session authorizing this device at THIS
      // epoch). The epoch fence + the session are the enforcement.
      log(`lease takeover: advancing to epoch ${nextEpoch} with a ${auth.kind}-signed session`)
      return gather(nextEpoch, auth)
    }

    // The canonical set reports an epoch my SYNCED chain does not show a head for
    // (writer null, epoch present): I am behind and cannot prove I am the current
    // writer, so I must not gather (it could double-grant against the real holder).
    // Refuse until synced (honest; M3 chain replication resolves it).
    if (state.epoch !== null && state.writer === null) {
      log(`lease acquire deferred: witnesses report epoch ${state.epoch} my chain has no head for — behind`)
      return { ok: false, reason: 'behind', observedEpoch: state.epoch }
    }

    // Fresh account (no witnessed append: epoch null) ⇒ epoch 1; or I AM the head
    // writer ⇒ a same-device renewal/continuation at the observed epoch — never
    // below my retained high-water mark (a witness that merely lost its cache
    // cannot roll the fence backward).
    const epoch = state.epoch === null ? Math.max(1, heldEpoch) : Math.max(state.epoch, heldEpoch)
    return gather(epoch)
  }

  async function heartbeat(): Promise<boolean> {
    if (!lease) return false
    const epoch = lease.body.epoch
    // A renewal is a same-device re-grant at the SAME epoch (never a takeover) —
    // the session is only needed to ACQUIRE a takeover epoch, not to hold it.
    const res = await gather(epoch)
    if (!res.ok) {
      log(`lease heartbeat failed: ${res.reason}`)
      return false
    }
    return true
  }

  return {
    acquire,
    heartbeat,
    currentEpoch: () => (lease ? lease.body.epoch : null),
    currentLease: () => lease,
    currentWitnessSet: () => witnessSet,
    held: () => lease !== null && !expired(lease),
    probe,
    release: () => {
      stopTimer()
      lease = null
      witnessSet = null
      takeoverAuth = null
    },
  }
}
