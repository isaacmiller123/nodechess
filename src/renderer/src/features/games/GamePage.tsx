import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { ArrowLeft, BookOpen, Bot, Globe, Swords, Users } from 'lucide-react'
import { Board } from '../../board/Board'
import { pieceSetClass } from '../../board/pieceSets'
import { useSettings } from '../../state/settings'
import type { GameKind } from '../../games/kernel'
import { isRegisteredGame } from '../../games/registry'
import OnlineTab from '../play/OnlineTab'
import type { CatalogEntry } from './catalog'
import { ArtThumb } from './ArtThumb'
import { KernelBot } from './KernelBot'
import { KernelOtb } from './KernelOtb'
import { ManualPane } from './ManualPane'
import { VariantBot } from './VariantBot'
import { VariantOtb } from './VariantOtb'

type PageTab = 'play' | 'manual'
type PlayMode = 'bot' | 'otb' | 'online'

/** Slim in-play strip labels (the hero collapses once a game starts). */
const MODE_LABEL: Record<PlayMode, string> = { bot: 'vs Bot', otb: 'Local OTB', online: 'Online' }

/** Catalog kinds that predate the kernel registry's naming. */
const REGISTRY_ALIAS: Record<string, GameKind> = { 'checkers-8': 'checkers', ttt: 'tictactoe' }

/** The registry kind for a catalog entry, or null when this build has no
 *  kernel for it (Online then keeps its "landing in P2" toast). */
function registryKind(entry: CatalogEntry): GameKind | null {
  if (isRegisteredGame(entry.kind)) return entry.kind
  const alias = REGISTRY_ALIAS[entry.kind]
  return alias !== undefined && isRegisteredGame(alias) ? alias : null
}

/**
 * Per-game page: hero + Play (vs Bot / Local OTB / Online) + Manual.
 * vs Bot: chess family → VariantBot (Fairy-Stockfish), every other registered
 * kind → KernelBot (KataGo GTP ipc for go, in-process bots for the rest).
 */
export function GamePage({
  entry,
  onBack,
  onOpenSettings
}: {
  entry: CatalogEntry
  onBack: () => void
  /** Deep link to Settings (KernelBot's inline KataGo install prompt). */
  onOpenSettings?: () => void
}): JSX.Element {
  const { settings } = useSettings()
  const [tab, setTab] = useState<PageTab>('play')
  const [mode, setMode] = useState<PlayMode | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    },
    []
  )

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  const onlineKind = registryKind(entry)

  const pickMode = useCallback(
    (m: PlayMode) => {
      // Online: any kernel-registered game. The OnlineTab below is pre-seeded
      // with this kind (wire v4 start config carries it to the joiner).
      if (m === 'online') {
        if (onlineKind) {
          setMode('online')
        } else {
          showToast(`Online ${entry.title} is landing in P2. Join codes will carry the game.`)
        }
        return
      }
      if (entry.status !== 'playable') {
        showToast(`${entry.title} is landing in P2.`)
        return
      }
      if ((m === 'otb' || m === 'bot') && !entry.otbReady) {
        showToast(`The ${entry.title} board is landing in P2.`)
        return
      }
      if (m === 'otb') {
        setMode('otb')
        return
      }
      if (m === 'bot') {
        // Chess family → VariantBot (Fairy-Stockfish); every other registered
        // kind → KernelBot over the games/bots.ts provider seam (KataGo GTP
        // for go. Its install state is handled INLINE by KernelBot).
        // (Standard chess lives in the Play tab's richer PlayView, not here.)
        if (entry.family === 'chess' || onlineKind) {
          setMode('bot')
        } else {
          showToast(`Bots for ${entry.title} are landing in P2.`)
        }
      }
    },
    [entry, onlineKind, showToast]
  )

  const playable = entry.status === 'playable'
  const botReady = playable && entry.otbReady === true && (entry.family === 'chess' || onlineKind !== null)

  return (
    // In-play the page trades the hero for a slim title strip and hands the
    // whole content column to the board (games.css .game-page.is-playing).
    <div className={`game-page${mode ? ' is-playing' : ''}`}>
      {mode ? (
        <header className="game-playbar">
          <button type="button" className="game-back" onClick={() => setMode(null)}>
            <ArrowLeft size={15} aria-hidden />
            Modes
          </button>
          <h2 className="game-playbar-title">{entry.title}</h2>
          <span className="game-playbar-mode">{MODE_LABEL[mode]}</span>
        </header>
      ) : (
        <button type="button" className="game-back" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden />
          All games
        </button>
      )}

      {mode === 'otb' ? (
        // The chess family (chessops + ffish waves, incl. runtime customs)
        // keeps its dedicated view (side naming, janggi pass, 960 reshuffle);
        // every other family plays through the generic kernel owner
        // (go sizes/scoring, hex swap, ...).
        entry.family === 'chess' ? (
          <VariantOtb entry={entry} />
        ) : (
          <KernelOtb entry={entry} />
        )
      ) : mode === 'bot' ? (
        entry.family === 'chess' ? (
          <VariantBot entry={entry} onToast={showToast} />
        ) : (
          <KernelBot
            entry={entry}
            kind={onlineKind!}
            onToast={showToast}
            onOpenSettings={onOpenSettings}
          />
        )
      ) : mode === 'online' && onlineKind ? (
        <div className="game-online">
          <OnlineTab initialGameKind={onlineKind} />
        </div>
      ) : (
        <>
          <header className="game-hero">
            <div className="game-hero-visual" aria-hidden>
              {entry.thumbFen ? (
                <div className={`board-wrap board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)} game-hero-board`}>
                  <Board
                    fen={entry.thumbFen}
                    orientation="white"
                    turnColor="white"
                    dests={new Map()}
                    viewOnly
                    coordinates={false}
                    animation={false}
                  />
                </div>
              ) : (
                <ArtThumb kind={entry.kind} />
              )}
            </div>
            <div className="game-hero-copy">
              <div className="game-hero-titlerow">
                <h2>{entry.title}</h2>
                {!playable && <span className="pill-p2">P2</span>}
              </div>
              <p className="game-hero-tagline">{entry.tagline}</p>
              <div className="game-tabs" role="tablist" aria-label={`${entry.title} sections`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'play'}
                  className={`game-tab${tab === 'play' ? ' is-active' : ''}`}
                  onClick={() => setTab('play')}
                >
                  <Swords size={15} aria-hidden /> Play
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'manual'}
                  className={`game-tab${tab === 'manual' ? ' is-active' : ''}`}
                  onClick={() => setTab('manual')}
                >
                  <BookOpen size={15} aria-hidden /> Manual
                </button>
              </div>
            </div>
          </header>

          {tab === 'play' ? (
            <div className="game-modes">
              <button type="button" className="mode-card" onClick={() => pickMode('bot')}>
                <span className="mode-icon"><Bot size={22} aria-hidden /></span>
                <span className="mode-name">vs Bot</span>
                <span className="mode-desc">Five strength levels, engine-backed</span>
                {botReady ? (
                  <span className="mode-status is-live">Play now</span>
                ) : (
                  <span className="mode-status is-p2">P2</span>
                )}
              </button>
              <button type="button" className="mode-card" onClick={() => pickMode('otb')}>
                <span className="mode-icon"><Users size={22} aria-hidden /></span>
                <span className="mode-name">Local OTB</span>
                <span className="mode-desc">Two players, one machine, auto-flip</span>
                {playable && entry.otbReady ? (
                  <span className="mode-status is-live">Play now</span>
                ) : (
                  <span className="mode-status is-p2">P2</span>
                )}
              </button>
              <button type="button" className="mode-card" onClick={() => pickMode('online')}>
                <span className="mode-icon"><Globe size={22} aria-hidden /></span>
                <span className="mode-name">Online</span>
                <span className="mode-desc">Peer-to-peer with a join code</span>
                {onlineKind ? (
                  <span className="mode-status is-live">Play now</span>
                ) : (
                  <span className="mode-status is-p2">P2</span>
                )}
              </button>
            </div>
          ) : (
            <ManualPane entry={entry} />
          )}
        </>
      )}

      {toast && (
        <div className="games-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  )
}
