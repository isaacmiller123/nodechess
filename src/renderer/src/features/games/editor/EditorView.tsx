import { useCallback, useEffect, useState, type JSX } from 'react'
import {
  ArrowLeft,
  FlaskConical,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2
} from 'lucide-react'
import type { CustomVariantRow } from '@shared/types'
import type { CustomVariantDef } from '../../../games/customVariants'
import { displayFenOfIni, parentDef, PARENTS, type EditorModel } from './model'
import { TEMPLATES, type VariantTemplate } from './templates'
import { MiniBoard } from './MiniBoard'
import { VariantEditor, type EditorSeed } from './VariantEditor'
import { PlayCustom } from './PlayCustom'
import './editor.css'

type Mode =
  | { t: 'gallery' }
  | { t: 'templates' }
  | { t: 'edit'; seed: EditorSeed }
  | { t: 'play'; def: CustomVariantDef }

function cloneModel(model: EditorModel): EditorModel {
  return { ...model, board: model.board.slice(), promotion: [...model.promotion] }
}

function rowToDef(row: CustomVariantRow): CustomVariantDef {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    iniText: row.iniText,
    boardFiles: row.boardFiles,
    boardRanks: row.boardRanks
  }
}

/**
 * The Variant Lab: gallery of saved custom variants, a template picker for
 * new ones, the builder, and local OTB play. Everything a user needs to invent
 * a chess variant and play it thirty seconds later.
 */
export default function EditorView({ onExit }: { onExit(): void }): JSX.Element {
  const [mode, setMode] = useState<Mode>({ t: 'gallery' })
  const [rows, setRows] = useState<CustomVariantRow[] | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await window.api.customVariants.list()
      setRows(res.variants)
    } catch {
      setRows([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openTemplate = (tpl: VariantTemplate): void => {
    const model = cloneModel(tpl.model)
    setMode({
      t: 'edit',
      seed: {
        name: model.name,
        description: model.description,
        model,
        boardFiles: model.files,
        boardRanks: model.ranks
      }
    })
  }

  const openSaved = (row: CustomVariantRow): void => {
    setMode({
      t: 'edit',
      seed: {
        id: row.id,
        name: row.name,
        description: row.description,
        iniText: row.iniText,
        boardFiles: row.boardFiles,
        boardRanks: row.boardRanks
      }
    })
  }

  const deleteRow = async (id: string): Promise<void> => {
    setConfirmDelete(null)
    try {
      await window.api.customVariants.delete(id)
    } finally {
      void refresh()
    }
  }

  if (mode.t === 'play') {
    return <PlayCustom def={mode.def} onBack={() => setMode({ t: 'gallery' })} />
  }

  if (mode.t === 'edit') {
    return (
      <VariantEditor
        seed={mode.seed}
        takenIds={(rows ?? []).map((r) => r.id)}
        onBack={() => setMode({ t: 'gallery' })}
        onSaved={() => void refresh()}
        onPlay={(def) => setMode({ t: 'play', def })}
      />
    )
  }

  if (mode.t === 'templates') {
    return (
      <div className="vl-view">
        <header className="vl-head">
          <button type="button" className="vl-btn vl-back" onClick={() => setMode({ t: 'gallery' })}>
            <ArrowLeft size={14} aria-hidden /> Variant Lab
          </button>
          <div>
            <h2 className="vl-title">Start from a template</h2>
            <p className="vl-sub">Every template is playable as-is. Pick one and bend it.</p>
          </div>
        </header>
        <div className="vl-template-grid">
          {TEMPLATES.map((tpl) => {
            const parent = parentDef(tpl.model.parent)
            const locked = parent.lockBoard === true
            return (
              <button key={tpl.id} type="button" className="vl-card" onClick={() => openTemplate(tpl)}>
                <span className="vl-card-thumb">
                  <MiniBoard
                    files={tpl.model.files}
                    ranks={tpl.model.ranks}
                    board={locked ? undefined : tpl.model.board}
                    fen={locked ? parent.startFen : undefined}
                  />
                </span>
                <span className="vl-card-title">{tpl.title}</span>
                <span className="vl-card-sub">{tpl.blurb}</span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // ---- gallery ---------------------------------------------------------------
  return (
    <div className="vl-view">
      <header className="vl-head">
        <button type="button" className="vl-btn vl-back" onClick={onExit}>
          <ArrowLeft size={14} aria-hidden /> Games
        </button>
        <div>
          <h2 className="vl-title">
            <FlaskConical size={20} aria-hidden /> Variant Lab
          </h2>
          <p className="vl-sub">
            Invent your own chess: thirty pawns, Amazon queens, exploding captures, any board the
            engine can hold. Built on real Fairy-Stockfish rules.
          </p>
        </div>
        <button type="button" className="vl-btn is-primary vl-new" onClick={() => setMode({ t: 'templates' })}>
          <Plus size={15} aria-hidden /> New variant
        </button>
      </header>

      {rows === null && (
        <div className="vl-play-loading" role="status">
          <span className="view-spinner" aria-hidden />
          Loading your creations…
        </div>
      )}

      {rows !== null && rows.length === 0 && (
        <div className="vl-empty">
          <Sparkles size={26} aria-hidden />
          <h3>No variants yet</h3>
          <p>
            Start from a template. The 30 Pawns Army takes about ten seconds to make and a lifetime
            to master.
          </p>
          <button type="button" className="vl-btn is-primary" onClick={() => setMode({ t: 'templates' })}>
            <Plus size={15} aria-hidden /> Create your first variant
          </button>
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="vl-gallery">
          {rows.map((row) => {
            const fen = displayFenOfIni(row.iniText)
            const head = /^\s*\[[A-Za-z0-9_-]+:([A-Za-z0-9_-]+)\]\s*$/m.exec(row.iniText)
            const parent = head ? PARENTS.find((p) => p.id === head[1]) : undefined
            return (
              <article key={row.id} className="vl-card is-saved">
                <span className="vl-card-thumb">
                  <MiniBoard files={row.boardFiles} ranks={row.boardRanks} fen={fen} />
                </span>
                <div className="vl-card-body">
                  <span className="vl-card-title">{row.name}</span>
                  {row.description && <span className="vl-card-sub">{row.description}</span>}
                  <span className="vl-card-meta">
                    <span className="vl-chip">
                      {row.boardFiles}×{row.boardRanks}
                    </span>
                    {parent && <span className="vl-chip">{parent.label} rules</span>}
                  </span>
                </div>
                <div className="vl-card-actions">
                  <button
                    type="button"
                    className="vl-btn is-primary"
                    onClick={() => setMode({ t: 'play', def: rowToDef(row) })}
                  >
                    <Play size={14} aria-hidden /> Play
                  </button>
                  <button type="button" className="vl-btn" onClick={() => openSaved(row)}>
                    <Pencil size={14} aria-hidden /> Edit
                  </button>
                  {confirmDelete === row.id ? (
                    <button
                      type="button"
                      className="vl-btn is-danger"
                      onClick={() => void deleteRow(row.id)}
                    >
                      <Trash2 size={14} aria-hidden /> Really delete?
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="vl-btn is-quiet"
                      onClick={() => setConfirmDelete(row.id)}
                      aria-label={`Delete ${row.name}`}
                    >
                      <Trash2 size={14} aria-hidden />
                    </button>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
