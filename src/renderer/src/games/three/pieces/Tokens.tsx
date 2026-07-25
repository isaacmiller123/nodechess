// token piece system: turned wooden discs with a recessed face carrying a
// glyph or art decal (xiangqi/janggi/makruk/custom pieces). Per-piece groups
// (small counts) sharing one lathe geometry + material; the decal plane sits
// in the recess.

import { useMemo, useRef, type JSX } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { TokenParams } from '../types'
import { glyphFor, makeGlyphTexture } from './decals'
import { cachedJitter, GhostMesh, type PieceSystemProps, type PreparedPiece } from './common'

const JIT = { offset: 0.02, tilt: 0.008, scale: 0.015 }

function tokenGeometry(r: number, h: number): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0.001, 0),
    new THREE.Vector2(r * 0.9, 0),
    new THREE.Vector2(r, h * 0.22),
    new THREE.Vector2(r, h * 0.78),
    new THREE.Vector2(r * 0.95, h * 0.94),
    new THREE.Vector2(r * 0.86, h), // raised rim
    new THREE.Vector2(r * 0.78, h),
    new THREE.Vector2(r * 0.74, h * 0.88), // recess wall
    new THREE.Vector2(0.001, h * 0.88) // recessed face
  ]
  const geo = new THREE.LatheGeometry(pts, 72)
  geo.computeVertexNormals()
  return geo
}

function Token({
  piece,
  geometry,
  material,
  r,
  h,
  params,
  controller,
  onPieceOver,
  onPieceOut,
  onPieceDown
}: {
  piece: PreparedPiece
  geometry: THREE.BufferGeometry
  material: THREE.Material
  r: number
  h: number
  params: TokenParams
} & Pick<PieceSystemProps, 'controller' | 'onPieceOver' | 'onPieceOut' | 'onPieceDown'>): JSX.Element {
  const group = useRef<THREE.Group>(null)
  const j = cachedJitter(piece.id, JIT)
  const ink = piece.color === 'white' ? '#b3372b' : '#20272d' // red side moves first
  const decal = useMemo(
    () => makeGlyphTexture(glyphFor(params.decalDir, piece.type, piece.color), { ink, ring: ink }),
    [params.decalDir, piece.type, piece.color, ink]
  )

  useFrame(() => {
    const g = group.current
    const pose = controller.pose(piece.id)
    if (!g || !pose) return
    g.position.set(pose.position.x + j.dx, pose.position.y, pose.position.z + j.dz)
    g.rotation.set(j.tiltX, j.yaw * 0.06, j.tiltZ)
    g.scale.setScalar(j.scale * pose.scale)
  })

  return (
    <group ref={group} position={piece.home}>
      <mesh
        geometry={geometry}
        material={material}
        castShadow
        receiveShadow
        onPointerOver={(e) => onPieceOver?.(piece.id, e)}
        onPointerOut={(e) => onPieceOut?.(piece.id, e)}
        onPointerDown={(e) => onPieceDown?.(piece.id, e)}
      />
      <mesh rotation-x={-Math.PI / 2} position={[0, h * 0.88 + 0.003, 0]}>
        <circleGeometry args={[r * 0.72, 48]} />
        <meshStandardMaterial map={decal} transparent roughness={0.5} polygonOffset polygonOffsetFactor={-1} />
      </mesh>
    </group>
  )
}

export function Tokens(props: PieceSystemProps & { params?: TokenParams }): JSX.Element {
  const params = props.params ?? {}
  const r = (params.diameter ?? 0.84) / 2
  const h = params.thickness ?? 0.2
  const geometry = useMemo(() => tokenGeometry(r, h), [r, h])
  const colors = params.colors ?? { white: '#ecd9ac', black: '#e3c791' }
  const materials = useMemo(
    () => ({
      white: new THREE.MeshPhysicalMaterial({
        color: colors.white,
        roughness: 0.4,
        clearcoat: 0.3,
        clearcoatRoughness: 0.4,
        envMapIntensity: 0.6
      }),
      black: new THREE.MeshPhysicalMaterial({
        color: colors.black,
        roughness: 0.4,
        clearcoat: 0.3,
        clearcoatRoughness: 0.4,
        envMapIntensity: 0.6
      })
    }),
    [colors.white, colors.black]
  )
  return (
    <group>
      {props.pieces.map((piece) => (
        <Token
          key={piece.id}
          piece={piece}
          geometry={geometry}
          material={materials[piece.color]}
          r={r}
          h={h}
          params={params}
          controller={props.controller}
          onPieceOver={props.onPieceOver}
          onPieceOut={props.onPieceOut}
          onPieceDown={props.onPieceDown}
        />
      ))}
      {props.ghosts.map((g) => (
        <GhostMesh
          key={g.id}
          ghost={g}
          geometry={geometry}
          material={materials[g.color]}
          removeGhost={props.removeGhost}
        />
      ))}
    </group>
  )
}
