// Which build the visitor is offered, and where it comes from.

/* WHERE THE BUILDS ARE.
   github.com/isaacmiller123/nodechess is the repo the git remote points at
   and the one carrying every release (renamed from chess-sharp 2026-07-27;
   GitHub 301-redirects the old slug).

   THESE ARE DIRECT DOWNLOADS. /releases/latest/download/<name> resolves with a
   302 to the asset itself, so a click downloads rather than landing the visitor
   on a release page to hunt through seven files.

   THE ONE MAINTENANCE COST, and it is real: electron-builder writes the version
   into every artifact name, so these names carry 1.4.0 and will 404 the moment
   1.5.0 ships. They are all in this one array so it is one edit.

   TO MAKE THEM PERMANENT, drop ${version} from the artifactName entries in
   electron-builder.yml so the files are named nodechess-mac-arm64.dmg and so
   on. Then /releases/latest/download/ never rots. Check first that
   src/main/updates/updateLogic.ts pickWinAsset still matches: its comment says
   it keys off the installer's exact prefix, so renaming without looking would
   break auto-update to fix a link. */
const RELEASE_BASE = 'https://github.com/isaacmiller123/nodechess/releases'
const LATEST = `${RELEASE_BASE}/latest/download`

/** Every asset the current release actually publishes, verified against the
 *  GitHub API rather than guessed. Sizes are the real ones, so a visitor on a
 *  phone plan knows what they are starting. */
export const RELEASE_VERSION = '1.4.0'

export type PlatformId = 'macos' | 'macos-intel' | 'windows' | 'linux' | 'ios' | 'android'

export interface PlatformOffer {
  id: PlatformId
  /** What the visitor calls it. */
  name: string
  /** Null when there is nothing to download for that platform yet. */
  href: string | null
  /** One short line under the control. */
  note: string
  /** Shown next to the control so a download is never a surprise. */
  size?: string
}

/* The notes describe what electron-builder.yml ACTUALLY emits, so this list
   cannot promise a build no target produces:
     mac    dmg + zip, arm64 and x64
     win    NSIS installer, portable exe and zip, x64 only
     linux  AppImage + deb, x64 only (added 1.4.0)

   THE ASSET PREFIX CHANGED. Up to and including 1.3.0 electron-builder wrote
   `Chess-...` because productName was still Chess#. It is `nodechess-...` from
   1.4.0 on. Both the version AND the prefix move together, which is why every
   link is built from RELEASE_VERSION rather than written out. */
export const OFFERS: readonly PlatformOffer[] = [
  {
    id: 'macos',
    name: 'macOS, Apple silicon',
    href: `${LATEST}/nodechess-${RELEASE_VERSION}-arm64.dmg`,
    note: 'M1 and later',
    size: '177 MB'
  },
  {
    id: 'macos-intel',
    name: 'macOS, Intel',
    href: `${LATEST}/nodechess-${RELEASE_VERSION}-x64.dmg`,
    note: 'Pre-2020 Macs',
    size: '179 MB'
  },
  {
    id: 'windows',
    name: 'Windows',
    href: `${LATEST}/nodechess-Setup-${RELEASE_VERSION}.exe`,
    note: '64 bit installer',
    size: '144 MB'
  },
  {
    id: 'linux',
    name: 'Linux',
    href: `${LATEST}/nodechess-${RELEASE_VERSION}-linux-x64.AppImage`,
    // Said plainly because it is the one platform where a headline feature is
    // missing: ENGINE_ARTIFACTS in src/main/datasets/datasets.service.ts has no
    // linux-x64 row, so Settings -> Datasets offers the puzzle DB and no engine.
    note: 'AppImage, x64. No Stockfish analysis yet',
    size: '180 MB'
  },
  { id: 'ios', name: 'iOS', href: null, note: 'The iOS app is coming soon' },
  { id: 'android', name: 'Android', href: null, note: 'The Android app is coming soon' }
]

/** Everything, for the release page, when a visitor wants a build this page did
 *  not lead with. */
export const ALL_RELEASES_URL = `${RELEASE_BASE}/latest`

export const offerFor = (id: PlatformId): PlatformOffer =>
  OFFERS.find((o) => o.id === id) ?? OFFERS[3]

/** The shape of the two things this reads, neither of which TS declares. */
interface UaData {
  platform?: string
}
interface UaWindow extends Navigator {
  userAgentData?: UaData
}

/**
 * The platform to lead with. userAgentData first, because a Chromium browser
 * answers it plainly; the user agent string second, because everything else
 * only has that. An iPad on iPadOS 13 and up says Macintosh, so a Mac claim
 * with a touch screen behind it is read as an iPad.
 *
 * Apple silicon versus Intel cannot be told apart from the user agent: every
 * Mac says the same thing. Apple silicon leads because it is every Mac sold
 * since 2020, and the Intel build is one control away in the full list.
 *
 * THE FALLBACK IS WINDOWS, NOT LINUX, as of 1.4.0. It was linux while linux
 * had no build, where leading with it meant showing "no Linux build yet": a
 * truthful answer for a browser we could not identify. Now that Linux is a real
 * AppImage, that same fallback would hand an unidentifiable visitor a binary
 * their machine probably cannot run. Windows is the majority desktop, so it is
 * the better guess, and every other build stays one control away in the full
 * list below the lead.
 */
export function detectPlatform(): PlatformId {
  if (typeof navigator === 'undefined') return 'windows'
  const nav = navigator as UaWindow
  const hinted = (nav.userAgentData?.platform ?? '').toLowerCase()
  const ua = nav.userAgent ?? ''
  const touch = typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0

  if (/iphone|ipad|ipod/i.test(ua)) return 'ios'
  if (hinted === 'android' || /android/i.test(ua)) return 'android'
  if (/macintosh|mac os x/i.test(ua) || hinted === 'macos') {
    return touch > 1 ? 'ios' : 'macos'
  }
  if (hinted === 'windows' || /windows/i.test(ua)) return 'windows'
  if (hinted === 'linux' || /linux|x11|cros/i.test(ua)) return 'linux'
  return 'windows'
}
