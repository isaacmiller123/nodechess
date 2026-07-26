// SETTINGS, from design-lab/v1/settings.html.
//
// The mock draws four sections: Appearance, Gameplay, Assistance, Engine and
// analysis. They are here in that order, with that copy, built out of the
// .set-row vocabulary in controls.tsx. What the mock could not draw, because a
// static page has no engine to fetch and no progress to erase, follows them in
// the same vocabulary: Sound, Profile, Datasets, Updates, Data, Credits.
//
// Every number the mock invented is replaced by the real one or by nothing.
// The Appearance head reads "cold iron and bone, cburnett" because that is
// what is running; the Engine head says whether Stockfish is actually on this
// machine rather than repeating the mock's "stockfish 16, bundled", which was
// wrong about both the version and the delivery.

import { useEffect, useRef, useState, type JSX } from 'react'
import { UserAvatar } from '../../components/Avatar'
import { useReadoutSlot } from '../../components/Layout'
import { ALL_RELEASES_URL, detectPlatform, offerFor } from '../landing/downloads'
import {
  useSettings,
  PALETTES,
  ANALYSIS_MULTIPV_MIN,
  ANALYSIS_MULTIPV_MAX,
  ANALYSIS_DEPTH_MIN,
  ANALYSIS_DEPTH_MAX,
  PLAY_THINK_MS_MIN,
  PLAY_THINK_MS_MAX,
  type AppPalette,
  type SoundTheme
} from '../../state/settings'
import { PIECE_SETS, getPieceSet, normalizePieceSet } from '../../board/pieceSets'
import { GAMES_ART_CREDITS } from '@shared/credits'
import { getSoundManager } from '../../sound'
import { useEngineReady } from '../../hooks/useEngineReady'
import { isWebBuild } from '../../platform'
import DatasetsPanel from './DatasetsPanel'
import UpdatesPanel from './UpdatesPanel'
import { Sec, SetRow, SetSegmented, SetSlider, SetSwitch, type SegOption } from './controls'
import './settings.css'

/** What each palette is FOR. A 46px chip cannot say "near monochrome,
 *  everything carried by value", so v1 writes a line under each one. The ids
 *  and the names come from state/settings.tsx; these are the notes. */
const PALETTE_NOTES: Record<AppPalette, string> = {
  'cold-iron-bone':
    'Near monochrome. The default: everything is carried by value, and the only hue on screen is a status colour.',
  'cold-graphite-oxblood': 'Cold blue grey neutrals under a deep wine accent.',
  'warm-ash-slate-blue': 'Warm grey neutrals under a cool dusty blue.',
  'cool-steel-deep-teal': 'Cold steel neutrals under a teal signal.',
  'warm-umber-sage': 'Genuinely warm brown under a muted sage green.',
  'green-slate-plum': 'Green tinted grey under a desaturated plum.',
  'blue-ink-straw': 'Indigo tinted neutrals under a pale straw yellow.',
  'warm-putty-dusty-rose': 'Warm putty grey under a light dusty rose.'
}

/** Selectable sound-effect packs. Keys map 1:1 to the SoundTheme union and to
 *  the sample folders under assets/sounds/ (see sound/SoundManager.ts). */
const SOUND_PACKS: { key: SoundTheme; name: string }[] = [
  { key: 'standard', name: 'Standard' },
  { key: 'classic', name: 'Classic' },
  { key: 'real', name: 'Realistic' }
]

// The depth slider exposes ANALYSIS_DEPTH_MIN..MAX plus one extra step at the
// top that maps to the 'max' sentinel (run to the engine ceiling).
const DEPTH_MAX_STEP = ANALYSIS_DEPTH_MAX + 1

const MULTIPV_OPTIONS: SegOption<number>[] = Array.from(
  { length: ANALYSIS_MULTIPV_MAX - ANALYSIS_MULTIPV_MIN + 1 },
  (_, i) => {
    const n = ANALYSIS_MULTIPV_MIN + i
    return { value: n, label: String(n) }
  }
)

const PIECE_OPTIONS: SegOption<string>[] = PIECE_SETS.map((p) => ({ value: p.id, label: p.label }))

const SOUND_OPTIONS: SegOption<SoundTheme>[] = SOUND_PACKS.map((p) => ({
  value: p.key,
  label: p.name
}))

/** 'GPLv2+' is how the registry spells it and 'GPLv2 or later' is how a credit
 *  line reads. One rule, no second copy of the licence table. */
function licenceWords(license: string): string {
  return license.endsWith('+') ? `${license.slice(0, -1)} or later` : license
}

// ---- Data / reset progress -------------------------------------------------

type ResetScope = 'school' | 'puzzles' | 'games'

/** The three scoped erases. Each description is what main actually wipes for
 *  that scope (src/main/ipc/maintenance.ipc.ts), not a summary of it. */
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
}): JSX.Element {
  const [phase, setPhase] = useState<ResetPhase>('idle')
  const [error, setError] = useState<string | null>(null)

  // The "Erased" acknowledgement lingers, then the row returns to rest.
  useEffect(() => {
    if (phase !== 'done') return
    const t = window.setTimeout(() => setPhase('idle'), 4000)
    return () => window.clearTimeout(t)
  }, [phase])

  const busy = phase === 'busy'
  const run = (): void => {
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
    <>
      <SetRow name={title} sub={desc}>
        {phase === 'done' ? (
          <span className="set-state is-on" role="status">
            Erased
          </span>
        ) : (
          <button
            type="button"
            className="btn is-quiet"
            disabled={!available || phase !== 'idle'}
            onClick={() => {
              setError(null)
              setPhase('armed')
            }}
          >
            {action}
          </button>
        )}
      </SetRow>

      {(phase === 'armed' || busy) && (
        <div className="set-row is-stack set-confirm">
          <span>
            <span className="set-sub">
              This permanently erases the data described above. There is no undo.
            </span>
          </span>
          <div className="set-actions">
            <button
              type="button"
              className="btn is-quiet"
              disabled={busy}
              onClick={() => setPhase('idle')}
            >
              Cancel
            </button>
            <button type="button" className="btn set-danger" disabled={busy} onClick={run}>
              {busy ? 'Erasing…' : confirm}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="set-row is-stack">
          <span>
            <span className="set-sub set-error" role="alert">
              Reset failed: {error}
            </span>
          </span>
        </div>
      )}
    </>
  )
}

export function SettingsView(): JSX.Element {
  /* Read once: the visitor's platform does not change while they read. */
  const leadOffer = offerFor(detectPlatform())
  const { settings, update, resetDefaults } = useSettings()
  const fileRef = useRef<HTMLInputElement>(null)
  const { ready: engineReady, recheck: recheckEngine } = useEngineReady()
  // The engine's real name, from the dataset manifest main serves, so this
  // screen is not a third place that hard codes a version number.
  const [engineLabel, setEngineLabel] = useState<string | null>(null)

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api?.datasets : undefined
    if (!api) return
    let cancelled = false
    api
      .items()
      .then((r) => {
        if (!cancelled) setEngineLabel(r.items.find((i) => i.key === 'engine')?.label ?? null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const pieceSet = getPieceSet(settings.pieceSet)
  const palette = PALETTES.find((p) => p.id === settings.palette) ?? PALETTES[0]

  // v1's head reads "cold iron and bone, cburnett": what you are running, in
  // the palette's own words plus the piece set's id.
  const appearanceCount = `${palette.label.toLowerCase().replace(', ', ' and ')}, ${settings.pieceSet}`

  // v1 wrote "stockfish 16, bundled". Both halves were wrong: it is Stockfish
  // 18, and it is deliberately NOT bundled (docs/DATASETS.md): it arrives
  // through Datasets below. So this reports presence instead of claiming it,
  // and says nothing at all where it cannot check.
  const engineName = engineLabel ? engineLabel.replace(/\s+engine$/i, '').toLowerCase() : null
  const engineCount =
    isWebBuild || engineReady === null
      ? ''
      : engineReady
        ? `${engineName ?? 'engine'}, installed`
        : `${engineName ?? 'engine'}, not installed`

  const depthIsMax = settings.analysisDepth === 'max'
  // Inline the check so TS narrows analysisDepth to `number` in the else branch.
  const depthSliderValue = settings.analysisDepth === 'max' ? DEPTH_MAX_STEP : settings.analysisDepth
  const depthDisplay = depthIsMax ? 'Max' : `${settings.analysisDepth} ply`
  const onDepthChange = (v: number): void =>
    update({ analysisDepth: v >= DEPTH_MAX_STEP ? 'max' : v })

  const onPickAvatar = (file: File | undefined): void => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => update({ avatar: String(reader.result) })
    reader.readAsDataURL(file)
  }

  // Sound: keep the live manager in step so the slider and the switch are
  // audible immediately (useSound consumers re-sync on their own renders too).
  const onSoundToggle = (v: boolean): void => {
    update({ sound: v })
    getSoundManager().setEnabled(v)
  }
  const onVolumeChange = (v: number): void => {
    update({ soundVolume: v })
    getSoundManager().setVolume(v)
  }
  const previewVolume = (): void => {
    if (settings.sound) getSoundManager().play('move')
  }
  const onSoundPack = (v: SoundTheme): void => {
    update({ soundTheme: v })
    const manager = getSoundManager()
    manager.setTheme(v)
    // A one-note taste of the new pack; the row below plays the full sample.
    if (settings.sound) void manager.previewTheme(v, ['move'])
  }

  const resetApi = typeof window !== 'undefined' ? window.api?.app?.resetProgress : undefined
  const resetScope = (scope: ResetScope): Promise<void> => {
    if (!resetApi) return Promise.reject(new Error('available in the desktop app only'))
    return resetApi({ scopes: [scope] }).then(() => undefined)
  }

  // The one thing to do next FROM HERE, and only when it is true: the engine
  // is genuinely absent and the download that fixes it is on this screen.
  useReadoutSlot(
    !isWebBuild && engineReady === false ? 'Import datasets to turn the engine on' : null,
    null
  )

  return (
    <div className="set-page col-single">
      {/* ================= GET THE APP =================
          WEB ONLY, and it exists because the landing page shows once. Before
          this, the only route to a download in the whole product was a visitor's
          FIRST EVER page load: come back a second time and there was no way to
          get the desktop build at all. Settings is where someone looks for it,
          so it lives here permanently and the landing page is now the shortcut
          rather than the only door.
          On desktop this is hidden: you are already in the thing it offers. */}
      {isWebBuild && (
        <Sec label="Get the app" count={leadOffer.name}>
          <div className="panel">
            <SetRow
              name="Desktop app"
              sub="The full engine and the whole puzzle library on your own disk, so it keeps working with no connection at all."
            >
              {leadOffer.href ? (
                <a className="btn is-primary" href={leadOffer.href}>
                  Download{leadOffer.size ? ` (${leadOffer.size})` : ''}
                </a>
              ) : (
                <span className="fact-note">{leadOffer.note}</span>
              )}
            </SetRow>
            <SetRow name="Other platforms" sub="Every build, including the one for a machine you are not sitting at.">
              <a className="btn" href={ALL_RELEASES_URL}>
                All downloads
              </a>
            </SetRow>
          </div>
        </Sec>
      )}

      {/* ================= APPEARANCE ================= */}
      <Sec label="Appearance" count={appearanceCount}>
        <div className="panel">
          <SetRow
            name="Palette"
            sub="Eight dark sets. Chrome colour only: the layout never moves and the board never changes."
            stack
          >
            <div className="set-pals" role="group" aria-label="Palette">
              {PALETTES.map((p) => (
                <button
                  key={p.id}
                  className="set-sw"
                  type="button"
                  data-pal={p.id}
                  aria-pressed={settings.palette === p.id}
                  onClick={() => update({ palette: p.id })}
                >
                  <span className="set-chip" data-palette={p.id} aria-hidden>
                    <span className="set-chip-accent" />
                    <span className="set-chip-bar">
                      <span className="set-chip-line" />
                      <span className="set-chip-line is-short" />
                    </span>
                  </span>
                  <span className="set-sw-name">{p.label}</span>
                  <span className="set-sw-note">{PALETTE_NOTES[p.id]}</span>
                </button>
              ))}
            </div>
          </SetRow>

          <SetRow
            name="Piece set"
            credit={`${pieceSet.author}, ${licenceWords(pieceSet.license)}`}
            stack
          >
            <SetSegmented
              label="Piece set"
              options={PIECE_OPTIONS}
              value={settings.pieceSet}
              scroll
              onChange={(id) => update({ pieceSet: normalizePieceSet(id) })}
            />
          </SetRow>

          <SetRow name="Board coordinates" sub="Files and ranks along the board edge.">
            <SetSwitch
              label="Board coordinates"
              on={settings.coordinates}
              onChange={(v) => update({ coordinates: v })}
            />
          </SetRow>

          <SetRow name="Piece animation" sub="Pieces slide to the square. Off means they cut.">
            <SetSwitch
              label="Piece animation"
              on={settings.animation}
              onChange={(v) => update({ animation: v })}
            />
          </SetRow>
        </div>
      </Sec>

      {/* ================= GAMEPLAY ================= */}
      <Sec label="Gameplay">
        <div className="panel">
          <SetRow name="Auto-queen" sub="Promote straight to a queen, no picker.">
            <SetSwitch
              label="Auto-queen"
              on={settings.autoQueen}
              onChange={(v) => update({ autoQueen: v })}
            />
          </SetRow>

          <SetRow name="Confirm resign" sub="Ask before a game is given up.">
            <SetSwitch
              label="Confirm resign"
              on={settings.confirmResign}
              onChange={(v) => update({ confirmResign: v })}
            />
          </SetRow>

          <SetRow name="Low-time warning" sub="A tick when the clock runs down in timed games.">
            <SetSwitch
              label="Low-time warning"
              on={settings.lowTimeWarning}
              onChange={(v) => update({ lowTimeWarning: v })}
            />
          </SetRow>

          {/* v1 has no row for takebacks and the pre-rebuild screen had none
              either, so allowTakebacks was a preference nobody could reach.
              Play reads it, so it gets the row it never had. */}
          <SetRow name="Allow takebacks" sub="Let a takeback be asked for and given in Play.">
            <SetSwitch
              label="Allow takebacks"
              on={settings.allowTakebacks}
              onChange={(v) => update({ allowTakebacks: v })}
            />
          </SetRow>

          <SetSlider
            name="Bot move time"
            sub="How long a bot takes over each move in casual play."
            value={settings.playThinkMs}
            min={PLAY_THINK_MS_MIN}
            max={PLAY_THINK_MS_MAX}
            step={50}
            display={`${settings.playThinkMs} ms`}
            ticks={['100 ms', '3000 ms']}
            onChange={(v) => update({ playThinkMs: v })}
          />
        </div>
      </Sec>

      {/* ================= ASSISTANCE ================= */}
      <Sec label="Assistance">
        <div className="panel">
          <SetRow name="Legal move dots" sub="Mark the squares a lifted piece can reach.">
            <SetSwitch
              label="Legal move dots"
              on={settings.showLegal}
              onChange={(v) => update({ showLegal: v })}
            />
          </SetRow>

          <SetRow name="Hints" sub="Hint buttons in School, Puzzles and Play. Off for a harder ride.">
            <SetSwitch
              label="Hints"
              on={settings.hintsEnabled}
              onChange={(v) => update({ hintsEnabled: v })}
            />
          </SetRow>

          <SetRow name="Engine arrows" sub="Draw the engine's suggestions on the analysis board.">
            <SetSwitch
              label="Engine arrows"
              on={settings.showEngineArrows}
              onChange={(v) => update({ showEngineArrows: v })}
            />
          </SetRow>

          <SetRow name="Evaluation bar" sub="The advantage bar beside analysis boards.">
            <SetSwitch
              label="Evaluation bar"
              on={settings.showEvalBar}
              onChange={(v) => update({ showEvalBar: v })}
            />
          </SetRow>
        </div>
      </Sec>

      {/* ================= ENGINE AND ANALYSIS ================= */}
      <Sec label="Engine and analysis" count={engineCount}>
        <div className="panel">
          <SetRow name="Candidate lines" sub="Alternatives shown beside the best move." wrap>
            <SetSegmented
              label="Candidate lines"
              options={MULTIPV_OPTIONS}
              value={settings.analysisMultiPV}
              onChange={(v) => update({ analysisMultiPV: v })}
            />
          </SetRow>

          <SetSlider
            name="Depth"
            sub="Deeper is stronger and slower. Max runs to the engine's ceiling."
            value={depthSliderValue}
            min={ANALYSIS_DEPTH_MIN}
            max={DEPTH_MAX_STEP}
            display={depthDisplay}
            ticks={[String(ANALYSIS_DEPTH_MIN), 'Max']}
            onChange={onDepthChange}
          />
        </div>
      </Sec>

      {/* ================= SOUND =================
          Real, and the mock never drew it. */}
      <Sec
        label="Sound"
        count={settings.sound ? (SOUND_PACKS.find((p) => p.key === settings.soundTheme)?.name.toLowerCase() ?? '') : 'off'}
      >
        <div className="panel">
          <SetRow name="Sound effects" sub="Moves, captures, checks and the clock.">
            <SetSwitch label="Sound effects" on={settings.sound} onChange={onSoundToggle} />
          </SetRow>

          <SetRow
            name="Sound pack"
            sub="Standard is Lichess-style, Classic is Chess.com-style, Realistic is a wooden board."
            stack
            off={!settings.sound}
          >
            <SetSegmented
              label="Sound pack"
              options={SOUND_OPTIONS}
              value={settings.soundTheme}
              scroll
              onChange={onSoundPack}
            />
          </SetRow>

          <SetRow name="Preview" sub="Play a few moves from the chosen pack." off={!settings.sound}>
            <button
              type="button"
              className="btn is-quiet"
              disabled={!settings.sound}
              onClick={() => void getSoundManager().previewTheme(settings.soundTheme)}
            >
              Play sample
            </button>
          </SetRow>

          <SetSlider
            name="Volume"
            sub="How loud the pack plays."
            value={settings.soundVolume}
            min={0}
            max={1}
            step={0.05}
            display={`${Math.round(settings.soundVolume * 100)}%`}
            ticks={['0%', '100%']}
            disabled={!settings.sound}
            onChange={onVolumeChange}
            onCommit={previewVolume}
          />
        </div>
      </Sec>

      {/* ================= PROFILE =================
          v1 keeps identity on the account page, which owns the handle. This is
          the OTHER name: what you are called on a local board, with a picture
          to go beside it. Neither has a home in the mock. */}
      <Sec label="Profile" count={settings.username}>
        <div className="panel">
          <SetRow name="Name" sub="What you are called on a local board and in saved games.">
            <input
              className="filter-input set-text"
              value={settings.username}
              maxLength={24}
              aria-label="Name"
              onChange={(e) => update({ username: e.target.value || 'User' })}
            />
          </SetRow>

          <SetRow name="Picture" sub="Shown beside your name while you play.">
            <span className="set-actions">
              <UserAvatar src={settings.avatar} name={settings.username} size={32} />
              <button type="button" className="btn is-quiet" onClick={() => fileRef.current?.click()}>
                Change picture
              </button>
              {settings.avatar && (
                <button type="button" className="btn is-quiet" onClick={() => update({ avatar: null })}>
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
            </span>
          </SetRow>
        </div>
      </Sec>

      {/* The engine and the puzzle database arrive here, so a finished import
          is what makes the Engine head above say "installed". */}
      <DatasetsPanel onInstalled={recheckEngine} />

      <UpdatesPanel />

      {/* ================= DATA ================= */}
      <Sec label="Data">
        <div className="panel">
          <SetRow
            name="Reset settings to defaults"
            sub="Restores appearance, gameplay, and engine preferences. Your profile is kept."
          >
            <button type="button" className="btn is-quiet" onClick={resetDefaults}>
              Reset to defaults
            </button>
          </SetRow>

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
            <SetRow sub="Progress resets are available in the desktop app." />
          )}
        </div>
      </Sec>

      {/* ================= CREDITS =================
          CC-BY art REQUIRES user-facing attribution, so this list is an
          obligation rather than a decision (docs/CREDITS.md is the full
          ledger; this mirrors src/shared/credits.ts). v1's only credit surface
          is the one line under Piece set, which covers pieces and not the
          board-game art. */}
      <Sec label="Credits" count={`${GAMES_ART_CREDITS.length} art packs`}>
        <div className="panel">
          <div className="facts">
            {GAMES_ART_CREDITS.map((c) => (
              <div className="fact" key={c.asset}>
                <span>
                  <span className="set-name">{c.asset}</span>
                  <span className="set-credit">{c.url}</span>
                </span>
                <span className="fact-value">
                  {c.author}
                  <span className="fact-note">{c.license}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </Sec>
    </div>
  )
}
