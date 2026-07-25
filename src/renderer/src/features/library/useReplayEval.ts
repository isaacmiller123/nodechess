// Debounced local eval for the replay viewer (never blocks the UI):
//   chess family (variants, ffish kinds, Variant Lab customs) →
//     engine:evalVariant. One ~300ms single-line Fairy-Stockfish search,
//     normalized here from side-to-move to WHITE (the EvalBar convention);
//   go → engine:estimateGo. One KataGo raw-net forward pass (winrate + score
//     lead), only when the katago dataset is installed;
//   everything else → 'none' (the viewer hides the bar entirely).
//
// Availability is probed once per mount via engine:status; a request failure
// flips the family to unavailable for the rest of the session instead of
// re-erroring on every ply step.

import { useEffect, useRef, useState } from 'react'
import type { EngineStatus } from '@shared/types'
import type { Score } from '../../chess/scores'
import { toWhite } from '../../chess/scores'
import type { GameSpec } from '../../games/kernel'
import { handicapPlacement, type GoState } from '../../games/go'
import { turnAt } from './replayData'

export type ReplayEval =
  /** This kind has no local engine. Render no bar. */
  | { family: 'none' }
  /** Chess family: white-POV score (null while pending/terminal). */
  | { family: 'chess'; score: Score | null; pending: boolean }
  /** Go: KataGo raw-net readout (null while pending / when unavailable). */
  | { family: 'go'; whiteWin: number | null; whiteLead: number; pending: boolean }

const NONE: ReplayEval = { family: 'none' }

/** Chess-family kinds the eval bar can serve: everything the fairy engine
 *  speaks. The registry statics plus Variant Lab customs. */
function evalFamilyOf(spec: GameSpec<unknown>): 'chess' | 'go' | 'none' {
  if (spec.family === 'chess') return 'chess'
  if (spec.kind === 'go') return 'go'
  return 'none'
}

const DEBOUNCE_MS = 250

export function useReplayEval(
  spec: GameSpec<unknown>,
  state: unknown,
  plies: number,
  enabled: boolean
): ReplayEval {
  const family = evalFamilyOf(spec)
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [result, setResult] = useState<ReplayEval>(NONE)
  // One failure disables the family for this mount (missing binary, wedged
  // engine): the bar hides instead of hammering a broken backend.
  const failedRef = useRef(false)
  const seqRef = useRef(0)

  useEffect(() => {
    if (family === 'none' || !enabled) return
    let cancelled = false
    window.api?.engine
      .status()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {
        if (!cancelled) failedRef.current = true
      })
    return () => {
      cancelled = true
    }
  }, [family, enabled])

  const available =
    enabled &&
    !failedRef.current &&
    ((family === 'chess' && status?.fairyReady === true) ||
      (family === 'go' && status?.katagoReady === true))

  useEffect(() => {
    if (!available || state === null) return
    const seq = ++seqRef.current
    // Show the bar immediately in its pending shape so the layout never jumps.
    setResult(
      family === 'chess'
        ? { family: 'chess', score: null, pending: true }
        : { family: 'go', whiteWin: null, whiteLead: 0, pending: true }
    )
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (family === 'chess') {
            const fen = (state as { fen?: string }).fen
            if (!fen) return
            const r = await window.api!.engine.evalVariant({ kind: spec.kind, fen })
            if (seqRef.current !== seq) return
            const stm = turnAt(spec, state, plies)
            const score: Score | null =
              r.cp === undefined && r.mate === undefined
                ? null
                : toWhite({ cp: r.cp, mate: r.mate }, stm)
            setResult({ family: 'chess', score, pending: false })
          } else {
            const s = state as GoState
            const r = await window.api!.engine.estimateGo({
              size: s.size,
              komi: s.komi,
              handicap: s.handicap >= 2 ? handicapPlacement(s.size, s.handicap) : undefined,
              moves: [...s.moves] // 'pass' plies included, GTP replays them verbatim
            })
            if (seqRef.current !== seq) return
            if (r === null) {
              failedRef.current = true // engine lacks kata-raw-nn: hide for good
              setResult(NONE)
              return
            }
            setResult({ family: 'go', whiteWin: r.whiteWin, whiteLead: r.whiteLead, pending: false })
          }
        } catch {
          if (seqRef.current !== seq) return
          failedRef.current = true
          setResult(NONE)
        }
      })()
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // `plies` tracks the position identity; spec identity is stable per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, state, plies, family])

  if (family === 'none' || !available) return NONE
  return result
}
