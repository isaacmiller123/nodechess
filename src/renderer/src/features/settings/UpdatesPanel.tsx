// Settings → Updates card. One live UpdateStatus snapshot (state/updates.ts)
// drives everything: current version, a manual "Check for updates" button, and
// the state-appropriate action.
//
// Two delivery modes decided by MAIN (src/main/updates/updateLogic.ts, the
// unsigned-build constraint, binding):
//   - 'auto'   (packaged Windows): electron-updater downloads in place; the
//     action here is "Restart & update" (quitAndInstall). Skipping it is safe:
//     the update also applies on the next quit.
//   - 'manual' (macOS always + dev builds): the action opens the right .dmg
//     download in the browser; the card owns the "install it over the old app"
//     copy since macOS can never auto-install an unsigned build.

import { useState, type JSX, type ReactNode } from 'react'
import { AlertTriangle, ArrowUpCircle, Check, Download, Loader2, RefreshCw } from 'lucide-react'
import { isWebBuild } from '../../platform'
import { applyUpdate, checkForUpdates, useUpdates } from '../../state/updates'

/** State-dependent status line: icon + copy. */
function StatusLine({ children, tone }: { children: ReactNode; tone: 'good' | 'accent' | 'bad' }): JSX.Element {
  return (
    <p className={`updates-status is-${tone}`} role="status">
      {children}
    </p>
  )
}

export default function UpdatesPanel(): JSX.Element {
  const status = useUpdates()
  const [checking, setChecking] = useState(false)
  // Manual mode: remember that "Update now" already opened the browser, so the
  // card can switch to install instructions.
  const [openedExternal, setOpenedExternal] = useState(false)

  const state = status?.state ?? 'idle'
  const busy = checking || state === 'checking'
  const auto = status?.mode === 'auto'
  const latest = status?.latestVersion

  const onCheck = (): void => {
    setChecking(true)
    setOpenedExternal(false)
    void checkForUpdates().finally(() => setChecking(false))
  }
  const onUpdate = (): void => {
    void applyUpdate().then((r) => {
      if (r.ok && r.action === 'external') setOpenedExternal(true)
    })
  }

  return (
    <section className="card settings-card">
      <h2>Updates</h2>
      <div className="updates-head">
        <span className="updates-version">
          <strong>nodechess v{status?.currentVersion ?? '…'}</strong>
          <span className="setting-sub">
            {/* Web: the served bundle IS the release, so there's nothing to check
                or install, so the manual button goes away with the copy. */}
            {isWebBuild
              ? 'Refresh to pick up new releases.'
              : auto
                ? 'Checked on launch. Updates install themselves.'
                : 'Checked on launch. New versions are one click.'}
          </span>
        </span>
        {!isWebBuild && (
          <button type="button" className="btn ghost" disabled={busy} onClick={onCheck}>
            {busy ? <Loader2 size={14} className="updates-spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
            {busy ? 'Checking…' : 'Check for updates'}
          </button>
        )}
      </div>

      {state === 'up-to-date' && (
        <StatusLine tone="good">
          <Check size={14} aria-hidden /> You&rsquo;re on the latest version.
        </StatusLine>
      )}
      {state === 'error' && (
        <StatusLine tone="bad">
          <AlertTriangle size={14} aria-hidden /> {status?.error ?? 'Update check failed.'}
        </StatusLine>
      )}
      {state === 'downloading' && (
        <div className="updates-progress-row">
          <StatusLine tone="accent">
            <Download size={14} aria-hidden /> Downloading v{latest}…
          </StatusLine>
          <div
            className="updates-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((status?.progress ?? 0) * 100)}
          >
            <span style={{ width: `${Math.round((status?.progress ?? 0) * 100)}%` }} />
          </div>
        </div>
      )}

      {(state === 'available' || state === 'ready') && (
        <div className="updates-offer">
          <span className="updates-offer-copy">
            <strong>
              <ArrowUpCircle size={15} aria-hidden /> nodechess v{latest} is out
            </strong>
            <span>
              {state === 'ready'
                ? 'Restart to finish, or it installs on your next quit.'
                : auto
                  ? 'It will download and install automatically.'
                  : openedExternal
                    ? 'Download started in your browser. Quit nodechess, then install the new app over the old one. Your games and progress are kept.'
                    : 'One click downloads the new app. Install it over the old one. Your games and progress are kept.'}
            </span>
          </span>
          <button type="button" className="btn" onClick={onUpdate}>
            {state === 'ready' ? 'Restart & update' : openedExternal ? 'Download again' : 'Update now'}
          </button>
        </div>
      )}
    </section>
  )
}
