// The row vocabulary of design-lab/v1/settings.html, as components.
//
// v1 draws one setting per row: a name, a sentence under it, and a control on
// the right. Four sections are built out of five shapes, and every extra
// surface this screen carries (datasets, updates, erases) is built out of the
// same five rather than inventing a sixth. So they live here once.
//
// The one place the app departs from the mock is the slider. v1 drew the track
// and the thumb by hand and said why: "this page is a picture and a real range
// control brings the platform's own colours with it". A picture cannot be
// dragged, so the real control is here, at zero opacity, lying on top of v1's
// drawing. The platform supplies dragging, arrow keys and the announcement;
// the drawing supplies every pixel.

import type { CSSProperties, JSX, ReactNode } from 'react'

export function Sec({
  label,
  count,
  children
}: {
  label: string
  /** The quiet right-hand line in the section head. Left out when the app has
   *  nothing true to put there. */
  count?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">{label}</h2>
        {count != null && count !== '' && <span className="sec-count">{count}</span>}
      </div>
      {children}
    </section>
  )
}

export function SetRow({
  name,
  sub,
  credit,
  stack = false,
  wrap = false,
  off = false,
  children
}: {
  name?: string
  sub?: ReactNode
  credit?: ReactNode
  /** One column: the control sits under the name instead of beside it. */
  stack?: boolean
  /** The control is a value plus a scale, so it takes a second line. */
  wrap?: boolean
  /** The setting above this one is switched off, so this one is inert. */
  off?: boolean
  children?: ReactNode
}): JSX.Element {
  const cls = ['set-row']
  if (stack) cls.push('is-stack')
  if (wrap) cls.push('is-wrap')
  if (off) cls.push('is-off')
  return (
    <div className={cls.join(' ')}>
      <span>
        {name != null && <span className="set-name">{name}</span>}
        {sub != null && <span className="set-sub">{sub}</span>}
        {credit != null && <span className="set-credit">{credit}</span>}
      </span>
      {children}
    </div>
  )
}

/** v1's switch. The picture reads aria-checked, so the markup and the picture
 *  cannot drift apart. */
export function SetSwitch({
  label,
  on,
  disabled = false,
  onChange
}: {
  label: string
  on: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <button
      className="set-switch"
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="set-knob" />
    </button>
  )
}

export interface SegOption<T> {
  value: T
  label: string
}

export function SetSegmented<T extends string | number>({
  label,
  options,
  value,
  scroll = false,
  onChange
}: {
  label: string
  options: readonly SegOption<T>[]
  value: T
  /** More cells than a phone has room for, so they scroll sideways rather than
   *  wrapping, which would break the hairlines between them. */
  scroll?: boolean
  onChange: (v: T) => void
}): JSX.Element {
  const group = (
    <div className="segmented" role="group" aria-label={label} data-segs="">
      {options.map((o) => (
        <button
          key={String(o.value)}
          className="seg"
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
  return scroll ? <div className="set-scroll">{group}</div> : group
}

/** Percent along a scale, clamped, for the fill and the thumb. */
function position(value: number, min: number, max: number): string {
  if (max <= min) return '0%'
  const pct = ((value - min) / (max - min)) * 100
  return `${Math.min(100, Math.max(0, pct))}%`
}

export function SetSlider({
  name,
  sub,
  value,
  min,
  max,
  step = 1,
  display,
  ticks,
  disabled = false,
  onChange,
  onCommit
}: {
  name: string
  sub: string
  value: number
  min: number
  max: number
  step?: number
  /** The value in words, shown in .set-num and announced by the input. */
  display: string
  /** The two words under the scale, one at each end. */
  ticks: [string, string]
  disabled?: boolean
  onChange: (v: number) => void
  /** Fired when the thumb is released, e.g. to play a sample. */
  onCommit?: () => void
}): JSX.Element {
  return (
    <SetRow name={name} sub={sub} wrap off={disabled}>
      <span className="set-num">{display}</span>
      <div className="set-range">
        <div
          className="set-track"
          style={{ '--set-pos': position(value, min, max) } as CSSProperties}
        >
          <span className="set-fill" />
          <span className="set-thumb" />
          <input
            className="set-input"
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            aria-label={name}
            aria-valuetext={display}
            onChange={(e) => onChange(Number(e.target.value))}
            onPointerUp={onCommit}
            onKeyUp={(e) => {
              // Only keys that move the thumb commit; tabbing onto it should not.
              if (/^(Arrow|Home$|End$|Page)/.test(e.key)) onCommit?.()
            }}
          />
        </div>
        <div className="ticks">
          <span className="lbl">{ticks[0]}</span>
          <span className="lbl">{ticks[1]}</span>
        </div>
      </div>
    </SetRow>
  )
}

/** The same track reporting a proportion instead of offering one: no thumb,
 *  because there is nothing here to drag. */
export function SetMeter({
  head,
  value,
  pct
}: {
  head: ReactNode
  value: ReactNode
  /** 0..100. */
  pct: number
}): JSX.Element {
  return (
    <div className="set-range">
      <div className="set-meter-head">
        <span>{head}</span>
        <span className="num">{value}</span>
      </div>
      <div
        className="set-track is-readonly"
        style={{ '--set-pos': `${Math.min(100, Math.max(0, pct))}%` } as CSSProperties}
      >
        <span className="set-fill" />
      </div>
    </div>
  )
}
