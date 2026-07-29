// Settings → Updates. One live UpdateStatus snapshot (state/updates.ts) drives
// everything: current version, a manual "Check for updates" button, and the
// state-appropriate action.
//
// Two delivery modes decided by MAIN (src/main/updates/updateLogic.ts, the
// unsigned-build constraint, binding):
//   - 'auto'   (packaged Windows): electron-updater downloads in place; the
//     action here is "Restart & update" (quitAndInstall). Skipping it is safe:
//     the update also applies on the next quit.
//   - 'manual' (macOS always + dev builds): the action opens the right .dmg
//     download in the browser; this owns the "install it over the old app"
//     copy since macOS can never auto-install an unsigned build.
//
// design-lab/v1 draws no version string and no update affordance anywhere, so
// this is written in the vocabulary of the sections that surround it: rows,
// quiet buttons, and the same track the sliders use for the download.

import { useState, type JSX } from 'react'
import { isWebBuild } from '../../platform'
import { applyUpdate, checkForUpdates, useUpdates } from '../../state/updates'
import { Sec, SetMeter, SetRow } from './controls'

export default function UpdatesPanel(): JSX.Element {
  const status = useUpdates()
  const [checking, setChecking] = useState(false)
  // Manual mode: remember that "Update now" already opened the browser, so the
  // row can switch to install instructions.
  const [openedExternal, setOpenedExternal] = useState(false)

  const state = status?.state ?? 'idle'
  const busy = checking || state === 'checking'
  const auto = status?.mode === 'auto'
  const latest = status?.latestVersion
  const pct = Math.round((status?.progress ?? 0) * 100)

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
    <Sec label="Updates" count={status ? `v${status.currentVersion}` : ''}>
      <div className="panel">
        <SetRow
          name={status ? `nodechess v${status.currentVersion}` : 'nodechess'}
          sub={
            // Web: the served bundle IS the release, so there is nothing to
            // check and nothing to install.
            isWebBuild
              ? 'Refresh to pick up new releases.'
              : auto
                ? 'Checked on launch. Updates install themselves.'
                : 'Checked on launch. New versions are one click.'
          }
        >
          {!isWebBuild && (
            <button type="button" className="btn is-quiet" disabled={busy} onClick={onCheck}>
              {busy ? 'Checking…' : 'Check for updates'}
            </button>
          )}
        </SetRow>

        {state === 'up-to-date' && (
          <SetRow name="Up to date" sub="You are on the latest version.">
            <span className="set-state is-on" role="status">
              Latest
            </span>
          </SetRow>
        )}

        {state === 'error' && (
          <SetRow name="Update check failed" sub={status?.error ?? 'The check could not complete.'}>
            <span className="set-state is-bad" role="alert">
              Failed
            </span>
          </SetRow>
        )}

        {state === 'downloading' && (
          <div className="set-row is-stack" role="status" aria-live="polite">
            <SetMeter head={`Downloading v${latest ?? ''}`} value={`${pct}%`} pct={pct} />
          </div>
        )}

        {(state === 'available' || state === 'ready') && (
          <SetRow
            name={`nodechess v${latest ?? ''} is out`}
            sub={
              state === 'ready'
                ? 'Restart to finish, or it installs on your next quit.'
                : auto
                  ? 'It will download and install automatically.'
                  : // Same honesty check as UpdateToast: no downloadUrl means
                    // the click only opens the release page, so neither branch
                    // below may promise a download that did not start.
                    openedExternal
                    ? status?.downloadUrl
                      ? 'Download started in your browser. Quit nodechess, then install the new file over the old one. Your games and progress are kept.'
                      : 'Opened the release page in your browser. Pick the file for your system. Your games and progress are kept.'
                    : status?.downloadUrl
                      ? 'One click downloads the new app. Install it over the old one. Your games and progress are kept.'
                      : 'One click opens the release page, where you pick the file for your system. Your games and progress are kept.'
            }
          >
            <button type="button" className="btn" onClick={onUpdate}>
              {state === 'ready' ? 'Restart & update' : openedExternal ? 'Download again' : 'Update now'}
            </button>
          </SetRow>
        )}
      </div>
    </Sec>
  )
}
