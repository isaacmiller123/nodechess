// Local go clocks (KernelOtb / KernelBot). Japanese byo-yomi over the same
// pure math the online session rules by (features/play/byoyomi.ts), owned
// entirely in the renderer: no host, no wire, one authoritative SideClock per
// color committed on every move, projected live by the shared clock face.
//
// The hook is the authority: it watches the game's `turn`, debits the side
// that just moved (crossing the main→byo-yomi boundary and any lapsed periods
// exactly like consumeElapsed rules online), credits the reset-on-move period,
// arms a flag watchdog for the running side's WHOLE remaining budget, and
// fires `onFlag` when the last period lapses. Period entry/consumption plays
// the lowTime tick so heads-down players hear the boundary.
//
// The row tags MAIN while a side is on main time and 'BY 3×30s' once the
// periods start; the ×N badge on the plate carries the live periods-left count
// and the period-consumed flash. The face itself is clockFace.tsx.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ClockGroup, ClockRow } from './clockFace'
import type { ClockInterp } from '../play/Clock'
import {
  afterMoveCredit,
  byoyomiLabel,
  consumeElapsed,
  freshSideClock,
  projectRunning,
  totalBudgetMs,
  type ByoyomiSpec,
  type SideClock
} from '../play/byoyomi'
import type { PlayerColor } from '../../games/kernel'
import { useSound } from '../../sound/useSound'

export interface GoClockConfig {
  /** Main time per side, ms (0 with byo-yomi = straight to period 1). */
  mainMs: number
  /** Japanese byo-yomi periods, or null for main-time-only. */
  byo: ByoyomiSpec | null
}

/** Main-time presets for the local go setup rows ('Off' = no clock unless a
 *  byo-yomi preset is picked). Order is the visual chip order. */
export const GO_MAIN_PRESETS: { id: string; label: string; ms: number }[] = [
  { id: 'off', label: 'Off', ms: 0 },
  { id: '5m', label: '5m', ms: 5 * 60_000 },
  { id: '10m', label: '10m', ms: 10 * 60_000 },
  { id: '30m', label: '30m', ms: 30 * 60_000 }
]

interface SideClocks {
  white: SideClock
  black: SideClock
}

export interface LocalGoClock {
  /** Committed snapshot + anchor for <Clock>'s self-ticking interp, per side. */
  interp(side: PlayerColor): ClockInterp | undefined
  /** Displayed ms fallback for <Clock ms> (committed value; interp overrides). */
  ms(side: PlayerColor): number
  /** Live in-byo-yomi flag per side (boundary-accurate to ~250ms). */
  inByo(side: PlayerColor): boolean
  /** The side that ran out of time, or null. Freezes both clocks. */
  flagged: PlayerColor | null
}

const IDLE: LocalGoClock = {
  interp: () => undefined,
  ms: () => 0,
  inByo: () => false,
  flagged: null
}

/**
 * Drive a local two-sided byo-yomi clock. `turn` is the game's side to move;
 * `running` gates the burn (false before the first move, in go's scoring
 * phase, after a result, and after a flag). `resetKey` restarts both clocks
 * from the config (bump it on every new game). `cfg` null = no clock at all.
 */
export function useLocalGoClock(
  cfg: GoClockConfig | null,
  turn: PlayerColor,
  running: boolean,
  resetKey: number,
  onFlag: (side: PlayerColor) => void
): LocalGoClock {
  const { play } = useSound()
  const byo = cfg?.byo ?? null
  const enabled = cfg !== null && (cfg.mainMs > 0 || byo !== null)

  const fresh = useCallback((): SideClocks => {
    const f = freshSideClock(cfg?.mainMs ?? 0, byo)
    return { white: { ...f }, black: { ...f } }
    // cfg identity is folded into resetKey by the callers (config rows reset).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.mainMs, byo?.periods, byo?.periodMs])

  // Authority: committed clocks + the anchor of the current think.
  const clocksRef = useRef<SideClocks>(fresh())
  const anchorRef = useRef(0) // performance.now() when `turn` started thinking; 0 = paused
  const turnRef = useRef<PlayerColor>(turn)
  const [flagged, setFlagged] = useState<PlayerColor | null>(null)
  // Bumped on every authority change so interp() hands <Clock> a fresh anchor.
  const [, setBeat] = useState(0)
  // Live boundary tracking (tag flips + entry sounds), per side.
  const [liveByo, setLiveByo] = useState<{ white: SideClock; black: SideClock }>(clocksRef.current)
  const liveByoRef = useRef(liveByo)
  liveByoRef.current = liveByo
  const onFlagRef = useRef(onFlag)
  onFlagRef.current = onFlag

  // Reset on a new game / config change.
  useEffect(() => {
    clocksRef.current = fresh()
    anchorRef.current = 0
    turnRef.current = turn
    setFlagged(null)
    setLiveByo(clocksRef.current)
    setBeat((b) => b + 1)
    // `turn` is deliberately NOT a dep. Reset only on new game/config.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, fresh])

  /** Settle the currently-thinking side up to now. `moved` credits the
   *  reset-on-move period; plain settles (pause) just burn. */
  const settle = useCallback(
    (side: PlayerColor, moved: boolean): void => {
      if (anchorRef.current === 0) return
      const elapsed = Math.max(0, performance.now() - anchorRef.current)
      anchorRef.current = 0
      const burned = consumeElapsed(clocksRef.current[side], elapsed, byo)
      if (burned.flagged) {
        clocksRef.current = { ...clocksRef.current, [side]: burned.clock }
        setLiveByo(clocksRef.current)
        setFlagged(side)
        setBeat((b) => b + 1)
        onFlagRef.current(side)
        return
      }
      const credited = moved ? afterMoveCredit(burned.clock, byo, 0) : burned.clock
      clocksRef.current = { ...clocksRef.current, [side]: credited }
      setLiveByo(clocksRef.current)
      setBeat((b) => b + 1)
    },
    [byo]
  )

  // Turn changes while running = the previous side committed a move: settle
  // its think, then anchor the NEW side's think in the same commit (the
  // running-gate effect below won't re-run, `running` usually stays true).
  useEffect(() => {
    if (!enabled || flagged) return
    const prev = turnRef.current
    turnRef.current = turn
    if (prev === turn) return
    settle(prev, true)
    if (running && anchorRef.current === 0) {
      anchorRef.current = performance.now()
      setBeat((b) => b + 1)
    }
  }, [turn, enabled, flagged, running, settle])

  // Running gate: anchor the think when the clock starts, fold it when paused.
  useEffect(() => {
    if (!enabled || flagged) return
    if (running) {
      if (anchorRef.current === 0) {
        anchorRef.current = performance.now()
        setBeat((b) => b + 1)
      }
      return
    }
    if (anchorRef.current !== 0) settle(turnRef.current, false)
  }, [running, enabled, flagged, settle])

  // Flag watchdog: fires when the running side's WHOLE budget (main + every
  // period ahead) lapses; recomputes on fire, never trusts timer punctuality.
  useEffect(() => {
    if (!enabled || flagged || !running) return
    const side = turn
    let timer = 0
    const arm = (): void => {
      if (anchorRef.current === 0) return
      const budget = totalBudgetMs(clocksRef.current[side], byo)
      const fireIn = Math.max(0, budget - (performance.now() - anchorRef.current))
      timer = window.setTimeout(() => {
        if (anchorRef.current === 0) return
        const remaining = totalBudgetMs(clocksRef.current[side], byo) - (performance.now() - anchorRef.current)
        if (remaining > 0) {
          arm() // early fire (throttled tab): re-arm for the residual
          return
        }
        settle(side, false) // burns past the last period → flags inside settle
      }, fireIn + 10)
    }
    arm()
    return (): void => window.clearTimeout(timer)
  }, [enabled, flagged, running, turn, byo, settle])

  // Boundary watcher (byo-yomi only): a 250ms pulse that projects the running
  // side and, on crossing into byo-yomi or consuming a period mid-think, plays
  // the lowTime tick and refreshes the MAIN/BY tag state.
  useEffect(() => {
    if (!enabled || !byo || flagged || !running) return
    const id = window.setInterval(() => {
      if (anchorRef.current === 0) return
      const side = turnRef.current
      const seen = liveByoRef.current[side]
      const projected = projectRunning(
        clocksRef.current[side],
        performance.now() - anchorRef.current,
        byo
      )
      if (projected.inByo !== seen.inByo || projected.periodsLeft !== seen.periodsLeft) {
        play('lowTime')
        setLiveByo((cur) => ({ ...cur, [side]: projected }))
      }
    }, 250)
    return (): void => window.clearInterval(id)
  }, [enabled, byo, flagged, running, play])

  return useMemo<LocalGoClock>(() => {
    if (!enabled) return IDLE
    const interp = (side: PlayerColor): ClockInterp => ({
      snapshot: {
        white: clocksRef.current.white.remainingMs,
        black: clocksRef.current.black.remainingMs
      },
      atMono: anchorRef.current === 0 ? performance.now() : anchorRef.current,
      running: flagged === null && running && anchorRef.current !== 0 ? turnRef.current : null,
      side,
      baseMs: cfg.mainMs,
      ...(byo ? { byoSpec: byo } : {}),
      ...(byo
        ? {
            byo: {
              periodsLeft: clocksRef.current[side].periodsLeft,
              inByo: clocksRef.current[side].inByo
            }
          }
        : {})
    })
    return {
      interp,
      ms: (side) => clocksRef.current[side].remainingMs,
      inByo: (side) => liveByo[side].inByo,
      flagged
    }
    // clocksRef mutations are surfaced through the `beat` state bumps that
    // accompany every commit, so this memo re-derives exactly when needed.
  }, [enabled, cfg?.mainMs, byo, flagged, running, liveByo])
}

/** One side's clock row: stone + name, MAIN/BY tag, ticking digit plate. */
export function GoClockRow({
  side,
  label,
  clock,
  active,
  over
}: {
  side: PlayerColor
  label: string
  clock: LocalGoClock
  /** This side's clock is the one burning. */
  active: boolean
  /** Game over (result, scoring, or flag). Freeze the display. */
  over: boolean
}): JSX.Element {
  const interp = clock.interp(side)
  const inByo = clock.inByo(side)
  const byoSpec = interp?.byoSpec
  return (
    <ClockRow
      side={side}
      name={label}
      ms={clock.ms(side)}
      interp={interp}
      active={active}
      over={over}
      tag={{
        // Cased here rather than by text-transform: '3×30s' must keep its
        // lowercase unit, and an etched label is uppercase everywhere else.
        text: inByo && byoSpec ? `BY ${byoyomiLabel(byoSpec)}` : 'MAIN',
        byo: inByo
      }}
    />
  )
}

/** The two clock rows, top-to-bottom in play order (black first in go). */
export function GoClockPair({
  clock,
  turn,
  labels,
  over
}: {
  clock: LocalGoClock
  turn: PlayerColor
  labels: { black: string; white: string }
  over: boolean
}): JSX.Element {
  return (
    <ClockGroup>
      {(['black', 'white'] as const).map((side) => (
        <GoClockRow
          key={side}
          side={side}
          label={labels[side]}
          clock={clock}
          active={turn === side}
          over={over || clock.flagged !== null}
        />
      ))}
    </ClockGroup>
  )
}
