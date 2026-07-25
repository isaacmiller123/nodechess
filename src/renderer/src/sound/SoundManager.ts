// SoundManager: offline-first chess sound effects for the renderer.
//
// Design decisions:
//   * Three selectable sound themes (settings.soundTheme):
//       'standard': the Lichess open-source "standard" set (see
//                    ../assets/sounds/ATTRIBUTION.md for source + license);
//       'classic':   a chess.com-flavored pack synthesized offline by
//                    scripts/gen-sounds.mjs (deep wooden thocks);
//       'real':      physically-layered wood sounds from the same script, with
//                    THREE variants per event; the manager picks a different
//                    variant per play so rapid moves don't sound machine-gun
//                    identical.
//   * Samples are bundled as base64 data: URLs via import.meta.glob(?inline).
//     The packaged app loads the renderer over file:// (see main/window.ts),
//     where fetch() of emitted asset URLs is not allowed. Inlining sidesteps
//     that with zero IPC and keeps the app fully offline.
//   * Synthesis fallback: every event also has a WebAudio recipe. If a theme
//     has no sample for an event or a sample fails to decode, the recipe
//     plays instead. Sound never goes silent because an asset is missing.
//   * Autoplay policies (Chromium / Electron) suspend an AudioContext created
//     before a user gesture. We lazily create the context and resume it on the
//     first user gesture; until then play() is a silent no-op. (Decoding works
//     fine on a suspended context, so themes preload eagerly.)
//
// The manager is intentionally decoupled from React and from window.api: it is
// a plain singleton-friendly class (the SoundTheme import below is type-only,
// erased at runtime). The useSound hook wraps it for components.

import type { SoundTheme } from '../state/settings'

export type SoundName =
  | 'move'
  | 'capture'
  | 'check'
  | 'castle'
  | 'promote'
  | 'gameStart'
  | 'gameEnd'
  | 'lowTime'
  | 'puzzleSolved'
  | 'puzzleFailed'
  // Games-platform events (docs/GAMES-PLATFORM-SPEC.md): synthesized by
  // scripts/gen-game-sounds.mjs into assets/sounds/games/ (shared across the
  // three themes; a theme dir may override any of them with its own file).
  | 'goStone' // slate stone snapped onto a kaya goban
  | 'discFlip' // othello disc flipping over (double-click flutter)
  | 'discPlace' // felt-damped wooden disc tap (checkers/morris)
  | 'discDrop' // connect-4 disc rattling down the slot + landing
  | 'pieceSlideCapture' // checkers multi-jump swoosh + landing tap
  | 'penStroke' // soft marker squeak (tic-tac-toe/hex)
  | 'shogiPiece' // crisp shogi wedge snap ("pachi")
  | 'gameStartGong' // subtle low gong (go game start)

const SOUND_EVENT_NAMES: readonly SoundName[] = [
  'move',
  'capture',
  'check',
  'castle',
  'promote',
  'gameStart',
  'gameEnd',
  'lowTime',
  'puzzleSolved',
  'puzzleFailed',
  'goStone',
  'discFlip',
  'discPlace',
  'discDrop',
  'pieceSlideCapture',
  'penStroke',
  'shogiPiece',
  'gameStartGong'
]

/** Local copy of the theme ids so this module stays React-free (the type-only
 *  import above keeps it honest: a removed id here fails to typecheck). */
const KNOWN_SOUND_THEMES: readonly SoundTheme[] = ['standard', 'classic', 'real']

export interface SoundManagerOptions {
  /** Master on/off. When false, play() is a no-op. Default: true. */
  enabled?: boolean
  /** 0..1 master gain. Default: 0.6. */
  volume?: number
  /** Which sample pack to play. Default: 'standard'. */
  theme?: SoundTheme
}

const SETTINGS_KEY = 'oct.settings.v1'

/** Read the `sound` flag from the shared settings localStorage key. */
export function readSoundEnabledFromSettings(): boolean {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return true
    const parsed = JSON.parse(raw) as { sound?: unknown }
    return parsed.sound !== false
  } catch {
    return true
  }
}

/** Default master volume MUST match `DEFAULTS.soundVolume` in state/settings.tsx
 *  so a fresh install sounds the same before and after the first React render. */
const DEFAULT_VOLUME = 0.7

/** Read the `soundVolume` pref (0..1) from the shared settings localStorage key,
 *  so the singleton starts at the user's volume before useSound's effect syncs it. */
export function readSoundVolumeFromSettings(): number {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_VOLUME
    const parsed = JSON.parse(raw) as { soundVolume?: unknown }
    const n = typeof parsed.soundVolume === 'number' ? parsed.soundVolume : NaN
    return Number.isFinite(n) ? clamp01(n) : DEFAULT_VOLUME
  } catch {
    return DEFAULT_VOLUME
  }
}

/** Default sound theme MUST match `DEFAULTS.soundTheme` in state/settings.tsx. */
const DEFAULT_THEME: SoundTheme = 'standard'

/** Read the `soundTheme` pref from the shared settings localStorage key, so the
 *  singleton plays the user's pack before useSound's effect syncs it. */
export function readSoundThemeFromSettings(): SoundTheme {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_THEME
    const parsed = JSON.parse(raw) as { soundTheme?: unknown }
    const t = parsed.soundTheme as SoundTheme
    return KNOWN_SOUND_THEMES.includes(t) ? t : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

// A synthesized recipe: a short blip built from one or more oscillator partials
// shaped by a simple attack/decay envelope. Tuned to read as crisp UI ticks,
// not musical notes: deliberately understated to match the app's polish.
// These are the FALLBACK voices: they play when a theme ships no sample for an
// event or the sample fails to decode (and for the first hit while a sample is
// still decoding), so audio never silently disappears.
interface Tone {
  type: OscillatorType
  /** Start frequency (Hz). */
  freq: number
  /** Optional end frequency for a quick pitch sweep. */
  toFreq?: number
  /** Relative weight of this partial in the mix (0..1). */
  gain: number
  /**
   * Seconds to wait (from the sound's start) before this partial sounds. Lets a
   * recipe stagger notes into a short arpeggio without a separate scheduler.
   * Default 0 (sounds immediately, like every other partial). The partial then
   * runs for `dur` seconds (or to the end of the recipe when `dur` is omitted).
   */
  delay?: number
  /** Per-partial duration in seconds. Omit to run until the recipe ends. */
  dur?: number
}

interface Recipe {
  partials: Tone[]
  /** Attack time in seconds. */
  attack: number
  /** Total duration in seconds. */
  duration: number
  /** Peak gain for this sound (multiplied by master volume). */
  peak: number
}

const RECIPES: Record<SoundName, Recipe> = {
  // move, soft, dry wooden "tock". Lowest, shortest, single triangle partial so
  // it stays unobtrusive under rapid play and reads plainly as "a piece moved".
  move: {
    partials: [{ type: 'triangle', freq: 300, toFreq: 196, gain: 1 }],
    attack: 0.002,
    duration: 0.085,
    peak: 0.5
  },
  // capture, harder, grittier knock. A square sub-tone adds a percussive thud
  // the plain move lacks, and a quick bright triangle "click" rides on top.
  capture: {
    partials: [
      { type: 'square', freq: 180, toFreq: 110, gain: 0.6 },
      { type: 'triangle', freq: 520, toFreq: 320, gain: 0.45 }
    ],
    attack: 0.001,
    duration: 0.13,
    peak: 0.55
  },
  // check. Bright, attention-getting two-tone in a high register (clear fifth),
  // the second note delayed so it reads as a deliberate "ding-ding" alert.
  check: {
    partials: [
      { type: 'sine', freq: 880, gain: 0.8, dur: 0.09 },
      { type: 'sine', freq: 1320, gain: 0.45, delay: 0.07, dur: 0.11 }
    ],
    attack: 0.002,
    duration: 0.2,
    peak: 0.5
  },
  // castle: low rolling "thunk-thunk": two staggered triangle hits suggest the
  // king and rook settling. Deliberately bassy so it never reads like a capture.
  castle: {
    partials: [
      { type: 'triangle', freq: 240, toFreq: 175, gain: 0.85, dur: 0.1 },
      { type: 'triangle', freq: 200, toFreq: 150, gain: 0.7, delay: 0.085, dur: 0.12 },
      { type: 'sine', freq: 360, toFreq: 300, gain: 0.22 }
    ],
    attack: 0.003,
    duration: 0.22,
    peak: 0.5
  },
  // promote: celebratory rising triad (C5-E5-G5-ish). Sequential sine notes give
  // an unmistakable "level up" flourish distinct from the single-note move/check.
  promote: {
    partials: [
      { type: 'sine', freq: 523, gain: 0.7, delay: 0, dur: 0.1 },
      { type: 'sine', freq: 659, gain: 0.7, delay: 0.08, dur: 0.1 },
      { type: 'sine', freq: 784, toFreq: 988, gain: 0.75, delay: 0.16, dur: 0.16 },
      { type: 'triangle', freq: 1568, gain: 0.18, delay: 0.16, dur: 0.16 }
    ],
    attack: 0.004,
    duration: 0.36,
    peak: 0.45
  },
  // gameStart: warm ascending perfect-fourth fanfare (A4 -> D5). Two clean sine
  // notes, gentle and inviting; lower and rounder than the puzzleSolved cue.
  gameStart: {
    partials: [
      { type: 'sine', freq: 440, gain: 0.9, delay: 0, dur: 0.16 },
      { type: 'sine', freq: 587, gain: 0.9, delay: 0.12, dur: 0.2 },
      { type: 'triangle', freq: 880, gain: 0.18, delay: 0.12, dur: 0.2 }
    ],
    attack: 0.006,
    duration: 0.34,
    peak: 0.42
  },
  // gameEnd: settled descending resolve (G4 -> C4) with a soft low body. Reads
  // as a calm "that's over", clearly the inverse of the gameStart rise.
  gameEnd: {
    partials: [
      { type: 'sine', freq: 392, gain: 0.85, delay: 0, dur: 0.18 },
      { type: 'sine', freq: 262, gain: 0.85, delay: 0.14, dur: 0.26 },
      { type: 'triangle', freq: 196, gain: 0.3, delay: 0.14, dur: 0.26 }
    ],
    attack: 0.006,
    duration: 0.44,
    peak: 0.45
  },
  // lowTime: tense, dry high tick. Square wave with a slight downward bend so a
  // repeated train of these feels like an urgent countdown clock.
  lowTime: {
    partials: [{ type: 'square', freq: 920, toFreq: 760, gain: 0.7 }],
    attack: 0.001,
    duration: 0.09,
    peak: 0.4
  },
  // puzzleSolved. Pleasant, brighter-than-gameStart success arpeggio: a rising
  // major triad (C5-E5-G5) capped by a high octave sparkle. Triangle bodies give
  // it a chime-like shimmer that clearly says "correct!".
  puzzleSolved: {
    partials: [
      { type: 'triangle', freq: 523, gain: 0.7, delay: 0, dur: 0.11 },
      { type: 'triangle', freq: 659, gain: 0.7, delay: 0.09, dur: 0.11 },
      { type: 'triangle', freq: 784, gain: 0.75, delay: 0.18, dur: 0.16 },
      { type: 'sine', freq: 1047, gain: 0.4, delay: 0.26, dur: 0.18 }
    ],
    attack: 0.004,
    duration: 0.46,
    peak: 0.46
  },
  // puzzleFailed. Soft, non-harsh error: a gentle descending minor second
  // (F4 -> E4-ish) on a mellow triangle. Lower and rounder than the check alert,
  // deliberately understated so a wrong answer never feels punishing.
  puzzleFailed: {
    partials: [
      { type: 'triangle', freq: 349, gain: 0.8, delay: 0, dur: 0.13 },
      { type: 'triangle', freq: 277, gain: 0.8, delay: 0.11, dur: 0.2 },
      { type: 'sine', freq: 174, gain: 0.25, delay: 0.11, dur: 0.2 }
    ],
    attack: 0.005,
    duration: 0.34,
    peak: 0.4
  },
  // --- games-platform fallbacks (samples ship in assets/sounds/games/; these
  // --- only voice the first hit while decoding, or if an asset ever breaks).
  // goStone. Hard glassy clack over a deep board 'pok'.
  goStone: {
    partials: [
      { type: 'triangle', freq: 2800, toFreq: 2200, gain: 0.35, dur: 0.03 },
      { type: 'sine', freq: 220, toFreq: 180, gain: 1 }
    ],
    attack: 0.001,
    duration: 0.12,
    peak: 0.55
  },
  // discFlip. Two quick light ticks.
  discFlip: {
    partials: [
      { type: 'triangle', freq: 1400, toFreq: 1100, gain: 0.7, dur: 0.03 },
      { type: 'triangle', freq: 950, toFreq: 760, gain: 0.9, delay: 0.035, dur: 0.05 }
    ],
    attack: 0.001,
    duration: 0.1,
    peak: 0.45
  },
  // discPlace. Dull felt-damped tap, lower and softer than a chess move.
  discPlace: {
    partials: [{ type: 'triangle', freq: 240, toFreq: 160, gain: 1 }],
    attack: 0.002,
    duration: 0.08,
    peak: 0.48
  },
  // discDrop. Three descending ticks then a landing knock.
  discDrop: {
    partials: [
      { type: 'triangle', freq: 1800, gain: 0.3, delay: 0, dur: 0.02 },
      { type: 'triangle', freq: 1500, gain: 0.35, delay: 0.07, dur: 0.02 },
      { type: 'triangle', freq: 1250, gain: 0.4, delay: 0.125, dur: 0.02 },
      { type: 'square', freq: 300, toFreq: 190, gain: 0.9, delay: 0.18, dur: 0.09 }
    ],
    attack: 0.001,
    duration: 0.3,
    peak: 0.5
  },
  // pieceSlideCapture. Quick downward swoosh into a tap.
  pieceSlideCapture: {
    partials: [
      { type: 'triangle', freq: 900, toFreq: 320, gain: 0.4, dur: 0.11 },
      { type: 'triangle', freq: 280, toFreq: 190, gain: 0.9, delay: 0.11, dur: 0.08 }
    ],
    attack: 0.004,
    duration: 0.22,
    peak: 0.5
  },
  // penStroke. Soft high squeak with a slight downward bend.
  penStroke: {
    partials: [{ type: 'sine', freq: 1500, toFreq: 1150, gain: 1 }],
    attack: 0.02,
    duration: 0.13,
    peak: 0.3
  },
  // shogiPiece. Sharper, brighter snap than the western move.
  shogiPiece: {
    partials: [
      { type: 'triangle', freq: 1700, toFreq: 1300, gain: 0.4, dur: 0.025 },
      { type: 'sine', freq: 200, toFreq: 160, gain: 1 }
    ],
    attack: 0.0008,
    duration: 0.1,
    peak: 0.55
  },
  // gameStartGong. Soft low gong swell.
  gameStartGong: {
    partials: [
      { type: 'sine', freq: 165, gain: 1, dur: 0.7 },
      { type: 'sine', freq: 249, gain: 0.4, dur: 0.55 },
      { type: 'sine', freq: 333, gain: 0.18, dur: 0.4 }
    ],
    attack: 0.015,
    duration: 0.75,
    peak: 0.35
  }
}

// ---------------------------------------------------------------------------
// Sample registry: every file under assets/sounds/<theme>/ ships in the
// renderer bundle as a base64 data: URL (`?inline`). File name convention:
//   <event>.mp3|wav          single take        (standard/, classic/)
//   <event>.<n>.wav          variant n of many  (real/: 3 takes per event)
//
// assets/sounds/games/ is a special pseudo-theme: samples for the games
// platform (goStone, discFlip, ...) shared by EVERY theme. A real theme dir
// may override any game event by shipping its own file for it. Theme files
// always win over the shared pool (see urlsFor).
// ---------------------------------------------------------------------------

const SAMPLE_MODULES = import.meta.glob('../assets/sounds/*/*.{mp3,wav,ogg}', {
  eager: true,
  query: '?inline',
  import: 'default'
}) as Record<string, string>

/** theme -> event -> data URLs (one per variant, variant order preserved). */
const THEME_SAMPLES: Partial<Record<SoundTheme, Partial<Record<SoundName, string[]>>>> = {}

/** Theme-agnostic samples from assets/sounds/games/ (generated by
 *  scripts/gen-game-sounds.mjs). Fallback pool for every theme. */
const SHARED_GAME_SAMPLES: Partial<Record<SoundName, string[]>> = {}

const SHARED_SAMPLE_DIR = 'games'

for (const modulePath of Object.keys(SAMPLE_MODULES).sort()) {
  const m = /\/sounds\/([^/]+)\/([A-Za-z0-9]+)(?:\.(\d+))?\.(?:mp3|wav|ogg)$/.exec(modulePath)
  if (!m) continue
  const dir = m[1]
  const event = m[2] as SoundName
  if (!SOUND_EVENT_NAMES.includes(event)) continue
  if (dir === SHARED_SAMPLE_DIR) {
    ;(SHARED_GAME_SAMPLES[event] ??= []).push(SAMPLE_MODULES[modulePath])
    continue
  }
  const theme = dir as SoundTheme
  if (!KNOWN_SOUND_THEMES.includes(theme)) continue
  const perTheme = (THEME_SAMPLES[theme] ??= {})
  ;(perTheme[event] ??= []).push(SAMPLE_MODULES[modulePath])
}

/**
 * Per-theme event redirects for events a pack deliberately ships no file for.
 * The Lichess standard set has no castle/check/promote sounds (its Check.mp3 is
 * a symlink to Silence upstream) and plays the same "dong" (GenericNotify) for
 * game start and end. Mirror that instead of silently dropping to synthesis.
 */
const THEME_ALIASES: Partial<Record<SoundTheme, Partial<Record<SoundName, SoundName>>>> = {
  standard: { castle: 'move', check: 'move', promote: 'move', gameEnd: 'gameStart' }
}

/** Decode the payload behind a bundled sample URL (data: from `?inline`, or a
 *  plain URL if the bundling strategy ever changes). Never throws. */
async function loadUrlBytes(url: string): Promise<ArrayBuffer | null> {
  if (url.startsWith('data:')) {
    // Chromium's fetch handles data: too, but decoding directly avoids a
    // needless copy through the network stack. Audio assets always inline
    // base64; anything else is malformed -> null.
    const comma = url.indexOf(',')
    if (comma < 0 || !/;base64$/i.test(url.slice(0, comma))) return null
    try {
      const bin = atob(url.slice(comma + 1))
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return bytes.buffer
    } catch {
      return null
    }
  }
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.arrayBuffer()
  } catch {
    return null
  }
}

type AudioCtor = typeof AudioContext

function getAudioContextCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    AudioContext?: AudioCtor
    webkitAudioContext?: AudioCtor
  }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

/** Gap between the demo sounds played by previewTheme(). */
const PREVIEW_GAP_MS = 420

export class SoundManager {
  private enabled: boolean
  private volume: number
  private theme: SoundTheme
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private unlocked = false
  private gestureBound = false
  /** url -> decoded buffer (null = decode failed; use synthesis forever). */
  private readonly decoded = new Map<string, AudioBuffer | null>()
  /** url -> in-flight decode (also caches settled decodes to dedupe work). */
  private readonly decoding = new Map<string, Promise<AudioBuffer | null>>()
  /** Last variant played per event, to avoid twice-in-a-row repeats. */
  private readonly lastVariant = new Map<SoundName, string>()
  /** Monotone token so a newer previewTheme() supersedes an older one. */
  private previewSeq = 0
  /** Recording tap fed by the master gain (Replay Theater export). */
  private recordDest: MediaStreamAudioDestinationNode | null = null
  private readonly boundUnlock: () => void

  constructor(opts: SoundManagerOptions = {}) {
    this.enabled = opts.enabled ?? true
    this.volume = clamp01(opts.volume ?? 0.6)
    this.theme = opts.theme ?? DEFAULT_THEME
    this.boundUnlock = () => {
      void this.unlock()
    }
  }

  /** Enable/disable all output. Disabling never throws and is instant. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** Set master volume (0..1). */
  setVolume(volume: number): void {
    this.volume = clamp01(volume)
    if (this.master && this.ctx) {
      this.master.gain.setValueAtTime(this.volume, this.ctx.currentTime)
    }
  }

  /** Switch sample pack at runtime; warms the pack's decodes in the background. */
  setTheme(theme: SoundTheme): void {
    if (!KNOWN_SOUND_THEMES.includes(theme)) return
    this.theme = theme
    this.preloadTheme(theme)
  }

  getTheme(): SoundTheme {
    return this.theme
  }

  /**
   * Register one-shot listeners that resume/unlock the AudioContext on the
   * first user gesture (required by autoplay policies). Idempotent. Call once,
   * e.g. from a top-level effect.
   */
  attachGestureUnlock(target: Document | HTMLElement = document): void {
    if (this.gestureBound || typeof window === 'undefined') return
    this.gestureBound = true
    const opts: AddEventListenerOptions = { once: true, passive: true }
    target.addEventListener('pointerdown', this.boundUnlock, opts)
    target.addEventListener('keydown', this.boundUnlock, opts)
    target.addEventListener('touchstart', this.boundUnlock, opts)
  }

  /** Eagerly create + resume the context (safe to call inside a gesture). */
  async unlock(): Promise<void> {
    const ctx = this.ensureContext()
    if (!ctx) return
    try {
      if (ctx.state === 'suspended') await ctx.resume()
      this.unlocked = ctx.state === 'running'
    } catch {
      /* resume can reject if still gesture-gated; will retry on next play */
    }
  }

  /**
   * Play a named sound with the active theme's sample (random variant when the
   * pack ships several). Falls back to the synthesized recipe while a sample is
   * still decoding, when a pack has no sample for the event, or when decoding
   * failed. No-ops silently when disabled or when no AudioContext is available.
   * Never throws.
   */
  play(name: SoundName): void {
    if (!this.enabled) return
    const ctx = this.ensureContext()
    if (!ctx || !this.master) return

    // Try to (re)resume opportunistically; if still suspended, bail quietly.
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {})
    }
    this.unlocked = true

    const buffer = this.pickReadyBuffer(this.theme, name)
    if (buffer) {
      this.playBuffer(ctx, buffer)
      return
    }
    // Not decoded yet (or nothing shipped): warm the decodes for next time and
    // voice this hit with the recipe so the event is never silent.
    for (const url of this.urlsFor(this.theme, name)) void this.ensureDecoded(url)
    this.playSynth(ctx, RECIPES[name])
  }

  /**
   * Audition a theme (used by the Settings pickers): plays the given events.
   * Default a move then a capture. With THAT theme's samples, without touching
   * the active theme. Waits for decodes, so the first press is already
   * representative; a newer preview cancels an older one's remaining sounds.
   */
  async previewTheme(theme: SoundTheme, names: SoundName[] = ['move', 'capture']): Promise<void> {
    if (!this.enabled || !KNOWN_SOUND_THEMES.includes(theme)) return
    const seq = ++this.previewSeq
    const ctx = this.ensureContext()
    if (!ctx || !this.master) return
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {})
    }
    for (let i = 0; i < names.length; i++) {
      const name = names[i]
      const urls = this.urlsFor(theme, name)
      let buffer: AudioBuffer | null = null
      if (urls.length) {
        buffer = await this.ensureDecoded(urls[Math.floor(Math.random() * urls.length)])
      }
      if (seq !== this.previewSeq) return // superseded by a newer preview
      if (buffer) this.playBuffer(ctx, buffer)
      else this.playSynth(ctx, RECIPES[name])
      if (i < names.length - 1) {
        await delay(PREVIEW_GAP_MS)
        if (seq !== this.previewSeq) return
      }
    }
  }

  /**
   * Recording tap: a MediaStream carrying everything routed through the master
   * gain (all board/UI sounds at the user's volume). Replay Theater's export
   * mixes its audio track into the canvas capture so the .webm keeps the move
   * sounds. Lazy + cached; lives until dispose(). Null when audio is
   * unavailable (the export then records video-only).
   */
  recordingStream(): MediaStream | null {
    const ctx = this.ensureContext()
    if (!ctx || !this.master) return null
    if (!this.recordDest) {
      try {
        this.recordDest = ctx.createMediaStreamDestination()
        this.master.connect(this.recordDest)
      } catch {
        this.recordDest = null
        return null
      }
    }
    return this.recordDest.stream
  }

  /** Release audio resources. Safe to call multiple times. */
  dispose(): void {
    try {
      void this.ctx?.close()
    } catch {
      /* ignore */
    }
    this.ctx = null
    this.master = null
    this.recordDest = null
    this.unlocked = false
    this.decoded.clear()
    this.decoding.clear()
    this.lastVariant.clear()
  }

  // ---- internals ----------------------------------------------------------

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx
    const Ctor = getAudioContextCtor()
    if (!Ctor) return null
    try {
      this.ctx = new Ctor()
    } catch {
      this.ctx = null
      return null
    }
    const master = this.ctx.createGain()
    master.gain.setValueAtTime(this.volume, this.ctx.currentTime)
    master.connect(this.ctx.destination)
    this.master = master
    this.unlocked = this.ctx.state === 'running'
    return this.ctx
  }

  /** Sample URLs for an event in a theme, following the theme's alias table.
   *  Theme files win; the shared games/ pool backs any event the theme does
   *  not ship (that's how the game-platform sounds reach all three themes). */
  private urlsFor(theme: SoundTheme, name: SoundName): string[] {
    const effective = THEME_ALIASES[theme]?.[name] ?? name
    const themed = THEME_SAMPLES[theme]?.[effective]
    if (themed && themed.length > 0) return themed
    return SHARED_GAME_SAMPLES[effective] ?? []
  }

  /** A decoded buffer for the event, preferring a variant that differs from the
   *  last one played (so the 'real' pack never machine-guns one take). */
  private pickReadyBuffer(theme: SoundTheme, name: SoundName): AudioBuffer | null {
    const urls = this.urlsFor(theme, name)
    const ready: { url: string; buffer: AudioBuffer }[] = []
    for (const url of urls) {
      const buffer = this.decoded.get(url)
      if (buffer) ready.push({ url, buffer })
    }
    if (ready.length === 0) return null
    let pool = ready
    if (ready.length > 1) {
      const last = this.lastVariant.get(name)
      const fresh = ready.filter((r) => r.url !== last)
      if (fresh.length > 0) pool = fresh
    }
    const pick = pool[Math.floor(Math.random() * pool.length)]
    this.lastVariant.set(name, pick.url)
    return pick.buffer
  }

  /** Start (or join) decoding one sample. Resolves null on failure, which is
   *  cached so a bad asset costs one attempt, not one per play. */
  private ensureDecoded(url: string): Promise<AudioBuffer | null> {
    const done = this.decoded.get(url)
    if (done !== undefined) return Promise.resolve(done)
    const inFlight = this.decoding.get(url)
    if (inFlight) return inFlight
    const ctx = this.ensureContext()
    // No audio stack (tests/SSR): don't cache, so a later call may retry.
    if (!ctx) return Promise.resolve(null)
    const task = (async (): Promise<AudioBuffer | null> => {
      try {
        const bytes = await loadUrlBytes(url)
        if (!bytes) return null
        return await ctx.decodeAudioData(bytes)
      } catch {
        return null
      }
    })().then((buffer) => {
      this.decoded.set(url, buffer)
      return buffer
    })
    this.decoding.set(url, task)
    return task
  }

  /** Kick off decodes for every sample in a theme, plus the shared games/
   *  pool every theme falls back to (idempotent, fire-and-forget). */
  private preloadTheme(theme: SoundTheme): void {
    if (!this.ensureContext()) return
    const samples = THEME_SAMPLES[theme]
    if (samples) {
      for (const urls of Object.values(samples)) {
        for (const url of urls) void this.ensureDecoded(url)
      }
    }
    for (const urls of Object.values(SHARED_GAME_SAMPLES)) {
      for (const url of urls) void this.ensureDecoded(url)
    }
  }

  private playSynth(ctx: AudioContext, recipe: Recipe): void {
    if (!this.master) return
    const now = ctx.currentTime
    const peak = Math.max(recipe.peak, 0.0002)

    // Master bus for the whole sound: a single shared output node that we tear
    // down once the longest partial has rung out.
    const bus = ctx.createGain()
    bus.gain.setValueAtTime(peak, now)
    bus.connect(this.master)

    let tailEnd = recipe.duration
    for (const p of recipe.partials) {
      const start = now + (p.delay ?? 0)
      // Per-partial length: explicit `dur`, else whatever's left of the recipe.
      const span = p.dur ?? Math.max(recipe.duration - (p.delay ?? 0), recipe.attack + 0.01)
      const stop = start + span
      tailEnd = Math.max(tailEnd, (p.delay ?? 0) + span)

      const osc = ctx.createOscillator()
      osc.type = p.type
      osc.frequency.setValueAtTime(p.freq, start)
      if (p.toFreq && p.toFreq !== p.freq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(p.toFreq, 1), stop)
      }

      // Each partial gets its own attack/decay so staggered notes read as
      // distinct events rather than one smeared blob.
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, start)
      env.gain.exponentialRampToValueAtTime(Math.max(p.gain, 0.0002), start + recipe.attack)
      env.gain.exponentialRampToValueAtTime(0.0001, stop)

      osc.connect(env)
      env.connect(bus)
      osc.start(start)
      osc.stop(stop + 0.02)
      osc.onended = () => {
        try {
          osc.disconnect()
          env.disconnect()
        } catch {
          /* ignore */
        }
      }
    }

    // Tear down the shared bus shortly after the last partial's tail.
    window.setTimeout(
      () => {
        try {
          bus.disconnect()
        } catch {
          /* ignore */
        }
      },
      Math.ceil((tailEnd + 0.05) * 1000)
    )
  }

  private playBuffer(ctx: AudioContext, buffer: AudioBuffer): void {
    if (!this.master) return
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.master)
    src.start()
    src.onended = () => {
      try {
        src.disconnect()
      } catch {
        /* ignore */
      }
    }
  }

  /** Exposed for tests/diagnostics. */
  get state(): {
    hasContext: boolean
    unlocked: boolean
    enabled: boolean
    theme: SoundTheme
  } {
    return {
      hasContext: this.ctx !== null,
      unlocked: this.unlocked,
      enabled: this.enabled,
      theme: this.theme
    }
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

// Process-wide singleton. Components should use the useSound hook, which wires
// this to the live settings flags and to the gesture-unlock listeners.
let singleton: SoundManager | null = null

export function getSoundManager(): SoundManager {
  if (!singleton) {
    singleton = new SoundManager({
      enabled: readSoundEnabledFromSettings(),
      volume: readSoundVolumeFromSettings(),
      theme: readSoundThemeFromSettings()
    })
  }
  return singleton
}
