// Board-space ↔ world-space mapping. One world unit = one square/cell.
//
// World frame: origin at board center, +y up, the FIRST-seat player ('white')
// sits toward +z. `orientation: 'black'` mirrors x/z so the black seat faces
// the camera: piece systems add `seatYaw` to keep directional pieces (wedges)
// pointing the right way. 'holes' boards stand upright in the x/y plane.

import * as THREE from 'three'
import type { TabletopBoardShape, TabletopColor, TabletopPos } from './types'

export interface TabletopLayout {
  shape: TabletopBoardShape
  orientation: TabletopColor
  /** Rest height for pieces (top surface of the slab / hole center plane z). */
  boardTopY: number
  /** Border width in cells beyond the playable area (frame/goban margin). */
  margin: number
  /** Overall board width/depth in world units (incl. margin). Camera fitting. */
  width: number
  depth: number
  /** Height of an upright 'holes' frame (0 otherwise). */
  frameHeight: number
  /** π when orientation is 'black' (mirrored world), else 0. */
  seatYaw: number
  center: THREE.Vector3
  worldOf(pos: TabletopPos, out?: THREE.Vector3): THREE.Vector3
  /** Nearest board position for a world point; null when outside (slack: half a cell). */
  posAt(point: THREE.Vector3): TabletopPos | null
}

export interface LayoutOpts {
  slabHeight?: number
  margin?: number
}

export function createLayout(
  shape: TabletopBoardShape,
  orientation: TabletopColor,
  opts: LayoutOpts = {}
): TabletopLayout {
  const { layout, files, ranks } = shape
  const mirror = orientation === 'black' ? -1 : 1
  const seatYaw = orientation === 'black' ? Math.PI : 0

  if (layout === 'holes') {
    const margin = opts.margin ?? 0.62
    const plinthTop = 0.34
    const frameHeight = ranks + margin * 1.4
    const width = files + margin * 2
    const center = new THREE.Vector3(0, plinthTop + frameHeight * 0.48, 0)
    return {
      shape,
      orientation,
      boardTopY: 0,
      margin,
      width,
      depth: 1.6,
      frameHeight,
      seatYaw,
      center,
      worldOf(pos, out = new THREE.Vector3()) {
        return out.set(mirror * (pos.file - (files - 1) / 2), plinthTop + margin * 0.35 + pos.rank + 0.5, 0)
      },
      posAt(point) {
        const file = Math.round(mirror * point.x + (files - 1) / 2)
        const rank = Math.round(point.y - plinthTop - margin * 0.35 - 0.5)
        if (file < 0 || file >= files) return null
        return { file, rank: Math.max(0, Math.min(ranks - 1, rank)) }
      }
    }
  }

  const isCells = layout === 'cells'
  // cells: squares centered on integer+0.5 grid; intersections: pieces ON the lines.
  const playW = isCells ? files : files - 1
  const playD = isCells ? ranks : ranks - 1
  const margin = opts.margin ?? (isCells ? 0.55 : 0.85)
  const slabHeight = opts.slabHeight ?? (isCells ? 0.3 : 0.55)
  const width = playW + margin * 2
  const depth = playD + margin * 2
  const worldX = (file: number): number => mirror * (file - (files - 1) / 2)
  const worldZ = (rank: number): number => mirror * -(rank - (ranks - 1) / 2)

  return {
    shape,
    orientation,
    boardTopY: slabHeight,
    margin,
    width,
    depth,
    frameHeight: 0,
    seatYaw,
    center: new THREE.Vector3(0, slabHeight, 0),
    worldOf(pos, out = new THREE.Vector3()) {
      return out.set(worldX(pos.file), slabHeight, worldZ(pos.rank))
    },
    posAt(point) {
      const fRaw = mirror * point.x + (files - 1) / 2
      const rRaw = -mirror * point.z + (ranks - 1) / 2
      const file = Math.round(fRaw)
      const rank = Math.round(rRaw)
      if (file < 0 || file >= files || rank < 0 || rank >= ranks) return null
      if (Math.abs(fRaw - file) > 0.55 || Math.abs(rRaw - rank) > 0.55) return null
      return { file, rank }
    }
  }
}
