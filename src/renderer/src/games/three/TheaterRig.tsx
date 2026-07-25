// Replay Theater rig: cinematic camera + scaled scene clock.
//
// Mounted by Tabletop3D INSTEAD of CameraRig when a `theater` directive is
// supplied: no OrbitControls, the camera belongs to the choreography
// (games/three/theater.ts pure envelopes). Runs at priority −10 so the clock
// overwrite lands BEFORE TabletopScene's motion tick (−1) and every piece
// system's pose sampling (0): all of them read `clock.elapsedTime`, so scaling
// it here puts the existing slide / lift-fade / flip animations into slow
// motion during capture emphasis with zero changes to the animation code.

import { useRef, type JSX } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { TabletopLayout } from './layout'
import {
  FINALE_ORBIT_FACTOR,
  dollyAt,
  orbitPhiAt,
  orbitThetaAt,
  pullAt,
  smoothK,
  sphericalToVec,
  theaterRadius,
  timeScaleAt,
  type TheaterDirective
} from './theater'

interface TheaterRigProps {
  directive: { current: TheaterDirective }
  layout: TabletopLayout
  span: number
  upright: boolean
}

interface RigState {
  /** Scaled scene-clock seconds (what every elapsedTime consumer sees). */
  scaled: number
  /** Orbit phase (scaled seconds, additionally damped by pause/finale). */
  phase: number
  radiusK: number
  pull: number
  focusWorld: THREE.Vector3
  focusSmooth: THREE.Vector3
  target: THREE.Vector3
}

export function TheaterRig({ directive, layout, span, upright }: TheaterRigProps): JSX.Element | null {
  const st = useRef<RigState | null>(null)
  if (!st.current) {
    st.current = {
      scaled: 0,
      phase: 0,
      radiusK: 1,
      pull: 0,
      focusWorld: layout.center.clone(),
      focusSmooth: layout.center.clone(),
      target: layout.center.clone()
    }
  }

  useFrame((state, delta) => {
    const s = st.current!
    const d = directive.current
    const dt = Math.min(0.1, Math.max(0, delta))
    const sinceMs = d.shot ? performance.now() - d.shot.atMs : Infinity
    const capture = d.shot?.capture ?? false

    // Scene clock: slow-mo through capture shots; REAL time while paused so
    // scrub-driven slides still glide (pausing freezes the orbit, not physics).
    const scale = d.paused ? 1 : timeScaleAt(sinceMs, capture, d.speed)
    s.scaled += dt * scale
    state.clock.elapsedTime = s.scaled

    // Orbit phase: stops with pause, halves for the finale hold, and naturally
    // breathes with the slow-mo (it advances in scaled time).
    s.phase += dt * scale * (d.paused ? 0 : d.finale ? FINALE_ORBIT_FACTOR : 1)

    // Framing envelopes → smoothed camera channels.
    const k = smoothK(dt, 0.16)
    s.radiusK += ((d.paused ? 1 : dollyAt(sinceMs, capture, d.speed)) - s.radiusK) * k
    s.pull += ((d.paused || d.finale ? 0 : pullAt(sinceMs, capture, d.speed)) - s.pull) * k
    if (d.shot?.focus) layout.worldOf(d.shot.focus, s.focusWorld)
    s.focusSmooth.lerp(s.focusWorld, smoothK(dt, 0.22))
    s.target.lerpVectors(layout.center, s.focusSmooth, s.pull)

    const radius = theaterRadius(span) * s.radiusK
    const theta = orbitThetaAt(s.phase, upright)
    const phi = orbitPhiAt(s.phase, upright)
    const p = sphericalToVec(radius, phi, theta)
    state.camera.position.set(p.x + s.target.x, p.y + s.target.y, p.z + s.target.z)
    state.camera.lookAt(s.target)
  }, -10)

  return null
}
