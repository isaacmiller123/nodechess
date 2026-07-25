// Replay Theater choreography: PURE math (no three, no React, no DOM).
//
// The cinematic replay is choreographed here as small deterministic functions
// so the camera work is unit-testable in bare node (scripts/test-theater.mjs)
// and so the 2D fallback player can share the exact same cadence without
// pulling the three.js chunk. Consumers:
//   - features/library/ReplayTheater.tsx (cadence, speeds, finale timing)
//   - games/three/TheaterRig.tsx (per-frame camera + scene-clock envelopes)
//
// Model: playback commits one ply at a time (a "shot"). Every envelope below
// is a function of REAL milliseconds since the shot committed, so live speed
// changes and pauses need no re-scheduling. The rig just re-evaluates.
//   - quiet move  → the camera's aim eases toward the action square, then
//     drifts back to the board center while the slow orbit continues;
//   - capture     → same framing plus a dolly-in and a brief scene slow-mo
//     (the shared clock is scaled, so the existing slide + lift-fade ghost
//     animations themselves play in slow motion), then everything recovers;
//   - finale      → the orbit relaxes to half rate and holds the final
//     position; the result card appears after FINALE_CARD_DELAY_MS.

/** Board-space aim point (fractional file/rank; centroid of changed squares). */
export interface TheaterFocus {
  file: number
  rank: number
}

/** One committed ply, as the rig sees it. */
export interface TheaterShot {
  /** performance.now() when the ply committed. */
  atMs: number
  /** The committed move captured material (spec.moveMeta of the played move). */
  capture: boolean
  focus: TheaterFocus | null
}

/** Mutable playback directive, owned by the player, sampled by the rig each
 *  frame (a ref: mutations never re-render the canvas). */
export interface TheaterDirective {
  shot: TheaterShot | null
  /** Cadence multiplier (THEATER_SPEEDS). */
  speed: number
  /** User paused: orbit freezes, scene clock stays real-time for scrubbing. */
  paused: boolean
  /** Game over: settle into the half-rate admiring orbit of the final position. */
  finale: boolean
}

export function defaultDirective(): TheaterDirective {
  return { shot: null, speed: 1, paused: false, finale: false }
}

/** Move cadence options (task bar: 0.5×–3×). */
export const THEATER_SPEEDS = [
  { label: '½×', x: 0.5 },
  { label: '1×', x: 1 },
  { label: '1½×', x: 1.5 },
  { label: '2×', x: 2 },
  { label: '3×', x: 3 }
] as const

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 0→1 smooth ease between edges (constant outside them, monotone inside). */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Frame-rate independent exponential-smoothing factor for a given half-life. */
export function smoothK(dtSec: number, halflifeSec: number): number {
  return 1 - Math.pow(2, -dtSec / Math.max(1e-6, halflifeSec))
}

// ---------------------------------------------------------------------------
// Cadence: how long playback dwells on each committed ply.

export const BASE_PLY_MS = 1350
/** Captures linger: the slow-mo + dolly need room to land and recover. */
export const CAPTURE_PLY_FACTOR = 2.1

const clampSpeed = (speed: number): number => clamp(speed, 0.25, 4)

/** Dwell after committing a ply, before the next one fires. */
export function plyDurationMs(capture: boolean, speed: number): number {
  return Math.round((BASE_PLY_MS * (capture ? CAPTURE_PLY_FACTOR : 1)) / clampSpeed(speed))
}

/** Establishing beat on the start position before the first move. */
export function establishMs(speed: number): number {
  return Math.round(clamp(1500 / clampSpeed(speed), 500, 2200))
}

// ---------------------------------------------------------------------------
// Capture slow-mo, scene-clock scale envelope (1 → dip → 1).

export const SLOWMO_SCALE = 0.35
/** Let the capture slide leave the square at full speed for a beat. */
const SLOWMO_LEAD_MS = 70
const SLOWMO_RAMP_MS = 140

/** Width of the slow-mo dip (real ms). Shrinks at faster cadences. */
export function slowmoWindowMs(speed: number): number {
  return clamp(950 / clampSpeed(speed), 380, 1400)
}

/** Scene-clock scale at `sinceMs` after a shot committed. Quiet moves: 1. */
export function timeScaleAt(sinceMs: number, capture: boolean, speed: number): number {
  if (!capture || !Number.isFinite(sinceMs)) return 1
  const w = slowmoWindowMs(speed)
  const inRamp = smoothstep(SLOWMO_LEAD_MS, SLOWMO_LEAD_MS + SLOWMO_RAMP_MS, sinceMs)
  const outRamp = smoothstep(SLOWMO_LEAD_MS + w - SLOWMO_RAMP_MS, SLOWMO_LEAD_MS + w, sinceMs)
  return 1 - (SLOWMO_SCALE < 1 ? (1 - SLOWMO_SCALE) * (inRamp - outRamp) : 0)
}

// ---------------------------------------------------------------------------
// Framing: dolly (radius multiplier) and pull (aim weight toward the action
// square). Quiet moves aim but never dolly; captures push in ~20%.

export const CAPTURE_DOLLY = 0.78

/** Camera radius multiplier at `sinceMs` after a shot committed. */
export function dollyAt(sinceMs: number, capture: boolean, speed: number): number {
  if (!capture || !Number.isFinite(sinceMs)) return 1
  const w = slowmoWindowMs(speed)
  const push = smoothstep(0, SLOWMO_LEAD_MS + SLOWMO_RAMP_MS * 2, sinceMs)
  const recover = smoothstep(SLOWMO_LEAD_MS + w, SLOWMO_LEAD_MS + w * 1.9, sinceMs)
  return 1 - (1 - CAPTURE_DOLLY) * (push - recover)
}

const QUIET_PULL = 0.42
const CAPTURE_PULL = 0.72

/** Aim weight (0 = board center, 1 = the action square) at `sinceMs`. */
export function pullAt(sinceMs: number, capture: boolean, speed: number): number {
  if (!Number.isFinite(sinceMs)) return 0
  const peak = capture ? CAPTURE_PULL : QUIET_PULL
  const dwell = plyDurationMs(capture, speed)
  const rise = smoothstep(0, 180, sinceMs)
  // Hand the frame back to the board center as the shot ages (matters when
  // playback stops. The next shot replaces this envelope otherwise).
  const release = smoothstep(dwell * 0.9, dwell * 1.8, sinceMs)
  return peak * rise * (1 - release)
}

// ---------------------------------------------------------------------------
// Orbit: a slow admiring arc, driven by an accumulated PHASE (seconds of
// scaled scene time; the rig integrates pauses/slow-mo/finale into it).

export const ORBIT_RATE = 0.1 // rad per phase-second, flat boards
const ORBIT_SWING = 0.45 // upright boards swing instead of circling
const UPRIGHT_SWING_RATE = 0.3
export const FINALE_ORBIT_FACTOR = 0.5

/** Camera azimuth for an orbit phase. Upright boards (connect four) never go
 *  behind the frame. They swing across the front instead. */
export function orbitThetaAt(phaseSec: number, upright: boolean, theta0 = -0.32): number {
  if (upright) return theta0 + Math.sin(phaseSec * UPRIGHT_SWING_RATE) * ORBIT_SWING
  return theta0 + phaseSec * ORBIT_RATE
}

/** Camera elevation (polar angle from +y): a gentle breathing bob, clamped
 *  well above the table plane. */
export function orbitPhiAt(phaseSec: number, upright: boolean): number {
  const base = upright ? 1.22 : (55 * Math.PI) / 180
  const amp = upright ? 0.05 : 0.09
  return clamp(base + Math.sin(phaseSec * 0.23) * amp, 0.15, 1.32)
}

/** Stage camera distance for a board span (slightly wider than play view). */
export function theaterRadius(span: number): number {
  return span * 1.5 + 1.4
}

/** Spherical → cartesian, y-up, theta measured around +y from +z (the
 *  THREE.Spherical convention: kept here so it is testable without three). */
export function sphericalToVec(
  radius: number,
  phi: number,
  theta: number
): { x: number; y: number; z: number } {
  const s = Math.sin(phi) * radius
  return { x: s * Math.sin(theta), y: Math.cos(phi) * radius, z: s * Math.cos(theta) }
}

// ---------------------------------------------------------------------------
// Action square: where did the committed move happen? Derived from the
// occupancy DIFF (codec-independent: works for every family, including
// othello flip fans and go capture clears).

export interface OccLike {
  file: number
  rank: number
  type: string
  color: string
}

const APPEAR_W = 1
const CHANGE_W = 0.9
const VACATE_W = 0.35

/** Weighted centroid of the squares a state transition touched: appearances
 *  (destinations/placements) dominate, occupant changes (capture landings,
 *  flips, promotions) almost as much, vacated squares (origins, captured
 *  stones) least. Null when nothing changed. */
export function diffFocus(prev: readonly OccLike[], next: readonly OccLike[]): TheaterFocus | null {
  const key = (o: OccLike): string => `${o.file},${o.rank}`
  const pm = new Map(prev.map((o) => [key(o), o]))
  const nm = new Map(next.map((o) => [key(o), o]))
  let w = 0
  let file = 0
  let rank = 0
  const add = (f: number, r: number, k: number): void => {
    w += k
    file += f * k
    rank += r * k
  }
  for (const [k, o] of nm) {
    const p = pm.get(k)
    if (!p) add(o.file, o.rank, APPEAR_W)
    else if (p.color !== o.color || p.type !== o.type) add(o.file, o.rank, CHANGE_W)
  }
  for (const [k, p] of pm) {
    if (!nm.has(k)) add(p.file, p.rank, VACATE_W)
  }
  if (w === 0) return null
  return { file: file / w, rank: rank / w }
}

// ---------------------------------------------------------------------------
// Finale + export timing.

/** Result card entrance after the last ply committed. */
export const FINALE_CARD_DELAY_MS = 950
/** Recording tail past the result card so the export never ends mid-fade. */
export const EXPORT_TAIL_MS = 1600
