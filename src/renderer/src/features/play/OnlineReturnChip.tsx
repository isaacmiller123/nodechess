// Floating "return to your online game" chip. Rendered by the app shell whenever
// a live online session (game or hosting) is running but the Play view isn't the
// one showing (MP-V3-SPEC §5, lichess free-navigation model). Clicking it jumps
// back to Play → Online. It reads the app-lifetime onlineStore snapshot, so it
// works from any view without touching the session.

import { useEffect, useState, type JSX } from 'react'
import { Timer, ChevronRight } from 'lucide-react'
import type { useOnlineGame } from './online/useOnlineGame'
import { formatClock } from './timeControl'
import './online.css'

interface OnlineReturnChipProps {
  state: ReturnType<typeof useOnlineGame>
  onReturn: () => void
}

/** Live remaining ms for the side whose clock is currently running, computed
 *  from the store's authoritative snapshot + monotonic base. Null when no clock
 *  is running (idle first move, paused, or between moves). */
function runningMs(state: OnlineReturnChipProps['state']): number | null {
  const clock = state.clock
  if (!clock || !clock.running) return null
  const base = clock.snapshot[clock.running]
  const elapsed = performance.now() - clock.atMono
  return Math.max(0, base - elapsed)
}

export function OnlineReturnChip({ state, onReturn }: OnlineReturnChipProps): JSX.Element {
  // Self-tick a display value while a clock runs so the chip's time stays live.
  const [, tick] = useState(0)
  useEffect(() => {
    if (!state.clock?.running) return
    const id = window.setInterval(() => tick((n) => n + 1), 250)
    return () => window.clearInterval(id)
  }, [state.clock?.running])

  const ms = runningMs(state)
  const label =
    state.phase === 'hosting'
      ? 'Waiting for an opponent'
      : ms !== null
        ? formatClock(ms)
        : 'Online game'

  return (
    <button
      type="button"
      className="online-return-chip"
      onClick={onReturn}
      title="Return to your online game"
      aria-label="Return to your online game"
    >
      <span className="online-return-dot" aria-hidden />
      <Timer size={15} aria-hidden />
      <span className="online-return-clock num">{label}</span>
      <span className="online-return-cta">
        Return <ChevronRight size={14} aria-hidden />
      </span>
    </button>
  )
}
