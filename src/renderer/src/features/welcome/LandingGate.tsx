import { Suspense, lazy, type ComponentType, type JSX } from 'react'
import './welcome.css'

/**
 * The web first visit surface: features/landing/Landing.tsx, owned by another
 * agent, loaded through here.
 *
 * THE CONTRACT: default export, one prop, `onEnter: () => void`. Calling it
 * means "I have read the page, put me in the app", and this side of the wire
 * is what records the first run and drops the shell in.
 *
 * WHY A GLOB AND NOT AN IMPORT. The landing page may not exist in this
 * checkout yet. A static `import('../landing/Landing')` would be a hard build
 * error the moment it is missing, taking the entire app down over a page that
 * only a first-time visitor ever sees. import.meta.glob resolves to an empty
 * map instead, and Vite picks the module up the moment the file appears. The
 * module is still code split: nothing here is eager.
 */
export interface LandingProps {
  onEnter: () => void
}

const LANDING_MODULES = import.meta.glob('../landing/Landing.tsx') as Record<
  string,
  () => Promise<unknown>
>

/**
 * Shown ONLY when the landing module is absent from the build. It is a
 * degraded state, not a second landing page: one true sentence and the way in,
 * so a missing module cannot lock a first-time visitor out of the app.
 */
function LandingUnavailable({ onEnter }: LandingProps): JSX.Element {
  return (
    <div className="welcome-landing-fallback">
      <h1>nodechess</h1>
      <p>Play chess, train tactics and study, in the browser.</p>
      <button type="button" className="btn is-primary" onClick={onEnter}>
        Enter
      </button>
    </div>
  )
}

const Landing = lazy(async () => {
  const load = Object.values(LANDING_MODULES)[0]
  if (!load) return { default: LandingUnavailable }
  try {
    const mod = (await load()) as { default?: ComponentType<LandingProps> }
    return { default: mod.default ?? LandingUnavailable }
  } catch {
    // A chunk that fails to load (flaky network mid-deploy) must not blank the
    // page: the visitor still gets a way in.
    return { default: LandingUnavailable }
  }
})

export function LandingGate({ onEnter }: LandingProps): JSX.Element {
  return (
    <Suspense fallback={<div className="view-loading" role="status" aria-live="polite" />}>
      <Landing onEnter={onEnter} />
    </Suspense>
  )
}

export default LandingGate
