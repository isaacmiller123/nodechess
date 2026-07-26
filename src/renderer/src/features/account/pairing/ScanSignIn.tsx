import { useEffect, useRef, useState, type JSX } from 'react'
import { formatCountdown } from './offer'
import {
  endClaim,
  startScan,
  stopCamera,
  useClaimState,
  submitCode,
} from './claimStore'
import './pairing.css'

/**
 * "Scan a code", on the device that is signing in.
 *
 * PHONE FIRST. This is the surface most people meet on a phone held up to a
 * laptop, so the viewfinder takes the column and nothing below it competes for
 * the thumb. The one control while the camera is live is Cancel.
 *
 * The camera is released by every path out of here: a code read, a failure, the
 * cancel button, and unmount. There is no state in which this component is gone
 * and the camera light is on.
 */
export function ScanSignIn({ onBack }: { onBack: () => void }): JSX.Element {
  const s = useClaimState()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [pasting, setPasting] = useState(false)
  const [typed, setTyped] = useState('')

  useEffect(() => endClaim, [])

  const open = (): void => {
    const el = videoRef.current
    if (!el) return
    setPasting(false)
    startScan(el)
  }

  const cancel = (): void => {
    endClaim()
    setTyped('')
  }

  const waiting = s.phase === 'connecting' || s.phase === 'waiting'

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Scan a code</h2>
        {waiting && s.secondsLeft > 0 && (
          <span className="sec-count num">{formatCountdown(s.secondsLeft)}</span>
        )}
      </div>
      <div className="panel">
        <div className="acct-where">
          <svg className="icon" aria-hidden focusable="false">
            <use href="#i-lock" />
          </svg>
          <div>
            <p className="acct-where-text">
              Sign in using a device you are already signed in on.
            </p>
            <p className="acct-where-sub">
              On that device, open Account and choose Add a device. Point this camera at the code it
              shows. That device will ask you to confirm before this one is signed in.
            </p>
          </div>
        </div>

        {/* The viewfinder is mounted for the whole life of this panel: a video
            element created at the moment the camera opens has no layout yet,
            and some engines will not play into an element that is not in the
            document. It is hidden until it has something to show. */}
        <div className={`acct-field pair-view${s.phase === 'scanning' ? ' is-live' : ''}`}>
          <video ref={videoRef} className="pair-video" playsInline muted />
          {s.phase === 'scanning' && (
            <p className="acct-hint" role="status">
              {s.cameraLive
                ? 'Point the camera at the code on your other device.'
                : 'Starting the camera.'}
            </p>
          )}
        </div>

        {s.phase === 'idle' && (
          <div className="acct-field">
            <div className="acct-pw">
              <button className="btn is-primary" type="button" onClick={open}>
                Open the camera
              </button>
              <button
                className="btn is-quiet"
                type="button"
                aria-expanded={pasting}
                onClick={() => setPasting((v) => !v)}
              >
                {pasting ? 'Use the camera instead' : 'No camera? Paste the code'}
              </button>
            </div>
            {pasting && (
              <>
                <label className="lbl" htmlFor="pair-paste">
                  Sign-in code
                </label>
                <textarea
                  id="pair-paste"
                  className="acct-textarea pair-text"
                  rows={3}
                  value={typed}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(e) => setTyped(e.target.value)}
                />
                <p className="acct-hint">
                  On the other device, under the code, choose &ldquo;No camera on that
                  device?&rdquo; and copy what it shows.
                </p>
                <button
                  className="btn is-primary acct-door"
                  type="button"
                  disabled={typed.trim() === ''}
                  onClick={() => submitCode(typed)}
                >
                  Use this code
                </button>
              </>
            )}
          </div>
        )}

        {s.phase === 'scanning' && (
          <div className="panel-foot">
            <button
              className="btn is-quiet"
              type="button"
              onClick={() => {
                stopCamera()
                setTyped('')
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {waiting && (
          <>
            <div className="acct-field" role="status">
              <p className="acct-where-text">Now confirm on your other device.</p>
              <span className="lbl">It should be showing</span>
              <p className="pair-fp num">{s.fingerprint ?? ''}</p>
              <p className="acct-hint">
                If your other device shows different characters, say no there. Nothing is signed in
                until you confirm.
              </p>
              {s.slow && (
                <p className="acct-hint">
                  This is taking longer than usual. Check that both devices are online and that the
                  code is still on screen.
                </p>
              )}
              <span className="acct-bar" aria-hidden>
                <span className="acct-bar-fill" style={{ width: '55%' }} />
              </span>
            </div>
            <div className="panel-foot">
              <button className="btn is-quiet" type="button" onClick={cancel}>
                Cancel
              </button>
            </div>
          </>
        )}

        {s.phase === 'installing' && (
          <div className="acct-field" role="status">
            <p className="acct-where-text">Signing you in.</p>
            <span className="acct-bar" aria-hidden>
              <span className="acct-bar-fill" style={{ width: '85%' }} />
            </span>
          </div>
        )}

        {s.phase === 'done' && (
          <div className="acct-field">
            <p className="acct-where-text">
              Signed in{s.handle ? ' as ' : '.'}
              {s.handle && <span className="num">{s.handle}</span>}
            </p>
          </div>
        )}

        {s.phase === 'failed' && (
          <>
            <div className="acct-field">
              <p className="acct-alert" role="alert">
                {s.error ?? 'That did not work.'}
              </p>
            </div>
            <div className="panel-foot">
              <button className="btn is-primary" type="button" onClick={open}>
                Try again
              </button>
            </div>
          </>
        )}

        <div className="acct-field">
          <button className="btn is-quiet acct-door" type="button" onClick={onBack}>
            Use a password or recovery phrase instead
          </button>
        </div>
      </div>
    </section>
  )
}
