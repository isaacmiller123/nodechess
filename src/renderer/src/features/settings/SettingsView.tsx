import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Play } from 'lucide-react'
import { UserAvatar } from '../../components/Avatar'
import {
  useSettings,
  type AppTheme,
  type SoundTheme,
  ANALYSIS_MULTIPV_MIN,
  ANALYSIS_MULTIPV_MAX,
  ANALYSIS_DEPTH_MIN,
  ANALYSIS_DEPTH_MAX,
  PLAY_THINK_MS_MIN,
  PLAY_THINK_MS_MAX
} from '../../state/settings'
import { PIECE_SETS, getPieceSet, normalizePieceSet } from '../../board/pieceSets'
import { GAMES_ART_CREDITS } from '@shared/credits'
import { getSoundManager } from '../../sound'
import DatasetsPanel from './DatasetsPanel'
import UpdatesPanel from './UpdatesPanel'
import './settings.css'

/**
 * App theme previews. Keys map 1:1 to the `[data-theme='<key>']` palette blocks
 * in tokens.css ('light' = :root). The preview hexes mirror each palette's
 * bg/surface/accent/text. They are literal on purpose: a swatch must show a
 * palette that is NOT currently active, so it cannot read live custom props
 * (same exception as the board swatches below; noted in the tokens.css header).
 */
const APP_THEME_META: {
  key: AppTheme
  label: string
  bg: string
  surface: string
  accent: string
  text: string
}[] = [
  { key: 'light', label: 'Light', bg: '#ffffff', surface: '#eef0f3', accent: '#3893e8', text: '#1b1c1d' },
  { key: 'dark', label: 'Dark', bg: '#161512', surface: '#2e2b27', accent: '#3893e8', text: '#c8c6c1' },
  { key: 'midnight', label: 'Midnight', bg: '#08090c', surface: '#191c24', accent: '#4f9cf7', text: '#ccd2dd' },
  { key: 'forest', label: 'Forest', bg: '#151a16', surface: '#28312a', accent: '#81b64c', text: '#c9d2c9' },
  { key: 'ocean', label: 'Ocean', bg: '#0f151d', surface: '#22303f', accent: '#29b6cd', text: '#c6d3de' },
  { key: 'sepia', label: 'Sepia', bg: '#f5eedd', surface: '#eee4cf', accent: '#8a5f34', text: '#40331f' }
]

/** Selectable sound-effect packs. Keys map 1:1 to the SoundTheme union and to
 *  the sample folders under assets/sounds/ (see sound/SoundManager.ts). */
const SOUND_THEME_META: { key: SoundTheme; name: string; desc: string }[] = [
  { key: 'standard', name: 'Standard', desc: 'Lichess-style' },
  { key: 'classic', name: 'Classic', desc: 'Chess.com-style' },
  { key: 'real', name: 'Realistic', desc: 'wooden board' }
]

/** Selectable board square palettes. Keys map 1:1 to the `.board-<key>`
 *  wrapper classes in tokens.css (which expose `--sq-light` / `--sq-dark`). */
const BOARD_THEMES = [
  { key: 'brown', label: 'Brown', light: '#f0d9b5', dark: '#b58863' },
  { key: 'green', label: 'Green', light: '#eeeed2', dark: '#769656' },
  { key: 'blue', label: 'Blue', light: '#dee3e6', dark: '#8ca2ad' },
  { key: 'grey', label: 'Grey', light: '#d8d8d8', dark: '#8f8f8f' },
  { key: 'purple', label: 'Purple', light: '#e9e1f2', dark: '#9171b8' },
  { key: 'wood', label: 'Wood', light: '#e8c99b', dark: '#a16f43' },
  { key: 'slate', label: 'Slate', light: '#c7ccd2', dark: '#5d6b7a' },
  { key: 'ice', label: 'Ice', light: '#e4eef2', dark: '#7fa7b8' }
] as const

function Toggle({
  on,
  onChange,
  label,
  hint
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label className="setting-row">
      <span className="setting-label">
        <span>{label}</span>
        {hint && <span className="setting-sub">{hint}</span>}
      </span>
      <button
        className={`switch${on ? ' on' : ''}`}
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
      >
        <span className="switch-knob" />
      </button>
    </label>
  )
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  step = 1,
  hint,
  disabled = false,
  onChange,
  onCommit
}: {
  label: string
  value: number
  display: string
  min: number
  max: number
  step?: number
  hint?: string
  disabled?: boolean
  onChange: (v: number) => void
  /** Fired when the user releases the slider (pointer/keyboard), e.g. to play a preview. */
  onCommit?: () => void
}) {
  return (
    <div className="setting-row setting-slider">
      <span>{label}</span>
      <span className="setting-value" aria-hidden>
        {display}
      </span>
      <input
        className="range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={`${label}: ${display}`}
        aria-valuetext={display}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={(e) => {
          // Only keys that move the thumb commit; tabbing onto the slider shouldn't.
          if (/^(Arrow|Home$|End$|Page)/.test(e.key)) onCommit?.()
        }}
      />
      {hint && <p className="setting-hint">{hint}</p>}
    </div>
  )
}

// ---- Data / reset progress -------------------------------------------------

type ResetScope = 'school' | 'puzzles' | 'games'

const RESET_SCOPES: {
  scope: ResetScope
  title: string
  desc: string
  action: string
  confirm: string
}[] = [
  {
    scope: 'school',
    title: 'Reset School progress',
    desc: 'Chapters, lessons, tests, concept mastery, reviews, study streak, and placement. School returns to a first-run state.',
    action: 'Reset School…',
    confirm: 'Erase School progress'
  },
  {
    scope: 'puzzles',
    title: 'Reset Puzzles progress',
    desc: 'Puzzle history, Rush runs, Daily results, and review cards. Your puzzle rating returns to 1200.',
    action: 'Reset Puzzles…',
    confirm: 'Erase Puzzles progress'
  },
  {
    scope: 'games',
    title: 'Delete game history',
    desc: 'All saved games, their reviews, and the activity feed. Your bot rating returns to 1200.',
    action: 'Delete games…',
    confirm: 'Delete all games'
  }
]

type ResetPhase = 'idle' | 'armed' | 'busy' | 'done'

/** One destructive reset row with an inline two-step confirm (no window.confirm). */
function ResetRow({
  title,
  desc,
  action,
  confirm,
  available,
  onConfirm
}: {
  title: string
  desc: string
  action: string
  confirm: string
  available: boolean
  onConfirm: () => Promise<void>
}) {
  const [phase, setPhase] = useState<ResetPhase>('idle')
  const [error, setError] = useState<string | null>(null)

  // The "Erased" acknowledgement lingers, then the row returns to rest.
  useEffect(() => {
    if (phase !== 'done') return
    const t = window.setTimeout(() => setPhase('idle'), 4000)
    return () => window.clearTimeout(t)
  }, [phase])

  const busy = phase === 'busy'
  const run = () => {
    setPhase('busy')
    setError(null)
    onConfirm()
      .then(() => setPhase('done'))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        setPhase('armed')
      })
  }

  return (
    <div className={`data-reset${phase === 'armed' || busy ? ' is-armed' : ''}`}>
      <div className="data-reset-row">
        <span className="reset-copy">
          <strong>{title}</strong>
          <span>{desc}</span>
        </span>
        {phase === 'done' ? (
          <span className="data-reset-done" role="status">
            <Check size={14} aria-hidden /> Erased
          </span>
        ) : (
          <button
            type="button"
            className="btn danger"
            disabled={!available || phase !== 'idle'}
            onClick={() => {
              setError(null)
              setPhase('armed')
            }}
          >
            {action}
          </button>
        )}
      </div>

      {(phase === 'armed' || busy) && (
        <div className="data-reset-confirm">
          <p className="data-reset-warning">
            <AlertTriangle size={14} aria-hidden />
            This permanently erases the data described above. There is no undo.
          </p>
          <div className="data-reset-actions">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setPhase('idle')}>
              Cancel
            </button>
            <button type="button" className="btn danger solid" disabled={busy} onClick={run}>
              {busy ? 'Erasing…' : confirm}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="data-reset-error" role="alert">
          Reset failed: {error}
        </p>
      )}
    </div>
  )
}

// The depth slider exposes ANALYSIS_DEPTH_MIN..MAX plus one extra step at the top
// that maps to the 'max' sentinel (run to the engine ceiling).
const DEPTH_MAX_STEP = ANALYSIS_DEPTH_MAX + 1

export function SettingsView() {
  const { settings, update, resetDefaults } = useSettings()
  const fileRef = useRef<HTMLInputElement>(null)

  const depthIsMax = settings.analysisDepth === 'max'
  // Inline the check so TS narrows analysisDepth to `number` in the else branch.
  const depthSliderValue = settings.analysisDepth === 'max' ? DEPTH_MAX_STEP : settings.analysisDepth
  const depthDisplay = depthIsMax ? 'Max' : String(settings.analysisDepth)
  const onDepthChange = (v: number) => update({ analysisDepth: v >= DEPTH_MAX_STEP ? 'max' : v })

  const onPickAvatar = (file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => update({ avatar: String(reader.result) })
    reader.readAsDataURL(file)
  }

  // Sound: keep the live manager in step so the slider/toggle are audible
  // immediately (useSound consumers re-sync on their own renders too).
  const onSoundToggle = (v: boolean) => {
    update({ sound: v })
    getSoundManager().setEnabled(v)
  }
  const onVolumeChange = (v: number) => {
    update({ soundVolume: v })
    getSoundManager().setVolume(v)
  }
  const previewVolume = () => {
    if (settings.sound) getSoundManager().play('move')
  }
  const onSoundTheme = (v: SoundTheme) => {
    update({ soundTheme: v })
    const manager = getSoundManager()
    manager.setTheme(v)
    // A one-note taste of the new pack (the ▶ button gives the full preview).
    if (settings.sound) void manager.previewTheme(v, ['move'])
  }
  const previewSoundTheme = (v: SoundTheme) => {
    if (settings.sound) void getSoundManager().previewTheme(v)
  }

  const resetApi = typeof window !== 'undefined' ? window.api?.app?.resetProgress : undefined
  const resetScope = (scope: ResetScope): Promise<void> => {
    if (!resetApi) return Promise.reject(new Error('available in the desktop app only'))
    return resetApi({ scopes: [scope] }).then(() => undefined)
  }

  return (
    <div className="settings-view">
      <section className="card settings-card">
        <h2>Profile</h2>
        <div className="profile-edit">
          <UserAvatar src={settings.avatar} name={settings.username} size={72} />
          <div className="profile-fields">
            <label className="field">
              <span>Username</span>
              <input
                className="text-input"
                value={settings.username}
                maxLength={24}
                onChange={(e) => update({ username: e.target.value || 'User' })}
              />
            </label>
            <div className="avatar-actions">
              <button className="btn" onClick={() => fileRef.current?.click()}>
                Change picture
              </button>
              {settings.avatar && (
                <button className="btn ghost" onClick={() => update({ avatar: null })}>
                  Remove
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => onPickAvatar(e.target.files?.[0])}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="card settings-card">
        <h2>Appearance</h2>
        <div className="setting-row setting-themes">
          <span>Theme</span>
          <div className="theme-swatches" role="group" aria-label="App theme">
            {APP_THEME_META.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`theme-swatch${settings.theme === t.key ? ' on' : ''}`}
                aria-pressed={settings.theme === t.key}
                title={t.label}
                onClick={() => update({ theme: t.key })}
              >
                <span className="theme-chip" style={{ background: t.bg }} aria-hidden>
                  <span className="theme-chip-bar" style={{ background: t.surface }}>
                    <span className="theme-chip-text" style={{ background: t.text }} />
                    <span className="theme-chip-text short" style={{ background: t.text }} />
                  </span>
                  <span className="theme-chip-accent" style={{ background: t.accent }} />
                </span>
                <span className="theme-swatch-name">{t.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <span>Board theme</span>
          <div className="board-swatches">
            {BOARD_THEMES.map((b) => (
              <button
                key={b.key}
                className={`swatch${settings.boardTheme === b.key ? ' on' : ''}`}
                title={b.label}
                onClick={() => update({ boardTheme: b.key })}
              >
                <span className="swatch-grid">
                  <span style={{ background: b.light }} />
                  <span style={{ background: b.dark }} />
                  <span style={{ background: b.dark }} />
                  <span style={{ background: b.light }} />
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <span>Pieces</span>
          <div className="segmented">
            {PIECE_SETS.map((p) => (
              <button
                key={p.id}
                className={`seg${settings.pieceSet === p.id ? ' on' : ''}`}
                onClick={() => update({ pieceSet: normalizePieceSet(p.id) })}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row setting-caption">
          <span className="muted small">
            {getPieceSet(settings.pieceSet).author} · {getPieceSet(settings.pieceSet).license}
          </span>
        </div>
        <Toggle
          label="Board coordinates"
          on={settings.coordinates}
          onChange={(v) => update({ coordinates: v })}
        />
        <Toggle
          label="Piece animation"
          on={settings.animation}
          onChange={(v) => update({ animation: v })}
        />
      </section>

      <section className="card settings-card">
        <h2>Gameplay</h2>
        <Toggle
          label="Auto-queen"
          hint="Promote pawns straight to a queen, skipping the piece picker."
          on={settings.autoQueen}
          onChange={(v) => update({ autoQueen: v })}
        />
        <Toggle
          label="Confirm resign"
          hint="Ask before resigning a game."
          on={settings.confirmResign}
          onChange={(v) => update({ confirmResign: v })}
        />
        <Toggle
          label="Low-time warning"
          hint="Sound an alert when your clock runs low in timed games."
          on={settings.lowTimeWarning}
          onChange={(v) => update({ lowTimeWarning: v })}
        />
        <Slider
          label="Play move time"
          value={settings.playThinkMs}
          display={`${settings.playThinkMs} ms`}
          min={PLAY_THINK_MS_MIN}
          max={PLAY_THINK_MS_MAX}
          step={50}
          hint="Thinking time the engine spends per move in casual Play."
          onChange={(v) => update({ playThinkMs: v })}
        />
      </section>

      <section className="card settings-card">
        <h2>Assistance</h2>
        <Toggle
          label="Show legal move dots"
          on={settings.showLegal}
          onChange={(v) => update({ showLegal: v })}
        />
        <Toggle
          label="Hints"
          hint="Show hint buttons in School, Puzzles, and Play. Turn off for a harder ride."
          on={settings.hintsEnabled}
          onChange={(v) => update({ hintsEnabled: v })}
        />
        <Toggle
          label="Engine arrows"
          hint="Draw the engine's suggested moves on the Analysis board."
          on={settings.showEngineArrows}
          onChange={(v) => update({ showEngineArrows: v })}
        />
        <Toggle
          label="Evaluation bar"
          hint="Show the advantage bar beside analysis boards."
          on={settings.showEvalBar}
          onChange={(v) => update({ showEvalBar: v })}
        />
      </section>

      <section className="card settings-card">
        <h2>Engine &amp; analysis</h2>
        <Slider
          label="Candidate lines"
          value={settings.analysisMultiPV}
          display={String(settings.analysisMultiPV)}
          min={ANALYSIS_MULTIPV_MIN}
          max={ANALYSIS_MULTIPV_MAX}
          hint="How many alternative engine lines to show in Analysis."
          onChange={(v) => update({ analysisMultiPV: v })}
        />
        <Slider
          label="Analysis depth"
          value={depthSliderValue}
          display={depthDisplay}
          min={ANALYSIS_DEPTH_MIN}
          max={DEPTH_MAX_STEP}
          hint="Higher depth is stronger but slower. Max runs to the engine's ceiling."
          onChange={onDepthChange}
        />
      </section>

      <section className="card settings-card">
        <h2>Sound</h2>
        <Toggle label="Sound effects" on={settings.sound} onChange={onSoundToggle} />
        <div className="setting-row sound-theme-row">
          <span>Sound theme</span>
          <div className="sound-theme-list" role="radiogroup" aria-label="Sound theme">
            {SOUND_THEME_META.map((t) => {
              const on = settings.soundTheme === t.key
              return (
                <div key={t.key} className={`sound-theme-option${on ? ' on' : ''}`}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className="sound-theme-pick"
                    onClick={() => onSoundTheme(t.key)}
                  >
                    <span className="sound-theme-dot" aria-hidden />
                    <span className="sound-theme-name">{t.name}</span>
                    <span className="sound-theme-desc">{t.desc}</span>
                  </button>
                  <button
                    type="button"
                    className="sound-theme-preview"
                    title={`Preview ${t.name} sounds`}
                    aria-label={`Preview ${t.name} sounds`}
                    disabled={!settings.sound}
                    onClick={() => previewSoundTheme(t.key)}
                  >
                    <Play size={12} aria-hidden />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
        <Slider
          label="Volume"
          value={settings.soundVolume}
          display={`${Math.round(settings.soundVolume * 100)}%`}
          min={0}
          max={1}
          step={0.05}
          disabled={!settings.sound}
          onChange={onVolumeChange}
          onCommit={previewVolume}
        />
      </section>

      <DatasetsPanel />

      <UpdatesPanel />

      <section className="card settings-card">
        <h2>Data</h2>
        <div className="settings-reset-row">
          <span className="reset-copy">
            <strong>Reset settings to defaults</strong>
            <span>Restores appearance, gameplay, and engine preferences. Your profile is kept.</span>
          </span>
          <button type="button" className="btn ghost" onClick={resetDefaults}>
            Reset to defaults
          </button>
        </div>

        <div className="data-reset-list">
          {RESET_SCOPES.map((r) => (
            <ResetRow
              key={r.scope}
              title={r.title}
              desc={r.desc}
              action={r.action}
              confirm={r.confirm}
              available={!!resetApi}
              onConfirm={() => resetScope(r.scope)}
            />
          ))}
          {!resetApi && (
            <p className="muted small">Progress resets are available in the desktop app.</p>
          )}
        </div>
      </section>

      {/* CC-BY art REQUIRES user-facing attribution (docs/CREDITS.md is the
          full ledger; this list mirrors src/shared/credits.ts). */}
      <section className="card settings-card">
        <h2>Art credits</h2>
        <ul className="settings-credits">
          {GAMES_ART_CREDITS.map((c) => (
            <li key={c.asset} className="muted small">
              {c.asset} · {c.author} ({c.license}) ·{' '}
              <span className="settings-credit-url">{c.url}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
