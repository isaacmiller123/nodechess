import type { JSX } from 'react'
import type { Phase } from './usePuzzleSession'
import type { Color } from '../../chess/chess'

export interface PuzzlePromptProps {
  phase: Phase
  userColor: Color
  correctSan?: string | null
  /** Retry-on-wrong: the fail is recorded but the learner is still solving. */
  keepTrying?: boolean
  /** The line was completed AFTER the fail was recorded ("solved, but the
   *  first try counted"). Only meaningful with phase 'failed'. */
  lateSolve?: boolean
}

function colorLabel(c: Color): string {
  return c === 'white' ? 'White' : 'Black'
}

/** Turn prompt + status banner. Mirrors the lichess solving header. */
export function PuzzlePrompt({
  phase,
  userColor,
  correctSan,
  keepTrying = false,
  lateSolve = false
}: PuzzlePromptProps): JSX.Element {
  let cls = 'panel pad puzzle-prompt'
  let title: string
  let subtitle: string

  switch (phase) {
    case 'solved':
      cls += ' is-solved'
      title = 'Solved'
      subtitle = 'Well played.'
      break
    case 'failed':
      cls += ' is-failed'
      if (lateSolve) {
        // Retry-on-wrong: they found the line in the end, but the first wrong
        // try already counted. Say so honestly without hiding the finish.
        title = 'Solved. Counted as failed.'
        subtitle = 'Only the first try is rated. On to the next one.'
      } else {
        title = 'Not quite'
        subtitle = correctSan ? `Best was ${correctSan}.` : 'That was not the move.'
      }
      break
    case 'empty':
      title = 'No puzzles'
      subtitle = 'No puzzles match this filter.'
      break
    case 'error':
      title = 'Something went wrong'
      subtitle = 'Could not load a puzzle. Try again.'
      break
    case 'loading':
      title = 'Loading puzzle'
      subtitle = 'Finding a position for you.'
      break
    case 'leadin':
    case 'solving':
    default:
      if (keepTrying) {
        // Retry-on-wrong: the fail is on the books; the board is live again.
        cls += ' is-keeptrying'
        title = 'Recorded as failed. Keep trying.'
        subtitle = `Take your time and find the move for ${colorLabel(userColor)}.`
      } else {
        title = `Find the best move for ${colorLabel(userColor)}`
        subtitle = 'Your move.'
      }
      break
  }

  return (
    <div className={cls}>
      <div className="prompt-title">{title}</div>
      <div className="prompt-subtitle">{subtitle}</div>
    </div>
  )
}
