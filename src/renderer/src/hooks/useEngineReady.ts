import { useCallback, useEffect, useState } from 'react'

// Shared availability guard for the main-process Stockfish (Play vs Computer,
// Analysis, hints, review). Mirrors the KataGo pattern in KernelBot: probe
// while `active`, expose null (probing) / true / false, and let callers
// re-probe on demand (e.g. after the Settings → Datasets download finishes).
//
// The signal is datasets:status().engine, "is a Stockfish binary on disk"
// (imported-first, then bundled; see main/datasets/paths.ts). This is NOT
// engine:status.analysisReady, which only says whether an instance is already
// RUNNING: false on every cold start even with the engine installed.
export function useEngineReady(active = true): {
  /** null while probing, then whether the Stockfish binary is on disk. */
  ready: boolean | null
  /** Force a fresh probe (e.g. after a failed spawn or a finished download). */
  recheck: () => void
} {
  return useDatasetReady('engine', active)
}

/** Same guard for the Lichess puzzle DB (datasets:status().puzzles). School
 *  warm-up/cool-down puzzle segments and the puzzle trainer need it on disk.
 *  Fresh installs must show the "download in Settings" notice, never a fake
 *  puzzle over the start position. */
export function usePuzzlesReady(active = true): {
  ready: boolean | null
  recheck: () => void
} {
  return useDatasetReady('puzzles', active)
}

function useDatasetReady(
  key: 'engine' | 'puzzles',
  active: boolean
): { ready: boolean | null; recheck: () => void } {
  const [ready, setReady] = useState<boolean | null>(null)
  const [seq, setSeq] = useState(0)
  const recheck = useCallback(() => setSeq((n) => n + 1), [])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api?.datasets) {
      setReady(false)
      return
    }
    api.datasets
      .status()
      .then((s) => {
        if (!cancelled) setReady(s[key])
      })
      .catch(() => {
        if (!cancelled) setReady(false)
      })
    return () => {
      cancelled = true
    }
  }, [active, seq, key])

  return { ready, recheck }
}
