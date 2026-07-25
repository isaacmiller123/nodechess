import { useCallback, useRef, useState, type JSX } from 'react'
import { ClipboardCopy, ClipboardPaste, Check, Eraser } from 'lucide-react'
import { parsePgnToGame, type LoadedGame } from './shareGame'

export interface SharePanelProps {
  /** PGN of the current tree (mainline). */
  pgn: string
  /** FEN of the current position. */
  fen: string
  /** Whether the current node has annotations to clear. */
  canClearAnnotations: boolean
  /** Clear annotations on the current node. */
  onClearAnnotations: () => void
  /** Load a parsed game's mainline into the tree. */
  onLoadGame: (game: LoadedGame) => void
}

type Copied = 'pgn' | 'fen' | null

/**
 * Export / import + annotations controls for the Analysis board:
 * Copy PGN, Copy FEN, Paste PGN (load a game into the tree), and Clear
 * annotations. Clipboard access is guarded; copy buttons confirm inline.
 */
export function SharePanel({
  pgn,
  fen,
  canClearAnnotations,
  onClearAnnotations,
  onLoadGame
}: SharePanelProps): JSX.Element {
  const [copied, setCopied] = useState<Copied>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flagCopied = useCallback((which: Exclude<Copied, null>) => {
    setCopied(which)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(null), 1400)
  }, [])

  const copy = useCallback(
    (text: string, which: Exclude<Copied, null>) => {
      const clip = navigator.clipboard
      if (!clip?.writeText) return
      clip
        .writeText(text)
        .then(() => flagCopied(which))
        .catch(() => {
          /* clipboard denied: silently no-op */
        })
    },
    [flagCopied]
  )

  const loadPaste = useCallback(() => {
    const game = parsePgnToGame(pasteText)
    if (!game) {
      setPasteError('Could not read a game from that PGN.')
      return
    }
    onLoadGame(game)
    setPasteText('')
    setPasteError(null)
    setPasteOpen(false)
  }, [pasteText, onLoadGame])

  return (
    <div className="panel share-panel">
      <div className="panel-head">
        <span className="panel-title">Share</span>
      </div>
      <div className="share-body">
        <div className="share-row">
          <button
            type="button"
            className="btn ghost share-btn"
            onClick={() => copy(pgn, 'pgn')}
            aria-label="Copy game PGN to clipboard"
          >
            {copied === 'pgn' ? <Check size={14} /> : <ClipboardCopy size={14} />}
            {copied === 'pgn' ? 'Copied' : 'Copy PGN'}
          </button>
          <button
            type="button"
            className="btn ghost share-btn"
            onClick={() => copy(fen, 'fen')}
            aria-label="Copy current position FEN to clipboard"
          >
            {copied === 'fen' ? <Check size={14} /> : <ClipboardCopy size={14} />}
            {copied === 'fen' ? 'Copied' : 'Copy FEN'}
          </button>
        </div>

        {pasteOpen ? (
          <div className="share-paste">
            <textarea
              className="share-textarea num"
              placeholder="Paste a PGN game here…"
              value={pasteText}
              autoFocus
              spellCheck={false}
              rows={5}
              onChange={(e) => {
                setPasteText(e.target.value)
                if (pasteError) setPasteError(null)
              }}
            />
            {pasteError && (
              <p className="share-error" role="alert">
                {pasteError}
              </p>
            )}
            <div className="share-row">
              <button type="button" className="btn share-btn" disabled={!pasteText.trim()} onClick={loadPaste}>
                Load game
              </button>
              <button
                type="button"
                className="btn ghost share-btn"
                onClick={() => {
                  setPasteOpen(false)
                  setPasteText('')
                  setPasteError(null)
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn ghost share-btn share-full" onClick={() => setPasteOpen(true)}>
            <ClipboardPaste size={14} /> Paste PGN
          </button>
        )}

        <button
          type="button"
          className="btn ghost share-btn share-full share-clear"
          disabled={!canClearAnnotations}
          onClick={onClearAnnotations}
          title="Remove right-click arrows and circles from this position"
        >
          <Eraser size={14} /> Clear annotations
        </button>
      </div>
    </div>
  )
}
