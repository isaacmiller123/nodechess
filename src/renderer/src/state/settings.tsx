import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { DEFAULT_PIECE_SET, normalizePieceSet, type PieceSetId } from '../board/pieceSets'

export type BoardTheme = 'brown' | 'green' | 'blue' | 'grey' | 'purple' | 'wood' | 'slate' | 'ice'

/** The eight chrome palettes, from design-lab/v1. 'cold-iron-bone' is the
 *  default and is declared on `:root` in styles/tokens.css, so it is the one id
 *  that CLEARS `data-palette` rather than setting it; the other seven are
 *  `[data-palette='<id>']` blocks in styles/palettes.css. There is no light
 *  mode: :root is the dark palette and always was.
 *
 *  A palette is chrome colour only. No block redeclares --sq-light, --sq-dark,
 *  --sq-mark, --piece-white or --piece-black, so switching palettes cannot
 *  repaint a single board pixel. That is enforced by the stylesheets, not by
 *  convention, and re-adding a board token to one of those blocks is a
 *  regression. */
export const PALETTES = [
  { id: 'cold-iron-bone', label: 'Cold iron, bone' },
  { id: 'cold-graphite-oxblood', label: 'Cold graphite, oxblood' },
  { id: 'warm-ash-slate-blue', label: 'Warm ash, slate blue' },
  { id: 'cool-steel-deep-teal', label: 'Cool steel, deep teal' },
  { id: 'warm-umber-sage', label: 'Warm umber, sage' },
  { id: 'green-slate-plum', label: 'Green slate, plum' },
  { id: 'blue-ink-straw', label: 'Blue ink, straw' },
  { id: 'warm-putty-dusty-rose', label: 'Warm putty, dusty rose' }
] as const
export type AppPalette = (typeof PALETTES)[number]['id']
export const DEFAULT_PALETTE: AppPalette = 'cold-iron-bone'
const PALETTE_IDS: readonly string[] = PALETTES.map((p) => p.id)

/** Analysis search depth: a fixed ply count, or 'max' (let the engine run to its ceiling). */
export type AnalysisDepth = number | 'max'

/** Inclusive bounds for the multi-PV (number of candidate lines) preference. */
export const ANALYSIS_MULTIPV_MIN = 1
export const ANALYSIS_MULTIPV_MAX = 5

/** Inclusive bounds for the fixed analysis depth (before the 'max' sentinel). */
export const ANALYSIS_DEPTH_MIN = 18
export const ANALYSIS_DEPTH_MAX = 30

/** Inclusive bounds (ms) for the casual-play engine move time. */
export const PLAY_THINK_MS_MIN = 100
export const PLAY_THINK_MS_MAX = 3000

/** Sound-effect packs: synthesized 'standard', retro 'classic', or recorded 'real' board sounds. */
export const SOUND_THEMES = ['standard', 'classic', 'real'] as const
export type SoundTheme = (typeof SOUND_THEMES)[number]

export interface AppSettings {
  palette: AppPalette
  boardTheme: BoardTheme
  pieceSet: PieceSetId
  showLegal: boolean
  coordinates: boolean
  animation: boolean
  sound: boolean
  /** Master sound-effect volume, 0..1. */
  soundVolume: number
  /** Which sound-effect pack plays for moves/captures/etc. */
  soundTheme: SoundTheme
  /** Allow takeback (undo) requests during Play. */
  allowTakebacks: boolean
  /** Promote straight to a queen without showing the piece picker. */
  autoQueen: boolean
  /** Ask before resigning a game in Play. */
  confirmResign: boolean
  /** Play the ticking warning when a clock runs low in timed Play. */
  lowTimeWarning: boolean
  /** Show hint buttons (School/Puzzles/Play coaching). Off for a harder game. */
  hintsEnabled: boolean
  /** Draw the engine's best-move arrows on the Analysis board. */
  showEngineArrows: boolean
  /** Show the evaluation bar beside analysis boards. */
  showEvalBar: boolean
  username: string
  avatar: string | null // data URL
  /** Candidate lines to request from the analysis engine (1–5). */
  analysisMultiPV: number
  /** Fixed analysis search depth in plies, or 'max' to run to the engine ceiling. */
  analysisDepth: AnalysisDepth
  /** Engine move time (ms) for casual Play vs the engine. */
  playThinkMs: number
  /** Per-game 3D board preference (Games library): kind → true = 3D table on. */
  board3d: Record<string, boolean>
}

const DEFAULTS: AppSettings = {
  palette: DEFAULT_PALETTE,
  boardTheme: 'brown',
  pieceSet: DEFAULT_PIECE_SET,
  showLegal: true,
  coordinates: true,
  animation: true,
  sound: true,
  soundVolume: 0.7,
  soundTheme: 'standard',
  allowTakebacks: true,
  autoQueen: false,
  confirmResign: true,
  lowTimeWarning: true,
  hintsEnabled: true,
  showEngineArrows: true,
  showEvalBar: true,
  username: 'User',
  avatar: null,
  analysisMultiPV: 3,
  analysisDepth: 22,
  playThinkMs: 600,
  board3d: {}
}

const KEY = 'oct.settings.v1'

/** Clamp + round a possibly-stale numeric pref; falls back to `fallback` for non-finite input. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Clamp a possibly-stale fractional pref (no rounding; used for 0..1 volume). */
function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Coerce a stored flag to a real boolean; anything non-boolean falls back. */
function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Coerce a stored palette to a known id. Unknown ids migrate to the default
 *  rather than leaving a dangling data-palette. This is also the upgrade path
 *  off the pre-v1 theme names ('light', 'dark', 'midnight', 'forest', 'ocean',
 *  'sepia'), none of which exist any more: they fail the check and land on
 *  cold iron and bone, which is the shipping default. */
function normalizePalette(value: unknown): AppPalette {
  return PALETTE_IDS.includes(value as string) ? (value as AppPalette) : DEFAULT_PALETTE
}

/** Coerce a stored sound theme to a known id; unknown/absent values take the default. */
function normalizeSoundTheme(value: unknown): SoundTheme {
  return SOUND_THEMES.includes(value as SoundTheme) ? (value as SoundTheme) : DEFAULTS.soundTheme
}

/** Coerce a stored analysis depth into a valid ply count or the 'max' sentinel. */
function normalizeDepth(value: unknown): AnalysisDepth {
  if (value === 'max') return 'max'
  return clampInt(value, ANALYSIS_DEPTH_MIN, ANALYSIS_DEPTH_MAX, DEFAULTS.analysisDepth as number)
}

/** Coerce the stored per-game 3D map: keep only boolean values on a plain object. */
function normalizeBoard3d(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === 'boolean') out[k] = v
  return out
}

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      // `theme` is not on AppSettings any more, but a settings blob written
      // before v1 still carries one, so the stored shape is read as the current
      // type plus that one legacy key. normalizePalette rejects every old theme
      // id anyway; reading it here just means an upgrading install is explicit
      // about what it is migrating from rather than silently seeing undefined.
      const stored = JSON.parse(raw) as Partial<AppSettings> & { theme?: unknown }
      const merged = { ...DEFAULTS, ...stored }
      // Coerce a possibly-stale/removed palette or piece set back to a known id.
      merged.palette = normalizePalette(stored.palette ?? stored.theme)
      merged.pieceSet = normalizePieceSet(stored.pieceSet)
      // QoL flags added after v1 shipped: absent or corrupt values take defaults.
      merged.autoQueen = asBool(stored.autoQueen, DEFAULTS.autoQueen)
      merged.confirmResign = asBool(stored.confirmResign, DEFAULTS.confirmResign)
      merged.lowTimeWarning = asBool(stored.lowTimeWarning, DEFAULTS.lowTimeWarning)
      merged.hintsEnabled = asBool(stored.hintsEnabled, DEFAULTS.hintsEnabled)
      merged.showEngineArrows = asBool(stored.showEngineArrows, DEFAULTS.showEngineArrows)
      merged.showEvalBar = asBool(stored.showEvalBar, DEFAULTS.showEvalBar)
      merged.soundVolume = clampFloat(stored.soundVolume, 0, 1, DEFAULTS.soundVolume)
      merged.soundTheme = normalizeSoundTheme(stored.soundTheme)
      merged.allowTakebacks = asBool(stored.allowTakebacks, DEFAULTS.allowTakebacks)
      // Defend Analysis/Play against corrupt or out-of-range stored values.
      merged.analysisMultiPV = clampInt(
        stored.analysisMultiPV,
        ANALYSIS_MULTIPV_MIN,
        ANALYSIS_MULTIPV_MAX,
        DEFAULTS.analysisMultiPV
      )
      merged.analysisDepth = normalizeDepth(stored.analysisDepth)
      merged.playThinkMs = clampInt(
        stored.playThinkMs,
        PLAY_THINK_MS_MIN,
        PLAY_THINK_MS_MAX,
        DEFAULTS.playThinkMs
      )
      merged.board3d = normalizeBoard3d(stored.board3d)
      return merged
    }
  } catch {
    /* ignore corrupt settings */
  }
  return DEFAULTS
}

/** Appearance + gameplay + engine prefs reset by the Settings "reset to defaults" action (Profile is preserved). */
const RESETTABLE_KEYS = [
  'palette',
  'boardTheme',
  'pieceSet',
  'showLegal',
  'coordinates',
  'animation',
  'sound',
  'soundVolume',
  'soundTheme',
  'allowTakebacks',
  'autoQueen',
  'confirmResign',
  'lowTimeWarning',
  'hintsEnabled',
  'showEngineArrows',
  'showEvalBar',
  'analysisMultiPV',
  'analysisDepth',
  'playThinkMs',
  'board3d'
] as const

interface Ctx {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => void
  /** Restore appearance + board/play + engine prefs to defaults; leaves profile untouched. */
  resetDefaults: () => void
}

const SettingsContext = createContext<Ctx | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(load)

  useEffect(() => {
    // The default palette is the one declared on :root, so it is expressed by
    // the ABSENCE of the attribute. Setting data-palette="cold-iron-bone"
    // would also work (palettes.css repeats that block byte for byte) but a
    // page with no attribute is the honest description of the shipping
    // default, and it is what the pre-paint snippet in index.html assumes.
    if (settings.palette === DEFAULT_PALETTE) delete document.documentElement.dataset.palette
    else document.documentElement.dataset.palette = settings.palette
    try {
      localStorage.setItem(KEY, JSON.stringify(settings))
    } catch {
      /* storage may be unavailable */
    }
  }, [settings])

  const update = (patch: Partial<AppSettings>) => setSettings((s) => ({ ...s, ...patch }))

  const resetDefaults = () =>
    setSettings((s) => {
      const next = { ...s }
      for (const k of RESETTABLE_KEYS) {
        // Assign each resettable key from DEFAULTS; the key union keeps this type-safe.
        Object.assign(next, { [k]: DEFAULTS[k] })
      }
      return next
    })

  return (
    <SettingsContext.Provider value={{ settings, update, resetDefaults }}>{children}</SettingsContext.Provider>
  )
}

export function useSettings(): Ctx {
  const c = useContext(SettingsContext)
  if (!c) throw new Error('useSettings must be used within SettingsProvider')
  return c
}
