import { useMemo, useState, type JSX } from 'react'
import { accountsUiStore } from './mock/store'
import { markRecoverySaved, useRecoverySaved } from './recoveryAck'

/**
 * v1's third section, the one thing to do on this screen.
 *
 * TWO PLACES THIS DEPARTS FROM THE MOCK, both because the mock is a static
 * page and this one holds the real key material:
 *  - the phrase is TWENTY-FOUR words, not twelve. The seed is 32 bytes, which
 *    is 24 BIP39 words, and a twelve word grid would show a phrase that does
 *    not restore the account.
 *  - there is no session seed to export unless the session actually holds one.
 *    That case renders one honest line. It never renders sample words: a
 *    player who wrote those down would have written down nothing.
 *
 * A DEVICE SIGNED IN BY SCANNING has no phrase here and never will, because the
 * phrase never travelled: it stayed on the device that approved this one. That
 * is not a failure state and must not read like one, so it gets its own line
 * rather than the "sign in again" one, which would send someone looking for a
 * password they do not need.
 */
export function AccountRecovery({
  rootPub,
  paired = false
}: {
  rootPub: string
  paired?: boolean
}): JSX.Element {
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const saved = useRecoverySaved(rootPub)

  // The real exports, read once per account. The session seed never changes
  // underneath a mounted view.
  const words = useMemo(() => accountsUiStore.exportMnemonicWords(), [rootPub])
  const keyfile = useMemo(() => accountsUiStore.exportKeyfile(), [rootPub])

  const copyPhrase = (): void => {
    if (!words) return
    void navigator.clipboard
      ?.writeText(words.join(' '))
      .then(() => setCopied(true))
      .catch(() => {})
  }

  const downloadKeyfile = (): void => {
    if (!keyfile) return
    const url = URL.createObjectURL(new Blob([keyfile.json], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = keyfile.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Recovery phrase</h2>
        {words && <span className="sec-count">{words.length} words</span>}
      </div>
      <div className="panel">
        {words === null ? (
          <div className="empty">
            {paired ? (
              <>
                <p className="empty-line">Your recovery phrase is not on this device.</p>
                <p className="empty-line">
                  It is on the device you made the account on, which is where it should be. This
                  device was signed in from there and can be removed from there.
                </p>
              </>
            ) : (
              <>
                <p className="empty-line">Sign in again to save your recovery phrase.</p>
                <p className="empty-line">
                  The words come from the key this device derived when you signed in.
                </p>
              </>
            )}
          </div>
        ) : (
          <div
            className={`phrase${revealed ? ' is-open' : ''}${saved ? ' is-saved' : ''}`}
          >
            <p className="phrase-note">
              Write these twenty-four words down in order and keep them off this device. Anyone who
              has them has your account.
            </p>
            <div className="phrase-grid">
              {words.map((w, i) => (
                <span className="word" key={`${i}-${w}`}>
                  <span className="word-no">{i + 1}</span>
                  {w}
                </span>
              ))}
            </div>
            {/* v1 hides this row once the phrase is marked saved, which is right
                for a mock that forgets the click. This one remembers it, so the
                row stays reachable: a player who saved the phrase in March
                still has to be able to look at it in June. */}
            <div className={`phrase-row${saved ? '' : ' phrase-actions'}`}>
              {!revealed && (
                <button className="btn is-primary" type="button" onClick={() => setRevealed(true)}>
                  Reveal phrase
                </button>
              )}
              <button className="btn" type="button" disabled={!revealed} onClick={copyPhrase}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              {keyfile && (
                <button className="btn" type="button" onClick={downloadKeyfile}>
                  Download keyfile
                </button>
              )}
              {!saved && (
                <button
                  className="btn is-quiet"
                  type="button"
                  disabled={!revealed}
                  onClick={() => markRecoverySaved(rootPub)}
                >
                  I have written it down
                </button>
              )}
            </div>
            <p className="saved">
              <svg className="icon" aria-hidden focusable="false">
                <use href="#i-check" />
              </svg>
              Marked as saved
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
