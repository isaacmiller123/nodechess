import type { JSX } from 'react'

/**
 * The icon sprite, verbatim from design-lab/v1.
 *
 * Radix Icons (MIT), redrawn to their 15x15 grid at ONE optical weight: every
 * glyph is a 1.1 stroke with square caps, which is why they sit together in a
 * rail without one of them reading as bolder than its neighbours. v1's
 * account.html drew i-check at 1.3, alone among sixteen; that one is normalised
 * to 1.1 here rather than shipping a single heavier tick.
 *
 * Mounted once, by Layout, and referenced everywhere as
 * `<svg className="icon"><use href="#i-home" /></svg>`. A sprite rather than a
 * component per icon because these are referenced from deep inside transcribed
 * markup, where a <use> is a closer match to the design source than an import.
 *
 * `mark` is the brand rook. It is here because v1 references it by id, but the
 * shipping rail draws the quorum logo from Logo.tsx instead: that mark is the
 * approved one, and the rook in the mockups was a placeholder standing in for
 * it.
 */
export function IconSprite(): JSX.Element {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden focusable="false">
      <symbol id="i-home" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M2.5 6.8 7.5 2.5l5 4.3V12.5H2.5z" />
      </symbol>
      <symbol id="i-play" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M4.8 2.9 12.2 7.5 4.8 12.1z" />
      </symbol>
      <symbol id="i-games" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M2.5 2.5h4.2v4.2H2.5zM8.3 2.5h4.2v4.2H8.3zM2.5 8.3h4.2v4.2H2.5zM8.3 8.3h4.2v4.2H8.3z" />
      </symbol>
      <symbol id="i-puzzles" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M2.5 2.5h5v5h5v5H2.5z" />
      </symbol>
      <symbol id="i-school" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M7.5 4.2C6.1 3.1 4.2 2.9 2.5 3.1v8.4c1.7-.2 3.6 0 5 1.1 1.4-1.1 3.3-1.3 5-1.1V3.1c-1.7-.2-3.6 0-5 1.1zM7.5 4.2v8.4" />
      </symbol>
      <symbol id="i-openings" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M3.5 12.5V3.5M3.5 7h4.6V3.8M3.5 10.4h7.9V7.2" />
      </symbol>
      <symbol id="i-analysis" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M2.5 10.6 5.6 7l2.5 2 4.4-5.4" />
      </symbol>
      <symbol id="i-progress" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M3.2 12.5V9.2M7.5 12.5V6.1M11.8 12.5V3.2" />
      </symbol>
      <symbol id="i-account" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M5 5.3a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M2.9 12.6c0-2.2 2-3.4 4.6-3.4s4.6 1.2 4.6 3.4" />
      </symbol>
      <symbol id="i-settings" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M2.5 5.2h10M2.5 9.8h10" />
      <rect x="4.6" y="3.6" width="1.8" height="3.2" fill="currentColor" stroke="none" />
      <rect x="8.6" y="8.2" width="1.8" height="3.2" fill="currentColor" stroke="none" />
      </symbol>
      <symbol id="i-chev" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M9.2 4.3 5.8 7.5l3.4 3.2" />
      </symbol>
      <symbol id="i-more" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M2.5 4.5h10M2.5 7.5h10M2.5 10.5h10" />
      </symbol>
      <symbol id="i-arrow" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M2.5 7.5h9.5M8.5 4l3.5 3.5-3.5 3.5" />
      </symbol>
      <symbol id="mark" viewBox="0 0 24 24">
      <path
      fill="currentColor"
      fillRule="evenodd"
      d="M3 3h18v18H3zM9.5 3h5v2.8h-5zM9.5 18.2h5V21h-5zM3 9.5h2.8v5H3zM18.2 9.5H21v5h-2.8z"
      />
      </symbol>
      <symbol id="i-check" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M3 8.2 6 11.2 12 4.4" />
      </symbol>
      <symbol id="i-lock" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="square">
      <path d="M4.6 7V5.4a2.9 2.9 0 0 1 5.8 0V7M3.4 7h8.2v5.5H3.4z" />
      </symbol>
    </svg>
  )
}
