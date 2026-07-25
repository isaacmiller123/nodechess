import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { migrateRatingsIntegrityV8, recomputeVsBotGlicko } from '../ratings/recompute'

// We use Node's built-in node:sqlite (Electron 42 / Node 24). No native module
// build needed. The puzzles.sqlite (imported at runtime, or bundled) is opened
// read-only; the writable app.sqlite lives in an INJECTED directory: this
// module is deliberately electron-free (web-port seam, docs/WEB-PORT-SPEC.md)
// so the same repos + migrations run under Electron AND the web server. The
// desktop injects app.getPath('userData') + datasets/paths resolvers from
// src/main/index.ts; the web server injects its own data dir.

export interface DbConfig {
  /** Directory the writable app.sqlite lives in (created if missing). */
  appDbDir: string
  /** Puzzle-DB resolution, when this process serves puzzles. Callbacks (not a
   *  fixed path) because the desktop's answer changes at runtime: a dataset
   *  imported mid-session must win over the bundled copy on the next open. */
  puzzles?: {
    /** Path getPuzzlesDb() opens (imported-first, then bundled). */
    resolvePath: () => string
    /** Whether a puzzle DB actually exists at the resolved path. */
    installed: () => boolean
  }
}

let config: DbConfig | null = null
let puzzlesDb: DatabaseSync | null = null
let appDb: DatabaseSync | null = null
let dbOverride: (() => DatabaseSync) | null = null

/** Open (creating if needed) an app DB in `dir` and run the full migration
 *  chain. getAppDb() uses this for the process singleton; the web server uses
 *  it directly for its per-user DB files (docs/WEB-PORT-SPEC.md W3). */
export function openAppDb(dir: string): DatabaseSync {
  fs.mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'app.sqlite'))
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;')
  migrate(db)
  return db
}

/** Reroute getAppDb() (and with it every repo) to another DB for the duration
 *  of one request: the web server's per-user scoping. The server serializes
 *  bridge calls, sets the override, awaits the handler, clears it. The
 *  desktop never calls this. */
export function setDbOverride(get: (() => DatabaseSync) | null): void {
  dbOverride = get
}

/** Inject where the DBs live. Must run once, before any getAppDb()/getPuzzlesDb()
 *  caller: the desktop does this at startup in src/main/index.ts. */
export function configureDb(c: DbConfig): void {
  config = c
}

/** True once the puzzle DB has been imported (or bundled). */
export function hasPuzzlesDb(): boolean {
  return config?.puzzles?.installed() ?? false
}

export function getPuzzlesDb(): DatabaseSync {
  if (!puzzlesDb) {
    const puzzles = config?.puzzles
    if (!puzzles) throw new Error('configureDb() ran without a puzzles source in this process')
    puzzlesDb = new DatabaseSync(puzzles.resolvePath(), { readOnly: true })
  }
  return puzzlesDb
}

export function getAppDb(): DatabaseSync {
  if (dbOverride) return dbOverride()
  if (!appDb) {
    if (!config) throw new Error('configureDb() must run before getAppDb()')
    appDb = openAppDb(config.appDbDir)
  }
  return appDb
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (row.user_version < 1) {
    db.exec('BEGIN')
    try {
      db.exec(`
      CREATE TABLE game(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        white_name TEXT, black_name TEXT,
        user_color TEXT,              -- 'white' | 'black' | null
        result TEXT,                  -- '1-0' | '0-1' | '1/2-1/2' | '*'
        opponent_kind TEXT,           -- 'engine' | 'persona' | 'human' | 'analysis'
        opponent_label TEXT,
        opponent_elo INTEGER,
        source TEXT,                  -- 'play' | 'import' | 'analysis'
        pgn TEXT NOT NULL,
        accuracy_white REAL, accuracy_black REAL,
        est_elo_low INTEGER, est_elo_high INTEGER,
        reviewed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_game_created ON game(created_at DESC);

      CREATE TABLE puzzle_attempt(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        puzzle_id TEXT NOT NULL,
        solved INTEGER NOT NULL,
        ms INTEGER,
        rating_before REAL, rating_after REAL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_attempt_created ON puzzle_attempt(created_at DESC);
      CREATE INDEX idx_attempt_puzzle ON puzzle_attempt(puzzle_id);

      CREATE TABLE rating(
        kind TEXT PRIMARY KEY,        -- 'puzzle' | 'vs-bot'
        rating REAL NOT NULL, rd REAL NOT NULL, vol REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE srs_card(
        puzzle_id TEXT PRIMARY KEY,
        due INTEGER NOT NULL,
        stability REAL, difficulty REAL,
        reps INTEGER NOT NULL DEFAULT 0,
        lapses INTEGER NOT NULL DEFAULT 0,
        state INTEGER NOT NULL DEFAULT 0,
        last_review INTEGER
      );
      CREATE INDEX idx_srs_due ON srs_card(due);

      CREATE TABLE progress_event(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,           -- 'puzzle' | 'game' | 'lesson'
        ref TEXT,
        value REAL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_progress_created ON progress_event(created_at DESC);

      CREATE TABLE setting(key TEXT PRIMARY KEY, value TEXT);
    `)
    const now = Date.now()
    const seed = db.prepare(
      'INSERT OR IGNORE INTO rating(kind,rating,rd,vol,updated_at) VALUES (?,?,?,?,?)'
    )
    seed.run('puzzle', 1200, 350, 0.06, now)
    seed.run('vs-bot', 1200, 350, 0.06, now)
      db.exec('PRAGMA user_version = 1')
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  if (row.user_version < 2) {
    // Chess School: per-concept mastery + per-chapter progress (Viktor coaching).
    db.exec('BEGIN')
    try {
      db.exec(`
      CREATE TABLE concept_mastery(
        concept_id TEXT PRIMARY KEY,
        mastery REAL NOT NULL DEFAULT 0,   -- 0..1 rolling estimate
        seen INTEGER NOT NULL DEFAULT 0,
        correct INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE chapter_progress(
        chapter_id TEXT PRIMARY KEY,
        segments_done INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        boss_won INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = 2;
    `)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  if (row.user_version < 3) {
    // Full-chapter school: per-lesson completion + per-chapter test state.
    db.exec('BEGIN')
    try {
      db.exec(`
      CREATE TABLE lesson_progress(
        chapter_id TEXT,
        lesson_id TEXT,
        done INTEGER,
        updated_at INTEGER,
        PRIMARY KEY(chapter_id, lesson_id)
      );
      CREATE TABLE chapter_test(
        chapter_id TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        passed INTEGER NOT NULL DEFAULT 0,
        best_pct REAL NOT NULL DEFAULT 0,
        updated_at INTEGER
      );
      PRAGMA user_version = 3;
    `)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  if (row.user_version < 4) {
    // Placement & unlock: a single-row store of the user's INTERNAL estimated Elo
    // (gates lesson unlocking; never shown) + the placement games behind it.
    // estimated_elo may move DOWN as well as up (mis-placement correction), so it
    // is overwritten, not Math.max'd. Kept SEPARATE from the Glicko `rating` table.
    db.exec('BEGIN')
    try {
      db.exec(`
      CREATE TABLE school_placement(
        id INTEGER PRIMARY KEY CHECK(id = 1),
        placed INTEGER NOT NULL DEFAULT 0,
        estimated_elo REAL,
        est_low REAL,
        est_high REAL,
        updated_at INTEGER
      );
      INSERT OR IGNORE INTO school_placement(id, placed) VALUES (1, 0);
      CREATE TABLE placement_game(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engine_elo INTEGER,
        accuracy REAL,
        move_count INTEGER,
        est REAL,
        low REAL,
        high REAL,
        created_at INTEGER NOT NULL
      );
      PRAGMA user_version = 4;
    `)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  if (row.user_version < 5) {
    // Puzzles trainer overhaul. Three slices in ONE migration block:
    //   (A) Themed/Custom training, (B) Puzzle Rush/Storm, (C) Daily + stats/history.
    //
    // puzzle_attempt gains `theme` + `mode` so per-theme stats (slice C) and
    //   mode-scoped history are queryable without re-deriving from the puzzle DB.
    //   `mode` distinguishes how the attempt was made ('train' | 'rush' | 'daily' |
    //   'custom'); rating-affecting attempts stay 'train'/'daily' (Rush does NOT
    //   move the Glicko rating. It has its own high-score record).
    // puzzle_rush_run is one finished Rush/Storm run (slice B): mode, score, the
    //   accuracy/streak stats, and the duration. Indexed by score for leaderboard
    //   reads and by created_at for history.
    // daily_result is one row per UTC day (slice C): the deterministic daily
    //   puzzle's id, whether it was solved first-try, and when, the source of the
    //   daily-streak computation. `ymd` is the YYYY-MM-DD key (UTC).
    db.exec('BEGIN')
    try {
      db.exec(`
      ALTER TABLE puzzle_attempt ADD COLUMN theme TEXT;
      ALTER TABLE puzzle_attempt ADD COLUMN mode TEXT NOT NULL DEFAULT 'train';
      CREATE INDEX idx_attempt_theme ON puzzle_attempt(theme);
      CREATE INDEX idx_attempt_mode ON puzzle_attempt(mode);

      CREATE TABLE puzzle_rush_run(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL,            -- 'rush3' | 'rush5' | 'storm' | 'survival'
        score INTEGER NOT NULL,        -- puzzles solved
        solved INTEGER NOT NULL,
        missed INTEGER NOT NULL,
        best_streak INTEGER NOT NULL DEFAULT 0,
        top_rating INTEGER,            -- hardest puzzle solved (rating), if tracked
        duration_ms INTEGER NOT NULL DEFAULT 0,
        ended_reason TEXT,             -- 'time' | 'lives' | 'quit' | 'cleared'
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_rush_score ON puzzle_rush_run(mode, score DESC);
      CREATE INDEX idx_rush_created ON puzzle_rush_run(created_at DESC);

      CREATE TABLE daily_result(
        ymd TEXT PRIMARY KEY,          -- 'YYYY-MM-DD' (UTC)
        puzzle_id TEXT NOT NULL,
        solved INTEGER NOT NULL,
        first_try INTEGER NOT NULL DEFAULT 0,
        ms INTEGER,
        created_at INTEGER NOT NULL
      );
      PRAGMA user_version = 5;
    `)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  if (row.user_version < 6) {
    // Chess School: spaced repetition of concepts + daily-lesson/streak surface.
    //
    // concept_srs is one SM-2-lite card per taught concept (NOT full FSRS; see
    //   school plan): `due` epoch-ms when the concept is next owed a review,
    //   `stability`/`difficulty` the SM-2 ease/interval state, reps/lapses the
    //   counters, `state` (0 new / 1 learning / 2 review), last_review epoch-ms.
    //   Indexed by `due` so "what's owed now" is an indexed range scan.
    // school_day is one row per LOCAL calendar day the user did School work,
    //   `lesson_done` set once a daily lesson is completed, `review_done` once an
    //   SRS review is done that day; either counts the day toward the streak. `ymd`
    //   is the user's LOCAL 'YYYY-MM-DD' (see src/main/util/day.ts). Deliberately
    //   LOCAL, not UTC, because the study streak is a private habit metric.
    db.exec('BEGIN')
    try {
      db.exec(`
      CREATE TABLE concept_srs(
        concept_id TEXT PRIMARY KEY,
        due INTEGER NOT NULL,
        stability REAL,
        difficulty REAL,
        reps INTEGER NOT NULL DEFAULT 0,
        lapses INTEGER NOT NULL DEFAULT 0,
        state INTEGER NOT NULL DEFAULT 0,
        last_review INTEGER
      );
      CREATE INDEX idx_concept_srs_due ON concept_srs(due);

      CREATE TABLE school_day(
        ymd TEXT PRIMARY KEY,          -- 'YYYY-MM-DD' (LOCAL day)
        lesson_done INTEGER DEFAULT 0,
        review_done INTEGER,
        created_at INTEGER NOT NULL
      );
      PRAGMA user_version = 6;
    `)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  if (row.user_version < 7) {
    // Placement provenance: mark which chapter_progress / lesson_progress rows
    // were bulk-written by the placement auto-completion (bulkCompleteChapters)
    // rather than earned by actually studying. auto_completed=1 rows are
    // placement artifacts: a lower re-placement prunes the ones above the new
    // estimate, and school:resetPlacement deletes them all. Manual rows
    // (recordLesson / completeChapter / recordSegment write 0) always survive.
    // Pre-migration rows default to 0 (treated as earned) so an existing DB never
    // loses progress it can't attribute.
    db.exec('BEGIN')
    try {
      db.exec(`
      ALTER TABLE chapter_progress ADD COLUMN auto_completed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE lesson_progress ADD COLUMN auto_completed INTEGER NOT NULL DEFAULT 0;
      PRAGMA user_version = 7;
    `)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  if (row.user_version < 8) {
    // Ratings integrity: every historical vs-bot Glicko update rated the user
    // against the bot's NOMINAL level label, but sub-floor (<1320) engine
    // levels measurably play up to ~+270 Elo above their labels (calibration
    // record in src/shared/botStrength.ts): the stored rating is corrupted.
    // The game table stores opponent_kind + opponent_elo per game, so the
    // corrected labels ARE reconstructible: replay the whole history from the
    // seed via measuredElo() instead of resetting to provisional. No schema
    // change; the bump just makes the one-time recompute run exactly once.
    db.exec('BEGIN')
    try {
      migrateRatingsIntegrityV8(db)
      db.exec('PRAGMA user_version = 8')
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  if (row.user_version < 9) {
    // Variant Lab: user-authored custom chess variants. `ini_text` (a
    // Fairy-Stockfish variants.ini snippet) is the single source of truth for
    // the rules; `id` is a client-generated slug and the dynamic game kind is
    // 'custom-<id>' (src/renderer/src/games/customVariants.ts). board_files/
    // board_ranks are denormalized so the gallery can draw cards without
    // parsing ini text. Gallery orders by updated_at DESC.
    db.exec('BEGIN')
    try {
      db.exec(`
      CREATE TABLE custom_variant(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        ini_text TEXT NOT NULL,
        board_files INTEGER NOT NULL,
        board_ranks INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_custom_variant_updated ON custom_variant(updated_at DESC);
      PRAGMA user_version = 9;
    `)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  if (row.user_version < 10) {
    // (1) game_kind: the games platform archives non-chess online games (go,
    //     othello, …) into this same table; without a family tag they polluted
    //     the chess Analysis/Progress/Home lists and opened as broken boards.
    //     Existing rows are all standard chess → default 'chess'.
    // (2) Maia self-heal: the v8 vs-bot recompute excluded opponent_kind='maia'
    //     (and coerced it to 'engine'), so anyone who played Maia bots carries a
    //     wrong vs-bot rating. recomputeVsBotGlicko now includes maia; re-run it
    //     once here (idempotent: replays the whole history from the seed).
    db.exec('BEGIN')
    try {
      db.exec(`ALTER TABLE game ADD COLUMN game_kind TEXT NOT NULL DEFAULT 'chess';`)
      recomputeVsBotGlicko(db)
      db.exec('PRAGMA user_version = 10;')
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

export function closeDbs(): void {
  puzzlesDb?.close()
  appDb?.close()
  puzzlesDb = null
  appDb = null
}
