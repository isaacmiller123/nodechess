// Subtle "a new version is out" toast: appears bottom-right after the quiet
// startup update check (src/main/updates) finds one. Non-blocking by design:
// "Update now" acts (installs on Windows / opens the right .dmg download on
// macOS: the unsigned-build split lives in main), "Later" dismisses for THIS
// version (localStorage), and the Settings → Updates card remains the full
// surface either way.

import { useEffect, useState, type JSX } from 'react'
import { ArrowUpCircle, X } from 'lucide-react'
import { applyUpdate, useUpdates } from '../state/updates'
import './update-toast.css'

const DISMISSED_KEY = 'updates.toast.dismissed.v1'

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

export function UpdateToast({ raised, onOpenSettings }: { raised?: boolean; onOpenSettings: () => void }): JSX.Element | null {
  const status = useUpdates()
  const [dismissed, setDismissed] = useState<string | null>(readDismissed)
  // Manual mode: after the browser download opens, linger briefly with the
  // install instruction, then get out of the way.
  const [phase, setPhase] = useState<'offer' | 'opened'>('offer')

  useEffect(() => {
    if (phase !== 'opened') return
    const t = window.setTimeout(() => setDismissed(status?.latestVersion ?? ''), 8000)
    return () => window.clearTimeout(t)
  }, [phase, status?.latestVersion])

  // 'available' (manual: mac + dev) and 'ready' (auto: win, downloaded) both
  // warrant the nudge; 'downloading' stays silent. The ready toast follows.
  const show =
    !!status &&
    (status.state === 'available' || status.state === 'ready') &&
    !!status.latestVersion &&
    dismissed !== status.latestVersion
  if (!show || !status) return null

  const later = (): void => {
    try {
      localStorage.setItem(DISMISSED_KEY, status.latestVersion ?? '')
    } catch {
      /* session-only dismissal is fine */
    }
    setDismissed(status.latestVersion ?? '')
  }
  const updateNow = (): void => {
    void applyUpdate().then((r) => {
      if (!r.ok) {
        // Nothing actionable here (e.g. state changed underneath). The
        // Settings card has the full story.
        onOpenSettings()
        later()
      } else if (r.action === 'external') {
        setPhase('opened')
      }
      // 'install' quits the app; 'downloading' keeps the toast (it flips to
      // the ready state on its own).
    })
  }

  return (
    <div className={`update-toast${raised ? ' is-raised' : ''}`} role="status" aria-live="polite">
      <ArrowUpCircle size={18} className="update-toast-icon" aria-hidden />
      <div className="update-toast-copy">
        <strong>
          {status.state === 'ready'
            ? `v${status.latestVersion} is ready to install`
            : `v${status.latestVersion} is out`}
        </strong>
        <span>
          {phase === 'opened'
            ? 'Download started. Quit nodechess and install it over the old app.'
            : status.state === 'ready'
              ? 'Restart to finish, or it installs on your next quit.'
              : status.mode === 'auto'
                ? 'Downloads and installs itself.'
                : 'One-click download; install it over the old app.'}
        </span>
      </div>
      {phase === 'offer' && (
        <div className="update-toast-actions">
          <button type="button" className="btn" onClick={updateNow}>
            {status.state === 'ready' ? 'Restart & update' : 'Update now'}
          </button>
          <button type="button" className="btn ghost" onClick={later}>
            Later
          </button>
        </div>
      )}
      <button type="button" className="icon-btn update-toast-x" aria-label="Dismiss" onClick={later}>
        <X size={14} />
      </button>
    </div>
  )
}
