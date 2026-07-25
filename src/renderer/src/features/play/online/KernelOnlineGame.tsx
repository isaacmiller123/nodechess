// The live ONLINE game screen for every non-chess kernel game (wire v4).
// Chess keeps its dedicated GameView path in OnlineTab (move list, assist,
// promotion UI); this component renders the same online chrome around the
// registry's own 2D board for the kind that arrived in the start config:
//
//   status/actions strip  (OnlineChrome: draw / abort / leave)
//   opponent chip + clock (PlayerChip, host-authoritative interp clocks)
//   the game's board      (React.lazy(entry.loadRenderer), preload spinner)
//   user chip + clock
//   result banner / controls (flip when the game rotates, resign w/ confirm)
//   rematch strip + leave confirm
//
// All state comes from the onlineStore snapshot; every action goes through the
// store singleton. Turn is derived from move-count parity against the spec's
// players order: exactly the adapter's rule (see gameAdapter.adapterFromSpec).

import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { Flag, FlipVertical2, Loader2 } from 'lucide-react'
import type { Color } from '../../../chess/chess'
import type { GameKind } from '../../../games/kernel'
import { getGame } from '../../../games/registry'
import { useSettings } from '../../../state/settings'
import { useSound } from '../../../sound/useSound'
import { PlayerChip } from '../PlayerChip'
import { ResultBanner } from '../ResultBanner'
import { formatClock } from '../timeControl'
import { normalizeByoyomi } from '../byoyomi'
import { onlineStore, type OnlineState } from './onlineStore'
import { liveMs, LeaveConfirm, OnlineStatusBar, PeerStrips, RematchStrip } from './OnlineChrome'
import { Board3DHost, BoardModeToggle, useBoardMode } from '../../games/boardMode'

export interface KernelOnlineGameProps {
  state: OnlineState
  leaveArmed: boolean
  onLeaveRequest: () => void
  onConfirmResignLeave: () => void
  onCancelLeave: () => void
}

export function KernelOnlineGame({
  state,
  leaveArmed,
  onLeaveRequest,
  onConfirmResignLeave,
  onCancelLeave
}: KernelOnlineGameProps): JSX.Element {
  const { settings } = useSettings()
  const { play } = useSound()

  const entry = getGame(state.gameKind as GameKind)
  // Stable lazy component per kind: remounting on every render would drop the
  // board's internal state (hover, animations).
  const BoardComp = useMemo(
    () => (entry ? lazy(entry.loadRenderer) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.gameKind]
  )

  const { is3d } = useBoardMode(state.gameKind)

  const over = state.banner !== null
  const userColor = state.myColor
  const opponentColor: Color = userColor === 'white' ? 'black' : 'white'
  const opponentName = state.opponentName || 'Opponent'

  // Whose move is it? spec.turn when the game defines one (go: handicap makes
  // WHITE open), else parity against the spec's move order. Exactly the
  // adapter's rule, so board glow and input gating always agree with the store.
  const players = entry?.spec.players ?? (['white', 'black'] as const)
  const turn: Color = entry?.spec.turn ? entry.spec.turn(state.boardState) : players[state.plyCount % 2]

  // Input is frozen while the peer is away/left (fair play + frozen authority).
  const inputFrozen = over || !!state.peerAway || state.peerLeft
  const interactive = !inputFrozen && turn === userColor

  // Two-step resign (settings.confirmResign), mirroring GameView.
  const [resignArmed, setResignArmed] = useState(false)
  useEffect(() => {
    if (over) setResignArmed(false)
  }, [over])
  const handleResign = useCallback(() => {
    if (settings.confirmResign && !resignArmed) {
      setResignArmed(true)
      return
    }
    setResignArmed(false)
    void onlineStore.resign()
  }, [settings.confirmResign, resignArmed])

  // Clocks: host-authoritative snapshot, self-ticked by the Clock component.
  // v5: byo-yomi makes a control timed even at main 0, and each side's interp
  // carries its own byo snapshot + the game's period spec.
  const byoSpec = normalizeByoyomi(state.config?.tc.byoyomi ?? null)
  const timed = (state.config?.tc.initialMs ?? 0) > 0 || byoSpec !== null
  const baseMs = state.config?.tc.initialMs ?? 0
  const clockLive = timed && !over && !state.peerAway
  const onLowTime = useCallback(() => {
    if (settings.lowTimeWarning) play('lowTime')
  }, [play, settings.lowTimeWarning])
  const sideInterp = (side: Color) => {
    if (!state.clock) return undefined
    // Re-shape the store's per-GAME byo snapshot into the Clock's per-SIDE one.
    const { byo, ...clock } = state.clock
    return {
      ...clock,
      side,
      baseMs,
      ...(byoSpec ? { byoSpec } : {}),
      ...(byo ? { byo: { ...byo[side] } } : {})
    }
  }
  const opponentClock = {
    ms: liveMs(state.clock, opponentColor),
    active: clockLive && turn === opponentColor,
    over,
    interp: sideInterp(opponentColor)
  }
  const userClock = {
    ms: liveMs(state.clock, userColor),
    active: clockLive && turn === userColor,
    over,
    interp: sideInterp(userColor),
    onLowTime
  }

  const onMove = useCallback((move: string) => void onlineStore.playMove(move), [])

  const title = entry?.spec.title ?? state.gameKind
  const canFlip = entry?.spec.flipPolicy === 'rotate'

  return (
    <div className="online-game">
      <OnlineStatusBar state={state} over={over} onLeaveRequest={onLeaveRequest} />
      <PeerStrips state={state} over={over} />

      <div className="play-view is-kernel">
        <div className="play-board-area">
          <PlayerChip
            kind="user"
            name={opponentName}
            sub={timed ? formatClock(opponentClock.ms) : 'Online'}
            color={opponentColor}
            active={opponentClock.active}
            clock={timed ? opponentClock : null}
          />

          <div className="kernel-board-stage">
            {BoardComp && entry ? (
              is3d ? (
                <Board3DHost
                  kind={entry.spec.kind}
                  state={state.boardState}
                  orientation={state.orientation}
                  interactive={interactive}
                  onMove={onMove}
                />
              ) : (
                <Suspense fallback={<KernelBoardLoading title={title} />}>
                  <BoardComp
                    kind={entry.spec.kind}
                    state={state.boardState}
                    orientation={state.orientation}
                    interactive={interactive}
                    onMove={onMove}
                  />
                </Suspense>
              )
            ) : (
              <div className="kernel-board-missing" role="alert">
                This build has no board for “{state.gameKind}”.
              </div>
            )}
          </div>

          <PlayerChip
            kind="user"
            name={settings.username}
            avatar={settings.avatar}
            color={userColor}
            active={userClock.active}
            clock={timed ? userClock : null}
          />

          {state.banner ? (
            <ResultBanner
              result={state.banner.result}
              reason={state.banner.reason}
              outcomeForUser={state.banner.outcomeForUser}
              title={state.banner.title}
              onNewGame={() => onlineStore.leave()}
              onRematch={state.peerLeft ? undefined : () => void onlineStore.offerRematch()}
            />
          ) : (
            <div className="board-controls play-controls">
              <div
                className={`play-controls-group${resignArmed ? ' is-confirm' : ''}`}
                role="group"
                aria-label="Game controls"
              >
                {resignArmed ? (
                  <span className="resign-confirm" role="alertdialog" aria-label="Confirm resignation">
                    <span className="resign-confirm-label">
                      <Flag size={13} aria-hidden /> Resign this game?
                    </span>
                    <button className="btn play-resign-commit" onClick={handleResign} disabled={over}>
                      Yes, resign
                    </button>
                    <button className="btn ghost" onClick={() => setResignArmed(false)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <>
                    <BoardModeToggle kind={state.gameKind} />
                    {canFlip && (
                      <>
                        <button
                          className="icon-btn"
                          onClick={() => onlineStore.flip()}
                          title="Flip board"
                          aria-label="Flip board"
                        >
                          <FlipVertical2 size={17} />
                        </button>
                        <span className="play-controls-sep" aria-hidden />
                      </>
                    )}
                    <button
                      className="btn ghost btn-resign"
                      onClick={handleResign}
                      disabled={over}
                      title="Resign"
                    >
                      <Flag size={14} /> Resign
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {over && !state.peerLeft && (
        <RematchStrip name={opponentName} sent={state.rematchSent} offered={state.rematchOffered} />
      )}

      {leaveArmed && <LeaveConfirm onConfirm={onConfirmResignLeave} onCancel={onCancelLeave} />}
    </div>
  )
}

/** Suspense fallback while the game's board module (and any WASM it pulls)
 *  loads: the "preload spinner" of the join flow. */
function KernelBoardLoading({ title }: { title: string }): JSX.Element {
  return (
    <div className="kernel-board-loading" role="status">
      <Loader2 className="spin" size={22} aria-hidden />
      <span>Setting up the {title} board…</span>
    </div>
  )
}
