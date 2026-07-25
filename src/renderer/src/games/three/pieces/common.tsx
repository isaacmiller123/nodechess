// Shared piece-system plumbing: prepared-piece shape, instance ref typing,
// deterministic jitter, and the capture ghost (lift + true opacity fade;
// ghosts render non-instanced precisely so they CAN fade).

import { useMemo, useRef, type JSX, type ReactNode } from 'react'
import * as THREE from 'three'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import {
  easeOutCubic,
  ghostProgress,
  type CaptureGhost,
  type MotionController
} from '../animation'
import { hashString, mulberry32 } from '../procedural'
import type { TabletopColor } from '../types'

/** A piece with its world rest position resolved (Tabletop3D prepares these). */
export interface PreparedPiece {
  id: string
  type: string
  color: TabletopColor
  home: THREE.Vector3
  seed: number
}

export interface PieceEvents {
  onPieceOver?(id: string, e: ThreeEvent<PointerEvent>): void
  onPieceOut?(id: string, e: ThreeEvent<PointerEvent>): void
  onPieceDown?(id: string, e: ThreeEvent<PointerEvent>): void
}

export interface PieceSystemProps extends PieceEvents {
  pieces: PreparedPiece[]
  ghosts: CaptureGhost[]
  controller: MotionController
  /** Instance buffer size (≥ max pieces ever shown). */
  capacity: number
  /** π when the world is mirrored for the black seat (directional pieces). */
  seatYaw: number
  /** True on 'holes' boards: discs stand in the x/y plane (axis along z). */
  upright: boolean
  artBase: string | null | undefined
  removeGhost(id: string): void
}

/** drei <Instance> handle: an Object3D whose transform feeds the instanced buffer. */
export type InstanceRef = THREE.Object3D & { color: THREE.Color }

export interface Jitter {
  dx: number
  dz: number
  yaw: number
  tiltX: number
  tiltZ: number
  scale: number
}

/**
 * Deterministic per-piece placement noise, hand-placed feel (spec: subtle
 * randomized rotation/offset). Magnitudes are per-system via `k`.
 */
export function jitterOf(seedStr: string, k: { offset: number; tilt: number; scale: number }): Jitter {
  const rand = mulberry32(hashString(seedStr))
  return {
    dx: (rand() - 0.5) * 2 * k.offset,
    dz: (rand() - 0.5) * 2 * k.offset,
    yaw: rand() * Math.PI * 2,
    tiltX: (rand() - 0.5) * 2 * k.tilt,
    tiltZ: (rand() - 0.5) * 2 * k.tilt,
    scale: 1 + (rand() - 0.5) * 2 * k.scale
  }
}

const jitterCache = new Map<string, Jitter>()

export function cachedJitter(id: string, k: { offset: number; tilt: number; scale: number }): Jitter {
  const key = `${id}|${k.offset}|${k.tilt}|${k.scale}`
  let j = jitterCache.get(key)
  if (!j) {
    j = jitterOf(id, k)
    jitterCache.set(key, j)
  }
  return j
}

/** Registry of live instance refs, keyed by piece id (callback-ref friendly). */
export function useInstanceRefs(): {
  refs: Map<string, InstanceRef>
  bind: (id: string) => (o: InstanceRef | null) => void
} {
  const refs = useRef(new Map<string, InstanceRef>()).current
  const binders = useRef(new Map<string, (o: InstanceRef | null) => void>()).current
  const bind = (id: string): ((o: InstanceRef | null) => void) => {
    let fn = binders.get(id)
    if (!fn) {
      fn = (o: InstanceRef | null) => {
        if (o) refs.set(id, o)
        else refs.delete(id)
      }
      binders.set(id, fn)
    }
    return fn
  }
  return { refs, bind }
}

/** Capture ghost: lifts, shrinks a little and fades out, then self-removes. */
export function GhostMesh({
  ghost,
  geometry,
  material,
  baseScale = 1,
  yOffset = 0,
  removeGhost,
  children
}: {
  ghost: CaptureGhost
  geometry: THREE.BufferGeometry
  material: THREE.Material
  baseScale?: number | [number, number, number]
  yOffset?: number
  removeGhost(id: string): void
  children?: ReactNode
}): JSX.Element {
  const mat = useMemo(() => {
    const m = material.clone()
    m.transparent = true
    m.depthWrite = false
    return m
  }, [material])
  const ref = useRef<THREE.Mesh>(null)
  const done = useRef(false)
  useFrame(({ clock }) => {
    const mesh = ref.current
    if (!mesh) return
    const t = ghostProgress(ghost, clock.elapsedTime)
    if (t >= 1) {
      if (!done.current) {
        done.current = true
        mesh.visible = false
        removeGhost(ghost.id)
      }
      return
    }
    const k = easeOutCubic(Math.max(0, t))
    mesh.position.set(ghost.position.x, ghost.position.y + yOffset + k * 0.9, ghost.position.z)
    mesh.rotation.x = ghost.flipAngle
    const s = 1 - 0.3 * k
    if (Array.isArray(baseScale)) mesh.scale.set(baseScale[0] * s, baseScale[1] * s, baseScale[2] * s)
    else mesh.scale.setScalar(baseScale * s)
    ;(mat as THREE.Material & { opacity: number }).opacity = 1 - k
  })
  return (
    <mesh ref={ref} geometry={geometry} material={mat} position={ghost.position}>
      {children}
    </mesh>
  )
}
