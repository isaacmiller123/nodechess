// The clock face every games-platform surface shares.
//
// design-lab/v1 draws no clock anywhere (its own header says there is none in
// that build, on purpose), so the LOOK here is not a transcription: it is the
// v1 instrument idiom applied to a running clock. Mono digits with tabular
// figures so nothing shifts as they count, the etched .lbl for the state tag,
// and a FILLED PLATE for the side that is actually burning time. Fill is how
// this palette says "this is the important thing": tokens.css is near
// monochrome on purpose, so a bone plate is the brightest object in the rail
// and the side to move is legible from across the room. Under the emergency
// threshold the plate turns danger, the digits switch to tenths and the number
// blinks: three cues, only one of which is hue.
//
// The COUNTING is not here and has not changed. Increment games hand in a
// fresh `ms` on every frame from features/play/useChessClock; go hands in a
// ClockInterp and this file projects it on a 100ms tick through the same pure
// byo-yomi math the authority rules by, so a period boundary lands here at the
// instant it lands there.

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { lowTimeThreshold, type ClockInterp } from '../play/Clock'
import { projectRunning, type SideClock } from '../play/byoyomi'
import { formatClock, LOW_TIME_MS } from '../play/timeControl'
import type { PlayerColor } from '../../games/kernel'

/** What one side's face shows this frame. */
interface Shown {
  ms: number
  inByo: boolean
  periodsLeft: number
  /** Below this the clock is an emergency. */
  threshold: number
}

/** Resolve the displayed time. Without an interp the caller is already ticking
 *  (useChessClock) and `ms` is this frame's truth; with one we interpolate the
 *  running side down from the authority's snapshot. */
function shownState(ms: number, interp: ClockInterp | undefined): Shown {
  if (!interp) {
    return { ms: Math.max(0, ms), inByo: false, periodsLeft: 0, threshold: LOW_TIME_MS }
  }
  const base: SideClock = {
    remainingMs: interp.snapshot[interp.side],
    periodsLeft: interp.byo?.periodsLeft ?? 0,
    inByo: interp.byo?.inByo ?? false
  }
  const elapsed = interp.running === interp.side ? Math.max(0, performance.now() - interp.atMono) : 0
  // projectRunning degrades to a clamped debit without a spec, and rolls across
  // period boundaries exactly like the authority with one.
  const p = elapsed === 0 ? base : projectRunning(base, elapsed, interp.byoSpec ?? null)
  return {
    ms: Math.max(0, p.remainingMs),
    inByo: p.inByo,
    periodsLeft: p.periodsLeft,
    // In byo-yomi the urgency belongs to the PERIOD, not to main time that was
    // spent long ago.
    threshold: p.inByo
      ? Math.min(LOW_TIME_MS, (interp.byoSpec?.periodMs ?? 0) / 2)
      : lowTimeThreshold(interp.baseMs)
  }
}

/** The MAIN / BY n×30s tag a go row carries. Increment games have no tag. */
export interface ClockTag {
  text: string
  /** In byo-yomi: the periods are running, main time is gone. */
  byo: boolean
}

/**
 * One side's clock: stone, name, optional state tag, and the digit plate.
 *
 * `active` is "this side is on the move"; `over` freezes the face (result,
 * go's scoring phase, or a flag) so a finished game never blinks at anyone.
 */
export function ClockRow({
  side,
  name,
  ms,
  interp,
  active,
  over,
  tag
}: {
  side: PlayerColor
  name: string
  ms: number
  interp?: ClockInterp
  active: boolean
  over: boolean
  tag?: ClockTag
}): JSX.Element {
  // The interp path re-renders itself; `frame` is only there to force it.
  const [, setFrame] = useState(0)
  const ticking = interp !== undefined && interp.running === interp.side && !over
  useEffect(() => {
    if (!ticking) return
    const id = window.setInterval(() => setFrame((n) => n + 1), 100)
    return (): void => window.clearInterval(id)
  }, [ticking])

  // A consumed period re-mounts the badge (React key), retriggering its flash.
  const lastPeriods = useRef<number | null>(null)
  const flash = useRef(0)

  const shown = shownState(ms, interp)
  if (shown.inByo && lastPeriods.current !== null && shown.periodsLeft < lastPeriods.current) {
    flash.current += 1
  }
  lastPeriods.current = shown.inByo ? shown.periodsLeft : null

  const running = active && !over
  const low = shown.ms < shown.threshold && !over
  const flagged = shown.ms <= 0 && (!shown.inByo || shown.periodsLeft === 0)
  const cls = ['gclk-row', running ? 'is-active' : '', low ? 'is-low' : '', flagged ? 'is-flagged' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls}>
      <span className={`votb-turn-dot is-${side}`} aria-hidden />
      <span className="gclk-name">{name}</span>
      {tag && <span className={`gclk-tag${tag.byo ? ' is-byo' : ''}`}>{tag.text}</span>}
      <span
        className="gclk-plate"
        role="timer"
        aria-label={
          shown.inByo
            ? `${name} clock, byo-yomi, ${shown.periodsLeft} periods left`
            : `${name} clock`
        }
        aria-live={running ? 'off' : 'polite'}
      >
        <span className="gclk-time">{formatClock(shown.ms)}</span>
        {shown.inByo && (
          <span key={flash.current} className="gclk-periods" aria-hidden>
            ×{shown.periodsLeft}
          </span>
        )}
      </span>
    </div>
  )
}

/** The pair of rows, with an optional etched caption naming the control the
 *  player picked in the setup dialog ("5+3"). Go rows say MAIN / BY per side
 *  instead, so they pass no caption. */
export function ClockGroup({
  caption,
  children
}: {
  caption?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="gclk" role="group" aria-label="Game clocks">
      {caption && <span className="gclk-cap lbl">{caption}</span>}
      {children}
    </div>
  )
}
