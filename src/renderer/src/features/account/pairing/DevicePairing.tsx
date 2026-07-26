import { useEffect, useState, type JSX } from 'react'
import { accountsUiStore } from '../mock/store'
import { QrCode } from './QrCode'
import { encodeOffer, formatCountdown } from './offer'
import {
  approveRequest,
  declineRequest,
  endOffer,
  startOffer,
  useOfferState,
} from './offerStore'
import './pairing.css'

/**
 * "Add a device", on the device that already holds the account.
 *
 * The section is one question at a time. Show a code; a device asks; you decide;
 * it is signed in. Nothing on this screen explains how any of that works, and
 * nothing on it is true only sometimes: the countdown is the real expiry, the
 * fingerprint is the real fingerprint, and a failure says what failed.
 *
 * The approval step is deliberately the loudest thing in the section. It is the
 * only moment where a person is the security.
 */
export function DevicePairing(): JSX.Element {
  const s = useOfferState()
  const [showText, setShowText] = useState(false)
  const [copied, setCopied] = useState(false)

  // A code left on screen after the page is closed is a code still listening.
  useEffect(() => endOffer, [])

  // The device list on this page is derived from the account's own history, so
  // it only tells the truth after the history changes underneath it.
  useEffect(() => {
    if (s.phase === 'granted') void accountsUiStore.refreshFromChain()
  }, [s.phase])

  const codeText = s.offer ? encodeOffer(s.offer) : ''

  const copyCode = (): void => {
    if (!codeText) return
    void navigator.clipboard
      ?.writeText(codeText)
      .then(() => setCopied(true))
      .catch(() => {})
  }

  const begin = (): void => {
    setShowText(false)
    setCopied(false)
    startOffer()
  }

  return (
    <section className="sec" id="acct-add-device">
      <div className="sec-head">
        <h2 className="lbl">Add a device</h2>
        {(s.phase === 'showing' || s.phase === 'asking') && (
          <span className="sec-count num">{formatCountdown(s.secondsLeft)}</span>
        )}
      </div>
      <div className="panel">
        {s.phase === 'idle' && (
          <>
            <div className="acct-where">
              <svg className="icon" aria-hidden focusable="false">
                <use href="#i-lock" />
              </svg>
              <div>
                <p className="acct-where-text">Sign in on your phone or another computer.</p>
                <p className="acct-where-sub">
                  This device shows a code. The other device scans it with its camera, and you
                  confirm here before anything happens. Your recovery phrase stays where it is and
                  is never part of the code.
                </p>
              </div>
            </div>
            <div className="panel-foot">
              <button className="btn is-primary" type="button" onClick={begin}>
                Show a sign-in code
              </button>
            </div>
          </>
        )}

        {s.phase === 'showing' && s.offer && (
          <>
            <div className="acct-field pair-code">
              <QrCode text={codeText} label="Sign-in code for another device" />
              <div className="pair-code-side">
                <p className="acct-where-text">Scan this with your other device.</p>
                <ol className="pair-steps">
                  <li>Open nodechess on the other device.</li>
                  <li>Go to Account and choose Scan a code.</li>
                  <li>Point its camera at this screen.</li>
                </ol>
                <p className="acct-hint">
                  This code works once, and only for the next{' '}
                  <span className="num">{formatCountdown(s.secondsLeft)}</span>. You will be asked
                  here before that device is signed in.
                </p>
              </div>
            </div>

            <div className="acct-field">
              <button
                className="btn is-quiet acct-door"
                type="button"
                aria-expanded={showText}
                onClick={() => setShowText((v) => !v)}
              >
                {showText ? 'Hide the code as text' : 'No camera on that device?'}
              </button>
              {showText && (
                <>
                  <p className="acct-hint">
                    Copy this and paste it into Scan a code on the other device. It is the same
                    code, so the same rules apply: once, and only while the timer runs.
                  </p>
                  <textarea
                    className="acct-textarea pair-text"
                    readOnly
                    rows={3}
                    value={codeText}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <div className="acct-pw">
                    <button className="btn is-quiet" type="button" onClick={copyCode}>
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="panel-foot">
              <button className="btn is-quiet" type="button" onClick={endOffer}>
                Cancel
              </button>
            </div>
          </>
        )}

        {s.phase === 'asking' && s.request && (
          <div className="pair-ask">
            <div className="acct-field">
              <p className="acct-where-text">A device wants to sign in to your account.</p>
              <p className="pair-ask-device num">{s.request.label}</p>
              <p className="acct-hint">
                If you say yes, this device is signed in to your account and stays signed in until
                it is removed. You can remove it from this page at any time.
              </p>
            </div>
            <div className="acct-field">
              <span className="lbl">Check the other device shows</span>
              <p className="pair-fp num">{s.request.fingerprint}</p>
              <p className="acct-hint">
                These characters are on the other device&rsquo;s screen right now. If they are
                different, or nothing is shown there, say no: something else scanned your code.
              </p>
            </div>
            <div className="panel-foot pair-decide">
              <button
                className="btn is-primary pair-yes"
                type="button"
                onClick={() => void approveRequest()}
              >
                Yes, sign it in
              </button>
              <button className="btn pair-no" type="button" onClick={declineRequest}>
                No
              </button>
            </div>
          </div>
        )}

        {s.phase === 'granting' && (
          <div className="acct-field" role="status">
            <p className="acct-where-text">Signing that device in.</p>
            <span className="acct-bar" aria-hidden>
              <span className="acct-bar-fill" style={{ width: '70%' }} />
            </span>
          </div>
        )}

        {s.phase === 'granted' && (
          <>
            <div className="acct-field">
              <p className="acct-where-text">
                {s.grantedLabel ?? 'That device'} is signed in to your account.
              </p>
              <p className="acct-hint">
                It is in your list of devices below, and you can remove it from there whenever you
                want. That code will not work again.
              </p>
            </div>
            <div className="panel-foot">
              <button className="btn is-quiet" type="button" onClick={endOffer}>
                Done
              </button>
            </div>
          </>
        )}

        {(s.phase === 'declined' || s.phase === 'expired' || s.phase === 'error') && (
          <>
            <div className="acct-field">
              <p className="acct-alert" role="alert">
                {s.phase === 'declined'
                  ? 'Not signed in. That code will not work again.'
                  : s.phase === 'expired'
                    ? 'That code expired before it was used.'
                    : (s.error ?? 'That did not work.')}
              </p>
            </div>
            <div className="panel-foot">
              <button className="btn is-primary" type="button" onClick={begin}>
                Show a new code
              </button>
              <button className="btn is-quiet" type="button" onClick={endOffer}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
