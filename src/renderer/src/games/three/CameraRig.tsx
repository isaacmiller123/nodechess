// Camera presets + clamped smooth orbit.
//   default: 35° elevation behind the player's seat, gentle settle-in on mount
//   topDown: near-vertical reading view (toggle animates between the two)
// Orbit stays inside sane tabletop bounds (never under the table, no pan).

import { useEffect, useRef, type JSX } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { easeInOutCubic } from './animation'

const PRESET_DUR = 0.85

interface CameraRigProps {
  center: THREE.Vector3
  /** Largest board dimension in world units. Drives distances. */
  span: number
  topDown: boolean
  /** Upright boards (connect four) get a lower, more frontal default. */
  upright: boolean
  /** False while a piece drag is in progress. */
  enabled: boolean
}

// The camera always sits at azimuth 0, the user's seat. Board orientation is
// handled entirely by the layout (world mirror + piece seatYaw); giving the
// orientation to the camera as well would cancel the mirror out.
function presetSpherical(props: CameraRigProps): THREE.Spherical {
  const { span, topDown, upright } = props
  if (topDown) return new THREE.Spherical(span * 1.3 + 1.2, 0.08, 0)
  if (upright) return new THREE.Spherical(span * 1.7 + 1.2, 1.28, 0)
  // 35° elevation → polar 55° from the up axis.
  return new THREE.Spherical(span * 1.38 + 1.2, (55 * Math.PI) / 180, 0)
}

export function CameraRig(props: CameraRigProps): JSX.Element {
  const { center, span, topDown, upright, enabled } = props
  const camera = useThree((s) => s.camera)
  const controls = useRef<OrbitControlsImpl | null>(null)
  const anim = useRef<{ t0: number; from: THREE.Spherical; to: THREE.Spherical } | null>(null)
  const mounted = useRef(false)

  // Preset transitions (and the mount settle-in).
  useEffect(() => {
    const to = presetSpherical(props)
    let from: THREE.Spherical
    if (!mounted.current) {
      mounted.current = true
      from = to.clone()
      from.radius *= 1.16
      from.phi = Math.max(0.05, from.phi - 0.22)
      camera.position.setFromSpherical(from).add(center)
      camera.lookAt(center)
    } else {
      from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(center))
    }
    anim.current = { t0: -1, from, to }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rerun on preset inputs only
  }, [topDown, upright, span, camera])

  useFrame(({ clock }) => {
    const a = anim.current
    const c = controls.current
    if (!a) return
    if (a.t0 < 0) a.t0 = clock.elapsedTime
    const t = (clock.elapsedTime - a.t0) / PRESET_DUR
    const k = easeInOutCubic(Math.min(1, t))
    // Shortest-path azimuth.
    let dTheta = a.to.theta - a.from.theta
    if (dTheta > Math.PI) dTheta -= Math.PI * 2
    if (dTheta < -Math.PI) dTheta += Math.PI * 2
    const sph = new THREE.Spherical(
      a.from.radius + (a.to.radius - a.from.radius) * k,
      a.from.phi + (a.to.phi - a.from.phi) * k,
      a.from.theta + dTheta * k
    )
    camera.position.setFromSpherical(sph).add(center)
    camera.lookAt(center)
    if (c) c.enabled = false
    if (t >= 1) {
      anim.current = null
      if (c) {
        c.enabled = enabled
        c.update()
      }
    }
  })

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      target={center}
      enabled={enabled && !anim.current}
      enableDamping
      dampingFactor={0.08}
      enablePan={false}
      rotateSpeed={0.7}
      minDistance={span * 0.85}
      maxDistance={span * 3}
      minPolarAngle={0.05}
      maxPolarAngle={upright ? 1.5 : 1.25}
    />
  )
}
