// disc piece system. Instanced lathe-turned pucks.
//   solid mode: per-instance lacquer colors (checkers, connect-four, morris),
//               optional groove rings + king stacking (type === 'king').
//   twoTone mode: one geometry, light top / dark underside via vertex colors;
//               the shown color is the flip angle (othello flip animation).

import { useMemo, type JSX } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { Instance, Instances } from '@react-three/drei'
import type { DiscParams } from '../types'
import { cachedJitter, GhostMesh, useInstanceRefs, type PieceSystemProps } from './common'

const JIT = { offset: 0.02, tilt: 0.012, scale: 0.015 }

function discProfile(r: number, h: number, grooved: boolean, twoTone: boolean): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [new THREE.Vector2(0.001, 0), new THREE.Vector2(r * 0.86, 0)]
  pts.push(new THREE.Vector2(r * 0.97, h * 0.12))
  pts.push(new THREE.Vector2(r, h * 0.3))
  if (twoTone) {
    // Crisp color seam at mid-rim.
    pts.push(new THREE.Vector2(r, h * 0.498))
    pts.push(new THREE.Vector2(r, h * 0.502))
  }
  pts.push(new THREE.Vector2(r, h * 0.7))
  pts.push(new THREE.Vector2(r * 0.97, h * 0.88))
  pts.push(new THREE.Vector2(r * 0.86, h))
  if (grooved) {
    pts.push(new THREE.Vector2(r * 0.76, h))
    pts.push(new THREE.Vector2(r * 0.72, h * 0.9))
    pts.push(new THREE.Vector2(r * 0.68, h))
    pts.push(new THREE.Vector2(r * 0.56, h))
    pts.push(new THREE.Vector2(r * 0.52, h * 0.91))
    pts.push(new THREE.Vector2(r * 0.48, h))
  }
  pts.push(new THREE.Vector2(0.001, h))
  return pts
}

function discGeometry(r: number, h: number, grooved: boolean, twoTone: boolean, twoToneColors?: { light: string; dark: string }): THREE.LatheGeometry {
  const geo = new THREE.LatheGeometry(discProfile(r, h, grooved, twoTone), 72)
  geo.translate(0, -h / 2, 0)
  geo.computeVertexNormals()
  if (twoTone && twoToneColors) {
    const light = new THREE.Color(twoToneColors.light)
    const dark = new THREE.Color(twoToneColors.dark)
    const pos = geo.attributes.position
    const colors = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const c = pos.getY(i) >= 0 ? light : dark
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  }
  return geo
}

export function Discs(props: PieceSystemProps & { params?: DiscParams }): JSX.Element {
  const p = props.params ?? {}
  const r = (p.diameter ?? 0.78) / 2
  const h = p.thickness ?? 0.21
  const twoTone = Boolean(p.twoTone)
  const colors = p.colors ?? { white: '#ece1c5', black: '#42302a' }

  const geometry = useMemo(
    () => discGeometry(r, h, Boolean(p.grooved), twoTone, p.twoToneColors),
    [r, h, p.grooved, twoTone, p.twoToneColors]
  )
  const material = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: '#ffffff',
        vertexColors: twoTone,
        roughness: 0.3,
        metalness: 0,
        clearcoat: 0.6,
        clearcoatRoughness: 0.28,
        envMapIntensity: 0.8
      }),
    [twoTone]
  )

  const { refs, bind } = useInstanceRefs()

  // Crowns: second stacked disc for kings (solid mode only).
  const crowns = p.kingStacks ? props.pieces.filter((x) => x.type === 'king') : []

  const upright = props.upright
  useFrame(() => {
    for (const piece of props.pieces) {
      const pose = props.controller.pose(piece.id)
      if (!pose) continue
      const j = cachedJitter(piece.id, JIT)
      const inst = refs.get(piece.id)
      if (inst) {
        if (upright) {
          // Standing in the frame: axis along z, centered in the hole plane.
          // Euler XYZ composes Rx·Ry·Rz, so the Y spin turns the disc around
          // its own axis BEFORE Rx stands it up (Z spin would tilt it).
          inst.position.set(pose.position.x, pose.position.y, pose.position.z)
          inst.rotation.set(Math.PI / 2, j.yaw, 0)
          inst.scale.setScalar(pose.scale)
        } else {
          inst.position.set(pose.position.x + j.dx, pose.position.y + h / 2, pose.position.z + j.dz)
          inst.rotation.set(pose.flipAngle + j.tiltX, j.yaw, j.tiltZ)
          inst.scale.setScalar(j.scale * pose.scale)
        }
      }
      if (piece.type === 'king') {
        const crown = refs.get(`${piece.id}#crown`)
        if (crown) {
          const cj = cachedJitter(`${piece.id}#crown`, JIT)
          crown.position.set(
            pose.position.x + j.dx + cj.dx * 0.6,
            pose.position.y + h * 1.46,
            pose.position.z + j.dz + cj.dz * 0.6
          )
          crown.rotation.set(cj.tiltX, cj.yaw, cj.tiltZ)
          crown.scale.setScalar(cj.scale * pose.scale * 0.96)
        }
      }
    }
  })

  const ghostMaterialFor = (color: 'white' | 'black'): THREE.Material => {
    if (twoTone) return material
    const m = material.clone()
    m.color = new THREE.Color(colors[color])
    return m
  }

  return (
    <group>
      <Instances
        geometry={geometry}
        material={material}
        limit={props.capacity + crowns.length + 8}
        castShadow
        receiveShadow
      >
        {props.pieces.map((piece) => (
          <Instance
            key={piece.id}
            ref={bind(piece.id)}
            position={piece.home}
            color={twoTone ? '#ffffff' : colors[piece.color]}
            onPointerOver={(e) => props.onPieceOver?.(piece.id, e)}
            onPointerOut={(e) => props.onPieceOut?.(piece.id, e)}
            onPointerDown={(e) => props.onPieceDown?.(piece.id, e)}
          />
        ))}
        {crowns.map((piece) => (
          <Instance
            key={`${piece.id}#crown`}
            ref={bind(`${piece.id}#crown`)}
            position={[piece.home.x, piece.home.y + h * 1.46, piece.home.z]}
            color={colors[piece.color]}
            onPointerOver={(e) => props.onPieceOver?.(piece.id, e)}
            onPointerOut={(e) => props.onPieceOut?.(piece.id, e)}
            onPointerDown={(e) => props.onPieceDown?.(piece.id, e)}
          />
        ))}
      </Instances>
      {props.ghosts.map((g) => (
        <GhostMesh
          key={g.id}
          ghost={g}
          geometry={geometry}
          material={ghostMaterialFor(g.color)}
          yOffset={h / 2}
          removeGhost={props.removeGhost}
        />
      ))}
    </group>
  )
}
