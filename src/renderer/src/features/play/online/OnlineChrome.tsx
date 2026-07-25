// Shared chrome for a LIVE online game, game-kind agnostic (MP-V3 §4/§5):
// the status/actions strip (draw offer/accept/decline, abort, leave), the
// peer-away countdown + peer-left claim row, the symmetric rematch strip and
// the two-step Leave confirm. Extracted from OnlineTab so the chess GameView
// path and the kernel-game path (KernelOnlineGame) render EXACTLY the same
// surround. Behavior lives in the onlineStore singleton either way.

import { useEffect, useState, type JSX } from 'react'
import { Globe, Handshake, OctagonX, Repeat, Wifi, WifiOff } from 'lucide-react'
import type { Color } from '../../../chess/chess'
import { onlineStore, type OnlineState } from './onlineStore'

/** Live remaining ms for one side, computed from the store's authoritative clock
 *  snapshot at render time. The store-owned Clock component does the smooth 100ms
 *  ticking on top of this; this coarse value keeps the ClockSide contract intact
 *  and drives the active-side glow. */
export function liveMs(clock: OnlineState['clock'], side: Color): number {
  if (!clock) return 0
  const base = clock.snapshot[side]
  if (clock.running !== side) return Math.max(0, base)
  const elapsed = performance.now() - clock.atMono
  return Math.max(0, base - elapsed)
}

/** Slim status strip above the board: online tag, a live status message
 *  (in-game errors surface here, never silent, L12) and the in-game actions
 *  (draw offer/accept/decline, abort, leave). */
export function OnlineStatusBar({
  state,
  over,
  onLeaveRequest
}: {
  state: OnlineState
  over: boolean
  onLeaveRequest: () => void
}): JSX.Element {
  const opponentName = state.opponentName || 'Opponent'
  // Draw cooldown: the store exposes drawBlockedUntilPly; a tooltip explains the
  // disabled Offer-draw button. Offers before ply 2 are also blocked.
  const drawCoolingDown = state.plyCount < state.drawBlockedUntilPly || state.plyCount < 2
  const drawCooldownTip = drawCoolingDown
    ? state.plyCount < 2
      ? 'Draw offers open after the first moves.'
      : 'Please wait before offering another draw.'
    : undefined

  return (
    <div className="online-statusbar">
      <span className="online-statusbar-tag">
        <Globe size={13} aria-hidden /> Online
      </span>

      {state.error ? (
        <span className="online-statusbar-msg warn">{state.error}</span>
      ) : state.drawOffered && !over ? (
        <span className="online-statusbar-msg">{opponentName} offers a draw.</span>
      ) : state.drawSent && !over ? (
        <span className="online-statusbar-msg muted">Draw offered, waiting…</span>
      ) : (
        <span className="online-statusbar-msg muted">Fair-play mode: hints &amp; takebacks are off.</span>
      )}

      <div className="online-statusbar-actions">
        {/* Incoming draw offer → Accept / Decline pair. */}
        {!over && state.drawOffered && !state.peerLeft && (
          <>
            <button className="btn ghost small is-accept" onClick={() => onlineStore.acceptDraw()}>
              <Handshake size={14} /> Accept draw
            </button>
            <button className="btn ghost small" onClick={() => onlineStore.declineDraw()}>
              Decline
            </button>
          </>
        )}
        {/* Offer draw (hidden while an incoming offer is pending). */}
        {!over && !state.drawOffered && !state.peerLeft && (
          <button
            className="btn ghost small"
            onClick={() => onlineStore.offerDraw()}
            disabled={state.drawSent || drawCoolingDown}
            title={drawCooldownTip}
          >
            {state.drawSent ? 'Draw sent' : 'Offer draw'}
          </button>
        )}
        {/* Abort while abortable (plyCount < 2): either side may abort. */}
        {!over && state.canAbort && !state.peerLeft && (
          <button
            className="btn ghost small"
            onClick={() => onlineStore.abort()}
            title="Abort, no result recorded"
          >
            <OctagonX size={14} /> Abort
          </button>
        )}
        <button className="btn ghost small" onClick={onLeaveRequest}>
          Leave
        </button>
      </div>
    </div>
  )
}

/** Peer-away countdown strip (MP-06) + the peer-left Claim victory / Abort row
 *  once the grace expires. Renders nothing while the peer is present. */
export function PeerStrips({ state, over }: { state: OnlineState; over: boolean }): JSX.Element | null {
  const opponentName = state.opponentName || 'Opponent'
  if (state.peerAway && !state.peerLeft) {
    return <PeerAwayStrip name={opponentName} deadlineMono={state.peerAway.deadlineMono} />
  }
  if (state.peerLeft && !over) {
    return (
      <div className="online-away-strip is-expired" role="status">
        <span className="online-away-msg">
          <WifiOff size={14} aria-hidden /> {opponentName} left the game.
        </span>
        <div className="online-away-actions">
          <button className="btn small" onClick={() => onlineStore.claimVictory()}>
            Claim victory
          </button>
          <button className="btn ghost small" onClick={() => onlineStore.abort()}>
            Abort game
          </button>
        </div>
      </div>
    )
  }
  return null
}

/** Peer-away countdown: a self-ticking "Ns to reconnect" line. On expiry the
 *  store flips peerLeft (the parent then renders the Claim victory / Abort row),
 *  so this component only owns the pre-expiry countdown display. */
function PeerAwayStrip({ name, deadlineMono }: { name: string; deadlineMono: number }): JSX.Element {
  const [remaining, setRemaining] = useState(() => Math.max(0, deadlineMono - performance.now()))
  useEffect(() => {
    const tick = (): void => setRemaining(Math.max(0, deadlineMono - performance.now()))
    tick()
    const id = window.setInterval(tick, 250)
    return () => window.clearInterval(id)
  }, [deadlineMono])
  const secs = Math.ceil(remaining / 1000)
  return (
    <div className="online-away-strip" role="status">
      <span className="online-away-msg">
        <Wifi size={14} className="online-away-spin" aria-hidden /> {name} disconnected. {secs}s to
        reconnect…
      </span>
    </div>
  )
}

/** Symmetric rematch strip (MP-07). The banner's Rematch button sends the offer;
 *  this strip reports the negotiation the banner cannot: sent means waiting plus
 *  Cancel, incoming means Accept / Decline. */
export function RematchStrip({
  name,
  sent,
  offered
}: {
  name: string
  sent: boolean
  offered: boolean
}): JSX.Element | null {
  if (offered) {
    return (
      <div className="online-rematch-strip" role="status">
        <span className="online-rematch-msg">
          <Repeat size={14} aria-hidden /> {name} wants a rematch.
        </span>
        <div className="online-rematch-actions">
          <button className="btn small" onClick={() => onlineStore.offerRematch()}>
            Accept
          </button>
          <button className="btn ghost small" onClick={() => onlineStore.declineRematch()}>
            Decline
          </button>
        </div>
      </div>
    )
  }
  if (sent) {
    return (
      <div className="online-rematch-strip" role="status">
        <span className="online-rematch-msg muted">Rematch offered, waiting for {name}…</span>
        <div className="online-rematch-actions">
          <button className="btn ghost small" onClick={() => onlineStore.declineRematch()}>
            Cancel
          </button>
        </div>
      </div>
    )
  }
  return null
}

/** Two-step Leave confirm (L10): only reachable while a live undecided game is
 *  up. "Resign & leave" resigns first so the opponent gets a clean result. */
export function LeaveConfirm({
  onConfirm,
  onCancel
}: {
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <div className="online-leave-confirm" role="alertdialog" aria-label="Leave the game?">
      <div className="online-leave-card">
        <h3>Leave the game?</h3>
        <p className="muted">Leaving forfeits the game. Your opponent wins by resignation.</p>
        <div className="online-leave-actions">
          <button className="btn danger" onClick={onConfirm}>
            Resign &amp; leave
          </button>
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
