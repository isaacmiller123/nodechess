import { useEffect, useState } from 'react'
import type { Role } from 'chessops/types'
import type { Key } from 'chessground/types'
import { FlipVertical2, Flag, RotateCcw, GraduationCap, ChevronDown, Undo2 } from 'lucide-react'
import { Board } from '../../board/Board'
import { PromotionPicker } from '../../board/PromotionPicker'
import { MoveList } from '../../panels/MoveList'
import { CoachHint, type CoachHintLastMove } from '../../components/CoachHint'
import type { GameTree } from '../../state/gameTree'
import type { BoardTheme } from '../../state/settings'
import type { Color, GameResult } from '../../chess/chess'
import { useOpeningTrace } from '../../chess/openingTrace'
import { SCHOOL_BRUSHES } from '../school/annotations'
import { AssistPanel, useAssist } from './Assist'
import type { ClockInterp } from './Clock'
import { PlayerChip } from './PlayerChip'
import { ResultBanner } from './ResultBanner'
import './game.css'

/** Clock state for one side, passed down from the clock engine. */
export interface ClockSide {
  ms: number
  active: boolean
  /** ONLINE path: authoritative snapshot the Clock self-ticks from at 100ms
   *  (Clock.tsx `interp`). Absent = local play, where `ms` is already live. */
  interp?: ClockInterp
  /** ONLINE path: one-shot low-time hook, forwarded to the Clock. */
  onLowTime?: () => void
}

export interface GameViewBanner {
  result: GameResult
  reason: string
  outcomeForUser: 'win' | 'loss' | 'draw'
  delta?: number
  newRating?: number
  /** Post-game accuracy % (0–100). Reserved teaser slot on the banner. */
  accuracy?: number
  /** Overrides the banner headline (used by Over-the-board, where there is no
   *  "you": e.g. "White wins"). Absent = the default You won/lost/Draw copy. */
  title?: string
}

export interface GameViewProps {
  /** Over-the-board (two humans on one screen): the board is movable for the
   *  side to MOVE (not a fixed `userColor`), and the Coach panel is hidden.
   *  Everything else (chips, clocks, takeback, banner) is driven by the props
   *  the caller already maps to board sides. Defaults to false (vs engine). */
  otb?: boolean
  fen: string
  orientation: Color
  turn: Color
  userColor: Color
  dests: Map<Key, Key[]>
  lastMove?: [Key, Key]
  check?: Color
  thinking: boolean
  /** Long bot think (allocation >= ~8s): the thinking dots switch to a calm,
   *  warm "thinking deeply" pulse. */
  deepThink?: boolean
  over: boolean
  /** True when viewing the live game position (the mainline tip). */
  atTip: boolean
  pendingPromo: { orig: string; dest: string } | null
  nonce: number
  boardTheme: BoardTheme
  /** Wrapper class for the active piece set, e.g. "pieces-merida". */
  pieceSetClass: string
  showLegal: boolean
  coordinates: boolean
  animation: boolean
  userName: string
  userAvatar: string | null
  /** Opponent chip display name (Stockfish, or a persona's name). */
  opponentName: string
  /** Opponent chip sub-label, e.g. "2780 Elo". */
  opponentSub: string
  /** Optional opponent style line, e.g. "in the style of …". */
  opponentStyleLine?: string
  /** Persona portrait data URI for the opponent card (base64 <img src>). */
  opponentPhoto?: string | null
  /** Whether a clock is running for this game (Unlimited hides clocks). */
  clockActive: boolean
  /** Remaining time + active flag for the opponent (top chip). */
  opponentClock: ClockSide
  /** Remaining time + active flag for the user (bottom chip). */
  userClock: ClockSide
  /** Ask an inline "are you sure?" before resigning (settings.confirmResign). */
  confirmResign?: boolean
  /** Show the Takeback control at all (settings.allowTakebacks). */
  allowTakebacks?: boolean
  /** There is a user move to take back right now (game live, move exists). */
  canTakeback?: boolean
  /** Take back the user's last move (plus the bot's reply when it landed). */
  onTakeback?: () => void
  /** Master switch for play assistance (settings.hintsEnabled). Off hides the
   *  Assistance panel and all of its board shapes entirely. */
  hintsEnabled: boolean
  /** Online live game: the "New game" control is a local-play affordance that
   *  would abandon the session, so it is hidden while the game is undecided
   *  (Leave, with its own confirm, is the exit). Post-banner is unaffected
   *  (the banner owns New game / Rematch). Defaults to false (local play). */
  onlineLive?: boolean
  /** Freeze board input regardless of turn (online: peer away / left). The
   *  board becomes view-only but history browsing and controls still work.
   *  Defaults to false. */
  inputFrozen?: boolean
  tree: GameTree
  banner: GameViewBanner | null
  onMove: (orig: Key, dest: Key) => void
  onPromo: (role: Role) => void
  onPromoCancel: () => void
  onResign: () => void
  onNewGame: () => void
  onFlip: () => void
  /** Open the finished game in Analysis (shown on the result banner when saved). */
  onAnalyze?: () => void
  /** Start another game with the same settings (result banner "Rematch"). */
  onRematch?: () => void
}

export function GameView({
  otb = false,
  fen,
  orientation,
  turn,
  userColor,
  dests,
  lastMove,
  check,
  thinking,
  deepThink = false,
  over,
  atTip,
  pendingPromo,
  nonce,
  boardTheme,
  pieceSetClass,
  showLegal,
  coordinates,
  animation,
  userName,
  userAvatar,
  opponentName,
  opponentSub,
  opponentStyleLine,
  opponentPhoto,
  clockActive,
  opponentClock,
  userClock,
  confirmResign,
  allowTakebacks = false,
  canTakeback = false,
  onTakeback,
  hintsEnabled,
  onlineLive = false,
  inputFrozen = false,
  tree,
  banner,
  onMove,
  onPromo,
  onPromoCancel,
  onResign,
  onNewGame,
  onFlip,
  onAnalyze,
  onRematch
}: GameViewProps) {
  // Coach is opt-in: off by default so it never intrudes on the game loop.
  const [coachOpen, setCoachOpen] = useState(false)

  // Two-step resign (settings.confirmResign): first click arms the inline
  // confirm, "Yes, resign" commits, Cancel (or the game ending) disarms.
  const [resignArmed, setResignArmed] = useState(false)
  useEffect(() => {
    if (over) setResignArmed(false)
  }, [over])

  // Play assistance (hint ladder + best-move / weakness overlays). The hook is
  // always mounted (hooks before any conditional render); it gates itself on
  // hintsEnabled / game over / whose turn it is and returns empty shapes when
  // inactive.
  const assist = useAssist({
    fen,
    turn,
    userColor,
    atTip,
    over,
    enabled: hintsEnabled
  })

  // Sticky opening identity for the Moves box header ("Ruy Lopez … · in book"):
  // names the line while in theory and keeps the name after the game leaves it.
  const trace = useOpeningTrace(tree)

  const handleResign = (): void => {
    if (confirmResign && !resignArmed) {
      setResignArmed(true)
      return
    }
    setResignArmed(false)
    onResign()
  }

  // Coach "was that move good?" must judge the USER's move. Not the engine's
  // instant reply (which would be tree.current). Walk back to the most recent
  // move made by the user's color (white = odd ply, black = even ply).
  const userIsWhite = userColor === 'white'
  let umNode: GameTree['current'] | null = tree.current
  while (umNode && !(umNode.move && umNode.parent && (umNode.ply % 2 === 1) === userIsWhite)) {
    umNode = umNode.parent
  }
  const coachLastMove: CoachHintLastMove | undefined =
    umNode && umNode.move && umNode.parent
      ? { fenBefore: umNode.parent.fen, played: umNode.move.uci, ply: umNode.ply }
      : undefined

  // Whose turn is it in the position the cards describe? For timed games the
  // clock engine already resolved this against the LIVE game (browsing history
  // never moves the glow); untimed games fall back to the displayed turn, gated
  // on atTip so past positions show no glow.
  const opponentColor: Color = userColor === 'white' ? 'black' : 'white'
  const opponentTurn = clockActive ? opponentClock.active : !over && atTip && turn === opponentColor
  const userTurn = clockActive ? userClock.active : !over && atTip && turn === userColor

  return (
    // is-deepthink softens the opponent chip's thinking dots into the slow,
    // warm "thinking deeply" pulse (bot time manager long allocations).
    <div className={`play-view${deepThink && thinking && !over ? ' is-deepthink' : ''}`}>
      <div className="play-board-area">
        <PlayerChip
          // OTB: the top player is a human too. Render a user chip (no engine
          // avatar / thinking dots). vs engine/persona keeps the engine chip.
          kind={otb ? 'user' : 'engine'}
          name={opponentName}
          sub={opponentSub}
          styleLine={opponentStyleLine}
          photo={opponentPhoto}
          thinking={!otb && thinking && !over}
          deepThink={deepThink}
          fen={fen}
          color={opponentColor}
          active={opponentTurn}
          clock={clockActive ? { ...opponentClock, over } : null}
        />

        <div className="board-stage">
          <div className={`board-wrap board-${boardTheme} ${pieceSetClass}`}>
            <Board
              fen={fen}
              orientation={orientation}
              turnColor={turn}
              dests={dests}
              lastMove={lastMove}
              check={check}
              // OTB: whichever side is to move may move (pass-and-play). vs
              // engine/persona: only the user's own color is movable.
              movableColor={otb ? turn : userColor}
              viewOnly={thinking || over || !atTip || inputFrozen}
              showDests={showLegal}
              coordinates={coordinates}
              animation={animation}
              onMove={onMove}
              shapes={assist.shapes}
              brushes={SCHOOL_BRUSHES}
              // Both terms only ever increase, so the sum changes whenever
              // either does: PlayView's illegal-move resync keeps working and
              // customSvg-only assist shape changes (invisible to shapesKey)
              // still force a re-sync.
              syncNonce={nonce + assist.shapesNonce}
            />
            {pendingPromo && (
              <PromotionPicker color={turn} onSelect={onPromo} onCancel={onPromoCancel} />
            )}
          </div>
        </div>

        <PlayerChip
          kind="user"
          name={userName}
          avatar={userAvatar}
          fen={fen}
          color={userColor}
          active={userTurn}
          clock={clockActive ? { ...userClock, over } : null}
        />

        {banner ? (
          <ResultBanner
            result={banner.result}
            reason={banner.reason}
            outcomeForUser={banner.outcomeForUser}
            title={banner.title}
            delta={banner.delta}
            newRating={banner.newRating}
            accuracy={banner.accuracy}
            onNewGame={onNewGame}
            onAnalyze={onAnalyze}
            onRematch={onRematch}
          />
        ) : (
          <div className="boardbar play-controls">
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
                  <button className="icon-btn" onClick={onFlip} title="Flip board" aria-label="Flip board">
                    <FlipVertical2 size={17} />
                  </button>
                  <span className="play-controls-sep" aria-hidden />
                  {allowTakebacks && onTakeback && (
                    <button
                      className="btn ghost"
                      onClick={onTakeback}
                      disabled={over || !canTakeback}
                      title="Take back your last move (and the reply)"
                    >
                      <Undo2 size={14} /> Takeback
                    </button>
                  )}
                  <button
                    className="btn ghost btn-resign"
                    onClick={handleResign}
                    disabled={over}
                    title="Resign"
                  >
                    <Flag size={14} /> Resign
                  </button>
                  {/* Online live game: no in-game "New game" (it would abandon the
                      session with no result, and the online Leave path handles exit
                      with a confirm). Local play keeps it. */}
                  {!onlineLive && (
                    <button className="btn ghost play-newgame" onClick={onNewGame} title="New game">
                      <RotateCcw size={14} /> New game
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <aside className="play-sidebar">
        <div className="panel move-panel">
          <div className="panel-head">
            <h2 className="lbl">Moves</h2>
          </div>
          <MoveList
            root={tree.root}
            currentId={tree.current.id}
            figurineMode={false}
            onSelect={tree.goTo}
            trace={trace}
          />
        </div>

        {assist.visible && <AssistPanel assist={assist} />}

        {/* No coach in Over-the-board play (two humans, no engine help). */}
        {!otb && (
          <div className="panel coachhint-panel">
            <button
              type="button"
              className="panel-head coachhint-toggle"
              onClick={() => setCoachOpen((o) => !o)}
              aria-expanded={coachOpen}
            >
              <span className="lbl">
                <GraduationCap size={15} /> Coach
              </span>
              <ChevronDown
                size={16}
                className={`coachhint-chevron${coachOpen ? ' is-open' : ''}`}
              />
            </button>
            {coachOpen && (
              <div className="coachhint-panel-body">
                <CoachHint fen={fen} lastMove={coachLastMove} />
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  )
}
