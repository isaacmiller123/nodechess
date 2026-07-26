import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { BOT_LEVEL_NAMES, resolveBotProvider } from '../../games/bots'
import { isRegisteredGame } from '../../games/registry'
import type { GameKind } from '../../games/kernel'
import type { GoHandicap, GoScoring, GoSize } from '../../games/go'
import { BYOYOMI_PRESETS } from '../play/byoyomi'
import { TIME_CONTROLS } from '../play/timeControl'
import { GO_MAIN_PRESETS } from './goClock'
import { TEMPLATES } from './editor/templates'
import { parentDef } from './editor/model'
import { GmArt } from './gmArt'
import type { CatalogEntry } from './catalog'
import {
  clockKind,
  defaultSetup,
  hasSeatChoice,
  komiForHandicap,
  parseBoardSize,
  resolveLaunch,
  SetupError,
  sideLabels,
  type GameLaunch,
  type SetupMode,
  type SetupState
} from './setup'

/* THE CONFIGURATION SCREEN, from design-lab/v1/games.html.
 *
 * One dialog for every game. Mode first, then a clock, then an Advanced panel
 * that stays shut until you want it and carries only the options that
 * particular game actually has.
 *
 * v1's Advanced map was written against src/renderer/src/games, so most of it
 * is real: go's four options, chess960's Scharnagl number, a start FEN for the
 * rest of the chess family, gomoku's board size, hex's pie rule. The rows it
 * asks for that this build cannot play are absent, and setup.ts says why at
 * each one. A control that does nothing is worse than a control that is not
 * there, because only one of the two lies. */

const MODES: { value: SetupMode; label: string }[] = [
  { value: 'local', label: 'Local' },
  { value: 'bot', label: 'Bot' },
  { value: 'online', label: 'Online' }
]

const GO_SIZES: { value: GoSize; label: string }[] = [
  { value: 9, label: '9x9' },
  { value: 13, label: '13x13' },
  { value: 19, label: '19x19' }
]

/** games/go.ts takes 0 or 2..9 hoshi stones; 1 stone is just komi. */
const GO_HANDICAPS: GoHandicap[] = [0, 2, 3, 4, 5, 6, 7, 8, 9]

/** games/gomoku.ts takes 5..19; these are the four worth a row. */
const GOMOKU_SIZES = [9, 13, 15, 19]

/** v1's four boards for the Lab. A start whose own board is none of these
 *  adds it, because a size the user already chose cannot go missing. */
const LAB_BOARDS = ['8x8', '8x10', '9x9', '10x10']

/** v1 writes the byo-yomi presets with a plain x; features/play/byoyomi.ts
 *  writes them with a multiplication sign. The screen is v1's. */
const BYOYOMI_LABELS: Record<string, string> = {
  off: 'Off',
  '3x30': '3x30s',
  '5x30': '5x30s',
  '5x60': '5x1m'
}

function Row({
  label,
  htmlFor,
  note,
  children
}: {
  label: string
  htmlFor?: string
  /** A true statement about this row, sitting between label and control. */
  note?: string
  children?: ReactNode
}): JSX.Element {
  return (
    <div className="gm-row">
      {htmlFor ? (
        <label className="lbl" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="lbl">{label}</span>
      )}
      {note && <span className="foot-note">{note}</span>}
      {children && <span className="gm-ctl">{children}</span>}
    </div>
  )
}

function Select({
  id,
  value,
  onChange,
  options
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}): JSX.Element {
  return (
    <select
      className="gm-select"
      id={id}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function GameSetup({
  entry,
  onClose,
  onStart,
  onOpenManual,
  onOpenEditor
}: {
  entry: CatalogEntry
  onClose: () => void
  onStart: (launch: GameLaunch) => void
  onOpenManual: () => void
  /** Create your own is a different errand: it opens the Lab, not a game. */
  onOpenEditor: (templateId: string, board: { files: number; ranks: number } | null) => void
}): JSX.Element {
  const [s, setS] = useState<SetupState>(() => defaultSetup(entry))
  const [advOpen, setAdvOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)

  const isCreate = entry.kind === 'custom-editor'
  const set = useCallback(<K extends keyof SetupState>(k: K, v: SetupState[K]): void => {
    setError(null)
    setS((prev) => ({ ...prev, [k]: v }))
  }, [])

  /* Escape closes, and Tab stays inside the screen while it is up. */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !dialog.current) return
      const focusable = [
        ...dialog.current.querySelectorAll<HTMLElement>('button, select, input')
      ].filter((el) => el.offsetParent !== null)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  /* The first control, so the screen can be driven from the keyboard the
     moment it opens. Create your own has no mode, so its focus is Advanced. */
  useEffect(() => {
    const target = dialog.current?.querySelector<HTMLElement>(
      isCreate ? '.gm-adv .gm-disc' : '.segmented .seg'
    )
    target?.focus()
  }, [isCreate])

  /* The per-level hint the bot itself reports ("~1400 Elo engine", and a
     different ladder once KataGo's human net is installed). */
  const levelHint = useMemo(() => {
    if (s.mode !== 'bot' || !isRegisteredGame(entry.kind)) return undefined
    try {
      return resolveBotProvider(entry.kind as GameKind).describe(s.level)
    } catch {
      return undefined
    }
  }, [s.mode, s.level, entry.kind])

  const start = (): void => {
    if (isCreate) {
      onOpenEditor(s.templateId, parseBoardSize(s.boardSize))
      return
    }
    try {
      onStart(resolveLaunch(entry, s))
    } catch (err) {
      setError(err instanceof SetupError ? err.message : 'That position could not be set up.')
    }
  }

  const [firstSide, secondSide] = sideLabels(
    entry.family === 'draughts' ? s.draughtsKind : entry.kind
  )
  const clock = clockKind(entry, s.mode)

  /* v1's ADV map, kept in v1's order: the seat first, then whatever that
     particular game's rules take. */
  function advancedRows(): JSX.Element[] {
    const rows: JSX.Element[] = []

    if (isCreate) {
      // v1 offers "Standard chess / Empty board". The Lab opens on seven named
      // starts instead, so those are what this row names.
      const tpl = TEMPLATES.find((t) => t.id === s.templateId) ?? TEMPLATES[0]
      const parent = parentDef(tpl.model.parent)
      const own = `${tpl.model.files}x${tpl.model.ranks}`
      rows.push(
        <Row key="template" label="Start from" htmlFor="gm-template">
          <Select
            id="gm-template"
            value={s.templateId}
            onChange={(v) => {
              // A start brings its own board, so picking one sets the row below.
              const next = TEMPLATES.find((t) => t.id === v)
              setError(null)
              setS((prev) => ({
                ...prev,
                templateId: v,
                boardSize: next ? `${next.model.files}x${next.model.ranks}` : prev.boardSize
              }))
            }}
            options={TEMPLATES.map((t) => ({ value: t.id, label: t.title }))}
          />
        </Row>
      )
      // v1's four sizes. The Lab's own Files/Ranks sliders go further, so this
      // is a seed, not a limit. A parent that defines its own start defines its
      // own board with it, and then the row says so rather than offering four.
      rows.push(
        parent.lockBoard === true ? (
          <Row key="lab-board" label="Board" note={`${parent.label} is fixed at ${own}.`} />
        ) : (
          <Row key="lab-board" label="Board" htmlFor="gm-lab-board">
            <Select
              id="gm-lab-board"
              value={s.boardSize}
              onChange={(v) => set('boardSize', v)}
              options={(LAB_BOARDS.includes(own) ? LAB_BOARDS : [own, ...LAB_BOARDS]).map((b) => ({
                value: b,
                label: b
              }))}
            />
          </Row>
        )
      )
      return rows
    }

    /* "Play as" comes first in every game, the way v1 writes it. What it
       decides depends on who is sitting down: vs a bot it is the seat you
       take, and locally it is the side of the board you sit on, which is the
       side the board opens facing. Online it would reach nothing: that screen
       asks the host for a colour itself. */
    if (hasSeatChoice(s.mode)) {
      rows.push(
        <Row key="side" label="Play as" htmlFor="gm-side">
          <Select
            id="gm-side"
            value={s.side}
            onChange={(v) => set('side', v as SetupState['side'])}
            options={[
              { value: 'first', label: firstSide },
              { value: 'second', label: secondSide },
              { value: 'random', label: 'Random' }
            ]}
          />
        </Row>
      )
    }

    // v1 puts this between the seat and the position, because it is a rule of
    // the game rather than a property of the start square layout.
    if (entry.kind === 'threecheck') {
      rows.push(
        <Row key="checks" label="Checks to win" htmlFor="gm-checks">
          <Select
            id="gm-checks"
            value={String(s.checks)}
            onChange={(v) => set('checks', Number(v))}
            options={[
              { value: '3', label: '3' },
              { value: '2', label: '2' },
              { value: '1', label: '1' }
            ]}
          />
        </Row>
      )
    }

    if (entry.kind === 'chess960') {
      rows.push(
        <Row key="start" label="Start position" htmlFor="gm-960">
          <Select
            id="gm-960"
            value={s.byNumber ? 'number' : 'random'}
            onChange={(v) => set('byNumber', v === 'number')}
            options={[
              { value: 'random', label: 'Random' },
              { value: 'number', label: 'By number' }
            ]}
          />
        </Row>
      )
      if (s.byNumber) {
        rows.push(
          <Row key="number" label="Number" htmlFor="gm-960-n">
            <input
              className="gm-input"
              id="gm-960-n"
              type="number"
              min={0}
              max={959}
              step={1}
              value={s.positionNumber}
              onChange={(e) => set('positionNumber', e.currentTarget.value)}
            />
          </Row>
        )
      }
    } else if (entry.family === 'chess') {
      // Every other chess-family spec takes a start FEN, so the two rows
      // travel together: the field only appears once the position is set to
      // come from one.
      rows.push(
        <Row key="pos" label="Position" htmlFor="gm-pos">
          <Select
            id="gm-pos"
            value={s.fromFen ? 'fen' : 'standard'}
            onChange={(v) => set('fromFen', v === 'fen')}
            options={[
              { value: 'standard', label: 'Standard' },
              { value: 'fen', label: 'From FEN' }
            ]}
          />
        </Row>
      )
      if (s.fromFen) {
        rows.push(
          <Row key="fen" label="FEN" htmlFor="gm-fen">
            <input
              className="gm-input is-wide"
              id="gm-fen"
              type="text"
              placeholder="paste a position"
              value={s.fen}
              onChange={(e) => set('fen', e.currentTarget.value)}
            />
          </Row>
        )
      }
    }

    if (entry.family === 'draughts') {
      rows.push(
        <Row key="board" label="Board" htmlFor="gm-draughts">
          <Select
            id="gm-draughts"
            value={s.draughtsKind}
            onChange={(v) => set('draughtsKind', v)}
            options={[
              { value: 'checkers', label: '8x8 American' },
              { value: 'checkers-intl', label: '10x10 International' }
            ]}
          />
        </Row>
      )
    }

    if (entry.kind === 'go') {
      rows.push(
        <Row key="size" label="Board size" htmlFor="gm-go-size">
          <Select
            id="gm-go-size"
            value={String(s.goSize)}
            onChange={(v) => set('goSize', Number(v) as GoSize)}
            options={GO_SIZES.map((g) => ({ value: String(g.value), label: g.label }))}
          />
        </Row>,
        <Row key="handicap" label="Handicap" htmlFor="gm-go-h">
          <Select
            id="gm-go-h"
            value={String(s.goHandicap)}
            onChange={(v) => {
              const h = Number(v) as GoHandicap
              // Handicap stones ARE the compensation, so komi drops to the
              // conventional half point the moment stones are placed.
              setS((prev) => ({ ...prev, goHandicap: h, goKomi: komiForHandicap(h) }))
            }}
            options={GO_HANDICAPS.map((h) => ({
              value: String(h),
              label: h === 0 ? 'Even' : String(h)
            }))}
          />
        </Row>,
        <Row key="komi" label="Komi" htmlFor="gm-go-komi">
          <input
            className="gm-input"
            id="gm-go-komi"
            type="number"
            min={-10}
            max={20}
            step={0.5}
            value={s.goKomi}
            onChange={(e) => set('goKomi', e.currentTarget.value)}
          />
        </Row>,
        <Row key="scoring" label="Scoring" htmlFor="gm-go-sc">
          <Select
            id="gm-go-sc"
            value={s.goScoring}
            onChange={(v) => set('goScoring', v as GoScoring)}
            options={[
              { value: 'area', label: 'Area' },
              { value: 'territory', label: 'Territory' }
            ]}
          />
        </Row>,
        <Row key="byo" label="Byo-yomi" htmlFor="gm-go-byo">
          <Select
            id="gm-go-byo"
            value={s.goByoId}
            onChange={(v) => set('goByoId', v)}
            options={BYOYOMI_PRESETS.map((p) => ({
              value: p.id,
              label: BYOYOMI_LABELS[p.id] ?? p.label
            }))}
          />
        </Row>
      )
    }

    if (entry.kind === 'gomoku') {
      rows.push(
        <Row key="gsize" label="Board size" htmlFor="gm-gomoku">
          <Select
            id="gm-gomoku"
            value={String(s.gomokuSize)}
            onChange={(v) => set('gomokuSize', Number(v))}
            options={GOMOKU_SIZES.map((n) => ({ value: String(n), label: `${n}x${n}` }))}
          />
        </Row>
      )
    }

    if (entry.kind === 'hex') {
      rows.push(
        <Row key="pie" label="Pie rule" htmlFor="gm-pie">
          <Select
            id="gm-pie"
            value={s.hexSwap ? 'on' : 'off'}
            onChange={(v) => set('hexSwap', v === 'on')}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' }
            ]}
          />
        </Row>
      )
    }

    return rows
  }

  const advanced = advancedRows()

  return (
    <>
      <button
        type="button"
        className="gm-scrim"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
      />

      <div
        className="gm-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gm-cfg-title"
      >
        <div className="gm-dlg-head">
          <span className="gm-dlg-art" aria-hidden>
            <span className="gm-art">
              <GmArt entry={entry} />
            </span>
          </span>
          <div>
            <h2 className="gm-dlg-title" id="gm-cfg-title">
              {entry.title}
            </h2>
            <p className="gm-dlg-note">{entry.tagline}</p>
          </div>
          <button className="gm-x" type="button" onClick={onClose}>
            <svg
              className="icon"
              aria-hidden
              viewBox="0 0 15 15"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
            >
              <path d="M3.8 3.8 11.2 11.2M11.2 3.8 3.8 11.2" />
            </svg>
            <span className="vh">Close</span>
          </button>
        </div>

        <div className="gm-dlg-body">
          {!isCreate && (
            <>
              <div className="gm-row">
                <span className="lbl" id="gm-mode-lbl">
                  Mode
                </span>
                <div className="segmented gm-ctl" role="group" aria-labelledby="gm-mode-lbl">
                  {MODES.map((m) => (
                    <button
                      key={m.value}
                      className="seg"
                      type="button"
                      aria-pressed={s.mode === m.value}
                      onClick={() => set('mode', m.value)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              {s.mode === 'bot' && (
                <Row label="Bot level" htmlFor="gm-level" note={levelHint}>
                  <Select
                    id="gm-level"
                    value={String(s.level)}
                    onChange={(v) => set('level', Number(v))}
                    options={BOT_LEVEL_NAMES.map((name, i) => ({
                      value: String(i + 1),
                      label: name
                    }))}
                  />
                </Row>
              )}

              {clock === 'go' ? (
                <Row label="Time" htmlFor="gm-tc">
                  <Select
                    id="gm-tc"
                    value={s.goMainId}
                    onChange={(v) => set('goMainId', v)}
                    options={GO_MAIN_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                  />
                </Row>
              ) : clock === 'online-owns-it' ? (
                <Row label="Time" note="Set on the online screen, with the opponent." />
              ) : (
                <Row label="Time" htmlFor="gm-tc">
                  <Select
                    id="gm-tc"
                    value={s.tcId}
                    onChange={(v) => set('tcId', v)}
                    options={TIME_CONTROLS.map((t) => ({ value: t.id, label: t.label }))}
                  />
                </Row>
              )}

              {entry.manualId !== 'custom-editor' && (
                <Row label="Manual">
                  <button type="button" className="btn is-quiet" onClick={onOpenManual}>
                    Read the rules
                  </button>
                </Row>
              )}
            </>
          )}

          {advanced.length > 0 && (
            <div className="gm-adv">
              <button
                className="gm-disc"
                type="button"
                aria-controls="gm-adv-panel"
                aria-expanded={advOpen}
                style={{ marginTop: 0 }}
                onClick={() => setAdvOpen((o) => !o)}
              >
                <svg className="icon" aria-hidden>
                  <use href="#i-chev" />
                </svg>
                <span className="gm-disc-shut">Advanced options</span>
                <span className="gm-disc-open">Hide advanced options</span>
              </button>
              <div className="gm-adv-panel" id="gm-adv-panel" hidden={!advOpen}>
                {advanced}
              </div>
            </div>
          )}

          {error && (
            <div className="gm-err" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="gm-dlg-foot">
          <button className="btn is-quiet" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn is-primary" type="button" onClick={start}>
            {isCreate ? 'Open the editor' : 'Start'}
          </button>
        </div>
      </div>
    </>
  )
}
