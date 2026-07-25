// Procedural canvas textures for the 3D tabletop.
//
// Board tops are baked into a single canvas (checker veneer, goban line grid,
// felt) so lines are anti-aliased and never z-fight. When games-art PBR color
// maps are available they are composited as the veneer source; otherwise a
// procedural wood grain is synthesized from the style color. The renderer
// must look GOOD standalone (spec: visual bar is paramount and gating).

import * as THREE from 'three'
import type { TabletopPos } from './types'

/** Deterministic 32-bit string hash (piece jitter seeds, veneer offsets). */
export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** mulberry32 PRNG. Tiny, deterministic, good enough for jitter. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Synthesized wood grain: base fill, low-frequency column tinting, wandering
 * darker grain streaks, fine speckle. Grain runs vertically.
 */
export function makeWoodGrainCanvas(size: number, base: string, seed = 7): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const rand = mulberry32(seed)
  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size)

  // Low-frequency plank-tone bands.
  const f1 = 0.9 + rand() * 0.5
  const f2 = 3.1 + rand() * 1.2
  for (let x = 0; x < size; x++) {
    const u = x / size
    const t = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * f1 + rand() * 0.02) * 0.8 + 0.2 * Math.sin(u * Math.PI * 2 * f2)
    const a = 0.05 * (t - 0.5)
    ctx.fillStyle = a > 0 ? `rgba(255,244,220,${a})` : `rgba(40,20,5,${-a})`
    ctx.fillRect(x, 0, 1, size)
  }

  // Wandering grain streaks.
  const streaks = 46
  for (let i = 0; i < streaks; i++) {
    const x0 = rand() * size
    const wobble = 6 + rand() * 22
    const period = size / (1.2 + rand() * 2.4)
    const phase = rand() * Math.PI * 2
    const alpha = 0.035 + rand() * 0.075
    ctx.strokeStyle = rand() < 0.75 ? `rgba(55,32,10,${alpha})` : `rgba(255,240,210,${alpha * 0.8})`
    ctx.lineWidth = 0.6 + rand() * 1.8
    ctx.beginPath()
    for (let y = 0; y <= size; y += 6) {
      const x = x0 + Math.sin((y / period) * Math.PI * 2 + phase) * wobble
      if (y === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  // Fine speckle.
  for (let i = 0; i < size * 3; i++) {
    const x = rand() * size
    const y = rand() * size
    ctx.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.03)'
    ctx.fillRect(x, y, 1, 1 + rand() * 2)
  }
  return canvas
}

/** Felt/cloth: base color, speckle noise, soft vignette. Tileable enough at distance. */
export function makeFeltCanvas(size: number, base: string, seed = 3): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const rand = mulberry32(seed)
  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < size * 24; i++) {
    const x = rand() * size
    const y = rand() * size
    ctx.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.022)' : 'rgba(0,0,0,0.03)'
    ctx.fillRect(x, y, 1, 1)
  }
  return canvas
}

export type VeneerSource = HTMLCanvasElement | HTMLImageElement

/** Draw a random rotated/mirrored crop of `src` into the current square, per-square veneer variety. */
function drawVeneerCell(
  ctx: CanvasRenderingContext2D,
  src: VeneerSource,
  x: number,
  y: number,
  cell: number,
  rand: () => number
): void {
  const sw = 'width' in src ? src.width : 0
  const crop = Math.min(sw, Math.max(64, Math.floor(sw * (0.4 + rand() * 0.35))))
  const sx = rand() * (sw - crop)
  const sy = rand() * (sw - crop)
  ctx.save()
  ctx.translate(x + cell / 2, y + cell / 2)
  ctx.rotate((Math.floor(rand() * 4) * Math.PI) / 2)
  if (rand() < 0.5) ctx.scale(-1, 1)
  ctx.drawImage(src, sx, sy, crop, crop, -cell / 2, -cell / 2, cell, cell)
  ctx.restore()
}

export interface CellsCanvasOpts {
  files: number
  ranks: number
  light: { color: string; src: VeneerSource | null }
  /** Present = checkered; absent = solid top (othello/shogi) using `light`. */
  dark?: { color: string; src: VeneerSource | null }
  /** Seam/grid line color (defaults to translucent black). */
  lineColor?: string
  seed?: number
}

/** Checkered or solid-with-seams cells board top. Canvas spans exactly files×ranks squares. */
export function makeCellsCanvas(opts: CellsCanvasOpts): HTMLCanvasElement {
  const { files, ranks } = opts
  const cell = Math.max(48, Math.min(220, Math.floor(2048 / Math.max(files, ranks))))
  const canvas = document.createElement('canvas')
  canvas.width = cell * files
  canvas.height = cell * ranks
  const ctx = canvas.getContext('2d')!
  const rand = mulberry32(opts.seed ?? 11)

  const lightSrc = opts.light.src ?? makeWoodGrainCanvas(512, opts.light.color, 21)
  const darkSrc = opts.dark ? (opts.dark.src ?? makeWoodGrainCanvas(512, opts.dark.color, 22)) : null

  for (let r = 0; r < ranks; r++) {
    for (let f = 0; f < files; f++) {
      const isDark = opts.dark ? (f + r) % 2 === 0 : false
      const x = f * cell
      const y = (ranks - 1 - r) * cell
      if (isDark && darkSrc) drawVeneerCell(ctx, darkSrc, x, y, cell, rand)
      else drawVeneerCell(ctx, lightSrc, x, y, cell, rand)
      // Gentle per-square tone shift so no two squares read identical.
      const tone = (rand() - 0.5) * 0.07
      ctx.fillStyle = tone > 0 ? `rgba(255,250,240,${tone})` : `rgba(20,10,0,${-tone})`
      ctx.fillRect(x, y, cell, cell)
      // Edge darkening: reads as square bevel from a distance.
      const g = ctx.createLinearGradient(x, y, x, y + cell)
      g.addColorStop(0, 'rgba(255,255,255,0.05)')
      g.addColorStop(0.12, 'rgba(255,255,255,0)')
      g.addColorStop(0.9, 'rgba(0,0,0,0)')
      g.addColorStop(1, 'rgba(0,0,0,0.07)')
      ctx.fillStyle = g
      ctx.fillRect(x, y, cell, cell)
    }
  }

  // Seams between squares.
  ctx.strokeStyle = opts.lineColor ?? 'rgba(15,10,5,0.4)'
  ctx.lineWidth = Math.max(1.5, cell * 0.014)
  ctx.beginPath()
  for (let f = 0; f <= files; f++) {
    const x = Math.min(canvas.width - 1, Math.max(1, f * cell))
    ctx.moveTo(x, 0)
    ctx.lineTo(x, canvas.height)
  }
  for (let r = 0; r <= ranks; r++) {
    const y = Math.min(canvas.height - 1, Math.max(1, r * cell))
    ctx.moveTo(0, y)
    ctx.lineTo(canvas.width, y)
  }
  ctx.stroke()
  return canvas
}

export interface IntersectionsCanvasOpts {
  files: number
  ranks: number
  /** Margin around the outer lines, in cells (goban border). */
  margin: number
  top: { color: string; src: VeneerSource | null }
  lineColor: string
  starPoints: TabletopPos[]
  seed?: number
}

/** Line-grid board top (goban). Canvas spans (files-1+2*margin) × (ranks-1+2*margin) cells. */
export function makeIntersectionsCanvas(opts: IntersectionsCanvasOpts): HTMLCanvasElement {
  const cellsW = opts.files - 1 + opts.margin * 2
  const cellsH = opts.ranks - 1 + opts.margin * 2
  const cell = Math.max(48, Math.min(200, Math.floor(2048 / Math.max(cellsW, cellsH))))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(cell * cellsW)
  canvas.height = Math.round(cell * cellsH)
  const ctx = canvas.getContext('2d')!

  const src = opts.top.src ?? makeWoodGrainCanvas(1024, opts.top.color, opts.seed ?? 31)
  // Stretch the veneer across the whole top: a goban is one solid block.
  ctx.drawImage(src, 0, 0, 'width' in src ? src.width : 1024, 'width' in src ? src.height : 1024, 0, 0, canvas.width, canvas.height)

  const px = (fileIdx: number): number => (opts.margin + fileIdx) * cell
  const py = (rankIdx: number): number => canvas.height - (opts.margin + rankIdx) * cell

  ctx.strokeStyle = opts.lineColor
  ctx.lineWidth = Math.max(1.6, cell * 0.045)
  ctx.lineCap = 'square'
  ctx.beginPath()
  for (let f = 0; f < opts.files; f++) {
    ctx.moveTo(px(f), py(0))
    ctx.lineTo(px(f), py(opts.ranks - 1))
  }
  for (let r = 0; r < opts.ranks; r++) {
    ctx.moveTo(px(0), py(r))
    ctx.lineTo(px(opts.files - 1), py(r))
  }
  ctx.stroke()

  // Slightly heavier outer border (traditional goban).
  ctx.lineWidth = Math.max(2.4, cell * 0.075)
  ctx.strokeRect(px(0), py(opts.ranks - 1), px(opts.files - 1) - px(0), py(0) - py(opts.ranks - 1))

  ctx.fillStyle = opts.lineColor
  for (const sp of opts.starPoints) {
    ctx.beginPath()
    ctx.arc(px(sp.file), py(sp.rank), Math.max(3, cell * 0.115), 0, Math.PI * 2)
    ctx.fill()
  }

  // Soft vignette keeps the slab from reading flat.
  const vg = ctx.createRadialGradient(
    canvas.width / 2,
    canvas.height / 2,
    Math.min(canvas.width, canvas.height) * 0.35,
    canvas.width / 2,
    canvas.height / 2,
    Math.max(canvas.width, canvas.height) * 0.75
  )
  vg.addColorStop(0, 'rgba(0,0,0,0)')
  vg.addColorStop(1, 'rgba(30,15,0,0.12)')
  ctx.fillStyle = vg
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  return canvas
}

/** Standard hoshi for square go boards; sensible center point otherwise. */
export function autoStarPoints(files: number, ranks: number): TabletopPos[] {
  if (files !== ranks) return []
  const n = files
  if (n === 19 || n === 15) {
    const a = 3
    const b = n - 4
    const m = (n - 1) / 2
    return [a, m, b].flatMap((f) => [a, m, b].map((r) => ({ file: f, rank: r })))
  }
  if (n === 13) {
    const pts: TabletopPos[] = [3, 9].flatMap((f) => [3, 9].map((r) => ({ file: f, rank: r })))
    pts.push({ file: 6, rank: 6 })
    return pts
  }
  if (n === 9) {
    const pts: TabletopPos[] = [2, 6].flatMap((f) => [2, 6].map((r) => ({ file: f, rank: r })))
    pts.push({ file: 4, rank: 4 })
    return pts
  }
  return []
}

/** Wrap a canvas as an sRGB three texture. */
export function canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}
