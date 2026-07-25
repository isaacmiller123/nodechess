// Bot-strength model shared by Play and the School boss.
//
// All strengths funnel through one request shape: level = { elo }. The MAIN
// process ('engine:play' in src/main/ipc/engine.ipc.ts) resolves how to reach the
// target: native UCI_Elo limiting at 1320+, and below Stockfish's floor an
// engine-driven weakening: a short full-strength MultiPV search whose candidate
// moves are picked by an Elo-scaled softmax over their scores, plus an occasional
// "human blunder" from the bottom candidates. The old renderer-side hack (Skill 0
// + shallow depth + uniform-random legal moves) is gone: weak bots now make
// natural-looking errors the engine actually considered. Misplaced pieces,
// missed tactics, rather than arbitrary shuffles. Sub-floor tiers remain
// approximations, not calibrated ratings.
import { ENGINE_ELO_FLOOR, type GoLimit, type PlayLevel } from '@shared/types'
import { destsFor, isPromotion } from './chess'

/** Stockfish's UCI_Elo / Skill-Level floor: re-exported from the shared
 *  contract (single source of truth, also used by main's engine.ipc.ts). */
export { ENGINE_ELO_FLOOR }

/**
 * A uniformly random legal move (UCI, queen-promotion by default) for the side to
 * move, or null if there are none. destsFor returns only legal moves, so every pick
 * is legal. LAST-RESORT fallback only: used when the engine fails to answer, so a
 * bot never freezes mid-game. It is no longer part of the strength model.
 */
export function randomLegalUci(fen: string): string | null {
  const moves: string[] = []
  destsFor(fen).forEach((tos, from) => {
    for (const to of tos) moves.push(isPromotion(fen, from, to) ? `${from}${to}q` : `${from}${to}`)
  })
  if (moves.length === 0) return null
  return moves[Math.floor(Math.random() * moves.length)]
}

/**
 * PlayLevel plus the time-trouble knob. `panic` rides the same engine:play wire
 * (validated by engine.ipc's zod schema) WITHOUT touching the shared PlayLevel
 * contract: at sub-floor strengths the main process reads it to search
 * shallower and pick hotter (raised softmax temperature + blunder chance). The
 * weak bot's own strength collapse in time trouble. At 1320+ it is ignored
 * (there the caller's shrunken movetime IS the collapse).
 */
export type BotPlayLevel = PlayLevel & { panic?: boolean }

/**
 * Choose the bot's move at a target Elo: pass { elo } straight through and let the
 * main process pick the weakening strategy (native UCI_Elo vs MultiPV softmax).
 * thinkMs is honored at 1320+; below the floor the main process substitutes its
 * own short Elo-scaled depth search (`panic` shrinks/heats that search: see
 * BotPlayLevel). Returns UCI; falls back to a random legal move only when the
 * engine returns nothing, and null if there is no move at all.
 */
export async function chooseBotMove(
  fen: string,
  elo: number,
  play: (req: { fen: string; level: PlayLevel; limit: GoLimit }) => Promise<{ bestmove: string } | null>,
  thinkMs = 800,
  panic = false
): Promise<string | null> {
  const level: BotPlayLevel = { elo: Math.max(100, Math.min(3190, Math.round(elo))) }
  if (panic) level.panic = true
  const limit: GoLimit = { kind: 'movetime', value: Math.max(1, Math.round(thinkMs)) }
  const res = await play({ fen, level, limit }).catch(() => null)
  return res?.bestmove ?? randomLegalUci(fen)
}
