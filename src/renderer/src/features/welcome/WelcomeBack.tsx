import { useEffect, useMemo, useRef, type JSX } from 'react'
import { X } from 'lucide-react'
import { OverlayDialog } from '../../components/OverlayDialog'
import Logo from '../../components/Logo'
import { useAccountsUi } from '../account/mock/store'
import { loadChangelog } from './changelog'
import './welcome.css'

/**
 * WELCOME BACK: the popup every visit after the first, on both targets.
 *
 * SHAPE IS THE BRIEF. Someone opens this five times a day, so it is a 400px
 * card, not a page: one head row carrying the mark and the greeting, a body
 * only when there is genuinely something to put in it, and a foot. The desktop
 * first launch next door is the opposite shape on purpose, a wide panel with
 * the mark at hero size. Nothing is added here that a person would have to
 * read twice.
 *
 * Two account variants, and the difference between them is the whole point of
 * the surface:
 *
 *  - signed in: greet them by the name on the account, confirm which account
 *    that is, and get out of the way.
 *  - no account: greet them, say in one line what an account is for, and put
 *    the action in the popup rather than sending them hunting for it. One
 *    line, no lecture, and nothing about how any of it works underneath. It
 *    dismisses without making one: Continue is the primary, the offer is not.
 *
 * There is a third state the matrix does not name and the app really has: an
 * account exists on this device but the session is signed out, which is the
 * COMMON case, because the derived seed is only stored on an explicit opt in.
 * Telling that person to create an account would be wrong, so the action says
 * sign in instead. Same line, different verb.
 *
 * THE TAG IS THE ONE THING WORTH KNOWING. In a keyring that holds several
 * accounts, which one this session resumed into is the fact that can have
 * changed since last time and that nothing else here would tell them. It is
 * read off the signed-in account, never composed.
 *
 * Desktop adds the changelog. Web does not: a web visit is always the current
 * build, so "what changed since you were last here" is a question only the
 * desktop app can answer honestly. When the changelog has no releases the
 * section still renders, with a count of none and two true lines: an empty
 * CHANGELOG.md is the real state of the file, not a failure to load it.
 */
export interface WelcomeBackProps {
  onClose: () => void
  /** Take them to the account screen (sign in / create both live there). */
  onOpenAccount: () => void
  /** Desktop only: render the changelog section. */
  withChangelog: boolean
}

/**
 * The reduced rook, not the lattice. Logo's own floor is 24px, and a 400px
 * card is where the mark is an identifier rather than a hero: the lattice at
 * that size reads as texture, and the rook is the form drawn for exactly this.
 * The first launch panel next door takes the lattice at 76px instead.
 */
const CARD_MARK = 22

export function WelcomeBack({
  onClose,
  onOpenAccount,
  withChangelog
}: WelcomeBackProps): JSX.Element | null {
  const { signedIn, account, keyringAccounts, busy } = useAccountsUi()
  const continueRef = useRef<HTMLButtonElement>(null)

  // Parsed once per mount. The source is inlined at build time, so this is a
  // string split, not IO.
  const releases = useMemo(() => (withChangelog ? loadChangelog() : []), [withChangelog])

  /* Hold the popup for the boot-time session resume (milliseconds: no key
     derivation runs). Rendering through it would greet a signed-in player by
     asking them to make an account, then swap the text under their cursor. */
  const holding = busy === 'resuming'

  /* Focus starts on the primary action. OverlayDialog focuses its own first
     focusable child (the close cross) in an effect; this component is above it
     in the tree, so this effect runs afterwards and wins. It waits for the
     resume to land, because there is nothing to focus until then. */
  useEffect(() => {
    if (!holding) continueRef.current?.focus()
  }, [holding])

  // Every hook above this line.
  if (holding) return null

  const name = signedIn ? (account?.displayName ?? '').trim() : ''
  const tag = signedIn ? (account?.tag ?? '').trim() : ''
  const hasLocalAccount = (keyringAccounts?.length ?? 0) > 0

  const goAccount = (): void => {
    onOpenAccount()
    onClose()
  }

  const releaseCount =
    releases.length === 0
      ? 'None yet'
      : releases.length === 1
        ? '1 release'
        : `${releases.length} releases`

  const hasBody = !signedIn || withChangelog

  return (
    <OverlayDialog
      onClose={onClose}
      placement="center"
      className="welcome-wb"
      labelledBy="welcome-back-title"
    >
      <div className="welcome-wb-head">
        <Logo size={CARD_MARK} variant="rook" motion="none" title="nodechess" />
        <h2 id="welcome-back-title" className="welcome-wb-title">
          {name !== '' ? `Welcome back, ${name}` : 'Welcome back'}
        </h2>
        {tag !== '' && <span className="tag">{tag}</span>}
        <button type="button" className="shell-modal-close" aria-label="Close" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </div>

      {hasBody && (
        <div className="welcome-wb-body">
          {!signedIn && (
            <p className="welcome-wb-line">
              {hasLocalAccount
                ? 'Sign in for rated play, and progress that follows you between devices.'
                : 'An account gets you rated play, and progress that follows you between devices.'}
            </p>
          )}

          {withChangelog && (
            <div className="welcome-wb-cl">
              <div className="welcome-cl-head">
                <span className="lbl">What&apos;s new</span>
                <span className="sec-count">{releaseCount}</span>
              </div>
              <div className="well welcome-changelog">
                {releases.length === 0 ? (
                  // NOT a fabricated release note, and not a load failure
                  // either. CHANGELOG.md starts empty and is never back-filled,
                  // so this is the true state of the file.
                  <div className="empty">
                    <p className="empty-line">No releases recorded yet.</p>
                    <p className="empty-line">Each one is listed here as it ships.</p>
                  </div>
                ) : (
                  releases.map((r) => (
                    <div className="welcome-release" key={`${r.version}-${r.date ?? ''}`}>
                      <div className="welcome-release-head">
                        <span className="welcome-release-version">{r.version}</span>
                        {r.date !== null && <span className="welcome-release-date">{r.date}</span>}
                      </div>
                      <ul className="welcome-release-items">
                        {r.items.map((item, i) => (
                          <li key={i}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="shell-modal-foot">
        {!signedIn && (
          <button type="button" className="btn welcome-wb-alt" onClick={goAccount}>
            {hasLocalAccount ? 'Sign in' : 'Create an account'}
          </button>
        )}
        <button type="button" className="btn is-primary" ref={continueRef} onClick={onClose}>
          Continue
        </button>
      </div>
    </OverlayDialog>
  )
}

export default WelcomeBack
