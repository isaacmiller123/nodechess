import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Play,
  Save,
  ShieldAlert,
  Undo2,
  XCircle
} from 'lucide-react'
import { preloadFfish } from '../../../games/ffish'
import {
  validateCustomVariantIni,
  MAX_BOARD_FILES,
  MAX_BOARD_RANKS,
  MIN_BOARD_SIZE,
  type CustomVariantDef
} from '../../../games/customVariants'
import {
  generateIni,
  modelFromIni,
  parentDef,
  resizeBoard,
  slugify,
  PARENTS,
  PIECE_PALETTE,
  type EditorModel,
  type ParentVariant,
  type PieceLetter
} from './model'
import { PositionPainter } from './PositionPainter'
import { PieceGlyph } from './PieceGlyph'

type Validation =
  | { t: 'dirty' }
  | { t: 'checking' }
  | { t: 'ok'; moveCount: number }
  | { t: 'bad'; error: string }

export interface EditorSeed {
  /** Present when editing a saved variant (keeps its id on save). */
  id?: string
  name: string
  description: string
  model?: EditorModel
  /** Raw ini text (saved variants); wins over `model` when it does not round-trip. */
  iniText?: string
  boardFiles: number
  boardRanks: number
}

/**
 * The Variant Lab builder: board painter + rule panels on a live variants.ini
 * preview, validated through the real rules engine before save/play.
 */
export function VariantEditor({
  seed,
  takenIds,
  onBack,
  onSaved,
  onPlay
}: {
  seed: EditorSeed
  /** Existing ids (collision-avoidance for new variants). */
  takenIds: string[]
  onBack(): void
  onSaved(def: CustomVariantDef): void
  onPlay(def: CustomVariantDef): void
}): JSX.Element {
  // ---- model / raw-mode bootstrapping --------------------------------------
  const initial = useMemo(() => {
    if (seed.model) return { model: seed.model, raw: null as string | null }
    if (seed.iniText) {
      const rebuilt = modelFromIni(seed.iniText, {
        name: seed.name,
        description: seed.description,
        files: seed.boardFiles,
        ranks: seed.boardRanks
      })
      if (rebuilt && rebuilt.exact) return { model: rebuilt.model, raw: null }
      if (rebuilt) return { model: rebuilt.model, raw: seed.iniText }
    }
    return { model: null, raw: seed.iniText ?? '' }
    // seed is stable for the life of this editor instance
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [model, setModel] = useState<EditorModel | null>(initial.model)
  const [rawText, setRawText] = useState<string | null>(initial.raw)
  const [advancedOpen, setAdvancedOpen] = useState(initial.raw !== null)
  const [validation, setValidation] = useState<Validation>({ t: 'dirty' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const rawMode = rawText !== null
  const ini = rawMode ? rawText : model ? generateIni(model) : ''

  // Any edit invalidates the last engine check.
  const iniRef = useRef(ini)
  useEffect(() => {
    if (iniRef.current !== ini) {
      iniRef.current = ini
      setValidation({ t: 'dirty' })
      setSaveError(null)
    }
  }, [ini])

  const patch = useCallback((p: Partial<EditorModel>): void => {
    setModel((m) => (m ? { ...m, ...p } : m))
  }, [])

  const name = model?.name ?? seed.name
  const description = model?.description ?? seed.description
  const files = model?.files ?? seed.boardFiles
  const ranks = model?.ranks ?? seed.boardRanks
  const parent = parentDef(model?.parent ?? 'chess')
  const boardLocked = parent.lockBoard === true

  // ---- actions --------------------------------------------------------------
  const validate = useCallback(async (): Promise<Validation> => {
    setValidation({ t: 'checking' })
    try {
      await preloadFfish()
      const res = validateCustomVariantIni(iniRef.current)
      const v: Validation = res.ok
        ? { t: 'ok', moveCount: res.moveCount ?? 0 }
        : { t: 'bad', error: res.error ?? 'Unknown problem.' }
      setValidation(v)
      return v
    } catch (err) {
      const v: Validation = {
        t: 'bad',
        error: `The rules engine failed to load (${err instanceof Error ? err.message : String(err)}).`
      }
      setValidation(v)
      return v
    }
  }, [])

  const buildDef = useCallback((): CustomVariantDef => {
    let id = seed.id
    if (!id) {
      const base = slugify(name)
      id = base
      let n = 2
      while (takenIds.includes(id)) id = `${base}-${n++}`
    }
    // Raw mode can change the board size out from under the builder. Trust the
    // ini text (explicit maxFile/maxRank, else the parent's dims) for the
    // persisted card dims.
    let defFiles = files
    let defRanks = ranks
    if (rawMode) {
      const mf = /^\s*maxFile\s*=\s*(\d+)\s*$/m.exec(iniRef.current)
      const mr = /^\s*maxRank\s*=\s*(\d+)\s*$/m.exec(iniRef.current)
      const head = /^\s*\[[A-Za-z0-9_-]+:([A-Za-z0-9_-]+)\]\s*$/m.exec(iniRef.current)
      const p = head ? PARENTS.find((x) => x.id === head[1]) : undefined
      defFiles = mf ? parseInt(mf[1], 10) : (p?.files ?? files)
      defRanks = mr ? parseInt(mr[1], 10) : (p?.ranks ?? ranks)
    }
    return {
      id,
      name: name.trim() || 'Untitled variant',
      description: description.trim(),
      iniText: iniRef.current,
      boardFiles: defFiles,
      boardRanks: defRanks
    }
  }, [seed.id, name, description, files, ranks, takenIds, rawMode])

  const saveThen = useCallback(
    async (after: 'stay' | 'play'): Promise<void> => {
      setSaving(true)
      setSaveError(null)
      try {
        const v = validation.t === 'ok' ? validation : await validate()
        if (v.t !== 'ok') return
        const def = buildDef()
        await window.api.customVariants.save(def)
        onSaved(def)
        if (after === 'play') onPlay(def)
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err))
      } finally {
        setSaving(false)
      }
    },
    [validation, validate, buildDef, onSaved, onPlay]
  )

  // ---- panels ----------------------------------------------------------------
  const sizeSlider = (
    label: string,
    value: number,
    max: number,
    apply: (v: number) => void
  ): JSX.Element => (
    <label className="vl-slider">
      <span className="vl-slider-label">
        {label} <strong>{value}</strong>
      </span>
      <input
        type="range"
        min={MIN_BOARD_SIZE}
        max={max}
        value={value}
        disabled={boardLocked}
        onChange={(e) => apply(parseInt(e.target.value, 10))}
      />
    </label>
  )

  const promotionChoices = PIECE_PALETTE.filter((p) => p.letter !== 'k' && p.letter !== 'p')

  return (
    <div className="vl-editor">
      <header className="vl-editor-head">
        <button type="button" className="vl-btn vl-back" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden /> Variant Lab
        </button>
        <div className="vl-editor-title">
          <input
            className="vl-name-input"
            value={name}
            placeholder="Name your variant"
            maxLength={80}
            onChange={(e) => patch({ name: e.target.value })}
            disabled={model === null}
            aria-label="Variant name"
          />
          <input
            className="vl-desc-input"
            value={description}
            placeholder="One line on why it's fun"
            maxLength={200}
            onChange={(e) => patch({ description: e.target.value })}
            disabled={model === null}
            aria-label="Variant description"
          />
        </div>
        <div className="vl-editor-cta">
          <button
            type="button"
            className="vl-btn"
            onClick={() => void saveThen('stay')}
            disabled={saving || validation.t === 'checking'}
          >
            <Save size={14} aria-hidden /> Save
          </button>
          <button
            type="button"
            className="vl-btn is-primary"
            onClick={() => void saveThen('play')}
            disabled={saving || validation.t === 'checking'}
          >
            <Play size={14} aria-hidden /> Save &amp; play
          </button>
        </div>
      </header>

      <div className="vl-editor-grid">
        <section className="vl-editor-board" aria-label="Start position">
          {model ? (
            <PositionPainter
              files={files}
              ranks={ranks}
              board={model.board}
              onChange={(board) => patch({ board })}
              disabled={boardLocked}
              disabledNote={`${parent.label} defines its own start. The board is part of the rules you inherit.`}
            />
          ) : (
            <div className="vl-rawonly-note" role="note">
              <Code2 size={18} aria-hidden />
              This variant is hand-written ini. Edit it in the Advanced panel.
            </div>
          )}
        </section>

        <section className="vl-editor-panels">
          {model && (
            <>
              <div className="vl-panel">
                <h4 className="vl-panel-title">Board</h4>
                {sizeSlider('Files', files, MAX_BOARD_FILES, (v) =>
                  patch({
                    files: v,
                    board: resizeBoard(model.board, files, ranks, v, ranks),
                    castling: model.castling && v === 8
                  })
                )}
                {sizeSlider('Ranks', ranks, MAX_BOARD_RANKS, (v) =>
                  patch({ ranks: v, board: resizeBoard(model.board, files, ranks, files, v) })
                )}
                {boardLocked && (
                  <p className="vl-panel-note">{parent.label} boards are fixed at {parent.files}×{parent.ranks}.</p>
                )}
              </div>

              <div className="vl-panel">
                <h4 className="vl-panel-title">Rules</h4>
                <label className="vl-field">
                  <span>Base game</span>
                  <select
                    value={model.parent}
                    onChange={(e) => {
                      const next = e.target.value as ParentVariant
                      const np = parentDef(next)
                      patch(
                        np.lockBoard
                          ? { parent: next, files: np.files, ranks: np.ranks }
                          : { parent: next }
                      )
                    }}
                  >
                    {PARENTS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="vl-panel-note">{parent.note}.</p>
                <label className="vl-field">
                  <span>Winning</span>
                  <select
                    value={model.royal}
                    disabled={boardLocked}
                    onChange={(e) => patch({ royal: e.target.value as EditorModel['royal'] })}
                  >
                    <option value="checkmate">Checkmate (checks enforced)</option>
                    <option value="king-capture">Capture the king (no check rules)</option>
                  </select>
                </label>
                <label className="vl-toggle">
                  <input
                    type="checkbox"
                    checked={model.castling && files === 8 && model.royal === 'checkmate'}
                    disabled={boardLocked || files !== 8 || model.royal === 'king-capture'}
                    onChange={(e) => patch({ castling: e.target.checked })}
                  />
                  Castling
                  {files !== 8 && <em className="vl-toggle-note">needs an 8-file board</em>}
                  {model.royal === 'king-capture' && (
                    <em className="vl-toggle-note">needs a royal king</em>
                  )}
                </label>
                <label className="vl-toggle">
                  <input
                    type="checkbox"
                    checked={model.doubleStep}
                    disabled={boardLocked}
                    onChange={(e) => patch({ doubleStep: e.target.checked })}
                  />
                  Pawn double step
                </label>
              </div>

              <div className="vl-panel">
                <h4 className="vl-panel-title">Promotion</h4>
                <div className="vl-promo-picks" role="group" aria-label="Promotion pieces">
                  {promotionChoices.map((p) => {
                    const active = model.promotion.includes(p.letter)
                    return (
                      <button
                        key={p.letter}
                        type="button"
                        className={`vl-pick${active ? ' is-active' : ''}`}
                        title={`${p.name}: ${p.moves}${p.betza ? ` (Betza ${p.betza})` : ''}`}
                        disabled={boardLocked}
                        onClick={() => {
                          const next = active
                            ? model.promotion.filter((l) => l !== p.letter)
                            : [...model.promotion, p.letter]
                          if (next.length > 0) patch({ promotion: next as PieceLetter[] })
                        }}
                      >
                        <PieceGlyph letter={p.letter} color="white" size={26} />
                      </button>
                    )
                  })}
                </div>
                <p className="vl-panel-note">
                  Pawns reaching the last rank may become any highlighted piece.
                </p>
              </div>
            </>
          )}

          <div className="vl-panel">
            <button
              type="button"
              className="vl-advanced-toggle"
              onClick={() => setAdvancedOpen((o) => !o)}
              aria-expanded={advancedOpen}
            >
              {advancedOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
              <Code2 size={14} aria-hidden />
              Advanced: variants.ini
              {rawMode && <span className="vl-raw-pill">raw mode</span>}
            </button>
            {advancedOpen && (
              <div className="vl-advanced">
                {rawMode ? (
                  <>
                    <textarea
                      className="vl-ini-edit"
                      value={rawText ?? ''}
                      spellCheck={false}
                      rows={Math.min(24, Math.max(8, (rawText ?? '').split('\n').length + 2))}
                      onChange={(e) => setRawText(e.target.value)}
                      aria-label="variants.ini text"
                    />
                    {model && (
                      <button
                        type="button"
                        className="vl-tool"
                        onClick={() => setRawText(null)}
                        title="Regenerate the ini from the builder panels (discards raw edits)"
                      >
                        <Undo2 size={13} aria-hidden /> Back to the builder
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <pre className="vl-ini-view">
                      <code>{ini}</code>
                    </pre>
                    <button
                      type="button"
                      className="vl-tool"
                      onClick={() => setRawText(ini)}
                      title="Edit the generated ini directly (Fairy-Stockfish variants.ini syntax)"
                    >
                      <Code2 size={13} aria-hidden /> Edit raw
                    </button>
                  </>
                )}
                <p className="vl-panel-note">
                  Fairy-Stockfish <code>variants.ini</code> syntax: fairy pieces use Betza notation
                  (Amazon <code>QN</code>, Chancellor <code>RN</code>, Archbishop <code>BN</code>).
                </p>
              </div>
            )}
          </div>

          <div className="vl-panel vl-validate">
            <button
              type="button"
              className="vl-btn"
              onClick={() => void validate()}
              disabled={validation.t === 'checking'}
            >
              <ShieldAlert size={14} aria-hidden />
              {validation.t === 'checking' ? 'Checking…' : 'Check rules'}
            </button>
            {validation.t === 'ok' && (
              <p className="vl-validation is-ok" role="status">
                <CheckCircle2 size={15} aria-hidden />
                Loads clean. {validation.moveCount} legal first moves.
              </p>
            )}
            {validation.t === 'bad' && (
              <p className="vl-validation is-bad" role="alert">
                <XCircle size={15} aria-hidden />
                {validation.error}
              </p>
            )}
            {saveError && (
              <p className="vl-validation is-bad" role="alert">
                <XCircle size={15} aria-hidden />
                {saveError}
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
