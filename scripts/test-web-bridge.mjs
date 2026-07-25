#!/usr/bin/env node
// Web IPC-bridge suite (web port W3+W4 — docs/WEB-PORT-SPEC.md, build contract §1/2/4/5).
//
//   node scripts/test-web-bridge.mjs
//
// Boots the REAL server (server/index.ts + the real ipc-bridge bundle) on an
// ephemeral port with a temp DATA_DIR and a tiny fixture puzzles.sqlite whose
// schema matches what src/main/db/puzzles.repo.ts queries (puzzles +
// puzzle_themes), then asserts the whole bridge contract:
//   - public content channels work logged-out against the anon DB:
//     puzzles:themes/next/get/batch (fixture DB), school:chapters/chapter,
//     famous:list, personas:list, app:dataVersion (proves the electron shim's
//     isPackaged=true + resourcesPath=<repo>/resources choice resolves content)
//   - private channels 401 logged-out; unknown channels 404; the excluded
//     desktop-only domains (engine/review/datasets/updates/dialog) are absent
//   - zod still gates payloads through the bundled handle() wrapper (400)
//   - per-user isolation: two accounts write games/settings/ratings into
//     DATA_DIR/users/<id>/app.sqlite and can never see each other's rows
//   - review persistence: POST /api/review/save + GET /api/review/:gameId
//     roundtrip, accuracy stamped onto the game row, cross-user reads null
// Exit 1 on any failure.

import { execSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(path.join(tmpdir(), 'webbridge-'))

// Fixture SPA root (the server refuses to boot without an index.html).
const webRoot = path.join(dir, 'dist-web')
mkdirSync(webRoot, { recursive: true })
writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>fixture</title>SPA-SHELL')

// ---- fixture puzzles.sqlite -------------------------------------------------
// Minimal tables matching src/main/db/puzzles.repo.ts reads: `puzzles` (full
// Lichess column set the repo SELECT *s) and the `puzzle_themes` junction the
// themed/next/batch queries + listThemes GROUP BY run over.
const puzzlesPath = path.join(dir, 'puzzles.sqlite')
{
  const pdb = new DatabaseSync(puzzlesPath)
  pdb.exec(`
    CREATE TABLE puzzles(
      PuzzleId TEXT PRIMARY KEY,
      FEN TEXT NOT NULL,
      Moves TEXT NOT NULL,
      Rating INTEGER NOT NULL,
      RatingDeviation INTEGER,
      Popularity INTEGER,
      NbPlays INTEGER,
      Themes TEXT,
      GameUrl TEXT,
      OpeningTags TEXT
    );
    CREATE TABLE puzzle_themes(
      PuzzleId TEXT NOT NULL,
      Theme TEXT NOT NULL,
      Rating INTEGER NOT NULL
    );
  `)
  const ins = pdb.prepare(
    'INSERT INTO puzzles(PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags) VALUES (?,?,?,?,?,?,?,?,?,?)'
  )
  const themeIns = pdb.prepare('INSERT INTO puzzle_themes(PuzzleId,Theme,Rating) VALUES (?,?,?)')
  const fixture = [
    ['fx001', '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', 'd1d8', 900, 80, 95, 1000, 'mate mateIn1 backRankMate', null, ''],
    ['fx002', 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4', 'f3g5 d7d5 e4d5', 1100, 90, 90, 800, 'fork short', null, 'Italian_Game'],
    ['fx003', '8/8/8/4k3/8/8/4P3/4K3 w - - 0 1', 'e2e4 e5e4', 1300, 75, 85, 500, 'endgame pawnEndgame', null, ''],
    ['fx004', 'rnbqkb1r/pppppppp/5n2/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 2 2', 'f3e5 f6e4', 1500, 70, 80, 300, 'fork opening', null, '']
  ]
  for (const row of fixture) {
    ins.run(...row)
    for (const theme of row[7].split(' ').filter(Boolean)) themeIns.run(row[0], theme, row[3])
  }
  pdb.close()
}
const FIXTURE_IDS = new Set(['fx001', 'fx002', 'fx003', 'fx004'])

const dataDir = path.join(dir, 'data')

// Bundle the server and the ipc bridge exactly like the build scripts do, into
// the SAME temp dir (index.cjs finds ipc-bridge.cjs next to itself).
const serverOut = path.join(dir, 'server.cjs')
const bridgeOut = path.join(dir, 'ipc-bridge.cjs')
execSync(
  `npx esbuild server/index.ts --bundle --platform=node --format=cjs ` +
    `--define:__WEB_APP_VERSION__='"0.0.0-test"' --outfile=${serverOut}`,
  { stdio: 'pipe', cwd: repoRoot }
)
execSync(
  `npx esbuild server/bridge-entry.ts --bundle --platform=node --format=cjs ` +
    `--alias:electron=${path.join(repoRoot, 'server/electron-shim.ts')} ` +
    `--alias:@shared=${path.join(repoRoot, 'src/shared')} ` +
    `--define:__WEB_APP_VERSION__='"0.0.0-test"' --outfile=${bridgeOut}`,
  { stdio: 'pipe', cwd: repoRoot }
)

const child = spawn(process.execPath, [serverOut], {
  env: {
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    WEB_ROOT: webRoot,
    DATA_DIR: dataDir,
    PUZZLES_PATH: puzzlesPath,
    RESOURCES_ROOT: path.join(repoRoot, 'resources'),
    LOG_LEVEL: 'silent'
  },
  stdio: ['ignore', 'pipe', 'inherit']
})

const base = await new Promise((resolvePromise, rejectPromise) => {
  const timer = setTimeout(() => rejectPromise(new Error('server never reported listening')), 15_000)
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += String(d)
    const m = buf.match(/nodechess-web listening (\S+)/)
    if (m) {
      clearTimeout(timer)
      resolvePromise(m[1])
    }
  })
  child.on('exit', (code) => rejectPromise(new Error(`server exited early (${code})`)))
})

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}`)
  }
}

function sidOf(res) {
  const cookies = res.headers.getSetCookie?.() ?? []
  for (const c of cookies) {
    const m = c.match(/^sid=([^;]*)/)
    if (m) return decodeURIComponent(m[1])
  }
  return null
}

const post = (p, body, cookie) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `sid=${cookie}` } : {}) },
    body: JSON.stringify(body)
  })
const get = (p, cookie) =>
  fetch(`${base}${p}`, { headers: cookie ? { cookie: `sid=${cookie}` } : {} })
const ipc = async (channel, payload = {}, cookie) => {
  const res = await post(`/api/ipc/${channel}`, payload, cookie)
  return { status: res.status, body: await res.json() }
}

/** A structurally valid 2-ply GameReview for the review-persistence roundtrip. */
function fixtureReview() {
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
  const afterE5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2'
  const mkMove = (over) => ({
    ply: 1,
    color: 'white',
    san: 'e4',
    uci: 'e2e4',
    fenBefore: start,
    fenAfter: afterE4,
    bestUci: 'e2e4',
    bestSan: 'e4',
    bestPv: ['e2e4', 'e7e5'],
    secondUci: 'd2d4',
    bestEval: { cp: 30, mate: null },
    playedEval: { cp: 30, mate: null },
    winBefore: 52,
    winAfter: 52,
    accuracy: 100,
    cpLoss: 0,
    winChancesDrop: 0,
    verdict: 'ok',
    badge: 'Best',
    comment: 'e4 is the best move.',
    isBest: true,
    critical: false,
    ...over
  })
  return {
    gameId: null,
    depth: 18,
    totalPlies: 2,
    white: { accuracy: 91.5, acpl: 12, moves: 1, inaccuracies: 0, mistakes: 0, blunders: 0, best: 1 },
    black: { accuracy: 44.2, acpl: 210, moves: 1, inaccuracies: 0, mistakes: 0, blunders: 1, best: 0 },
    whiteElo: { est: 2050, low: 1850, high: 2250, accuracy: 91.5, kind: 'estimate' },
    blackElo: { est: 900, low: 700, high: 1100, accuracy: 44.2, kind: 'estimate' },
    moveEvals: [
      mkMove({}),
      mkMove({
        ply: 2,
        color: 'black',
        san: 'e5',
        uci: 'e7e5',
        fenBefore: afterE4,
        fenAfter: afterE5,
        bestUci: 'c7c5',
        bestSan: 'c5',
        bestPv: ['c7c5'],
        verdict: 'blunder',
        badge: 'Blunder',
        comment: 'e5 is a blunder. c5 was best.',
        accuracy: 30,
        cpLoss: 250,
        winChancesDrop: 0.35,
        isBest: false,
        critical: true
      })
    ]
  }
}

try {
  // ---- public content channels, logged out (anon DB) ----------------------
  let r = await ipc('app:dataVersion')
  check(
    'app:dataVersion logged-out -> shim getVersion (0.0.0-test)',
    r.status === 200 && r.body.appVersion === '0.0.0-test'
  )

  r = await ipc('puzzles:themes')
  const themeKeys = (r.body.themes ?? []).map((t) => t.key)
  check('puzzles:themes works logged-out against the fixture DB', r.status === 200 && themeKeys.includes('fork') && themeKeys.includes('mate'))
  const forkCount = (r.body.themes ?? []).find((t) => t.key === 'fork')?.count
  check('puzzles:themes counts the junction rows (fork=2)', forkCount === 2)

  r = await ipc('puzzles:next', { ratingLo: 600, ratingHi: 2200 })
  check(
    'puzzles:next logged-out returns a fixture puzzle with parsed moves',
    r.status === 200 && FIXTURE_IDS.has(r.body.puzzle?.id) && Array.isArray(r.body.puzzle?.moves)
  )

  r = await ipc('puzzles:next', { theme: 'fork', ratingLo: 600, ratingHi: 2200 })
  check('puzzles:next {theme:fork} returns a fork puzzle', r.status === 200 && ['fx002', 'fx004'].includes(r.body.puzzle?.id))

  r = await ipc('puzzles:get', { puzzleId: 'fx001' })
  check(
    'puzzles:get returns the puzzle (themes split)',
    r.status === 200 && r.body.puzzle?.rating === 900 && r.body.puzzle?.themes.includes('backRankMate')
  )

  r = await ipc('puzzles:batch', { count: 3, ratingLo: 600, ratingHi: 2200 })
  check('puzzles:batch returns up to count fixture puzzles', r.status === 200 && r.body.puzzles.length === 3 && r.body.puzzles.every((p) => FIXTURE_IDS.has(p.id)))

  r = await ipc('school:chapters')
  check(
    'school:chapters logged-out -> the shipped curriculum resolves (shim resourcesPath)',
    r.status === 200 && (r.body.chapters?.length ?? 0) >= 40 && r.body.chapters.every((c) => c.locked === true)
  )
  const chapterId = r.body.chapters?.[0]?.id
  r = await ipc('school:chapter', { id: chapterId })
  check('school:chapter loads one chapter (no eloFloor leak)', r.status === 200 && r.body.chapter?.id === chapterId && !('eloFloor' in r.body.chapter))

  r = await ipc('famous:list', {})
  check('famous:list logged-out -> real library resolves', r.status === 200 && (r.body.games?.length ?? 0) > 0)

  r = await ipc('personas:list')
  check('personas:list logged-out -> real catalog resolves', r.status === 200 && (r.body.personas?.length ?? 0) > 0)

  r = await ipc('openings:lookup', { fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1' })
  check('openings:lookup answers logged-out (public)', r.status === 200 && 'opening' in r.body)

  // ---- gating / route hygiene ---------------------------------------------
  r = await ipc('games:list')
  check('private channel logged-out -> 401 auth-required', r.status === 401 && r.body.error === 'auth-required')
  r = await ipc('puzzles:recordDaily', { ymd: '2026-01-01', puzzleId: 'fx001', solved: true, firstTry: true })
  check('puzzles:recordDaily is auth-only (daily reads are public, writes are not)', r.status === 401)

  for (const excluded of ['engine:analyze', 'review:run', 'datasets:status', 'updates:check', 'dialog:openPgn']) {
    r = await ipc(excluded)
    check(`excluded desktop channel ${excluded} -> 404 unknown-channel`, r.status === 404 && r.body.error === 'unknown-channel')
  }
  r = await ipc('totally:made-up')
  check('unknown channel -> 404', r.status === 404)

  r = await ipc('puzzles:get', {})
  check('zod gate: puzzles:get without puzzleId -> 400 invalid-payload', r.status === 400 && r.body.error === 'invalid-payload')
  r = await ipc('puzzles:next', { ratingLo: 'high' })
  check('zod gate: wrong payload types -> 400', r.status === 400)

  // ---- wire caps on public channels (audit WEB-SEC-04) ----------------------
  // Anonymous callers share ONE global DB mutex, so unbounded arrays on public
  // channels were a whole-server DoS. Oversized payloads must 400 at the zod
  // gate; realistic payloads keep answering.
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  const noEval = { cp: null, mate: null }
  const dMove = (ply) => ({
    ply, fenBefore: START, played: 'e2e4', best: '', pv: [],
    evalBefore: noEval, evalAfter: noEval, byUser: true
  })
  const debriefBase = { chapterId, userColor: 'white' }

  r = await ipc('school:debrief', { ...debriefBase, moves: [dMove(1), dMove(2)] })
  check('school:debrief small payload still answers', r.status === 200 && Array.isArray(r.body.lines))
  r = await ipc('school:debrief', { ...debriefBase, moves: Array.from({ length: 1025 }, (_, i) => dMove(i + 1)) })
  check('CAP: school:debrief with 1025 moves -> 400', r.status === 400 && r.body.error === 'invalid-payload')
  // A full game's worth of moves (~200 plies) MUST still pass — the cap is a
  // DoS bound, not a real-usage limit.
  r = await ipc('school:debrief', { ...debriefBase, moves: Array.from({ length: 200 }, (_, i) => dMove(i + 1)) })
  check('school:debrief full-game 200 moves still answers', r.status === 200)
  r = await ipc('school:debrief', { ...debriefBase, moves: [{ ...dMove(1), pv: Array(257).fill('e2e4') }] })
  check('CAP: school:debrief pv of 257 -> 400', r.status === 400)
  r = await ipc('school:debrief', { ...debriefBase, moves: [{ ...dMove(1), fenBefore: 'k'.repeat(129) }] })
  check('CAP: school:debrief 129-char fen -> 400', r.status === 400)

  const narrateReq = {
    fenBefore: START, played: 'e2e4', best: 'e2e4', pv: ['e2e4', 'e7e5'],
    evalBefore: { cp: 20, mate: null }, evalAfter: { cp: 20, mate: null }, knownConceptIds: []
  }
  r = await ipc('school:narrate', narrateReq)
  check('school:narrate small payload still answers', r.status === 200 && typeof r.body.line?.text === 'string')
  // A deep engine PV (well past a tight 64) must still pass.
  r = await ipc('school:narrate', { ...narrateReq, pv: Array(80).fill('e2e4') })
  check('school:narrate deep 80-move pv still answers', r.status === 200)
  r = await ipc('school:narrate', { ...narrateReq, pv: Array(257).fill('e2e4') })
  check('CAP: school:narrate pv of 257 -> 400', r.status === 400)
  r = await ipc('school:narrate', { ...narrateReq, knownConceptIds: Array(1025).fill('x') })
  check('CAP: school:narrate 1025 concept ids -> 400', r.status === 400)

  const coachReq = {
    fenBefore: START, played: 'e2e4', best: 'e2e4', pv: ['e2e4'],
    evalBefore: { cp: 20, mate: null }, evalAfter: { cp: 20, mate: null }
  }
  r = await ipc('coach:explainMove', coachReq)
  check('coach:explainMove small payload still answers', r.status === 200 && typeof r.body.text === 'string')
  // CoachHint forwards the raw analysis PV — a deep one must not be rejected.
  r = await ipc('coach:explainMove', { ...coachReq, pv: Array(80).fill('e2e4') })
  check('coach:explainMove deep 80-move pv still answers', r.status === 200)
  r = await ipc('coach:explainMove', { ...coachReq, pv: Array(257).fill('e2e4') })
  check('CAP: coach:explainMove pv of 257 -> 400', r.status === 400)

  r = await ipc('puzzles:next', { exclude: Array(2049).fill('fx001') })
  check('CAP: puzzles:next exclude of 2049 -> 400', r.status === 400)
  r = await ipc('puzzles:batch', { count: 3, exclude: Array(2049).fill('fx001') })
  check('CAP: puzzles:batch exclude of 2049 -> 400', r.status === 400)
  r = await ipc('puzzles:next', { exclude: Array(300).fill('fx001') })
  check('puzzles:next session-sized exclude (300) still answers', r.status === 200)
  // REGRESSION GUARD: the desktop Custom trainer can select every theme in the
  // catalog (73 today, no renderer-side cap) — the themes cap must sit above it.
  r = await ipc('puzzles:batch', { count: 3, themes: Array.from({ length: 100 }, (_, i) => `theme${i}`) })
  check('puzzles:batch full-catalog 100-theme selection still answers', r.status === 200)
  r = await ipc('puzzles:batch', { count: 3, themes: Array(257).fill('fork') })
  check('CAP: puzzles:batch themes of 257 -> 400', r.status === 400)

  // A body past the route's 1 MiB default must die at the body parser (413),
  // long before any handler or the DB mutex.
  const oversized = await post('/api/ipc/school:debrief', {
    ...debriefBase,
    moves: Array.from({ length: 20000 }, (_, i) => dMove(i + 1))
  })
  check('an over-1MiB body -> 413 (bodyLimit, pre-handler)', oversized.status === 413)

  // ---- CSRF origin gate ------------------------------------------------------
  // SameSite=Lax already blocks cross-site cookie sends; the Origin check is
  // the backstop for mutating /api calls. No Origin (curl, tests) passes.
  let originRes = await fetch(`${base}/api/ipc/app:ping`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: '{}'
  })
  check('CSRF: cross-origin POST -> 403 bad-origin', originRes.status === 403)
  originRes = await fetch(`${base}/api/ipc/app:ping`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'null' },
    body: '{}'
  })
  check('CSRF: Origin "null" -> 403', originRes.status === 403)
  originRes = await fetch(`${base}/api/ipc/app:ping`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: '{}'
  })
  check('CSRF: same-origin POST passes', originRes.status === 200)

  // ---- per-user isolation ---------------------------------------------------
  let res = await post('/api/auth/signup', { username: 'user-a', password: 'password123' })
  const sidA = sidOf(res)
  res = await post('/api/auth/signup', { username: 'user-b', password: 'password123' })
  const sidB = sidOf(res)
  check('two accounts created', Boolean(sidA) && Boolean(sidB))

  r = await ipc('games:save', { pgn: '1. e4 e5', whiteName: 'user-a', result: '1-0', source: 'play' }, sidA)
  const gameIdA = r.body.gameId
  check('user A saves a game via the bridge', r.status === 200 && Number.isInteger(gameIdA))

  r = await ipc('games:list', {}, sidA)
  check(
    'games:list returns it for user A',
    r.status === 200 && r.body.games.length === 1 && r.body.games[0].pgn === '1. e4 e5' && r.body.games[0].id === gameIdA
  )

  r = await ipc('games:list', {}, sidB)
  check('ISOLATION: user B cannot see user A games', r.status === 200 && r.body.games.length === 0)

  r = await ipc('games:save', { pgn: '1. d4 d5', whiteName: 'user-b' }, sidB)
  check('ISOLATION: user B gets their own id sequence (fresh per-user DB)', r.status === 200 && r.body.gameId === 1)
  r = await ipc('games:list', {}, sidB)
  check('user B sees exactly their own game', r.body.games.length === 1 && r.body.games[0].pgn === '1. d4 d5')
  r = await ipc('games:list', {}, sidA)
  check('user A still sees exactly their own game', r.body.games.length === 1 && r.body.games[0].pgn === '1. e4 e5')

  r = await ipc('settings:set', { key: 'boardTheme', value: { name: 'walnut' } }, sidA)
  check('user A writes a setting', r.status === 200 && r.body.ok === true)
  r = await ipc('settings:get', { key: 'boardTheme' }, sidB)
  check('ISOLATION: user B reads null for it', r.status === 200 && r.body.value === null)
  r = await ipc('settings:get', { key: 'boardTheme' }, sidA)
  check('user A reads their setting back', r.body.value?.name === 'walnut')

  r = await ipc('puzzles:attempt', { puzzleId: 'fx002', puzzleRating: 1100, solved: true, mode: 'train' }, sidA)
  const ratingAfterA = r.body.ratingAfter
  check('user A puzzle attempt moves their Glicko rating', r.status === 200 && Number.isInteger(ratingAfterA) && ratingAfterA > 1200)
  r = await ipc('ratings:get', { kind: 'puzzle' }, sidB)
  check('ISOLATION: user B rating still at the 1200 seed', r.status === 200 && r.body.rating === 1200)
  r = await ipc('ratings:get', { kind: 'puzzle' }, sidA)
  check('user A rating persisted', r.body.rating === ratingAfterA)

  // Content channels answer for logged-in users too (their own DB).
  r = await ipc('puzzles:themes', {}, sidA)
  check('puzzle content still serves logged-in', r.status === 200 && r.body.themes.length > 0)

  // ---- review persistence ---------------------------------------------------
  const review = fixtureReview()
  res = await post('/api/review/save', { gameId: gameIdA, review })
  check('review save logged-out -> 401', res.status === 401)
  res = await get(`/api/review/${gameIdA}`)
  check('review get logged-out -> 401', res.status === 401)

  res = await post('/api/review/save', { gameId: gameIdA, review }, sidA)
  let body = await res.json()
  check('user A saves a review -> {ok:true}', res.status === 200 && body.ok === true)

  res = await get(`/api/review/${gameIdA}`, sidA)
  body = await res.json()
  check(
    'review roundtrips (summaries + both move evals)',
    res.status === 200 &&
      body.review?.white?.accuracy === 91.5 &&
      body.review?.black?.blunders === 1 &&
      body.review?.moveEvals?.length === 2 &&
      body.review?.moveEvals?.[1]?.badge === 'Blunder' &&
      body.review?.whiteElo?.est === 2050
  )

  r = await ipc('games:get', { gameId: gameIdA }, sidA)
  check(
    'saving stamped accuracy onto the game row (setGameAccuracy)',
    r.body.game?.accuracy_white === 91.5 && r.body.game?.accuracy_black === 44.2
  )

  res = await get(`/api/review/${gameIdA}`, sidB)
  body = await res.json()
  check('ISOLATION: user B reads null for user A review', res.status === 200 && body.review === null)

  res = await get('/api/review/999', sidA)
  body = await res.json()
  check('review get for an unreviewed id -> {review:null}', res.status === 200 && body.review === null)

  res = await post('/api/review/save', { gameId: 999, review }, sidA)
  check('review save for a nonexistent game -> 404', res.status === 404)

  res = await post('/api/review/save', { gameId: gameIdA, review: { nope: true } }, sidA)
  check('review save with a broken review -> 400', res.status === 400)

  res = await get('/api/review/not-a-number', sidA)
  check('review get with a junk id -> 400', res.status === 400)
} finally {
  child.kill()
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nWeb bridge: all green')
