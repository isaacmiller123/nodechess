// Minimal ambient types for the untyped `tenuki` package (0.3.1): ONLY the
// headless surface games/go.ts consumes (Game without an element uses tenuki's
// NullRenderer, so everything here is DOM-free). y/x are measured from the
// TOP-LEFT of the board: y = 0 is the top row, x = 0 is the left column.
declare module 'tenuki' {
  export type TenukiColor = 'black' | 'white'
  export type TenukiPointValue = TenukiColor | 'empty'

  export interface TenukiPoint {
    y: number
    x: number
  }

  export interface TenukiIntersection extends TenukiPoint {
    value: TenukiPointValue
    isEmpty(): boolean
    isBlack(): boolean
    isWhite(): boolean
  }

  /** Immutable snapshot of one position (tenuki keeps a stack of these). */
  export interface TenukiBoardState {
    moveNumber: number
    /** Color that just moved (null at the initial position). */
    color: TenukiColor | null
    pass: boolean
    playedPoint: TenukiPoint | null
    intersections: readonly TenukiIntersection[]
    blackStonesCaptured: number
    whiteStonesCaptured: number
    /** Stones removed by the move that produced THIS state. CAUTION: the
     *  INITIAL state omits this field entirely (undefined at runtime).
     *  Guard with Array.isArray before reading it. */
    capturedPositions: readonly TenukiPoint[]
    boardSize: number
    intersectionAt(y: number, x: number): TenukiIntersection
    nextColor(): TenukiColor
    /** Pure simulation: returns the state after the play, without pushing it. */
    playAt(y: number, x: number, color: TenukiColor): TenukiBoardState
  }

  export interface TenukiGameOptions {
    element?: HTMLElement
    boardSize?: number
    komi?: number
    scoring?: 'territory' | 'area' | 'equivalence'
    koRule?:
      | 'simple'
      | 'positional-superko'
      | 'situational-superko'
      | 'natural-situational-superko'
    handicapStones?: number
    freeHandicapPlacement?: boolean
  }

  export interface TenukiRenderOption {
    render?: boolean
  }

  export class Game {
    constructor(options?: TenukiGameOptions)
    boardSize: number
    currentPlayer(): TenukiColor
    currentState(): TenukiBoardState
    intersections(): readonly TenukiIntersection[]
    intersectionAt(y: number, x: number): TenukiIntersection
    isIllegalAt(y: number, x: number): boolean
    playAt(y: number, x: number, options?: TenukiRenderOption): boolean
    pass(options?: TenukiRenderOption): boolean
    /** True once the last two moves were both passes. */
    isOver(): boolean
    markDeadAt(y: number, x: number, options?: TenukiRenderOption): boolean | undefined
    unmarkDeadAt(y: number, x: number, options?: TenukiRenderOption): boolean | undefined
    toggleDeadAt(y: number, x: number, options?: TenukiRenderOption): boolean | undefined
    deadStones(): readonly TenukiPoint[]
    /** Komi already added to white. Only meaningful when isOver(). */
    score(): { black: number; white: number }
    territory(): { black: readonly TenukiPoint[]; white: readonly TenukiPoint[] }
    moveNumber(): number
    undo(): void
  }
}
