// MpNetSession: the one object that owns an internet game, host or guest side.
// PURE session/authority logic: it imports ONLY the isomorphic wire protocol, the
// shared types, the (type-erased + pure) time-control helper and the platform
// flag. NO trystero, NO electron, NO node, so it bundles standalone into the
// renderer and runs unchanged under bare node for tests. The actual signaling + WebRTC lives behind an injected
// MpTransport (see rtcTransport.ts).
//
// Roles & authority
//   HOST: creates the room; the join code IS the room key. The host is
//           AUTHORITATIVE: it owns the gameId, the monotonic clocks (per-move
//           timestamps, increment credit, flag on zero, lag compensation),
//           validates turn alternation, and relays the guest's moves. It accepts
//           the FIRST peer that appears; extras get a targeted error and are
//           otherwise ignored.
//   GUEST: joins by code and renders what the host tells it. It never runs an
//           authoritative clock. A guest hearing hello{role:'guest'} knows nobody
//           is hosting and fails immediately; no host at all within 30s → friendly
//           give-up.
//   WITNESS (wire v6, accounts spec §3): an optional THIRD, non-playing peer.
//           It announces itself by hello{role:'witness'} (never by presence); a
//           session that opted into signed play (opts.signing) seats exactly ONE
//           and the HOST mirrors the committed game stream to it; its wclk/wend
//           countersignatures are verified here and surface via onWitnessStream.
//           A second witness hello is refused with a targeted error; a session
//           with no signing config TOLERATES a witness hello and ignores it.
//           Signed play itself: both hellos carry root/key ⇒ the host mints the
//           game key (segment.ts), every move carries the mover's chained sig,
//           terminals carry an esig, and any bad/missing signature tears the
//           session down loudly (signed play never silently degrades).
//
// Perspective: every MpEvent is emitted from the RECEIVER's point of view
//   (`yourColor` is this client's color; `resign.by`/`flag.by` is who lost).
//
// Time base (D3): ALL elapsed measurement uses a monotonic clock (performance.now(),
//   injectable for tests). It excludes mac sleep, so a sleeping host charges no one.
//   Flag/abort watchdog callbacks NEVER trust timer punctuality: on fire they
//   recompute the remaining time from the monotonic base and re-arm for any residual.
//
// Failure policy: nothing here throws to the caller. host()/join() resolve; every
//   other failure (bad code, no host, version mismatch, peer gone, malformed
//   traffic, illegal/out-of-turn move) surfaces as an MpEvent and tears down.

import type { MpEvent, MpGameConfig, MpColor, MpClocks, MpByo } from '@shared/types'
import {
  type WireMsg,
  type HelloMsg,
  parseWireMsg,
  encodeWireMsg,
  makeHello,
  sanitizeName,
  PROTOCOL_VERSION,
  generateRoomCode,
  normalizeRoomCode
} from '@shared/mp/wire'
import { MoveChainVerifier, sigClock, ladderFromConfig, REASON_FLAG, REASON_RESIGN } from '@shared/mp/witnessCore'
import {
  gameKey as computeGameKey,
  signMove,
  signWitnessEnd,
  transcriptDigest,
  witnessClockBytes,
  verifyWitnessEnd,
  type GameKeySeed,
  type SignedMove
} from '@shared/accounts/segment'
import { toB64u, verifySigB64u } from '@shared/accounts/hash'
import { isWebBuild } from '../../../platform'
import { timeControlCategory, type TimeControl } from '../timeControl'
import {
  afterMoveCredit,
  consumeElapsed,
  freshSideClock,
  normalizeByoyomi,
  totalBudgetMs,
  type ByoyomiSpec,
  type SideClock
} from '../byoyomi'

export type MpRole = 'host' | 'guest'

/** Host-side legality seam (wire v4): the session itself relays OPAQUE move
 *  strings and knows NO game rules. The store registers a validator backed by
 *  the game kernel; the session consults it before committing a GUEST move.
 *  `moves` is the committed move list so far (the position is derivable from
 *  it); return false to silently drop the move (same as an out-of-turn move).
 *  Default (nothing registered) = accept, preserving pre-v4 behavior. */
export type MpMoveValidator = (moves: readonly string[], move: string) => boolean

// ---- Injected transport contract (implemented by rtcTransport.ts) -------------

export interface MpTransportListeners {
  onMessage(text: string, fromPeer: string): void
  onPeerJoin(peerId: string): void
  onPeerLeave(peerId: string): void
  /** Optional relay-connectivity ticks: how many signaling relays are open. */
  onRelayStatus?(connected: number, total: number): void
  /** A queued send failed (dead/closed channel). The session treats it like
   *  heartbeat trouble (suspend path), never an unhandled rejection (T6). */
  onSendError?(err: unknown): void
}

export interface MpTransport {
  /** Send wire text to a specific peer, or broadcast to the room if omitted. */
  send(text: string, toPeer?: string): void
  /** Stop the relay-connectivity poll early (once handshaken; T8). Optional so a
   *  minimal/test transport need not implement it. */
  stopRelayPoll?(): void
  close(): void
  /** Resolves once the underlying room has fully left, so a same-code rejoin can
   *  await settle before re-creating the transport (T7). Optional. */
  closed?: Promise<void>
}

export type MpTransportFactory = (
  roomCode: string,
  listeners: MpTransportListeners
) => MpTransport | Promise<MpTransport>

// ---- Timing constants ---------------------------------------------------------
// Grouped into one mutable MP_TIMING record (production defaults below). They live
// on an object rather than as bare `const`s for exactly ONE reason: the headless
// suite (scripts/test-mp.mjs) must shrink the multi-second watchdog windows to a
// few ms so it can exercise the abort/flag/handshake/discovery/heartbeat timers
// deterministically instead of sleeping tens of seconds. `__setMpTimingForTests`
// is the ONLY writer; production code never mutates it and reads the same fields.

export interface MpTimingConfig {
  /** How long the guest waits to discover the host before giving up (ms). */
  DISCOVERY_TIMEOUT_MS: number
  /** Host: after bonding a peer on presence, unbond if no valid hello lands within
   *  this window and accept the next peer (L8). */
  HANDSHAKE_WATCHDOG_MS: number
  /** First-move grace: the first mover must move within this of start, and the
   *  replier within this of that first move, else the game aborts (D1/MP-03).
   *  (Who moves first is config.game.firstMover; white when absent, chess.) */
  FIRST_MOVE_ABORT_MS: number
  /** Heartbeat cadence: send a ping this often once handshaken. */
  HEARTBEAT_MS: number
  /** Declare the peer away only after this much silence AND two failed evals (D4). */
  PEER_SILENCE_MS: number
  /** Max lag forgiven per guest move debit (D11). */
  MAX_LAG_FORGIVE_MS: number
  /** Reconnect grace by speed category (MP-06). */
  GRACE_BY_CATEGORY: Record<string, number>
}

/** Production timing defaults. Mutated ONLY by __setMpTimingForTests (tests). */
const MP_TIMING: MpTimingConfig = {
  DISCOVERY_TIMEOUT_MS: 30_000,
  HANDSHAKE_WATCHDOG_MS: 15_000,
  FIRST_MOVE_ABORT_MS: 30_000,
  HEARTBEAT_MS: 5_000,
  PEER_SILENCE_MS: 15_000,
  MAX_LAG_FORGIVE_MS: 250,
  GRACE_BY_CATEGORY: {
    Bullet: 20_000,
    Blitz: 30_000,
    Rapid: 45_000,
    Classical: 60_000,
    Unlimited: 45_000
  }
}

/** TEST-ONLY: shallow-merge overrides into MP_TIMING so the headless suite can
 *  shrink watchdog windows without a real 30s wait. Never called in production. */
export function __setMpTimingForTests(overrides: Partial<MpTimingConfig>): void {
  Object.assign(MP_TIMING, overrides)
}

/** The friendly message shown when nobody is hosting the entered code. */
const NO_HOST_MESSAGE =
  "Nobody's hosting with that code right now. Double-check it, and make sure " +
  'your opponent still has their game open.'

type Clocks = MpClocks

/** v6 witness→player stream messages surfaced via onWitnessStream. */
export type MpWitnessMsg = Extract<WireMsg, { t: 'wclk' } | { t: 'wend' }>

/** v6 signed play (spec §3). When set, our hello carries root/key; a game
 *  becomes SIGNED only when BOTH sides did. All shipped callers omit it. */
export interface MpSigningConfig {
  /** ed25519 device signing private key (raw 32 bytes). */
  priv: Uint8Array
  /** b64u public signing key: what our move/terminal signatures verify against. */
  key: string
  /** b64u account root, sent in hello and bound into the game key. */
  root: string
  /** Optional pin: refuse any opponent whose hello identity isn't this root. */
  oppRoot?: string
}

export interface MpSessionOptions {
  /** Monotonic time source (ms). Defaults to performance.now(). Injected in tests. */
  now?: () => number
  /** v6 signed play + witness admission. ABSENT (every current caller) ⇒ the
   *  session behaves byte-for-byte like v5 apart from hello.v. */
  signing?: MpSigningConfig
}

export class MpNetSession {
  private readonly makeTransport: MpTransportFactory
  private readonly now: () => number
  private transport: MpTransport | null = null
  /** The `closed` promise of the transport we most recently tore down, so a
   *  same-code rejoin can await the room's full settle before re-creating one (T7). */
  private pendingClose: Promise<void> | null = null

  private role: MpRole | null = null
  private config: MpGameConfig | null = null
  /** Our display name (sanitized), sent in hello/start. */
  private myName: string | undefined
  /** The peer's display name, learned from their hello. */
  private peerName: string | undefined
  /** This client's own color, resolved at start. */
  private myColor: MpColor | null = null

  /** The single bonded peer id (host: the accepted guest; guest: the host). */
  private peerId: string | null = null
  /** A peer we suspended on (peer-away): its traffic is dropped except hello, and
   *  a rebond from the SAME id resumes rather than restarts (T3/T2). */
  private ghostPeerId: string | null = null
  /** True once the peer's hello has been validated (both sides). */
  private handshaked = false

  // ---- authoritative game state ----------------------------------------------
  /** Host-owned game id: monotonic per session, starts 1, +1 per rematch. Guest
   *  adopts the host's value. In-game wire messages carry it; mismatches drop. */
  private gameId = 0
  /** Which color the GUEST plays (host color is the opposite). */
  private guestColor: MpColor | null = null
  /** Authoritative remaining time per side (host only). With byo-yomi, a side
   *  still on main time reads main-ms; once in byo-yomi it reads the CURRENT
   *  period's remaining ms (see byoState). */
  private clocks: Clocks = { white: 0, black: 0 }
  /** v5 byo-yomi snapshot (periods left + inByo per side), or null for plain
   *  Fischer. Host-authoritative; the guest mirrors whatever rides the wire. */
  private byoState: MpByo | null = null
  /** Whose move it is right now. null before start / after game end. */
  private toMove: MpColor | null = null
  /** Monotonic time (ms) when the side-to-move's clock started ticking. 0 while
   *  the clock is IDLE (before white's first move, or paused during suspend). */
  private turnStartedAt = 0
  /** 0-based half-move count committed so far (both sides track it). */
  private plyCount = 0
  /** Full move list (UCIs from startpos), host keeps it for resync. */
  private moves: string[] = []
  /** True once the game is decided, further clock math and relays are suppressed. */
  private over = false
  /** True while a game is live and undecided (drives suspend eligibility). */
  private inGame = false

  /** Flag-fall watchdog for the side currently on move (host only). */
  private flagTimer: ReturnType<typeof setTimeout> | null = null
  /** First-move abort watchdog (host only). */
  private abortTimer: ReturnType<typeof setTimeout> | null = null
  /** Host handshake watchdog (unbond a silent peer). */
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null

  // ---- draw-offer bookkeeping ------------------------------------------------
  private incomingDrawOffer = false
  private outgoingDrawOffer = false
  /** Ply before which the given side may not (re-)offer a draw. Host-enforced:
   *  no offers before ply 2; +20 plies after a decline for the declined side. */
  private drawBlockedUntilPly: Record<MpColor, number> = { white: 0, black: 0 }

  // ---- rematch bookkeeping (symmetric) ---------------------------------------
  private myRematchOffer = false
  private peerRematchOffer = false

  // ---- suspend / resume ------------------------------------------------------
  /** When set, the game is paused waiting for the ghost peer to rebond. */
  private suspended = false
  /** Grace-expiry timer while suspended. */
  private graceTimer: ReturnType<typeof setTimeout> | null = null

  // ---- heartbeat + discovery timers ------------------------------------------
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null
  /** Last time we heard ANY message from the bonded peer (monotonic). */
  private lastPeerMsgAt = 0
  /** Last time our own heartbeat tick fired (monotonic), self-stall detector. */
  private lastTickAt = 0
  /** Consecutive failed heartbeat evaluations (two-strike rule). */
  private missedEvals = 0
  /** Rolling round-trip estimate (ms) from timestamped ping/pong. */
  private rtt = 0

  // ---- v6 signed play + the witness seat --------------------------------------
  /** Our signing identity, or null (unsigned, every shipped caller). Set at
   *  construction (opts.signing) OR additively via configureSigning() before a
   *  host()/join(); frozen for the duration of a live game (see the guard). */
  private signing: MpSigningConfig | null
  /** Peer identity from its hello (present ⇒ it offers signed play). */
  private peerRoot: string | null = null
  private peerKey: string | null = null
  /** The single seated witness: peer id + identity from its hello. */
  private witnessPeerId: string | null = null
  private witnessRoot: string | null = null
  private witnessKey: string | null = null
  /** Host-minted global game key + player roots by color (signed games only). */
  private gameKey: string | null = null
  private gamePlayers: { w: string; b: string } | null = null
  /** Interleaved move-sig chain tracker; non-null IS the "signed game" flag. */
  private chain: MoveChainVerifier | null = null
  /** Guest only: true while our last move is signed into the chain optimistically
   *  but not yet confirmed by the host's authoritative clock ack. If the host
   *  instead flags US on that move, it never entered the host/witness transcript,
   *  so we roll it back (else our getSignedGame() diverges from the wstream). */
  private guestMoveUnacked = false

  // ---- event fan-out ----------------------------------------------------------
  private listeners = new Set<(ev: MpEvent) => void>()
  /** v6: verified witness wclk/wend fan-out (A6 builds segments from these). */
  private witnessListeners = new Set<(msg: MpWitnessMsg) => void>()

  /** Registered host-side move validator (kernel seam). null = accept all. */
  private moveValidator: MpMoveValidator | null = null

  constructor(makeTransport: MpTransportFactory, opts: MpSessionOptions = {}) {
    this.makeTransport = makeTransport
    this.signing = opts.signing ?? null
    this.now =
      opts.now ??
      (typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? () => performance.now()
        : () => Date.now())
  }

  /** Register the host-side move validator (kernel seam, wire v4). The store
   *  registers a game-kernel-backed check; the session calls it before
   *  committing a GUEST move. null (or never called) = accept everything, so
   *  behavior without a registered kernel is identical to pre-v4. Survives
   *  resetState(), registration lifetime belongs to the registrant, like
   *  event listeners (L1). */
  setMoveValidator(fn: MpMoveValidator | null): void {
    this.moveValidator = fn
  }

  /** Subscribe to session events; returns the unsubscriber. */
  onEvent(cb: (ev: MpEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** v6: subscribe to VERIFIED witness stream messages (wclk/wend). Fires only
   *  in signed games with a seated witness; absence is fine (unsigned play).
   *  Same lifetime rule as onEvent (L1): survives resetState(). */
  onWitnessStream(cb: (msg: MpWitnessMsg) => void): () => void {
    this.witnessListeners.add(cb)
    return () => this.witnessListeners.delete(cb)
  }

  /** v6: the seated witness's identity (A6 segment building), or null. */
  getWitnessIdentity(): { root: string; key: string } | null {
    return this.witnessRoot && this.witnessKey ? { root: this.witnessRoot, key: this.witnessKey } : null
  }

  /** v6: this game's signed-play material (A6 segment building), or null for
   *  unsigned games. `moves` is the verified interleaved SignedMove chain. */
  getSignedGame(): { gameKey: string; players: { w: string; b: string }; moves: readonly SignedMove[] } | null {
    if (!this.chain || !this.gameKey || !this.gamePlayers) return null
    return { gameKey: this.gameKey, players: { ...this.gamePlayers }, moves: this.chain.moves }
  }

  /** v6 (A6 Lane C): set or clear the signed-play identity. ADDITIVE: a caller
   *  that never touches it stays byte-for-byte v5 (signing null ⇒ no identity in
   *  hello, no move sig). Casual play passes `null` to guarantee no stale rated
   *  identity leaks into an unsigned game.
   *
   *  GUARDED to pre-host()/join(): the identity is frozen while a game is live
   *  (`inGame`), so a running signed game's key/players/chain can never change
   *  under it. Call it BEFORE host()/join(); a mid-game call is a safe no-op
   *  (the session never throws to the caller). The per-game signed state
   *  (peerRoot/gameKey/chain) still resets each game via beginGame/resetState;
   *  this only sets OUR standing identity, read at setupSignedGame/hello time. */
  configureSigning(cfg: MpSigningConfig | null): void {
    if (this.inGame) return // frozen mid-game: set signing before host()/join()
    this.signing = cfg
  }

  private emitEvent(ev: MpEvent): void {
    for (const cb of this.listeners) cb(ev)
  }

  // ============================================================================
  // HOST
  // ============================================================================

  /** Create the room; resolves with the join code as soon as the transport is up.
   *  The host then waits indefinitely for a guest. */
  async host(cfg: MpGameConfig, name?: string): Promise<{ code: string }> {
    this.teardownTransport()
    this.resetState()
    await this.awaitPreviousClose()
    this.role = 'host'
    this.config = cfg
    this.myName = sanitizeName(name)
    const code = generateRoomCode()
    this.transport = await this.makeTransport(code, this.transportListeners())
    return { code }
  }

  // ============================================================================
  // GUEST
  // ============================================================================

  /** Join a room by code. Resolves {ok:true} once the transport is up (bad codes
   *  resolve {ok:false} without creating one); never rejects. A missing host
   *  surfaces later as an 'error' event via the discovery timeout. */
  async join(code: string, name?: string): Promise<{ ok: boolean; error?: string }> {
    const normalized = normalizeRoomCode(code)
    if (!normalized) {
      return { ok: false, error: 'That code is not valid. Double-check the characters.' }
    }
    this.teardownTransport()
    this.resetState()
    await this.awaitPreviousClose()
    this.role = 'guest'
    this.myName = sanitizeName(name)
    this.transport = await this.makeTransport(normalized, this.transportListeners())
    // We're contacting relays; the transport reports counts as they connect.
    this.emitEvent({ type: 'net', state: 'relays' })
    // Give up if no host answers within the discovery window.
    this.discoveryTimer = setTimeout(() => {
      this.fail(NO_HOST_MESSAGE)
    }, MP_TIMING.DISCOVERY_TIMEOUT_MS)
    return { ok: true }
  }

  // ============================================================================
  // Outbound actions (called by the UI on behalf of the local player)
  // ============================================================================

  /** Send OUR move to the peer. On the host this is authoritative (updates clocks
   *  and relays); on the guest it's a request the host will time and relay back.
   *  Blocked while suspended (the store also freezes the board). */
  async sendMove(uci: string): Promise<{ ok: boolean }> {
    if (!this.peerId || this.over || this.suspended) return { ok: false }
    // A move answers any pending draw exchange (offer withdrawn / declined).
    this.incomingDrawOffer = false
    this.outgoingDrawOffer = false

    if (this.role === 'host') {
      // We're the authority: apply our own move to the clocks and relay it.
      if (!this.myColor || this.toMove !== this.myColor) return { ok: false } // not our turn
      const ply = this.plyCount
      const clocks = this.commitMove(this.myColor, uci, 0)
      if (!clocks) return { ok: false } // flagged during commit, handled inside
      const byo = this.byoSnapshot()
      // v6: in a signed game our move carries our sig over the exact wire clocks.
      const sig = this.signOwnMove(ply, uci, clocks)
      const msg: WireMsg = {
        t: 'move',
        gameId: this.gameId,
        ply,
        uci,
        clockMs: clocks,
        ...(byo ? { byo } : {}),
        ...(sig ? { sig } : {})
      }
      this.sendWire(msg)
      this.sendWitness(msg)
      return { ok: true }
    }

    // Guest: it must be our turn (the host re-validates, but gate locally so our
    // ply bookkeeping stays honest for the next host move / a resumeReq).
    if (!this.myColor || this.toMove !== this.myColor) return { ok: false }
    // Hand the move to the host (clockMs is a courtesy hint it ignores; it recomputes
    // authoritatively). Record it locally + advance our ply/turn OPTIMISTICALLY so
    // the host's next relayed move isn't dropped as out-of-order; the host's `clock`
    // ack corrects our clocks. The store rolls the board back if this returns false.
    // v6: a signed guest signs over the clock snapshot it SENDS (its claim; the
    // host's authoritative clocks ride the 'clock' ack as always).
    const clockMs = { ...this.clocks }
    const sig = this.signOwnMove(this.plyCount, uci, clockMs)
    // v6: the move is signed into our chain optimistically; mark it unconfirmed
    // until the host's 'clock' ack lands. If a flag on us arrives first, we roll
    // it back (see applyFlag). null sig ⇒ unsigned game, nothing to reconcile.
    if (sig) this.guestMoveUnacked = true
    this.sendWire({ t: 'move', gameId: this.gameId, ply: this.plyCount, uci, clockMs, ...(sig ? { sig } : {}) })
    this.recordMove(uci)
    this.toMove = this.myColor === 'white' ? 'black' : 'white'
    return { ok: true }
  }

  async resign(): Promise<{ ok: boolean }> {
    if (!this.peerId || this.over || !this.myColor || !this.inGame) return { ok: false }
    const gid = this.gameId
    // v6: countersign our own loss (rage-quit denial, §3) before ending.
    const esig = this.signTerminal(this.myColor === 'white' ? '0-1' : '1-0', REASON_RESIGN)
    this.endGame()
    const msg: WireMsg = { t: 'resign', gameId: gid, by: this.myColor, ...(esig ? { esig } : {}) }
    this.sendWire(msg)
    this.sendWitness(msg)
    this.emitEvent({ type: 'resign', by: this.myColor })
    return { ok: true }
  }

  async offerDraw(): Promise<{ ok: boolean }> {
    if (!this.peerId || this.over || !this.myColor || this.suspended || !this.inGame) {
      return { ok: false }
    }
    // If the peer already offered, offering back = accepting.
    if (this.incomingDrawOffer) return this.acceptDraw()
    // Gate: no offers before ply 2, and none until our post-decline cooldown lapses.
    if (this.plyCount < 2) return { ok: false }
    if (this.plyCount < this.drawBlockedUntilPly[this.myColor]) return { ok: false }
    // Idempotent: a second offer while one is outstanding is a no-op (still ok).
    if (this.outgoingDrawOffer) return { ok: true }
    this.outgoingDrawOffer = true
    this.sendWire({ t: 'drawOffer', gameId: this.gameId })
    return { ok: true }
  }

  async acceptDraw(): Promise<{ ok: boolean }> {
    if (!this.peerId || this.over || !this.incomingDrawOffer) return { ok: false }
    this.incomingDrawOffer = false
    const gid = this.gameId
    // v6: countersign the draw for the witness BEFORE ending (null in unsigned
    // games, so the v5 drawAccept dance below stays byte-identical). The witness
    // gets a signed 1/2-1/2 terminal so it CLOSES (tick stops → no phantom
    // flag over an agreed draw); the full witnessed-draw record needs both
    // sides' esigs, delivered once A6 builds the two-sided witness feed path.
    const esig = this.signTerminal('1/2-1/2', 'agreement')
    this.endGame()
    this.sendWire({ t: 'drawAccept', gameId: gid })
    if (esig) this.sendWitness({ t: 'gameOver', gameId: gid, result: '1/2-1/2', reason: 'agreement', esig })
    this.emitEvent({ type: 'drawAccept' })
    return { ok: true }
  }

  async declineDraw(): Promise<{ ok: boolean }> {
    if (!this.peerId || this.over || !this.incomingDrawOffer) return { ok: false }
    this.incomingDrawOffer = false
    // The offerer (the peer) must wait a cooldown before re-offering. Host owns
    // the ledger; a guest's decline is enforced when the host receives drawOffer.
    const offerer: MpColor = this.myColor === 'white' ? 'black' : 'white'
    this.drawBlockedUntilPly[offerer] = this.plyCount + 20
    this.sendWire({ t: 'drawDecline', gameId: this.gameId })
    this.emitEvent({ type: 'drawDecline' })
    return { ok: true }
  }

  /** Board-terminal ending detected by the store (checkmate/stalemate/insufficient/…).
   *  The session ends the game, stops clocks, and tells the peer (D7). Spec API:
   *  mp.gameEnded(result, reason). */
  async gameEnded(result: '1-0' | '0-1' | '1/2-1/2', reason: string): Promise<{ ok: boolean }> {
    if (!this.peerId || this.over || !this.inGame) return { ok: false }
    const gid = this.gameId
    const esig = this.signTerminal(result, reason) // v6 terminal countersignature
    this.endGame()
    const msg: WireMsg = { t: 'gameOver', gameId: gid, result, reason, ...(esig ? { esig } : {}) }
    this.sendWire(msg)
    this.sendWitness(msg)
    this.emitEvent({ type: 'gameOver', gameId: gid, result, reason })
    return { ok: true }
  }

  /** Manual abort while the game hasn't really begun (plyCount < 2). No result. */
  async abort(): Promise<{ ok: boolean }> {
    if (!this.peerId || this.over || !this.inGame || this.plyCount >= 2) return { ok: false }
    const gid = this.gameId
    this.endGame()
    const msg: WireMsg = { t: 'abort', gameId: gid, reason: 'manual' }
    this.sendWire(msg)
    this.sendWitness(msg) // v6: close the witness's view (host-originated abort)
    this.emitEvent({ type: 'abort', gameId: gid, reason: 'manual' })
    return { ok: true }
  }

  async offerRematch(): Promise<{ ok: boolean }> {
    if (!this.peerId || !this.over) return { ok: false }
    this.myRematchOffer = true
    // Tell the peer we want a rematch (both roles send the same offer).
    this.sendWire({ t: 'rematchOffer' })
    // The host starts the game only once BOTH sides have offered.
    if (this.role === 'host' && this.peerRematchOffer) this.startRematchAsHost()
    return { ok: true }
  }

  async declineRematch(): Promise<{ ok: boolean }> {
    if (!this.peerId) return { ok: false }
    this.myRematchOffer = false
    this.peerRematchOffer = false
    this.sendWire({ t: 'rematchDecline' })
    this.emitEvent({ type: 'rematchDecline' })
    return { ok: true }
  }

  /** Grace expired and the local player claims the win (opponent left). Host-only
   *  in effect (only the still-present side calls it). Emits gameOver with reason
   *  'opponent left' and sends it best-effort (the peer is likely gone). */
  async claimVictory(): Promise<{ ok: boolean }> {
    if (this.over || !this.myColor || !this.inGame) return { ok: false }
    const gid = this.gameId
    const result: '1-0' | '0-1' = this.myColor === 'white' ? '1-0' : '0-1'
    this.endGame()
    // Best-effort: the ghost is probably gone, but a straggler should still hear it.
    this.sendGhost({ t: 'gameOver', gameId: gid, result, reason: 'opponent left' })
    this.emitEvent({ type: 'gameOver', gameId: gid, result, reason: 'opponent left' })
    return { ok: true }
  }

  /** Tear everything down. Idempotent; safe before host()/join(). Sends a polite
   *  'bye' first when connected so the peer gets a clean 'peer-left'. MUST NOT
   *  clear event listeners, subscription lifetime belongs to the subscriber (L1). */
  leave(): void {
    if (this.peerId) {
      // Best-effort goodbye; the transport swallows a send after close.
      this.sendWire({ t: 'bye' })
    }
    this.teardownTransport()
    this.resetState()
  }

  // ============================================================================
  // Transport wiring
  // ============================================================================

  private transportListeners(): MpTransportListeners {
    return {
      onMessage: (text, fromPeer) => this.onRaw(text, fromPeer),
      onPeerJoin: (id) => this.onPeerJoin(id),
      onPeerLeave: (id) => this.onPeerLeave(id),
      onSendError: (err) => this.onSendError(err),
      onRelayStatus: (connected, total) => {
        // Relay-status 'net' events only while we haven't handshaked (T8).
        if (this.handshaked) return
        this.emitEvent({ type: 'net', state: 'relays', relays: { connected, total } })
        // Guest: once at least one relay is open we're actively searching for the
        // host. (Harmless if emitted repeatedly; the UI just shows "searching".)
        if (this.role === 'guest' && !this.peerId && connected > 0) {
          this.emitEvent({ type: 'net', state: 'searching' })
        }
      }
    }
  }

  /** A peer appeared in the room. Bond to the first; refuse the rest (unless it's
   *  the ghost rebonding, which trystero re-pairs with the same id, T2). */
  private onPeerJoin(id: string): void {
    // Ghost rebond: the SAME peer we suspended on came back. Re-adopt it and let
    // the resume handshake run; do NOT restart the game.
    if (this.suspended && id === this.ghostPeerId) {
      this.rebond(id)
      return
    }
    if (this.peerId) {
      // Already have our one opponent: politely refuse extras (targeted).
      if (this.role === 'host') {
        this.transport?.send(encodeWireMsg({ t: 'error', message: 'host is busy' }), id)
      }
      return
    }
    // A brand-new peer arriving while a game is suspended: the seat is taken.
    if (this.suspended && this.role === 'host') {
      this.transport?.send(encodeWireMsg({ t: 'error', message: 'game in progress' }), id)
      return
    }
    this.peerId = id
    this.lastPeerMsgAt = this.now()
    // Peer found: the hello handshake / WebRTC is now in flight.
    if (this.role === 'guest') this.emitEvent({ type: 'net', state: 'connecting' })
    // Host arms a handshake watchdog: unbond a peer that never says a valid hello.
    if (this.role === 'host') this.armHandshakeWatchdog()
    // Both sides greet immediately; the game starts once the peer's hello lands.
    this.sendWire(this.makeOurHello())
  }

  /** A peer left the room. Only the bonded (or ghost) peer matters. */
  private onPeerLeave(id: string): void {
    // v6: the witness leaving frees its seat; the game itself is untouched.
    if (id === this.witnessPeerId) {
      this.witnessPeerId = null
      this.witnessRoot = null
      this.witnessKey = null
      return
    }
    if (id === this.peerId) this.onPeerGone()
    // A ghost fully leaving the room is fine, the grace timer still governs.
  }

  private onSendError(err: unknown): void {
    // A dead channel is heartbeat trouble: enter the suspend/away path rather than
    // letting the rejection go unhandled (T6). Ignore before/after a live game.
    void err
    if (!this.inGame || this.suspended || this.over) return
    this.enterSuspend()
  }

  private makeOurHello(): WireMsg {
    return makeHello(
      this.role === 'host' ? 'host' : 'guest',
      this.myName,
      undefined,
      // v6: offer our signing identity when configured (absent = exactly v5).
      this.signing ? { root: this.signing.root, key: this.signing.key } : undefined
    )
  }

  private sendWire(msg: WireMsg): void {
    if (!this.transport || !this.peerId) return
    this.transport.send(encodeWireMsg(msg), this.peerId)
  }

  /** v6: mirror a wire message to the seated witness. HOST only, the host is
   *  the authority, so the witness follows ONE consistent committed stream
   *  (the guest's terminals reach it via the host's forward in onRaw). */
  private sendWitness(msg: WireMsg): void {
    if (this.role !== 'host' || !this.transport || !this.witnessPeerId) return
    this.transport.send(encodeWireMsg(msg), this.witnessPeerId)
  }

  /** Best-effort send to the ghost peer id (used when claiming a left game). */
  private sendGhost(msg: WireMsg): void {
    const target = this.peerId ?? this.ghostPeerId
    if (!this.transport || !target) return
    this.transport.send(encodeWireMsg(msg), target)
  }

  // ============================================================================
  // Inbound: translate one wire message into events / drive host authority
  // ============================================================================

  protected onRaw(text: string, fromPeer: string): void {
    const msg: WireMsg | null = parseWireMsg(text)
    if (!msg) {
      // Only complain about garbage from our bonded peer; ignore strangers.
      if (!this.peerId || fromPeer === this.peerId) {
        this.emitEvent({ type: 'error', message: 'malformed message from peer' })
      }
      return
    }
    // While suspended, drop ALL ghost traffic except a hello (which re-bonds).
    if (this.suspended && fromPeer === this.ghostPeerId && msg.t !== 'hello') return
    // v6: the seated witness is a legitimate third peer. Its stream messages
    // (wclk/wend) are verified + surfaced here; everything else it says except
    // a hello is dropped, a witness is never a game participant.
    if (this.witnessPeerId && fromPeer === this.witnessPeerId && msg.t !== 'hello') {
      if (msg.t === 'wclk' || msg.t === 'wend') this.onWitnessStreamMsg(msg)
      return
    }
    // Ignore chatter from any peer that isn't our bonded opponent (T3), except a
    // hello, which is how a rebond announces itself.
    if (this.peerId && fromPeer !== this.peerId && msg.t !== 'hello') return

    // Any traffic from the (bonded/ghost) peer counts as liveness.
    if (fromPeer === this.peerId || fromPeer === this.ghostPeerId) this.lastPeerMsgAt = this.now()

    // Drop stale in-game traffic addressed to a different game (D8) or out-of-
    // order plies (a move with the wrong ply, e.g. a duplicate/lag delivery).
    if (this.isInGameMsg(msg) && 'gameId' in msg && msg.gameId !== this.gameId) return

    switch (msg.t) {
      case 'hello':
        this.onHello(msg.v, msg.role, msg.name, fromPeer, msg.root, msg.key)
        return
      case 'start':
        this.onStart(msg.gameId, msg.yourColor, msg.config, msg.name, msg.gameKey, msg.players)
        return
      case 'move':
        this.onWireMove(msg.ply, msg.uci, msg.clockMs, msg.byo, msg.sig)
        return
      case 'clock':
        this.onWireClock(msg.clockMs, msg.toMove, msg.byo)
        return
      case 'flag':
        // Trust the host's flag verdict (guest); the host doesn't receive its own.
        this.applyFlag(msg.by, msg.clockMs, msg.byo)
        return
      case 'abort':
        this.sendWitness(msg) // v6: keep the witness's view of the game closed
        this.applyAbort(msg.reason)
        return
      case 'gameOver':
        this.sendWitness(msg) // v6: forward the peer's countersigned terminal
        this.applyGameOver(msg.result, msg.reason)
        return
      case 'drawOffer':
        this.onWireDrawOffer()
        return
      case 'drawDecline':
        this.onWireDrawDecline()
        return
      case 'drawAccept': {
        // Peer accepted OUR offer: game drawn.
        this.outgoingDrawOffer = false
        if (this.over) return
        const gid = this.gameId
        // v6: countersign the draw for the witness (mirrors acceptDraw; null in
        // unsigned games). sendWitness is host-only, so this is how the HOST's
        // draw esig reaches the witness when the GUEST accepted our offer.
        const esig = this.signTerminal('1/2-1/2', 'agreement')
        this.endGame()
        if (esig) this.sendWitness({ t: 'gameOver', gameId: gid, result: '1/2-1/2', reason: 'agreement', esig })
        this.emitEvent({ type: 'drawAccept' })
        return
      }
      case 'resign':
        if (this.over) return
        this.sendWitness(msg) // v6: forward the resigner's countersignature
        this.endGame()
        this.emitEvent({ type: 'resign', by: msg.by })
        return
      case 'rematchOffer':
        this.onWireRematchOffer()
        return
      case 'rematchDecline':
        this.myRematchOffer = false
        this.peerRematchOffer = false
        this.emitEvent({ type: 'rematchDecline' })
        return
      case 'rematchStart':
        // Guest side: host started a rematch; adopt the (swapped) color + gameId.
        this.onRematchStart(msg.gameId, msg.yourColor, msg.gameKey, msg.players)
        return
      case 'resumeReq':
        this.onResumeReq(msg.gameId, msg.havePly)
        return
      case 'resync':
        this.onResync(msg.gameId, msg.moves, msg.clockMs, msg.toMove, msg.yourColor, msg.config, msg.byo)
        return
      case 'wclk':
      case 'wend':
        // v6: only honored from the seated witness (handled before the switch).
        return
      case 'bye':
        this.onPeerGone()
        return
      case 'ping':
        // Echo the sender's timestamp so THEY can measure RTT.
        this.sendWire({ t: 'pong', ts: msg.ts })
        return
      case 'pong':
        // Our ping came back: update the rolling RTT estimate.
        this.onPong(msg.ts)
        return
      case 'error':
        this.onWireError(msg.message)
        return
    }
  }

  /** Which wire messages carry a gameId that must match the current game. */
  private isInGameMsg(msg: WireMsg): boolean {
    switch (msg.t) {
      case 'move':
      case 'clock':
      case 'flag':
      case 'abort':
      case 'gameOver':
      case 'resign':
      case 'drawOffer':
      case 'drawDecline':
      case 'drawAccept':
      case 'resumeReq':
        return true
      // start/resync/rematchStart CARRY a new gameId (they set it), never drop.
      default:
        return false
    }
  }

  private onWireError(message: string): void {
    // A guest×guest collision or a busy/in-progress host: friendly failure + drop.
    this.fail(message)
  }

  // ---- handshake -------------------------------------------------------------

  private onHello(
    peerVersion: number,
    peerRole: HelloMsg['role'],
    peerName: string | undefined,
    fromPeer: string,
    peerRoot?: string,
    peerKey?: string
  ): void {
    if (peerVersion !== PROTOCOL_VERSION) {
      // Version mismatch: tell the peer, tell our UI, and drop. On desktop both
      // messages point at Settings → Updates, the fix is always "update both
      // apps" (OnlineTab also surfaces a live update nudge next to this error).
      // The web build has no Updates panel, so it asks in platform-neutral terms.
      this.sendWire({
        t: 'error',
        message: `version mismatch (host expects v${PROTOCOL_VERSION}), ${
          isWebBuild
            ? 'make sure both players are on the latest version'
            : 'update both apps in Settings → Updates'
        }`
      })
      this.fail(
        `The other player is running an incompatible version (protocol v${peerVersion} vs v${PROTOCOL_VERSION}). ${
          isWebBuild
            ? 'Make sure both players are on the latest version.'
            : 'Update both apps in Settings → Updates.'
        }`
      )
      return
    }
    // v6: a witness announces itself by hello role, never by presence; seat
    // it (or tolerate it) WITHOUT disturbing the host/guest handshake.
    if (peerRole === 'witness') {
      this.onWitnessHello(fromPeer, peerRoot, peerKey)
      return
    }
    // Role sanity: a guest that hears another guest knows nobody is hosting (T5).
    if (this.role === 'guest' && peerRole !== 'host') {
      this.fail("That code has no host. It looks like you both joined. One of you needs to Host.")
      return
    }
    if (this.role === 'host' && peerRole !== 'guest') {
      // Two hosts on the same code: refuse this stranger, keep hosting.
      this.transport?.send(encodeWireMsg({ t: 'error', message: 'that code is already hosted' }), fromPeer)
      return
    }
    // v6 pinned opponent: when the caller arranged a specific account, REFUSE a
    // peer whose hello identity is missing or different, but refuse only that
    // PEER, never the session. This runs pre-handshake ONLY (once we've bonded
    // the arranged opponent, the `if (this.handshaked) return` guard below drops
    // every stray hello), and at most releases a wrong unbonded candidate so we
    // keep waiting for the real opponent, mirroring onWitnessHello's seat
    // release. Calling this.fail() here (as an earlier version did) let any peer
    // who knew the room code tear down a live pinned game with one stray hello,
    // and let a wrong peer wandering in pre-bond permanently block the arranged
    // opponent, a one-message DoS.
    if (!this.handshaked && this.signing?.oppRoot && peerRoot !== this.signing.oppRoot) {
      this.transport?.send(encodeWireMsg({ t: 'error', message: 'identity mismatch' }), fromPeer)
      if (fromPeer === this.peerId) {
        this.peerId = null
        this.emitEvent({ type: 'net', state: 'searching' })
      }
      return
    }
    this.peerName = peerName
    // v6: adopt the peer's signing identity (present ⇒ it offers signed play)
    // ONLY on the genuine first handshake. A later duplicate/stray hello reaches
    // here before the `handshaked` guard below; letting it run would null an
    // established peerRoot/peerKey and silently downgrade a signed rematch to
    // unsigned (or tear it down). Once handshaked, the identity is frozen.
    if (!this.handshaked) {
      this.peerRoot = peerRoot ?? null
      this.peerKey = peerKey ?? null
    }

    // Ghost hello during suspend: the SAME peer is back → RESUME, never restart
    // (D9). rebond() restores the bond, re-anchors the clock, restarts the
    // heartbeat, and emits peer-back. The guest then asks for a resync.
    if (this.suspended && fromPeer === this.ghostPeerId) {
      this.rebond(fromPeer)
      this.handshaked = true
      if (this.role === 'guest') {
        this.sendWire({ t: 'resumeReq', gameId: this.gameId, havePly: this.plyCount })
      }
      return
    }

    if (this.handshaked) return // ignore a duplicate hello mid-game

    // Handshake good: stop the discovery/handshake clocks and start heartbeating.
    this.handshaked = true
    this.clearDiscoveryTimer()
    this.clearHandshakeWatchdog()
    this.transport?.stopRelayPoll?.()
    this.startHeartbeat()

    if (this.suspended) {
      // Suspended but this hello isn't from the ghost, shouldn't happen (a new
      // peer while suspended is refused in onPeerJoin), but never start a game.
      return
    }

    // A live game already exists (e.g. onPeerJoin re-bonded the ghost first, then
    // its hello arrived): this is a RESUME, never a restart (D9). The host waits
    // for the guest's resumeReq; the guest asks for a resync.
    if (this.inGame && !this.over) {
      if (this.role === 'guest') {
        this.sendWire({ t: 'resumeReq', gameId: this.gameId, havePly: this.plyCount })
      }
      return
    }

    if (this.role === 'host') {
      // Host resolves colors now and starts the game for both sides.
      this.startGameAsHost()
    }
    // Guest waits for the host's 'start'.
  }

  /** v6 witness seating. POLICY (the documented tolerance choice): a session
   *  that did NOT opt into signed play (no `signing` config) TOLERATES a
   *  witness hello and ignores everything it says, honest degradation, zero
   *  disturbance to the shipped unsigned flow. A signed session seats exactly
   *  ONE witness; a SECOND witness hello gets a targeted wire error and
   *  changes nothing for the session or the first witness. */
  private onWitnessHello(fromPeer: string, root?: string, key?: string): void {
    if (fromPeer === this.witnessPeerId) return // duplicate hello, already seated
    if (this.witnessPeerId) {
      // Seat taken: refuse THIS peer only.
      this.transport?.send(encodeWireMsg({ t: 'error', message: 'witness seat taken' }), fromPeer)
      return
    }
    // The witness may have been presence-bonded as our opponent before it
    // spoke (we bond the FIRST peer to appear). Give the seat back and keep
    // waiting for a real opponent, but a peer that already HANDSHAKED as our
    // opponent can never re-declare itself a witness mid-game.
    if (fromPeer === this.peerId) {
      if (this.handshaked) return
      this.peerId = null
      this.emitEvent({ type: 'net', state: 'searching' })
    }
    // Unsigned session, or a witness that names no signing identity: tolerate
    // + ignore, the documented degradation choice (never an error, never a
    // seat, zero disturbance to the shipped unsigned flow).
    if (!this.signing || !root || !key) return
    this.witnessPeerId = fromPeer
    this.witnessRoot = root
    this.witnessKey = key
    // If this witness seated AFTER the host already sent `start` (the guest
    // handshaked first), it missed the one-shot mirrored start + every move so
    // far, so its WitnessCore would never initialize and never countersign.
    // Replay the started game to JUST this witness so it catches up to the live
    // transcript. A no-op when the witness seats BEFORE the game starts (the
    // normal path, `start` then mirrors to it as usual) and for unsigned games.
    // This is what lets the matchmaking seat race resolve with ~0 delay instead
    // of forcing the guest to wait for the witness to seat first.
    this.resendGameToWitness()
  }

  /** v6: replay the in-progress game to a witness that seated LATE (after the
   *  one-shot `start`). Sends the same `start` the guest received (so the
   *  witness inits its WitnessCore with our gameKey/players/config), then every
   *  committed SIGNED move in ply order (so it verifies the full move-sig chain
   *  and resumes the wclk cadence + terminal wend). The witness's clock rounding
   *  is idempotent on the already-integer SignedMove clocks, so each replayed sig
   *  verifies byte-for-byte. HOST-only + a live SIGNED game only, otherwise a
   *  no-op, so the witness-seats-first and unsigned flows stay byte-identical.
   *  Only the seated witness sees it (sendWitness targets it); the players don't. */
  private resendGameToWitness(): void {
    if (this.role !== 'host' || !this.witnessPeerId) return
    if (!this.inGame || this.over) return
    const chain = this.chain
    if (!this.config || !this.gameKey || !this.gamePlayers || !chain) return
    const startMsg: WireMsg = {
      t: 'start',
      gameId: this.gameId,
      yourColor: this.guestColor ?? 'black', // witness ignores this; needs gameKey
      config: this.config,
      ...(this.myName ? { name: this.myName } : {}),
      gameKey: this.gameKey,
      players: this.gamePlayers
    }
    this.sendWitness(startMsg)
    // Replay each committed signed move (SignedMove.clockMs is {w,b} integers →
    // wire {white,black}; the witness re-rounds identically, so the sig holds).
    for (const m of chain.moves) {
      this.sendWitness({
        t: 'move',
        gameId: this.gameId,
        ply: m.ply,
        uci: m.move,
        clockMs: { white: m.clockMs.w, black: m.clockMs.b },
        sig: m.sig
      })
    }
  }

  /** v6: verify + surface a witness stream message. Verification failures are
   *  IGNORED (the witness is advisory, a forged/buggy witness must never
   *  kill a live game); valid messages fan out to onWitnessStream. */
  private onWitnessStreamMsg(msg: MpWitnessMsg): void {
    if (!this.gameKey || !this.witnessKey) return
    if (msg.gameId !== this.gameId) return
    // Fail CLOSED: witnessClockBytes / witnessEndBytes → canonicalBytes THROW on
    // an unencodable value (the wire clock schema is a bare z.number(), so a
    // seated (and unauthenticated) witness can send clockMs {white:1e21} or a
    // -0, and ply/wts are unbounded ints). Verification failures here are
    // IGNORED by contract ("a forged/buggy witness must never kill a live
    // game"), so a throw MUST read as "ignore", never escape into onRaw →
    // transport.onMessage and tear the live session down.
    try {
      if (msg.t === 'wclk') {
        const bytes = witnessClockBytes(this.gameKey, msg.ply, sigClock(msg.clockMs), msg.wts)
        if (!verifySigB64u(msg.sig, bytes, this.witnessKey)) return
      } else if (!this.verifyWitnessEndMsg(msg)) {
        return
      }
    } catch {
      return // unencodable witness message, ignore, exactly like a bad sig
    }
    for (const cb of this.witnessListeners) cb(msg)
  }

  /** v6 (A6 Lane C, the documented mpSession seam): verify a terminal `wend`.
   *  A RATED witness signs its wend over the FULL rated binding (kind/tc +
   *  players-by-color + the adjudicated reason, segment.ts RatedBinding, the
   *  exact bytes SegmentPayload.wstream carries), while an unrated signed game
   *  signs the LEGACY binding-less bytes. Surface EITHER: the session re-derives
   *  the rated binding from its OWN config (ladderFromConfig, the same map the
   *  witness used) + this game's players + the wend's own reason, NEVER trusting
   *  a witness claim it can't reconstruct. A legacy wend keeps verifying legacy;
   *  a forged/mismatched wend verifies as neither and is ignored (the witness is
   *  advisory, it never tears a live game down). Guarded by the caller's
   *  try/catch: witnessEndBytes → canonicalBytes may throw on an unencodable
   *  value, which reads as "ignore", exactly like a bad signature. */
  private verifyWitnessEndMsg(msg: Extract<MpWitnessMsg, { t: 'wend' }>): boolean {
    if (!this.gameKey || !this.witnessKey) return false
    const wstream = { wkey: this.witnessKey, sig: msg.sig }
    // Unrated signed game: binding-less bytes (byte-for-byte the prior path).
    if (verifyWitnessEnd(wstream, this.gameKey, msg.result, msg.plies, msg.transcript)) return true
    // Rated game: the binding is ATOMIC (verifySegmentEvent requires rated ⇔
    // fully bound), so players/reason must ride alongside kind/tc.
    if (!this.config || !this.gamePlayers) return false
    const { kind, tc } = ladderFromConfig(this.config)
    return verifyWitnessEnd(wstream, this.gameKey, msg.result, msg.plies, msg.transcript, {
      kind,
      tc,
      players: this.gamePlayers,
      reason: msg.reason,
    })
  }

  private armHandshakeWatchdog(): void {
    this.clearHandshakeWatchdog()
    this.handshakeTimer = setTimeout(() => {
      if (this.handshaked || !this.peerId) return
      // The bonded peer never greeted us: unbond and accept the next one (L8).
      const stale = this.peerId
      this.peerId = null
      this.emitEvent({ type: 'net', state: 'searching' })
      void stale
    }, MP_TIMING.HANDSHAKE_WATCHDOG_MS)
  }

  private clearHandshakeWatchdog(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  // ---- host: game start ------------------------------------------------------

  private resolveColors(): { hostColor: MpColor; guestColor: MpColor } {
    const choice = this.config?.hostColor ?? 'white'
    const hostColor: MpColor =
      choice === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : choice
    const guestColor: MpColor = hostColor === 'white' ? 'black' : 'white'
    return { hostColor, guestColor }
  }

  private startGameAsHost(): void {
    if (!this.config) return
    const { hostColor, guestColor } = this.resolveColors()
    this.myColor = hostColor
    this.guestColor = guestColor
    this.gameId += 1 // first game → 1
    this.beginGame()
    this.setupSignedGame() // v6: mint the game key when both sides offered identity
    // Tell the guest their color + config + our name; emit our own start. The
    // witness gets the SAME start (it ignores yourColor; it needs gameKey).
    const startMsg: WireMsg = {
      t: 'start',
      gameId: this.gameId,
      yourColor: guestColor,
      config: this.config,
      ...(this.myName ? { name: this.myName } : {}),
      ...(this.gameKey && this.gamePlayers ? { gameKey: this.gameKey, players: this.gamePlayers } : {})
    }
    this.sendWire(startMsg)
    this.sendWitness(startMsg)
    this.emitEvent({ type: 'peer-joined' })
    this.emitEvent({
      type: 'start',
      gameId: this.gameId,
      yourColor: hostColor,
      config: this.config,
      ...(this.peerName ? { opponentName: this.peerName } : {})
    })
  }

  // ---- v6 signed play ---------------------------------------------------------

  /** Host: mint the global game key when BOTH sides offered identity in their
   *  hellos (v6 signed play). Renderer web crypto is fine HERE, shared/mp
   *  stays randomness-free. No mutual identity ⇒ stays unsigned (exactly v5). */
  private setupSignedGame(): void {
    if (!this.signing || !this.peerRoot || !this.peerKey || !this.myColor) return
    const myC: 'w' | 'b' = this.myColor === 'white' ? 'w' : 'b'
    const roots =
      myC === 'w' ? { w: this.signing.root, b: this.peerRoot } : { w: this.peerRoot, b: this.signing.root }
    const keys = myC === 'w' ? { w: this.signing.key, b: this.peerKey } : { w: this.peerKey, b: this.signing.key }
    const nonce = new Uint8Array(32)
    crypto.getRandomValues(nonce)
    const seed: GameKeySeed = { v: 1, t: 'game-key', w: roots.w, b: roots.b, nonce: toB64u(nonce), ts: Date.now() }
    this.adoptSignedGame(computeGameKey(seed), roots, keys)
  }

  /** Guest: adopt the host's game key + player roots off start/rematchStart.
   *  A signed start must name OUR root under OUR color and the peer's under
   *  the other, any mismatch is a LOUD failure (a signed session never
   *  silently degrades to unsigned). */
  private adoptSignedGameFromWire(
    gameKeyB: string | undefined,
    players: { w: string; b: string } | undefined,
    myColor: MpColor
  ): void {
    if (!gameKeyB || !players) {
      // Mutual identity (both hellos carried root/key) MANDATES a signed game
      // (the v6 rule setupSignedGame also enforces). An absent gameKey here is
      // therefore a downgrade (a malicious host, or a relay stripping the
      // optional field), NOT an unsigned game, so fail loud instead of silently
      // dropping to v5. Only a session that never established mutual identity
      // legitimately continues unsigned.
      if (this.signing && this.peerRoot && this.peerKey) {
        this.failSigned('signed start missing gameKey/players (downgrade)')
      }
      return // genuinely unsigned: exactly v5
    }
    if (!this.signing || !this.peerRoot || !this.peerKey) {
      this.failSigned('signed start without mutual identity')
      return
    }
    const myC: 'w' | 'b' = myColor === 'white' ? 'w' : 'b'
    const oppC: 'w' | 'b' = myC === 'w' ? 'b' : 'w'
    if (players[myC] !== this.signing.root || players[oppC] !== this.peerRoot) {
      this.failSigned('signed start names the wrong players')
      return
    }
    const keys = myC === 'w' ? { w: this.signing.key, b: this.peerKey } : { w: this.peerKey, b: this.signing.key }
    this.adoptSignedGame(gameKeyB, { w: players.w, b: players.b }, keys)
  }

  private adoptSignedGame(gameKeyB: string, roots: { w: string; b: string }, keys: { w: string; b: string }): void {
    this.gameKey = gameKeyB
    this.gamePlayers = roots
    this.chain = new MoveChainVerifier(gameKeyB, keys, this.firstMover() === 'white' ? 'w' : 'b')
  }

  private clearSignedGame(): void {
    this.gameKey = null
    this.gamePlayers = null
    this.chain = null
  }

  /** Sign OUR move over the exact wire clock snapshot and advance the local
   *  chain. Returns null in unsigned games. */
  private signOwnMove(ply: number, uci: string, clockMs: Clocks): string | null {
    if (!this.chain || !this.signing || !this.gameKey) return null
    // Fail CLOSED: signMove → moveSigBytes → canonicalBytes THROWS on an
    // unencodable clock. A guest adopts this.clocks straight off the host's
    // 'clock'/'move' wire (clocksSchema is a bare z.number()), so a malicious
    // host can plant e.g. white:1e21 and crash the guest on its NEXT signature.
    // A signed session must tear down loudly (failSigned), never throw out of
    // sendMove and the UI await.
    let m: SignedMove
    try {
      m = signMove(this.signing.priv, this.gameKey, ply, uci, sigClock(clockMs), this.chain.prevSig)
    } catch {
      this.failSigned(`unencodable clock at ply ${ply}`)
      return null
    }
    const err = this.chain.accept(m.ply, m.move, m.clockMs, m.sig)
    if (err) {
      // Only possible if our own key doesn't match our color's key, a
      // programming/config error, but never sign past a broken chain.
      this.failSigned(`own move rejected: ${err}`)
      return null
    }
    return m.sig
  }

  /** Verify an incoming move against the chain (v6). `advance` false = peek
   *  only (the host verifies BEFORE committing; the commit may still flag).
   *  A bad or missing signature is a LOUD protocol failure. */
  private verifyIncomingMove(ply: number, uci: string, clockMs: Clocks, sig: string | undefined, advance: boolean): boolean {
    if (!this.chain) return true
    if (sig === undefined) {
      this.failSigned(`unsigned move at ply ${ply} in a signed game`)
      return false
    }
    const err = advance
      ? this.chain.accept(ply, uci, sigClock(clockMs), sig)
      : this.chain.check(ply, uci, sigClock(clockMs), sig)
    if (err) {
      this.failSigned(err)
      return false
    }
    return true
  }

  /** Terminal countersignature (esig) over segment.ts witnessEndBytes for the
   *  transcript as WE verified it. Null in unsigned games. */
  private signTerminal(result: '1-0' | '0-1' | '1/2-1/2', reason: string): string | null {
    if (!this.chain || !this.signing || !this.gameKey) return null
    const transcript = transcriptDigest(this.gameKey, this.chain.moves, result, reason)
    return signWitnessEnd(this.signing.priv, this.signing.key, this.gameKey, result, this.chain.plies, transcript).sig
  }

  /** v6 fail-loud: tell the peer why, then tear down. A signed session NEVER
   *  silently degrades to unsigned play. */
  private failSigned(detail: string): void {
    this.sendWire({ t: 'error', message: `signed play failure: ${detail}` })
    this.fail(`Signed game integrity failure: ${detail}`)
  }

  /** The color that moves FIRST in this game. Wire v4: rides in the game
   *  selector (config.game.firstMover, black for go/gomoku/othello/checkers);
   *  absent = white, so chess and every pre-firstMover config are unchanged.
   *  Move ORDER is the only thing that varies; color names stay white/black
   *  on the wire, and rematch color swaps don't touch it (the order is
   *  anchored to the color, not the seat). */
  private firstMover(): MpColor {
    return this.config?.game?.firstMover ?? 'white'
  }

  /** Reset per-game state for a fresh game (host + guest). Clocks IDLE, the
   *  first mover is to move but its clock not yet running (first-move rule).
   *  Arms the abort watchdog. */
  private beginGame(): void {
    const initial = this.config?.tc.initialMs ?? 0
    const byo = this.byoCfg()
    const fresh = freshSideClock(initial, byo)
    this.clocks = { white: fresh.remainingMs, black: fresh.remainingMs }
    this.byoState = byo
      ? {
          white: { periodsLeft: fresh.periodsLeft, inByo: fresh.inByo },
          black: { periodsLeft: fresh.periodsLeft, inByo: fresh.inByo }
        }
      : null
    this.over = false
    this.inGame = true
    this.suspended = false
    this.incomingDrawOffer = false
    this.outgoingDrawOffer = false
    this.myRematchOffer = false
    this.peerRematchOffer = false
    this.drawBlockedUntilPly = { white: 0, black: 0 }
    this.plyCount = 0
    this.moves = []
    // v6: per-game signed state resets with the game; the host/guest re-adopt
    // a fresh game key right after (rematches mint a new one).
    this.clearSignedGame()
    this.guestMoveUnacked = false
    // Clocks IDLE: the first mover is to move but turnStartedAt stays 0 (no
    // debit, no flag) until its first move commits (D1/MP-03).
    this.toMove = this.firstMover()
    this.turnStartedAt = 0
    this.clearFlagTimer()
    // The host owns the abort watchdog for the missing first move.
    if (this.role === 'host') this.armAbortWatchdog()
  }

  /** Whether this game runs a clock at all (initialMs 0 ⇒ untimed/unlimited,
   *  unless byo-yomi is configured, which is a real clock even with main 0). */
  private get timed(): boolean {
    return (this.config?.tc.initialMs ?? 0) > 0 || this.byoCfg() !== null
  }

  /** The game's validated byo-yomi spec, or null for plain Fischer (v5). */
  private byoCfg(): ByoyomiSpec | null {
    return normalizeByoyomi(this.config?.tc.byoyomi ?? null)
  }

  /** One side's clock as the pure byoyomi SideClock (math view over
   *  clocks[side] + byoState[side]). */
  private sideClock(side: MpColor): SideClock {
    const b = this.byoState?.[side]
    return { remainingMs: this.clocks[side], periodsLeft: b?.periodsLeft ?? 0, inByo: b?.inByo ?? false }
  }

  /** Write a pure SideClock back into clocks/byoState. */
  private storeSideClock(side: MpColor, c: SideClock): void {
    this.clocks[side] = c.remainingMs
    if (this.byoState) this.byoState[side] = { periodsLeft: c.periodsLeft, inByo: c.inByo }
  }

  /** Defensive copy of the byo snapshot for wire/event payloads (undefined when
   *  the game has no byo-yomi, keeps v4-shaped messages byte-identical). */
  private byoSnapshot(): MpByo | undefined {
    if (!this.byoState) return undefined
    return { white: { ...this.byoState.white }, black: { ...this.byoState.black } }
  }

  private currentTimeControl(): TimeControl {
    const initial = this.config?.tc.initialMs ?? 0
    const inc = this.config?.tc.incrementMs ?? 0
    return { id: 'mp', label: 'mp', baseMs: initial, incMs: inc }
  }

  // ---- clocks + move authority ------------------------------------------------

  /** Commit `mover`'s move: record it, debit its elapsed time (with lag forgiveness
   *  for guest moves), credit the increment, flip the turn, re-arm watchdogs.
   *  Returns the fresh authoritative clocks, or null if the mover just flagged
   *  (game ended + flag emitted/relayed inside). Host-only. */
  private commitMove(mover: MpColor, uci: string, lagForgiveMs: number): Clocks | null {
    // The opening move of the game, by the FIRST MOVER (config.game.firstMover;
    // white when absent, black in go/gomoku/othello/checkers), gets the
    // first-move grace: debit 0, no increment.
    const isOpeningMove = this.plyCount === 0 && mover === this.firstMover()

    if (!this.timed) {
      this.recordMove(uci)
      this.toMove = mover === 'white' ? 'black' : 'white'
      this.clearAbortWatchdog()
      // The reply after the opening move still needs its own abort window.
      if (this.plyCount === 1) this.armAbortWatchdog()
      return { ...this.clocks }
    }

    if (isOpeningMove) {
      // The first mover's move 1 debits 0 and credits NO increment; it starts
      // the OTHER side's clock. (Verified lichess/scalachess.)
      this.recordMove(uci)
      this.toMove = mover === 'white' ? 'black' : 'white'
      this.turnStartedAt = this.now()
      this.clearAbortWatchdog()
      this.armAbortWatchdog() // the replier must answer within the grace window
      this.armFlagTimer()
      return { ...this.clocks }
    }

    // Normal debit from the replier's move 1 onward: plain Fischer, or (v5)
    // byo-yomi, the think burns main time first, spills into periods, and a
    // move made within a period resets it (afterMoveCredit); the increment is
    // only credited while still on main time.
    const now = this.now()
    const elapsed = Math.max(0, now - this.turnStartedAt - Math.max(0, lagForgiveMs))
    const byo = this.byoCfg()
    const burned = consumeElapsed(this.sideClock(mover), elapsed, byo)
    if (burned.flagged) {
      // Flag fall on the mover's own clock: they lose on time.
      this.storeSideClock(mover, burned.clock)
      this.flagLoss(mover)
      return null
    }
    const inc = this.config?.tc.incrementMs ?? 0
    this.storeSideClock(mover, afterMoveCredit(burned.clock, byo, inc))
    this.recordMove(uci)
    // Flip the turn; the other side's clock now starts ticking.
    this.toMove = mover === 'white' ? 'black' : 'white'
    this.turnStartedAt = now
    // Once the reply has landed (ply ≥ 2) the game is truly underway: no more abort.
    this.clearAbortWatchdog()
    this.armFlagTimer()
    return { ...this.clocks }
  }

  private recordMove(uci: string): void {
    this.moves.push(uci)
    this.plyCount += 1
  }

  /** Arm a watchdog that fires when the side-to-move would flag. On fire it
   *  RECOMPUTES remaining from the monotonic base and re-arms for any residual
   *  (never trusts the timer's punctuality, D3). Host-only. With byo-yomi the
   *  budget is main + every period still ahead (a side only truly flags when
   *  its LAST period lapses); the mid-think period bookkeeping is settled by
   *  consumeElapsed at commit/pause time. */
  private armFlagTimer(): void {
    this.clearFlagTimer()
    if (!this.timed || this.over || !this.toMove || this.turnStartedAt === 0) return
    const side = this.toMove
    const budget = totalBudgetMs(this.sideClock(side), this.byoCfg())
    const fireIn = Math.max(0, budget - (this.now() - this.turnStartedAt))
    this.flagTimer = setTimeout(() => {
      this.flagTimer = null
      if (this.over || this.suspended || this.toMove !== side || this.turnStartedAt === 0) return
      const remaining =
        totalBudgetMs(this.sideClock(side), this.byoCfg()) - (this.now() - this.turnStartedAt)
      if (remaining > 0) {
        // Fired early (timer imprecision / throttling): re-arm for the residual.
        this.armFlagTimer()
        return
      }
      this.flagLoss(side)
    }, fireIn)
  }

  private clearFlagTimer(): void {
    if (this.flagTimer) {
      clearTimeout(this.flagTimer)
      this.flagTimer = null
    }
  }

  /** The side `loser` ran out of time. Its own event: flag{by, clocks} with the
   *  loser zeroed (and, with byo-yomi, its periods exhausted); the store
   *  adjudicates insufficient-material draw vs win. */
  private flagLoss(loser: MpColor): void {
    if (this.over) return
    const gid = this.gameId
    this.clocks[loser] = 0
    if (this.byoState) this.byoState[loser] = { periodsLeft: 0, inByo: true }
    // v6: the host countersigns the flag verdict it is about to relay. (The
    // store may still adjudicate an insufficient-material draw, that
    // refinement of the SIGNED result is A6's; see the brick report.)
    const esig = this.signTerminal(loser === 'white' ? '0-1' : '1-0', REASON_FLAG)
    this.endGame()
    const clockMs = { ...this.clocks }
    const byo = this.byoSnapshot()
    const msg: WireMsg = { t: 'flag', gameId: gid, by: loser, clockMs, ...(byo ? { byo } : {}), ...(esig ? { esig } : {}) }
    this.sendWire(msg)
    this.sendWitness(msg)
    this.emitEvent({ type: 'flag', gameId: gid, by: loser, clockMs, ...(byo ? { byo } : {}) })
  }

  /** Arm the first-move abort watchdog (host-only). Fires if the side that owes
   *  the move (the first mover pre-move-1, or the replier pre-reply) never
   *  plays within grace. */
  private armAbortWatchdog(): void {
    this.clearAbortWatchdog()
    if (this.over || this.plyCount >= 2) return
    this.abortTimer = setTimeout(() => {
      this.abortTimer = null
      if (this.over || this.suspended || this.plyCount >= 2) return
      const gid = this.gameId
      this.endGame()
      const msg: WireMsg = { t: 'abort', gameId: gid, reason: 'no-first-move' }
      this.sendWire(msg)
      this.sendWitness(msg) // v6: close the witness's view (host abort watchdog)
      this.emitEvent({ type: 'abort', gameId: gid, reason: 'no-first-move' })
    }, MP_TIMING.FIRST_MOVE_ABORT_MS)
  }

  private clearAbortWatchdog(): void {
    if (this.abortTimer) {
      clearTimeout(this.abortTimer)
      this.abortTimer = null
    }
  }

  /** Mark the game decided and stop the clock/abort watchdogs. */
  private endGame(): void {
    this.over = true
    this.inGame = false
    this.toMove = null
    this.turnStartedAt = 0
    this.suspended = false
    this.clearFlagTimer()
    this.clearAbortWatchdog()
    this.clearGraceTimer()
  }

  // ---- inbound move / clock ---------------------------------------------------

  /** A 'move' wire message arrived. Host: it's the guest's move, enforce turn +
   *  ply order, time it with lag forgiveness, relay the authoritative clocks.
   *  Guest: it's the host's authoritative move. Both drop out-of-order plies. */
  private onWireMove(ply: number, uci: string, clockMs: Clocks, byo?: MpByo, sig?: string): void {
    if (this.over || this.suspended) return
    // Reject duplicates / out-of-order: the next expected ply is plyCount.
    // (Signed games too: a wrong-ply arrival is a benign dup/lag delivery;
    // the chain itself refuses anything that would actually commit out of
    // order, and the witness refuses it loudly.)
    if (ply !== this.plyCount) return

    if (this.role === 'host') {
      // The guest moved. Enforce turn order; ignore their clock hint entirely.
      if (this.toMove !== this.guestColor) return
      // v6 signed game: verify the guest's sig over ITS claimed clock snapshot
      // BEFORE committing (peek, the commit below may still flag). Bad or
      // missing sig ⇒ loud teardown, never a silent drop.
      if (this.chain && !this.verifyIncomingMove(ply, uci, clockMs, sig, false)) return
      // Kernel seam (v4): the wire no longer proves legality (moves are opaque
      // game-codec strings), ask the registered validator before committing.
      // Silently drop an illegal move, exactly like an out-of-turn one. The
      // guest's optimistic local state stays consistent because ITS store also
      // validated locally; a truly malicious guest just gets ignored.
      if (this.moveValidator && !this.moveValidator(this.moves, uci)) return
      // Lag compensation: forgive up to min(rtt/2, 250ms) of the guest's debit.
      const lagForgive = Math.min(this.rtt / 2, MP_TIMING.MAX_LAG_FORGIVE_MS)
      const committedPly = this.plyCount
      const authoritative = this.commitMove(this.guestColor as MpColor, uci, lagForgive)
      if (!authoritative) return // guest flagged; flagLoss already fired
      // v6: the move committed, advance the sig chain (already verified) and
      // mirror the guest's move to the witness EXACTLY as signed (its claimed
      // clocks; our authoritative clocks ride the 'clock' ack as always).
      if (this.chain) {
        // The sig was already verified at the pre-commit peek and the chain head
        // is unchanged (commitMove never touches this.chain), so advance without
        // a second ed25519 verify. sig is defined here: the peek rejects an
        // unsigned move before we ever reach commit.
        const err = this.chain.advanceChecked(committedPly, uci, sigClock(clockMs), sig as string)
        if (err) {
          this.failSigned(err)
          return
        }
        this.sendWitness({ t: 'move', gameId: this.gameId, ply: committedPly, uci, clockMs, ...(sig ? { sig } : {}) })
      }
      const authByo = this.byoSnapshot()
      // Surface the guest's move to the HOST renderer with authoritative clocks…
      this.emitEvent({
        type: 'move',
        gameId: this.gameId,
        ply: committedPly,
        uci,
        clockMs: authoritative,
        ...(authByo ? { byo: authByo } : {})
      })
      // …and ack the guest with the authoritative clocks (D5) so its clock updates.
      if (this.toMove) {
        this.sendWire({
          t: 'clock',
          gameId: this.gameId,
          clockMs: authoritative,
          toMove: this.toMove,
          ...(authByo ? { byo: authByo } : {})
        })
      }
    } else {
      // Guest: trust the host's move AND its authoritative clocks (clockMs is
      // authoritative host→guest; v5: the byo snapshot rides along). Record it,
      // adopt the clocks, flip the turn. Turn parity keys off the FIRST MOVER
      // (even ply = first mover's turn), not a hardcoded white.
      // v6 signed game: verify the host's sig first (fail loud on tampering).
      if (this.chain && !this.verifyIncomingMove(ply, uci, clockMs, sig, true)) return
      this.clocks = { ...clockMs }
      if (byo) this.byoState = { white: { ...byo.white }, black: { ...byo.black } }
      this.recordMove(uci)
      const first = this.firstMover()
      const second: MpColor = first === 'white' ? 'black' : 'white'
      this.toMove = this.plyCount % 2 === 0 ? first : second
      this.emitEvent({
        type: 'move',
        gameId: this.gameId,
        ply,
        uci,
        clockMs: { ...clockMs },
        ...(byo ? { byo: { white: { ...byo.white }, black: { ...byo.black } } } : {})
      })
    }
  }

  /** Host→guest clock ack/resync. Guest mirrors the authoritative snapshot. */
  private onWireClock(clockMs: Clocks, toMove: MpColor, byo?: MpByo): void {
    if (this.role === 'host' || this.over) return
    // v6: the host's authoritative clock ack confirms it committed our move:
    // our optimistic chain move is now part of the shared transcript.
    this.guestMoveUnacked = false
    this.clocks = { ...clockMs }
    if (byo) this.byoState = { white: { ...byo.white }, black: { ...byo.black } }
    this.toMove = toMove
    this.emitEvent({
      type: 'clock',
      gameId: this.gameId,
      clockMs: { ...clockMs },
      toMove,
      ...(byo ? { byo: { white: { ...byo.white }, black: { ...byo.black } } } : {})
    })
  }

  private onStart(
    gameId: number,
    yourColor: MpColor,
    config: MpGameConfig,
    name: string | undefined,
    gameKeyB?: string,
    players?: { w: string; b: string }
  ): void {
    // Guest adopts its color + the game config + host id/name; clocks arrive via
    // move/clock events. Ignore a re-`start` for a game we already have.
    if (this.role !== 'guest') return
    this.config = config
    this.myColor = yourColor
    this.gameId = gameId
    if (name) this.peerName = name
    this.beginGame()
    // v6: adopt the host's game key AFTER beginGame (which clears signed state).
    this.adoptSignedGameFromWire(gameKeyB, players, yourColor)
    if (!this.transport) return // adoptSignedGameFromWire failed loud, no start event
    this.emitEvent({
      type: 'start',
      gameId,
      yourColor,
      config,
      ...(this.peerName ? { opponentName: this.peerName } : {})
    })
  }

  // ---- inbound draw ----------------------------------------------------------

  private onWireDrawOffer(): void {
    if (this.over) return
    // Host enforces the offer gate against the OFFERER (the peer) on receipt.
    if (this.role === 'host') {
      const offerer: MpColor = this.guestColor ?? 'black'
      if (this.plyCount < 2 || this.plyCount < this.drawBlockedUntilPly[offerer]) {
        // Illegal offer (too early / in cooldown): silently drop it.
        return
      }
    }
    this.incomingDrawOffer = true
    this.emitEvent({ type: 'drawOffer' })
  }

  private onWireDrawDecline(): void {
    // The peer declined OUR offer. Clear it and honor our own cooldown.
    if (!this.outgoingDrawOffer) return
    this.outgoingDrawOffer = false
    if (this.myColor) this.drawBlockedUntilPly[this.myColor] = this.plyCount + 20
    this.emitEvent({ type: 'drawDecline' })
  }

  // ---- inbound flag / abort / gameOver ---------------------------------------

  private applyFlag(by: MpColor, clockMs: Clocks, byo?: MpByo): void {
    if (this.over) return
    // v6: the host flagged US on a move we optimistically signed into our chain
    // but the host never committed (it timed out on that very move); roll it
    // back so our getSignedGame() transcript matches the host's and witness's,
    // which stopped one ply short. Only when the loss is OURS and a move is
    // still unacked; a normal flag (opponent lost, or our move already acked)
    // leaves the chain untouched.
    if (by === this.myColor && this.guestMoveUnacked && this.chain) {
      this.chain.rollbackLast()
    }
    this.guestMoveUnacked = false
    this.clocks = { ...clockMs }
    if (byo) this.byoState = { white: { ...byo.white }, black: { ...byo.black } }
    this.endGame()
    this.emitEvent({
      type: 'flag',
      gameId: this.gameId,
      by,
      clockMs: { ...clockMs },
      ...(byo ? { byo: { white: { ...byo.white }, black: { ...byo.black } } } : {})
    })
  }

  private applyAbort(reason: 'no-first-move' | 'manual'): void {
    if (this.over) return
    const gid = this.gameId
    this.endGame()
    this.emitEvent({ type: 'abort', gameId: gid, reason })
  }

  private applyGameOver(result: '1-0' | '0-1' | '1/2-1/2', reason: string): void {
    if (this.over) return
    const gid = this.gameId
    this.endGame()
    this.emitEvent({ type: 'gameOver', gameId: gid, result, reason })
  }

  // ---- rematch ----------------------------------------------------------------

  private onWireRematchOffer(): void {
    this.peerRematchOffer = true
    this.emitEvent({ type: 'rematchOffer' })
    // Host starts only on MUTUAL offers (its own click counts as its offer).
    if (this.role === 'host' && this.myRematchOffer) this.startRematchAsHost()
  }

  private startRematchAsHost(): void {
    if (!this.config || !this.myColor || !this.guestColor) return
    // Swap colors; keep the same time control; bump the gameId.
    const newHostColor: MpColor = this.myColor === 'white' ? 'black' : 'white'
    const newGuestColor: MpColor = newHostColor === 'white' ? 'black' : 'white'
    this.myColor = newHostColor
    this.guestColor = newGuestColor
    this.gameId += 1
    this.beginGame()
    this.setupSignedGame() // v6: a signed rematch mints a FRESH game key
    const msg: WireMsg = {
      t: 'rematchStart',
      gameId: this.gameId,
      yourColor: newGuestColor,
      ...(this.gameKey && this.gamePlayers ? { gameKey: this.gameKey, players: this.gamePlayers } : {})
    }
    this.sendWire(msg)
    this.sendWitness(msg)
    this.emitEvent({ type: 'rematchStart', gameId: this.gameId, yourColor: newHostColor })
  }

  private onRematchStart(gameId: number, yourColor: MpColor, gameKeyB?: string, players?: { w: string; b: string }): void {
    if (!this.config || this.role !== 'guest') return
    this.myColor = yourColor
    this.gameId = gameId
    this.beginGame()
    this.adoptSignedGameFromWire(gameKeyB, players, yourColor) // v6
    if (!this.transport) return // failed loud
    this.emitEvent({ type: 'rematchStart', gameId, yourColor })
  }

  // ============================================================================
  // Suspend / resume (T2/T3/T4/L6/D9/MP-06)
  // ============================================================================

  /** The peer went silent mid-game: pause the clock, keep the room open, remember
   *  the ghost, and grant a speed-scaled grace window. */
  private enterSuspend(): void {
    if (!this.inGame || this.over || this.suspended || !this.peerId) return
    this.suspended = true
    this.ghostPeerId = this.peerId
    this.peerId = null
    // Pause the authoritative clock: freeze how much of the current turn elapsed
    // by folding it into the remaining time, and stop turnStartedAt from ticking.
    // With byo-yomi the fold crosses period boundaries exactly like a commit
    // would (periods burned before the pause stay burned; no move, no reset).
    if (this.role === 'host' && this.timed && this.toMove && this.turnStartedAt > 0) {
      const elapsed = Math.max(0, this.now() - this.turnStartedAt)
      const burned = consumeElapsed(this.sideClock(this.toMove), elapsed, this.byoCfg())
      this.storeSideClock(this.toMove, burned.clock)
      this.turnStartedAt = 0
    }
    this.clearFlagTimer()
    this.clearAbortWatchdog()
    this.stopHeartbeat()
    const graceMs = this.graceMs()
    this.emitEvent({ type: 'peer-away', graceMs })
    this.clearGraceTimer()
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null
      if (!this.suspended) return
      // Grace expired: the peer is gone. Unbind and let the UI claim/abort.
      this.ghostPeerId = null
      this.suspended = false
      this.handshaked = false
      this.emitEvent({ type: 'peer-left' })
    }, graceMs)
  }

  private graceMs(): number {
    const category = timeControlCategory(this.currentTimeControl())
    return MP_TIMING.GRACE_BY_CATEGORY[category] ?? MP_TIMING.GRACE_BY_CATEGORY.Rapid
  }

  /** The ghost peer re-appeared (onPeerJoin or a hello): restore the bond. The
   *  host answers the peer's resumeReq with a resync; the clock resumes on the
   *  first fresh turn tick (turnStartedAt re-anchored below). */
  private rebond(id: string): void {
    if (!this.suspended) return
    this.clearGraceTimer()
    this.suspended = false
    this.peerId = id
    this.ghostPeerId = null
    this.lastPeerMsgAt = this.now()
    this.handshaked = false // re-run a lightweight handshake
    // Re-anchor the running clock so paused time isn't charged.
    if (this.role === 'host' && this.timed && this.toMove && this.plyCount >= 1) {
      this.turnStartedAt = this.now()
    }
    this.startHeartbeat()
    this.emitEvent({ type: 'peer-back' })
    // Greet again so the peer's transport re-learns us and the handshake reruns.
    this.sendWire(this.makeOurHello())
    // Host re-arms its watchdogs for the resumed position.
    if (this.role === 'host') {
      if (this.plyCount < 2) this.armAbortWatchdog()
      this.armFlagTimer()
    }
  }

  /** Host: a rejoining guest asks to resume. Answer with the full authoritative
   *  snapshot (NEVER a fresh start, never wipe a live game, D9). */
  private onResumeReq(gameId: number, havePly: number): void {
    if (this.role !== 'host' || this.over || !this.guestColor) return
    if (gameId !== this.gameId) return
    void havePly
    this.sendWire({
      t: 'resync',
      gameId: this.gameId,
      moves: [...this.moves],
      clockMs: { ...this.clocks },
      // Defensive fallback only (toMove is null post-game and onResumeReq
      // already bails on this.over): derive from the game's move order.
      toMove: this.toMove ?? this.firstMover(),
      yourColor: this.guestColor,
      // v4: carry the game config (kind + options) so a resumed guest can
      // rebuild any game, not just chess.
      ...(this.config ? { config: this.config } : {}),
      // v5: byo-yomi survives the reconnect (consumed periods stay consumed).
      ...(this.byoState ? { byo: this.byoSnapshot() } : {}),
      // v6: the game key + players survive too. The rebonding guest KEPT its
      // chain across the suspend (same session object, D9), so these are a
      // consistency echo, not fresh adoption, a brand-new session cannot
      // rejoin a signed game mid-flight (the move sigs aren't resent).
      ...(this.gameKey && this.gamePlayers ? { gameKey: this.gameKey, players: this.gamePlayers } : {})
    })
  }

  /** Guest: adopt the host's authoritative snapshot after a rebond. Re-anchors the
   *  move list, clocks, and turn to the host's truth. The store keeps its own board
   *  across the suspend (it's a module singleton, L2), and the suspend froze BOTH
   *  sides so no moves were missed, so resync only needs to re-authority the clocks
   *  (delivered via a `clock` event). `moves`/plyCount are re-synced defensively. */
  private onResync(
    gameId: number,
    moves: string[],
    clockMs: Clocks,
    toMove: MpColor,
    yourColor: MpColor,
    config?: MpGameConfig,
    byo?: MpByo
  ): void {
    if (this.role !== 'guest') return
    // v4: adopt the game config when it rides along (kind + options survive the
    // JSON round-trip untouched, z.unknown() passes the blob through).
    if (config) this.config = config
    this.gameId = gameId
    this.moves = [...moves]
    this.plyCount = moves.length
    this.clocks = { ...clockMs }
    // v5: adopt the byo-yomi snapshot (consumed periods stay consumed).
    if (byo) this.byoState = { white: { ...byo.white }, black: { ...byo.black } }
    this.toMove = toMove
    this.myColor = yourColor
    this.over = false
    this.inGame = true
    this.suspended = false
    // v6: a signed game's per-move sigs are NOT resent in the resync, so our
    // chain can resume only if it already matches the authoritative transcript
    // exactly (the suspend normally freezes BOTH sides, so it does). If the host
    // committed a move we never received before it noticed us gone, our chain
    // lags and cannot be reconciled from UCIs alone; tear the signed game down
    // loudly rather than break opaquely on the next signature (finding H). Full
    // signed-game resumption (resync carrying the SignedMove chain) is A6.
    if (this.chain) {
      const cm = this.chain.moves
      const desynced = cm.length !== this.moves.length || this.moves.some((u, i) => cm[i]?.move !== u)
      if (desynced) {
        this.failSigned('signed game desynced on reconnect (missing move signatures)')
        return
      }
      this.guestMoveUnacked = false
    }
    // Surface the authoritative clocks + turn immediately (peer-back already fired
    // on rebond); the store re-anchors its clock snapshot from this.
    this.emitEvent({
      type: 'clock',
      gameId,
      clockMs: { ...clockMs },
      toMove,
      ...(byo ? { byo: { white: { ...byo.white }, black: { ...byo.black } } } : {})
    })
  }

  private clearGraceTimer(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
  }

  // ============================================================================
  // Heartbeat + teardown
  // ============================================================================

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastPeerMsgAt = this.now()
    this.lastTickAt = this.now()
    this.missedEvals = 0
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), MP_TIMING.HEARTBEAT_MS)
  }

  /** One heartbeat tick (D4): SEND a ping first, then evaluate. Self-stall
   *  forgiveness, if our own gap since last fire was > 2× cadence we were
   *  suspended, so skip judgment this tick. Declare peer-away only after ≥15s
   *  silence AND two consecutive failed evaluations. */
  private heartbeatTick(): void {
    if (!this.peerId || this.suspended || this.over) return
    const now = this.now()
    const tickGap = now - this.lastTickAt
    this.lastTickAt = now
    // Ping FIRST, even if we're about to judge. The ping timestamp deliberately
    // uses REAL monotonic time, not the injectable game clock: RTT is a network
    // property, and measuring it with the injected clock lets a test's (or any
    // future consumer's) clock advance masquerade as network lag, a real
    // Windows-CI failure where a heartbeat straddling a fake 500ms advance
    // produced rtt=500 and silently forgave 250ms of think time.
    this.sendWire({ t: 'ping', ts: performance.now() })
    // Self-stall: our own timer was frozen (throttled/suspended machine). Give the
    // peer a clean slate: don't punish them for OUR gap.
    if (tickGap > 2 * MP_TIMING.HEARTBEAT_MS) {
      this.lastPeerMsgAt = now
      this.missedEvals = 0
      return
    }
    const silence = now - this.lastPeerMsgAt
    if (silence > MP_TIMING.PEER_SILENCE_MS) {
      this.missedEvals += 1
      if (this.missedEvals >= 2) {
        // Two strikes: the peer is away. Enter the suspend/grace path.
        this.enterSuspend()
      }
    } else {
      this.missedEvals = 0
    }
  }

  /** TEST-ONLY: pin the rolling RTT estimate so the lag-compensation path is
   *  deterministically testable (real pongs would EMA-decay any injected value).
   *  Cleared by resetState(). Never call outside tests. */
  __setRttForTests(ms: number): void {
    this.rtt = ms
    this.rttPinnedForTests = true
  }
  private rttPinnedForTests = false

  private onPong(sentTs: number): void {
    if (this.rttPinnedForTests) return
    // Real monotonic time, matching the ping timestamp; see heartbeatTick.
    const sample = Math.max(0, performance.now() - sentTs)
    // Exponential moving average so a single spike doesn't dominate forgiveness.
    this.rtt = this.rtt === 0 ? sample : this.rtt * 0.7 + sample * 0.3
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearDiscoveryTimer(): void {
    if (this.discoveryTimer) {
      clearTimeout(this.discoveryTimer)
      this.discoveryTimer = null
    }
  }

  /** The peer vanished mid-session. During a live undecided game this enters the
   *  suspend/grace path (keep the room open for a rebond); otherwise (pre-game or
   *  post-game) it's a clean peer-left. */
  private onPeerGone(): void {
    if (!this.peerId) return
    if (this.inGame && !this.over && !this.suspended) {
      this.enterSuspend()
      return
    }
    this.peerId = null
    this.handshaked = false
    this.clearFlagTimer()
    this.clearAbortWatchdog()
    this.stopHeartbeat()
    this.emitEvent({ type: 'peer-left' })
  }

  /** Fatal error path: report and tear down the transport (session stays inert
   *  until the UI calls leave()). */
  private fail(message: string): void {
    this.emitEvent({ type: 'error', message })
    this.teardownTransport()
    this.peerId = null
    this.ghostPeerId = null
    this.handshaked = false
    this.suspended = false
    this.witnessPeerId = null // v6: the seat dies with the transport
    this.witnessRoot = null
    this.witnessKey = null
    this.clearAllTimers()
  }

  private teardownTransport(): void {
    this.clearAllTimers()
    if (this.transport) {
      // Remember the room's settle so a same-code rejoin can await it (T7).
      this.pendingClose = this.transport.closed ?? null
      try {
        this.transport.close()
      } catch {
        /* ignore */
      }
      this.transport = null
    }
  }

  private clearAllTimers(): void {
    this.clearDiscoveryTimer()
    this.clearHandshakeWatchdog()
    this.clearFlagTimer()
    this.clearAbortWatchdog()
    this.clearGraceTimer()
    this.stopHeartbeat()
  }

  /** Await the previous room's full teardown before re-creating a transport on the
   *  same code (T7); bounded so a stuck close can't wedge host()/join() forever. */
  private async awaitPreviousClose(): Promise<void> {
    const pending = this.pendingClose
    this.pendingClose = null
    if (!pending) return
    await Promise.race([pending, new Promise<void>((res) => setTimeout(res, 1_500))])
  }

  /** Reset all per-game state so a session instance can be reused across a
   *  host()/join() cycle. Clears all timers FIRST (D10). Does NOT clear event
   *  listeners (subscription lifetime belongs to the subscriber, L1). */
  private resetState(): void {
    this.clearAllTimers()
    this.role = null
    this.config = null
    this.myName = undefined
    this.peerName = undefined
    this.myColor = null
    this.peerId = null
    this.ghostPeerId = null
    this.handshaked = false
    this.gameId = 0
    this.guestColor = null
    this.clocks = { white: 0, black: 0 }
    this.byoState = null
    this.toMove = null
    this.turnStartedAt = 0
    this.plyCount = 0
    this.moves = []
    this.over = false
    this.inGame = false
    this.suspended = false
    this.incomingDrawOffer = false
    this.outgoingDrawOffer = false
    this.myRematchOffer = false
    this.peerRematchOffer = false
    this.drawBlockedUntilPly = { white: 0, black: 0 }
    this.lastPeerMsgAt = 0
    this.lastTickAt = 0
    this.missedEvals = 0
    this.rtt = 0
    this.rttPinnedForTests = false
    // v6: identities + witness seat + signed-game state (witnessListeners
    // survive, same L1 rule as listeners).
    this.peerRoot = null
    this.peerKey = null
    this.witnessPeerId = null
    this.witnessRoot = null
    this.witnessKey = null
    this.guestMoveUnacked = false
    this.clearSignedGame()
  }
}
