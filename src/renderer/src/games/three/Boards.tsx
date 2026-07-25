// Board-plane generators. Spec §3D: 'cells' checkered/solid slab with beveled
// frame, 'intersections' line-grid goban block, 'holes' upright connect-four
// frame on a plinth. Tops are baked canvases (procedural.ts) so lines stay
// crisp; slabs/frames are real beveled geometry so edges catch the key light.

import { useMemo, type JSX } from 'react'
import * as THREE from 'three'
import { RoundedBox } from '@react-three/drei'
import type { TabletopLayout } from './layout'
import type { BoardStyle } from './types'
import {
  autoStarPoints,
  canvasTexture,
  makeCellsCanvas,
  makeFeltCanvas,
  makeIntersectionsCanvas,
  makeWoodGrainCanvas,
  type VeneerSource
} from './procedural'
import { useArtPbr, veneerImage } from './materialHooks'

interface BoardProps {
  layout: TabletopLayout
  style: BoardStyle
  artBase: string | null | undefined
}

function fallbackVeneer(color: string, wantsWood: boolean, seed: number): VeneerSource {
  return wantsWood ? makeWoodGrainCanvas(512, color, seed) : makeFeltCanvas(512, color, seed)
}

/**
 * Frame/side material: art wood when available, tinted rough fallback
 * otherwise. Built imperatively and re-created when the maps arrive. Adding a
 * map to a live material would need a shader recompile (needsUpdate), a fresh
 * material sidesteps the whole class of bug.
 */
function FrameMaterial({ style, artBase }: { style: BoardStyle; artBase: string | null | undefined }): JSX.Element {
  const maps = useArtPbr(style.frameTexture, artBase, [2, 2])
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: maps ? '#e8ddcf' : style.frameColor,
        map: maps?.map ?? null,
        normalMap: maps?.normalMap ?? null,
        roughnessMap: maps?.roughnessMap ?? null,
        roughness: 0.55,
        metalness: 0,
        envMapIntensity: 0.5
      }),
    [maps, style.frameColor]
  )
  return <primitive object={material} attach="material" />
}

/** NxM checkered (or solid-with-seams) slab with a beveled frame border. */
export function CellsBoard({ layout, style, artBase }: BoardProps): JSX.Element {
  const { files, ranks } = layout.shape
  const lightArt = useArtPbr(style.topTexture, artBase)
  const darkArt = useArtPbr(style.checkerTexture, artBase)

  const topTex = useMemo(() => {
    const lightImg = veneerImage(lightArt)
    const darkImg = veneerImage(darkArt)
    const canvas = makeCellsCanvas({
      files,
      ranks,
      light: {
        color: style.topColor,
        src: lightImg ?? fallbackVeneer(style.topColor, Boolean(style.topTexture), 21)
      },
      dark: style.checkerColor
        ? {
            color: style.checkerColor,
            src: darkImg ?? fallbackVeneer(style.checkerColor, Boolean(style.checkerTexture), 22)
          }
        : undefined,
      lineColor: style.lineColor
    })
    return canvasTexture(canvas)
  }, [files, ranks, style, lightArt, darkArt])

  const slabH = layout.boardTopY
  return (
    <group>
      <RoundedBox
        args={[layout.width, slabH, layout.depth]}
        radius={Math.min(0.07, slabH * 0.3)}
        smoothness={4}
        position={[0, slabH / 2, 0]}
        castShadow
        receiveShadow
      >
        <FrameMaterial style={style} artBase={artBase} />
      </RoundedBox>
      <mesh rotation-x={-Math.PI / 2} position={[0, slabH + 0.002, 0]} receiveShadow>
        <planeGeometry args={[files, ranks]} />
        <meshStandardMaterial map={topTex} roughness={0.42} metalness={0} envMapIntensity={0.65} />
      </mesh>
    </group>
  )
}

/** Line-grid goban block (go/gomoku/xiangqi-ish). Whole top is one veneer canvas. */
export function IntersectionsBoard({ layout, style, artBase }: BoardProps): JSX.Element {
  const { files, ranks } = layout.shape
  const topArt = useArtPbr(style.topTexture, artBase)

  const { topTex, sideTex } = useMemo(() => {
    const img = veneerImage(topArt)
    const src = img ?? makeWoodGrainCanvas(1024, style.topColor, 31)
    const stars =
      style.starPoints === 'auto' ? autoStarPoints(files, ranks) : (style.starPoints ?? [])
    const canvas = makeIntersectionsCanvas({
      files,
      ranks,
      margin: layout.margin,
      top: { color: style.topColor, src },
      lineColor: style.lineColor ?? '#3b2a12',
      starPoints: stars
    })
    // Sides carry the SAME veneer as the top (a goban is one solid block).
    // Procedural amber next to pale art veneer reads as mismatched plastic.
    let sideSrc: HTMLCanvasElement
    if (src instanceof HTMLCanvasElement) {
      sideSrc = src
    } else {
      sideSrc = document.createElement('canvas')
      sideSrc.width = 512
      sideSrc.height = 512
      sideSrc.getContext('2d')!.drawImage(src, 0, 0, 512, 512)
    }
    const side = canvasTexture(sideSrc)
    side.repeat.set(2, 1)
    return { topTex: canvasTexture(canvas), sideTex: side }
  }, [files, ranks, style, layout.margin, topArt])

  const slabH = layout.boardTopY
  return (
    <group>
      <RoundedBox
        args={[layout.width, slabH, layout.depth]}
        radius={0.05}
        smoothness={4}
        position={[0, slabH / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial
          map={sideTex}
          color="#cdbb9b"
          roughness={0.5}
          metalness={0}
          envMapIntensity={0.5}
        />
      </RoundedBox>
      <mesh rotation-x={-Math.PI / 2} position={[0, slabH + 0.002, 0]} receiveShadow>
        <planeGeometry args={[layout.width, layout.depth]} />
        <meshStandardMaterial map={topTex} roughness={0.45} metalness={0} envMapIntensity={0.7} />
      </mesh>
    </group>
  )
}

/** Upright connect-four frame: plinth, pillars, hole-punched beveled front. */
export function HolesBoard({ layout, style }: BoardProps): JSX.Element {
  const { files, ranks } = layout.shape

  const frameGeo = useMemo(() => {
    const w = layout.width
    const bottom = 0.22 // sunk into the plinth
    const top = 0.34 + layout.frameHeight
    const r = 0.18
    const shape = new THREE.Shape()
    shape.moveTo(-w / 2 + r, bottom)
    shape.lineTo(w / 2 - r, bottom)
    shape.quadraticCurveTo(w / 2, bottom, w / 2, bottom + r)
    shape.lineTo(w / 2, top - r)
    shape.quadraticCurveTo(w / 2, top, w / 2 - r, top)
    shape.lineTo(-w / 2 + r, top)
    shape.quadraticCurveTo(-w / 2, top, -w / 2, top - r)
    shape.lineTo(-w / 2, bottom + r)
    shape.quadraticCurveTo(-w / 2, bottom, -w / 2 + r, bottom)
    const v = new THREE.Vector3()
    for (let f = 0; f < files; f++) {
      for (let k = 0; k < ranks; k++) {
        layout.worldOf({ file: f, rank: k }, v)
        const hole = new THREE.Path()
        hole.absarc(v.x, v.y, 0.375, 0, Math.PI * 2, true)
        shape.holes.push(hole)
      }
    }
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.26,
      bevelEnabled: true,
      bevelSize: 0.025,
      bevelThickness: 0.02,
      bevelSegments: 3,
      curveSegments: 28
    })
    geo.translate(0, 0, -0.13)
    return geo
  }, [layout, files, ranks])

  const plastic = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: style.frameColor,
        roughness: 0.32,
        metalness: 0,
        clearcoat: 0.9,
        clearcoatRoughness: 0.22,
        envMapIntensity: 0.8
      }),
    [style.frameColor]
  )

  const pillarH = layout.frameHeight + 0.55
  return (
    <group>
      {/* plinth */}
      <RoundedBox
        args={[layout.width + 1.5, 0.34, 2.1]}
        radius={0.08}
        smoothness={4}
        position={[0, 0.17, 0]}
        castShadow
        receiveShadow
      >
        <primitive object={plastic} attach="material" />
      </RoundedBox>
      {/* side pillars */}
      {[-1, 1].map((s) => (
        <RoundedBox
          key={s}
          args={[0.42, pillarH, 0.66]}
          radius={0.08}
          smoothness={4}
          position={[s * (layout.width / 2 + 0.08), 0.3 + pillarH / 2, 0]}
          castShadow
          receiveShadow
        >
          <primitive object={plastic} attach="material" />
        </RoundedBox>
      ))}
      {/* hole-punched face */}
      <mesh geometry={frameGeo} material={plastic} castShadow receiveShadow />
    </group>
  )
}

/** Dispatch on layout kind. */
export function BoardPlane(props: BoardProps): JSX.Element {
  switch (props.layout.shape.layout) {
    case 'cells':
      return <CellsBoard {...props} />
    case 'intersections':
      return <IntersectionsBoard {...props} />
    case 'holes':
      return <HolesBoard {...props} />
  }
}
