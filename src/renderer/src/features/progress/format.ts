// Pure, React-free formatting helpers for the Progress view.
// Type-only import from shared is allowed (we never edit shared files).
import type {
  GameRow,
  PuzzleHistoryRow,
  SchoolChapterMeta,
  SchoolMastery
} from '../../../../shared/types'

/**
 * Confidence band around a Glicko-style rating: +/- 2*rd, floored at 0.
 * Guards against negative/NaN rd. `pm` is the half-width (the "±" amount).
 */
export interface RatingBand {
  center: number
  lo: number
  hi: number
  pm: number
}

export function ratingBand(rating: number, rd: number): RatingBand {
  const safeRd = Number.isFinite(rd) && rd > 0 ? rd : 0
  const pm = Math.round(2 * safeRd)
  const center = Number.isFinite(rating) ? Math.round(rating) : 0
  return { center, lo: Math.max(0, center - pm), hi: center + pm, pm }
}

/**
 * Compact, absolute date for table rows. Empty string for null/invalid so the
 * caller can render a neutral placeholder. Recent items get a relative hint.
 */
export function formatGameDate(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return ''
  const now = Date.now()
  const diff = now - ts
  if (diff >= 0) {
    const min = Math.floor(diff / 60000)
    if (min < 1) return 'just now'
    if (min < 60) return `${min}m ago`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr}h ago`
    const day = Math.floor(hr / 24)
    if (day < 7) return `${day}d ago`
  }
  try {
    const d = new Date(ts)
    const sameYear = d.getFullYear() === new Date().getFullYear()
    return d.toLocaleDateString(
      undefined,
      sameYear
        ? { month: 'short', day: 'numeric' }
        : { year: 'numeric', month: 'short', day: 'numeric' }
    )
  } catch {
    return ''
  }
}

export type GameResultKind = 'win' | 'loss' | 'draw' | 'unknown'

/**
 * Map a stored game result ('1-0' | '0-1' | '1/2-1/2') against the user's color
 * into win/loss/draw. Anything unexpected -> 'unknown' (neutral chip, no crash).
 */
export function resultKind(game: Pick<GameRow, 'result' | 'user_color'>): GameResultKind {
  const r = game.result
  if (r === '1/2-1/2') return 'draw'
  const color = game.user_color
  if ((r === '1-0' || r === '0-1') && (color === 'white' || color === 'black')) {
    const userWon = (r === '1-0' && color === 'white') || (r === '0-1' && color === 'black')
    return userWon ? 'win' : 'loss'
  }
  return 'unknown'
}

/** Short label for a result chip. */
export function resultChipLabel(kind: GameResultKind): string {
  switch (kind) {
    case 'win':
      return 'Win'
    case 'loss':
      return 'Loss'
    case 'draw':
      return 'Draw'
    default:
      return '·'
  }
}

/**
 * Best available human label for the opponent: explicit label, else "Bot {elo}",
 * else the non-user side's name, else 'Opponent'.
 */
export function opponentLabelOf(game: GameRow): string {
  if (game.opponent_label && game.opponent_label.trim()) return game.opponent_label.trim()
  if (game.opponent_elo != null && Number.isFinite(game.opponent_elo)) {
    return `Bot ${Math.round(game.opponent_elo)}`
  }
  const userColor = game.user_color
  const other = userColor === 'white' ? game.black_name : userColor === 'black' ? game.white_name : null
  if (other && other.trim()) return other.trim()
  return 'Opponent'
}

/** Opponent Elo as a string, or '' when unknown. */
export function opponentEloOf(game: GameRow): string {
  if (game.opponent_elo != null && Number.isFinite(game.opponent_elo)) {
    return String(Math.round(game.opponent_elo))
  }
  return ''
}

export type UserColor = 'white' | 'black' | null

/** Normalize the user's color for display ('White' | 'Black' | '·'). */
export function userColorOf(game: GameRow): UserColor {
  return game.user_color === 'white' || game.user_color === 'black' ? game.user_color : null
}

export function userColorLabel(color: UserColor): string {
  if (color === 'white') return 'White'
  if (color === 'black') return 'Black'
  return '·'
}

/**
 * The user's own accuracy for a game, picking the side that matches their color.
 * Returns null when the side is unknown or the value is missing/invalid.
 */
export function userAccuracyOf(game: GameRow): number | null {
  const color = userColorOf(game)
  const raw =
    color === 'white' ? game.accuracy_white : color === 'black' ? game.accuracy_black : null
  if (raw == null || !Number.isFinite(raw)) return null
  return raw
}

/** Format an accuracy percentage compactly (one decimal, no trailing zero). */
export function formatAccuracy(acc: number | null): string {
  if (acc == null || !Number.isFinite(acc)) return ''
  const rounded = Math.round(acc * 10) / 10
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`
}

/** Solve percentage from solved/tried, floored at 0, null when nothing tried. */
export function solvePercent(solved: number, tried: number): number | null {
  if (!Number.isFinite(tried) || tried <= 0) return null
  const s = Number.isFinite(solved) && solved > 0 ? solved : 0
  return Math.round((s / tried) * 100)
}

/** Compact integer formatting with grouping (e.g. 1,204). */
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '0'
  try {
    return Math.round(n).toLocaleString()
  } catch {
    return String(Math.round(n))
  }
}

/**
 * A single point on the results trend. `value` is a running score where
 * win = +1, draw = 0, loss = -1, accumulated oldest -> newest. Used by the
 * sparkline to draw a momentum line without any external state.
 */
export interface TrendPoint {
  value: number
  kind: GameResultKind
}

/**
 * Derive a cumulative win/loss momentum series from a games list. `games` is
 * expected newest-first (as games.list returns); we reverse to oldest-first so
 * the line reads left-to-right through time.
 */
export function resultTrend(games: GameRow[]): TrendPoint[] {
  const ordered = [...games].reverse()
  let running = 0
  const out: TrendPoint[] = []
  for (const g of ordered) {
    const kind = resultKind(g)
    if (kind === 'win') running += 1
    else if (kind === 'loss') running -= 1
    out.push({ value: running, kind })
  }
  return out
}

// ----------------------------------------------------------------------------
// Rating-over-time + accuracy series (chronological, oldest -> newest)
// ----------------------------------------------------------------------------

/** A single dated value point for the line charts. */
export interface SeriesPoint {
  /** Epoch ms of the game; used for the x-axis hint, not for spacing. */
  t: number
  value: number
  /** 1-based index in the chronological series (handy for labels). */
  i: number
}

/** Sort a copy of games oldest-first by created_at (newest-first input is fine). */
function chronological(games: GameRow[]): GameRow[] {
  return [...games].sort((a, b) => {
    const ta = Number.isFinite(a.created_at) ? a.created_at : 0
    const tb = Number.isFinite(b.created_at) ? b.created_at : 0
    return ta - tb
  })
}

/**
 * The user's own per-game accuracy series (matched to their color). Games with
 * no usable accuracy are skipped. Oldest -> newest.
 */
export function accuracySeries(games: GameRow[]): SeriesPoint[] {
  const out: SeriesPoint[] = []
  let i = 0
  for (const g of chronological(games)) {
    const acc = userAccuracyOf(g)
    if (acc == null) continue
    i += 1
    out.push({ t: g.created_at, value: Math.round(acc * 10) / 10, i })
  }
  return out
}

/**
 * The puzzle ladder over time, from the attempt history. This is the only
 * rating history the app keeps: the rating table holds one current row per
 * ladder, so the bot ladder has no equivalent series. `rows` arrive newest
 * first; attempts that did not move the rating (rush, custom) carry no
 * rating_after and are skipped. Oldest -> newest.
 */
export function puzzleRatingSeries(rows: PuzzleHistoryRow[]): SeriesPoint[] {
  const out: SeriesPoint[] = []
  for (let idx = rows.length - 1; idx >= 0; idx--) {
    const r = rows[idx]
    const v = r.ratingAfter
    if (v == null || !Number.isFinite(v)) continue
    out.push({ t: r.createdAt, value: Math.round(v), i: out.length + 1 })
  }
  return out
}

/** Simple {first,last,delta,avg,min,max} summary over a numeric series. */
export interface SeriesStats {
  first: number
  last: number
  delta: number
  avg: number
  min: number
  max: number
  count: number
}

export function seriesStats(points: SeriesPoint[]): SeriesStats | null {
  if (points.length === 0) return null
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (const p of points) {
    sum += p.value
    if (p.value < min) min = p.value
    if (p.value > max) max = p.value
  }
  const first = points[0].value
  const last = points[points.length - 1].value
  return {
    first,
    last,
    delta: last - first,
    avg: Math.round((sum / points.length) * 10) / 10,
    min,
    max,
    count: points.length
  }
}

// ----------------------------------------------------------------------------
// School: the curriculum as a fraction and the chapter that is open
// ----------------------------------------------------------------------------

export interface SchoolProgress {
  /** Chapters in the curriculum (40 today, read rather than assumed). */
  total: number
  completed: number
  /** The chapter the learner is standing in: first unlocked one not finished. */
  current: SchoolChapterMeta | null
  /** Lessons finished inside `current`. */
  currentDone: number
  /** Chapter ids already finished, for the pip strip. */
  doneIds: Set<string>
}

/**
 * The same reading School's own path makes (SchoolView derives these three the
 * same way): how many chapters are finished, which one is open, and how far
 * into it the learner is. When every unlocked chapter is finished the first
 * unfinished one is still named, so the row always leads somewhere.
 */
export function schoolProgress(
  chapters: SchoolChapterMeta[],
  mastery: SchoolMastery | null
): SchoolProgress {
  const ordered = [...chapters].sort((a, b) => a.order - b.order)
  const doneIds = new Set(
    (mastery?.chapters ?? []).filter((c) => c.completed).map((c) => c.chapterId)
  )
  const lessonsByChapter = new Map<string, number>()
  for (const l of mastery?.lessons ?? []) {
    lessonsByChapter.set(l.chapterId, (lessonsByChapter.get(l.chapterId) ?? 0) + 1)
  }
  const unfinished = ordered.filter((c) => !doneIds.has(c.id))
  const current = unfinished.find((c) => !c.locked) ?? unfinished[0] ?? null
  return {
    total: ordered.length,
    completed: ordered.filter((c) => doneIds.has(c.id)).length,
    current,
    currentDone: current ? (lessonsByChapter.get(current.id) ?? 0) : 0,
    doneIds
  }
}

// ----------------------------------------------------------------------------
// Table cells the design asks for that are not stored columns
// ----------------------------------------------------------------------------

const SAN_MOVE = /^(?:[KQRBN][a-h1-8]?x?[a-h][1-8]|[a-h]x?[a-h]?[1-8](?:=[QRBN])?|O-O-O|O-O)[+#]?$/

/**
 * Full moves in a stored game, counted off the PGN movetext. GameRow has no
 * move-count column and a full chessops walk per table row is far too heavy for
 * a five-row list, so this counts SAN tokens after stripping headers, comments,
 * variations, NAGs and move numbers. Null when nothing countable is left, so
 * the cell can show a neutral placeholder rather than a wrong 0.
 */
export function moveCountOf(pgn: string | null | undefined): number | null {
  if (!pgn) return null
  const body = pgn
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/;[^\n]*/g, ' ')
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\$\d+/g, ' ')
    .replace(/\d+\.(\.\.)?/g, ' ')
  let plies = 0
  for (const tok of body.split(/\s+/)) {
    if (tok && SAN_MOVE.test(tok)) plies += 1
  }
  return plies > 0 ? Math.ceil(plies / 2) : null
}

/**
 * A Lichess theme key as a sentence: 'backRankMate' -> 'Back rank mate'. The
 * design writes theme names in sentence case, not title case.
 */
export function humanizeTheme(key: string): string {
  const spaced = key
    .replace(/[-_]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .trim()
    .toLowerCase()
  if (!spaced) return ''
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// ----------------------------------------------------------------------------
// Chart geometry. Pure numbers for the 600x160 viewBox both plots are drawn in.
// ----------------------------------------------------------------------------

/** The plot's own coordinate space, matching the viewBox in the markup. */
export const PLOT_W = 600
export const PLOT_H = 160

/** A five-label vertical scale: four equal bands, round numbers at every line. */
export interface PlotScale {
  bottom: number
  top: number
  /** Top to bottom, as the y column reads. */
  labels: number[]
}

const SCALE_STEPS = [10, 20, 25, 50, 100, 150, 200, 250, 500, 1000]

/** The smallest rating span a chart is allowed to show, so a settled ladder
 *  does not get magnified into a mountain range. */
const MIN_RATING_SPAN = 100

function scaleFrom(bottom: number, step: number): PlotScale {
  const labels = [4, 3, 2, 1, 0].map((i) => bottom + i * step)
  return { bottom, top: bottom + 4 * step, labels }
}

/**
 * A rating scale that contains every value it is given, on round numbers.
 * Derived, never fixed: the ladders start at 1200 here, and a hard-coded
 * 1100-1700 axis would draw a new account's line off the bottom of the frame.
 * With nothing to plot it centres on `center`, which is what the empty chart's
 * dashed level line marks.
 */
export function ratingScale(values: number[], center: number): PlotScale {
  const usable = values.filter((v) => Number.isFinite(v))
  if (usable.length === 0) {
    const step = 100
    return scaleFrom(Math.round(center / step) * step - 2 * step, step)
  }
  let lo = Math.min(...usable)
  let hi = Math.max(...usable)
  if (hi - lo < MIN_RATING_SPAN) {
    const pad = (MIN_RATING_SPAN - (hi - lo)) / 2
    lo -= pad
    hi += pad
  }
  for (const step of SCALE_STEPS) {
    const bottom = Math.floor((lo - step * 0.3) / step) * step
    if (bottom + 4 * step >= hi) return scaleFrom(bottom, step)
  }
  const step = Math.max(1000, Math.ceil((hi - lo) / 4 / 1000) * 1000)
  return scaleFrom(Math.floor(lo / step) * step, step)
}

/** A value's y in plot space, clamped to the frame. */
export function plotY(value: number, scale: PlotScale): number {
  const span = scale.top - scale.bottom
  if (span <= 0) return PLOT_H / 2
  const y = ((scale.top - value) / span) * PLOT_H
  return Math.round(Math.min(PLOT_H, Math.max(0, y)) * 10) / 10
}

/**
 * A dated series as polyline points across the full width. `from`/`to` are the
 * time domain shared by every track on the same plot, so two lines drawn from
 * different sources still line up in time. One point is not a line and comes
 * back empty: the caller marks a lone reading with a tick, the way the design
 * marks the seed.
 */
export function polylinePoints(
  points: SeriesPoint[],
  from: number,
  to: number,
  scale: PlotScale
): string {
  if (points.length < 2) return ''
  const span = to - from
  return points
    .map((p, i) => {
      const x =
        span > 0
          ? ((p.t - from) / span) * PLOT_W
          : points.length > 1
            ? (i / (points.length - 1)) * PLOT_W
            : 0
      return `${Math.round(Math.min(PLOT_W, Math.max(0, x)) * 10) / 10},${plotY(p.value, scale)}`
    })
    .join(' ')
}
