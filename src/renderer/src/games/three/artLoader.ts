// games-art loader contract for the 3D tabletop.
//
// Art lives in resources/games-art/ (owned by the art pipeline; this module
// only READS). PBR sets follow textures/<name>_{color,normal,roughness}.jpg.
// Resolution order for the base URL:
//   1. explicit `artBaseUrl` prop on <Tabletop3D>
//   2. resolver installed via setGamesArtResolver() (app wiring, wave 2)
//   3. window.__gamesArtBase (dev/preview harnesses set this)
// When nothing resolves (or any file 404s) callers keep their procedural
// fallback materials, so the renderer is fully standalone.

import * as THREE from 'three'
import type { ArtTextureName } from './types'

declare global {
  interface Window {
    __gamesArtBase?: string
  }
}

let resolver: ((relPath: string) => string | null) | null = null

/** App-level hook: map a games-art relative path (e.g. 'textures/slate_color.jpg') to a loadable URL. */
export function setGamesArtResolver(fn: ((relPath: string) => string | null) | null): void {
  resolver = fn
}

export function resolveGamesArtUrl(relPath: string, baseOverride?: string | null): string | null {
  if (baseOverride === null) return null
  if (baseOverride) return `${baseOverride.replace(/\/$/, '')}/${relPath}`
  if (resolver) return resolver(relPath)
  if (typeof window !== 'undefined' && window.__gamesArtBase) {
    return `${window.__gamesArtBase.replace(/\/$/, '')}/${relPath}`
  }
  return null
}

export interface PbrMaps {
  map: THREE.Texture
  normalMap: THREE.Texture | null
  roughnessMap: THREE.Texture | null
}

const loader = new THREE.TextureLoader()
const cache = new Map<string, Promise<PbrMaps | null>>()

function loadTexture(url: string, srgb: boolean): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    loader.load(
      url,
      (tex) => {
        if (srgb) tex.colorSpace = THREE.SRGBColorSpace
        tex.wrapS = THREE.RepeatWrapping
        tex.wrapT = THREE.RepeatWrapping
        tex.anisotropy = 8
        resolve(tex)
      },
      undefined,
      () => resolve(null)
    )
  })
}

/**
 * Load a PBR set by games-art name; null when the base URL is unresolvable or
 * the color map is missing (normal/roughness are optional extras). Cached per
 * resolved color-map URL.
 */
export function loadPbrSet(
  name: ArtTextureName,
  baseOverride?: string | null
): Promise<PbrMaps | null> {
  const colorUrl = resolveGamesArtUrl(`textures/${name}_color.jpg`, baseOverride)
  if (!colorUrl) return Promise.resolve(null)
  const hit = cache.get(colorUrl)
  if (hit) return hit
  const p = (async (): Promise<PbrMaps | null> => {
    const [map, normalMap, roughnessMap] = await Promise.all([
      loadTexture(colorUrl, true),
      loadTexture(resolveGamesArtUrl(`textures/${name}_normal.jpg`, baseOverride) ?? '', false),
      loadTexture(resolveGamesArtUrl(`textures/${name}_roughness.jpg`, baseOverride) ?? '', false)
    ])
    if (!map) return null
    return { map, normalMap, roughnessMap }
  })()
  cache.set(colorUrl, p)
  return p
}

/** Load any games-art image (piece decal SVG/PNG) as an HTMLImageElement, null on failure. */
export function loadArtImage(
  relPath: string,
  baseOverride?: string | null
): Promise<HTMLImageElement | null> {
  const url = resolveGamesArtUrl(relPath, baseOverride)
  if (!url) return Promise.resolve(null)
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}
