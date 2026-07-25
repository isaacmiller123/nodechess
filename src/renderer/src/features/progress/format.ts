// Pure, React-free formatting helpers for the Progress view.
// Type-only import from shared is allowed (we never edit shared files).
import type { GameRow } from '../../../../shared/types'

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
 * An estimated playing-strength series derived from each reviewed game's
 * estimated-Elo band midpoint (est_elo_low/high). Games without an estimate are
 * skipped, so this reflects *reviewed* games only. Oldest -> newest.
 */
export function estEloSeries(games: GameRow[]): SeriesPoint[] {
  const out: SeriesPoint[] = []
  let i = 0
  for (const g of chronological(games)) {
    const lo = g.est_elo_low
    const hi = g.est_elo_high
    if (lo == null || hi == null || !Number.isFinite(lo) || !Number.isFinite(hi)) continue
    const mid = Math.round((lo + hi) / 2)
    if (!Number.isFinite(mid) || mid <= 0) continue
    i += 1
    out.push({ t: g.created_at, value: mid, i })
  }
  return out
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
// Streaks
// ----------------------------------------------------------------------------

export interface StreakInfo {
  /** Signed current run: + for a win streak, - for a loss streak, 0 if none. */
  current: number
  /** Longest win run anywhere in the window. */
  bestWin: number
  /** Longest loss run anywhere in the window. */
  worstLoss: number
}

/**
 * Compute streaks from a games list. Draws and unknowns break a run (they are
 * neither wins nor losses). `games` is newest-first; the *current* streak is
 * read from the most recent end. Win/loss "best" runs scan the whole window.
 */
export function computeStreaks(games: GameRow[]): StreakInfo {
  const chrono = chronological(games)
  let bestWin = 0
  let worstLoss = 0
  let runWin = 0
  let runLoss = 0
  for (const g of chrono) {
    const k = resultKind(g)
    if (k === 'win') {
      runWin += 1
      runLoss = 0
      if (runWin > bestWin) bestWin = runWin
    } else if (k === 'loss') {
      runLoss += 1
      runWin = 0
      if (runLoss > worstLoss) worstLoss = runLoss
    } else {
      runWin = 0
      runLoss = 0
    }
  }
  // Current streak = the trailing run at the newest end.
  let current = 0
  for (let idx = chrono.length - 1; idx >= 0; idx--) {
    const k = resultKind(chrono[idx])
    if (idx === chrono.length - 1) {
      if (k === 'win') current = 1
      else if (k === 'loss') current = -1
      else break
    } else {
      if (current > 0 && k === 'win') current += 1
      else if (current < 0 && k === 'loss') current -= 1
      else break
    }
  }
  return { current, bestWin, worstLoss }
}

// ----------------------------------------------------------------------------
// Results breakdown (W/D/L, optionally grouped by opponent kind)
// ----------------------------------------------------------------------------

export interface ResultTally {
  wins: number
  draws: number
  losses: number
  /** Games whose result couldn't be classified (still counted for total). */
  unknown: number
  total: number
}

export function emptyTally(): ResultTally {
  return { wins: 0, draws: 0, losses: 0, unknown: 0, total: 0 }
}

function addToTally(t: ResultTally, kind: GameResultKind): void {
  t.total += 1
  if (kind === 'win') t.wins += 1
  else if (kind === 'draw') t.draws += 1
  else if (kind === 'loss') t.losses += 1
  else t.unknown += 1
}

/** Score percentage (win=1, draw=0.5) over decided games, or null if none. */
export function scorePercent(t: ResultTally): number | null {
  const decided = t.wins + t.draws + t.losses
  if (decided <= 0) return null
  return Math.round(((t.wins + t.draws * 0.5) / decided) * 100)
}

export type OpponentGroupKey = 'bot' | 'persona' | 'other'

export interface OpponentGroup {
  key: OpponentGroupKey
  label: string
  tally: ResultTally
}

/** Normalize the stored opponent_kind into one of our display buckets. */
export function opponentGroupOf(game: GameRow): OpponentGroupKey {
  const raw = (game.opponent_kind ?? '').toLowerCase()
  if (raw.includes('persona')) return 'persona'
  if (raw.includes('bot') || raw.includes('engine') || raw.includes('stockfish')) return 'bot'
  // No explicit kind but a numeric Elo strongly implies a bot opponent.
  if (raw === '' && game.opponent_elo != null && Number.isFinite(game.opponent_elo)) return 'bot'
  return 'other'
}

const GROUP_LABELS: Record<OpponentGroupKey, string> = {
  bot: 'Bots',
  persona: 'Personas',
  other: 'Other'
}

/**
 * Split games into W/D/L tallies per opponent group, dropping empty groups and
 * ordering bots -> personas -> other. Returns [] for an empty/new profile.
 */
export function groupByOpponent(games: GameRow[]): OpponentGroup[] {
  const buckets: Record<OpponentGroupKey, ResultTally> = {
    bot: emptyTally(),
    persona: emptyTally(),
    other: emptyTally()
  }
  for (const g of games) addToTally(buckets[opponentGroupOf(g)], resultKind(g))
  const order: OpponentGroupKey[] = ['bot', 'persona', 'other']
  return order
    .filter((k) => buckets[k].total > 0)
    .map((k) => ({ key: k, label: GROUP_LABELS[k], tally: buckets[k] }))
}
