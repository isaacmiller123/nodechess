// Small hooks bridging the async art loader into R3F materials.

import { useEffect, useState } from 'react'
import * as THREE from 'three'
import { loadPbrSet, type PbrMaps } from './artLoader'
import type { ArtTextureName } from './types'

/**
 * PBR set for a games-art texture name, or null (not resolvable / loading /
 * missing): callers keep procedural fallbacks until it arrives. Textures are
 * cloned so per-use repeat doesn't fight the shared cache.
 */
export function useArtPbr(
  name: ArtTextureName | undefined,
  artBase: string | null | undefined,
  repeat?: [number, number]
): PbrMaps | null {
  const [maps, setMaps] = useState<PbrMaps | null>(null)
  useEffect(() => {
    let alive = true
    setMaps(null)
    if (!name) return undefined
    loadPbrSet(name, artBase).then((set) => {
      if (!alive || !set) return
      if (!repeat) {
        setMaps(set)
        return
      }
      const clone = (t: THREE.Texture | null): THREE.Texture | null => {
        if (!t) return null
        const c = t.clone()
        c.repeat.set(repeat[0], repeat[1])
        c.needsUpdate = true
        return c
      }
      setMaps({
        map: clone(set.map) as THREE.Texture,
        normalMap: clone(set.normalMap),
        roughnessMap: clone(set.roughnessMap)
      })
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- repeat is a tuple literal
  }, [name, artBase, repeat?.[0], repeat?.[1]])
  return maps
}

/** The color-map image when it is canvas-composable (veneer source), else null. */
export function veneerImage(maps: PbrMaps | null): HTMLImageElement | null {
  const img = maps?.map.image as unknown
  return img instanceof HTMLImageElement ? img : null
}
