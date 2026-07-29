// Update service: keeps friends off mismatched versions for online play.
//
// Two delivery paths, decided by updateLogic.decideUpdatePath (BINDING;
// unsigned builds, see that file's header):
//   - 'electron-updater' (packaged Windows): electron-updater polls the GitHub
//     feed (latest.yml on the release, publish block in electron-builder.yml),
//     auto-downloads, and installs on user confirm via quitAndInstall.
//   - 'notify-download' (macOS always + dev builds): we query the public
//     GitHub releases API ourselves, compare semver, and hand the user the
//     right .dmg via shell.openExternal. NEVER an in-place mac install.
//
// State is a single UpdateStatus snapshot; every change is pushed to all
// windows on 'updates:status' (renderer store: state/updates.ts).

import fs from 'node:fs'
import path from 'node:path'
import { app, shell, BrowserWindow, net } from 'electron'
import type { UpdateActionResult, UpdateStatus } from '@shared/types'
import {
  decideUpdatePath,
  isNewerVersion,
  latestReleaseApiUrl,
  parseLatestRelease,
  pickAssetForPlatform,
  type LinuxPackageFormat
} from './updateLogic'

/**
 * Which Linux package this process is running from. Both signals are written
 * by the packaging itself, and they are the same two electron-updater reads to
 * choose between its AppImage and deb updaters, so this agrees with the tool
 * that would take over if Linux ever gets in-place updates:
 *   - APPIMAGE is exported into the environment by the AppImage runtime.
 *   - `package-type` is dropped next to the app by electron-builder when it
 *     builds an installable package (it holds the literal "deb" here).
 * Neither present means an unpacked tree, a distro rebuild, or something we do
 * not recognise: return null and let the caller fall back to the release page
 * rather than assert a format and hand out the wrong file.
 */
function linuxPackageFormat(): LinuxPackageFormat {
  if (process.platform !== 'linux') return null
  if (process.env.APPIMAGE) return 'appimage'
  try {
    const declared = fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8')
    if (declared.trim() === 'deb') return 'deb'
  } catch {
    // No such file on an AppImage or an unpacked run. Not an error.
  }
  return null
}

const updatePath = decideUpdatePath(process.platform, app.isPackaged)

let status: UpdateStatus = {
  state: 'idle',
  currentVersion: app.getVersion(),
  mode: updatePath === 'electron-updater' ? 'auto' : 'manual'
}

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('updates:status', status)
  }
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

// ---- electron-updater (packaged Windows only) ---------------------------------

/** Lazy so the mac/dev path never loads (or misconfigures) electron-updater. */
async function winUpdater(): Promise<typeof import('electron-updater').autoUpdater> {
  const { autoUpdater } = await import('electron-updater')
  return autoUpdater
}

let winWired = false
async function wireWinUpdater(): Promise<void> {
  if (winWired) return
  winWired = true
  const u = await winUpdater()
  u.autoDownload = true
  // Belt-and-suspenders: even if the user picks "later", the update applies on quit.
  u.autoInstallOnAppQuit = true
  u.on('checking-for-update', () => setStatus({ state: 'checking', error: undefined }))
  u.on('update-available', (info) =>
    setStatus({ state: 'downloading', latestVersion: info.version, progress: 0 })
  )
  u.on('update-not-available', () =>
    setStatus({ state: 'up-to-date', checkedAt: Date.now(), progress: undefined })
  )
  u.on('download-progress', (p) =>
    setStatus({ state: 'downloading', progress: Math.min(1, p.percent / 100) })
  )
  u.on('update-downloaded', (info) =>
    setStatus({ state: 'ready', latestVersion: info.version, progress: 1, checkedAt: Date.now() })
  )
  u.on('error', (err) =>
    setStatus({ state: 'error', error: friendlyError(err), progress: undefined })
  )
}

// ---- notify-download path (mac always, dev builds) -----------------------------

function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return /ENOTFOUND|ECONN|ETIMEDOUT|ERR_INTERNET|ERR_NAME|fetch failed|net::/i.test(raw)
    ? "Couldn't reach the update server. Check your connection and try again."
    : raw
}

async function checkViaGitHub(): Promise<void> {
  const res = await net.fetch(latestReleaseApiUrl(), {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nodechess-updater' }
  })
  if (!res.ok) throw new Error(`update check failed (HTTP ${res.status})`)
  const release = parseLatestRelease(await res.json())
  if (!release) throw new Error('update check failed (unexpected release payload)')
  if (!isNewerVersion(release.version, status.currentVersion)) {
    setStatus({ state: 'up-to-date', latestVersion: release.version, checkedAt: Date.now() })
    return
  }
  const asset = pickAssetForPlatform(
    release.assets,
    process.platform,
    process.arch,
    linuxPackageFormat()
  )
  setStatus({
    state: 'available',
    latestVersion: release.version,
    downloadUrl: asset?.url,
    releaseUrl: release.releaseUrl || undefined,
    checkedAt: Date.now()
  })
}

// ---- public surface (updates.ipc.ts) -------------------------------------------

let checking: Promise<UpdateStatus> | null = null

/** Check now (manual button, and the startup check). Coalesces concurrent calls. */
export function checkForUpdates(): Promise<UpdateStatus> {
  if (checking) return checking
  checking = (async () => {
    setStatus({ state: 'checking', error: undefined })
    try {
      if (updatePath === 'electron-updater') {
        await wireWinUpdater()
        // Events drive the state (downloading/ready/up-to-date).
        await (await winUpdater()).checkForUpdates()
      } else {
        await checkViaGitHub()
      }
    } catch (err) {
      setStatus({ state: 'error', error: friendlyError(err), checkedAt: Date.now() })
    }
    return status
  })().finally(() => {
    checking = null
  })
  return checking
}

/** The "Update now" click. */
export async function downloadUpdate(): Promise<UpdateActionResult> {
  if (updatePath === 'electron-updater') {
    if (status.state === 'ready') {
      // User confirmed: install and relaunch. setImmediate lets the IPC reply
      // flush before the windows tear down.
      setImmediate(() => void winUpdater().then((u) => u.quitAndInstall()))
      return { ok: true, action: 'install' }
    }
    if (status.state === 'downloading') return { ok: true, action: 'downloading' }
    return { ok: false, action: 'none', error: 'no update downloaded yet' }
  }
  // Manual path: one-click browser download of the right artifact. The UI owns
  // the "quit nodechess and install it over the old app" copy.
  const url = status.downloadUrl ?? status.releaseUrl
  if (status.state !== 'available' || !url) {
    return { ok: false, action: 'none', error: 'no update available' }
  }
  await shell.openExternal(url)
  return { ok: true, action: 'external' }
}

/** Startup hook (main/index.ts, after whenReady): one quiet background check a
 *  few seconds in: packaged builds only, so dev never nags or hits the API. */
export function initUpdates(): void {
  if (!app.isPackaged) return
  setTimeout(() => {
    void checkForUpdates()
  }, 5_000)
}
