// The two controls design-lab/v1/play.html picks everything with: a segmented
// two-or-three way switch, and a row of two-line chips. Both are shell.css
// objects (.segmented/.seg, .chips/.chip.is-stacked); nothing here styles
// anything, it only emits v1's markup and holds the pick.

import { useEffect, useState, type JSX } from 'react'
import {
  CUSTOM_BASE_MINUTES,
  CUSTOM_INC_SECONDS,
  CUSTOM_TIME_CONTROL_ID,
  baseStepIndex,
  customTimeControl,
  incStepIndex,
  timeControlById,
  timeControlCategory,
  type TimeControl
} from './timeControl'

export interface SegOption<T extends string> {
  key: T
  label: string
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false
}: {
  label: string
  value: T
  options: readonly SegOption<T>[]
  onChange: (v: T) => void
  /** The control is real but the answer is not the player's to give. It still
   *  draws, showing the value the app will actually use, and refuses the press.
   *  Say why in a .play-qual beside it: a locked control with no reason next to
   *  it is indistinguishable from a broken one. */
  disabled?: boolean
}): JSX.Element {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          className="seg"
          type="button"
          aria-pressed={value === o.key}
          disabled={disabled}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// v1's clock row, in v1's order: seven presets and then Custom. Every one of
// these is a real preset in timeControl.ts, and each chip's second line is
// timeControlCategory's answer for it rather than a hand-typed word, so the two
// can never drift.
export const CLOCK_CHIP_IDS = ['1+0', '3+2', '5+0', '10+5', '15+10', '30+0', 'unlimited'] as const

/** Nearest legal value on the custom base curve, in minutes. */
function snapMinutes(v: number): number {
  return CUSTOM_BASE_MINUTES[baseStepIndex(v * 60_000)]
}

/** Nearest legal value on the custom increment curve, in seconds. */
function snapSeconds(v: number): number {
  return CUSTOM_INC_SECONDS[incStepIndex(v * 1000)]
}

/**
 * The Clock row. v1 draws eight chips, the last of which reveals two number
 * fields. All eight are drawn on every surface, always in v1's order: a row
 * that loses a chip is a different control, and the player cannot tell a chip
 * that was removed from one that was never there.
 *
 * `lockedIds` is how a surface says "not this one, here": those chips draw and
 * refuse the press, and `note` says why in one line under the row. Typed custom
 * values snap to timeControl.ts's step curves on the way out, because those
 * curves are what the rest of the app (and the rated ladder assertion)
 * understands a custom control to be.
 */
export function ClockChips({
  value,
  onChange,
  lockedIds = [],
  note,
  customId
}: {
  value: TimeControl
  onChange: (tc: TimeControl) => void
  /** Chip ids this surface cannot start a game at. Pass `note` with them. */
  lockedIds?: readonly string[]
  /** ONE short line under the row saying why a chip is locked. A qualifier, at
   *  the .fact-note measure: if it needs a paragraph it belongs in the Play
   *  explainer, not beside a control. */
  note?: string
  /** id for the revealed custom block, so the chip can own it via aria. */
  customId: string
}): JSX.Element {
  const isCustom = value.id === CUSTOM_TIME_CONTROL_ID
  // Raw text while the field is being typed into ("1" on the way to "12"), so
  // a half-finished number is never snapped out from under the caret.
  const [minutes, setMinutes] = useState('12')
  const [increment, setIncrement] = useState('3')

  // Seed the fields from whatever control is live when Custom opens.
  useEffect(() => {
    if (!isCustom) return
    setMinutes(String(Math.round((value.baseMs / 60_000) * 100) / 100))
    setIncrement(String(Math.round(value.incMs / 1000)))
    // Only on entering the custom state; typing must not re-seed itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCustom])

  function commitCustom(rawMinutes: string, rawIncrement: string): void {
    const m = Number(rawMinutes)
    const i = Number(rawIncrement)
    if (!Number.isFinite(m) || !Number.isFinite(i)) return
    onChange(customTimeControl(snapMinutes(m), snapSeconds(i)))
  }

  return (
    <div>
      <div className="chips" role="group" aria-label="Time control">
        {CLOCK_CHIP_IDS.map((id) => {
          const tc = timeControlById(id)
          // Matched on the numbers, not the id, so a control built somewhere
          // else out of the same base and increment still presses its own chip.
          const on = !isCustom && value.baseMs === tc.baseMs && value.incMs === tc.incMs
          return (
            <button
              key={id}
              className="chip is-stacked"
              type="button"
              aria-pressed={on}
              disabled={lockedIds.includes(id)}
              onClick={() => onChange(tc)}
            >
              <span className="chip-main">{tc.label}</span>
              <span className="chip-sub">
                {id === 'unlimited' ? 'No clock' : timeControlCategory(tc)}
              </span>
            </button>
          )
        })}
        <button
          className="chip is-stacked"
          type="button"
          aria-pressed={isCustom}
          aria-expanded={isCustom}
          aria-controls={customId}
          disabled={lockedIds.includes(CUSTOM_TIME_CONTROL_ID)}
          onClick={() => commitCustom(minutes, increment)}
        >
          <span className="chip-main">Custom</span>
          <span className="chip-sub">Set it</span>
        </button>
      </div>

      <div className="play-custom" id={customId} hidden={!isCustom}>
        <span className="lbl">Minutes</span>
        <input
          className="play-num"
          type="text"
          inputMode="numeric"
          value={minutes}
          aria-label="Minutes"
          onChange={(e) => {
            setMinutes(e.target.value)
            commitCustom(e.target.value, increment)
          }}
          onBlur={() => setMinutes(String(snapMinutes(Number(minutes) || 0)))}
        />
        <span className="lbl">Increment</span>
        <input
          className="play-num"
          type="text"
          inputMode="numeric"
          value={increment}
          aria-label="Increment in seconds"
          onChange={(e) => {
            setIncrement(e.target.value)
            commitCustom(minutes, e.target.value)
          }}
          onBlur={() => setIncrement(String(snapSeconds(Number(increment) || 0)))}
        />
        <span className="lbl">Seconds</span>
      </div>

      {note !== undefined && <span className="play-qual">{note}</span>}
    </div>
  )
}

/** m:ss since a start instant, for the search head's one live number. */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Ticks once a second while `since` is set. Real elapsed time from a real
 *  event, never a fabricated countdown. */
export function useElapsed(since: number | null): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [since])
  return since === null ? '0:00' : elapsedLabel(now - since)
}
