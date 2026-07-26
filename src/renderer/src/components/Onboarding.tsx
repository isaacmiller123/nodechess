import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { Cpu, Database, WifiOff, Bot, type LucideIcon } from 'lucide-react'
import { OverlayDialog } from './OverlayDialog'
import Logo from './Logo'
import { useSettings } from '../state/settings'
import type { ViewKey } from './Layout'
// The welcome surfaces share one stylesheet.
import '../features/welcome/welcome.css'

/**
 * DESKTOP FIRST LAUNCH. The one popup a downloaded copy shows once, ever.
 *
 * It is desktop only by construction: App.tsx picks it, and the web first run
 * is the landing page instead. Nothing here branches on isWebBuild, because a
 * branch would imply this can render on the web, and it cannot.
 *
 * IT IS SHAPED LIKE A PAGE, NOT A DIALOG, and that is the point. This is the
 * first thing a downloaded copy shows: it opens with the mark at hero size, a
 * thank you, and a section of what the build adds, with no head strip and no
 * close cross in the corner. The returning popup next door is the opposite
 * shape on purpose, a 400px card someone can kill in a keystroke. If these two
 * ever converge on the same box, the difference between arriving and returning
 * has been thrown away.
 *
 * WHAT IT SAYS, AND WHY EACH LINE SURVIVED. Someone who just downloaded a
 * desktop build has already been sold on the app; what they do not know is what
 * they got that the site does not have. So the list is differences, and every
 * one of them was checked against the code rather than the marketing:
 *
 *  - Stockfish is NOT bundled. electron-builder.yml leaves the ~114 MB engine
 *    out of the installer on purpose and datasets.service.ts imports it at
 *    runtime, so the honest claim is "one download, then native", not
 *    "included". The web build is not engineless either: it runs
 *    stockfish-18-lite in WASM (vite.web.config.ts ENGINE_ASSETS), so the
 *    difference is full versus lite, and that is what the line says.
 *  - The puzzle database really is a local file here (datasets 'puzzles', a
 *    single SQLite artifact) where the web build reads chunks over the
 *    network, and reports puzzles:false when they are not deployed.
 *  - Offline is real: engine, puzzles, games and analysis are all on this
 *    machine. It is scoped to those, because online play obviously is not.
 *  - Maia and KataGo are hard-coded desktop only in the web api
 *    (webApi.ts DATASETS_NONE: "maia/katago stay desktop-only"), which is the
 *    same fact KernelBot states in its own words.
 *
 * The name field stays. It is the only place the app ever asks, and Settings
 * is where you would otherwise have to go looking for it.
 */
export interface OnboardingProps {
  onClose: () => void
  onNavigate: (view: ViewKey) => void
}

const DESKTOP_ADVANTAGES: { key: string; title: string; body: string; Icon: LucideIcon }[] = [
  {
    key: 'engine',
    title: 'The full Stockfish engine',
    body: 'One download in Settings and Stockfish 18 runs natively on your own CPU, not the lite build a browser tab is limited to.',
    Icon: Cpu
  },
  {
    key: 'puzzles',
    title: 'The whole puzzle database, on disk',
    body: 'The Lichess puzzle set downloads once and stays here, so every theme and rating band is yours to draw from.',
    Icon: Database
  },
  {
    key: 'offline',
    title: 'Works with the network off',
    body: 'Games against the engine, puzzles, School and analysis all run on this machine. There is nothing to reach.',
    Icon: WifiOff
  },
  {
    key: 'bots',
    title: 'Bots the web build cannot run',
    body: 'Maia, the human-style neural nets, and KataGo behind the Go boards. Neither has come to the web yet.',
    Icon: Bot
  }
]

/* The mark is the hero here, so it is drawn at a size where the lattice
   actually resolves. Logo falls back to the reduced rook at or below 24px. */
const HERO_MARK = 76

export function Onboarding({ onClose, onNavigate }: OnboardingProps): JSX.Element {
  const { settings, update } = useSettings()
  const [name, setName] = useState(settings.username === 'User' ? '' : settings.username)
  const startRef = useRef<HTMLButtonElement>(null)

  /* Focus starts on the primary action, not on the close affordance and not on
     the optional name field. OverlayDialog focuses the first focusable child in
     its own effect; this component sits above it in the tree, so this effect
     runs after that one and wins. */
  useEffect(() => {
    startRef.current?.focus()
  }, [])

  const commitName = (): void => {
    const trimmed = name.trim()
    if (trimmed && trimmed !== settings.username) update({ username: trimmed.slice(0, 24) })
  }

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    commitName()
    onClose()
  }

  const goTo = (view: ViewKey): void => {
    commitName()
    onNavigate(view)
    onClose()
  }

  return (
    <OverlayDialog
      onClose={onClose}
      placement="center"
      className="welcome-fr"
      labelledBy="onboarding-title"
    >
      <div className="welcome-fr-body">
        <div className="welcome-fr-hero">
          <span className="welcome-fr-mark">
            <Logo size={HERO_MARK} variant="lattice" motion="both" title="nodechess" />
          </span>
          <h2 id="onboarding-title" className="welcome-fr-title">
            Thanks for downloading{' '}
            <span className="nc-word">
              <span className="nc-word-a">node</span>
              <span className="nc-word-b">chess</span>
            </span>
          </h2>
          <p className="welcome-fr-lede">This build is not a wrapper around the website.</p>
        </div>

        <section className="sec welcome-fr-sec">
          <div className="sec-head">
            <h3 className="lbl">What it adds</h3>
            <span className="sec-count">{DESKTOP_ADVANTAGES.length} things</span>
          </div>
          <div className="panel">
            {DESKTOP_ADVANTAGES.map(({ key, title, body, Icon }) => (
              <div className="row welcome-adv" key={key}>
                <span className="welcome-adv-icon">
                  <Icon size={18} aria-hidden />
                </span>
                <span className="welcome-adv-text">
                  <strong className="welcome-adv-title">{title}</strong>
                  <span className="welcome-adv-body">{body}</span>
                </span>
              </div>
            ))}
          </div>
        </section>

        <form className="well welcome-fr-name" onSubmit={onSubmit}>
          <label className="lbl" htmlFor="welcome-fr-name-input">
            Your name
          </label>
          <input
            id="welcome-fr-name-input"
            className="filter-input"
            type="text"
            value={name}
            maxLength={24}
            placeholder="Player"
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
          />
        </form>
      </div>

      {/* No close cross: the quiet button is the close, and it says where it
          leaves you. Escape and the scrim close it too. */}
      <div className="shell-modal-foot">
        <button type="button" className="btn is-quiet" onClick={onClose}>
          Look around first
        </button>
        <button type="button" className="btn is-primary" ref={startRef} onClick={() => goTo('play')}>
          Start playing
        </button>
      </div>
    </OverlayDialog>
  )
}
