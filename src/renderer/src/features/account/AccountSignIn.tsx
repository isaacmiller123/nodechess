import { useEffect, useState, type JSX } from 'react'
import { accountsUiStore, useAccountsUi } from './mock/store'
import { ScanSignIn } from './pairing/ScanSignIn'
import { PHRASE_WORDS, checkPhrase, phraseProblemMessage, phraseWords } from './recoveryPhrase'

/**
 * Signed out, which v1 never drew: account.html shows the signed-in page only,
 * and the app boots signed out. So this is the same page in the same language,
 * one section, answering the question the player actually arrived with: do I
 * need an account, and what does it get me.
 *
 * Creating an account no longer hides the recovery phrase behind a modal step.
 * The page you land on IS the recovery page, so the account commits on success
 * and the phrase section, with the readout pointing at it, is what you see.
 *
 * THE THIRD MODE. The account is twenty-four words, the landing page says so
 * and the recovery section writes them down, so this screen has to take them
 * back. It is not a segment of the picker: someone arriving to make an account
 * should not have to step past it, and someone arriving with a phrase in hand
 * needs one obvious door, so the door sits under the form in both modes.
 *
 * The phrase is checked completely before anything is derived, read or asked of
 * the network (./recoveryPhrase), and it is covered by default: this is the one
 * field in the app where the person beside you reading the screen is the whole
 * of the loss.
 *
 * THE FOURTH MODE. Scanning a code is the way in that needs neither the
 * password nor the phrase, because it asks a device you are already signed in
 * on. It is a whole surface of its own (pairing/ScanSignIn), so it takes the
 * page rather than folding into this form, and the door to it sits beside the
 * recovery-phrase door for the same reason that one does.
 */

/** 3 to 24 chars, letters / digits / underscore / hyphen. */
const NAME_RE = /^[a-zA-Z0-9_-]{3,24}$/

type Mode = 'create' | 'signin' | 'recovery' | 'scan'

export function AccountSignIn(): JSX.Element {
  const { busy, error, keyringAccounts } = useAccountsUi()
  const [mode, setMode] = useState<Mode>('create')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  // Privacy default: the derived seed is stored only on an explicit opt-in.
  const [remember, setRemember] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [fill, setFill] = useState(0)
  const [phrase, setPhrase] = useState('')
  const [showPhrase, setShowPhrase] = useState(false)
  const [phraseError, setPhraseError] = useState<string | null>(null)

  const isBusy = busy === 'deriving' || busy === 'verifying'

  /* Key derivation is seconds-scale on a phone, so the wait gets a measure.
     Cosmetic pacing only: the phase flips come from the store. */
  useEffect(() => {
    if (!isBusy) {
      setFill(0)
      return
    }
    const started = Date.now()
    const budget = busy === 'deriving' ? 1300 : 480
    setFill(6)
    const t = window.setInterval(() => {
      setFill(Math.min(96, Math.round(((Date.now() - started) / budget) * 100)))
    }, 80)
    return () => window.clearInterval(t)
  }, [isBusy, busy])

  const nameOk = NAME_RE.test(name)
  const passOk = mode === 'create' ? password.length >= 8 : password.length > 0
  const nameError = !nameOk && (submitted || name !== '')
  const passError = !passOk && (submitted || (mode === 'create' && password !== ''))

  // Real keyring rows under this name: same name plus a different password is a
  // different account, so the password is the picker and there is no list step.
  const sameName = (keyringAccounts ?? []).filter(
    (k) => k.displayName.toLowerCase() === name.toLowerCase()
  )

  const typed = phraseWords(phrase).length

  const switchMode = (m: Mode): void => {
    if (isBusy) return
    // Leaving the phrase behind means leaving key material in a component that
    // is about to show something else. Walking away from the field drops it.
    if (mode === 'recovery' && m !== 'recovery') {
      setPhrase('')
      setShowPhrase(false)
    }
    setMode(m)
    setSubmitted(false)
    setPhraseError(null)
    accountsUiStore.clearError()
  }

  async function submit(): Promise<void> {
    setSubmitted(true)
    if (isBusy) return
    if (mode === 'recovery') {
      // Everything decidable about the phrase is decided BEFORE a key is
      // derived, storage is read or the network is asked.
      const checked = checkPhrase(phrase)
      if (checked.problem !== null || checked.normalized === null) {
        setPhraseError(
          phraseProblemMessage(checked.problem ?? { kind: 'checksum' })
        )
        return
      }
      setPhraseError(null)
      await accountsUiStore.signInWithPhrase(checked.normalized, remember)
      return
    }
    if (!nameOk || !passOk) return
    if (mode === 'create') {
      // The keys exist the moment this returns, so the account commits here and
      // the page it lands on carries the recovery phrase.
      if (await accountsUiStore.createAccount(name, password, remember))
        accountsUiStore.finishCreate()
      return
    }
    await accountsUiStore.signIn(name, password, remember)
  }

  const stored = keyringAccounts ?? []

  // Every hook above this line. Scanning takes the page: a camera viewfinder
  // cannot share a column with a password form on a phone.
  if (mode === 'scan') return <ScanSignIn onBack={() => switchMode('signin')} />

  return (
    <>
      <section className="sec">
        <div className="sec-head">
          <h2 className="lbl">Account</h2>
        </div>
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="acct-where">
            <svg className="icon" aria-hidden focusable="false">
              <use href="#i-lock" />
            </svg>
            <div>
              <p className="acct-where-text">
                {mode === 'recovery'
                  ? 'Sign in with your recovery phrase.'
                  : 'You are not signed in on this device.'}
              </p>
              <p className="acct-where-sub">
                {mode === 'recovery'
                  ? 'The twenty-four words you wrote down when you made the account. They bring it back on any device, and you do not need the password.'
                  : 'Games against the engine, puzzles, School and analysis all work without one. An account adds rated play, friends, and a history that follows you to any device.'}
              </p>
            </div>
          </div>

          {mode !== 'recovery' && (
            <div className="acct-field" aria-busy={isBusy}>
              <div className="segmented">
                <button
                  className="seg"
                  type="button"
                  aria-pressed={mode === 'create'}
                  disabled={isBusy}
                  onClick={() => switchMode('create')}
                >
                  Create account
                </button>
                <button
                  className="seg"
                  type="button"
                  aria-pressed={mode === 'signin'}
                  disabled={isBusy}
                  onClick={() => switchMode('signin')}
                >
                  Sign in
                </button>
              </div>
            </div>
          )}

          {mode === 'recovery' && (
            <div className="acct-field">
              <label className="lbl" htmlFor="acct-phrase">
                Recovery phrase
              </label>
              <textarea
                id="acct-phrase"
                className={`acct-textarea acct-phrase${showPhrase ? '' : ' is-covered'}`}
                value={phrase}
                rows={4}
                disabled={isBusy}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-invalid={phraseError !== null}
                aria-describedby="acct-phrase-count"
                onChange={(e) => {
                  setPhrase(e.target.value)
                  if (phraseError !== null) setPhraseError(null)
                  accountsUiStore.clearError()
                }}
              />
              <div className="acct-pw">
                <button
                  className="btn is-quiet"
                  type="button"
                  disabled={isBusy}
                  onClick={() => setShowPhrase((v) => !v)}
                >
                  {showPhrase ? 'Hide' : 'Show'}
                </button>
                {/* The count is what a covered field can still tell you, and it
                    is the mistake people actually make. */}
                <span className="acct-count" id="acct-phrase-count" aria-live="polite">
                  {typed} of {PHRASE_WORDS} words
                </span>
              </div>
              {phraseError !== null ? (
                <p className="acct-alert" role="alert">
                  {phraseError}
                </p>
              ) : (
                <p className="acct-hint">
                  Type or paste all {PHRASE_WORDS} words, in order, separated by spaces. Capitals and
                  line breaks do not matter.
                </p>
              )}
            </div>
          )}

          {mode !== 'recovery' && (
            <>
              <div className="acct-field">
                <label className="lbl" htmlFor="acct-name">
                  Username
                </label>
                <input
                  id="acct-name"
                  className="filter-input acct-input"
                  value={name}
                  maxLength={24}
                  autoComplete="username"
                  spellCheck={false}
                  disabled={isBusy}
                  aria-invalid={nameError}
                  onChange={(e) => setName(e.target.value)}
                />
                <p
                  className={nameError ? 'acct-alert' : 'acct-hint'}
                  role={nameError ? 'alert' : undefined}
                >
                  3 to 24 characters: letters, numbers, _ and -.
                </p>
                {mode === 'create' && nameOk && (
                  <p className="acct-hint" aria-live="polite">
                    You&rsquo;ll be <span className="num">{name}#·····</span>. Your tag is assigned
                    when the account is created, so names are never taken.
                  </p>
                )}
              </div>

              <div className="acct-field">
                <label className="lbl" htmlFor="acct-pass">
                  Password
                </label>
                <div className="acct-pw">
                  <input
                    id="acct-pass"
                    className="filter-input acct-input"
                    type={showPw ? 'text' : 'password'}
                    value={password}
                    autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
                    disabled={isBusy}
                    aria-invalid={passError}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    className="btn is-quiet"
                    type="button"
                    disabled={isBusy}
                    onClick={() => setShowPw((v) => !v)}
                  >
                    {showPw ? 'Hide' : 'Show'}
                  </button>
                </div>
                {passError ? (
                  <p className="acct-alert" role="alert">
                    {mode === 'create' ? 'At least 8 characters.' : 'Enter your password.'}
                  </p>
                ) : (
                  <p className="acct-hint">
                    {mode === 'create'
                      ? 'At least 8 characters. There is no password reset, so pick one you will keep.'
                      : 'The password you created this account with.'}
                  </p>
                )}
              </div>
            </>
          )}

          {mode === 'signin' && sameName.length > 1 && (
            <div className="acct-field">
              <p className="acct-hint">
                This device holds {sameName.length} accounts named {name} (
                {sameName.map((k) => `#${k.tag}`).join(', ')}). Your password picks which one.
              </p>
            </div>
          )}

          <div className="acct-field">
            <label className="acct-check">
              <input
                type="checkbox"
                checked={remember}
                disabled={isBusy}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>Keep me signed in on this device.</span>
            </label>
            {mode === 'create' && (
              <p className="acct-hint">
                There is no password reset and no email. Next you save a recovery phrase, which is
                the only other way back in.
              </p>
            )}
          </div>

          {/* The door. Under the form in both password modes, because someone
              arriving with a phrase in hand should not have to guess which of
              the two pickers hides it. */}
          {mode !== 'recovery' && (
            <div className="acct-field">
              <p className="acct-hint">
                Already signed in on your phone or another computer? Sign in here by scanning the
                code it shows, and confirming there.
              </p>
              <button
                className="btn is-quiet acct-door"
                type="button"
                disabled={isBusy}
                onClick={() => switchMode('scan')}
              >
                Scan a code
              </button>
              <p className="acct-hint">Lost the password, or on a device that has never seen this account?</p>
              <button
                className="btn is-quiet acct-door"
                type="button"
                disabled={isBusy}
                onClick={() => switchMode('recovery')}
              >
                Use your recovery phrase
              </button>
            </div>
          )}

          {error !== null && (
            <div className="acct-field">
              <p className="acct-alert" role="alert">
                {error}
              </p>
            </div>
          )}

          {isBusy && (
            <div className="acct-field" role="status">
              <p className="acct-hint">
                {busy === 'deriving' ? 'Setting up your account.' : 'Signing you in.'} This takes a
                few seconds, and nothing leaves this device.
              </p>
              <span className="acct-bar" aria-hidden>
                <span className="acct-bar-fill" style={{ width: `${fill}%` }} />
              </span>
            </div>
          )}

          <div className="panel-foot">
            <button className="btn is-primary" type="submit" disabled={isBusy}>
              {isBusy ? 'Working' : mode === 'create' ? 'Create account' : 'Sign in'}
            </button>
            {mode === 'recovery' && (
              <button
                className="btn is-quiet"
                type="button"
                disabled={isBusy}
                onClick={() => switchMode('signin')}
              >
                Use a password instead
              </button>
            )}
          </div>
        </form>
      </section>

      {stored.length > 0 && (
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">On this device</h2>
            <span className="sec-count">
              {stored.length} account{stored.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="panel">
            {stored.map((k) => (
              <div className="row acct-row" key={`${k.foldedName}#${k.tag}`}>
                <div className="acct-row-main">
                  <span className="acct-row-name num">{k.handle}</span>
                </div>
                <button
                  className="btn is-quiet"
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    switchMode('signin')
                    setName(k.displayName)
                  }}
                >
                  Use this name
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}
