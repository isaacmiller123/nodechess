import type { JSX } from 'react'

export type HintStageValue = 0 | 1 | 2 | 3

export interface HintButtonProps {
  stage: HintStageValue
  disabled: boolean
  onHint: () => void
  /** The move itself, once the ladder has climbed all the way. */
  revealSan?: string | null
}

/* v1 draws one flat "Hint" in the boardbar. The trainer's help is a ladder:
   the first press rings the piece, the second draws the destination, the third
   names the move. One button still, saying what the next press will do. */
const LABEL: Record<HintStageValue, string> = {
  0: 'Hint',
  1: 'Hint again',
  2: 'Show the move',
  3: 'Move shown'
}

export function HintButton({ stage, disabled, onHint, revealSan }: HintButtonProps): JSX.Element {
  const spent = stage >= 3
  return (
    <button
      className="btn is-quiet"
      type="button"
      onClick={onHint}
      disabled={disabled || spent}
      title="Hint (h)"
    >
      {spent && revealSan ? revealSan : LABEL[stage]}
    </button>
  )
}
