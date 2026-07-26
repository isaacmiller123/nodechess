/**
 * WHICH WELCOME SURFACE APPEARS, and the one bit of state that decides it.
 *
 * The matrix (isWebBuild picks the column):
 *
 *                 first ever                 every time after
 *   web           the landing page           welcome back (popup)
 *   desktop       first launch (popup)       welcome back + changelog (popup)
 *
 * "First ever" is a single boolean per target, held in localStorage. Getting it
 * wrong is expensive in both directions: a returning player who sees the
 * landing page again thinks the app forgot them, and a brand new player who
 * never sees it lands in a shell with no explanation. So the keys are spelled
 * out here, one per target, and nothing else in the app writes them.
 *
 * THE KEY SUFFIX IS NOT THE APP VERSION. `.v1` is the version of this key's
 * MEANING, and it is a hand written literal on purpose. Never derive it from
 * package.json: shipping 1.4.2 would then hand every existing player a fresh
 * first run, which is exactly the failure this comment exists to prevent. The
 * suffix moves only when someone deliberately decides that everyone should see
 * a first run again, and that is a product decision, not a release.
 *
 * The two targets get separate keys because they are separate installs with
 * separate storage and genuinely different first runs. Someone who used the
 * site and then downloaded the app has not seen the desktop first launch.
 */

/** Web (browser localStorage): the landing page has been seen and entered. */
export const WEB_FIRST_RUN_KEY = 'nodechess.firstRun.web.v1'

/** Desktop (Electron renderer localStorage): the first launch popup has shown. */
export const DESKTOP_FIRST_RUN_KEY = 'nodechess.firstRun.desktop.v1'

/**
 * The key the old single onboarding dialog wrote. Anyone carrying it has
 * already been welcomed once, so they are NOT a first run on this target: the
 * migration below marks the target's new key and leaves the old one in place
 * (deleting it would re-strand the same people if this code is ever rolled
 * back). Read once, then never again.
 */
export const LEGACY_ONBOARDING_KEY = 'oct.onboarding.seen.v1'

const DONE = '1'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // Storage denied (private mode, blocked third-party context). Callers
    // treat this as "already seen": interrupting on every single load is worse
    // than never showing a first run at all.
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage denied: the surface still renders this session, it just cannot
       be remembered. Nothing here is worth failing a mount over. */
  }
}

/** Which target's key applies to this build. */
export function firstRunKey(isWeb: boolean): string {
  return isWeb ? WEB_FIRST_RUN_KEY : DESKTOP_FIRST_RUN_KEY
}

/**
 * True when this target has never been welcomed on this device.
 *
 * Storage being unavailable answers false: see read() above.
 */
export function isFirstRun(isWeb: boolean): boolean {
  const key = firstRunKey(isWeb)
  if (read(key) === DONE) return false
  // Migration, once: someone who saw the old dialog is not a first run. Write
  // the new key so this lookup stops happening after the first boot.
  if (read(LEGACY_ONBOARDING_KEY) === DONE) {
    write(key, DONE)
    return false
  }
  return true
}

/** Record that the first run surface has been shown. Idempotent. */
export function markFirstRunDone(isWeb: boolean): void {
  write(firstRunKey(isWeb), DONE)
}

/** The four surfaces. 'none' is what a denied-storage boot gets. */
export type WelcomeSurface = 'landing' | 'firstRunDesktop' | 'welcomeBack'

/** The whole decision, in one place, so it can be read in one sitting. */
export function chooseWelcomeSurface(isWeb: boolean, firstRun: boolean): WelcomeSurface {
  if (!firstRun) return 'welcomeBack'
  return isWeb ? 'landing' : 'firstRunDesktop'
}
