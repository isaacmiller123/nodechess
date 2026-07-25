// wedge piece system. Shogi koma: five-sided boxwood prism lying flat, tip
// toward the opponent, glyph/art decal on the face. Piece counts are small
// (≤40), so wedges render as per-piece groups sharing one geometry+material.
// The decal plane rides the same transform for free. (High-count systems,
// stones/discs, are the instanced ones.)

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { TabletopColor, WedgeParams } from '../types'
import { glyphFor, loadArtDecal, makeGlyphTexture } from './decals'
import { cachedJitter, GhostMesh, type PieceSystemProps, type PreparedPiece } from './common'

const JIT = { offset: 0.03, tilt: 0.008, scale: 0.012 }

function komaGeometry(w: number): { geo: THREE.ExtrudeGeometry; length: number; thickness: number } {
  const l = w * 1.12
  const t = w * 0.22
  const shape = new THREE.Shape()
  shape.moveTo(-w / 2, 0)
  shape.lineTo(w / 2, 0)
  shape.lineTo(w * 0.4, l * 0.74)
  shape.lineTo(0, l)
  shape.lineTo(-w * 0.4, l * 0.74)
  shape.closePath()
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: t,
    bevelEnabled: true,
    bevelSize: w * 0.035,
    bevelThickness: t * 0.22,
    bevelSegments: 2
  })
  // Shape-space: +y toward the tip, extrude along +z. Lay it flat: tip → -z,
  // thickness → +y, centered underfoot.
  geo.translate(0, -l / 2, -t / 2)
  geo.rotateX(-Math.PI / 2)
  return { geo, length: l, thickness: t + t * 0.22 }
}

function useDecalTexture(
  decalDir: string | undefined,
  type: string,
  color: TabletopColor,
  artBase: string | null | undefined
): THREE.Texture {
  const promoted = type.startsWith('+')
  const fallback = useMemo(
    () => makeGlyphTexture(glyphFor(decalDir, type, color), { ink: promoted ? '#a8271d' : '#241407' }),
    [decalDir, type, color, promoted]
  )
  const [tex, setTex] = useState<THREE.Texture>(fallback)
  useEffect(() => {
    setTex(fallback)
    if (!decalDir) return undefined
    let alive = true
    loadArtDecal(decalDir, type, color, artBase).then((t) => {
      if (alive && t) setTex(t)
    })
    return () => {
      alive = false
    }
  }, [decalDir, type, color, artBase, fallback])
  return tex
}

function Wedge({
  piece,
  geometry,
  material,
  dims,
  params,
  seatYaw,
  controller,
  artBase,
  onPieceOver,
  onPieceOut,
  onPieceDown
}: {
  piece: PreparedPiece
  geometry: THREE.BufferGeometry
  material: THREE.Material
  dims: { length: number; thickness: number }
  params: WedgeParams
} & Pick<
  PieceSystemProps,
  'seatYaw' | 'controller' | 'artBase' | 'onPieceOver' | 'onPieceOut' | 'onPieceDown'
>): JSX.Element {
  const group = useRef<THREE.Group>(null)
  const decal = useDecalTexture(params.decalDir, piece.type, piece.color, artBase)
  const j = cachedJitter(piece.id, JIT)
  const yaw = seatYaw + (piece.color === 'black' ? Math.PI : 0) + (j.dx * 1.5)

  useFrame(() => {
    const g = group.current
    const pose = controller.pose(piece.id)
    if (!g || !pose) return
    g.position.set(pose.position.x + j.dx, pose.position.y, pose.position.z + j.dz)
    g.rotation.set(j.tiltX, yaw, j.tiltZ)
    g.scale.setScalar(j.scale * pose.scale)
  })

  const w = params.width ?? 0.68
  return (
    <group ref={group} position={piece.home} rotation-y={yaw}>
      <mesh
        geometry={geometry}
        material={material}
        castShadow
        receiveShadow
        onPointerOver={(e) => onPieceOver?.(piece.id, e)}
        onPointerOut={(e) => onPieceOut?.(piece.id, e)}
        onPointerDown={(e) => onPieceDown?.(piece.id, e)}
      />
      <mesh rotation-x={-Math.PI / 2} position={[0, dims.thickness + 0.004, dims.length * 0.06]}>
        <planeGeometry args={[w * 0.72, dims.length * 0.72]} />
        <meshStandardMaterial map={decal} transparent roughness={0.5} polygonOffset polygonOffsetFactor={-1} />
      </mesh>
    </group>
  )
}

export function Wedges(props: PieceSystemProps & { params?: WedgeParams }): JSX.Element {
  const params = props.params ?? {}
  const w = params.width ?? 0.68
  const { geo, length, thickness } = useMemo(() => komaGeometry(w), [w])
  const material = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: '#e9c98f', // boxwood
        roughness: 0.42,
        metalness: 0,
        clearcoat: 0.25,
        clearcoatRoughness: 0.4,
        envMapIntensity: 0.6
      }),
    []
  )
  return (
    <group>
      {props.pieces.map((piece) => (
        <Wedge
          key={piece.id}
          piece={piece}
          geometry={geo}
          material={material}
          dims={{ length, thickness }}
          params={params}
          seatYaw={props.seatYaw}
          controller={props.controller}
          artBase={props.artBase}
          onPieceOver={props.onPieceOver}
          onPieceOut={props.onPieceOut}
          onPieceDown={props.onPieceDown}
        />
      ))}
      {props.ghosts.map((g) => (
        <GhostMesh
          key={g.id}
          ghost={g}
          geometry={geo}
          material={material}
          removeGhost={props.removeGhost}
        />
      ))}
    </group>
  )
}
