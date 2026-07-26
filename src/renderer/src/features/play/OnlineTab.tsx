// Play → Online tab. Everything you can play against another person over the
// internet, on one page and in one order:
//
//   RATED   : pick a ladder pool and hit Play; the matchmaking pool finds a
//             stranger and a witness (features/play/online/RatedPanel). Needs a
//             signed-in account: it supplies the identity that signs the moves
//             and the ladder numbers that decide who is a legal opponent.
//   CASUAL  : one player HOSTS (shares a short join code = a random room key),
//             the other JOINS. No account, no server, no port forwarding.
//
// Both end up in the SAME live game below: a direct, encrypted WebRTC peer-to-
// peer connection with signaling through public relays in the renderer. Rated
// vs casual is a choice inside one flow, never a separate destination.
//
// v3 (MP-V3-SPEC §5): this file is a PURE VIEW over the module-level `onlineStore`
// (features/play/online/onlineStore.ts). The live game lives in that store for the
// app's whole lifetime, so navigating away and back is SAFE. Unmount does NOT
// tear the session down (the L1/L2/MP-01 fix). All game state (phase, colors,
// clocks, banner, offers, peer-away, errors) is read from the store snapshot via
// useOnlineGame(); every action goes through the store singleton, which is the
// ONLY caller of mp.leave().
//
// Fair-play rules for online games (contract): assist/hints and takebacks are
// DISABLED. Clocks are HOST-AUTHORITATIVE; the store owns the snapshot and the
// Clock component ticks it locally (B2/D5).

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { Role } from 'chessops/types'
import type { Key } from 'chessground/types'
import { Copy, Check, Globe, Radio, LogIn, Loader2, AlertTriangle, X } from 'lucide-react'
import type { MpColor, MpGameConfig } from '@shared/types'
import type { GameKind } from '../../games/kernel'
import { isRegisteredGame } from '../../games/registry'
import { useMatchmaking } from '../account/net/matchmaking'
import { onlineStore } from './online/onlineStore'
import { useOnlineGame } from './online/useOnlineGame'
import { RatedPanel } from './online/RatedPanel'
import { GamePicker } from './online/GamePicker'
import { KernelOnlineGame } from './online/KernelOnlineGame'
import { liveMs, LeaveConfirm, OnlineStatusBar, PeerStrips, RematchStrip } from './online/OnlineChrome'
import { useGameTree } from '../../state/gameTree'
import { useSettings } from '../../state/settings'
import { applyUpdate, useUpdates } from '../../state/updates'
import {
  applyMove,
  checkColor,
  destsFor,
  isPromotion,
  turnColor,
  uciToLastMove,
  type Color
} from '../../chess/chess'
import { pieceSetClass } from '../../board/pieceSets'
import { useSound } from '../../sound/useSound'
import { GameView } from './GameView'
import { TimeControlPicker } from './TimeControlPicker'
import { timeControlById, formatClock, type TimeControl } from './timeControl'
import { BYOYOMI_PRESETS, byoyomiPresetById } from './byoyomi'
import type { GoHandicap } from '../../games/go'
import './online.css'

type ColorChoice = MpColor | 'random'

/** Go host-row chips: board sizes + 'Off' + 2..9 handicap stones. */
const GO_SIZES = [9, 13, 19] as const
const GO_HANDICAPS: readonly GoHandicap[] = [0, 2, 3, 4, 5, 6, 7, 8, 9]

/** What the host surface needs to know about this tab: nothing live ('idle'),
 *  a session is open but no game yet ('lobby'), or a game is live ('game'). It
 *  is NOT a nav lock (the store survives unmount, so switching tabs or views can
 *  never kill the session). */
export type OnlineStage = 'idle' | 'lobby' | 'game'

export interface OnlineTabProps {
  /** Seed for the host card's time control, the shared Play control. Untimed
   *  values fall back to 10+0 (the wire refuses initialMs < 1s). */
  initialTimeControl?: TimeControl
  /** Reflect host-card picker changes back into the shared Play control. */
  onTimeControl?: (tc: TimeControl) => void
  /** Stage reports for the host surface (game-width handoff only). */
  onStage?: (stage: OnlineStage) => void
  /** Pre-seed the host card's game picker (GamePage Online tab passes its
   *  kind). Chess remains the default, and the picker stays changeable. */
  initialGameKind?: GameKind
}

/** True for the hello-gate failure (mpSession's version-mismatch copy):
 *  the one lobby error a new build actually fixes. */
function isVersionMismatchError(message: string): boolean {
  return /version/i.test(message) && /(mismatch|incompatible)/i.test(message)
}

/** Shown under a version-mismatch lobby error when an update is genuinely
 *  waiting: one click starts it (in-place on Windows, browser .dmg download on
 *  macOS, decided by main). The error copy itself already points the OTHER
 *  player at Settings → Updates. */
function VersionMismatchNudge(): JSX.Element | null {
  const updates = useUpdates()
  if (!updates || (updates.state !== 'available' && updates.state !== 'ready')) return null
  return (
    <div className="online-update-nudge">
      <span>
        <strong>nodechess v{updates.latestVersion}</strong> is out. Updating both apps fixes this.
      </span>
      <button type="button" className="btn" onClick={() => void applyUpdate()}>
        {updates.state === 'ready' ? 'Restart & update' : 'Update now'}
      </button>
    </div>
  )
}

export default function OnlineTab({
  initialTimeControl,
  onTimeControl,
  onStage,
  initialGameKind
}: OnlineTabProps = {}): JSX.Element {
  const { settings } = useSettings()
  const state = useOnlineGame()
  // A rated search owns the session while it runs: once the pool strikes a
  // match it opens (or joins) the mp room itself, so the code cards below must
  // stand down and the host card's join code must not be presented as
  // something to share: nobody types a code into a matchmade game.
  const mm = useMatchmaking()
  const ratedActive = mm.phase !== 'idle' && mm.phase !== 'signed-out'

  // ---- setup form (local, pre-session only) --------------------------------
  // Online games must be timed (the wire refuses initialMs < 1s): seed from the
  // shared Play control when it carries a clock, else default to a friendly rapid
  // control, and forbid Unlimited at Start either way.
  const [hostTc, setHostTcState] = useState<TimeControl>(() =>
    initialTimeControl && initialTimeControl.baseMs > 0
      ? initialTimeControl
      : timeControlById('10+0')
  )
  const onTimeControlRef = useRef(onTimeControl)
  onTimeControlRef.current = onTimeControl
  const setHostTc = useCallback((tc: TimeControl) => {
    setHostTcState(tc)
    onTimeControlRef.current?.(tc)
  }, [])
  const [hostColorChoice, setHostColorChoice] = useState<ColorChoice>('white')
  // Which game the host card offers (wire v4). Chess default; GamePage's Online
  // tab pre-seeds its own kind. Guarded so a stale/unknown seed can't stick.
  const [gameKind, setGameKind] = useState<GameKind>(() =>
    initialGameKind && isRegisteredGame(initialGameKind) ? initialGameKind : 'chess'
  )
  // Go-only host options (QoL): board size, handicap stones, byo-yomi periods.
  // They ride the wire in config.game.options / config.tc.byoyomi; the joiner
  // adopts whatever arrives in start/resync, no local selection involved.
  const [goSize, setGoSize] = useState<9 | 13 | 19>(19)
  const [goHandicap, setGoHandicap] = useState<GoHandicap>(0)
  const [goByoId, setGoByoId] = useState('off')
  const [joinCode, setJoinCode] = useState('')
  const [copied, setCopied] = useState(false)
  // Client-side form validation (empty code / unlimited TC) lives here so it's
  // not confused with a session error from the store. Cleared on any resubmit.
  const [formError, setFormError] = useState<string | null>(null)
  // Two-step Leave confirm (L10): armed only while a live undecided game is up.
  const [leaveArmed, setLeaveArmed] = useState(false)

  // Lobby buttons disable while a join/host is dialing. The store owns the
  // connection lifecycle, so "busy" is simply the connecting phase.
  const busy = state.phase === 'connecting' && !state.error

  // ---- display tree (fed from the store's move list) -----------------------
  // The store is authoritative for the live position; this local tree mirrors
  // state.moves so GameView's MoveList + history browsing keep working. It resets
  // on every new gameId and appends any moves it hasn't applied yet.
  const tree = useGameTree()
  const syncedGameIdRef = useRef<number>(-1)
  const syncedPlyRef = useRef(0)
  useEffect(() => {
    // Chess only: the tree applies UCIs with chessops. Kernel games render
    // through KernelOnlineGame straight off the store's boardState instead.
    if (state.phase !== 'game' || state.gameKind !== 'chess') return
    if (syncedGameIdRef.current !== state.gameId) {
      tree.reset()
      syncedGameIdRef.current = state.gameId
      syncedPlyRef.current = 0
    }
    // Append any moves the tree hasn't seen. Apply against the live tip so a
    // history selection never corrupts the mainline.
    for (let i = syncedPlyRef.current; i < state.moves.length; i++) {
      let tip = tree.root
      while (tip.children[0]) tip = tip.children[0]
      const uci = state.moves[i]
      const promo = uci.length > 4 ? (ROLE_FROM_CHAR[uci[4]] as Role | undefined) : undefined
      const m = applyMove(tip.fen, uci.slice(0, 2), uci.slice(2, 4), promo)
      if (!m) break
      tree.addMove(m)
    }
    syncedPlyRef.current = state.moves.length
    // tree identity is stable across renders; keying on moves/gameId is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.gameId, state.moves.length, state.gameKind])

  // ---- promotion picker (local UI state) -----------------------------------
  const [pendingPromo, setPendingPromo] = useState<{ orig: string; dest: string } | null>(null)
  const [nonce, setNonce] = useState(0)
  // A fresh game/position clears any half-finished promotion.
  useEffect(() => {
    setPendingPromo(null)
  }, [state.gameId, state.plyCount])

  // ---- stage report (width handoff; NOT a nav lock) ------------------------
  const onStageRef = useRef(onStage)
  onStageRef.current = onStage
  const stage: OnlineStage =
    state.phase === 'game' ? 'game' : state.phase === 'idle' ? 'idle' : 'lobby'
  useEffect(() => {
    onStageRef.current?.(stage)
  }, [stage])
  // Leaving THIS tab no longer tears anything down, but report 'idle' so the
  // host surface stops widening while the tab isn't shown. The session persists.
  useEffect(
    () => () => {
      onStageRef.current?.('idle')
    },
    []
  )

  // Disarm the Leave confirm whenever the game is no longer live-undecided.
  const liveUndecided = state.phase === 'game' && state.banner === null && !state.peerLeft
  useEffect(() => {
    if (!liveUndecided) setLeaveArmed(false)
  }, [liveUndecided])

  // ---- derived board data --------------------------------------------------
  const fen = tree.currentFen
  const dests = useMemo(() => destsFor(fen), [fen])
  const turn = turnColor(fen)
  const check = checkColor(fen)
  const lastMove = tree.current.move ? uciToLastMove(tree.current.move.uci) : undefined
  const atTip = tree.current.children.length === 0
  const over = state.banner !== null

  // ---- local move → store (optimistic apply + rollback lives in the store) --
  const commit = useCallback(
    (orig: string, dest: string, promotion?: Role) => {
      // Only the side to move at the live tip may move, and only when it's us and
      // the game is live. peerAway/over are blocked by the store too, but we gate
      // here for immediate feedback (fair-play: no history-position moves).
      if (over || !atTip || state.peerAway || turn !== state.myColor) {
        setNonce((n) => n + 1)
        return
      }
      const promoChar = promotion ? PROMO_CHAR[promotion] : ''
      const uci = `${orig}${dest}${promoChar}`
      // Validate locally so an illegal drag just snaps back (no store churn).
      const m = applyMove(fen, orig, dest, promotion)
      if (!m) {
        setNonce((n) => n + 1)
        return
      }
      onlineStore.playMove(uci)
    },
    [over, atTip, state.peerAway, turn, state.myColor, fen]
  )

  const onMove = useCallback(
    (orig: Key, dest: Key) => {
      if (isPromotion(fen, orig, dest)) {
        if (settings.autoQueen) commit(orig, dest, 'queen')
        else setPendingPromo({ orig, dest })
      } else commit(orig, dest)
    },
    [fen, commit, settings.autoQueen]
  )
  const onPromo = useCallback(
    (role: Role) => {
      if (pendingPromo) commit(pendingPromo.orig, pendingPromo.dest, role)
      setPendingPromo(null)
    },
    [pendingPromo, commit]
  )
  const onPromoCancel = useCallback(() => {
    setPendingPromo(null)
    setNonce((n) => n + 1)
  }, [])

  // ---- host / join actions -------------------------------------------------
  const doHost = useCallback(() => {
    if (hostTc.baseMs <= 0) {
      setFormError('Online games need a clock. Pick a time control (Unlimited is not supported online).')
      return
    }
    setFormError(null)
    // Go rides its QoL options on the wire: byo-yomi in tc (v5), size/handicap
    // in game.options (opaque blob the joiner's kernel init consumes).
    const goByo = gameKind === 'go' ? byoyomiPresetById(goByoId).byo : null
    const cfg: MpGameConfig = {
      tc: {
        initialMs: hostTc.baseMs,
        incrementMs: hostTc.incMs,
        ...(goByo ? { byoyomi: goByo } : {})
      },
      hostColor: hostColorChoice,
      // Wire v4: chess stays the implicit default (config byte-identical to
      // pre-v4 hosts); other kinds ride in config.game. Chess960 resolves its
      // shuffled start HERE so both peers init the same position.
      ...(gameKind !== 'chess'
        ? {
            game: {
              kind: gameKind,
              ...(gameKind === 'chess960'
                ? { options: { positionNumber: Math.floor(Math.random() * 960) } }
                : {}),
              ...(gameKind === 'go'
                ? { options: { size: goSize, ...(goHandicap >= 2 ? { handicap: goHandicap } : {}) } }
                : {})
            }
          }
        : {})
    }
    onlineStore.host(cfg)
  }, [hostTc, hostColorChoice, gameKind, goSize, goHandicap, goByoId])

  const doJoin = useCallback(() => {
    const trimmed = joinCode.trim()
    if (trimmed.length < 5) {
      setFormError('Enter the full join code your opponent shared.')
      return
    }
    setFormError(null)
    onlineStore.join(trimmed)
  }, [joinCode])

  // ---- leave / teardown ----------------------------------------------------
  // The ONLY leave paths: an explicit user command. Post-banner it's immediate;
  // mid-game (live + undecided) it goes through the two-step confirm (L10) whose
  // "Resign & leave" resigns first so the opponent gets a clean result.
  const requestLeave = useCallback(() => {
    if (liveUndecided) setLeaveArmed(true)
    else onlineStore.leave()
  }, [liveUndecided])
  const confirmResignLeave = useCallback(() => {
    setLeaveArmed(false)
    onlineStore.resign()
    onlineStore.leave()
  }, [])
  const cancelLeave = useCallback(() => setLeaveArmed(false), [])

  const copyCode = useCallback(() => {
    if (!state.code) return
    void navigator.clipboard?.writeText(state.code).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      },
      () => {}
    )
  }, [state.code])

  // ==========================================================================
  // RENDER
  // ==========================================================================
  if (state.phase === 'game') {
    // Non-chess kinds (wire v4): the registry's own board inside the same
    // online chrome. The joiner renders whatever kind arrived in the start
    // config. No local selection involved.
    if (state.gameKind !== 'chess') {
      return (
        <KernelOnlineGame
          state={state}
          leaveArmed={leaveArmed}
          onLeaveRequest={requestLeave}
          onConfirmResignLeave={confirmResignLeave}
          onCancelLeave={cancelLeave}
        />
      )
    }
    return (
      <OnlineGame
        state={state}
        fen={fen}
        turn={turn}
        dests={dests}
        lastMove={lastMove}
        check={check}
        atTip={atTip}
        over={over}
        pendingPromo={pendingPromo}
        nonce={nonce}
        settings={settings}
        tree={tree}
        leaveArmed={leaveArmed}
        onMove={onMove}
        onPromo={onPromo}
        onPromoCancel={onPromoCancel}
        onLeaveRequest={requestLeave}
        onConfirmResignLeave={confirmResignLeave}
        onCancelLeave={cancelLeave}
      />
    )
  }

  // ---- setup / lobby -------------------------------------------------------
  return (
    <div className="online-lobby">
      <header className="online-lobby-head">
        <h2>Play online</h2>
        <p className="muted">
          Rated games pair you with a stranger and count on your ladder. Casual games are a code you
          send to someone you know. No account, no setup.
        </p>
      </header>

      {(formError || state.error) && (
        <>
          <div className="online-error" role="alert">
            <AlertTriangle size={15} aria-hidden />
            <span>{formError || state.error}</span>
            <button
              className="icon-btn online-error-x"
              onClick={() => {
                setFormError(null)
                onlineStore.dismissError()
              }}
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
          {!formError && state.error && isVersionMismatchError(state.error) && (
            <VersionMismatchNudge />
          )}
        </>
      )}

      {/* RATED: the pool. It owns the whole surface once a search or a
          matchmade handoff is running (a matchmade game has no code to share),
          and steps aside entirely while a casual session is dialing. */}
      {(ratedActive || state.phase === 'idle') && (
        <RatedPanel initialTimeControl={initialTimeControl} />
      )}

      {!ratedActive && state.phase === 'idle' && (
        <div className="online-friend-head">
          <h3>Play a friend</h3>
          <span className="muted small">
            Casual: one of you hosts and shares the code. Nothing here is rated.
          </span>
        </div>
      )}

      {ratedActive ? null : state.phase === 'hosting' && state.code ? (
        <HostWaiting
          code={state.code}
          copied={copied}
          onCopy={copyCode}
          onCancel={() => onlineStore.leave()}
          relays={state.relays}
        />
      ) : state.phase === 'connecting' ? (
        <div className="online-card online-connecting">
          <Loader2 className="spin" size={22} aria-hidden />
          <span>{guestStatusText(state.netStage)}</span>
          <button className="btn ghost" onClick={() => onlineStore.leave()}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="online-cards">
          {/* HOST */}
          <section className="online-card" aria-label="Host a game">
            <div className="online-card-head">
              <Radio size={18} className="online-card-icon" aria-hidden />
              <div>
                <h3>Host a game</h3>
                <span className="muted small">Open a table and share the code.</span>
              </div>
            </div>

            <div className="online-field">
              <span className="online-label">Game</span>
              <GamePicker value={gameKind} onChange={setGameKind} disabled={busy} />
            </div>

            {gameKind === 'go' && (
              <div className="online-field">
                <span className="online-label">Go options</span>
                <div className="goopt">
                  <div className="goopt-row" role="group" aria-label="Board size">
                    <span className="goopt-name">Board</span>
                    {GO_SIZES.map((sz) => (
                      <button
                        key={sz}
                        type="button"
                        className={`goopt-chip${goSize === sz ? ' on' : ''}`}
                        aria-pressed={goSize === sz}
                        onClick={() => setGoSize(sz)}
                      >
                        <span className="num">{sz}×{sz}</span>
                      </button>
                    ))}
                  </div>
                  <div className="goopt-row" role="group" aria-label="Handicap stones">
                    <span className="goopt-name">Handicap</span>
                    {GO_HANDICAPS.map((h) => (
                      <button
                        key={h}
                        type="button"
                        className={`goopt-chip${goHandicap === h ? ' on' : ''}`}
                        aria-pressed={goHandicap === h}
                        title={h === 0 ? 'Even game' : `Black starts with ${h} hoshi stones; White moves first; komi 0.5`}
                        onClick={() => setGoHandicap(h)}
                      >
                        <span className="num">{h === 0 ? 'Off' : h}</span>
                      </button>
                    ))}
                  </div>
                  <div className="goopt-row" role="group" aria-label="Byo-yomi overtime">
                    <span className="goopt-name">Byo-yomi</span>
                    {BYOYOMI_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`goopt-chip${goByoId === p.id ? ' on' : ''}`}
                        aria-pressed={goByoId === p.id}
                        title={
                          p.byo
                            ? `${p.byo.periods} overtime periods of ${p.byo.periodMs / 1000}s, and a move inside a period resets it`
                            : 'No overtime, main time only'
                        }
                        onClick={() => setGoByoId(p.id)}
                      >
                        <span className="num">{p.label}</span>
                      </button>
                    ))}
                  </div>
                  {goHandicap >= 2 && (
                    <p className="online-note">
                      Black pre-places {goHandicap} stones, White moves first, komi drops to 0.5.
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="online-field">
              <span className="online-label">Time control</span>
              <TimeControlPicker value={hostTc} onChange={setHostTc} dense />
              {hostTc.baseMs <= 0 && (
                <p className="online-note warn">Online games need a clock. Pick any timed control.</p>
              )}
            </div>

            <div className="online-field">
              <span className="online-label">Play as</span>
              <div className="online-colors" role="group" aria-label="Play as">
                {(['white', 'black', 'random'] as ColorChoice[]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`online-color${hostColorChoice === c ? ' on' : ''}`}
                    aria-pressed={hostColorChoice === c}
                    onClick={() => setHostColorChoice(c)}
                  >
                    <span className={`online-disc is-${c}`} aria-hidden>
                      {c === 'white' ? '♔' : c === 'black' ? '♚' : '⯪'}
                    </span>
                    <span className="online-color-label">
                      {c === 'white' ? 'White' : c === 'black' ? 'Black' : 'Random'}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              className="btn online-primary"
              onClick={doHost}
              disabled={busy || hostTc.baseMs <= 0}
            >
              <Radio size={15} /> Start &amp; get code
            </button>
          </section>

          {/* JOIN */}
          <section className="online-card" aria-label="Join a game">
            <div className="online-card-head">
              <LogIn size={18} className="online-card-icon" aria-hidden />
              <div>
                <h3>Join a game</h3>
                <span className="muted small">Enter the code your opponent sent.</span>
              </div>
            </div>

            <div className="online-field">
              <span className="online-label" id="join-code-label">
                Join code
              </span>
              <input
                className="online-code-input num"
                aria-labelledby="join-code-label"
                placeholder="XXXXX-XXXXX"
                autoCapitalize="characters"
                spellCheck={false}
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') doJoin()
                }}
              />
              <p className="online-note">Codes look like <span className="num">A1B2C-D3E4F</span>.</p>
            </div>

            <button
              type="button"
              className="btn online-primary"
              onClick={doJoin}
              disabled={busy || joinCode.trim().length < 5}
            >
              <LogIn size={15} /> Join game
            </button>
          </section>
        </div>
      )}
    </div>
  )
}

const ROLE_FROM_CHAR: Record<string, Role> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }
const PROMO_CHAR: Record<Role, string> = {
  queen: 'q',
  rook: 'r',
  bishop: 'b',
  knight: 'n',
  king: '',
  pawn: ''
}

/** Guest-side staged status copy, driven by the store's netStage as we go from
 *  contacting relays → discovering the peer → the direct WebRTC handshake. */
function guestStatusText(stage: 'relays' | 'searching' | 'connecting' | null): string {
  switch (stage) {
    case 'searching':
      return 'Looking for your opponent…'
    case 'connecting':
      return 'Found them, connecting…'
    case 'relays':
    default:
      return 'Connecting…'
  }
}

// ---------------------------------------------------------------------------
// Host "waiting for opponent" panel: big copyable code, a live relay-connection
// status line, and a plain note that the connection is direct + encrypted.
// ---------------------------------------------------------------------------
function HostWaiting({
  code,
  copied,
  onCopy,
  onCancel,
  relays
}: {
  code: string
  copied: boolean
  onCopy: () => void
  onCancel: () => void
  relays: { connected: number; total: number } | null
}): JSX.Element {
  const online = (relays?.connected ?? 0) > 0
  const relayTitle = relays && relays.connected > 0 ? 'Connected' : 'Connecting…'

  return (
    <div className="online-card online-hosting" aria-label="Waiting for an opponent">
      <div className="online-card-head">
        <Radio size={18} className="online-card-icon is-live" aria-hidden />
        <div>
          <h3>Waiting for your opponent…</h3>
          <span className="muted small">Share this code. The game starts the moment they join.</span>
        </div>
      </div>

      <button className="online-code" onClick={onCopy} title="Copy join code" aria-label={`Join code ${code}, click to copy`}>
        <span className="online-code-text num">{code}</span>
        <span className="online-code-copy">
          {copied ? <Check size={16} /> : <Copy size={16} />}
          {copied ? 'Copied' : 'Copy'}
        </span>
      </button>

      <div className="online-net" role="status" title={relayTitle}>
        <span className={`online-net-dot${online ? ' is-online' : ''}`} aria-hidden />
        <span className="online-net-text">
          {online ? 'Waiting for your opponent' : 'Connecting…'}
        </span>
      </div>

      <div className="online-note-block">
        <p className="online-note">
          <Globe size={13} aria-hidden /> Share the code any way you like: text, Discord, anything.
        </p>
      </div>

      <div className="online-hosting-foot">
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The live online game. Wraps GameView with online-specific chrome, all driven
// by the store snapshot: a status/actions strip (draw offer/accept/decline,
// abort, resign-via-leave), a peer-away countdown strip, a symmetric rematch
// strip, and a Leave confirm. Host-authoritative clocks come from the store.
// ---------------------------------------------------------------------------
interface OnlineGameProps {
  state: ReturnType<typeof useOnlineGame>
  fen: string
  turn: Color
  dests: Map<Key, Key[]>
  lastMove?: [Key, Key]
  check?: Color
  atTip: boolean
  over: boolean
  pendingPromo: { orig: string; dest: string } | null
  nonce: number
  settings: ReturnType<typeof useSettings>['settings']
  tree: ReturnType<typeof useGameTree>
  leaveArmed: boolean
  onMove: (orig: Key, dest: Key) => void
  onPromo: (role: Role) => void
  onPromoCancel: () => void
  onLeaveRequest: () => void
  onConfirmResignLeave: () => void
  onCancelLeave: () => void
}

function OnlineGame({
  state,
  fen,
  turn,
  dests,
  lastMove,
  check,
  atTip,
  over,
  pendingPromo,
  nonce,
  settings,
  tree,
  leaveArmed,
  onMove,
  onPromo,
  onPromoCancel,
  onLeaveRequest,
  onConfirmResignLeave,
  onCancelLeave
}: OnlineGameProps): JSX.Element {
  const userColor = state.myColor
  const opponentColor: Color = userColor === 'white' ? 'black' : 'white'
  const opponentName = state.opponentName || 'Opponent'

  // One-shot low-time cue for OUR OWN clock (lichess behavior): the Clock's
  // interp path fires it at the per-control emergency threshold; the live
  // setting gates it here (mirrors PlayView's onLowTime).
  const { play } = useSound()
  const onLowTime = useCallback(() => {
    if (settings.lowTimeWarning) play('lowTime')
  }, [play, settings.lowTimeWarning])

  const timed = (state.config?.tc.initialMs ?? 0) > 0
  const baseMs = state.config?.tc.initialMs ?? 0
  const clockLive = timed && !over && !state.peerAway
  // Live remaining ms from the store snapshot; `interp` hands the Clock the
  // authoritative snapshot so it self-ticks at 100ms (B2/D5/MP-02); the coarse
  // ms value keeps GameView's ClockSide contract and drives the active glow.
  // (byo is stripped from the spread: OnlineClock.byo is the v5 PER-GAME shape;
  // ClockInterp.byo is per-side and only go games, so only KernelOnlineGame builds it.)
  const chessInterp = (side: Color) => {
    if (!state.clock) return undefined
    const { byo: _byo, ...clock } = state.clock
    return { ...clock, side, baseMs }
  }
  const opponentClock = {
    ms: liveMs(state.clock, opponentColor),
    active: clockLive && turn === opponentColor && atTip,
    interp: chessInterp(opponentColor)
  }
  const userClock = {
    ms: liveMs(state.clock, userColor),
    active: clockLive && turn === userColor && atTip,
    interp: chessInterp(userColor),
    onLowTime
  }
  const opponentSub = timed ? formatClock(opponentClock.ms) : 'Online'

  // Input is disabled while the peer is away (fair-play + no moves into a frozen
  // authority) and, obviously, once the game is over.
  const inputFrozen = over || !!state.peerAway || state.peerLeft

  return (
    <div className="online-game">
      {/* Shared online chrome (OnlineChrome.tsx): status/actions strip with the
          draw negotiation + abort + leave, then the peer-away/left strips. */}
      <OnlineStatusBar state={state} over={over} onLeaveRequest={onLeaveRequest} />
      <PeerStrips state={state} over={over} />

      <GameView
        fen={fen}
        orientation={state.orientation}
        turn={turn}
        userColor={userColor}
        dests={dests}
        lastMove={lastMove}
        check={check}
        thinking={false}
        over={over}
        atTip={atTip}
        pendingPromo={pendingPromo}
        nonce={nonce}
        boardTheme={settings.boardTheme}
        pieceSetClass={pieceSetClass(settings.pieceSet)}
        showLegal={settings.showLegal}
        coordinates={settings.coordinates}
        animation={settings.animation}
        // Fair play: no hints, no takebacks online.
        hintsEnabled={false}
        allowTakebacks={false}
        canTakeback={false}
        userName={settings.username}
        userAvatar={settings.avatar}
        opponentName={opponentName}
        opponentSub={opponentSub}
        opponentPhoto={null}
        clockActive={timed}
        opponentClock={opponentClock}
        userClock={userClock}
        confirmResign={settings.confirmResign}
        tree={tree}
        banner={state.banner}
        onMove={onMove}
        onPromo={onPromo}
        onPromoCancel={onPromoCancel}
        onResign={() => onlineStore.resign()}
        // Online seams: no local-play "New game" mid-game (Leave is the exit,
        // with its own confirm); input frozen while the peer is away/left.
        onlineLive
        inputFrozen={inputFrozen}
        // Board input is disabled while the peer is away (fair-play + frozen clock).
        // Post-banner the banner's New game / Rematch drive the store.
        onNewGame={() => onlineStore.leave()}
        onFlip={() => onlineStore.flip()}
        // Rematch is a symmetric offer; the banner button just sends the offer.
        onRematch={state.peerLeft ? undefined : () => onlineStore.offerRematch()}
      />

      {/* Symmetric rematch strip (MP-07): sent → "waiting" + Cancel; incoming →
          Accept / Decline. Only after the game is over and the peer is present. */}
      {over && !state.peerLeft && (
        <RematchStrip
          name={opponentName}
          sent={state.rematchSent}
          offered={state.rematchOffered}
        />
      )}

      {/* Leave confirm (L10): only reachable while a live undecided game is up. */}
      {leaveArmed && <LeaveConfirm onConfirm={onConfirmResignLeave} onCancel={onCancelLeave} />}
    </div>
  )
}
