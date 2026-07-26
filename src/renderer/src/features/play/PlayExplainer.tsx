// THE PLAY EXPLAINER.
//
// Everything the Play screen used to teach in paragraphs lives here instead:
// what the three ways are, and what rated costs you that casual does not. It
// opens once, the first time a player reaches Play, and then never again on
// its own. The Play head keeps a quiet "How Play works" control so the same
// screen can be read a second time on purpose, because a one time explainer
// you cannot re-open is a dead end.
//
// The copy is v1's own: "Rated moves your rating and needs an account. Casual
// moves nothing and needs none. Same opponents, same board." The screen it was
// taken off now says only the short part, at the control it belongs to.

import { useCallback, useState, type JSX } from 'react'
import { X } from 'lucide-react'
import { OverlayDialog } from '../../components/OverlayDialog'

/** Same shape as the shell's own first-run flag: oct.<area>.<thing>.<version>. */
export const PLAY_EXPLAINER_SEEN_KEY = 'oct.play.explainer.v1'

/** Storage can be unavailable (private windows, hardened profiles). A read that
 *  throws must not keep the explainer up forever, so failure counts as seen. */
function readSeen(): boolean {
  try {
    return localStorage.getItem(PLAY_EXPLAINER_SEEN_KEY) === '1'
  } catch {
    return true
  }
}

function writeSeen(): void {
  try {
    localStorage.setItem(PLAY_EXPLAINER_SEEN_KEY, '1')
  } catch {
    // Nothing to do: the explainer simply opens again next time.
  }
}

/**
 * Owns both the flag and the open/closed state.
 *
 * `open` is true on the very first mount after the flag is unset. Closing it
 * (button, Escape, or the scrim) writes the flag, so every exit route counts as
 * having read it. `reopen` shows it again without touching the flag, which is
 * already set by then anyway.
 */
export function usePlayExplainer(): {
  open: boolean
  reopen: () => void
  close: () => void
} {
  const [open, setOpen] = useState(() => !readSeen())

  const close = useCallback(() => {
    writeSeen()
    setOpen(false)
  }, [])

  const reopen = useCallback(() => setOpen(true), [])

  return { open, reopen, close }
}

interface Way {
  name: string
  what: string
}

const WAYS: readonly Way[] = [
  { name: 'Online', what: 'Matched against a stranger near your strength.' },
  { name: 'Bot', what: 'Eight fixed levels, or a grandmaster to copy. Works offline.' },
  { name: 'Local', what: 'Two people taking turns on this screen.' }
]

const STAKES: readonly Way[] = [
  {
    name: 'Rated',
    what: "Moves your rating and needs an account. It is played at its ladder's own clock, and the colours come with the pairing."
  },
  {
    name: 'Casual',
    what: 'Moves nothing and needs none. Any clock, either colour, and it starts from a code you send to someone.'
  }
]

export interface PlayExplainerProps {
  onClose: () => void
}

export function PlayExplainer({ onClose }: PlayExplainerProps): JSX.Element {
  return (
    <OverlayDialog
      onClose={onClose}
      placement="center"
      className="shell-modal play-explainer"
      labelledBy="play-explainer-title"
    >
      <div className="shell-modal-head">
        <h2 id="play-explainer-title">How Play works</h2>
        <button
          type="button"
          className="shell-modal-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={18} aria-hidden />
        </button>
      </div>

      <div className="shell-modal-body">
        <p className="play-explain-lead">Three ways in. Pick one, pick a clock, start.</p>

        <dl className="play-explain">
          {WAYS.map((w) => (
            <div className="play-explain-row" key={w.name}>
              <dt className="lbl">{w.name}</dt>
              <dd>{w.what}</dd>
            </div>
          ))}
        </dl>

        <h3 className="play-explain-head">Rated and casual</h3>

        <dl className="play-explain">
          {STAKES.map((s) => (
            <div className="play-explain-row" key={s.name}>
              <dt className="lbl">{s.name}</dt>
              <dd>{s.what}</dd>
            </div>
          ))}
        </dl>

        <p className="play-explain-lead">Same opponents, same board.</p>
      </div>

      <div className="shell-modal-foot">
        <button type="button" className="btn is-primary" onClick={onClose}>
          Start playing
        </button>
      </div>
    </OverlayDialog>
  )
}
