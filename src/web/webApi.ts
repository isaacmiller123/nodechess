// The WEB implementation of the shared `Api` contract (docs/WEB-PORT-SPEC.md).
//
// This is the second implementation of src/shared/types.ts `Api`. The desktop
// one lives in src/preload/api.ts (Electron IPC). The renderer is untouched:
// src/web/main.web.tsx installs this object as `window.api` before any
// renderer module evaluates.
//
// NOTHING here talks to a server. The web build is a static site, so every
// namespace resolves in the browser, from one of four places:
//
//   PUZZLE LIBRARY (src/web/data via ./puzzles):
//     the ~2 GB puzzle database, split into static chunks and read over HTTP
//     range requests: next/get/themes/batch/daily. Reads degrade to their
//     honest empty shapes when the artifact isn't deployed, and datasets.status
//     reports puzzles:false so the gated surfaces show their own notice.
//
//   STATIC CONTENT (src/web/content):
//     curriculum chapters, famous games, the persona catalog: the same
//     resource files the desktop main process reads, emitted into the build by
//     vite.web.config.ts and fetched on demand.
//
//   CLIENT COMPUTE:
//     engines/review/perf/persona moves (src/web/engines, WASM), the coach's
//     move explanations (src/main/coach; pure chessops, no engine, shared
//     verbatim with desktop) and the opening table (the same EPD-keyed JSON).
//
//   LOCAL STATE (src/web/localData, src/web/reviewStore):
//     games, ratings, settings, custom variants, puzzle attempts/daily/rush,
//     stored reviews. This browser IS the database. There is no account to
//     sync to and no server that could hold it.
//
// Two things are honestly missing rather than moved, both in School:
//   - PROGRESS (mastery, tests, SRS, placement, streaks) has no browser-side
//     store. It was account-only on the web, and the accounts it belonged to
//     are gone, so reads answer empty and writes say they aren't kept. Every
//     chapter therefore reads locked-behind-placement.
//   - Viktor's school:narrate/debrief: his voice layer
//     (src/main/coach/viktor.ts) constructs a native engine pool at module
//     scope and cannot be bundled for a browser.

import { parseFen, makeFen } from 'chessops/fen'
import type {
  Api,
  CustomVariantRow,
  DailyStreak,
  DatasetStatus,
  OpeningInfo,
  UpdateStatus
} from '@shared/types'
import { measuredElo } from '@shared/botStrength'
import { explainMove, positional } from '../main/coach'
import {
  SETTING_PREFIX,
  clearLocalGames,
  clearLocalPuzzleState,
  listLocalRushRuns,
  localDailyStreak,
  localPuzzleHistory,
  localPuzzleStats,
  localRushBests,
  normalizeYmd,
  readDailyResult,
  readGames,
  readLocalRating,
  readVariants,
  recordLocalDaily,
  recordLocalGameResult,
  recordLocalPuzzleAttempt,
  resetLocalRating,
  saveLocalRushRun,
  storageGet,
  storageSet,
  todayYmd,
  writeGames,
  writeVariants,
  GAMES_CAP
} from './localData'
import { clearLocalReviews, reviewStore } from './reviewStore'
import { puzzleDatasetInfo, puzzleReader } from './puzzles'
import { chapterMetas, getChapter, NO_SCHOOL_PROGRESS } from './content/school'
import { getFamous, listFamous } from './content/famous'
import { listPersonas } from './content/personas'
import { createEngineApi, createPerfApi, createPersonaMove, createReviewApi } from './engines'

// ---- Honest degradation ----------------------------------------------------------

/** A READ against something that ships with the site (the puzzle artifact, the
 *  content tree). When it can't be reached. An incomplete deploy, a network
 *  drop. The call resolves to its EMPTY shape, which is exactly what the
 *  desktop does with a missing dataset directory and what every renderer
 *  surface already renders (no chapters, no games, no puzzle). The cause is
 *  never guessed at: the first failure of the page logs the real error, naming
 *  the file, so a broken deploy is one console line away. */
let loggedReadFailure = false
async function staticRead<T>(what: string, run: () => Promise<T>, empty: () => T): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (!loggedReadFailure) {
      loggedReadFailure = true
      console.error(`nodechess static read failed (${what}). The app is running degraded.`, err)
    }
    return empty()
  }
}

/** Reject with the standard coming-online copy. The renderer's existing error
 *  paths (toasts, status strips, best-effort try/catch) surface this string. */
function comingOnline(what: string): Promise<never> {
  return Promise.reject(
    new Error(`${what} is coming online. This part of the nodechess web app isn't wired up yet.`)
  )
}

/** School PROGRESS (mastery, tests, SRS, placement, streaks) is the one part of
 *  the desktop app with no browser-side store yet: it was account-only on the
 *  web, and the accounts it belonged to are gone. Reads answer empty (below);
 *  writes say plainly that nothing is being kept. */
function schoolProgressUnavailable(what: string): Promise<never> {
  return Promise.reject(
    new Error(`${what} isn't saved yet. The nodechess web app has nowhere to keep School progress.`)
  )
}

/** Viktor's spoken coaching (school:narrate / school:debrief). Everything he
 *  says is computed from src/main/coach/viktor.ts, which cannot be bundled for
 *  a browser (see the school namespace below). */
function viktorUnavailable(): Promise<never> {
  return Promise.reject(
    new Error('Viktor’s spoken coaching isn’t available in the nodechess web app yet.')
  )
}

/** Bot-move rejection the game UIs recognize: KernelBot/VariantBot show
 *  `err.message` in their toast only for `instanceof BotUnavailableError`
 *  (anything else falls back to desktop "is the dataset installed?" copy).
 *  Lazy import keeps module-eval order safe; by the time a bot moves, the
 *  games bundle is already loaded so this resolves from cache. */
async function botComingOnline(what: string): Promise<never> {
  const { BotUnavailableError } = await import('@/games/bots')
  throw new BotUnavailableError(
    `${what} are coming online. Not available in the nodechess web app yet.`
  )
}

const ok = Promise.resolve({ ok: true as const })
const noopUnsubscribe = (): (() => void) => () => {}

// ---- The lazy engine layer (src/web/engines: the W2 contract) --------------------
// The factories are constructed on FIRST USE and cached; in an environment
// without Worker/WebAssembly they throw ("not supported"), which parks the
// cache at null and keeps the fallbacks answering. Nothing here re-probes: a
// successful construction is permanent for the page lifetime.

function lazy<T>(create: () => T): () => T | null {
  let cache: T | null | undefined
  return () => {
    if (cache === undefined) {
      try {
        cache = create()
      } catch {
        cache = null
      }
    }
    return cache
  }
}

/** Engine deps: resolve a saved custom variant's ini text. Accepts either the
 *  raw variant id or the 'custom-<id>' kind string the games platform uses. */
async function getCustomVariantIni(id: string): Promise<string | null> {
  const direct = customVariantGet(id)
  if (direct?.iniText) return direct.iniText
  if (id.startsWith('custom-')) {
    const stripped = customVariantGet(id.slice('custom-'.length))
    if (stripped?.iniText) return stripped.iniText
  }
  return null
}

function customVariantGet(id: string): CustomVariantRow | null {
  return readVariants()[id] ?? null
}

const engineLayer = lazy<Api['engine']>(() => createEngineApi({ getCustomVariantIni }))
const reviewLayer = lazy<Api['review']>(() => createReviewApi(reviewStore))
const perfLayer = lazy<Api['perf']>(() => createPerfApi(reviewStore))
const personaMoveLayer = lazy<Api['personas']['move']>(() => createPersonaMove())

// ---- Empty/default read results ----------------------------------------------

const ZERO_STREAK: DailyStreak = { current: 0, best: 0, todaySolved: false, recent: [] }

/** Local YYYY-MM-DD (school streaks are LOCAL-day, like the puzzle daily). */
const localYmd = todayYmd

// datasets.status is the renderer's capability gate (useEngineReady): `engine`
// is the WASM layer's own probe, `puzzles` the static artifact's. maia/katago
// are desktop-only, and there is nothing to import on the web, so the rest stay
// false forever.
const DATASETS_NONE: DatasetStatus = {
  engine: false,
  puzzles: false,
  maia: false,
  katago: false,
  katagoHuman: false,
  complete: false
}

const ENGINE_STATUS_NONE = {
  analysisReady: false,
  playReady: false,
  lc0Ready: false,
  fairyReady: false,
  katagoReady: false,
  katagoHumanReady: false
}

// ---- datasets.status probes (memoized once-true) --------------------------------
// useEngineReady re-calls datasets:status on every gated-surface mount, so both
// probes cache their first success; a false answer re-probes (an artifact can
// "appear" when a flaky network recovers mid-session).

let engineDatasetMemo = false
async function probeEngineDataset(): Promise<boolean> {
  if (engineDatasetMemo) return true
  const eng = engineLayer()
  if (!eng) return false
  try {
    const s = await eng.status()
    engineDatasetMemo = s.analysisReady && s.playReady
  } catch {
    engineDatasetMemo = false
  }
  return engineDatasetMemo
}

let puzzlesDatasetMemo = false
async function probePuzzlesDataset(): Promise<boolean> {
  if (puzzlesDatasetMemo) return true
  try {
    // The manifest alone answers this: one small fetch, no database read.
    puzzlesDatasetMemo = (await puzzleDatasetInfo()).puzzleCount > 0
  } catch {
    puzzlesDatasetMemo = false
  }
  return puzzlesDatasetMemo
}

// Opening-name lookup, REAL on web, and byte-identical to desktop: the same
// EPD-keyed resources/openings/openings.json the main process reads (488 KB)
// lazy-loads as its own chunk on first lookup, and the same chessops EPD
// normalization keys the match (src/main/openings/openings.repo.ts).
let openingsTable: Promise<Record<string, OpeningInfo>> | null = null

function loadOpenings(): Promise<Record<string, OpeningInfo>> {
  if (!openingsTable) {
    openingsTable = import('../../resources/openings/openings.json')
      .then((m) => (m.default ?? m) as Record<string, OpeningInfo>)
      .catch(() => ({}))
  }
  return openingsTable
}

// The web app updates by refresh. There is nothing to check or download.
const UPDATE_STATUS: UpdateStatus = {
  state: 'idle',
  currentVersion: __WEB_APP_VERSION__,
  mode: 'manual'
}

export const webApi: Api = {
  app: {
    ping: async () => ({ ok: true, ts: Date.now() }),
    // engineVersion reflects the W2 WASM engines (static string: the About
    // panel copy, not a capability claim); the puzzle date is the artifact's
    // own build stamp, so About reports the library actually being served.
    dataVersion: async () => ({
      appVersion: `${__WEB_APP_VERSION__} (web)`,
      engineVersion: 'Stockfish 18 lite + Fairy-Stockfish 14 (WASM)',
      puzzleDbDate: await staticRead(
        'app:dataVersion',
        async () => (await puzzleDatasetInfo()).builtAt.slice(0, 10),
        () => 'not installed'
      )
    }),
    // Wipe the browser-resident equivalents per scope. School has no local
    // store (see schoolProgressUnavailable), so that scope is an honest no-op.
    resetProgress: async (req) => {
      for (const scope of new Set(req.scopes)) {
        if (scope === 'puzzles') {
          resetLocalRating('puzzle')
          clearLocalPuzzleState()
        }
        if (scope === 'games') {
          clearLocalGames()
          clearLocalReviews()
          resetLocalRating('vs-bot')
        }
      }
      return { ok: true }
    }
  },

  settings: {
    get: async (key) => {
      const raw = storageGet(SETTING_PREFIX + key)
      if (raw === null) return { value: null }
      try {
        return { value: JSON.parse(raw) as unknown }
      } catch {
        return { value: null }
      }
    },
    set: async (key, value) => {
      storageSet(SETTING_PREFIX + key, JSON.stringify(value ?? null))
      return { ok: true }
    }
  },

  // W2 engines (client-side WASM) behind the lazy layer. The rejection choices
  // are load-bearing (see W1 audit): newGame REJECTING keeps PlayView's
  // belt-and-braces gate from starting a fake "Stockfish" game.
  engine: {
    analyze: (req) => engineLayer()?.analyze(req) ?? comingOnline('Engine analysis'),
    stop: (handleId) => engineLayer()?.stop(handleId) ?? ok,
    play: (req) => engineLayer()?.play(req) ?? comingOnline('Playing the engine'),
    playVariant: (req) => engineLayer()?.playVariant(req) ?? botComingOnline('Variant bots'),
    playGo: (req) => engineLayer()?.playGo(req) ?? botComingOnline('Go bots'),
    evalVariant: (req) => engineLayer()?.evalVariant(req) ?? comingOnline('The eval bar'),
    estimateGo: (req) => engineLayer()?.estimateGo(req) ?? comingOnline('Territory estimates'),
    status: () => engineLayer()?.status() ?? Promise.resolve({ ...ENGINE_STATUS_NONE }),
    newGame: (instance) => engineLayer()?.newGame(instance) ?? comingOnline('Playing the engine'),
    onLine: (cb) => engineLayer()?.onLine(cb) ?? noopUnsubscribe(),
    onBestmove: (cb) => engineLayer()?.onBestmove(cb) ?? noopUnsubscribe()
  },

  // CONTENT (the puzzle rows) → the chunked artifact. USER DATA (attempts,
  // ratings, daily results, Rush runs, stats, history) → this browser.
  puzzles: {
    next: (req) => staticRead('puzzles:next', () => puzzleReader().next(req), () => ({ puzzle: null })),
    get: (id) => staticRead('puzzles:get', () => puzzleReader().get(id), () => ({ puzzle: null })),
    themes: () => staticRead('puzzles:themes', () => puzzleReader().themes(), () => ({ themes: [] })),
    batch: (req) => staticRead('puzzles:batch', () => puzzleReader().batch(req), () => ({ puzzles: [] })),
    // Local Glicko-2. The exact desktop applyPuzzleResult math + mode rules.
    attempt: async (req) => recordLocalPuzzleAttempt(req),
    saveRush: async (req) => saveLocalRushRun(req),
    rushRuns: async (req) => ({ runs: listLocalRushRuns(req) }),
    rushBests: async () => ({ bests: localRushBests() }),
    // The artifact holds no user state, so it always answers result:null. The
    // day's outcome is merged in from this browser's record.
    daily: async (req) => {
      const ymd = normalizeYmd(req?.ymd)
      const { puzzle } = await staticRead(
        'puzzles:daily',
        () => puzzleReader().daily({ ymd }),
        () => ({ ymd, puzzle: null, result: null })
      )
      return { ymd, puzzle, result: readDailyResult(ymd) }
    },
    recordDaily: async (req) => recordLocalDaily(req),
    dailyStreak: async () => ({ streak: localDailyStreak() }),
    stats: async () => localPuzzleStats(),
    history: async (req) => ({ rows: localPuzzleHistory(req) })
  },

  // The REAL local Glicko-2 store (localData.ts), which reads as the desktop's
  // unseeded default until the first rated attempt.
  ratings: {
    get: async (kind) => {
      const rec = readLocalRating(kind)
      return { rating: Math.round(rec.rating), rd: Math.round(rec.rd), vol: rec.vol }
    }
  },
  progress: {
    summary: async () => {
      const puzzle = readLocalRating('puzzle')
      const vsBot = readLocalRating('vs-bot')
      const games = readGames().rows
      return {
        puzzleRating: Math.round(puzzle.rating),
        puzzleRd: Math.round(puzzle.rd),
        vsBotRating: Math.round(vsBot.rating),
        vsBotRd: Math.round(vsBot.rd),
        puzzlesSolved: puzzle.solved,
        puzzlesTried: puzzle.attempts,
        gamesPlayed: games.length,
        lastPuzzleAt: puzzle.lastAt,
        lastGameAt: games[0]?.created_at ?? null
      }
    }
  },

  // The localStorage archive, with the desktop game-table semantics: list =
  // chess rows only, listAll = every kind, both newest-first.
  games: {
    save: async (input) => {
      const store = readGames()
      const id = ++store.seq
      store.rows.unshift({
        id,
        created_at: Date.now(),
        white_name: input.whiteName ?? null,
        black_name: input.blackName ?? null,
        user_color: input.userColor ?? null,
        result: input.result ?? null,
        opponent_kind: input.opponentKind ?? null,
        opponent_label: input.opponentLabel ?? null,
        opponent_elo: input.opponentElo ?? null,
        source: input.source ?? null,
        pgn: input.pgn,
        accuracy_white: null,
        accuracy_black: null,
        est_elo_low: null,
        est_elo_high: null,
        reviewed: 0,
        game_kind: input.gameKind ?? 'chess'
      })
      store.rows = store.rows.slice(0, GAMES_CAP)
      writeGames(store)
      return { gameId: id }
    },
    list: async (req) => ({
      games: readGames()
        .rows.filter((g) => g.game_kind === 'chess')
        .slice(req?.offset ?? 0, (req?.offset ?? 0) + (req?.limit ?? 50))
    }),
    listAll: async (req) => {
      const rows = readGames().rows
      const filtered = rows.filter(
        (g) =>
          (!req?.kind || g.game_kind === req.kind) &&
          (!req?.source || g.source === req.source) &&
          (!req?.result || g.result === req.result)
      )
      const offset = req?.offset ?? 0
      const kindCounts = new Map<string, number>()
      const sources = new Set<string>()
      for (const g of rows) {
        kindCounts.set(g.game_kind, (kindCounts.get(g.game_kind) ?? 0) + 1)
        if (g.source) sources.add(g.source)
      }
      return {
        games: filtered.slice(offset, offset + (req?.limit ?? 60)),
        kinds: [...kindCounts.entries()]
          .map(([kind, count]) => ({ kind, count }))
          .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
        sources: [...sources].sort()
      }
    },
    get: async (gameId) => ({ game: readGames().rows.find((g) => g.id === gameId) ?? null }),
    // The desktop pipeline run locally: nominal→measured Elo mapping
    // (shared/botStrength; main owns this on desktop) then the vs-bot Glicko
    // update.
    reportResult: async (req) => {
      const rated = measuredElo({ kind: req.opponentKind ?? 'engine', elo: req.botElo })
      return recordLocalGameResult(rated, req.score)
    }
  },

  // REAL. Same table, same EPD keying as the desktop lookup.
  openings: {
    lookup: async (fen) => {
      const setup = parseFen(fen)
      if (setup.isErr) return { opening: null }
      const epd = makeFen(setup.value, { epd: true })
      return { opening: (await loadOpenings())[epd] ?? null }
    }
  },

  // The coaching engine itself: src/main/coach is pure chessops (no engine, no
  // LLM, no network), so the browser runs the SAME code the desktop main
  // process does, on the evals the caller already has.
  coach: {
    explainMove: async (args) => explainMove(args),
    positional: async (args) => positional(args)
  },

  // W2 client-side review behind the lazy layer, persisting through the
  // localStorage reviewStore. review.get answers from the store EVEN when the
  // engine layer is unavailable. Stored reviews are readable without an engine.
  review: {
    run: (req) => reviewLayer()?.run(req) ?? comingOnline('Game review'),
    get: (gameId) => reviewLayer()?.get(gameId) ?? reviewStore.load(gameId),
    cancel: () => reviewLayer()?.cancel() ?? ok,
    onProgress: (cb) => reviewLayer()?.onProgress(cb) ?? noopUnsubscribe()
  },
  perf: {
    estimate: (req) => perfLayer()?.estimate(req) ?? comingOnline('Performance estimates')
  },

  // Static library (src/web/content/famous.ts).
  famous: {
    list: (req) => staticRead('famous:list', async () => ({ games: await listFamous(req) }), () => ({ games: [] })),
    get: (id) => staticRead('famous:get', async () => ({ game: await getFamous(id) }), () => ({ game: null }))
  },

  // Curriculum CONTENT is static and complete. PROGRESS is not stored anywhere
  // in the web build: reads answer empty (an unplaced, unstudied learner, which
  // is exactly what this browser knows) and writes reject with copy that says
  // so. Every chapter therefore reports locked:'placement'. The honest state,
  // not a bug in the content pipeline.
  school: {
    chapters: () =>
      staticRead(
        'school:chapters',
        async () => ({ chapters: await chapterMetas(NO_SCHOOL_PROGRESS) }),
        () => ({ chapters: [] })
      ),
    chapter: (id) =>
      staticRead('school:chapter', async () => ({ chapter: await getChapter(id) }), () => ({ chapter: null })),
    mastery: async () => ({ concepts: [], chapters: [], lessons: [] }),
    recordConcept: () => schoolProgressUnavailable('Concept progress'),
    recordSegment: () => schoolProgressUnavailable('Lesson progress'),
    completeChapter: () => schoolProgressUnavailable('Chapter completion'),
    recordLesson: () => schoolProgressUnavailable('Lesson progress'),
    recordTest: () => schoolProgressUnavailable('Chapter test results'),
    testState: async () => ({ attempts: 0, passed: false, bestPct: 0 }),
    recommend: async () => ({ recommended: null }),
    dueReviews: async () => ({ due: [] }),
    reviewConcept: () => schoolProgressUnavailable('Concept reviews'),
    daily: async () => ({
      ymd: localYmd(),
      chapterId: null,
      chapterTitle: null,
      lessonId: null,
      lessonTitle: null,
      doneToday: false,
      reviewsDue: 0
    }),
    recordDaily: () => schoolProgressUnavailable('School streaks'),
    streak: async () => ({ streak: ZERO_STREAK }),
    placementState: async () => ({ placed: false, estimatedElo: null, band: null, games: [] }),
    recordPlacementGame: () => schoolProgressUnavailable('Placement games'),
    resetPlacement: async () => ({ placed: false, estimatedElo: null, band: null, games: [] }),
    // Desktop's fixed placement level (school/placement.ts). Same constant.
    placementConfig: async () => ({ engineElo: 1350 }),
    // Viktor's voice layer (src/main/coach/viktor.ts) constructs a native
    // StockfishPool at module scope, so it cannot be bundled for the browser.
    // Narrate and debrief are the only two channels this build cannot answer,
    // and they fail immediately rather than doing work they can't finish. The
    // WASM eval pass a debrief needs already exists here
    // (src/web/engines/debrief.ts): split the pool out of viktor.ts and both
    // become client calls over the enriched moves.
    narrate: () => viktorUnavailable(),
    debrief: () => viktorUnavailable()
  },

  // Catalog → static content; moves → the W2 engine layer (style-weighted
  // MultiPV selection runs client-side).
  personas: {
    list: () =>
      staticRead('personas:list', async () => ({ personas: await listPersonas() }), () => ({ personas: [] })),
    move: (req) => personaMoveLayer()?.(req) ?? comingOnline('Persona bots')
  },

  // The renderer's capability gate: `engine` reflects the WASM layer's own
  // probe (useEngineReady gates Play/Analysis off this flag) and `puzzles` the
  // static artifact's manifest. In engineless environments (old browsers) or a
  // deploy without the puzzle chunks both degrade to false and the required-
  // notice gates return. Honest in both directions. maia/katago stay
  // desktop-only, and there is nothing to import in a browser.
  datasets: {
    status: async () => {
      const [engine, puzzles] = await Promise.all([probeEngineDataset(), probePuzzlesDataset()])
      return { ...DATASETS_NONE, engine, puzzles, complete: engine && puzzles }
    },
    items: async () => ({ items: [] }),
    import: async () => ({
      ok: false,
      status: { ...DATASETS_NONE },
      error: 'Nothing to download on the web: the engines and puzzle library are served with the app.'
    }),
    cancel: async () => ok,
    onProgress: () => noopUnsubscribe()
  },

  // localStorage: Variant Lab works fully in-browser (ffish WASM validates the
  // ini in the renderer).
  customVariants: {
    save: async (req) => {
      const map = readVariants()
      const now = Date.now()
      const prev = map[req.id]
      const variant: CustomVariantRow = {
        ...req,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now
      }
      map[req.id] = variant
      writeVariants(map)
      return { variant }
    },
    list: async () => ({
      variants: Object.values(readVariants()).sort((a, b) => b.updatedAt - a.updatedAt)
    }),
    get: async (id) => ({ variant: customVariantGet(id) }),
    delete: async (id) => {
      const map = readVariants()
      delete map[id]
      writeVariants(map)
      return { ok: true }
    }
  },

  // Real web-native behavior: the browser download IS the save dialog.
  dialog: {
    saveFile: async (req) => {
      const blob = new Blob([req.data as BlobPart])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = req.suggestedName
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      return { ok: true, path: req.suggestedName }
    }
  },

  // The web app updates by refresh. Check honestly reports up-to-date,
  // download has nothing to do.
  updates: {
    status: async () => ({ ...UPDATE_STATUS }),
    check: async () => ({ ...UPDATE_STATUS, state: 'up-to-date', checkedAt: Date.now() }),
    download: async () => ({
      ok: false,
      action: 'none',
      error: 'The web app is always current. Refresh the page to pick up new releases.'
    }),
    onStatus: () => noopUnsubscribe()
  }
}
