// Piece motion controller: one per <Tabletop3D>.
//
// Pure math, no React: piece systems sample `pose(id)` every frame and write
// the result onto their instance transforms. Tabletop3D drives it from prop
// diffs (move/flip/spawn) and interaction (hover lift, drag), so all systems
// share identical motion feel: ease-out slides with a low arc, half-turn flips
// with a hop, drop-in spawns, smoothed hover lift.

import * as THREE from 'three'

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

export interface PiecePose {
  position: THREE.Vector3
  /** Flip rotation around X (two-tone discs). 0 = light face up, π = dark face up. */
  flipAngle: number
  scale: number
}

const MOVE_DUR = 0.34
const FLIP_DUR = 0.42
const SPAWN_DUR = 0.3
const MOVE_ARC = 0.35
const FLIP_HOP = 0.45
const LIFT_HEIGHT = 0.22

interface Entry {
  home: THREE.Vector3
  moveFrom: THREE.Vector3 | null
  moveT0: number
  flipCur: number
  flipFrom: number
  flipT0: number
  spawnT0: number
  lift: number
  liftTarget: number
  drag: THREE.Vector3 | null
  dragCur: THREE.Vector3 | null
}

export class MotionController {
  private entries = new Map<string, Entry>()
  private now = 0
  private last = 0

  /** Register or refresh a piece. New ids optionally play the drop-in spawn. */
  ensure(id: string, home: THREE.Vector3, flipAngle: number, spawnAnim: boolean): void {
    const e = this.entries.get(id)
    if (!e) {
      this.entries.set(id, {
        home: home.clone(),
        moveFrom: null,
        moveT0: 0,
        flipCur: flipAngle,
        flipFrom: flipAngle,
        flipT0: -1,
        spawnT0: spawnAnim ? this.now : -1,
        lift: 0,
        liftTarget: 0,
        drag: null,
        dragCur: null
      })
      return
    }
    if (!e.home.equals(home)) this.moveTo(id, home)
    // Flip target changes are driven explicitly via setFlip.
  }

  /**
   * Re-home a piece with NO slide: used when the whole layout changes under
   * the pieces (OTB orientation flip mirrors the world): every piece must
   * repaint at its new spot instantly, never glide across the board.
   */
  teleport(id: string, home: THREE.Vector3): void {
    const e = this.entries.get(id)
    if (!e) return
    e.home.copy(home)
    e.moveFrom = null
    e.spawnT0 = -1
    e.drag = null
    e.dragCur = null
  }

  moveTo(id: string, home: THREE.Vector3): void {
    const e = this.entries.get(id)
    if (!e) return
    const pose = this.pose(id)
    e.moveFrom = pose ? pose.position.clone() : e.home.clone()
    e.home.copy(home)
    e.moveT0 = this.now
    e.drag = null
    e.dragCur = null
  }

  setFlip(id: string, angle: number, animate: boolean): void {
    const e = this.entries.get(id)
    if (!e) return
    if (!animate || Math.abs(angle - e.flipCur) < 1e-3) {
      e.flipCur = angle
      e.flipFrom = angle
      e.flipT0 = -1
      return
    }
    e.flipFrom = e.flipCur
    e.flipT0 = this.now
    e.flipCur = angle
  }

  setLift(id: string, lifted: boolean): void {
    const e = this.entries.get(id)
    if (e) e.liftTarget = lifted ? LIFT_HEIGHT : 0
  }

  clearLifts(): void {
    for (const e of this.entries.values()) e.liftTarget = 0
  }

  /** Drag override: piece is pulled toward `p` (smoothed) until moveTo/endDrag. */
  setDragPoint(id: string, p: THREE.Vector3 | null): void {
    const e = this.entries.get(id)
    if (!e) return
    e.drag = p ? p.clone() : null
    if (!p) e.dragCur = null
  }

  /** Drop rejected/unanswered: glide back home. */
  snapHome(id: string): void {
    const e = this.entries.get(id)
    if (!e) return
    this.moveTo(id, e.home.clone())
  }

  remove(id: string): void {
    this.entries.delete(id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** Current rest position (clone), or null. */
  homeOf(id: string): THREE.Vector3 | null {
    const e = this.entries.get(id)
    return e ? e.home.clone() : null
  }

  /** Current flip target angle (two-tone discs). */
  flipOf(id: string): number {
    return this.entries.get(id)?.flipCur ?? 0
  }

  ids(): IterableIterator<string> {
    return this.entries.keys()
  }

  /** Advance clocks + smoothed channels. Call once per frame before sampling poses. */
  tick(now: number): void {
    const dt = this.last === 0 ? 1 / 60 : Math.min(0.1, now - this.last)
    this.last = now
    this.now = now
    const k = 1 - Math.exp(-dt * 14)
    const kd = 1 - Math.exp(-dt * 26)
    for (const e of this.entries.values()) {
      e.lift += (e.liftTarget - e.lift) * k
      if (e.drag) {
        if (!e.dragCur) e.dragCur = e.drag.clone()
        else e.dragCur.lerp(e.drag, kd)
      }
    }
  }

  /** True while any animation still needs frames (demand-render hint). */
  active(): boolean {
    for (const e of this.entries.values()) {
      if (e.moveFrom || e.flipT0 >= 0 || e.spawnT0 >= 0 || e.drag) return true
      if (Math.abs(e.lift - e.liftTarget) > 1e-3) return true
    }
    return false
  }

  private scratch: PiecePose = { position: new THREE.Vector3(), flipAngle: 0, scale: 1 }

  /**
   * Current pose. Returned object is reused across calls. Copy what you keep.
   */
  pose(id: string): PiecePose | null {
    const e = this.entries.get(id)
    if (!e) return null
    const out = this.scratch
    out.scale = 1
    out.flipAngle = e.flipCur

    // Base position: drag > move animation > home.
    if (e.dragCur) {
      out.position.copy(e.dragCur)
    } else if (e.moveFrom) {
      const t = (this.now - e.moveT0) / MOVE_DUR
      if (t >= 1) {
        e.moveFrom = null
        out.position.copy(e.home)
      } else {
        const k = easeOutCubic(t)
        out.position.lerpVectors(e.moveFrom, e.home, k)
        out.position.y += Math.sin(Math.PI * k) * MOVE_ARC * Math.min(1, e.moveFrom.distanceTo(e.home) * 0.45)
      }
    } else {
      out.position.copy(e.home)
    }

    // Flip.
    if (e.flipT0 >= 0) {
      const t = (this.now - e.flipT0) / FLIP_DUR
      if (t >= 1) {
        e.flipT0 = -1
        e.flipFrom = e.flipCur
      } else {
        const k = easeInOutCubic(t)
        out.flipAngle = e.flipFrom + (e.flipCur - e.flipFrom) * k
        out.position.y += Math.sin(Math.PI * t) * FLIP_HOP
      }
    }

    // Spawn drop-in.
    if (e.spawnT0 >= 0) {
      const t = (this.now - e.spawnT0) / SPAWN_DUR
      if (t >= 1) {
        e.spawnT0 = -1
      } else {
        const k = easeOutCubic(t)
        out.position.y += (1 - k) * 0.55
        out.scale = 0.8 + 0.2 * k
      }
    }

    out.position.y += e.lift
    return out
  }
}

/** Capture ghost: a piece leaving the board (lift + fade, rendered non-instanced). */
export interface CaptureGhost {
  id: string
  type: string
  color: 'white' | 'black'
  position: THREE.Vector3
  flipAngle: number
  bornAt: number
}

export const GHOST_DUR = 0.6

/** 0..1 progress for a ghost at time `now`; ≥1 means done. */
export function ghostProgress(g: CaptureGhost, now: number): number {
  return (now - g.bornAt) / GHOST_DUR
}
