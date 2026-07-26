// Pure formatting helpers for the profile surfaces.
//
// Relative times take the evaluation instant EXPLICITLY (complete-3): the
// caller states its clock, so nothing here reads an ambient one and the whole
// module runs the same headless as it does in the browser.

export const HOUR = 3_600_000
export const DAY = 86_400_000

/** Shorten an account id for display: first 8 characters and an ellipsis. */
export function shortB64u(v: string): string {
  return `${v.slice(0, 8)}…`
}

/** Wordy staleness for "last witnessed activity" (§10). Years for the long-gone. */
export function relativeWts(ts: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 2) return 'moments ago'
  if (min < 60) return `${min} minutes ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`
  if (day < 365) {
    const mo = Math.max(1, Math.round(day / 30))
    return `${mo} month${mo === 1 ? '' : 's'} ago`
  }
  const yr = Math.round((day / 365) * 10) / 10
  const label = Number.isInteger(yr) ? yr.toFixed(0) : yr.toFixed(1)
  return `${label} year${yr === 1 ? '' : 's'} ago`
}

/** Account age from a creation timestamp. */
export function accountAge(createdWts: number, nowMs: number): string {
  const day = Math.max(1, Math.round((nowMs - createdWts) / DAY))
  if (day < 30) return `${day} day${day === 1 ? '' : 's'}`
  if (day < 365) {
    const mo = Math.max(1, Math.round(day / 30))
    return `${mo} month${mo === 1 ? '' : 's'}`
  }
  const yr = Math.round((day / 365) * 10) / 10
  const label = Number.isInteger(yr) ? yr.toFixed(0) : yr.toFixed(1)
  return `${label} year${yr === 1 ? '' : 's'}`
}

/** Compact date for game rows: relative under a week, absolute past it. */
export function gameDate(ts: number, nowMs: number): string {
  const diff = nowMs - ts
  const hr = Math.floor(diff / HOUR)
  if (hr < 1) return 'just now'
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear()
  try {
    return d.toLocaleDateString(
      undefined,
      sameYear
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' }
    )
  } catch {
    return `${day}d ago`
  }
}

/** Whole days until a witnessed expiry (ban countdowns, §9). */
export function daysRemaining(expiresWts: number, nowMs: number): number {
  return Math.max(0, Math.ceil((expiresWts - nowMs) / DAY))
}

/** Human region name for a 2-letter country code; falls back to the code. */
export function regionName(code: string): string {
  const cc = code.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(cc)) return cc
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) ?? cc
  } catch {
    return cc
  }
}
