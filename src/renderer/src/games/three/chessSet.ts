// Photoreal chess set loader, Poly Haven "Chess Set" (CC0, Riley Queen),
// repackaged by scripts/prep-chess3d.mjs into resources/games-art/chess3d/
// (per-piece geometry GLBs + shared PBR JPEG sets + manifest.json; ≤15MB).
//
// INTEGRATION NOTES (for the 'glb' piece system completing three/providers.ts):
// - Call `loadChessSet(artBaseUrl)` (same base-URL semantics as artLoader.ts;
//   null result = keep the procedural/2D fallback. Never throw to the UI).
// - Geometries are returned ALREADY SCALED to tabletop world units
//   (1 unit = 1 board square, per types.ts BoardStyle.slabHeight convention),
//   origin at the piece's base center: place a piece at
//   position=(fileX, boardTopY, rankZ) with no extra scaling. King height
//   ≈ 1.64 units. `board` is the full scanned board+frame (8 squares of
//   playfield, frame beyond ±4); its origin is the board center with the top
//   surface at y = boardTopY.
// - Materials: `materials(variant)` builds a fresh trio per call
//   ('marble' = native photoscan maps, 'wood' = warm recolor of the same maps).
//   Callers own disposal of what they create; `dispose()` tears down the
//   shared geometries/textures.
// - Piece code mapping: kernel piece chars 'k','q','r','b','n','p' (any case)
//   → ChessPieceType via `pieceTypeFromCode`.
//
// If the provider contract gains a dedicated GLB shape, keep this module the
// single owner of manifest/file names: they must stay in sync with
// scripts/prep-chess3d.mjs.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { resolveGamesArtUrl } from './artLoader'
import type { TabletopColor } from './types'

export type ChessPieceType = 'king' | 'queen' | 'rook' | 'bishop' | 'knight' | 'pawn'

/** 'marble' = the native Poly Haven photoscan look; 'wood' = warm recolor variant. */
export type ChessSetVariant = 'marble' | 'wood'

export const CHESS_PIECE_TYPES: readonly ChessPieceType[] = [
  'king',
  'queen',
  'rook',
  'bishop',
  'knight',
  'pawn'
]

export interface ChessSetMaterials {
  white: THREE.MeshStandardMaterial
  black: THREE.MeshStandardMaterial
  board: THREE.MeshStandardMaterial
}

export interface ChessSetAssets {
  /** Per color × type piece geometry, world units (1 = one square), base at y=0. */
  geometries: Record<TabletopColor, Record<ChessPieceType, THREE.BufferGeometry>>
  /** Scanned board + frame geometry, world units, origin at board center. */
  boardGeometry: THREE.BufferGeometry
  /** y (world units) of the board's top surface. Rest pieces here. */
  boardTopY: number
  /** Source physical square size in meters (provenance/debug). */
  squareSizeMeters: number
  /** Build a fresh material trio for a variant. Caller disposes what it makes. */
  materials(variant?: ChessSetVariant): ChessSetMaterials
  /** Dispose shared geometries + textures (invalidates the cache entry). */
  dispose(): void
}

/** Kernel piece char ('K', 'n', …) → geometry key; null for fairy pieces (procedural fallback). */
export function pieceTypeFromCode(code: string): ChessPieceType | null {
  switch (code.toLowerCase()) {
    case 'k':
      return 'king'
    case 'q':
      return 'queen'
    case 'r':
      return 'rook'
    case 'b':
      return 'bishop'
    case 'n':
      return 'knight'
    case 'p':
      return 'pawn'
    default:
      return null
  }
}

interface ManifestPiece {
  file: string
  tris: number
  bytes: number
  material: string
}
interface Manifest {
  license: string
  squareSize: number
  boardTopY: number
  pieces: Record<string, ManifestPiece>
  textures: Record<'pieces_white' | 'pieces_black' | 'board', { diff: string; normal: string; arm: string }>
}

interface TextureSet {
  diff: THREE.Texture
  normal: THREE.Texture | null
  arm: THREE.Texture | null
}

/** Wood-variant recolor: multiplies the native diffuse; slight roughness lift. */
const WOOD_TINTS: Record<'white' | 'black' | 'board', { color: string; roughness: number }> = {
  white: { color: '#d9a15c', roughness: 1.15 }, // boxwood → warm honey
  black: { color: '#8a5a3a', roughness: 1.1 }, // ebonized → walnut (map is dark; tint warms it)
  board: { color: '#c99a62', roughness: 1.05 }
}

const cache = new Map<string, Promise<ChessSetAssets | null>>()

/**
 * Load the photoreal chess set. Resolves null when the art base is not
 * configured or any file fails. Callers keep their procedural fallback.
 * Cached per resolved manifest URL; `dispose()` evicts the entry.
 */
export function loadChessSet(artBaseUrl?: string | null): Promise<ChessSetAssets | null> {
  const manifestUrl = resolveGamesArtUrl('chess3d/manifest.json', artBaseUrl)
  if (!manifestUrl) return Promise.resolve(null)
  const hit = cache.get(manifestUrl)
  if (hit) return hit
  const p = loadSet(manifestUrl, artBaseUrl).catch(() => null)
  cache.set(manifestUrl, p)
  return p
}

async function loadSet(
  manifestUrl: string,
  artBaseUrl?: string | null
): Promise<ChessSetAssets | null> {
  const res = await fetch(manifestUrl)
  if (!res.ok) return null
  const manifest = (await res.json()) as Manifest
  const worldScale = 1 / manifest.squareSize // meters → world units (1 = one square)

  const gltfLoader = new GLTFLoader()
  const loadGeometry = async (file: string): Promise<THREE.BufferGeometry | null> => {
    const url = resolveGamesArtUrl(`chess3d/${file}`, artBaseUrl)
    if (!url) return null
    const gltf = await gltfLoader.loadAsync(url)
    let geometry: THREE.BufferGeometry | null = null
    gltf.scene.traverse((obj) => {
      if (!geometry && (obj as THREE.Mesh).isMesh) {
        geometry = (obj as THREE.Mesh).geometry
      }
    })
    if (geometry) {
      const g = geometry as THREE.BufferGeometry
      g.scale(worldScale, worldScale, worldScale)
      g.computeBoundingSphere()
    }
    return geometry
  }

  const pieceIds: string[] = []
  for (const color of ['white', 'black'] as const) {
    for (const type of CHESS_PIECE_TYPES) pieceIds.push(`${type}_${color}`)
  }
  const [boardGeometry, ...pieceGeos] = await Promise.all([
    loadGeometry(manifest.pieces.board.file),
    ...pieceIds.map((id) => loadGeometry(manifest.pieces[id].file))
  ])
  if (!boardGeometry || pieceGeos.some((g) => !g)) return null

  const geometries = {
    white: {},
    black: {}
  } as Record<TabletopColor, Record<ChessPieceType, THREE.BufferGeometry>>
  pieceIds.forEach((id, i) => {
    const [type, color] = id.split('_') as [ChessPieceType, TabletopColor]
    geometries[color][type] = pieceGeos[i] as THREE.BufferGeometry
  })

  const texLoader = new THREE.TextureLoader()
  const loadTex = (rel: string, srgb: boolean): Promise<THREE.Texture | null> => {
    const url = resolveGamesArtUrl(`chess3d/${rel}`, artBaseUrl)
    if (!url) return Promise.resolve(null)
    return new Promise((resolve) => {
      texLoader.load(
        url,
        (tex) => {
          if (srgb) tex.colorSpace = THREE.SRGBColorSpace
          tex.anisotropy = 8
          tex.flipY = false // glTF UV convention (geometry UVs come from the GLBs)
          resolve(tex)
        },
        undefined,
        () => resolve(null)
      )
    })
  }
  const loadTexSet = async (
    group: 'pieces_white' | 'pieces_black' | 'board'
  ): Promise<TextureSet | null> => {
    const t = manifest.textures[group]
    const [diff, normal, arm] = await Promise.all([
      loadTex(t.diff, true),
      loadTex(t.normal, false),
      loadTex(t.arm, false)
    ])
    if (!diff) return null // normal/arm are quality extras, diffuse is required
    return { diff, normal, arm }
  }
  const [whiteTex, blackTex, boardTex] = await Promise.all([
    loadTexSet('pieces_white'),
    loadTexSet('pieces_black'),
    loadTexSet('board')
  ])
  if (!whiteTex || !blackTex || !boardTex) return null

  const buildMaterial = (
    tex: TextureSet,
    tint: { color: string; roughness: number } | null
  ): THREE.MeshStandardMaterial => {
    const mat = new THREE.MeshStandardMaterial({
      map: tex.diff,
      normalMap: tex.normal ?? undefined,
      metalness: tex.arm ? 1 : 0, // ARM blue channel scales this down per-texel
      roughness: 1
    })
    if (tex.arm) {
      // glTF ORM packing: R = ambient occlusion, G = roughness, B = metalness.
      mat.aoMap = tex.arm
      mat.roughnessMap = tex.arm
      mat.metalnessMap = tex.arm
      mat.aoMapIntensity = 1
    }
    if (tint) {
      mat.color.set(tint.color)
      mat.roughness = Math.min(1, tint.roughness)
    }
    return mat
  }

  const materials = (variant: ChessSetVariant = 'marble'): ChessSetMaterials => ({
    white: buildMaterial(whiteTex, variant === 'wood' ? WOOD_TINTS.white : null),
    black: buildMaterial(blackTex, variant === 'wood' ? WOOD_TINTS.black : null),
    board: buildMaterial(boardTex, variant === 'wood' ? WOOD_TINTS.board : null)
  })

  const dispose = (): void => {
    cache.delete(manifestUrl)
    boardGeometry.dispose()
    for (const color of ['white', 'black'] as const) {
      for (const type of CHESS_PIECE_TYPES) geometries[color][type]?.dispose()
    }
    for (const set of [whiteTex, blackTex, boardTex]) {
      set.diff.dispose()
      set.normal?.dispose()
      set.arm?.dispose()
    }
  }

  return {
    geometries,
    boardGeometry,
    boardTopY: manifest.boardTopY * worldScale,
    squareSizeMeters: manifest.squareSize,
    materials,
    dispose
  }
}
