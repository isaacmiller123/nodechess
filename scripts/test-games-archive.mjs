#!/usr/bin/env node
// Games-archive migration + filter suite (audit fix: non-chess online games
// polluted the chess Analysis/Progress/Home lists).
//
//   node scripts/test-games-archive.mjs
//
// Verifies, against a real node:sqlite temp DB, the exact SQL the v10 migration
// and games.repo use:
//   1. The v10 ALTER (game_kind TEXT NOT NULL DEFAULT 'chess') is accepted and
//      backfills every pre-existing row to 'chess' (no data loss).
//   2. The listGames filter (WHERE game_kind='chess') surfaces chess games and
//      hides non-chess ones (go/othello/…), which the chess PGN parser + review
//      engine cannot render.
// Exit 1 on any failure.

import { DatabaseSync } from 'node:sqlite'

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? `, ${detail}` : ''}`)
  }
}

// Pre-v10 game table (game_kind column absent), matching database.ts's CREATE.
const db = new DatabaseSync(':memory:')
db.exec(`
  CREATE TABLE game(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    white_name TEXT, black_name TEXT, user_color TEXT, result TEXT,
    opponent_kind TEXT, opponent_label TEXT, opponent_elo INTEGER,
    source TEXT, pgn TEXT NOT NULL DEFAULT ''
  );
`)
let t = 1000
const ins = (source, pgn) =>
  db.prepare('INSERT INTO game(created_at,source,pgn) VALUES (?,?,?)').run(t++, source, pgn)
ins('play', '1. e4 e5')
ins('online', '1. d4 d5')

// ---- 1. the exact v10 ALTER ----------------------------------------------------
console.log('v10 migration ALTER')
db.exec(`ALTER TABLE game ADD COLUMN game_kind TEXT NOT NULL DEFAULT 'chess';`)
const backfilled = db.prepare("SELECT COUNT(*) c FROM game WHERE game_kind='chess'").get()
check('ALTER accepted; existing rows backfilled to chess', backfilled.c === 2, `got ${backfilled.c}`)

// ---- 2. new saves stamp their kind; filter hides non-chess ----------------------
console.log('game_kind stamping + list filter')
const insK = (kind, pgn) =>
  db.prepare('INSERT INTO game(created_at,source,pgn,game_kind) VALUES (?,?,?,?)').run(t++, 'online', pgn, kind)
insK('chess', '1. c4') // an online chess game must still appear
insK('go', 'B[pd];W[dd]') // a go game: must be hidden
insK('othello', 'f5 d6') // othello: hidden

// The exact listGames query.
const listed = db
  .prepare("SELECT game_kind FROM game WHERE game_kind = 'chess' ORDER BY created_at DESC")
  .all()
check('chess-only filter returns all 3 chess games', listed.length === 3, `got ${listed.length}`)
check('no non-chess kind leaks into the list', listed.every((r) => r.game_kind === 'chess'))
const total = db.prepare('SELECT COUNT(*) c FROM game').get()
check('non-chess games are stored, not dropped', total.c === 5, `got ${total.c}`)

db.close()

// ---- 3. the REAL migrate() chain (database.ts), headless -----------------------
// The shape checks above prove the SQL; this proves database.ts actually runs it.
// Same electron-stub discipline as scripts/test-settings-persist.mjs: esbuild
// bundles the REAL db/database.ts + db/games.repo.ts with `electron` aliased to
// a stub whose app.getPath('userData') reads globalThis.__userData, so each case
// below points getAppDb() at its own temp dir and exercises the true migration.
console.log('real migrate() chain (fresh 0→10 and v9→10)')
{
  const { execSync } = await import('node:child_process')
  const { pathToFileURL, fileURLToPath } = await import('node:url')
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = (await import('node:path')).default

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dir = mkdtempSync(path.join(tmpdir(), 'games-archive-'))
  const stubPath = path.join(dir, 'electron-stub.mjs')
  writeFileSync(
    stubPath,
    `export const app = { getPath: () => globalThis.__userData }
export const ipcMain = { handle: () => {} }
`
  )
  const entryPath = path.join(dir, 'entry.mjs')
  writeFileSync(
    entryPath,
    `export { configureDb, getAppDb, closeDbs } from ${JSON.stringify(path.join(repoRoot, 'src/main/db/database.ts'))}
export { saveGame, listGames, getGame } from ${JSON.stringify(path.join(repoRoot, 'src/main/db/games.repo.ts'))}
export { recomputeVsBotGlicko } from ${JSON.stringify(path.join(repoRoot, 'src/main/ratings/recompute.ts'))}
`
  )
  const out = path.join(dir, 'db.bundle.mjs')
  execSync(
    `npx esbuild ${entryPath} --bundle --platform=node --format=esm --alias:electron=${stubPath} --outfile=${out}`,
    { stdio: 'pipe', cwd: repoRoot }
  )
  const M = await import(pathToFileURL(out).href)
  const userVersion = (d) => d.prepare('PRAGMA user_version').get().user_version

  // ---- 3a. FRESH DB: 0 → 10 in one open --------------------------------------
  const freshDir = path.join(dir, 'fresh')
  mkdirSync(freshDir, { recursive: true })
  globalThis.__userData = freshDir
  // DB seam (WEB-PORT-SPEC W1): database.ts takes an injected dir, not app.getPath.
  M.configureDb({ appDbDir: freshDir })
  {
    const adb = M.getAppDb()
    check('fresh open lands on user_version 10', userVersion(adb) === 10, `got ${userVersion(adb)}`)
    const cols = adb.prepare('PRAGMA table_info(game)').all().map((c) => c.name)
    check('fresh schema has game_kind', cols.includes('game_kind'))
    // The real saveGame/listGames against the real schema.
    const chessId = M.saveGame({ pgn: '1. e4 e5', source: 'online' })
    M.saveGame({ pgn: 'B[pd];W[dd]', source: 'online', gameKind: 'go' })
    const listedRows = M.listGames()
    check('real listGames returns only the chess row', listedRows.length === 1 && listedRows[0].id === chessId)
    check('real listGames row carries game_kind', listedRows[0].game_kind === 'chess')
    const goRow = M.getGame(chessId + 1)
    check("real getGame still loads the go row (game_kind 'go')", goRow?.game_kind === 'go')
    // Idempotent re-open: closeDbs + fresh getAppDb re-runs migrate() harmlessly.
    M.closeDbs()
    const adb2 = M.getAppDb()
    check('fresh re-open stays at user_version 10', userVersion(adb2) === 10)
    check('re-open keeps the rows', adb2.prepare('SELECT COUNT(*) c FROM game').get().c === 2)
    M.closeDbs()
  }

  // ---- 3b. v9 → 10: seeded pre-v10 DB (maia game + stale rating) --------------
  // Build the file EXACTLY as a v9 app left it: game table without game_kind,
  // rating table with a WRONG vs-bot row (the v8 recompute that dropped maia),
  // user_version = 9. Only the v10 block may run on open.
  const v9Dir = path.join(dir, 'v9')
  mkdirSync(v9Dir, { recursive: true })
  {
    const seed = new DatabaseSync(path.join(v9Dir, 'app.sqlite'))
    seed.exec(`
      CREATE TABLE game(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        white_name TEXT, black_name TEXT, user_color TEXT, result TEXT,
        opponent_kind TEXT, opponent_label TEXT, opponent_elo INTEGER,
        source TEXT, pgn TEXT NOT NULL DEFAULT '',
        accuracy_white REAL, accuracy_black REAL,
        est_elo_low INTEGER, est_elo_high INTEGER,
        reviewed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE rating(
        kind TEXT PRIMARY KEY,
        rating REAL NOT NULL, rd REAL NOT NULL, vol REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO rating(kind,rating,rd,vol,updated_at) VALUES ('vs-bot', 999, 350, 0.06, 0);
      INSERT INTO game(created_at,user_color,result,opponent_kind,opponent_elo,source,pgn)
        VALUES (1, 'white', '1-0', 'engine', 1200, 'play', '1. e4'),
               (2, 'white', '1-0', 'maia',   1500, 'play', '1. d4');
      PRAGMA user_version = 9;
    `)
    seed.close()
  }
  globalThis.__userData = v9Dir
  M.configureDb({ appDbDir: v9Dir })
  {
    const adb = M.getAppDb() // the REAL migrate() runs the v10 block here
    check('v9→10 open lands on user_version 10', userVersion(adb) === 10, `got ${userVersion(adb)}`)
    const kinds = adb.prepare('SELECT game_kind, COUNT(*) c FROM game GROUP BY game_kind').all()
    check(
      "v9 rows all backfilled to game_kind 'chess'",
      kinds.length === 1 && kinds[0].game_kind === 'chess' && kinds[0].c === 2,
      JSON.stringify(kinds)
    )
    // Maia self-heal: the stored rating must equal the full 2-game replay
    // (recomputeVsBotGlicko is idempotent, so re-running it must not move it),
    // and must have replaced the seeded garbage 999.
    const stored = adb.prepare("SELECT rating, rd, vol FROM rating WHERE kind='vs-bot'").get()
    check('v10 replaced the stale vs-bot rating', Math.abs(stored.rating - 999) > 1, `still ${stored.rating}`)
    const again = M.recomputeVsBotGlicko(adb)
    check('self-heal counted BOTH games (engine + maia)', again.games === 2, `got ${again.games}`)
    check(
      'stored rating IS the maia-inclusive replay (idempotent)',
      Math.abs(again.rating - stored.rating) < 1e-9 &&
        Math.abs(again.rd - stored.rd) < 1e-9 &&
        Math.abs(again.vol - stored.vol) < 1e-12,
      JSON.stringify({ again, stored })
    )
    // Idempotent re-open of the migrated file.
    M.closeDbs()
    const adb2 = M.getAppDb()
    check('v9→10 re-open stays at user_version 10', userVersion(adb2) === 10)
    M.closeDbs()
  }
}

// ---- 4. archive envelope (src/shared/gameArchive.ts) ---------------------------
// The pgn-column contract for NON-chess kinds: encode/parse round trip, format
// sniffing against real PGN / legacy tag text, strict-parse rejects, and an
// end-to-end archive → replay pipe through a real kernel spec.
console.log('archive envelope (shared/gameArchive + games/archive)')
{
  const { execSync } = await import('node:child_process')
  const { pathToFileURL, fileURLToPath } = await import('node:url')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = (await import('node:path')).default

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dir = mkdtempSync(path.join(tmpdir(), 'game-archive-env-'))
  const entryPath = path.join(dir, 'entry.mjs')
  writeFileSync(
    entryPath,
    `export * from ${JSON.stringify(path.join(repoRoot, 'src/shared/gameArchive.ts'))}
export { archiveFinishedGame, replayOptionsOf } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/src/games/archive.ts'))}
export { notateGame } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/src/games/kernel.ts'))}
export { CONNECT4_SPEC } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/src/games/small/connect4.ts'))}
export { GO_SPEC } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/src/games/go.ts'))}
export { CHESS_VARIANT_SPECS } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/src/games/chessVariants.ts'))}
`
  )
  const out = path.join(dir, 'archive.bundle.mjs')
  execSync(
    `npx esbuild ${entryPath} --bundle --platform=node --format=esm --loader:.css=empty ` +
      `--alias:@shared=${path.join(repoRoot, 'src/shared')} --outfile=${out}`,
    { stdio: 'pipe', cwd: repoRoot }
  )
  const A = await import(pathToFileURL(out).href)

  // -- encode/parse round trip ----------------------------------------------------
  const env = {
    v: 1,
    kind: 'gomoku',
    moves: ['h8', 'h9', 'j8'],
    result: '0-1',
    meta: { notated: ['B H8', 'W H9', 'B J8'], reason: 'five-in-a-row', white: 'You', black: 'Bot L3' }
  }
  const text = A.encodeGameArchive(env)
  check('encode emits one JSON object, v first', text.startsWith('{"v":1,'), text.slice(0, 24))
  const back = A.parseGameArchive(text)
  check('round trip preserves the envelope', JSON.stringify(back) === JSON.stringify(env))
  const minimal = A.parseGameArchive(A.encodeGameArchive({ v: 1, kind: 'ttt', moves: [], result: '1/2-1/2' }))
  check('meta-less minimal envelope is valid', minimal !== null && minimal.meta === undefined)

  // -- sniffing: envelopes vs the two text formats sharing the column --------------
  check('isArchiveJson accepts an envelope', A.isArchiveJson(text))
  check('isArchiveJson accepts leading whitespace', A.isArchiveJson('  \n' + text))
  check('isArchiveJson rejects real chess PGN', !A.isArchiveJson('[Event "Casual"]\n\n1. e4 e5 1-0'))
  check(
    'isArchiveJson rejects the legacy online tag format',
    !A.isArchiveJson('[Variant "gomoku"]\n\nh8 a1 f8 0-1\n')
  )
  check('isArchiveJson rejects bare movetext', !A.isArchiveJson('1. e4 e5'))

  // -- strict parse rejects ---------------------------------------------------------
  check('parse rejects corrupt JSON', A.parseGameArchive('{"v":1,"kind":') === null)
  check('parse rejects a FUTURE version', A.parseGameArchive('{"v":2,"kind":"go","moves":[],"result":"1-0"}') === null)
  check('parse rejects a missing kind', A.parseGameArchive('{"v":1,"moves":[],"result":"1-0"}') === null)
  check(
    'parse rejects non-string moves',
    A.parseGameArchive('{"v":1,"kind":"go","moves":[3],"result":"1-0"}') === null
  )
  check(
    'parse rejects an unknown result token',
    A.parseGameArchive('{"v":1,"kind":"go","moves":[],"result":"*"}') === null
  )
  check(
    'parse rejects a malformed meta.notated',
    A.parseGameArchive('{"v":1,"kind":"go","moves":["d4"],"result":"1-0","meta":{"notated":"B D4"}}') === null
  )

  // -- end-to-end: finished game → archiveFinishedGame → parse → kernel replay ------
  {
    const c4 = A.CONNECT4_SPEC
    let s = c4.init()
    const line = ['4', '5', '4', '5', '4', '5', '4'] // white wins the d-column
    for (const mv of line) s = c4.play(s, mv)
    const result = c4.result(s)
    check('connect4 fixture reaches 1-0', result?.score === '1-0' && result.winner === 'white')
    const pgn = A.archiveFinishedGame({
      spec: c4,
      start: c4.init(),
      moves: s.moves,
      result,
      white: 'You',
      black: 'Bot L2',
      event: 'Play vs Bot'
    })
    const parsed = A.parseGameArchive(pgn)
    check('archiveFinishedGame emits a parseable v1 envelope', parsed !== null && parsed.kind === 'connect4')
    check('envelope moves are the wire codec verbatim', parsed.moves.join(' ') === line.join(' '))
    check(
      'envelope notation is the landing-square form',
      parsed.meta?.notated?.join(' ') === 'd1 e1 d2 e2 d3 e3 d4'
    )
    check('envelope carries the result + reason', parsed.result === '1-0' && parsed.meta?.reason === 'connect4')
    check('envelope names both players', parsed.meta?.white === 'You' && parsed.meta?.black === 'Bot L2')
    // Replay EXACTLY as the Library viewer does: init(meta.options) + play().
    let r = c4.init(parsed.meta?.options)
    for (const mv of parsed.moves) {
      r = c4.play(r, mv)
      if (r === null) break
    }
    check('parsed envelope replays through the kernel spec', r !== null && c4.result(r)?.score === '1-0')
  }

  // -- replay options: start-position fidelity ---------------------------------------
  {
    const go = A.GO_SPEC
    const goStart = go.init({ size: 9, handicap: 2 })
    const opts = A.replayOptionsOf(go, goStart)
    const replayed = go.init(opts)
    check(
      'go replay options reproduce size + handicap (white to open)',
      replayed.size === 9 && replayed.handicap === 2 && go.turn(replayed) === 'white',
      JSON.stringify(opts)
    )
    const c960 = A.CHESS_VARIANT_SPECS.chess960
    const start960 = c960.init({ positionNumber: 42 })
    const opts960 = A.replayOptionsOf(c960, start960)
    check(
      'chess960 replay options pin the shuffled start FEN',
      c960.init(opts960).fen === start960.fen,
      JSON.stringify(opts960)
    )
  }
}

if (failures) {
  console.error(`\n${failures} FAILED`)
  process.exit(1)
}
console.log('\nALL GREEN: games-archive migration + filter + envelope')
