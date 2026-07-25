// Japanese byo-yomi clock math. Pure data + tiny helpers: no React, no
// window.api, no node, so it bundles into mpSession's isomorphic test bundle
// (scripts/test-mp.mjs) AND drives the local go clocks (features/games).
//
// Model (classic Japanese byo-yomi, lichess/OGS semantics):
//   - a side starts on MAIN time (initialMs); moves debit it as usual;
//   - when main runs out the side enters byo-yomi: `periods` overtime periods
//     of `periodMs` each. The think that exhausted main spills into period 1;
//   - a move made within the current period RESETS it to a full period
//     (periods are never accumulated, never banked);
//   - letting the current period lapse while thinking CONSUMES it and the next
//     period starts; when the LAST period lapses the side flags;
//   - Fischer increment applies only while a side is still on main time.
//
// One SideClock per color. `remainingMs` is main time before `inByo`, then the
// remaining time of the CURRENT period; `periodsLeft` counts remaining periods
// INCLUDING the running one (0 only after a byo-yomi flag). This is exactly the
// shape that rides the v5 wire (shared MpByoSide + the MpClocks number).

export interface ByoyomiSpec {
  /** Number of overtime periods (≥ 1 for byo-yomi to mean anything). */
  periods: number
  /** Length of each period, ms. */
  periodMs: number
}

export interface SideClock {
  /** Main ms remaining, or the CURRENT period's remaining ms once inByo. */
  remainingMs: number
  /** Periods remaining, INCLUDING the one currently running. */
  periodsLeft: number
  /** True once main time is exhausted and the side lives in periods. */
  inByo: boolean
}

/** A valid, usable byo-yomi spec or null (0/negative fields = plain Fischer). */
export function normalizeByoyomi(byo: ByoyomiSpec | undefined | null): ByoyomiSpec | null {
  if (!byo) return null
  if (!Number.isFinite(byo.periods) || !Number.isFinite(byo.periodMs)) return null
  if (byo.periods < 1 || byo.periodMs <= 0) return null
  return { periods: Math.floor(byo.periods), periodMs: Math.floor(byo.periodMs) }
}

/** Fresh side clock. With byo-yomi and NO main time the side starts directly
 *  in period 1 (main 0 + N×30s is a legal, common go control). */
export function freshSideClock(initialMs: number, byo: ByoyomiSpec | null): SideClock {
  if (byo && initialMs <= 0) {
    return { remainingMs: byo.periodMs, periodsLeft: byo.periods, inByo: true }
  }
  return { remainingMs: initialMs, periodsLeft: byo ? byo.periods : 0, inByo: false }
}

export interface ConsumeResult {
  clock: SideClock
  /** The side ran completely out (last period lapsed / main lapsed, no byo). */
  flagged: boolean
  /** How many periods this think consumed (entering byo-yomi counts the spill
   *  only when it lapses whole periods). Drives the period-consumed flash. */
  periodsConsumed: number
  /** True when this think crossed from main time into byo-yomi. */
  enteredByo: boolean
}

/**
 * Burn `elapsedMs` of think time off a side clock, crossing the main→byo-yomi
 * boundary and any number of period boundaries. Pure: returns a fresh clock.
 * A boundary hit exactly (remaining 0) survives. Only NEGATIVE time flags,
 * matching the session's historical `remaining < 0` convention.
 */
export function consumeElapsed(c: SideClock, elapsedMs: number, byo: ByoyomiSpec | null): ConsumeResult {
  const spent = Math.max(0, elapsedMs)
  let remaining = c.remainingMs - spent
  if (!byo) {
    if (remaining < 0) {
      return { clock: { ...c, remainingMs: 0 }, flagged: true, periodsConsumed: 0, enteredByo: false }
    }
    return { clock: { ...c, remainingMs: remaining }, flagged: false, periodsConsumed: 0, enteredByo: false }
  }
  let { periodsLeft, inByo } = c
  let periodsConsumed = 0
  let enteredByo = false
  if (!inByo) {
    if (remaining >= 0) {
      return { clock: { remainingMs: remaining, periodsLeft, inByo }, flagged: false, periodsConsumed, enteredByo }
    }
    // Main exhausted mid-think: the overflow spills into period 1.
    inByo = true
    enteredByo = true
    remaining += byo.periodMs
  }
  while (remaining < 0 && periodsLeft > 1) {
    periodsLeft -= 1
    periodsConsumed += 1
    remaining += byo.periodMs
  }
  if (remaining < 0) {
    // The last period lapsed: flag, everything zeroed.
    return {
      clock: { remainingMs: 0, periodsLeft: 0, inByo: true },
      flagged: true,
      periodsConsumed,
      enteredByo
    }
  }
  return { clock: { remainingMs: remaining, periodsLeft, inByo }, flagged: false, periodsConsumed, enteredByo }
}

/** Credit after the side COMMITTED a move: in byo-yomi the current period
 *  resets to full (never banked); on main time the Fischer increment applies. */
export function afterMoveCredit(c: SideClock, byo: ByoyomiSpec | null, incrementMs: number): SideClock {
  if (byo && c.inByo) return { ...c, remainingMs: byo.periodMs }
  return { ...c, remainingMs: c.remainingMs + Math.max(0, incrementMs) }
}

/** Total ms until this side would flag if it never moved again: current
 *  remaining + every period still ahead. Drives the host's flag watchdog. */
export function totalBudgetMs(c: SideClock, byo: ByoyomiSpec | null): number {
  if (!byo) return c.remainingMs
  const periodsAhead = Math.max(0, c.inByo ? c.periodsLeft - 1 : c.periodsLeft)
  return c.remainingMs + periodsAhead * byo.periodMs
}

/**
 * Project a RUNNING side clock `elapsedMs` into the current think, for display
 * (never authority): same math as consumeElapsed, so an interpolating clock
 * rolls across period boundaries exactly like the host will rule.
 */
export function projectRunning(c: SideClock, elapsedMs: number, byo: ByoyomiSpec | null): SideClock {
  return consumeElapsed(c, elapsedMs, byo).clock
}

/** Compact spec label, e.g. "3×30s" or "5×1m" (whole minutes collapse). */
export function byoyomiLabel(byo: ByoyomiSpec): string {
  const s = byo.periodMs / 1000
  const unit = s % 60 === 0 && s >= 60 ? `${s / 60}m` : `${s}s`
  return `${byo.periods}×${unit}`
}

/** Curated byo-yomi presets for the go pickers (host card + local setup rows).
 *  Order matters: it is the visual chip order. 'off' = plain Fischer. */
export interface ByoyomiPreset {
  id: string
  label: string
  byo: ByoyomiSpec | null
}

export const BYOYOMI_PRESETS: ByoyomiPreset[] = [
  { id: 'off', label: 'Off', byo: null },
  { id: '3x30', label: '3×30s', byo: { periods: 3, periodMs: 30_000 } },
  { id: '5x30', label: '5×30s', byo: { periods: 5, periodMs: 30_000 } },
  { id: '5x60', label: '5×1m', byo: { periods: 5, periodMs: 60_000 } }
]

export function byoyomiPresetById(id: string): ByoyomiPreset {
  return BYOYOMI_PRESETS.find((p) => p.id === id) ?? BYOYOMI_PRESETS[0]
}
