// Browser preview harness: DORMANT in the real app.
//
// installMock() wires a fake `window.api` so the renderer can be driven in a
// plain browser (no Electron/IPC) for interactive testing. It is loaded ONLY
// when the page is opened with `?mock` AND no real preload bridge exists
// (see main.tsx), so it can never run inside the packaged desktop app.
//
// The data is small but realistic. Real FENs, legal UCI moves, a working
// curriculum lesson and a streaming engine stub, so the actual product
// components (Board, PuzzlesView, LessonDetail, AnalysisView, …) exercise the
// same code paths a user hits, just sourced from canned data.
//
// The mock is typed as the shared `Api` contract: if the real surface grows or
// a return shape changes, this file fails typecheck instead of silently
// drifting (which used to strand `?mock` on loading states / crashes).

import type {
  Api,
  CustomVariantRow,
  DailyStreak,
  DatasetProgress,
  EngineLine,
  GameReview,
  PlacementState,
  Puzzle,
  SchoolChapter,
  SchoolChapterMeta
} from '../../shared/types'
import { destsFor, INITIAL_FEN } from './chess/chess'

/** Legal first moves from a FEN as UCI strings (for engine PV / opponent replies). */
function legalUcis(fen: string): string[] {
  const out: string[] = []
  for (const [orig, dests] of destsFor(fen)) {
    for (const d of dests) out.push(`${orig}${d}`)
  }
  return out
}

const MOCK_PUZZLES: Puzzle[] = [
  {
    // Black to move plays ...Kh8 (lead-in); White solves with Ra8#.
    id: 'mock-backrank',
    fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 b - - 0 1',
    moves: ['g8h8', 'a1a8'],
    rating: 900,
    themes: ['mateIn1', 'backRankMate'],
    openingTags: []
  },
  {
    // Black plays a quiet rook move (lead-in); White mates with Qxf7#.
    id: 'mock-scholar',
    fen: 'r1bqkbnr/pppp1Qpp/2n5/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 1',
    moves: ['a8b8', 'f7f8'],
    rating: 1100,
    themes: ['mateIn1'],
    openingTags: []
  }
]

/** Canned empty streak (puzzles daily + school daily lesson). */
const ZERO_STREAK: DailyStreak = { current: 0, best: 0, todaySolved: false, recent: [] }

/** Local YYYY-MM-DD (school streaks are LOCAL-day). */
function localYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

/** UTC YYYY-MM-DD (the puzzle daily is a UTC-day key). */
function utcYmd(): string {
  return new Date().toISOString().slice(0, 10)
}

// A review in the CURRENT GameReview shape (per-side summaries + Elo bands).
const MOCK_REVIEW: GameReview = {
  gameId: null,
  depth: 12,
  totalPlies: 0,
  white: { accuracy: 90, acpl: 18, moves: 0, inaccuracies: 0, mistakes: 0, blunders: 0, best: 0 },
  black: { accuracy: 88, acpl: 24, moves: 0, inaccuracies: 1, mistakes: 0, blunders: 0, best: 0 },
  whiteElo: { est: 1350, low: 1200, high: 1500, accuracy: 90, kind: 'estimate' },
  blackElo: { est: 1300, low: 1150, high: 1450, accuracy: 88, kind: 'estimate' },
  moveEvals: []
}

// ---- School: one openable chapter + one locked, so the index/lock UI renders. ----
const MOCK_CHAPTER: SchoolChapter = {
  id: 'mock-ch1',
  band: '400–500',
  order: 1,
  title: 'First Steps',
  subtitle: 'How the pieces fight',
  concepts: [
    { id: 'mock-hanging', name: 'Hanging pieces', short: 'A piece nobody defends is free to take.' },
    { id: 'mock-check', name: 'Check', short: 'Attack the king. It must be answered.' }
  ],
  estMinutes: 20,
  lessons: [
    {
      id: 'mock-l1',
      title: 'Take what is free',
      kind: 'concept',
      summary: 'Undefended pieces are gifts. Learn to spot them.',
      segments: [
        {
          kind: 'teach',
          title: 'The idea',
          steps: [
            {
              fen: INITIAL_FEN,
              coach: { text: 'Welcome. Before anything else: never leave a piece hanging.' }
            }
          ]
        }
      ]
    }
  ],
  test: {
    passThreshold: 0.7,
    questions: [
      {
        kind: 'mc',
        prompt: 'A piece with no defender that your opponent can capture is called…',
        options: ['pinned', 'hanging', 'forked'],
        answerIndex: 1,
        explain: 'An undefended, attackable piece is hanging.'
      }
    ]
  }
}

const MOCK_CHAPTER_METAS: SchoolChapterMeta[] = [
  {
    id: MOCK_CHAPTER.id,
    band: MOCK_CHAPTER.band,
    order: 1,
    title: MOCK_CHAPTER.title,
    subtitle: MOCK_CHAPTER.subtitle,
    estMinutes: MOCK_CHAPTER.estMinutes,
    conceptCount: MOCK_CHAPTER.concepts.length,
    lessonCount: MOCK_CHAPTER.lessons?.length ?? 0,
    locked: false
  },
  {
    id: 'mock-ch2',
    band: '500–600',
    order: 2,
    title: 'Sharper Eyes',
    subtitle: 'Spotting free material',
    estMinutes: 25,
    conceptCount: 2,
    lessonCount: 3,
    locked: true,
    lockReason: 'elo'
  }
]

const MOCK_PLACEMENT: PlacementState = {
  placed: true,
  estimatedElo: 520,
  band: { est: 520, low: 420, high: 620, accuracy: 74, kind: 'estimate' },
  games: []
}

// Library preview rows: one of each archive shape so the Games → Library list
// and the replay viewer are fully drivable in the browser harness. A chess
// PGN row (routes to Analysis), an envelope with stored notation (atomic), an
// envelope replaying live notation (go 9x9), and a LEGACY generic-text row
// (othello). Moves are real and legal. The replay pipe validates them through
// the actual rules engines, so a drift here shows up as a truncation warning.
const MOCK_GAME_ROW = {
  white_name: 'You',
  black_name: 'Guest',
  user_color: 'white' as const,
  opponent_kind: 'human',
  opponent_label: 'Guest',
  opponent_elo: null,
  accuracy_white: null,
  accuracy_black: null,
  est_elo_low: null,
  est_elo_high: null,
  reviewed: 0
}
const MOCK_LIBRARY_GAMES = [
  {
    ...MOCK_GAME_ROW,
    id: 101,
    created_at: Date.now() - 3600_000,
    result: '1-0',
    source: 'play',
    game_kind: 'chess',
    accuracy_white: 91.2,
    opponent_label: 'Stockfish 1500',
    pgn: '[Event "Vs bot"]\n[White "You"]\n[Black "Stockfish 1500"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0'
  },
  {
    ...MOCK_GAME_ROW,
    id: 102,
    created_at: Date.now() - 86400_000,
    result: '1-0',
    source: 'otb',
    game_kind: 'atomic',
    pgn: JSON.stringify({
      v: 1,
      kind: 'atomic',
      moves: ['e2e4', 'd7d5', 'e4d5', 'g8f6', 'b1c3', 'f6d5'],
      result: '1-0',
      meta: {
        notated: ['e4', 'd5', 'exd5', 'Nf6', 'Nc3', 'Nd5'],
        reason: 'variant',
        white: 'You',
        black: 'Guest',
        event: 'Over the board',
        date: '2026.07.09'
      }
    })
  },
  {
    ...MOCK_GAME_ROW,
    id: 103,
    created_at: Date.now() - 2 * 86400_000,
    result: '0-1',
    source: 'online',
    user_color: 'black' as const,
    game_kind: 'go',
    pgn: JSON.stringify({
      v: 1,
      kind: 'go',
      moves: ['e5', 'c3', 'g5', 'c5', 'e3', 'c7', 'g3', 'pass', 'pass'],
      result: '0-1',
      meta: {
        reason: 'score',
        white: 'Guest',
        black: 'You',
        options: { size: 9, komi: 5.5 },
        event: 'Online game',
        date: '2026.07.08'
      }
    })
  },
  {
    ...MOCK_GAME_ROW,
    id: 104,
    created_at: Date.now() - 3 * 86400_000,
    result: '1/2-1/2',
    source: 'online',
    game_kind: 'othello',
    pgn: '[Event "Online game"]\n[White "You"]\n[Black "Guest"]\n[Result "1/2-1/2"]\n[Variant "othello"]\n\nd3 c3 1/2-1/2'
  }
]

let handleSeq = 0
const lineSubs = new Set<(l: EngineLine) => void>()


// Datasets: start "not installed" so the import flow is exercisable in preview.
const datasetSubs = new Set<(p: DatasetProgress) => void>()
let mockDatasets = {
  engine: false,
  puzzles: false,
  maia: false,
  katago: false,
  katagoHuman: false,
  complete: false
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function emitLines(fen: string, handleId: number, multipv: number): void {
  const ucis = legalUcis(fen).slice(0, Math.max(1, multipv))
  // Two depth bursts so the panel/arrows look alive.
  for (const depth of [12, 20]) {
    setTimeout(() => {
      ucis.forEach((uci, i) => {
        for (const cb of lineSubs) {
          cb({
            handleId,
            depth,
            multipv: i + 1,
            scoreCp: 35 - i * 18,
            pv: [uci]
          })
        }
      })
    }, depth * 8)
  }
}

const ok = Promise.resolve({ ok: true as const })

// Variant Lab (customVariants mock): session-scoped in-memory store.
const mockCustomVariants = new Map<string, CustomVariantRow>()

export function installMock(): void {
  const api: Api = {
    app: {
      ping: async () => ({ ok: true, ts: Date.now() }),
      dataVersion: async () => ({ appVersion: 'mock', engineVersion: 'mock', puzzleDbDate: 'mock' }),
      resetProgress: async () => ({ ok: true })
    },
    settings: {
      get: async () => ({ value: null }),
      set: async () => ok
    },
    engine: {
      analyze: async ({ fen, multipv }) => {
        const handleId = ++handleSeq
        emitLines(fen, handleId, multipv ?? 3)
        return { handleId }
      },
      stop: async () => ok,
      play: async ({ fen }) => {
        const ucis = legalUcis(fen)
        return { bestmove: ucis[0] ?? '0000' }
      },
      // No engine in the browser mock. Variant bots surface the toast path.
      playVariant: async () => {
        throw new Error('Fairy-Stockfish is unavailable in the browser dev mock.')
      },
      // Go bots: the not-installed message drives KernelBot's inline prompt.
      playGo: async () => {
        throw new Error('KataGo is not installed. Download the Go engine in Settings → Datasets.')
      },
      // Replay-viewer eval: no engines in the browser mock. The bar hides.
      evalVariant: async () => {
        throw new Error('Fairy-Stockfish is unavailable in the browser dev mock.')
      },
      estimateGo: async () => {
        throw new Error('KataGo is not installed. Download the Go engine in Settings → Datasets.')
      },
      status: async () => ({
        analysisReady: true,
        playReady: true,
        // lc0Ready true so the Classic/Human style toggle is previewable in the
        // browser harness (engine.play ignores level.maia here; first legal move).
        lc0Ready: true,
        fairyReady: false,
        // katagoReady false so the go vs-Bot INLINE INSTALL PROMPT is previewable.
        katagoReady: false,
        katagoHumanReady: false
      }),
      newGame: async () => ok,
      onLine: (cb) => {
        lineSubs.add(cb)
        return () => {
          lineSubs.delete(cb)
        }
      },
      onBestmove: () => () => {}
    },
    puzzles: {
      next: async ({ exclude }) => {
        const pool = MOCK_PUZZLES.filter((p) => !(exclude ?? []).includes(p.id))
        return { puzzle: (pool[0] ?? MOCK_PUZZLES[0]) ?? null }
      },
      get: async (id) => ({ puzzle: MOCK_PUZZLES.find((p) => p.id === id) ?? null }),
      themes: async () => ({
        themes: [
          { key: 'mateIn1', count: 2 },
          { key: 'backRankMate', count: 1 }
        ]
      }),
      attempt: async () => ({ ratingAfter: 1010, rd: 80, delta: 10 }),
      batch: async () => ({ puzzles: MOCK_PUZZLES }),
      saveRush: async ({ score }) => ({ id: 1, best: score, isBest: true }),
      rushRuns: async () => ({ runs: [] }),
      rushBests: async () => ({ bests: [] }),
      daily: async () => ({ ymd: utcYmd(), puzzle: MOCK_PUZZLES[0], result: null }),
      recordDaily: async () => ({ streak: ZERO_STREAK }),
      dailyStreak: async () => ({ streak: ZERO_STREAK }),
      stats: async () => ({
        totalAttempts: 0,
        totalSolved: 0,
        accuracy: 0,
        bestStreak: 0,
        byTheme: [],
        daily: []
      }),
      history: async () => ({ rows: [] })
    },
    ratings: {
      get: async () => ({ rating: 1000, rd: 80, vol: 0.06 })
    },
    progress: {
      summary: async () => ({
        puzzleRating: 1000,
        puzzleRd: 80,
        vsBotRating: 1000,
        vsBotRd: 80,
        puzzlesSolved: 0,
        puzzlesTried: 0,
        gamesPlayed: 0,
        lastPuzzleAt: null,
        lastGameAt: null
      })
    },
    games: {
      save: async () => ({ gameId: 1 }),
      list: async () => ({ games: [] }),
      listAll: async ({ kind, source } = {}) => ({
        games: MOCK_LIBRARY_GAMES.filter(
          (g) => (!kind || g.game_kind === kind) && (!source || g.source === source)
        ),
        kinds: [
          { kind: 'chess', count: 1 },
          { kind: 'atomic', count: 1 },
          { kind: 'go', count: 1 },
          { kind: 'othello', count: 1 }
        ],
        sources: ['play', 'otb', 'online']
      }),
      get: async (gameId) => ({
        game: MOCK_LIBRARY_GAMES.find((g) => g.id === gameId) ?? null
      }),
      reportResult: async () => ({ ratingAfter: 1010, delta: 10 })
    },
    openings: {
      lookup: async (fen) => ({
        opening: fen === INITIAL_FEN ? null : { eco: 'A00', name: 'Mock Opening' }
      })
    },
    coach: {
      explainMove: async () => ({ verdict: 'Good', motifs: [], text: 'Mock coaching note.' }),
      positional: async () => ({ terms: [], text: 'Mock positional note.' })
    },
    review: {
      run: async () => ({ reviewId: 1, review: MOCK_REVIEW }),
      get: async () => ({ review: null, moveEvals: [] }),
      cancel: async () => ok,
      onProgress: () => () => {}
    },
    perf: {
      estimate: async () => ({ est: 1300, low: 1200, high: 1500, accuracy: 90 })
    },
    famous: {
      list: async () => ({ games: [] }),
      get: async () => ({ game: null })
    },
    school: {
      chapters: async () => ({ chapters: MOCK_CHAPTER_METAS }),
      chapter: async (id) => ({ chapter: id === MOCK_CHAPTER.id ? MOCK_CHAPTER : null }),
      mastery: async () => ({ concepts: [], chapters: [], lessons: [] }),
      recordConcept: async () => ({ mastery: 0.5 }),
      recordSegment: async () => ok,
      completeChapter: async () => ok,
      narrate: async () => ({ line: { text: 'Viktor (mock): a sound move. Continue.' } }),
      debrief: async () => ({
        lines: [{ text: 'Mock debrief: you used your lessons well.' }],
        usedConcepts: [],
        verdict: 'Well played.'
      }),
      recordLesson: async () => ok,
      recordTest: async ({ scorePct }) => ({
        passed: scorePct >= 70,
        attempts: 1,
        mustRetake: false,
        bestPct: scorePct
      }),
      testState: async () => ({ attempts: 0, passed: false, bestPct: 0 }),
      recommend: async () => ({ recommended: null }),
      dueReviews: async () => ({ due: [] }),
      reviewConcept: async ({ conceptId }) => ({
        conceptId,
        due: Date.now() + 86_400_000,
        reps: 1,
        lapses: 0,
        state: 1,
        remainingDue: 0
      }),
      daily: async () => ({
        ymd: localYmd(),
        chapterId: MOCK_CHAPTER.id,
        chapterTitle: MOCK_CHAPTER.title,
        lessonId: 'mock-l1',
        lessonTitle: 'Take what is free',
        doneToday: false,
        reviewsDue: 0
      }),
      recordDaily: async () => ({ streak: ZERO_STREAK }),
      streak: async () => ({ streak: ZERO_STREAK }),
      placementState: async () => MOCK_PLACEMENT,
      recordPlacementGame: async () => MOCK_PLACEMENT,
      resetPlacement: async () => ({ placed: false, estimatedElo: null, band: null, games: [] }),
      placementConfig: async () => ({ engineElo: 1350 })
    },
    personas: {
      list: async () => ({ personas: [] }),
      move: async ({ fen }) => {
        const ucis = legalUcis(fen)
        return { bestmove: ucis[0] ?? '0000' }
      }
    },
    datasets: {
      status: async () => mockDatasets,
      items: async () => ({
        items: [
          { key: 'engine', label: 'Stockfish 18 engine', bytes: 114007552, installedBytes: 114007552 },
          {
            key: 'puzzles',
            label: 'Lichess puzzle database',
            bytes: 705175215,
            installedBytes: 2148864000
          },
          {
            key: 'maia',
            label: 'Maia human-style chess (lc0 + 5 nets)',
            bytes: 8240517,
            installedBytes: 8240517
          },
          {
            key: 'katago',
            label: 'KataGo Go engine (2 nets)',
            bytes: 19416780,
            installedBytes: 19416780,
            optIn: { label: 'Human-style Go net', bytes: 99066230, installed: false }
          }
        ]
      }),
      import: async (req) => {
        const emit = (p: DatasetProgress): void => datasetSubs.forEach((cb) => cb(p))
        const items: { key: 'engine' | 'puzzles' | 'maia' | 'katago'; total: number }[] = [
          { key: 'engine', total: 114007552 },
          { key: 'puzzles', total: 705175215 },
          { key: 'maia', total: 8240517 },
          { key: 'katago', total: 19416780 + (req?.includeHuman ? 99066230 : 0) }
        ]
        for (let i = 0; i < items.length; i++) {
          const it = items[i]
          for (let step = 1; step <= 4; step++) {
            await sleep(120)
            emit({
              key: it.key,
              phase: 'download',
              received: Math.round((it.total * step) / 4),
              total: it.total,
              itemIndex: i,
              itemCount: items.length
            })
          }
          emit({ key: it.key, phase: 'verify', received: it.total, total: it.total, itemIndex: i, itemCount: items.length })
        }
        mockDatasets = {
          engine: true,
          puzzles: true,
          maia: true,
          katago: true,
          katagoHuman: req?.includeHuman === true,
          complete: true
        }
        emit({ key: 'all', phase: 'done', received: 0, total: 0, itemIndex: 4, itemCount: 4 })
        return { ok: true, status: mockDatasets }
      },
      cancel: async () => ok,
      onProgress: (cb) => {
        datasetSubs.add(cb)
        return () => {
          datasetSubs.delete(cb)
        }
      }
    },
    // Variant Lab: in-memory store so the editor gallery/save/delete flows work
    // in the browser preview (ffish WASM itself loads fine in the browser).
    customVariants: {
      save: async (req) => {
        const now = Date.now()
        const prev = mockCustomVariants.get(req.id)
        const variant = { ...req, createdAt: prev?.createdAt ?? now, updatedAt: now }
        mockCustomVariants.set(req.id, variant)
        return { variant }
      },
      list: async () => ({
        variants: [...mockCustomVariants.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      }),
      get: async (id) => ({ variant: mockCustomVariants.get(id) ?? null }),
      delete: async (id) => {
        mockCustomVariants.delete(id)
        return { ok: true }
      }
    },
    // Save dialog: the browser preview has no OS dialog. Trigger a plain
    // download so Replay Theater's export stays fully testable in the harness.
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
    // Updates: the browser preview is neither installable nor updatable. A
    // static manual-mode snapshot that reports up-to-date on check. Add
    // `&mockUpdate=available` (or `=ready`, the Windows post-download state) to
    // the preview URL to seed a fake newer version so the startup toast and the
    // Settings → Updates offer render for visual checks.
    updates: (() => {
      const seeded = new URLSearchParams(window.location.search).get('mockUpdate')
      const status =
        seeded === 'available' || seeded === 'ready'
          ? ({
              state: seeded,
              currentVersion: 'mock',
              mode: seeded === 'ready' ? 'auto' : 'manual',
              latestVersion: '9.9.9',
              downloadUrl: 'https://example.com/nodechess-9.9.9-arm64.dmg',
              releaseUrl: 'https://example.com/releases',
              checkedAt: Date.now()
            } as const)
          : ({ state: 'idle', currentVersion: 'mock', mode: 'manual' } as const)
      return {
        status: async () => status,
        check: async () =>
          seeded
            ? { ...status, checkedAt: Date.now() }
            : { state: 'up-to-date' as const, currentVersion: 'mock', mode: 'manual' as const, checkedAt: Date.now() },
        download: async () => ({
          ok: false,
          action: 'none' as const,
          error: 'not available in the browser preview'
        }),
        onStatus: () => () => {}
      }
    })()
    // NOTE: multiplayer is no longer part of window.api. The renderer owns the
    // WebRTC session directly (features/play/online/mpClient), so there's nothing
    // to mock here anymore.
  }

  window.api = api
  // eslint-disable-next-line no-console
  console.info('[devMock] window.api installed (preview harness)')
}
