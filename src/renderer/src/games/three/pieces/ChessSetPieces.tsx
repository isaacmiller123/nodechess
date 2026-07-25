// chessSet piece system. The photoreal Poly Haven chess set (chessSet.ts
// loader): scanned board + per-piece GLB geometries with the native PBR
// photoscan materials. Unlike the procedural systems this one also OWNS the
// board mesh (the scan includes board + frame), so Tabletop3D skips BoardPlane
// for provider.system === 'chessSet'.
//
// Load states:
//   loading  → BoardPlane fallback only (pieces land together with the GLBs;
//              file:// loads settle in well under a second)
//   failed   → BoardPlane + procedural Tokens with piece-letter decals (the
//              renderer must never dead-end; art may be missing in dev runs)
//   loaded   → scanned board aligned to the layout grid + GLB pieces
//
// Pieces are plain meshes (≤ 32 + ghosts; instancing would save nothing) that
// sample MotionController poses per frame, exactly like Tokens. Knights face
// the opponent per color; a whisper of deterministic yaw/offset jitter keeps a
// full board reading hand-placed rather than CAD-perfect.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import {
  loadChessSet,
  pieceTypeFromCode,
  type ChessSetAssets,
  type ChessSetMaterials
} from '../chessSet'
import type { BoardStyle, ChessSetParams } from '../types'
import type { TabletopLayout } from '../layout'
import { BoardPlane } from '../Boards'
import { Tokens } from './Tokens'
import { GhostMesh, cachedJitter, type PieceSystemProps, type PreparedPiece } from './common'

const JIT = { offset: 0.018, tilt: 0, scale: 0.012 }

/** Fallback token look while/if the GLB set is unavailable. */
const FALLBACK_TOKENS = {
  diameter: 0.72,
  thickness: 0.24,
  colors: { white: '#e9dcc0', black: '#4a3a33' }
} as const

function ChessPiece({
  piece,
  geometry,
  material,
  seatYaw,
  controller,
  onPieceOver,
  onPieceOut,
  onPieceDown
}: {
  piece: PreparedPiece
  geometry: THREE.BufferGeometry
  material: THREE.Material
  seatYaw: number
} & Pick<PieceSystemProps, 'controller' | 'onPieceOver' | 'onPieceOut' | 'onPieceDown'>): JSX.Element {
  const ref = useRef<THREE.Mesh>(null)
  const j = cachedJitter(piece.id, JIT)
  // Knights face the opponent (the scan's rest pose faces the -x file axis,
  // hence the -π/2); every other piece is turned a hair for life.
  const baseYaw =
    piece.type.toLowerCase() === 'n'
      ? seatYaw + (piece.color === 'white' ? 0 : Math.PI) - Math.PI / 2 + (j.yaw - Math.PI) * 0.04
      : (j.yaw - Math.PI) * 0.35

  useFrame(() => {
    const mesh = ref.current
    const pose = controller.pose(piece.id)
    if (!mesh || !pose) return
    mesh.position.set(pose.position.x + j.dx, pose.position.y, pose.position.z + j.dz)
    mesh.rotation.set(0, baseYaw, 0)
    mesh.scale.setScalar(j.scale * pose.scale)
  })

  return (
    <mesh
      ref={ref}
      geometry={geometry}
      material={material}
      position={piece.home}
      castShadow
      receiveShadow
      onPointerOver={(e) => onPieceOver?.(piece.id, e)}
      onPointerOut={(e) => onPieceOut?.(piece.id, e)}
      onPointerDown={(e) => onPieceDown?.(piece.id, e)}
    />
  )
}

export function ChessSetSystem(
  props: PieceSystemProps & {
    params?: ChessSetParams
    layout: TabletopLayout
    boardStyle: BoardStyle
  }
): JSX.Element {
  const { layout, boardStyle, artBase } = props
  // undefined = loading, null = failed (procedural fallback), assets = ready.
  const [assets, setAssets] = useState<ChessSetAssets | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    loadChessSet(artBase).then((a) => {
      if (alive) setAssets(a ?? null)
    })
    return () => {
      alive = false
    }
  }, [artBase])

  const variant = props.params?.variant ?? 'marble'
  const materials: ChessSetMaterials | null = useMemo(
    () => (assets ? assets.materials(variant) : null),
    [assets, variant]
  )
  // Materials are per-mount (assets/geometries stay cached in chessSet.ts).
  useEffect(() => {
    if (!materials) return
    return () => {
      materials.white.dispose()
      materials.black.dispose()
      materials.board.dispose()
    }
  }, [materials])

  if (!assets || !materials) {
    return (
      <group>
        <BoardPlane layout={layout} style={boardStyle} artBase={artBase} />
        {assets === null ? <Tokens {...props} params={FALLBACK_TOKENS} /> : null}
      </group>
    )
  }

  const geometryFor = (type: string, color: 'white' | 'black'): THREE.BufferGeometry | null => {
    const t = pieceTypeFromCode(type)
    return t ? assets.geometries[color][t] : null
  }

  // Fairy piece codes (custom variants routed here by mistake) fall back to
  // tokens rather than vanishing.
  const glbPieces = props.pieces.filter((p) => pieceTypeFromCode(p.type) !== null)
  const fairyPieces = props.pieces.filter((p) => pieceTypeFromCode(p.type) === null)

  return (
    <group>
      {/* Scanned board+frame: origin at board center, top surface at
          assets.boardTopY. Quarter-turn corrects checker parity (a1 dark). */}
      <mesh
        geometry={assets.boardGeometry}
        material={materials.board}
        position={[0, layout.boardTopY - assets.boardTopY, 0]}
        rotation-y={Math.PI / 2}
        castShadow
        receiveShadow
      />
      {glbPieces.map((p) => (
        <ChessPiece
          key={p.id}
          piece={p}
          geometry={geometryFor(p.type, p.color)!}
          material={p.color === 'white' ? materials.white : materials.black}
          seatYaw={props.seatYaw}
          controller={props.controller}
          onPieceOver={props.onPieceOver}
          onPieceOut={props.onPieceOut}
          onPieceDown={props.onPieceDown}
        />
      ))}
      {fairyPieces.length > 0 ? (
        <Tokens {...props} pieces={fairyPieces} ghosts={[]} params={FALLBACK_TOKENS} />
      ) : null}
      {props.ghosts.map((g) => {
        const geo = geometryFor(g.type, g.color)
        if (!geo) return null
        return (
          <GhostMesh
            key={g.id}
            ghost={g}
            geometry={geo}
            material={g.color === 'white' ? materials.white : materials.black}
            removeGhost={props.removeGhost}
          />
        )
      })}
    </group>
  )
}
