import type { JSX } from 'react'
import type { Color } from '../../chess/chess'

/** The states the one task line has to cover, shared by Train, Custom and Daily. */
export type TaskState = 'loading' | 'solving' | 'keepTrying' | 'solved' | 'lateSolve' | 'failed'

export interface PuzzleTaskProps {
  state: TaskState
  /** The side the learner is playing. */
  userColor: Color
  /** The move that was right, when we know it. */
  correctSan?: string | null
}

function colorWord(c: Color): string {
  return c === 'white' ? 'White' : 'Black'
}

/**
 * v1's task block: one accented line above the facts, saying the only thing the
 * learner has to do. It carries the solve states too, including the two the
 * trainer needs and v1 never drew: a wrong move is on the books the moment it
 * is played, and finishing the line afterwards does not take it back.
 */
export function PuzzleTask({ state, userColor, correctSan }: PuzzleTaskProps): JSX.Element {
  let text: string
  switch (state) {
    case 'loading':
      text = 'Finding a position for you.'
      break
    case 'keepTrying':
      text = 'Recorded as failed. Keep trying.'
      break
    case 'solved':
      text = 'Solved.'
      break
    case 'lateSolve':
      text = 'Solved. Counted as failed.'
      break
    case 'failed':
      text = correctSan ? `Not the move. ${correctSan} was.` : 'Not the move.'
      break
    case 'solving':
    default:
      text = `Play the move ${colorWord(userColor)} would play. One try.`
      break
  }

  return (
    <div className="task">
      <p className="task-text">{text}</p>
    </div>
  )
}
