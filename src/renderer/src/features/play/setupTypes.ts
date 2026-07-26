// The vocabulary of the Play setup screen, shared by the page and its four
// sections. design-lab/v1/play.html draws three peers (Online, Bot, Local
// board); a bot's STYLE is the app's own axis, because the same "play a
// machine on this device" flow reaches Stockfish levels, the Maia nets and the
// grandmaster personas.

import type { MaiaLevel, Persona } from '@shared/types'
import type { TimeControl } from './timeControl'

/** Which of the three peers is showing. */
export type PlayMode = 'online' | 'bot' | 'local'

/** Which side the user takes. 'random' is rolled at start. */
export type ColorChoice = 'white' | 'black' | 'random'

/** What kind of machine the Bot section is currently configuring. */
export type BotStyle = 'levels' | 'human' | 'grandmasters'

/**
 * A fully-resolved request to start a game. The sections own their own forms
 * and hand the page one of these; the page owns the tree, the clock and the
 * reply loop and never reads a form back. A rematch replays the same value,
 * which is why 'random' survives in it: re-rolling the colour is what a
 * rematch is supposed to do.
 */
export type StartSpec =
  | { kind: 'engine'; elo: number; color: ColorChoice; tc: TimeControl }
  | { kind: 'maia'; level: MaiaLevel; color: ColorChoice; tc: TimeControl }
  | { kind: 'persona'; persona: Persona; color: ColorChoice; tc: TimeControl }
  | { kind: 'otb'; whiteName: string; blackName: string; autoFlip: boolean; tc: TimeControl }
