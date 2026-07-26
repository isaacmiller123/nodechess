import { lazy, Suspense, useCallback, useEffect, useState, type JSX } from 'react'
import { Layout, type ViewKey } from './components/Layout'
import { Placeholder } from './components/Placeholder'
import { SettingsProvider } from './state/settings'
import HomeView from './features/home/HomeView'
import { CommandPalette } from './components/CommandPalette'
import { ShortcutsHelp } from './components/ShortcutsHelp'
import { Onboarding } from './components/Onboarding'
import { LandingGate } from './features/welcome/LandingGate'
import { WelcomeBack } from './features/welcome/WelcomeBack'
import { useWelcome } from './features/welcome/useWelcome'
import { isWebBuild } from './platform'
import { OnlineReturnChip } from './features/play/OnlineReturnChip'
import { UpdateToast } from './components/UpdateToast'
import { useOnlineGame } from './features/play/online/useOnlineGame'
import './components/shell-overlays.css'

// Home stays eager (first paint); every other view is code-split so the initial
// bundle only carries the dashboard. React.lazy needs default exports, so views
// that export a named component are adapted to a default here.
const PlayView = lazy(() => import('./features/play/PlayView'))
const GamesView = lazy(() => import('./features/games/GamesView'))
const PuzzlesView = lazy(() => import('./features/puzzles/PuzzlesView'))
const OpeningsView = lazy(() => import('./features/openings/OpeningsView'))
const ProgressView = lazy(() => import('./features/progress/ProgressView'))
const SchoolView = lazy(() => import('./features/school/SchoolView'))
const AnalysisView = lazy(() =>
  import('./features/analysis/AnalysisView').then((m) => ({ default: m.AnalysisView }))
)
const SettingsView = lazy(() =>
  import('./features/settings/SettingsView').then((m) => ({ default: m.SettingsView }))
)
const AccountView = lazy(() => import('./features/account/AccountView'))

/* There is no screen title anywhere in v1 and so there is no TITLES map here
   any more. The old shell printed the name of the current screen in a top bar;
   v1 spends that row on the readout instead, on the grounds that you already
   know which screen you clicked and you do not know your rating. */

/* The first-run keys, the legacy onboarding key it migrates, and the whole
   web/desktop matrix live in features/welcome/welcomeState.ts. Nothing about
   which welcome surface appears is decided here any more: App only renders
   what useWelcome() picked. */

function ViewFallback(): JSX.Element {
  return (
    <div className="view-loading" role="status" aria-live="polite">
      <span className="view-spinner" aria-hidden />
      <span className="visually-hidden">Loading…</span>
    </div>
  )
}

function CurrentView({
  view,
  onNavigate,
  gameId,
  onOpenGame,
  famousId,
  onOpenFamousGame
}: {
  view: ViewKey
  onNavigate: (v: ViewKey) => void
  gameId?: number
  onOpenGame: (id: number) => void
  /** Famous-game id to open in Analysis (e.g. "morphy-g1"). */
  famousId?: string
  onOpenFamousGame: (id: string) => void
}): JSX.Element {
  switch (view) {
    case 'home':
      return <HomeView onNavigate={onNavigate} onOpenGame={onOpenGame} />
    case 'play':
      return (
        <PlayView
          onAnalyzeGame={onOpenGame}
          onOpenFamousGame={onOpenFamousGame}
          onOpenSettings={() => onNavigate('settings')}
        />
      )
    case 'games':
      return <GamesView onOpenSettings={() => onNavigate('settings')} onOpenChessGame={onOpenGame} />
    case 'puzzles':
      return <PuzzlesView />
    case 'openings':
      return <OpeningsView />
    case 'school':
      return <SchoolView onOpenSettings={() => onNavigate('settings')} />
    case 'progress':
      return <ProgressView onNavigate={onNavigate} onOpenGame={onOpenGame} />
    case 'analysis':
      return (
        <AnalysisView
          gameId={gameId}
          famousId={famousId}
          onOpenSettings={() => onNavigate('settings')}
        />
      )
    case 'account':
      return <AccountView />
    case 'settings':
      return <SettingsView />
    default:
      return <Placeholder view={view} />
  }
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const p = navigator.platform || ''
  return /mac|iphone|ipad|ipod/i.test(p) || /mac/i.test(navigator.userAgent)
}

/**
 * Inner shell: routing plus the app-shell overlays (command palette, shortcuts
 * help) and the welcome surface for this load.
 *
 * THE WELCOME SURFACE. features/welcome decides which of the three it is; this
 * component only renders it. Two of them are popups over the shell. The third,
 * the web landing page, REPLACES the shell: it explains the site before you are
 * in it, so drawing the app behind it would defeat the point. That is the early
 * return below, and it sits after every hook in this component deliberately.
 */
function AppShell(): JSX.Element {
  const welcome = useWelcome()
  // Live online session (survives across all views; the store is app-lifetime).
  // Drives the Play-rail pulsing dot and a floating "return to game" chip when
  // the Play view isn't the one showing.
  const online = useOnlineGame()
  const onlineLive = online.phase === 'game' || online.phase === 'hosting'
  const [view, setView] = useState<ViewKey>('home')
  const [pendingGameId, setPendingGameId] = useState<number | null>(null)
  const [pendingFamousId, setPendingFamousId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const isMac = isMacPlatform()

  // Plain navigation clears any pending game so opening Analysis from the rail
  // gives a fresh board; openGame carries a saved game's id into Analysis and
  // openFamousGame a famous-game id (persona "see their famous games"). The two
  // pending ids are mutually exclusive. Setting one clears the other.
  const navigate = useCallback((v: ViewKey) => {
    setPendingGameId(null)
    setPendingFamousId(null)
    setView(v)
  }, [])
  const openGame = useCallback((id: number) => {
    setPendingFamousId(null)
    setPendingGameId(id)
    setView('analysis')
  }, [])
  const openFamousGame = useCallback((id: string) => {
    setPendingGameId(null)
    setPendingFamousId(id)
    setView('analysis')
  }, [])

  // Global shortcuts: Cmd/Ctrl+K toggles the palette; '?' opens shortcuts help.
  // Both ignore typing contexts so they never hijack text entry.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setShortcutsOpen(false)
        setPaletteOpen((o) => !o)
        return
      }
      const target = e.target as HTMLElement | null
      const typing =
        !!target &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      if (!mod && !typing && e.key === '?') {
        e.preventDefault()
        setPaletteOpen(false)
        setShortcutsOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /* WEB, FIRST EVER VISIT. The landing page instead of the app, never over it.
     Every hook in this component is above this line; nothing below it is
     conditional on the branch. features/landing is another agent's file, so
     LandingGate loads it lazily and survives its absence. */
  if (welcome.surface === 'landing') {
    return <LandingGate onEnter={welcome.dismiss} />
  }

  return (
    <>
      <Layout active={view} onNavigate={navigate} playPulse={onlineLive && view !== 'play'}>
        <Suspense fallback={<ViewFallback />}>
          <CurrentView
            view={view}
            onNavigate={navigate}
            gameId={pendingGameId ?? undefined}
            onOpenGame={openGame}
            famousId={pendingFamousId ?? undefined}
            onOpenFamousGame={openFamousGame}
          />
        </Suspense>
      </Layout>
      {/* Floating return chip: only when a session is live and the Play view
          isn't showing (lichess free-navigation model). Click → back to Play. */}
      {onlineLive && view !== 'play' && (
        <OnlineReturnChip state={online} onReturn={() => navigate('play')} />
      )}
      {/* Startup "new version" nudge (main pushes the status after its quiet
          launch check). Raised above the return chip when both are showing. */}
      <UpdateToast
        raised={onlineLive && view !== 'play'}
        onOpenSettings={() => navigate('settings')}
      />
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onNavigate={navigate} />}
      {shortcutsOpen && <ShortcutsHelp onClose={() => setShortcutsOpen(false)} isMac={isMac} />}
      {/* DESKTOP, FIRST EVER LAUNCH: thanks, and what this build gives them. */}
      {welcome.surface === 'firstRunDesktop' && (
        <Onboarding onClose={welcome.dismiss} onNavigate={navigate} />
      )}
      {/* EVERY LOAD AFTER THE FIRST, both targets. The changelog rides along on
          desktop only: a web visit is always the current build. */}
      {welcome.surface === 'welcomeBack' && (
        <WelcomeBack
          onClose={welcome.dismiss}
          onOpenAccount={() => navigate('account')}
          withChangelog={!isWebBuild}
        />
      )}
    </>
  )
}

export default function App(): JSX.Element {
  return (
    <SettingsProvider>
      <AppShell />
    </SettingsProvider>
  )
}
