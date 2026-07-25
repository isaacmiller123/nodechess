import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import { handle } from './util'
import { getAppDb } from '../db/database'

// Maintenance / destructive-ops IPC. Kept separate from app.ipc so the reset
// surface (and future ops like re-index / vacuum) has one obvious home.
//
// app:resetProgress wipes locally stored progress per scope:
//   school:   chapter/lesson/test progress, concept mastery + SRS, study-day
//             streak, and placement (games deleted, school_placement re-locked).
//   puzzles: attempt history, Rush runs, Daily results, puzzle SRS cards, and
//             the public puzzle rating (re-seeded).
//   games:    saved games, the activity feed (progress_event), cached game
//             reviews, and the public vs-bot rating (re-seeded).
// Each scope runs in its own transaction so one failing scope never leaves a
// half-wiped sibling; a repeat call is a harmless no-op (idempotent deletes).

const resetProgressSchema = z
  .object({
    scopes: z.array(z.enum(['school', 'puzzles', 'games'])).min(1)
  })
  .strict()

type ResetScope = z.infer<typeof resetProgressSchema>['scopes'][number]

/** Glicko-2 seed row MUST match the migration seed in db/database.ts. */
const GLICKO_SEED = { rating: 1200, rd: 350, vol: 0.06 } as const

/** True when `name` exists as a table. Needed for review.ts's lazily created
 *  cache tables (game_review / move_eval), which are absent until the first
 *  game review runs. */
function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name)
  return row !== undefined
}

/** Re-seed one public Glicko rating row (kind 'puzzle' | 'vs-bot'). */
function reseedRating(db: DatabaseSync, kind: 'puzzle' | 'vs-bot', now: number): void {
  db.prepare('UPDATE rating SET rating=?, rd=?, vol=?, updated_at=? WHERE kind=?').run(
    GLICKO_SEED.rating,
    GLICKO_SEED.rd,
    GLICKO_SEED.vol,
    now,
    kind
  )
}

/** School: every teaching artifact + placement back to the locked first-run
 *  state (placed=0, estimate cleared): mirrors placement.repo.resetPlacement
 *  but wipes ALL progress rows, not just auto_completed placement artifacts. */
function wipeSchool(db: DatabaseSync, now: number): void {
  db.exec(`
    DELETE FROM chapter_progress;
    DELETE FROM lesson_progress;
    DELETE FROM chapter_test;
    DELETE FROM concept_mastery;
    DELETE FROM concept_srs;
    DELETE FROM school_day;
    DELETE FROM placement_game;
  `)
  db.prepare(
    `UPDATE school_placement
       SET placed=0, estimated_elo=NULL, est_low=NULL, est_high=NULL, updated_at=?
     WHERE id=1`
  ).run(now)
}

/** Puzzles: history + Rush + Daily + SRS cards, and the puzzle rating re-seeded. */
function wipePuzzles(db: DatabaseSync, now: number): void {
  db.exec(`
    DELETE FROM puzzle_attempt;
    DELETE FROM puzzle_rush_run;
    DELETE FROM daily_result;
    DELETE FROM srs_card;
  `)
  reseedRating(db, 'puzzle', now)
}

/** Games: saved games + activity feed + cached reviews, and the vs-bot rating
 *  re-seeded (per the Api contract: games covers the vs-bot rating). */
function wipeGames(db: DatabaseSync, now: number): void {
  db.exec(`
    DELETE FROM game;
    DELETE FROM progress_event;
  `)
  // Review cache tables are created lazily by review.ts. Guard their absence.
  if (tableExists(db, 'game_review')) db.exec('DELETE FROM game_review')
  if (tableExists(db, 'move_eval')) db.exec('DELETE FROM move_eval')
  reseedRating(db, 'vs-bot', now)
}

const WIPERS: Record<ResetScope, (db: DatabaseSync, now: number) => void> = {
  school: wipeSchool,
  puzzles: wipePuzzles,
  games: wipeGames
}

/** Run one scope's wipe in its own transaction (rolls back on any failure). */
function runScope(db: DatabaseSync, scope: ResetScope): void {
  db.exec('BEGIN')
  try {
    WIPERS[scope](db, Date.now())
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function registerMaintenance(): void {
  handle('app:resetProgress', resetProgressSchema, ({ scopes }) => {
    const db = getAppDb()
    // Dedupe so ['school','school'] doesn't run (harmlessly) twice.
    for (const scope of new Set(scopes)) runScope(db, scope)
    return { ok: true }
  })
}
