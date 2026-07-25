import { useEffect, useRef, useState } from 'react'
import { formatClock, LOW_TIME_MS } from './timeControl'
import { projectRunning, type ByoyomiSpec, type SideClock } from './byoyomi'

/**
 * Low-time "emergency" threshold (ms) for a control whose base time is `baseMs`,
 * matching lichess/scalachess Clock.Config: min(60s, max(10s, base/8)). A 10+0
 * game turns urgent at 60s, a 1+0 game at 10s. When no base is supplied (the
 * local-play path, which drives `ms` directly), we keep the flat LOW_TIME_MS so
 * that behavior is unchanged.
 */
export function lowTimeThreshold(baseMs: number): number {
  if (baseMs <= 0) return LOW_TIME_MS
  return Math.min(60_000, Math.max(10_000, Math.floor(baseMs / 8)))
}

/**
 * The authoritative clock state the ONLINE store keeps: a snapshot taken at a
 * monotonic instant, plus which side (if any) is currently burning time. The
 * Clock interpolates the running side down from the snapshot itself (the store
 * does not re-render 10×/s), so a live countdown appears without host chatter.
 */
export interface ClockInterp {
  /** Remaining ms for each side at `atMono`. With byo-yomi, an `inByo` side's
   *  number is its CURRENT period's remaining ms. */
  snapshot: { white: number; black: number }
  /** performance.now() timestamp the snapshot was taken at. */
  atMono: number
  /** Side whose clock is running (subtract elapsed since atMono), or null. */
  running: 'white' | 'black' | null
  /** Which side THIS clock renders. */
  side: 'white' | 'black'
  /** This control's base time (ms) — drives the emergency threshold. */
  baseMs: number
  /** Byo-yomi (v5, go): the game's period spec + THIS side's snapshot. The
   *  interpolation rolls across period boundaries exactly like the host rules
   *  (projectRunning), and the render gains a ×N periods badge. */
  byoSpec?: ByoyomiSpec
  byo?: { periodsLeft: number; inByo: boolean }
}

export interface ClockProps {
  /**
   * Remaining time for this side, in milliseconds. Used directly in the LOCAL
   * play path (useChessClock already ticks and hands a fresh value each frame).
   * Ignored when `interp` is supplied (the online path self-ticks instead).
   */
  ms: number
  /** Whether this side's clock is currently counting down. */
  active: boolean
  /** Whether the game has ended (freezes the urgency styling). */
  over: boolean
  /** Accessible label prefix, e.g. "White" / "Black" / a player name. */
  label: string
  /**
   * ONLINE path: interpolate the displayed time from an authoritative snapshot
   * instead of trusting `ms`. When present the component runs a 100ms tick,
   * derives `shown = snapshot[side] − (side === running ? now − atMono : 0)`
   * clamped ≥ 0, and fires `onLowTime` once when it first crosses the per-control
   * emergency threshold. Absent ⇒ the plain presentational path above.
   */
  interp?: ClockInterp
  /**
   * One-shot low-time hook (online path only): invoked exactly once, the first
   * time THIS side's interpolated clock drops below its emergency threshold while
   * running. The store wires it to the low-time sound (gated on settings).
   */
  onLowTime?: () => void
}

/** Displayed state for an interpolating clock: remaining ms (clamped ≥ 0) plus
 *  the projected byo-yomi side snapshot when the game has byo-yomi. */
function interpState(interp: ClockInterp, now: number): SideClock {
  const base: SideClock = {
    remainingMs: interp.snapshot[interp.side],
    periodsLeft: interp.byo?.periodsLeft ?? 0,
    inByo: interp.byo?.inByo ?? false
  }
  const elapsed = interp.running === interp.side ? Math.max(0, now - interp.atMono) : 0
  if (elapsed === 0) return base
  // projectRunning degrades to a plain clamped debit when byoSpec is absent,
  // and rolls across period boundaries exactly like the host otherwise.
  return projectRunning(base, elapsed, interp.byoSpec ?? null)
}

/**
 * A single side's countdown, rendered as a chess.com-style digit block docked
 * to the right edge of its player card. Reads mm:ss, switching to tenths under
 * 10s. The ticking side is highlighted; a low clock turns urgent and blinks.
 *
 * Two modes:
 *   • LOCAL play — purely presentational: renders the `ms` handed in each frame
 *     (all timing lives in useChessClock). Low-time = flat LOW_TIME_MS.
 *   • ONLINE play — self-ticking: given `interp`, it runs a 100ms interval and
 *     interpolates the running side down from the store's authoritative snapshot,
 *     with the per-control emergency threshold and a one-shot low-time hook.
 */
export function Clock({ ms, active, over, label, interp, onLowTime }: ClockProps) {
  // Online path re-renders itself on a 100ms cadence; `frame` just forces it.
  const [, setFrame] = useState(0)
  // One-shot latch so the low-time hook fires at most once per Clock lifetime.
  // Re-armed whenever the game restarts (snapshot base climbs back over the
  // threshold — a rematch reuses the same mounted Clock).
  const lowFiredRef = useRef(false)
  const onLowTimeRef = useRef(onLowTime)
  onLowTimeRef.current = onLowTime
  // Byo-yomi: remember the last shown periodsLeft so a consumed period gets a
  // one-beat flash (keyed span re-mounts the animation).
  const lastPeriodsRef = useRef<number | null>(null)
  const flashRef = useRef(0)

  const ticking = interp !== undefined && interp.running === interp.side && !over

  useEffect(() => {
    if (!ticking) return
    const id = setInterval(() => setFrame((n) => n + 1), 100)
    return () => clearInterval(id)
  }, [ticking])

  // Resolve the displayed ms + the emergency threshold for this render.
  let shown: number
  let threshold: number
  let inByo = false
  let periodsLeft = 0
  if (interp) {
    const projected = interpState(interp, performance.now())
    shown = Math.max(0, projected.remainingMs)
    inByo = projected.inByo
    periodsLeft = projected.periodsLeft
    // In byo-yomi urgency tracks the PERIOD, not the (long-gone) main time.
    threshold = inByo ? Math.min(LOW_TIME_MS, (interp.byoSpec?.periodMs ?? 0) / 2) : lowTimeThreshold(interp.baseMs)
    if (inByo && lastPeriodsRef.current !== null && periodsLeft < lastPeriodsRef.current) {
      flashRef.current += 1 // a period was consumed — retrigger the flash
    }
    lastPeriodsRef.current = inByo ? periodsLeft : null
    // Re-arm the one-shot when a fresh game lifts us back above the threshold
    // (rematch on the same mounted component).
    if (shown > threshold) lowFiredRef.current = false
    // Fire the one-shot the first time the running side crosses below it.
    if (!over && interp.running === interp.side && shown < threshold && !lowFiredRef.current) {
      lowFiredRef.current = true
      onLowTimeRef.current?.()
    }
  } else {
    shown = ms
    threshold = LOW_TIME_MS
  }

  const low = shown < threshold
  const flagged = shown <= 0 && (!inByo || periodsLeft === 0)
  const className = [
    'play-clock',
    active && !over ? 'is-active' : '',
    low && !over ? 'is-low' : '',
    flagged ? 'is-flagged' : '',
    inByo ? 'is-byo' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span
      className={className}
      role="timer"
      aria-label={inByo ? `${label} clock, byo-yomi, ${periodsLeft} periods left` : `${label} clock`}
      aria-live={active && !over ? 'off' : 'polite'}
    >
      <span className="play-clock-time num">{formatClock(shown)}</span>
      {inByo && (
        <span key={flashRef.current} className="play-clock-periods num" aria-hidden>
          ×{periodsLeft}
        </span>
      )}
    </span>
  )
}
