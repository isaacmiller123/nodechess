// goStone piece system: instanced biconvex stones, slate (black) and
// clamshell (white) physical materials. Every stone carries deterministic
// sub-grid offset, yaw and a whisper of tilt so a full board reads hand-placed
// (spec gate: stones must look GOOD, specular slate, randomized pose).

import { useMemo, type JSX } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { Instance, Instances } from '@react-three/drei'
import { useArtPbr } from '../materialHooks'
import type { StoneParams } from '../types'
import {
  cachedJitter,
  GhostMesh,
  useInstanceRefs,
  type PieceSystemProps,
  type PreparedPiece
} from './common'

const JIT = { offset: 0.045, tilt: 0.055, scale: 0.035 }

function stoneGeometry(diameter: number, height: number): THREE.SphereGeometry {
  const geo = new THREE.SphereGeometry(diameter / 2, 48, 32)
  geo.scale(1, height / diameter, 1)
  geo.computeVertexNormals()
  return geo
}

function StoneSet({
  pieces,
  material,
  geometry,
  capacity,
  controller,
  onPieceOver,
  onPieceOut,
  onPieceDown,
  halfHeight
}: {
  pieces: PreparedPiece[]
  material: THREE.Material
  geometry: THREE.BufferGeometry
  capacity: number
  halfHeight: number
} & Pick<PieceSystemProps, 'controller' | 'onPieceOver' | 'onPieceOut' | 'onPieceDown'>): JSX.Element {
  const { refs, bind } = useInstanceRefs()
  useFrame(() => {
    for (const p of pieces) {
      const inst = refs.get(p.id)
      const pose = controller.pose(p.id)
      if (!inst || !pose) continue
      const j = cachedJitter(p.id, JIT)
      inst.position.set(pose.position.x + j.dx, pose.position.y + halfHeight, pose.position.z + j.dz)
      inst.rotation.set(j.tiltX, j.yaw, j.tiltZ)
      inst.scale.setScalar(j.scale * pose.scale)
    }
  })
  return (
    <Instances geometry={geometry} material={material} limit={capacity} castShadow receiveShadow>
      {pieces.map((p) => (
        <Instance
          key={p.id}
          ref={bind(p.id)}
          position={p.home}
          onPointerOver={(e) => onPieceOver?.(p.id, e)}
          onPointerOut={(e) => onPieceOut?.(p.id, e)}
          onPointerDown={(e) => onPieceDown?.(p.id, e)}
        />
      ))}
    </Instances>
  )
}

export function GoStones(props: PieceSystemProps & { params?: StoneParams }): JSX.Element {
  const diameter = props.params?.diameter ?? 0.96
  const height = props.params?.height ?? 0.42
  const slate = useArtPbr('slate', props.artBase, [0.35, 0.35])

  const geometry = useMemo(() => stoneGeometry(diameter, height), [diameter, height])
  const blackMat = useMemo(() => {
    const m = new THREE.MeshPhysicalMaterial({
      color: '#22262b',
      roughness: 0.24,
      metalness: 0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.3,
      envMapIntensity: 1.0
    })
    // Slate PBR (when art is present): faint surface variation, kept subtle.
    if (slate?.normalMap) {
      m.normalMap = slate.normalMap
      m.normalScale = new THREE.Vector2(0.35, 0.35)
    }
    if (slate?.roughnessMap) m.roughnessMap = slate.roughnessMap
    return m
  }, [slate])
  const whiteMat = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: '#f3eede',
        roughness: 0.3,
        metalness: 0,
        clearcoat: 0.35,
        clearcoatRoughness: 0.35,
        envMapIntensity: 0.85
      }),
    []
  )

  const black = props.pieces.filter((p) => p.color === 'black')
  const white = props.pieces.filter((p) => p.color === 'white')
  const halfHeight = height / 2

  return (
    <group>
      <StoneSet
        pieces={black}
        material={blackMat}
        geometry={geometry}
        capacity={props.capacity}
        controller={props.controller}
        onPieceOver={props.onPieceOver}
        onPieceOut={props.onPieceOut}
        onPieceDown={props.onPieceDown}
        halfHeight={halfHeight}
      />
      <StoneSet
        pieces={white}
        material={whiteMat}
        geometry={geometry}
        capacity={props.capacity}
        controller={props.controller}
        onPieceOver={props.onPieceOver}
        onPieceOut={props.onPieceOut}
        onPieceDown={props.onPieceDown}
        halfHeight={halfHeight}
      />
      {props.ghosts.map((g) => (
        <GhostMesh
          key={g.id}
          ghost={g}
          geometry={geometry}
          material={g.color === 'black' ? blackMat : whiteMat}
          yOffset={halfHeight}
          removeGhost={props.removeGhost}
        />
      ))}
    </group>
  )
}
