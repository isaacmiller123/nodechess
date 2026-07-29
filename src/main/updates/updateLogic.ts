// Update decision logic: the PURE half of src/main/updates. No electron (or
// node) imports so scripts/test-updater.mjs can bundle it headless and golden-
// test every branch in bare node.
//
// Platform policy (HARD CONSTRAINT: design around it, never "fix" it): this
// app ships UNSIGNED.
//   - Windows: electron-updater over the NSIS installer works unsigned →
//     true in-place auto-update (the 'electron-updater' path).
//   - macOS: Squirrel.Mac REFUSES unsigned bundles, so in-place auto-install
//     can NEVER work here. The mac path is check + notify + hand the user the
//     right .dmg to install over the old app (the 'notify-download' path).
//     NEVER attempt an in-place mac install.

/** GitHub repo that hosts the releases (public API: no token needed). */
export const UPDATE_OWNER = 'isaacmiller123'
export const UPDATE_REPO = 'nodechess'

/** How updates are delivered on a given platform/build. */
export type UpdatePath = 'electron-updater' | 'notify-download'

/**
 * The decision table. electron-updater is used ONLY on packaged Windows
 * builds; everything else (mac always: unsigned, dev builds, linux) gets the
 * check-and-notify path with a browser download.
 */
export function decideUpdatePath(platform: string, packaged: boolean): UpdatePath {
  return platform === 'win32' && packaged ? 'electron-updater' : 'notify-download'
}

/** `GET` this to learn the newest published release (drafts/prereleases are
 *  excluded by the endpoint itself). */
export function latestReleaseApiUrl(owner = UPDATE_OWNER, repo = UPDATE_REPO): string {
  return `https://api.github.com/repos/${owner}/${repo}/releases/latest`
}

// ---- semver ------------------------------------------------------------------

interface Semver {
  major: number
  minor: number
  patch: number
  /** Prerelease identifiers after '-' (empty for a release). */
  pre: string[]
}

/** Parse '1.2.3', 'v1.2.3', '1.2.3-beta.1'. Null for anything malformed. */
export function parseSemver(v: string): Semver | null {
  const m = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : []
  }
}

/** Standard semver ordering: -1 | 0 | 1. Prereleases sort BELOW their release. */
export function cmpSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  // Same triple: a release outranks any prerelease.
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  // Both prereleases: identifier-by-identifier, numeric < alphanumeric (semver §11).
  const n = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < n; i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1 // shorter prerelease sorts first
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/** True when `latest` is strictly newer than `current`. Malformed input on
 *  either side → false (never nag off garbage). */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseSemver(latest)
  const b = parseSemver(current)
  if (!a || !b) return false
  return cmpSemver(a, b) > 0
}

// ---- GitHub release payload ----------------------------------------------------

export interface ReleaseAsset {
  name: string
  url: string
}

export interface LatestRelease {
  /** Clean version (tag with any leading 'v' stripped). */
  version: string
  assets: ReleaseAsset[]
  /** Human release page. The universal fallback download link. */
  releaseUrl: string
}

/** Narrow the /releases/latest JSON to what we use. Null on anything odd. */
export function parseLatestRelease(json: unknown): LatestRelease | null {
  if (typeof json !== 'object' || json === null) return null
  const o = json as Record<string, unknown>
  if (typeof o.tag_name !== 'string' || !parseSemver(o.tag_name)) return null
  const assets: ReleaseAsset[] = []
  if (Array.isArray(o.assets)) {
    for (const raw of o.assets) {
      const a = raw as Record<string, unknown>
      if (typeof a?.name === 'string' && typeof a?.browser_download_url === 'string') {
        assets.push({ name: a.name, url: a.browser_download_url })
      }
    }
  }
  return {
    version: o.tag_name.replace(/^[vV]/, ''),
    assets,
    releaseUrl: typeof o.html_url === 'string' ? o.html_url : ''
  }
}

// ---- asset selection -----------------------------------------------------------

/**
 * The right mac download for this machine. Artifact names come from
 * electron-builder.yml: dmg = `nodechess-<v>-<arch>.dmg`, zip =
 * `nodechess-<v>-mac-<arch>.zip`. Matched by suffix only, so releases published
 * under the old `Chess-` name still resolve. Preference: exact-arch dmg →
 * exact-arch zip → any dmg (better than nothing on an unknown arch) → null.
 */
export function pickMacAsset(assets: ReleaseAsset[], arch: string): ReleaseAsset | null {
  return (
    assets.find((a) => a.name.endsWith(`-${arch}.dmg`)) ??
    assets.find((a) => a.name.endsWith(`-mac-${arch}.zip`)) ??
    assets.find((a) => a.name.endsWith('.dmg')) ??
    null
  )
}

/** The Windows manual-path download (dev builds / fallback): the NSIS
 *  installer `nodechess-Setup-<v>.exe`, never the portable exe. The legacy
 *  `Chess-Setup-` prefix is still accepted so a nodechess build can update off
 *  a release cut before the rename. */
export function pickWinAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  return assets.find((a) => /^(?:nodechess|Chess)-Setup-.*\.exe$/.test(a.name)) ?? null
}

/**
 * Which kind of Linux package this build was installed from, or null when that
 * cannot be known.
 *
 * THIS CANNOT BE GUESSED FROM THE ASSET NAMES, and guessing is the trap. A
 * release carries both a .AppImage and a .deb; handing a .deb to someone
 * running the AppImage (or the reverse) is worse than handing them nothing,
 * because it looks like it worked. The only honest source is the running
 * install itself, which is why updateService resolves this from the AppImage
 * env var and electron-builder's `package-type` resource rather than from the
 * release. Anything it cannot identify stays null and gets the release page.
 */
export type LinuxPackageFormat = 'appimage' | 'deb' | null

/** The Linux artifact matching the format the user actually installed. */
export function pickLinuxAsset(
  assets: ReleaseAsset[],
  format: LinuxPackageFormat
): ReleaseAsset | null {
  if (format === 'appimage') return assets.find((a) => /\.AppImage$/i.test(a.name)) ?? null
  if (format === 'deb') return assets.find((a) => /\.deb$/i.test(a.name)) ?? null
  return null
}

/** Per-platform pick for the notify-download path. Unknown platform → null
 *  (the release page link still works). */
export function pickAssetForPlatform(
  assets: ReleaseAsset[],
  platform: string,
  arch: string,
  linuxFormat: LinuxPackageFormat = null
): ReleaseAsset | null {
  if (platform === 'darwin') return pickMacAsset(assets, arch)
  if (platform === 'win32') return pickWinAsset(assets)
  if (platform === 'linux') return pickLinuxAsset(assets, linuxFormat)
  return null
}
