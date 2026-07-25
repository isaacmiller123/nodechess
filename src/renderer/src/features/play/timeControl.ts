// Time-control model for Play. Pure data + tiny helpers: no React, no window.api.
//
// A TimeControl is either Unlimited (no clock) or a base/increment pair given in
// the familiar "base+inc" chess notation (minutes base, seconds increment).

import type { Color } from '../../chess/chess'

export interface TimeControl {
  /** Stable id used for the picker + persistence. */
  id: string
  /** Short label shown in the picker, e.g. "5+0". */
  label: string
  /** Initial time per side, in milliseconds. 0 means Unlimited (no clock). */
  baseMs: number
  /** Increment added after each move, in milliseconds. */
  incMs: number
}

const MIN = 60_000
const SEC = 1_000

// Curated presets: the lichess-style chip row. Unlimited stays the default so
// the no-clock experience is unchanged unless the user opts in. Order matters:
// it is the visual order of the chips in TimeControlPicker.
export const TIME_CONTROLS: TimeControl[] = [
  { id: 'unlimited', label: 'Unlimited', baseMs: 0, incMs: 0 },
  { id: '1+0', label: '1+0', baseMs: 1 * MIN, incMs: 0 },
  { id: '2+1', label: '2+1', baseMs: 2 * MIN, incMs: 1 * SEC },
  { id: '3+0', label: '3+0', baseMs: 3 * MIN, incMs: 0 },
  { id: '3+2', label: '3+2', baseMs: 3 * MIN, incMs: 2 * SEC },
  { id: '5+0', label: '5+0', baseMs: 5 * MIN, incMs: 0 },
  { id: '5+3', label: '5+3', baseMs: 5 * MIN, incMs: 3 * SEC },
  { id: '10+0', label: '10+0', baseMs: 10 * MIN, incMs: 0 },
  { id: '10+5', label: '10+5', baseMs: 10 * MIN, incMs: 5 * SEC },
  { id: '15+10', label: '15+10', baseMs: 15 * MIN, incMs: 10 * SEC },
  { id: '30+0', label: '30+0', baseMs: 30 * MIN, incMs: 0 },
  { id: '30+20', label: '30+20', baseMs: 30 * MIN, incMs: 20 * SEC }
]

export const DEFAULT_TIME_CONTROL_ID = 'unlimited'

/** Stable id for any control synthesized from the custom sliders. */
export const CUSTOM_TIME_CONTROL_ID = 'custom'

export function timeControlById(id: string): TimeControl {
  return TIME_CONTROLS.find((t) => t.id === id) ?? TIME_CONTROLS[0]
}

/** Whether this control runs a clock at all. */
export function isTimed(tc: TimeControl): boolean {
  return tc.baseMs > 0
}

// ---- Lichess-style CUSTOM step curves ---------------------------------------
// The picker's custom sliders are index sliders over these arrays (not linear
// ms sliders), so the low end has fine control and the high end takes big steps.
// Exactly lichess's feel.

/** Base-time steps in MINUTES (lichess "Minutes per side" curve). */
export const CUSTOM_BASE_MINUTES: number[] = [
  0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 25,
  30, 40, 45, 60, 90, 120, 150, 180
]

/** Increment steps in SECONDS (lichess "Increment in seconds" curve). */
export const CUSTOM_INC_SECONDS: number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 10, 15, 20, 25, 30, 40, 45, 60, 90, 120, 150, 180
]

/** Nearest index into a step array for a raw value (for seeding the sliders from
 *  an arbitrary control). */
function nearestIndex(steps: number[], value: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < steps.length; i++) {
    const d = Math.abs(steps[i] - value)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** Index into CUSTOM_BASE_MINUTES nearest to a control's base time. */
export function baseStepIndex(baseMs: number): number {
  return nearestIndex(CUSTOM_BASE_MINUTES, baseMs / MIN)
}

/** Index into CUSTOM_INC_SECONDS nearest to a control's increment. */
export function incStepIndex(incMs: number): number {
  return nearestIndex(CUSTOM_INC_SECONDS, incMs / SEC)
}

/** Human label for a base/increment pair, e.g. "3+2" or "¾+0". Fractional
 *  bases (lichess's sub-minute steps) render as vulgar fractions like lichess. */
export function timeControlLabel(baseMs: number, incMs: number): string {
  if (baseMs <= 0) return 'Unlimited'
  const inc = Math.round(incMs / SEC)
  const min = baseMs / MIN
  const baseLabel =
    min === 0.25 ? '¼' : min === 0.5 ? '½' : min === 0.75 ? '¾' : String(round1(min))
  return `${baseLabel}+${inc}`
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Build a TimeControl from raw base/increment step VALUES (minutes + seconds).
 * Keeps the existing TimeControl shape and hands back the reserved `custom` id
 * so persistence/pickers can tell a hand-tuned control apart from a preset.
 * A base of 0 collapses to the canonical Unlimited control (no clock).
 */
export function customTimeControl(baseMinutes: number, incSeconds: number): TimeControl {
  const baseMs = Math.max(0, Math.round(baseMinutes * MIN))
  if (baseMs <= 0) return TIME_CONTROLS[0] // Unlimited
  const incMs = Math.max(0, Math.round(incSeconds * SEC))
  return {
    id: CUSTOM_TIME_CONTROL_ID,
    label: timeControlLabel(baseMs, incMs),
    baseMs,
    incMs
  }
}

// ---- Speed category (lichess's estimated-duration rule) ----------------------

export type TimeCategory = 'Unlimited' | 'Bullet' | 'Blitz' | 'Rapid' | 'Classical'

/**
 * Lichess speed bucket for a control, from its estimated game duration
 * `base + 40*increment` (seconds): <30s UltraBullet folds into Bullet, ≤179s
 * Bullet, <480s Blitz, <1500s Rapid, else Classical. Unlimited is its own bucket.
 */
export function timeControlCategory(tc: TimeControl): TimeCategory {
  if (tc.baseMs <= 0) return 'Unlimited'
  const estSeconds = tc.baseMs / SEC + 40 * (tc.incMs / SEC)
  if (estSeconds < 179) return 'Bullet'
  if (estSeconds < 480) return 'Blitz'
  if (estSeconds < 1500) return 'Rapid'
  return 'Classical'
}

/** Threshold (ms) under which a side is considered "low on time". */
export const LOW_TIME_MS = 10_000

/**
 * Format remaining milliseconds for display.
 *   >= 10s  -> "mm:ss"
 *   <  10s  -> "s.t" (seconds with one tenth) for the urgency read.
 * Always clamps at zero; never shows a negative clock.
 */
export function formatClock(ms: number): string {
  const clamped = Math.max(0, ms)
  if (clamped >= LOW_TIME_MS) {
    const totalSec = Math.ceil(clamped / 1000)
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }
  // Under 10s: show tenths, e.g. "9.4". Floor the tenth so it never reads higher
  // than the real remaining time.
  const tenths = Math.floor(clamped / 100)
  const whole = Math.floor(tenths / 10)
  const frac = tenths % 10
  return `${whole}.${frac}`
}

/** Per-side remaining time. */
export type ClockTimes = Record<Color, number>
