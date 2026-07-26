import { useEffect, useRef, useState } from 'react'
import type { EngineLine } from '@shared/types'

export interface PvLine {
  multipv: number
  depth: number
  scoreCp?: number
  mate?: number
  pv: string[]
}

/** What the search itself is doing, as opposed to what it found. Stockfish
 *  reports these on every info line and the IPC channel has always forwarded
 *  them; they stopped here because no surface asked for them. The Engine
 *  readout does. Fields are optional because a line may omit any of them. */
export interface SearchStats {
  depth: number
  seldepth?: number
  nodes?: number
  nps?: number
}

// Live infinite analysis of `fen` while `enabled`. Streams MultiPV lines from the
// main-process Stockfish via the engine IPC push channel.
//
// Lines are tagged with the fen they were produced for and the hook only returns
// lines matching the *current* fen. A render-time guard clears the buffer the
// instant `fen` changes, so the eval bar and on-board arrows never show the
// previous position for a frame (the prior bug: the clear ran in a post-render
// effect, one frame late).
// `depthCap` bounds the search: null runs the infinite analysis this hook has
// always run, a number stops Stockfish at that depth (GoLimit already carries
// {kind:'depth'} and the main process already accepts it). A cap is also the
// only thing that gives the depth readout a denominator.
export function useAnalysis(fen: string, enabled: boolean, multipv = 3, depthCap: number | null = null) {
  const [state, setState] = useState<{ fen: string; lines: PvLine[]; stats: SearchStats }>({
    fen,
    lines: [],
    stats: { depth: 0 }
  })
  // Set when engine:analyze rejects (fresh install without the engine dataset,
  // spawn failure, crash). Consumers surface it instead of "analyzing… depth 0"
  // forever: the swallowed rejection here was the audit's Analysis hang.
  const [error, setError] = useState<string | null>(null)
  const handleRef = useRef<number | null>(null)
  const linesRef = useRef<Map<number, PvLine>>(new Map())
  const fenRef = useRef(fen)

  // Synchronous reset on fen change: drop the previous position's lines during
  // render so this render already returns an empty set for the new fen.
  if (state.fen !== fen) {
    linesRef.current = new Map()
    fenRef.current = fen
    setState({ fen, lines: [], stats: { depth: 0 } })
  }

  useEffect(() => {
    if (!window.api?.engine) return
    const off = window.api.engine.onLine((l: EngineLine) => {
      if (l.handleId !== handleRef.current || !l.multipv || !l.pv) return
      linesRef.current.set(l.multipv, {
        multipv: l.multipv,
        depth: l.depth ?? 0,
        scoreCp: l.scoreCp,
        mate: l.mate,
        pv: l.pv
      })
      const lines = Array.from(linesRef.current.values()).sort((a, b) => a.multipv - b.multipv)
      setState({
        fen: fenRef.current,
        lines,
        stats: { depth: l.depth ?? 0, seldepth: l.seldepth, nodes: l.nodes, nps: l.nps }
      })
    })
    return off
  }, [])

  useEffect(() => {
    const engine = window.api?.engine
    if (!engine) return
    let cancelled = false
    linesRef.current = new Map()
    fenRef.current = fen

    const stopCurrent = () => {
      if (handleRef.current !== null) {
        // stop() can itself reject (engine gone). Never an unhandled rejection.
        engine.stop(handleRef.current).catch(() => undefined)
        handleRef.current = null
      }
    }
    stopCurrent()

    if (enabled) {
      setError(null)
      engine
        .analyze({
          fen,
          multipv,
          limit: depthCap === null ? { kind: 'infinite' } : { kind: 'depth', value: depthCap }
        })
        .then(({ handleId }) => {
          if (cancelled) engine.stop(handleId).catch(() => undefined)
          else handleRef.current = handleId
        })
        .catch((e: unknown) => {
          // Surface the failure (missing/broken engine binary) instead of
          // leaving the eval bar spinning at depth 0 forever.
          if (!cancelled) setError(e instanceof Error ? e.message : String(e))
        })
    }

    return () => {
      cancelled = true
      stopCurrent()
    }
  }, [fen, enabled, multipv, depthCap])

  // Only surface lines that belong to the current fen.
  const lines = state.fen === fen ? state.lines : []
  const stats = state.fen === fen ? state.stats : { depth: 0 }
  return { lines, depth: stats.depth, stats, error }
}
