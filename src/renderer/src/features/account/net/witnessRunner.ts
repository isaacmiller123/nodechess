// A6 M1: the WITNESS RUNNER BODY (spec §3 entanglement).
//
// `WitnessCore` (src/shared/mp/witnessCore.ts) is the pure BRAIN: it verifies a
// signed game's move-sig chain, countersigns the clock stream (wclk) at a
// cadence, adjudicates terminals, and signs the stream end (wend) + the §3
// witnessed-result record. It touches NO transport and produces NOTHING on its
// own, `feed(msg)` returns the messages the caller must SEND.
//
// This module is that missing body: it joins the multiplayer game room as the
// third, non-playing peer (`hello{role:'witness'}`, seated by mpSession.ts:887/
// :980), mirrors the host's committed stream INTO a `WitnessCore`, and BROADCASTS
// every emitted wclk/wend back to both players so their `MpNetSession`s verify +
// surface them (onWitnessStream) and embed the wstream into BOTH chains' segment.
//
// Platform-specific by design (renderer-hosted next to the `mp` singleton. The
// same home as mpClient.ts): it owns a live transport + timers, so it lives
// OUTSIDE src/shared/accounts (which stays pure). The transport is INJECTED
// exactly like `MpNetSession` takes an `MpTransportFactory`: prod passes
// `createRtcTransport` (rtcTransport.ts), headless tests pass a mock room, so
// the frame/dispatch logic is unit-testable with no real relay.
//
// Casual/unsigned play is UNAFFECTED: an unsigned host never seats a witness
// (mpSession onWitnessHello tolerates + ignores) and never mirrors a stream, so
// this runner simply never receives a `start` and produces nothing. Signing,
// and therefore witnessing, is opt-in, and only for a rated game whose players
// both signed in (the caller supplies `kind`/`tc`/`pairing`).

import { WitnessCore, type WitnessGameInit } from '@shared/mp/witnessCore'
import { encodeWireMsg, makeHello, parseWireMsg, type WireMsg } from '@shared/mp/wire'
import type {
  MpTransport,
  MpTransportFactory,
  MpTransportListeners,
  MpWitnessMsg,
} from '../../play/online/mpSession'
import type { B64u, PairingPayload } from '@shared/accounts/types'
import type { WitnessedResultRecord } from '@shared/accounts/storage/types'

/** The witness's own signing identity. Shape matches Lane C's
 *  `deviceSigningKey()` ({ priv, key, root }) so a signed-in client can witness
 *  someone else's game with the same material it plays its own with. */
export interface WitnessRunnerIdentity {
  /** Witness account root (b64u). Rides in hello + the witnessed-result record. */
  root: B64u
  /** Witness device signing pubkey (b64u). What every wclk/wend verifies against. */
  key: B64u
  /** Witness device signing private key (raw 32 bytes). */
  priv: Uint8Array
}

/**
 * What the witness knows about the game that the WIRE alone cannot tell it. The
 * host-minted `start` carries gameId/gameKey/players-ROOTS/config; this supplies
 * the rest:
 *  - the players' DEVICE signing keys (move sigs verify against these, not the
 *    roots): the witness resolves each color's key by matching the mirrored
 *    start's `players[color]` root against `participants`;
 *  - the RATED ladder binding + pairing anchors, which are a deliberate opt-in
 *    (a game is witnessed as RATED only when `kind`/`tc`/`pairing` are given.
 *    Otherwise it follows as legacy/unrated, byte-identical to the pre-A4 path).
 *
 * In M1 the caller (dev flow) hands this over out of band with the room code; in
 * M2 the matchmaker fills it from the pool ads it already holds.
 */
export interface WitnessRunnerGameInit {
  /** Known participant signing identities (device keys the players sign with),
   *  by account root. A hello the witness observes DIRECTLY on its own authored
   *  peer channel (the host's) takes precedence. It is the ground truth of what
   *  that player is actually signing with. Matchmaking / the dev flow supplies
   *  the rest (notably the guest, whose hello is targeted at the host, not us). */
  participants?: ReadonlyArray<{ root: B64u; key: B64u }>
  /** Which color moves FIRST (chess = 'w'). Cross-checked by WitnessCore against
   *  the mirrored start's `config.game.firstMover`; defaults from that config. */
  firstMover?: 'w' | 'b'
  /** RATED ladder binding (§6). Present ⇒ the witness signs kind/tc into its
   *  wend + witnessed result and WitnessCore cross-checks the start's config.
   *  Absent ⇒ unrated (legacy byte shape; no pairing gate). */
  kind?: string
  tc?: { baseMs: number; incMs: number }
  /** A5 J5 pairing anchors for a RATED game (§3/§8). WitnessCore REFUSES to serve
   *  a rated game without them. `'embedder-verified'` asserts the caller already
   *  cross-checked both players' witnessed 'pairing' events against the real
   *  chains (the M1 dev-slice choice); the two per-color `PairingPayload`s are the
   *  M2 form. Ignored on an unrated game. */
  pairing?: 'embedder-verified' | { w: PairingPayload; b: PairingPayload }
  /** Optional pin: follow ONLY a start bearing this exact gameKey (a dev/
   *  matchmaking handoff sanity gate). Absent ⇒ adopt the start's own gameKey. */
  gameKey?: B64u
}

/** The witnessed terminal: everything a segment writer (Lane E) and the peer's
 *  shard/serve layer (Lane B) need from a completed witnessing. */
export interface WitnessedGameResult {
  gameKey: B64u
  result: '1-0' | '0-1' | '1/2-1/2'
  reason: string
  plies: number
  /** Player account roots by color (from the mirrored start). */
  players: { w: B64u; b: B64u }
  /** The witness's terminal STREAM signature: exactly `SegmentPayload.wstream`
   *  for BOTH players' chains. */
  wstream: { wkey: B64u; sig: B64u }
  /** The standalone §3 witnessed-result record (rage-quit denial + the artifact
   *  the peer publishes to shard space for offline reconstruction). */
  record: WitnessedResultRecord
}

export interface WitnessRunnerOpts {
  /** Transport factory: REQUIRED. Prod: `createRtcTransport`; tests: a mock room
   *  factory. Kept injected (like `MpNetSession`) so this module never imports a
   *  concrete transport and stays headless-testable. */
  makeTransport: MpTransportFactory
  /** The witness's OWN wall clock (unix ms): its independent time authority for
   *  wclk `wts` and observed-flag adjudication. Defaults to `Date.now`. */
  now?: () => number
  /** Countersign the clock stream every N verified plies (WitnessCore default 4). */
  wclkEveryPlies?: number
  /** Observed-flag (rage-quit) poll interval (ms). Default 2000. `<= 0` disables
   *  the internal timer: tests drive `handle.tick()` deterministically. */
  tickIntervalMs?: number
  /** Fired (after broadcast) with each emitted witness stream message. */
  onWitnessMsg?: (msg: MpWitnessMsg) => void
  /** Fired ONCE when the game reaches a witnessed terminal. The lead wires this
   *  into the peer service (Lane B): publish `record` to shard space + seed the
   *  witnessed head so the peer can serve `attest` for both players' segment
   *  appends (clientAppendWitnessed). */
  onWitnessed?: (result: WitnessedGameResult) => void
  /** Fired when the follower can no longer countersign this game (a chain
   *  violation poison, a ladder/pairing contradiction, or an unresolved device
   *  key). ADVISORY. A witness never tears a live game down. */
  onError?: (error: string) => void
  /** Optional diagnostic log sink. */
  log?: (msg: string) => void
}

/** Handle over a running witness. */
export interface WitnessRunnerHandle {
  /** The room code being followed. */
  readonly roomCode: string
  /** Drive the observed-flag check once (prod uses the internal timer; tests call
   *  this with an explicit witnessed time to exercise the rage-quit closer). */
  tick(nowWts?: number): void
  /** The witnessed terminal once reached, else null (also delivered via
   *  `onWitnessed`). */
  result(): WitnessedGameResult | null
  /** Leave the room + clear timers. Idempotent. */
  stop(): void
}

/**
 * Join `roomCode` as the witness for one signed, rated game and drive a
 * `WitnessCore` over the host's mirrored stream, broadcasting wclk/wend to both
 * players and producing the witnessed result on terminal.
 */
export function witnessRunner(
  roomCode: string,
  gameInit: WitnessRunnerGameInit,
  witnessIdentity: WitnessRunnerIdentity,
  opts: WitnessRunnerOpts,
): WitnessRunnerHandle {
  const now = opts.now ?? (() => Date.now())
  const tickIntervalMs = opts.tickIntervalMs ?? 2_000
  const log = opts.log ?? (() => {})

  const core = new WitnessCore({
    wpriv: witnessIdentity.priv,
    wkey: witnessIdentity.key,
    wroot: witnessIdentity.root,
    now,
    ...(opts.wclkEveryPlies !== undefined ? { wclkEveryPlies: opts.wclkEveryPlies } : {}),
  })

  // Device keys learned from hellos the witness authored a channel to (the host).
  // Preferred over `participants` when present: ground truth of what is signed.
  const observedKeys = new Map<B64u, B64u>()
  const seededKeys = new Map<B64u, B64u>()
  for (const p of gameInit.participants ?? []) seededKeys.set(p.root, p.key)
  const resolveKey = (root: B64u): B64u | undefined => observedKeys.get(root) ?? seededKeys.get(root)

  const ourHello = makeHello('witness', undefined, undefined, {
    root: witnessIdentity.root,
    key: witnessIdentity.key,
  })

  let transport: MpTransport | null = null
  let stopped = false
  let initialized = false // a WitnessGameInit is live in the core
  let firstMover: 'w' | 'b' = gameInit.firstMover ?? 'w'
  let players: { w: B64u; b: B64u } | null = null
  let terminal: WitnessedGameResult | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null

  const broadcast = (msg: WireMsg): void => {
    // No `toPeer` → the whole room; both players receive it (each seated us via
    // its own onWitnessHello, so each routes it to onWitnessStreamMsg).
    transport?.send(encodeWireMsg(msg))
  }

  const announce = (): void => {
    // Re-announcing is harmless: a duplicate witness hello is ignored once seated
    // (onWitnessHello early-returns on fromPeer === witnessPeerId).
    broadcast(ourHello)
  }

  /** Fan out WitnessCore's emitted messages to both players + the callback. */
  const emitAll = (emit: WireMsg[] | undefined): void => {
    for (const m of emit ?? []) {
      broadcast(m)
      if (m.t === 'wclk' || m.t === 'wend') opts.onWitnessMsg?.(m)
    }
  }

  /** After any feed/tick, capture the terminal exactly once. */
  const captureTerminal = (): void => {
    if (terminal) return
    const wstream = core.wstream()
    if (!wstream) return
    const record = core.buildWitnessedResult()
    if (!record || !players) return
    terminal = {
      gameKey: record.body.game,
      result: record.body.result,
      reason: record.body.reason,
      plies: record.body.plies,
      players: { w: players.w, b: players.b },
      wstream,
      record,
    }
    stopTickTimer()
    log(`witnessed terminal ${terminal.result} (${terminal.reason}) over ${terminal.plies} plies`)
    opts.onWitnessed?.(terminal)
  }

  const startTickTimer = (): void => {
    if (tickTimer || tickIntervalMs <= 0) return
    tickTimer = setInterval(() => runTick(), tickIntervalMs)
  }
  const stopTickTimer = (): void => {
    if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }

  const runTick = (nowWts?: number): void => {
    if (!initialized || terminal || stopped) return
    const res = core.tick(nowWts ?? now())
    emitAll(res.emit)
    captureTerminal()
  }

  /** The mirrored host-authoritative `start`/`rematchStart`: (re)initialize the
   *  core, then feed the message so its consistency + pairing gates run. */
  const onStartLike = (msg: Extract<WireMsg, { t: 'start' } | { t: 'rematchStart' }>): void => {
    // Unsigned game (no gameKey/players): nothing to witness. Degrade silently.
    if (!msg.gameKey || !msg.players) return
    if (gameInit.gameKey !== undefined && msg.gameKey !== gameInit.gameKey) {
      log(`ignoring start for an unexpected gameKey ${msg.gameKey}`)
      return
    }
    // `start` carries config (⇒ firstMover); a `rematchStart` reuses the session
    // config, so keep the prior firstMover.
    if (msg.t === 'start') {
      firstMover = msg.config.game?.firstMover === 'black' ? 'b' : 'w'
    }
    if (gameInit.firstMover !== undefined) firstMover = gameInit.firstMover

    const keyW = resolveKey(msg.players.w)
    const keyB = resolveKey(msg.players.b)
    if (!keyW || !keyB) {
      // No device key for a color ⇒ the witness cannot verify that side's move
      // sigs. Refuse to follow (honest degradation), never a wrong-key follow.
      opts.onError?.(`missing device key for ${!keyW ? 'white' : 'black'}: cannot witness this game`)
      return
    }

    const init: WitnessGameInit = {
      gameId: msg.gameId,
      gameKey: msg.gameKey,
      players: {
        w: { root: msg.players.w, key: keyW },
        b: { root: msg.players.b, key: keyB },
      },
      firstMover,
      ...(gameInit.kind !== undefined ? { kind: gameInit.kind } : {}),
      ...(gameInit.tc !== undefined ? { tc: gameInit.tc } : {}),
      ...(gameInit.pairing !== undefined ? { pairing: gameInit.pairing } : {}),
    }
    core.init(init)
    players = { w: msg.players.w, b: msg.players.b }
    initialized = true
    terminal = null // a fresh (re)match resets the terminal latch

    // Feed the start itself so WitnessCore runs its start-consistency +
    // ladder/players/pairing gates (a contradiction poisons the follower).
    const res = core.feed(msg, now())
    if (!res.ok) opts.onError?.(res.error ?? 'witness rejected the start')
    else {
      log(`following ${gameInit.kind !== undefined ? 'rated' : 'unrated'} game ${msg.gameKey} (gameId ${msg.gameId})`)
      startTickTimer()
    }
  }

  /** Feed one committed in-game message, broadcast any countersignatures. */
  const feedAndBroadcast = (msg: WireMsg): void => {
    if (!initialized) {
      // A move before the start can only happen on a reordered transport; ours is
      // reliable-ordered, so this is a diagnostic, not a normal path.
      log(`dropping ${msg.t} before start`)
      return
    }
    const res = core.feed(msg, now())
    emitAll(res.emit)
    if (!res.ok && res.error) opts.onError?.(res.error)
    captureTerminal()
  }

  const onMessage = (text: string): void => {
    if (stopped) return
    const msg = parseWireMsg(text)
    if (!msg) return
    switch (msg.t) {
      case 'hello':
        // Learn a player's device signing key from its hello (the host's reaches
        // us; the guest's is targeted at the host, hence `participants`).
        if ((msg.role === 'host' || msg.role === 'guest') && msg.root && msg.key) {
          observedKeys.set(msg.root, msg.key)
        }
        return
      case 'start':
      case 'rematchStart':
        onStartLike(msg)
        return
      // Our own outputs / another witness's / control noise. Never fed.
      case 'wclk':
      case 'wend':
      case 'error':
      case 'bye':
      case 'ping':
      case 'pong':
        return
      default:
        feedAndBroadcast(msg)
    }
  }

  const listeners: MpTransportListeners = {
    onMessage: (text) => onMessage(text),
    // A newcomer (host on our join; guest when it arrives) must learn we are a
    // witness so it seats us and later routes our wclk/wend to onWitnessStream.
    onPeerJoin: () => announce(),
    onPeerLeave: () => {},
    onSendError: (err) => log(`send error: ${String(err)}`),
  }

  // Create the transport (sync or async factory), then announce to any peers
  // already present. A microtask beats the transport's first (macrotask) peer
  // delivery, so `transport` is set before onPeerJoin fires. A synchronous
  // throw from the factory routes to onError too (never out of the caller).
  try {
    void Promise.resolve(opts.makeTransport(roomCode, listeners))
      .then((t) => {
        if (stopped) {
          t.close()
          return
        }
        transport = t
        announce()
      })
      .catch((err) => opts.onError?.(`transport failed: ${String(err)}`))
  } catch (err) {
    opts.onError?.(`transport failed: ${String(err)}`)
  }

  return {
    roomCode,
    tick: (nowWts?: number) => runTick(nowWts),
    result: () => terminal,
    stop: () => {
      if (stopped) return
      stopped = true
      stopTickTimer()
      const t = transport
      transport = null
      t?.close()
    },
  }
}
