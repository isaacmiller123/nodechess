// WebGL availability probe: Tabletop3D refuses to mount a <Canvas> without it
// and reports through onUnavailable so callers fall back to the 2D board.

let cached: { ok: boolean; reason?: string } | null = null

export function detectWebGL(): { ok: boolean; reason?: string } {
  if (cached) return cached
  try {
    if (typeof document === 'undefined') {
      cached = { ok: false, reason: 'no-dom' }
      return cached
    }
    const canvas = document.createElement('canvas')
    const gl =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')
    if (!gl) {
      cached = { ok: false, reason: 'webgl-unsupported' }
      return cached
    }
    // Losing the probe context immediately frees the GPU handle.
    const lose = (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')
    lose?.loseContext()
    cached = { ok: true }
  } catch {
    cached = { ok: false, reason: 'webgl-error' }
  }
  return cached
}

/** True when the shared 3D tabletop can render on this machine. */
export function isTabletopSupported(): boolean {
  return detectWebGL().ok
}
