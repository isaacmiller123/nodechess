// Shared lichess-style time-control picker. Preset chips (Unlimited + a
// bullet→classical ladder) plus a CUSTOM mode: two index sliders over lichess's
// step curves (fine at the low end, big jumps up top) with a live
// "3+2 · Blitz" category readout. Fully controlled: value in, onChange out.
//
// design-lab/v1's play page picks a clock with chips and two number fields
// instead, so Play no longer renders this. The Games page's online host card
// still does, which is why it survives, and why it now imports its own styles.

import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import { Flame, Infinity as InfinityIcon, Rabbit, Turtle, Zap, SlidersHorizontal } from 'lucide-react'
import {
  CUSTOM_BASE_MINUTES,
  CUSTOM_INC_SECONDS,
  TIME_CONTROLS,
  baseStepIndex,
  customTimeControl,
  incStepIndex,
  timeControlCategory,
  timeControlLabel,
  type TimeCategory,
  type TimeControl
} from './timeControl'
import './TimeControlPicker.css'

export interface TimeControlPickerProps {
  value: TimeControl
  onChange: (tc: TimeControl) => void
  /** Compact variant (tighter chips) for the Grandmasters challenge row. */
  dense?: boolean
}

/** Icon per speed bucket for the live readout. */
const CATEGORY_ICON: Record<TimeCategory, typeof Zap> = {
  Unlimited: InfinityIcon,
  Bullet: Zap,
  Blitz: Flame,
  Rapid: Rabbit,
  Classical: Turtle
}

/** True when two controls describe the same clock (id-independent). */
function sameClock(a: TimeControl, b: TimeControl): boolean {
  return a.baseMs === b.baseMs && a.incMs === b.incMs
}

/** The preset whose clock matches `tc`, if any (so a 'custom' control that lands
 *  exactly on a preset still lights that chip). */
function matchingPreset(tc: TimeControl): TimeControl | undefined {
  return TIME_CONTROLS.find((p) => sameClock(p, tc))
}

function CategoryReadout({ tc }: { tc: TimeControl }): JSX.Element {
  const category = timeControlCategory(tc)
  const Icon = CATEGORY_ICON[category]
  return (
    <span className="tcp-readout" aria-live="polite">
      <Icon size={15} className="tcp-readout-icon" aria-hidden />
      <span className="tcp-readout-label num">{tc.baseMs > 0 ? tc.label : 'Unlimited'}</span>
      <span className="tcp-readout-sep" aria-hidden>
        ·
      </span>
      <span className="tcp-readout-cat">{category === 'Unlimited' ? 'No clock' : category}</span>
    </span>
  )
}

export function TimeControlPicker({ value, onChange, dense = false }: TimeControlPickerProps): JSX.Element {
  const preset = matchingPreset(value)
  // Custom mode: explicit 'custom' id, or a control that matches no preset.
  const isCustomValue = value.id === 'custom' || preset === undefined
  const [customOpen, setCustomOpen] = useState(isCustomValue)

  // Follow the incoming value into custom mode (e.g. a saved 'custom' control),
  // but never force it CLOSED: the user may open Custom off a preset and tune.
  const wasCustomValue = useRef(isCustomValue)
  useEffect(() => {
    if (isCustomValue && !wasCustomValue.current) setCustomOpen(true)
    wasCustomValue.current = isCustomValue
  }, [isCustomValue])

  // Slider positions are indices into the step curves. Seeded from the current
  // value so opening Custom off a preset starts on that preset's clock.
  const baseIdx = baseStepIndex(value.baseMs)
  const incIdx = incStepIndex(value.incMs)

  const emitFromSteps = (bIdx: number, iIdx: number): void => {
    onChange(customTimeControl(CUSTOM_BASE_MINUTES[bIdx], CUSTOM_INC_SECONDS[iIdx]))
  }

  const baseFillPct = (baseIdx / (CUSTOM_BASE_MINUTES.length - 1)) * 100
  const incFillPct = (incIdx / (CUSTOM_INC_SECONDS.length - 1)) * 100
  // Preview label tracks the sliders even before onChange settles the value.
  const customLabel = timeControlLabel(
    CUSTOM_BASE_MINUTES[baseIdx] * 60_000,
    CUSTOM_INC_SECONDS[incIdx] * 1000
  )

  return (
    <div className={`tcp${dense ? ' is-dense' : ''}`}>
      <div className="tcp-chips" role="group" aria-label="Time control">
        {TIME_CONTROLS.map((tc) => {
          const on = !customOpen && preset !== undefined && sameClock(preset, tc)
          const unlimited = tc.baseMs <= 0
          return (
            <button
              key={tc.id}
              type="button"
              className={`tcp-chip${on ? ' on' : ''}${unlimited ? ' is-unlimited' : ''}`}
              aria-pressed={on}
              onClick={() => {
                setCustomOpen(false)
                onChange(tc)
              }}
            >
              {unlimited ? (
                <>
                  <InfinityIcon size={14} aria-hidden />
                  <span>Unlimited</span>
                </>
              ) : (
                <span className="num">{tc.label}</span>
              )}
            </button>
          )
        })}
        <button
          type="button"
          className={`tcp-chip tcp-chip-custom${customOpen ? ' on' : ''}`}
          aria-pressed={customOpen}
          onClick={() => {
            // Entering Custom: keep the current clock so the sliders start where
            // the user was (seed a 'custom' control unless already unlimited).
            setCustomOpen(true)
            if (value.baseMs > 0) emitFromSteps(baseIdx, incIdx)
          }}
        >
          <SlidersHorizontal size={13} aria-hidden />
          <span>Custom</span>
        </button>
      </div>

      {customOpen ? (
        <div className="tcp-custom">
          <div className="tcp-slider">
            <div className="tcp-slider-head">
              <span className="tcp-slider-label">Minutes per side</span>
              <span className="tcp-slider-value num">{formatMinutes(CUSTOM_BASE_MINUTES[baseIdx])}</span>
            </div>
            <input
              className="tcp-range"
              type="range"
              min={0}
              max={CUSTOM_BASE_MINUTES.length - 1}
              step={1}
              value={baseIdx}
              aria-label="Minutes per side"
              aria-valuetext={`${formatMinutes(CUSTOM_BASE_MINUTES[baseIdx])} minutes`}
              style={{ '--fill': `${baseFillPct}%` } as CSSProperties}
              onChange={(e) => emitFromSteps(Number(e.target.value), incIdx)}
            />
          </div>
          <div className="tcp-slider">
            <div className="tcp-slider-head">
              <span className="tcp-slider-label">Increment in seconds</span>
              <span className="tcp-slider-value num">{CUSTOM_INC_SECONDS[incIdx]}</span>
            </div>
            <input
              className="tcp-range"
              type="range"
              min={0}
              max={CUSTOM_INC_SECONDS.length - 1}
              step={1}
              value={incIdx}
              aria-label="Increment in seconds"
              aria-valuetext={`${CUSTOM_INC_SECONDS[incIdx]} seconds increment`}
              style={{ '--fill': `${incFillPct}%` } as CSSProperties}
              onChange={(e) => emitFromSteps(baseIdx, Number(e.target.value))}
            />
          </div>
          <div className="tcp-custom-foot">
            <CategoryReadout tc={customTimeControl(CUSTOM_BASE_MINUTES[baseIdx], CUSTOM_INC_SECONDS[incIdx])} />
            <span className="tcp-custom-preview num" aria-hidden>
              {CUSTOM_BASE_MINUTES[baseIdx] > 0 ? customLabel : 'No clock'}
            </span>
          </div>
        </div>
      ) : (
        <div className="tcp-foot">
          <CategoryReadout tc={value} />
        </div>
      )}
    </div>
  )
}

/** Slider read-out for a base-minute step (¼/½/¾ for sub-minute, else the number). */
function formatMinutes(min: number): string {
  if (min === 0) return '0'
  if (min === 0.25) return '¼'
  if (min === 0.5) return '½'
  if (min === 0.75) return '¾'
  return String(min)
}

export default TimeControlPicker
