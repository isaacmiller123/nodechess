import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { GameKind } from '../../games/kernel'
import { isRegisteredGame } from '../../games/registry'
import OnlineTab from '../play/OnlineTab'
import type { CatalogEntry } from './catalog'
import { KernelBot } from './KernelBot'
import { KernelOtb } from './KernelOtb'
import { ManualPane } from './ManualPane'
import { VariantBot } from './VariantBot'
import { VariantOtb } from './VariantOtb'
import type { GameLaunch, SetupMode } from './setup'

/** The mode strip, in the setup screen's own three words. */
const MODE_LABEL: Record<SetupMode, string> = { local: 'Local', bot: 'Bot', online: 'Online' }

/** Catalog kinds that predate the kernel registry's naming. */
const REGISTRY_ALIAS: Record<string, GameKind> = { 'checkers-8': 'checkers', ttt: 'tictactoe' }

/** The registry kind for a catalog entry, or null when this build has no
 *  kernel for it. */
function registryKind(entry: CatalogEntry): GameKind | null {
  if (isRegisteredGame(entry.kind)) return entry.kind
  const alias = REGISTRY_ALIAS[entry.kind]
  return alias !== undefined && isRegisteredGame(alias) ? alias : null
}

function Playbar({
  title,
  tag,
  onBack
}: {
  title: string
  tag: string
  onBack: () => void
}): JSX.Element {
  return (
    <header className="game-playbar">
      <button type="button" className="game-back" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden />
        All games
      </button>
      <h2 className="game-playbar-title">{title}</h2>
      <span className="game-playbar-mode">{tag}</span>
    </header>
  )
}

/**
 * The board, opened on the options the setup screen collected.
 *
 * The design lab stops at Start ("Nothing on this page plays a game"), so
 * everything below the playbar is the app's own play surface: the chess family
 * through the variant adapter, every other family through the generic kernel
 * owner, online through the shared join-code screen.
 */
export function GamePage({
  launch,
  onBack,
  onOpenSettings
}: {
  launch: GameLaunch
  onBack: () => void
  /** Deep link to Settings (KernelBot's inline KataGo install prompt). */
  onOpenSettings?: () => void
}): JSX.Element {
  const { entry, mode, surface } = launch
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

  const kind = registryKind(entry)
  const isChessFamily = entry.family === 'chess'

  let surfaceEl: JSX.Element
  if (mode === 'online') {
    surfaceEl = kind ? (
      <div className="game-online">
        <OnlineTab initialGameKind={kind} />
      </div>
    ) : (
      <NoKernel title={entry.title} />
    )
  } else if (mode === 'bot') {
    surfaceEl = isChessFamily ? (
      <VariantBot entry={entry} onToast={showToast} setup={surface} />
    ) : kind ? (
      <KernelBot
        entry={entry}
        kind={kind}
        onToast={showToast}
        onOpenSettings={onOpenSettings}
        setup={surface}
      />
    ) : (
      <NoKernel title={entry.title} />
    )
  } else {
    surfaceEl = isChessFamily ? (
      <VariantOtb entry={entry} setup={surface} />
    ) : (
      <KernelOtb entry={entry} setup={surface} />
    )
  }

  return (
    <div className="game-page is-playing">
      <Playbar title={entry.title} tag={MODE_LABEL[mode]} onBack={onBack} />
      {surfaceEl}
      {toast && (
        <div className="games-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  )
}

/** A kind the setup screen offered but this build has no rules for. Says so
 *  rather than mounting an empty board. */
function NoKernel({ title }: { title: string }): JSX.Element {
  return (
    <div className="well">
      <div className="empty">
        <p className="empty-line">{title} is not playable in this build.</p>
        <p className="empty-line">Pick another game from the library.</p>
      </div>
    </div>
  )
}

/** The illustrated manual for one game, reached from the setup screen. */
export function ManualPage({
  entry,
  onBack
}: {
  entry: CatalogEntry
  onBack: () => void
}): JSX.Element {
  return (
    <div className="game-page">
      <Playbar title={entry.title} tag="Rules" onBack={onBack} />
      <ManualPane entry={entry} />
    </div>
  )
}
