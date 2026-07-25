// onlineStore: the app-lifetime home of a live internet game (the B1 fix).
//
// This is a PLAIN module singleton with NO React imports: it runs unchanged in
// bare node against a mocked `mp` (scripts/test-mp-store.mjs). The React binding
// lives in useOnlineGame.ts (useSyncExternalStore); OnlineTab becomes a pure view
// that reads this store and never touches the session on unmount. Navigating away
// and back re-attaches to the SAME live game (MP-01/L2).
//
// The store subscribes to `mp.onEvent` exactly ONCE at module init, for the
// lifetime of the process. Everything the session reports (§8 MpEvent v3) flows
// through the single event pump below; every action the UI can take is a method
// on the exported `onlineStore`. State is a single immutable snapshot object.
// Every mutation replaces it wholesale and notifies subscribers.
//
// Authority split (unchanged from the session design): the HOST owns clocks and
// flagging; this store never runs a clock of its own for adjudication. It DOES
// interpolate a display clock (Clock.tsx) from the authoritative snapshot the
// session hands it, and it applies moves locally with chessops purely to render
// the board and to detect board-terminal endings (→ mp.gameEnded).

import type { MpByo, MpColor, MpEvent, MpGameConfig, MpClocks } from '@shared/types'
import { mp } from './mpClient'
// A6 (Lane C): TYPE-ONLY. Fully erased at bundle, so the bare-node store test
// (which mocks `mp`) never pulls the session/accounts/crypto stack.
import type { MpSigningConfig, MpWitnessMsg } from './mpSession'
import type { SignedMove } from '@shared/accounts/segment'
import { afterMoveCredit, consumeElapsed, normalizeByoyomi, type SideClock } from '../byoyomi'
import { applyMove, INITIAL_FEN, type Color, type GameResult } from '../../../chess/chess'
import {
  adapterFromSpec,
  registerOnlineGameAdapter,
  resolveOnlineGameAdapter,
  type OnlineGameAdapter,
  type OnlineMoveMeta
} from './gameAdapter'
import { chessOnlineAdapter } from './chessAdapter'
import { getGame, listGames } from '../../../games/registry'
import type { GameKind } from '../../../games/kernel'
import type { SoundName } from '../../../sound/SoundManager'
import { treeToPgn } from '../../../state/pgn'
import type { TreeNode } from '../../../state/gameTree'
import type { GameViewBanner } from '../GameView'

// ---------------------------------------------------------------------------
// Sound seam (documented for builder-ui).
//
// The store must run in bare node (test-mp-store.mjs), but the SoundManager
// module pulls Vite-only `import.meta.glob` at import time, so the store can NOT
// statically import it. Instead the store computes WHICH sound to play and hands
// the name to a registered sink. The UI wires the real sink once, from a
// top-level effect:
//   onlineStore.setSoundSink((name) => getSoundManager().play(name))
// Until registered (and always in bare node) the sink is a silent no-op.
//
// The low-time one-shot is NOT here. It lives in Clock.tsx's onLowTime hook,
// which the view gates on settings.lowTimeWarning.
// ---------------------------------------------------------------------------

/** Pure move→sound mapping (mirrors sound/useSound.soundForMove; inlined so the
 *  store stays free of the Vite-glob SoundManager import). */
function soundNameForMove(m: { san: string; capture: boolean; check: boolean }): SoundName {
  if (m.san.includes('=')) return 'promote'
  if (m.san.startsWith('O-O')) return 'castle'
  if (m.check) return 'check'
  if (m.capture) return 'capture'
  return 'move'
}

// ---------------------------------------------------------------------------
// Public state shape (§4, verbatim contract with builder-ui).
// ---------------------------------------------------------------------------

export interface OnlineClock {
  /** Remaining ms per side at `atMono`. With byo-yomi, a side that is `inByo`
   *  reads its CURRENT period's remaining ms here (main time before that). */
  snapshot: { white: number; black: number }
  /** performance.now() instant the snapshot was taken. */
  atMono: number
  /** Side currently burning time (interpolate it down), or null when idle. */
  running: 'white' | 'black' | null
  /** v5: per-side byo-yomi snapshot (periods left / inByo), present only when
   *  the game's tc has byoyomi. Display readers pair it with config.tc.byoyomi. */
  byo?: MpByo
}

export interface OnlineState {
  phase: 'idle' | 'hosting' | 'connecting' | 'game'
  code: string | null
  config: MpGameConfig | null
  gameId: number
  myColor: 'white' | 'black'
  orientation: 'white' | 'black'
  /** Registry kind of the live/last game ('chess' when idle. Wire default). */
  gameKind: string
  moves: string[] // codec moves from the start position (chess: UCIs)
  fen: string // the adapter's positionKey (chess: the FEN). Chess boards read this
  /** The adapter's opaque game state: non-chess board renderers consume it
   *  directly (GameBoardProps.state). Chess: the FEN string (=== fen). */
  boardState: unknown
  plyCount: number
  clock: OnlineClock | null
  banner: GameViewBanner | null
  drawOffered: boolean // the OPPONENT has an offer standing to us
  drawSent: boolean // WE have an offer standing to them
  drawBlockedUntilPly: number // our next allowed offer ply (cooldown / pre-ply-2)
  rematchOffered: boolean // the opponent offered a rematch
  rematchSent: boolean // we offered a rematch
  peerAway: { deadlineMono: number } | null
  peerLeft: boolean
  canAbort: boolean // plyCount < 2 && live
  opponentName: string // default 'Opponent'
  netStage: 'relays' | 'searching' | 'connecting' | null
  relays: { connected: number; total: number } | null
  error: string | null
}

/** Live settings the store needs but cannot read from a React context. Pushed by
 *  the UI via `setSettings` whenever they change (see useOnlineGame). */
export interface OnlineSettingsSnapshot {
  username: string
  /** Gate for the one-shot low-time sound (settings.lowTimeWarning). */
  lowTimeWarning: boolean
}

// ---------------------------------------------------------------------------
// A6 (Lane C): signed rated play seams.
//
// The store stays free of the accounts/crypto import (the bare-node store test
// mocks `mp` and never bundles it): the signed-in device key arrives through a
// PROVIDER the app boot wires (useOnlineGame.ts), exactly like setSoundSink; and
// a finished signed+witnessed game's SEGMENT is handed to a PUBLISHER the lead
// wires to Lane E's buildAndPublishSegment. The store only decides rated↔casual
// and assembles the writer's inputs: it never reimplements crypto.
// ---------------------------------------------------------------------------

/** The verified terminal witness end-signature (wend) surfaced by the session. */
export type MpWitnessEnd = Extract<MpWitnessMsg, { t: 'wend' }>

/** Everything Lane E's segment writer needs from a finished SIGNED, WITNESSED,
 *  rated game to build + append the countersigned segment to THIS player's
 *  chain. Opponent head/profile/checkpoint come from Lane E's own pre-game
 *  snapshot (preGame.ts), not from here. */
export interface SignedGameOutcome {
  /** Verified signed-play material from the session (mp.getSignedGame()). */
  signed: { gameKey: string; players: { w: string; b: string }; moves: readonly SignedMove[] }
  /** The seated witness identity (mp.getWitnessIdentity()). */
  witness: { root: string; key: string }
  /** The witness's terminal countersignature (from mp.onWitnessStream). */
  wend: MpWitnessEnd
  /** OUR color in the finished game. */
  color: 'w' | 'b'
  /** The result/reason THIS client recorded (its own chain claim; the wend
   *  carries the witness-adjudicated result/transcript for cross-check). */
  result: GameResult
  reason: string
  /** A4 ladder binding (§6) derived from the game config. */
  kind: string
  tc: { baseMs: number; incMs: number }
  /** The full game config, for any further derivation the writer needs. */
  config: MpGameConfig
}

/** The Lane E seam: build + publish THIS player's segment. Wired by the lead
 *  (useOnlineGame.ts) to segmentWriter.buildAndPublishSegment. */
export type SegmentPublisher = (outcome: SignedGameOutcome) => void

// ---------------------------------------------------------------------------
// Constants (mirrors the session's §2 rules so both sides agree locally).
// ---------------------------------------------------------------------------

/** After a decline, the SAME side waits this many plies before re-offering. */
const DRAW_COOLDOWN_PLIES = 20
/** No draw offers before this ply (game is still abortable), lichess parity. */
const DRAW_MIN_PLY = 2
const OPPONENT_DEFAULT = 'Opponent'

// ---------------------------------------------------------------------------
// PGN name helpers (MP-09).
// ---------------------------------------------------------------------------

/** Sanitize a display name for headers/UI: trim, strip control chars, cap 24. */
function cleanName(raw: string | undefined | null): string {
  if (!raw) return ''
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 24)
}

function yyyymmdd(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}.${m}.${day}`
}

function outcomeForUser(result: GameResult, userColor: Color): 'win' | 'loss' | 'draw' {
  if (result === '1/2-1/2') return 'draw'
  const userWon = (result === '1-0' && userColor === 'white') || (result === '0-1' && userColor === 'black')
  return userWon ? 'win' : 'loss'
}

// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------

const FRESH: OnlineState = {
  phase: 'idle',
  code: null,
  config: null,
  gameId: 0,
  myColor: 'white',
  orientation: 'white',
  gameKind: 'chess',
  moves: [],
  fen: INITIAL_FEN,
  boardState: INITIAL_FEN,
  plyCount: 0,
  clock: null,
  banner: null,
  drawOffered: false,
  drawSent: false,
  drawBlockedUntilPly: DRAW_MIN_PLY,
  rematchOffered: false,
  rematchSent: false,
  peerAway: null,
  peerLeft: false,
  canAbort: false,
  opponentName: OPPONENT_DEFAULT,
  netStage: null,
  relays: null,
  error: null
}

// The built-in default game. Registered at module init so 'chess' (and an
// absent config.game: full back-compat) always resolves. Chess keeps its
// dedicated adapter (SAN-producing moveMeta feeds the PGN archive).
registerOnlineGameAdapter(chessOnlineAdapter)
// Every OTHER kernel game bridges in from the registry (spec §Wire-v4): any
// registered game is automatically hostable/joinable online.
for (const entry of listGames()) {
  if (entry.spec.kind === 'chess') continue
  registerOnlineGameAdapter(adapterFromSpec(entry.spec))
}

/** Resolve the online adapter for a kind, bridging registry entries that were
 *  registered AFTER module init (the custom-variant dynamic seam) on demand. */
function onlineAdapterFor(kind: string): OnlineGameAdapter<unknown> | null {
  const existing = resolveOnlineGameAdapter(kind)
  if (existing) return existing
  const entry = getGame(kind as GameKind)
  if (!entry) return null
  const adapter = adapterFromSpec(entry.spec)
  registerOnlineGameAdapter(adapter)
  return adapter
}

class OnlineStore {
  private state: OnlineState = FRESH
  private readonly subscribers = new Set<() => void>()

  /** The kernel for the CURRENT game (spec §Wire-v4). Chess by default; swapped
   *  per game at start from config.game.kind. All rules-shaped questions (apply
   *  a move, terminal check, whose turn) go through it. Never chessops direct. */
  private adapter: OnlineGameAdapter<unknown> = chessOnlineAdapter as OnlineGameAdapter<unknown>

  /** The adapter's opaque game state (chess: the FEN). Mirrors state.moves;
   *  state.fen is always adapter.positionKey(gameState) for the UI board. */
  private gameState: unknown = chessOnlineAdapter.init()

  /** Live settings snapshot (UI pushes it). Defaults keep bare-node tests sane. */
  private settings: OnlineSettingsSnapshot = { username: 'User', lowTimeWarning: true }

  /**
   * SAN for each committed ply (parallel to state.moves), so we can build a PGN
   * without a React game tree. Kept off the public snapshot (render doesn't need
   * it) and rebuilt on every fresh game / resync.
   */
  private sans: string[] = []
  /** True once this game's result has been persisted (save-exactly-once). */
  private saved = false

  /** Registered sound sink (UI wires it to getSoundManager().play). No-op until
   *  registered, and always in bare node, where the sound module can't load. */
  private soundSink: ((name: SoundName) => void) | null = null

  /** A6 (Lane C): provider for the signed-in device signing key (boot wires it
   *  to mpSigningKey). null ⇒ no key ⇒ casual/unsigned (byte-identical v5). */
  private signingKeyProvider: (() => MpSigningConfig | null) | null = null
  /** A6 (Lane C): the Lane E segment writer, wired by the lead. null ⇒ segments
   *  aren't published (the game still plays; it just isn't chain-written). */
  private segmentPublisher: SegmentPublisher | null = null
  /** A6 (Lane C): latest verified witness wend for the CURRENT game (from
   *  mp.onWitnessStream), or null. Reset per game. */
  private lastWend: MpWitnessEnd | null = null
  /** A6 (Lane C): the result/reason captured when a SIGNED game ended, awaiting
   *  the witness wend to assemble the segment. Reset per game. */
  private pendingSegment: { result: GameResult; reason: string } | null = null
  /** A6 (Lane C): publish-at-most-once guard for the current game's segment. */
  private segmentPublished = false

  constructor() {
    // Subscribe to the session ONCE, for the app's lifetime. Never unsubscribed.
    mp.onEvent((ev) => this.onEvent(ev))
    // Register the host-side legality check (kernel seam, wire v4): the session
    // relays opaque strings and consults us before committing a guest move.
    // Optional-chained: the bare-node store test mocks `mp` without this method,
    // and the seam's default (unregistered) is accept. Chess-identical.
    mp.setMoveValidator?.((moves, move) => this.validateGuestMove(moves, move))
    // A6 (Lane C): collect the verified witness stream. Only the terminal wend
    // assembles a segment; the mock mp (bare-node store test) lacks this method
    // (optional-chained ⇒ no-op there), and it never fires for an unsigned game.
    mp.onWitnessStream?.((msg) => this.onWitnessMsg(msg))
  }

  /** Host-side legality gate for GUEST moves (called by the session pre-commit).
   *  Judged with the current game's kernel. Defensive: if our mirrored state
   *  isn't at the ply the session is committing (mid-resync races), accept:
   *  authority/behavior then matches pre-v4 exactly. */
  private validateGuestMove(moves: readonly string[], move: string): boolean {
    if (this.state.phase !== 'game') return true
    if (moves.length !== this.state.plyCount) return true
    return this.adapter.play(this.gameState, move) !== null
  }

  // ---- store plumbing ------------------------------------------------------

  getState(): OnlineState {
    return this.state
  }

  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }

  /** Replace the snapshot and notify. All mutations funnel through here. */
  private set(patch: Partial<OnlineState>): void {
    this.state = { ...this.state, ...patch }
    for (const cb of this.subscribers) cb()
  }

  /** Push the live settings snapshot (username, low-time gate). UI-driven. */
  setSettings(s: OnlineSettingsSnapshot): void {
    this.settings = { username: s.username, lowTimeWarning: s.lowTimeWarning }
  }

  /** Register the sound sink (UI: getSoundManager().play). See the seam note at
   *  the top of this file. Passing null detaches it. */
  setSoundSink(sink: ((name: SoundName) => void) | null): void {
    this.soundSink = sink
  }

  /** A6 (Lane C): register the signed-in device signing-key provider (boot wires
   *  it to mpSigningKey). null detaches ⇒ rated games honestly degrade to casual
   *  when signed out or unwired. */
  setSigningKeyProvider(provider: (() => MpSigningConfig | null) | null): void {
    this.signingKeyProvider = provider
  }

  /** A6 (Lane C): register the segment writer (lead wires it to Lane E's
   *  buildAndPublishSegment). null detaches ⇒ no segment is published. */
  setSegmentPublisher(publisher: SegmentPublisher | null): void {
    this.segmentPublisher = publisher
  }

  // ---- derived helpers -----------------------------------------------------

  /** Whether a live, undecided game is in progress (board is playable). */
  private get live(): boolean {
    return this.state.phase === 'game' && this.state.banner === null && !this.state.peerLeft
  }

  private get myTurn(): Color {
    return this.adapter.turn(this.gameState)
  }

  private sound(name: SoundName): void {
    this.soundSink?.(name)
  }

  // ---- clock snapshot ------------------------------------------------------

  /** Adopt an authoritative clock snapshot, timestamped to now (monotonic). The
   *  running side is whoever is on move, unless the game is over/idle (null).
   *  The byo snapshot (v5) is adopted when the event carries one and carried
   *  forward otherwise, so optimistic re-anchors never drop it. */
  private setClock(clocks: MpClocks, running: 'white' | 'black' | null, byo?: MpByo): void {
    const carried = byo ?? this.state.clock?.byo
    this.set({
      clock: {
        snapshot: { white: clocks.white, black: clocks.black },
        atMono: performance.now(),
        running,
        ...(carried ? { byo: carried } : {})
      }
    })
  }

  /** The game's byo-yomi spec (null = plain Fischer). */
  private byoSpec(): ReturnType<typeof normalizeByoyomi> {
    return normalizeByoyomi(this.state.config?.tc.byoyomi ?? null)
  }

  // ---- game lifecycle ------------------------------------------------------

  /** Begin (or restart via rematch) a fresh game. Resets board + offer flags.
   *  Games whose rules engine loads asynchronously (ffish WASM) hold in a
   *  net-ish 'connecting' state until preload resolves, then start. */
  private beginGame(gameId: number, yourColor: MpColor, cfg: MpGameConfig, opponentName?: string): void {
    // Resolve the game kernel (wire v4): absent config.game = chess, always
    // registered. An unknown kind (start from a build with more games) surfaces
    // as a friendly error instead of corrupting state with the wrong rules.
    const kind = cfg.game?.kind ?? 'chess'
    const adapter = onlineAdapterFor(kind)
    if (!adapter) {
      this.set({ error: `This build can't play '${kind}' games online yet.` })
      return
    }
    if (adapter.preload && adapter.needsPreload?.()) {
      // The joiner learns the kind only at 'start': load the rules engine
      // now, surfaced as the tail of the connection dance. Early wire traffic
      // is impossible in practice (the opponent's first move takes longer than
      // the WASM load) and dropped safely by the gameId gate if it happens.
      this.set({ phase: 'connecting', config: cfg, netStage: 'connecting', error: null })
      void adapter.preload().then(
        () => this.startGame(gameId, yourColor, cfg, adapter, opponentName),
        (err) =>
          this.set({
            phase: 'idle',
            error: err instanceof Error ? err.message : `Couldn't load the ${kind} rules engine.`
          })
      )
      return
    }
    this.startGame(gameId, yourColor, cfg, adapter, opponentName)
  }

  /** The synchronous tail of beginGame. Adapter is resolved and preloaded. */
  private startGame(
    gameId: number,
    yourColor: MpColor,
    cfg: MpGameConfig,
    adapter: OnlineGameAdapter<unknown>,
    opponentName?: string
  ): void {
    this.adapter = adapter
    try {
      this.gameState = adapter.init(cfg.game?.options)
    } catch {
      // Corrupt/unsupported options from the peer: friendly error, no board.
      this.set({ error: `Couldn't start a '${adapter.kind}' game with these options.` })
      return
    }
    this.sans = []
    this.saved = false
    // A6 (Lane C): reset per-game segment state. A prior game's wend/terminal
    // must never leak into this one (a signed rematch mints a fresh game key).
    this.lastWend = null
    this.pendingSegment = null
    this.segmentPublished = false
    const initial = cfg.tc.initialMs
    this.set({
      phase: 'game',
      config: cfg,
      gameId,
      myColor: yourColor,
      orientation: yourColor,
      gameKind: adapter.kind,
      moves: [],
      fen: adapter.positionKey(this.gameState),
      boardState: this.gameState,
      plyCount: 0,
      // Clocks are IDLE at start (§2 first-move rule): running = null until
      // white's first move commits.
      clock: initial > 0 ? { snapshot: { white: initial, black: initial }, atMono: performance.now(), running: null } : null,
      banner: null,
      drawOffered: false,
      drawSent: false,
      drawBlockedUntilPly: DRAW_MIN_PLY,
      rematchOffered: false,
      rematchSent: false,
      peerAway: null,
      peerLeft: false,
      canAbort: true, // plyCount 0 < 2 && live
      opponentName: cleanName(opponentName) || OPPONENT_DEFAULT,
      error: null
    })
    this.sound('gameStart')
  }

  /** Append a committed ply: adopt the adapter's next state and mirror its
   *  position key into state.fen for the UI. */
  private pushMove(move: string, next: unknown, meta: OnlineMoveMeta): void {
    this.gameState = next
    this.sans.push(meta.san)
    const moves = [...this.state.moves, move]
    this.set({
      moves,
      fen: this.adapter.positionKey(next),
      boardState: next,
      plyCount: moves.length,
      canAbort: moves.length < 2 && this.live
    })
  }

  /** The sound for a just-committed move: the spec's own hint when the adapter
   *  provides one (kernel games), else the chess SAN heuristics. */
  private moveSound(meta: OnlineMoveMeta): SoundName {
    return meta.sound ?? soundNameForMove(meta)
  }

  /** Raise the end banner + persist (once) + play the end sound. `save` gates
   *  persistence: aborted / abandoned-without-claim games raise a banner (or
   *  none) but are NOT saved. */
  private endGame(result: GameResult | null, reason: string, opts: { save: boolean; title?: string }): void {
    if (this.state.banner) return // already ended
    if (result) {
      const banner: GameViewBanner = {
        result,
        reason,
        outcomeForUser: outcomeForUser(result, this.state.myColor),
        ...(opts.title ? { title: opts.title } : {})
      }
      this.set({ banner, clock: this.frozenClock(), canAbort: false })
      if (opts.save) {
        this.saveFinished(result)
        // A6 (Lane C): if this was a SIGNED game, remember its terminal so the
        // countersigned segment is published once the witness wend lands. Inert
        // for casual/unsigned games and when no segment writer is wired.
        this.captureSignedTerminal(result, reason)
      }
    } else {
      // Aborted / neutral end: a titled banner with a synthetic draw result so
      // the view can render it, but never saved (opts.save must be false).
      const banner: GameViewBanner = {
        result: '1/2-1/2',
        reason,
        outcomeForUser: 'draw',
        title: opts.title ?? 'Game aborted'
      }
      this.set({ banner, clock: this.frozenClock(), canAbort: false })
    }
    this.sound('gameEnd')
  }

  /** Restart interpolation from the frozen snapshot: the side on move resumes
   *  burning from now. No-op when idle/over or untimed. */
  private resumedClock(): OnlineClock | null {
    const c = this.state.clock
    if (!c || !this.live) return c
    return {
      snapshot: { ...c.snapshot },
      atMono: performance.now(),
      running: this.adapter.turn(this.gameState),
      ...(c.byo ? { byo: c.byo } : {})
    }
  }

  /** Freeze the current clock (stop interpolating) at its displayed value.
   *  With byo-yomi the freeze crosses period boundaries exactly like the host
   *  will rule (display-only; the next authoritative snapshot corrects drift). */
  private frozenClock(): OnlineClock | null {
    const c = this.state.clock
    if (!c) return null
    if (c.running === null) return c
    const now = performance.now()
    const elapsed = Math.max(0, now - c.atMono)
    const side = c.running
    const burned = consumeElapsed(
      {
        remainingMs: c.snapshot[side],
        periodsLeft: c.byo?.[side].periodsLeft ?? 0,
        inByo: c.byo?.[side].inByo ?? false
      },
      elapsed,
      this.byoSpec()
    ).clock
    const snap = { ...c.snapshot, [side]: burned.remainingMs }
    const byo = c.byo
      ? { ...c.byo, [side]: { periodsLeft: burned.periodsLeft, inByo: burned.inByo } }
      : undefined
    return { snapshot: snap, atMono: now, running: null, ...(byo ? { byo } : {}) }
  }

  /** Persist a finished game exactly once (≥2 plies + a real result). Aborted /
   *  unclaimed-abandoned games never reach here with save:true.
   *
   *  Archive format (the game table's `pgn` column): standard chess keeps the
   *  real PGN writer (byte-for-byte the pre-v4 output); every other game gets
   *  the generic serialization: PGN-style tags (incl. [Variant "<kind>"]) +
   *  the wire-codec move list joined by spaces. */
  private saveFinished(result: GameResult): void {
    if (this.saved) return
    if (this.state.plyCount < 2) return // not a real game: don't archive
    this.saved = true
    const uc = this.state.myColor
    const me = cleanName(this.settings.username) || 'Anonymous'
    const opp = this.state.opponentName || OPPONENT_DEFAULT
    const whiteName = uc === 'white' ? me : opp
    const blackName = uc === 'white' ? opp : me
    const headers: Record<string, string> = {
      Event: 'Online game',
      Site: 'nodechess',
      Date: yyyymmdd(),
      White: whiteName,
      Black: blackName,
      Result: result
    }
    const pgn =
      this.adapter.kind === 'chess'
        ? treeToPgn(this.buildTree(), headers)
        : genericArchive(this.adapter.kind, headers, this.state.moves, result)
    // Best-effort; never block the banner on a failed save. (window.api is
    // undefined in bare-node tests. Guarded.)
    void (globalThis as { window?: typeof window }).window?.api?.games
      ?.save({
        pgn,
        whiteName,
        blackName,
        userColor: uc,
        result,
        opponentKind: 'human',
        opponentLabel: opp,
        source: 'online',
        // Non-chess kinds are archived but hidden from the chess Analysis list.
        gameKind: this.adapter.kind
      })
      .catch(() => {})
  }

  /** Rebuild a minimal linear game tree (root → mainline) from moves+sans so we
   *  can reuse the shared PGN writer without holding a React tree. */
  private buildTree(): TreeNode {
    const root: TreeNode = { id: 'r', ply: 0, fen: INITIAL_FEN, parent: null, children: [] }
    let node = root
    let fen = INITIAL_FEN
    for (let i = 0; i < this.state.moves.length; i++) {
      const uci = this.state.moves[i]
      const m = applyMove(fen, uci.slice(0, 2), uci.slice(2, 4), uciPromo(uci))
      if (!m) break // defensive: stop at the first inconsistency
      fen = m.fen
      const child: TreeNode = {
        id: `n${i + 1}`,
        ply: i + 1,
        move: { san: this.sans[i] ?? m.san, uci: m.uci, capture: m.capture, check: m.check },
        fen: m.fen,
        parent: node,
        children: []
      }
      node.children.push(child)
      node = child
    }
    return root
  }

  // ==========================================================================
  // Event pump: one entry per §8 MpEvent v3 variant.
  // ==========================================================================

  private onEvent(ev: MpEvent): void {
    switch (ev.type) {
      case 'net':
        this.set({ netStage: ev.state, ...(ev.relays ? { relays: ev.relays } : {}) })
        return

      case 'peer-joined':
        // Host only; 'start' follows immediately. Nothing to render on its own.
        return

      case 'start':
        this.beginGame(ev.gameId, ev.yourColor, ev.config, ev.opponentName)
        return

      case 'move':
        this.onRemoteMove(ev.gameId, ev.ply, ev.uci, ev.clockMs, ev.byo)
        return

      case 'clock':
        // Host ack after committing our move, and periodic re-sync. Trust it.
        if (ev.gameId !== this.state.gameId) return
        this.setClock(ev.clockMs, this.live ? ev.toMove : null, ev.byo)
        return

      case 'flag':
        this.onFlag(ev.gameId, ev.by, ev.clockMs, ev.byo)
        return

      case 'abort':
        if (ev.gameId !== this.state.gameId) return
        // No result, nothing saved. Neutral banner.
        this.endGame(null, 'Game aborted', {
          save: false,
          title: ev.reason === 'no-first-move' ? 'Game aborted: no first move' : 'Game aborted'
        })
        return

      case 'gameOver':
        if (ev.gameId !== this.state.gameId) return
        // Board-terminal ending confirmed by the peer. Adopt its result/reason.
        this.endGame(ev.result, ev.reason, { save: true })
        return

      case 'drawOffer':
        if (!this.live) return
        this.set({ drawOffered: true })
        this.sound('gameStart') // notify-style cue for an incoming offer
        return

      case 'drawDecline':
        // Our standing offer was declined: clear it; UI shows "declined".
        this.set({ drawSent: false })
        return

      case 'drawAccept':
        this.endGame('1/2-1/2', 'by agreement', { save: true })
        return

      case 'resign':
        // Genuine resignation only (flags come via 'flag'). Winner = other side.
        this.endGame(ev.by === 'white' ? '0-1' : '1-0', 'by resignation', { save: true })
        return

      case 'rematchOffer':
        if (!this.state.banner) return // only meaningful post-game
        this.set({ rematchOffered: true })
        this.sound('gameStart')
        return

      case 'rematchDecline':
        this.set({ rematchSent: false, rematchOffered: false })
        return

      case 'rematchStart':
        // Host committed a mutual rematch: fresh game, swapped colors, gameId+1.
        this.beginGame(ev.gameId, ev.yourColor, this.state.config as MpGameConfig, this.state.opponentName)
        return

      case 'peer-away':
        // Live undecided game froze: pause clock, start the reconnect countdown.
        this.set({
          peerAway: { deadlineMono: performance.now() + ev.graceMs },
          clock: this.frozenClock()
        })
        return

      case 'peer-back':
        // Resume immediately: re-arm the display clock for the side on move so it
        // ticks again without waiting for the host's next re-sync (which corrects
        // any drift). The snapshot value is the frozen one. We only restart it.
        this.set({
          peerAway: null,
          clock: this.resumedClock()
        })
        return

      case 'peer-left':
        // Grace expired: opponent is gone. UI offers Claim victory / Abort.
        this.set({ peerAway: null, peerLeft: true })
        return

      case 'error':
        // In-game errors surface in the status strip; lobby errors in the alert
        // row. Either way, never silent. A pre-game error drops toward the menu.
        this.set({ error: ev.message, ...(this.state.phase === 'game' ? {} : { phase: 'idle' }) })
        return
    }
  }

  /** Apply a move the REMOTE peer made (drop stale gameId / out-of-order ply). */
  private onRemoteMove(gameId: number, ply: number, uci: string, clockMs: MpClocks, byo?: MpByo): void {
    if (gameId !== this.state.gameId) return
    if (ply !== this.state.plyCount) return // duplicate / out-of-order: drop (D8)
    const meta = this.adapter.moveMeta(this.gameState, uci) ?? { san: uci, capture: false, check: false }
    const next = this.adapter.play(this.gameState, uci)
    if (next === null) return // illegal against our state: ignore rather than corrupt
    this.pushMove(uci, next, meta)
    this.sound(this.moveSound(meta))
    // Adopt the authoritative clocks; the side now on move is the running side.
    this.setClock(clockMs, this.live ? this.adapter.turn(next) : null, byo)
    this.detectTerminal(next)
  }

  /** After any local/remote move: if the game itself ended (kernel-terminal),
   *  tell the session so it stops clocks + broadcasts gameOver, and raise our
   *  banner. `s` is the adapter state AFTER the move. */
  private detectTerminal(s: unknown): void {
    const out = this.adapter.result(s)
    if (!out) return
    mp.gameEnded(out.result, out.reason)
    this.endGame(out.result, out.reason, { save: true })
  }

  /** A side flagged (§2 Flag). Adjudication is the adapter's call, made on the
   *  SAME position both stores hold, so results agree: chess family applies
   *  the lichess insufficient-material draw, everything else is a plain loss
   *  on time (the fallback below, for adapters without the hook). */
  private onFlag(gameId: number, by: MpColor, clockMs: MpClocks, byo?: MpByo): void {
    if (gameId !== this.state.gameId) return
    // Zero the flagged side's displayed clock from the message.
    this.setClock(clockMs, null, byo)
    const adjudicated = this.adapter.flagResult?.(this.gameState, by)
    if (adjudicated) {
      this.endGame(adjudicated.result, adjudicated.reason, { save: true })
    } else {
      this.endGame(by === 'white' ? '0-1' : '1-0', 'on time', { save: true })
    }
  }

  // ==========================================================================
  // A6 (Lane C): signed rated play wiring.
  // ==========================================================================

  /** Configure the session's signed-play identity BEFORE host()/join(). Rated +
   *  signed-in ⇒ offer our device key (the game becomes SIGNED only if the
   *  opponent's hello ALSO carries identity. Honest degradation otherwise).
   *  Casual, signed-out, or no provider ⇒ null, which also CLEARS any prior
   *  rated identity so casual play is byte-identical v5. `oppRoot` pins a
   *  specific opponent when the matchmaker knows it (M2). */
  private applySigning(rated: boolean, oppRoot?: string): void {
    if (!rated) {
      mp.configureSigning?.(null)
      return
    }
    const key = this.signingKeyProvider?.() ?? null
    mp.configureSigning?.(key ? { ...key, ...(oppRoot ? { oppRoot } : {}) } : null)
  }

  /** A verified witness stream message arrived. wclk is advisory (display only
   *  in M1); the terminal wend is what a segment is built from. Ignores a wend
   *  addressed to a stale game. */
  private onWitnessMsg(msg: MpWitnessMsg): void {
    if (msg.t !== 'wend') return
    if (msg.gameId !== this.state.gameId) return
    this.lastWend = msg
    this.maybePublishSegment()
  }

  /** A SIGNED game reached a saveable terminal: remember result/reason and try
   *  to publish (the witness wend may already be in hand, or land moments later).
   *  Inert for casual/unsigned games and when no writer is wired. */
  private captureSignedTerminal(result: GameResult, reason: string): void {
    if (this.segmentPublished || this.pendingSegment) return
    if (!this.segmentPublisher) return
    if (!mp.getSignedGame?.()) return // casual/unsigned game ⇒ no segment
    this.pendingSegment = { result, reason }
    this.maybePublishSegment()
  }

  /** Hand the finished SIGNED, WITNESSED game to Lane E's writer once BOTH the
   *  terminal (pendingSegment) and the witness wend are present. At-most-once.
   *  No seated witness ⇒ no segment (honest: an unwitnessed rated game is not a
   *  countersigned segment). Both players run this independently for their own
   *  chain, embedding the SAME witness wstream. */
  private maybePublishSegment(): void {
    if (this.segmentPublished) return
    const pending = this.pendingSegment
    const wend = this.lastWend
    const publisher = this.segmentPublisher
    if (!pending || !wend || !publisher) return
    const signed = mp.getSignedGame?.()
    const witness = mp.getWitnessIdentity?.() ?? null
    const cfg = this.state.config
    if (!signed || !witness || !cfg) return
    this.segmentPublished = true
    this.pendingSegment = null
    publisher({
      signed,
      witness,
      wend,
      color: this.state.myColor === 'white' ? 'w' : 'b',
      result: pending.result,
      reason: pending.reason,
      kind: cfg.game?.kind ?? 'chess',
      tc: { baseMs: cfg.tc.initialMs, incMs: cfg.tc.incrementMs },
      config: cfg
    })
  }

  // ==========================================================================
  // Actions (§4): everything the UI can invoke.
  // ==========================================================================

  /** Host a table. `opts.rated` (default false ⇒ casual, byte-identical v5)
   *  opts a signed-in host into v6 signed play; the game becomes SIGNED only if
   *  the joiner also offers identity. Every existing caller (no opts) is casual. */
  async host(cfg: MpGameConfig, opts?: { rated?: boolean }): Promise<void> {
    const kind = cfg.game?.kind ?? 'chess'
    // Wire v4: the session is game-agnostic. It cannot know that go/gomoku/
    // othello/checkers open with BLACK. Stamp the game's first mover into the
    // selector so the move ORDER travels in the config; the joiner adopts it
    // from start/resync automatically. The first mover is options-aware via
    // spec.turn on a fresh init (go: handicap ≥ 2 → WHITE opens); parity games
    // fall back to players[0]. Only a non-white first mover is stamped: absent
    // = white, so chess (and every white-first game) stays byte-identical.
    if (cfg.game && !cfg.game.firstMover) {
      const spec = getGame(kind as GameKind)?.spec
      let first = spec?.players[0]
      if (spec?.turn) {
        try {
          first = spec.turn(spec.init(cfg.game.options))
        } catch {
          /* corrupt options fail later in beginGame with a friendly error */
        }
      }
      if (first === 'black') {
        cfg = { ...cfg, game: { ...cfg.game, firstMover: 'black' } }
      }
    }
    this.set({ ...FRESH, phase: 'hosting', config: cfg, error: null })
    // The HOST knows the kind up front: refuse unknown kinds before opening a
    // table, and load an async rules engine (ffish WASM) before the code is
    // shown so the game starts instantly when the opponent joins.
    const adapter = onlineAdapterFor(kind)
    if (!adapter) {
      this.set({ phase: 'idle', error: `This build can't play '${kind}' games online yet.` })
      return
    }
    if (adapter.preload && adapter.needsPreload?.()) {
      this.set({ netStage: 'relays' }) // net-ish "getting ready" while WASM loads
      try {
        await adapter.preload()
      } catch (err) {
        this.set({
          phase: 'idle',
          error: err instanceof Error ? err.message : `Couldn't load the ${kind} rules engine.`
        })
        return
      }
    }
    // A6 (Lane C): configure signed play BEFORE opening the room so our hello can
    // carry identity. Rated + signed-in ⇒ offer signing; else null (casual = v5).
    this.applySigning(opts?.rated ?? false)
    try {
      const res = await mp.host(cfg)
      this.set({ code: res.code, phase: 'hosting' })
    } catch (err) {
      this.set({ phase: 'idle', error: err instanceof Error ? err.message : 'Could not start hosting.' })
    }
  }

  /** Join a table by code. `opts.rated` (default false ⇒ casual) opts a signed-in
   *  joiner into v6 signed play; `opts.oppRoot` pins a matchmaker-known opponent.
   *  Every existing caller (no opts) is casual, byte-identical v5. */
  async join(code: string, opts?: { rated?: boolean; oppRoot?: string }): Promise<void> {
    this.set({ ...FRESH, phase: 'connecting', error: null })
    // A6 (Lane C): configure signed play BEFORE dialing so our hello carries
    // identity (pinned to oppRoot when known); else null (casual = v5).
    this.applySigning(opts?.rated ?? false, opts?.oppRoot)
    try {
      const res = await mp.join(code)
      if (!res.ok) {
        this.set({ phase: 'idle', error: res.error ?? 'Could not join that game.' })
      }
      // On success, wait for the 'start' event to flip us into 'game'.
    } catch (err) {
      this.set({ phase: 'idle', error: err instanceof Error ? err.message : 'Could not join that game.' })
    }
  }

  /** Optimistically apply + send OUR move; roll back if the session rejects it
   *  (D6). Blocked while it's not our turn, the game is over, or the peer is away. */
  async playMove(uci: string): Promise<void> {
    if (!this.live || this.state.peerAway) return
    if (this.myTurn !== this.state.myColor) return
    const meta = this.adapter.moveMeta(this.gameState, uci) ?? { san: uci, capture: false, check: false }
    const next = this.adapter.play(this.gameState, uci)
    if (next === null) return

    // A move answers any pending draw exchange (offer withdrawn / declined).
    const priorMoves = this.state.moves
    const priorFen = this.state.fen
    const priorClock = this.state.clock
    const priorPly = this.state.plyCount
    const priorState = this.gameState

    this.set({ drawOffered: false, drawSent: false })
    this.pushMove(uci, next, meta)
    this.sound(this.moveSound(meta))

    const res = await mp.sendMove(uci)
    if (!res.ok) {
      // Roll back the optimistic apply. The session refused it.
      this.sans.pop()
      this.gameState = priorState
      this.set({
        moves: priorMoves,
        fen: priorFen,
        boardState: priorState,
        clock: priorClock,
        plyCount: priorPly,
        canAbort: priorPly < 2 && this.live
      })
      return
    }
    // Committed. Optimistically flip the display clock to the side now on move
    // (§4: "snapshot updates … AND after our own committed move") so our own
    // clock stops and the opponent's starts immediately, the host's authoritative
    // 'clock' ack (or the mirrored 'move') re-anchors any drift. After ANY move
    // the side on move (turnColor(m.fen)) is running: white's own first move ends
    // the idle phase and starts black's clock, exactly per the §2 first-move rule.
    // We keep the current snapshot values (the host owns debit/increment) and only
    // re-time which side burns.
    if (this.state.clock && this.live) {
      const c = this.frozenClock()
      if (c) {
        // v5: optimistically credit OUR committed move like the host will.
        // In byo-yomi the current period resets to full (the authoritative
        // ack corrects any drift, but without this our period would keep
        // draining visually until the opponent's next message).
        let snap = c.snapshot
        let byo = c.byo
        const spec = this.byoSpec()
        if (spec && byo) {
          const mine = this.state.myColor
          const credited = afterMoveCredit(
            {
              remainingMs: snap[mine],
              periodsLeft: byo[mine].periodsLeft,
              inByo: byo[mine].inByo
            } as SideClock,
            spec,
            0 // increment is host-credited; don't double-guess it here
          )
          snap = { ...snap, [mine]: credited.remainingMs }
          byo = { ...byo, [mine]: { periodsLeft: credited.periodsLeft, inByo: credited.inByo } }
        }
        this.setClock(snap, this.adapter.turn(next), byo)
      }
    }
    // The kernel-terminal check runs on the confirmed position.
    this.detectTerminal(next)
  }

  async resign(): Promise<void> {
    if (!this.live) return
    await mp.resign()
    // The session echoes a 'resign' event back, which raises our banner.
  }

  async offerDraw(): Promise<void> {
    if (!this.live) return
    if (this.state.drawOffered) {
      await this.acceptDraw()
      return
    }
    if (this.state.plyCount < DRAW_MIN_PLY) return
    if (this.state.plyCount < this.state.drawBlockedUntilPly) return
    this.set({ drawSent: true, drawBlockedUntilPly: this.state.plyCount + DRAW_COOLDOWN_PLIES })
    await mp.offerDraw()
  }

  async acceptDraw(): Promise<void> {
    if (!this.live || !this.state.drawOffered) return
    await mp.acceptDraw()
    // 'drawAccept' echoes back to end the game on both sides.
  }

  async declineDraw(): Promise<void> {
    if (!this.state.drawOffered) return
    this.set({ drawOffered: false })
    await mp.declineDraw()
  }

  async offerRematch(): Promise<void> {
    if (!this.state.banner || this.state.peerLeft) return
    this.set({ rematchSent: true })
    await mp.offerRematch()
  }

  async declineRematch(): Promise<void> {
    if (!this.state.rematchOffered) return
    this.set({ rematchOffered: false })
    await mp.declineRematch()
  }

  /** Abort while abortable (plyCount < 2 && live). No result, nothing saved. */
  async abort(): Promise<void> {
    if (!this.state.canAbort) return
    await mp.abort()
    this.endGame(null, 'Game aborted', { save: false })
  }

  /** Claim victory after the opponent's grace expired (peer-left). Records a win. */
  async claimVictory(): Promise<void> {
    if (!this.state.peerLeft || this.state.banner) return
    await mp.claimVictory()
    const result: GameResult = this.state.myColor === 'white' ? '1-0' : '0-1'
    this.endGame(result, 'opponent left the game', { save: true })
  }

  /** The ONLY caller of mp.leave(). Tears the session down + resets the store. */
  leave(): void {
    mp.leave()
    this.sans = []
    this.saved = false
    // A6 (Lane C): drop any pending signed-segment state with the session.
    this.lastWend = null
    this.pendingSegment = null
    this.segmentPublished = false
    // Back to the default game so an idle store always mirrors FRESH (chess).
    this.adapter = chessOnlineAdapter as OnlineGameAdapter<unknown>
    this.gameState = chessOnlineAdapter.init()
    this.set({ ...FRESH })
  }

  flip(): void {
    this.set({ orientation: this.state.orientation === 'white' ? 'black' : 'white' })
  }

  dismissError(): void {
    this.set({ error: null })
  }
}

/** Generic archive text for non-chess games (the game table's `pgn` column):
 *  PGN-style tag pairs + a [Variant] tag + the wire-codec moves joined by
 *  spaces, terminated by the result. Readable, greppable, replayable. */
function genericArchive(
  kind: string,
  headers: Record<string, string>,
  moves: readonly string[],
  result: GameResult
): string {
  const tags = { ...headers, Variant: kind }
  const tagText = Object.entries(tags)
    .map(([k, v]) => `[${k} "${v.replace(/"/g, "'")}"]`)
    .join('\n')
  return `${tagText}\n\n${[...moves, result].join(' ')}\n`
}

/** Promotion role char from a UCI string, if any (e.g. 'e7e8q' → 'queen'). */
function uciPromo(uci: string): 'queen' | 'rook' | 'bishop' | 'knight' | undefined {
  if (uci.length <= 4) return undefined
  switch (uci[4]) {
    case 'q':
      return 'queen'
    case 'r':
      return 'rook'
    case 'b':
      return 'bishop'
    case 'n':
      return 'knight'
    default:
      return undefined
  }
}

/** The process-wide singleton. Import this anywhere; the React binding is
 *  useOnlineGame(). Subscribes to `mp` at construction, for the app's lifetime. */
export const onlineStore = new OnlineStore()
