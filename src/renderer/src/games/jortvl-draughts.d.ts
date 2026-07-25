// Ambient types for @jortvl/draughts (MPL-2.0, ships untyped JS).
// Only the surface games/checkers.ts consumes is declared. The library is a
// chess.js-style API over 10x10 international draughts, FMJD numbering 1..50.
declare module '@jortvl/draughts' {
  /** A generated move. `jumps` is [origin, ...landing squares]; `takes` the captured squares. */
  export interface JortvlMove {
    from: number
    to: number
    jumps: number[]
    takes: number[]
    pieces_taken?: string[]
    flags?: string
  }

  export interface JortvlDraughts {
    fen(): string
    ascii(): string
    turn(): 'w' | 'b'
    moves(): JortvlMove[]
    /** WARNING: string form matches from/to only. Ambiguous capture paths pick the first match. */
    move(move: string | { from: number; to: number }): JortvlMove | false
    gameOver(): boolean
    load(fen: string): boolean
  }

  const Draughts: new (fen?: string) => JortvlDraughts
  export default Draughts
}
