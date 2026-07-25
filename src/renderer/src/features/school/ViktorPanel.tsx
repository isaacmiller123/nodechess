import { useEffect, useMemo, useRef, useState, type JSX } from 'react'

export type ViktorTone = 'pleased' | 'stern' | 'neutral'

export interface ViktorPanelProps {
  /** Viktor's current line. Empty/whitespace -> a quiet placeholder. */
  text: string
  /** Step / section heading shown above the line (bold, like a chess.com lesson step). */
  eyebrow?: string
  /** Action area (buttons, feedback chips) pinned to the bottom of the card. */
  children?: React.ReactNode
  /** When true, Viktor is intentionally silent (e.g. during the boss game). */
  silent?: boolean
  /** When true, Viktor is working (engine thinking, debrief loading). An
   *  animated ellipsis replaces the line. */
  thinking?: boolean
  /** Explicit mood accent on the card. When absent it is derived from the
   *  line's leading words (Viktor's framings are deterministic). */
  tone?: ViktorTone
}

// Viktor's framing vocabulary is deterministic (viktor.ts pools + authored
// success/retry lines), so a conservative leading-words check can color the
// card without misfiring. Unknown phrasing stays neutral.
const PLEASED_RE =
  /^(good\b|yes\b|precisely|exactly|correct\b|well played|a clean win|the win is yours|strong work|solved|acceptable|sound enough|playable|reasonable)/i
const STERN_RE =
  /^(no\b|no[ ,]|that is a blunder|a mistake|careless|not the cleanest|not quite|not yet|stop\.|you lost the thread|you were not watching|wrong\b|hm\.)/i

/** Derive a tone from Viktor's line (after any "Move 12." debrief prefix). */
export function deriveViktorTone(text: string): ViktorTone {
  const t = text.replace(/^move\s+\d+[.:]?\s*/i, '').trim()
  if (PLEASED_RE.test(t)) return 'pleased'
  if (STERN_RE.test(t)) return 'stern'
  return 'neutral'
}

/** Hand-drawn Viktor: stern old-school master. Bald, grey beard, spectacles.
 *  Single-color line art in currentColor so it inherits the avatar chip's
 *  token-driven color in both themes. */
function ViktorPortrait(): JSX.Element {
  return (
    <svg
      className="viktor-portrait"
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      {/* coat / shoulders */}
      <path d="M13 64 C13 53.5 20.5 48 32 48 C43.5 48 51 53.5 51 64 Z" fill="currentColor" opacity="0.9" />
      {/* bald dome + temples (line art) */}
      <path
        d="M20.6 31 C19.4 17.5 24.8 9.5 32 9.5 C39.2 9.5 44.6 17.5 43.4 31"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      {/* ears */}
      <path d="M20.4 28.6 C18 28.4 17.6 32.8 20.9 33.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M43.6 28.6 C46 28.4 46.4 32.8 43.1 33.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* stern brows: angled down toward the bridge, clear of the rims */}
      <path d="M21.4 22.8 L28.2 25" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M42.6 22.8 L35.8 25" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      {/* spectacles */}
      <circle cx="25.9" cy="31.4" r="4.5" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="2.1" />
      <circle cx="38.1" cy="31.4" r="4.5" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="2.1" />
      <path d="M30.7 30.9 Q32 29.6 33.3 30.9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* nose */}
      <path d="M32 33.2 L32 37.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* full grey beard (solid silhouette, wavy mustache top edge) */}
      <path
        d="M20.2 32.5 C18.8 43 22.4 52 32 56.8 C41.6 52 45.2 43 43.8 32.5
           C42.2 38 41 39.5 38.2 39.9 C35.6 40.2 33.8 39 32 39
           C30.2 39 28.4 40.2 25.8 39.9 C23 39.5 21.8 38 20.2 32.5 Z"
        fill="currentColor"
        opacity="0.95"
      />
      {/* mustache ridge */}
      <path
        d="M26.6 40.6 C28.6 38.9 30.2 39.5 32 39.5 C33.8 39.5 35.4 38.9 37.4 40.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  )
}

function Dots(): JSX.Element {
  return (
    <span className="viktor-dots" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  )
}

/**
 * The lesson instruction card (chess.com-Lessons style): Viktor's portrait and
 * title at the top, the teaching line as the body (with a fast text-reveal when
 * it changes), and a pinned action footer. The card border tints by Viktor's
 * mood (pleased or stern) when one is set or derivable from the line.
 */
/** Characters revealed per 16ms tick: fast enough to never drag on long lines,
 *  slow enough that Viktor visibly SPEAKS rather than pasting a slide. */
const TYPE_CHARS_PER_TICK = 3

export function ViktorPanel({
  text,
  eyebrow,
  children,
  silent,
  thinking,
  tone
}: ViktorPanelProps): JSX.Element {
  const line = text?.trim() ?? ''
  const resolvedTone: ViktorTone =
    thinking || silent ? 'neutral' : (tone ?? deriveViktorTone(line))

  // Honor prefers-reduced-motion: reveal instantly.
  const reducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    []
  )

  // ---- Typewriter: reveal the line character-by-character; click to skip. ----
  const [shown, setShown] = useState(() => line.length)
  const timerRef = useRef<number | null>(null)
  useEffect(() => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (!line || reducedMotion || silent || thinking) {
      setShown(line.length)
      return
    }
    setShown(0)
    timerRef.current = window.setInterval(() => {
      setShown((n) => {
        const next = n + TYPE_CHARS_PER_TICK
        if (next >= line.length) {
          if (timerRef.current != null) {
            window.clearInterval(timerRef.current)
            timerRef.current = null
          }
          return line.length
        }
        return next
      })
    }, 16)
    return () => {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [line, reducedMotion, silent, thinking])

  const typing = !thinking && !silent && line.length > 0 && shown < line.length
  const state = thinking ? 'thinking' : silent ? 'silent' : typing ? 'speaking' : line ? 'said' : 'idle'
  const skip = (): void => setShown(line.length)

  return (
    <section
      className={`lesson-card viktor-card viktor-tone-${resolvedTone}`}
      data-state={state}
      aria-label="Coach Viktor"
    >
      <header className="lesson-instructor">
        <span className="lesson-instructor-avatar viktor-avatar" aria-hidden>
          <ViktorPortrait />
        </span>
        <span className="lesson-instructor-id">
          <span className="lesson-instructor-name">Viktor</span>
          <span className="lesson-instructor-role">Master Coach</span>
        </span>
        <span className={`viktor-status is-${state}`} aria-hidden>
          {state === 'thinking' ? 'thinking' : state === 'speaking' ? 'speaking' : ''}
        </span>
      </header>

      <div className="lesson-card-body">
        {eyebrow && <h3 className="lesson-step-title">{eyebrow}</h3>}
        {/* The bubble: Viktor's speech, with a tail from the portrait. Clicking
            while he is mid-sentence completes the line instantly. */}
        <div
          className="viktor-bubble"
          data-typing={typing || undefined}
          onClick={typing ? skip : undefined}
          role="presentation"
          title={typing ? 'Click to finish the line' : undefined}
        >
          {thinking ? (
            <p className="lesson-text muted viktor-thinking" role="status">
              Viktor studies the position
              <Dots />
            </p>
          ) : silent ? (
            <p className="lesson-text muted">
              Viktor watches in silence. Play your game. We talk after.
            </p>
          ) : line ? (
            // aria-label carries the FULL line so screen readers never wait on
            // the visual typewriter.
            <p className="lesson-text viktor-line" aria-label={line} aria-live="polite">
              <span aria-hidden>{line.slice(0, shown)}</span>
              {typing && <span className="viktor-caret" aria-hidden />}
            </p>
          ) : (
            <p className="lesson-text muted">…</p>
          )}
        </div>
      </div>

      {children && <footer className="lesson-card-actions">{children}</footer>}
    </section>
  )
}

export default ViktorPanel
