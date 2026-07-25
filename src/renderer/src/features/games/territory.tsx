// Live territory estimate for go views (OTB / bot / replay). KataGo's raw
// neural-net ownership via engine:estimateGo (KatagoPool.estimate, one forward
// pass, no search). Strictly advisory and never blocking: requests are
// throttled to one per MIN_INTERVAL_MS, always for the LATEST position, and a
// missing/incapable engine collapses the whole feature to a hidden state (the
// toggle itself only renders once KataGo is confirmed installed).
//
// Owners (KernelOtb / KernelBot / GameReplayView) hold the toggle state, hand
// `estimate.ownership` to GoBoard's `territory` prop for the shading overlay,
// and render <TerritoryControl> (the toggle chip + the score strip) in
// their side panel.

import { useEffect, useRef, useState, type JSX } from 'react'
import { Layers } from 'lucide-react'
import type { EstimateGoResult } from '@shared/types'
import { handicapPlacement, type GoState } from '../../games/go'

/** Floor between estimate request STARTS (spec: throttle to ≥ 1.5s). */
const MIN_INTERVAL_MS = 1_500

export interface TerritoryState {
  /** KataGo installed AND speaking kata-raw-nn. False hides the feature. */
  available: boolean
  /** Latest ownership/lead/winrate snapshot (survives while the next loads). */
  estimate: EstimateGoResult | null
  /** A request is scheduled or in flight for the current position. */
  pending: boolean
}

const HIDDEN: TerritoryState = { available: false, estimate: null, pending: false }

/**
 * Throttled ownership estimates for the given live position. `enabled` is the
 * user's toggle, while false nothing is probed beyond the one-shot
 * availability check (which gates whether the toggle renders at all).
 */
export function useTerritoryEstimate(state: GoState | null, enabled: boolean): TerritoryState {
  const [available, setAvailable] = useState(false)
  const [estimate, setEstimate] = useState<EstimateGoResult | null>(null)
  const [pending, setPending] = useState(false)
  const seqRef = useRef(0)
  const lastStartRef = useRef(0)
  // One failure hides the feature for this mount instead of hammering a
  // broken backend (same discipline as the replay eval hook).
  const failedRef = useRef(false)

  // Availability probe (once per mount): the toggle only exists when KataGo is
  // actually installed, spec: "graceful hidden state when katago absent".
  useEffect(() => {
    let cancelled = false
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api) return
    api.engine
      .status()
      .then((s) => {
        if (!cancelled && !failedRef.current) setAvailable(s.katagoReady)
      })
      .catch(() => {
        /* engines unavailable: stay hidden */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const moveCount = state?.moves.length ?? 0

  useEffect(() => {
    if (!enabled || !available || state === null || failedRef.current) return
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api) return
    const seq = ++seqRef.current
    setPending(true)
    // Space request starts ≥ MIN_INTERVAL_MS apart; a newer position cancels a
    // still-waiting older one, so the estimate always chases the latest board.
    const wait = Math.max(0, MIN_INTERVAL_MS - (performance.now() - lastStartRef.current))
    const timer = window.setTimeout(() => {
      lastStartRef.current = performance.now()
      api.engine
        .estimateGo({
          size: state.size,
          komi: state.komi,
          ...(state.handicap >= 2 ? { handicap: handicapPlacement(state.size, state.handicap) } : {}),
          moves: [...state.moves] // 'pass' plies included, GTP replays them verbatim
        })
        .then((r) => {
          if (seqRef.current !== seq) return
          setPending(false)
          if (r === null) {
            // Engine build without kata-raw-nn. Hide for good, quietly.
            failedRef.current = true
            setAvailable(false)
            setEstimate(null)
            return
          }
          setEstimate(r)
        })
        .catch(() => {
          if (seqRef.current !== seq) return
          setPending(false)
          failedRef.current = true
          setAvailable(false)
          setEstimate(null)
        })
    }, wait)
    return () => window.clearTimeout(timer)
    // moveCount is the position identity; deadMarks/finalized don't matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, available, moveCount, state?.size, state?.handicap])

  if (!available) return HIDDEN
  return { available, estimate: enabled ? estimate : null, pending: enabled && pending }
}

/** Toggle chip + score-estimate strip for a go side panel. Renders nothing
 *  when KataGo is absent (the feature simply doesn't exist without it). */
export function TerritoryControl({
  territory,
  on,
  onToggle
}: {
  territory: TerritoryState
  on: boolean
  onToggle: (on: boolean) => void
}): JSX.Element | null {
  if (!territory.available) return null
  const est = territory.estimate
  const blackWin = est ? 1 - est.whiteWin : null
  return (
    <div className="territory">
      <button
        type="button"
        className={`votb-btn territory-toggle${on ? ' is-on' : ''}`}
        aria-pressed={on}
        onClick={() => onToggle(!on)}
      >
        <Layers size={14} aria-hidden /> Territory estimate
      </button>
      {on && (
        <div className="territory-strip" role="status" aria-label="KataGo territory estimate">
          {est === null ? (
            <span className="territory-pending">KataGo is estimating…</span>
          ) : (
            <>
              <span className="territory-bar" aria-hidden>
                <span
                  className="territory-bar-black"
                  style={{ width: `${Math.round((blackWin ?? 0.5) * 100)}%` }}
                />
              </span>
              <span className="territory-label num">
                B {Math.round((blackWin ?? 0.5) * 100)}% ·{' '}
                {est.whiteLead >= 0
                  ? `W+${est.whiteLead.toFixed(1)}`
                  : `B+${(-est.whiteLead).toFixed(1)}`}
              </span>
              {territory.pending && <span className="territory-dot" aria-hidden />}
            </>
          )}
        </div>
      )}
    </div>
  )
}
