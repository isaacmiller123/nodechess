// OTB auto-flip timing shared by every games-platform local view (KernelOtb,
// VariantOtb, the Variant Lab's PlayCustom). Mirrors the chess Play OTB feel:
// the board turns to face the side to move a brief moment AFTER a move
// commits: the move animation is seen completing first, then the board flips
// in one instant repaint (the boards themselves guarantee no cross-board
// slides on an orientation change). Turning auto-flip off snaps back to
// White-side-up immediately.

import { useEffect, useState } from 'react'
import type { PlayerColor } from '../../games/kernel'

/** Post-move pause before the board turns to the next player. */
export const OTB_FLIP_DELAY_MS = 450

/**
 * @param turn   side to move (the orientation target while `active`)
 * @param active auto-flip enabled AND the game's flipPolicy is 'rotate'
 * @param base   the side the board faces when it is not following the turn.
 *               The setup screen's "Play as" chose it; White when nothing did.
 */
export function useOtbOrientation(
  turn: PlayerColor,
  active: boolean,
  base: PlayerColor = 'white'
): PlayerColor {
  // Opening orientation faces the first player immediately (no start-up flip).
  const [orientation, setOrientation] = useState<PlayerColor>(active ? turn : base)

  useEffect(() => {
    if (!active) {
      setOrientation(base)
      return
    }
    const id = window.setTimeout(() => setOrientation(turn), OTB_FLIP_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [turn, active, base])

  return active ? orientation : base
}
