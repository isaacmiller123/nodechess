/** Small formatters shared by the four puzzle panes. Nothing here invents a
 *  value: every function takes a real number and only decides how it reads. */

/** Theme sizes as v1 writes them: 2.36M, 655K, 1.1K, 940. */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

/** A whole number in full, grouped: 4762884 -> "4,762,884". The corpus line is
 *  the one place the size is stated rather than abbreviated. */
export function formatFull(n: number): string {
  return String(Math.max(0, Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 1 -> "1st". Used for "5th attempt". */
export function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A YYYY-MM-DD key as v1 writes a date: "Sat 25 Jul 2026". */
export function formatYmd(ymd: string): string {
  const d = ymdToDate(ymd)
  if (!d) return ymd
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** "25 Jul", for the missed-days list where the year is noise. */
export function formatYmdShort(ymd: string): string {
  const d = ymdToDate(ymd)
  if (!d) return ymd
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** Parse a LOCAL day key. The daily puzzle rolls at local midnight, so these
 *  keys are local dates and must not be read as UTC. */
export function ymdToDate(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** A local date back to its YYYY-MM-DD key. */
export function dateToYmd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** Milliseconds as a clock: 3:00, 0:09. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Seconds as a clock, for a button that says how long a run is. */
export function formatSeconds(sec: number): string {
  return formatClock(sec * 1000)
}

/** How long ago, in the shortest true form. */
export function formatAgo(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  return `${Math.round(day / 7)}w ago`
}

/** A duration in ms as m:ss, for a finished run. */
export function formatDuration(ms: number): string {
  return formatClock(ms)
}

/** Start of today, local, in ms. The cut for "today's attempts". */
export function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
