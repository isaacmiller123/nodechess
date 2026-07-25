// vs-bot Glicko recompute from stored game history (ratings-integrity fix).
//
// Historical 'games:reportResult' updates rated the user against each bot's
// NOMINAL level label. Sub-floor (<1320) engine levels actually play measurably
// stronger than their labels (see src/shared/botStrength.ts calibration record),
// so every stored update against them was wrong. The game table keeps enough to
// reconstruct the truth per game, opponent_kind ('engine' | 'persona'),
// opponent_elo (the nominal label as reported at save time), result and
// user_color, so instead of resetting the rating to provisional we REPLAY the
// entire vs-bot history from the seed with corrected opponent Elos.
//
// This module is deliberately electron-free (node:sqlite is type-only) so
// scripts/test-ratings-integrity.mjs can esbuild-bundle it and exercise the
// migration on a temp DB. database.ts calls migrateRatingsIntegrityV8 from its
// user_version<8 block.

import type { DatabaseSync } from 'node:sqlite'
import { glicko2Update, type Glicko } from '../rating/glicko2'
import { measuredElo, type RatedBotConfig } from './botStrength'

/** The rating a fresh profile starts from (mirrors the v1 migration seed and
 *  ratings.repo.ts getRating fallback). */
export const VS_BOT_SEED: Glicko = { rating: 1200, rd: 350, vol: 0.06 }

/** Per-opponent RD + tau used by applyGameResult (ratings.repo.ts). The replay
 *  must use identical constants or the recompute would disagree with the live
 *  updater on the SAME inputs. */
export const VS_BOT_OPPONENT_RD = 60
export const VS_BOT_TAU = 0.5

interface HistoryRow {
  user_color: string
  result: string
  opponent_kind: string
  opponent_elo: number
}

/** User-perspective score for a stored result, or null when unrateable. */
function scoreOf(result: string, userColor: string): number | null {
  if (result === '1/2-1/2') return 0.5
  if (result === '1-0') return userColor === 'white' ? 1 : 0
  if (result === '0-1') return userColor === 'black' ? 1 : 0
  return null
}

export interface RecomputeResult extends Glicko {
  /** Number of games that entered the replay. */
  games: number
}

/**
 * Replay the full vs-bot history from the seed, rating each game against
 * `mapElo(config)` (defaults to the measured-strength truth), and persist the
 * result to the rating table. Deterministic and idempotent: the output depends
 * only on the game table, so running it twice writes the same row.
 */
export function recomputeVsBotGlicko(
  db: DatabaseSync,
  mapElo: (config: RatedBotConfig) => number = measuredElo
): RecomputeResult {
  const rows = db
    .prepare(
      `SELECT user_color, result, opponent_kind, opponent_elo
         FROM game
        WHERE opponent_kind IN ('engine','persona','maia')
          AND opponent_elo IS NOT NULL
          AND user_color IN ('white','black')
          AND result IN ('1-0','0-1','1/2-1/2')
          AND source = 'play'
        ORDER BY created_at ASC, id ASC`
    )
    .all() as unknown as HistoryRow[]

  let g: Glicko = { ...VS_BOT_SEED }
  let games = 0
  for (const row of rows) {
    const score = scoreOf(row.result, row.user_color)
    if (score === null) continue
    // Preserve maia/persona (measuredElo passes their nominal Elo through as the
    // human-like net's rating); everything else is a raw engine level. Coercing
    // maia→engine here silently dropped Maia games AND re-labeled their strength.
    const kind: RatedBotConfig['kind'] =
      row.opponent_kind === 'persona' || row.opponent_kind === 'maia'
        ? row.opponent_kind
        : 'engine'
    const opponent = mapElo({ kind, elo: row.opponent_elo })
    g = glicko2Update(g, [{ rating: opponent, rd: VS_BOT_OPPONENT_RD, score }], VS_BOT_TAU)
    games++
  }

  db.prepare(
    `INSERT INTO rating(kind, rating, rd, vol, updated_at) VALUES ('vs-bot',?,?,?,?)
     ON CONFLICT(kind) DO UPDATE SET rating=excluded.rating, rd=excluded.rd,
       vol=excluded.vol, updated_at=excluded.updated_at`
  ).run(g.rating, g.rd, g.vol, Date.now())

  return { ...g, games }
}

/**
 * The user_version 7 → 8 migration body: recompute the vs-bot Glicko from the
 * stored per-game opponent labels using the measured-strength mapping. The
 * caller (database.ts migrate()) owns the transaction + PRAGMA bump.
 */
export function migrateRatingsIntegrityV8(db: DatabaseSync): RecomputeResult {
  return recomputeVsBotGlicko(db)
}
