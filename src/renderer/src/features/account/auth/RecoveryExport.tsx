import { useEffect, useState, type JSX } from 'react'
import { AlertCircle, Check, Copy, Download, Eye, EyeOff, X } from 'lucide-react'
import { OverlayDialog } from '../../../components/OverlayDialog'
import { accountsUiStore } from '../mock/store'

/**
 * Recovery export: there is no password reset, so the 24-word mnemonic and the
 * keyfile are the only lifelines. The words and keyfile come from the REAL
 * session seed (src/web/accounts.ts exportMnemonic/exportKeyfile), never fixture
 * data. `RecoveryExportBody` is the raw content so AuthDialog can show it as the
 * post-creation step inside its own modal; `RecoveryExport` wraps the same body
 * in an OverlayDialog so SecurityTab can reopen it later.
 */

export function RecoveryExportBody({ onDone }: { onDone: () => void }): JSX.Element {
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)
  const [acked, setAcked] = useState(false)
  // Real exports, read once per mount. The session seed never changes underneath
  // an open dialog.
  const [words] = useState<string[] | null>(() => accountsUiStore.exportMnemonicWords())
  const [keyfile] = useState<{ json: string; filename: string } | null>(() =>
    accountsUiStore.exportKeyfile()
  )

  if (words === null || keyfile === null) {
    // No live session seed (fail-closed). Never show placeholder words a user
    // could mistake for a lifeline.
    return (
      <div className="aauth-recovery">
        <p className="aauth-err" role="alert">
          <AlertCircle size={13} aria-hidden /> Sign in again to save your recovery phrase.
        </p>
        <div className="aauth-recovery-foot">
          <button type="button" className="btn" onClick={onDone}>
            Close
          </button>
        </div>
      </div>
    )
  }

  return <RecoveryContent words={words} keyfile={keyfile} onDone={onDone} state={{ revealed, setRevealed, copied, setCopied, saved, setSaved, acked, setAcked }} />
}

interface RecoveryUiState {
  revealed: boolean
  setRevealed: (v: boolean) => void
  copied: boolean
  setCopied: (v: boolean) => void
  saved: boolean
  setSaved: (v: boolean) => void
  acked: boolean
  setAcked: (v: boolean) => void
}

function RecoveryContent({
  words,
  keyfile,
  onDone,
  state
}: {
  words: string[]
  keyfile: { json: string; filename: string }
  onDone: () => void
  state: RecoveryUiState
}): JSX.Element {
  const { revealed, setRevealed, copied, setCopied, saved, setSaved, acked, setAcked } = state

  // Transient "Copied" / "Keyfile saved" feedback, with cleanup.
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(t)
  }, [copied])

  useEffect(() => {
    if (!saved) return
    const t = window.setTimeout(() => setSaved(false), 2400)
    return () => window.clearTimeout(t)
  }, [saved])

  const copyPhrase = (): void => {
    void navigator.clipboard
      ?.writeText(words.join(' '))
      .then(() => setCopied(true))
      .catch(() => {})
  }

  const downloadKeyfile = (): void => {
    const blob = new Blob([keyfile.json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = keyfile.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    setSaved(true)
  }

  return (
    <div className="aauth-recovery">
      <p className="aauth-lead">
        These 24 words are the only way back into your account, and anyone who has them has your
        account. Write them down somewhere offline, or download the keyfile. Either one restores it
        on any device.
      </p>

      <div className="aauth-words-wrap">
        <ol className={`aauth-words${revealed ? '' : ' is-hidden'}`} aria-hidden={!revealed}>
          {words.map((w, i) => (
            <li key={`${i}-${w}`} className="aauth-word">
              <span className="aauth-word-n num">{i + 1}</span>
              <span className="aauth-word-w">{w}</span>
            </li>
          ))}
        </ol>
        {!revealed && (
          <div className="aauth-reveal">
            <button
              type="button"
              className="btn ghost aauth-btn-ic"
              onClick={() => setRevealed(true)}
            >
              <Eye size={15} aria-hidden /> Reveal words
            </button>
          </div>
        )}
      </div>

      <div className="aauth-recovery-actions" aria-live="polite">
        <button type="button" className="btn ghost small aauth-btn-ic" onClick={copyPhrase}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copied ? 'Copied' : 'Copy phrase'}
        </button>
        <button type="button" className="btn ghost small aauth-btn-ic" onClick={downloadKeyfile}>
          {saved ? <Check size={14} aria-hidden /> : <Download size={14} aria-hidden />}
          {saved ? 'Keyfile saved' : 'Download keyfile'}
        </button>
        {revealed && (
          <button
            type="button"
            className="btn ghost small aauth-btn-ic"
            onClick={() => setRevealed(false)}
          >
            <EyeOff size={14} aria-hidden /> Hide
          </button>
        )}
      </div>

      <label className="aauth-ack">
        <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
        <span>I&rsquo;ve written these down. There is no reset.</span>
      </label>

      <div className="aauth-recovery-foot">
        <button type="button" className="btn" disabled={!acked} onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  )
}

export function RecoveryExport({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <OverlayDialog
      onClose={onClose}
      placement="center"
      className="shell-modal"
      labelledBy="aauth-recovery-title"
    >
      <div className="shell-modal-head">
        <h2 id="aauth-recovery-title">Recovery phrase &amp; keyfile</h2>
        <button type="button" className="shell-modal-close" aria-label="Close" onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      </div>
      <div className="shell-modal-body">
        <RecoveryExportBody onDone={onClose} />
      </div>
    </OverlayDialog>
  )
}
