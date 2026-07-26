import { useCallback, useState } from 'react'
import { isWebBuild } from '../../platform'
import {
  chooseWelcomeSurface,
  isFirstRun,
  markFirstRunDone,
  type WelcomeSurface
} from './welcomeState'

/**
 * THE DECISION IS MADE ONCE, AT MODULE LOAD, ON PURPOSE.
 *
 * isFirstRun both reads and (on the legacy migration) writes localStorage, and
 * markFirstRunDone always writes. That makes the decision self-erasing: ask it
 * twice and the second answer is always "not a first run". React StrictMode
 * double invokes render functions and useState initialisers in development, so
 * doing this inside the hook would turn a genuine first visit into a welcome
 * back popup on the second pass, in exactly the environment where it is being
 * developed. Module scope runs once per page load, before React renders.
 *
 * MARKED DONE IMMEDIATELY, not when the surface is dismissed. Someone who opens
 * the landing page and closes the tab has still seen it, and the failure this
 * ordering prevents (a returning player shown the landing page again) is much
 * worse than the one it accepts (a visitor who bounced never sees it twice).
 */
const FIRST_RUN = isFirstRun(isWebBuild)
if (FIRST_RUN) markFirstRunDone(isWebBuild)

const INITIAL_SURFACE: WelcomeSurface = chooseWelcomeSurface(isWebBuild, FIRST_RUN)

export interface Welcome {
  /** The surface to render, or null once it has been dismissed. */
  surface: WelcomeSurface | null
  /** Landing: they pressed enter. Popups: they closed it. */
  dismiss: () => void
}

/** The welcome surface for this load. Pure: see the note above. */
export function useWelcome(): Welcome {
  const [surface, setSurface] = useState<WelcomeSurface | null>(INITIAL_SURFACE)
  const dismiss = useCallback(() => setSurface(null), [])
  return { surface, dismiss }
}
