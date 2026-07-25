// The web `Api['engine']` implementation: a channel-for-channel port of
// src/main/ipc/engine.ipc.ts onto the WASM pools (pools.ts):
//   analyze/stop  → analysis instance, one active streaming subscription,
//                   handleId increments, onLine/onBestmove fan-out.
//   play          → play instance; level → strategy routing identical to
//                   desktop, including the calibrated sub-1320 weak-play model
//                   (weakPlay.ts) and the legacy uciElo/skill knobs.
//   playVariant   → Fairy-Stockfish; FAIRY_VARIANT_KINDS + 'custom-<id>'
//                   (custom inis resolved via deps.getCustomVariantIni: the
//                   web upgrade the build contract asks for; desktop routes
//                   customs through the same engine via VariantPath).
//   evalVariant   → one bounded single-line fairy search, side-to-move POV.
//   playGo/estimateGo → honest desktop-only rejections (KataGo is native-only).
//   status        → capability probe (assets reachable + wasm/SAB support),
//                   optimistic-after-warmup per the build contract.
//
// The zod schemas guarding the desktop channels run in the main process; here
// the same constraints are enforced inline (safeFen re-serialization, the
// variant-FEN allowlist, level/movetime clamps): cheap, and it keeps the
// engine's stdin-equivalent free of smuggled commands on both platforms.

import { parseFen, makeFen } from 'chessops/fen'
import {
  ENGINE_ELO_FLOOR,
  FAIRY_VARIANT_KINDS,
  MAIA_LEVELS,
  type Api,
  type EngineBestmove,
  type EngineLine,
  type EngineStatus,
  type EvalVariantResult,
  type GoLimit,
  type PlayLevel
} from '@shared/types'
import type { WebEngineDeps } from './index'
import {
  assetReachable,
  chessWorkerUrl,
  fairyScriptUrl,
  isolated,
  wasmSupported,
  webEngineSupported
} from './assets'
import { fairyPool, pool, serializeAnalysis, serializeFairy, serializePlay } from './pools'
import type { WebUciEngine } from './WebUciEngine'
import type { BestMove, InfoLine } from './uci'
import { weakPlay, WEAK_DEFAULT_MOVETIME_MS } from './weakPlay'

// ---- Input guards (mirror the desktop zod schemas) --------------------------------

/** Parse + re-serialize any FEN before it reaches the engine, so a malformed
 *  payload can't smuggle newlines/extra UCI commands into the command stream. */
export function safeFen(fen: string): string {
  const setup = parseFen(fen)
  if (setup.isErr) throw new Error('engine: invalid FEN')
  return makeFen(setup.value)
}

/** Variant FENs can't be chessops-validated (xiangqi/shogi/janggi dialects).
 *  Character allowlist, one line, FEN alphabet only (desktop VARIANT_FEN_RE). */
export const VARIANT_FEN_RE = /^[A-Za-z0-9/\[\]+~.\- ]{1,160}$/

function checkLimit(limit: GoLimit): GoLimit {
  if (
    !limit ||
    (limit.kind !== 'infinite' &&
      (!Number.isInteger(limit.value) || (limit as { value: number }).value <= 0))
  ) {
    throw new Error('engine: invalid go limit')
  }
  return limit
}

function intInRange(v: number, lo: number, hi: number, what: string): number {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`engine: ${what} out of range`)
  return v
}

// ---- Level → strategy routing (pure; golden-tested headlessly) ---------------------

export type PlayStrategy =
  | { kind: 'maia'; level: (typeof MAIA_LEVELS)[number] }
  | { kind: 'weak'; elo: number; panic: boolean }
  | { kind: 'uciElo'; elo: number }
  | { kind: 'skill'; skill: number }
  | { kind: 'default'; elo: 1500 }

/** Desktop engine:play's knob precedence, extracted pure:
 *  maia > elo (native at >= ENGINE_ELO_FLOOR, weak model below) > legacy
 *  uciElo > legacy skill > club default 1500. `panic` rides beside the typed
 *  knobs exactly as it does over the desktop ipc (playSchema accepts it; the
 *  shared PlayLevel type doesn't declare it). */
export function resolvePlayStrategy(level: PlayLevel): PlayStrategy {
  if (level.maia !== undefined) {
    if (!(MAIA_LEVELS as readonly number[]).includes(level.maia)) {
      throw new Error('engine: invalid maia level')
    }
    return { kind: 'maia', level: level.maia }
  }
  if (level.elo !== undefined) {
    intInRange(level.elo, 100, 3190, 'elo')
    if (level.elo < ENGINE_ELO_FLOOR) {
      const panic = (level as PlayLevel & { panic?: boolean }).panic === true
      return { kind: 'weak', elo: level.elo, panic }
    }
    return { kind: 'uciElo', elo: level.elo }
  }
  if (level.uciElo !== undefined) {
    return { kind: 'uciElo', elo: intInRange(level.uciElo, ENGINE_ELO_FLOOR, 3190, 'uciElo') }
  }
  if (level.skill !== undefined) {
    return { kind: 'skill', skill: intInRange(level.skill, 0, 20, 'skill') }
  }
  // Neither given: never answer at full strength. Cap to a club default.
  return { kind: 'default', elo: 1500 }
}

// ---- Variant routing (desktop FAIRY_UCI_VARIANT / FAIRY_LEVELS verbatim) -----------

/** kind → the engine's UCI_Variant id ('chess960' is 'chess' + UCI_Chess960). */
export const FAIRY_UCI_VARIANT: Record<(typeof FAIRY_VARIANT_KINDS)[number], string> = {
  chess960: 'chess',
  crazyhouse: 'crazyhouse',
  atomic: 'atomic',
  antichess: 'antichess',
  kingofthehill: 'kingofthehill',
  threecheck: '3check',
  horde: 'horde',
  racingkings: 'racingkings',
  xiangqi: 'xiangqi',
  shogi: 'shogi',
  janggi: 'janggi',
  makruk: 'makruk',
  placement: 'placement'
}

/** Level 1..5 → engine strength (games/bots.ts CHESS_LEVEL_ELO envelope). */
export const FAIRY_LEVELS = [
  { elo: 600, movetime: 150 },
  { elo: 1000, movetime: 250 },
  { elo: 1400, movetime: 350 },
  { elo: 1850, movetime: 500 },
  { elo: 2300, movetime: 700 }
] as const

/** Mirrors renderer games/customVariants.ts SECTION_RE (first ini section =
 *  the variant the engine must select). */
export const INI_SECTION_RE = /^\s*\[([A-Za-z0-9_-]+)(?::([A-Za-z0-9_-]+))?\]\s*$/m

interface FairyTarget {
  variant: string
  chess960: boolean
  variantIni?: { id: string; text: string }
}

/** kind → fairy engine target. Built-in kinds, or 'custom-<id>' resolved
 *  through deps.getCustomVariantIni. Throws on unknown kinds. The desktop
 *  resolveEvalVariant contract. */
async function resolveFairyTarget(kind: string, deps: WebEngineDeps): Promise<FairyTarget> {
  if (kind === 'chess') return { variant: 'chess', chess960: false }
  if ((FAIRY_VARIANT_KINDS as readonly string[]).includes(kind)) {
    const k = kind as (typeof FAIRY_VARIANT_KINDS)[number]
    return { variant: FAIRY_UCI_VARIANT[k], chess960: kind === 'chess960' }
  }
  if (kind.startsWith('custom-')) {
    const id = kind.slice('custom-'.length)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id.length > 48) {
      throw new Error(`evalVariant: bad custom variant id '${id}'`)
    }
    const ini = await deps.getCustomVariantIni(id)
    if (ini == null) throw new Error(`evalVariant: unknown custom variant '${id}'`)
    const head = INI_SECTION_RE.exec(ini)
    if (!head) throw new Error(`evalVariant: custom variant '${id}' has no [section] header`)
    return { variant: head[1], chess960: false, variantIni: { id, text: ini } }
  }
  throw new Error(`evalVariant: unsupported kind '${kind}'`)
}

// ---- Bounded single-line eval (desktop evalOnce verbatim) --------------------------

/**
 * One bounded single-line search; resolves with the LAST scored info line
 * (side-to-move relative, UCI convention). Terminal positions ('bestmove
 * (none)', no info) resolve to {}. Every exit path detaches its listeners.
 */
export function evalOnce(
  eng: WebUciEngine,
  fen: string,
  movetimeMs: number
): Promise<EvalVariantResult> {
  return new Promise((resolve, reject) => {
    let last: InfoLine | null = null
    let done = false
    const onInfo = (info: InfoLine): void => {
      if (info.scoreCp !== undefined || info.mate !== undefined) last = info
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      eng.off('info', onInfo)
      eng.off('bestmove', onBest)
      eng.off('exit', onExit)
      eng.off('engineError', onErr)
    }
    const onBest = (): void => {
      if (done) return
      done = true
      cleanup()
      if (!last) resolve({})
      else if (last.mate !== undefined) resolve({ mate: last.mate })
      else resolve({ cp: last.scoreCp })
    }
    const fail = (e: Error): void => {
      if (done) return
      done = true
      cleanup()
      reject(e)
    }
    const onExit = (): void => fail(new Error('engine exited during eval'))
    const onErr = (err: Error): void =>
      fail(err instanceof Error ? err : new Error('engine error during eval'))
    // Hard ceiling well above any movetime the guard admits.
    const timer = setTimeout(() => fail(new Error('eval timeout')), 15000)
    eng.on('info', onInfo)
    eng.once('bestmove', onBest)
    eng.once('exit', onExit)
    eng.once('engineError', onErr)
    void eng.search(fen, { kind: 'movetime', value: movetimeMs }, 1)
  })
}

// ---- Go bots: honest desktop-only rejection ----------------------------------------

async function goBotsDesktopOnly(): Promise<never> {
  // Lazy import: BotUnavailableError is the class the game UIs surface as a
  // toast (same pattern as webApi.ts botComingOnline).
  const { BotUnavailableError } = await import('@/games/bots')
  throw new BotUnavailableError('Go bots are coming to the web, available today in the desktop app.')
}

// ---- Status probe ------------------------------------------------------------------

let statusProbe: Promise<{ chess: boolean; fairy: boolean }> | null = null

/** Capability warmup probe (memoized while successful, retried after failure):
 *  wasm support + the engine assets reachable same-origin. The fairy build is
 *  pthread-only, so it additionally needs crossOriginIsolated; chess falls
 *  back to its single-threaded build when isolation is missing. */
function probeCapabilities(): Promise<{ chess: boolean; fairy: boolean }> {
  if (!statusProbe) {
    statusProbe = (async () => {
      if (!wasmSupported()) return { chess: false, fairy: false }
      const [chessOk, fairyOk] = await Promise.all([
        pool.hasAnalysis() || pool.hasPlay() ? Promise.resolve(true) : assetReachable(chessWorkerUrl()),
        fairyPool.hasEngine() ? Promise.resolve(true) : assetReachable(fairyScriptUrl())
      ])
      return { chess: chessOk, fairy: fairyOk && isolated() }
    })()
    statusProbe.then(
      (r) => {
        // A failed probe must not be permanent (e.g. transient dev-server hiccup).
        if (!r.chess && !r.fairy) statusProbe = null
      },
      () => {
        statusProbe = null
      }
    )
  }
  return statusProbe
}

// ---- The factory -------------------------------------------------------------------

export function buildEngineApi(deps: WebEngineDeps): Api['engine'] {
  if (!webEngineSupported()) {
    // Throwing at construction (not per call) routes engineless environments
    // into webApi's lazy() catch → the W1 coming-online fallbacks.
    throw new Error('web engine layer unavailable: no Worker/WebAssembly in this environment')
  }
  // engine.onLine / engine.onBestmove subscribers (the web stand-in for the
  // desktop's sender.send('engine:line'|'engine:bestmove')).
  const lineSubs = new Set<(line: EngineLine) => void>()
  const bestmoveSubs = new Set<(bm: EngineBestmove) => void>()

  let nextHandle = 1
  // One analysis engine -> one active streaming subscription at a time.
  let active: {
    handleId: number
    eng: WebUciEngine
    onInfo: (i: InfoLine) => void
    onBest: (b: BestMove) => void
  } | null = null

  function clearActive(): void {
    if (active) {
      active.eng.off('info', active.onInfo)
      active.eng.off('bestmove', active.onBest)
      active = null
    }
  }

  return {
    analyze: ({ fen, multipv, limit }) =>
      serializeAnalysis(async () => {
        const safe = safeFen(fen) // validate/normalize before any allocation
        const mpv = multipv === undefined ? 3 : intInRange(multipv, 1, 10, 'multipv')
        checkLimit(limit)
        const eng = await pool.getAnalysis()
        clearActive()
        // Drain any in-flight (infinite) search to idle BEFORE attaching this
        // search's listeners: otherwise the previous search's stop-bestmove
        // would immediately tear the new subscription down.
        await eng.stop()
        const handleId = nextHandle++
        const onInfo = (info: InfoLine): void => {
          const payload: EngineLine = { handleId, ...info }
          for (const cb of [...lineSubs]) cb(payload)
        }
        const onBest = (bm: BestMove): void => {
          const payload: EngineBestmove = { handleId, ...bm }
          for (const cb of [...bestmoveSubs]) cb(payload)
          clearActive()
        }
        active = { handleId, eng, onInfo, onBest }
        eng.on('info', onInfo)
        eng.once('bestmove', onBest)
        await eng.search(safe, limit, mpv)
        return { handleId }
      }),

    stop: (handleId) =>
      serializeAnalysis(async () => {
        // Only stop the search the caller actually started (a stale id is a no-op).
        if (active && active.handleId === handleId) {
          await active.eng.stop()
          clearActive()
        }
        return { ok: true }
      }),

    play: ({ fen, level, limit }) =>
      serializePlay(async () => {
        const safe = safeFen(fen)
        checkLimit(limit)
        const strategy = resolvePlayStrategy(level)
        if (strategy.kind === 'maia') {
          // Honest desktop-only rejection: the Maia nets run on lc0, which has
          // no browser build here. status() reports lc0Ready false, so the
          // renderer never offers the Human style on web. This is defensive.
          throw new Error(
            'The Human (Maia) style is desktop-only for now: lc0 does not run in the web app.'
          )
        }
        const eng = await pool.getPlay()
        // Drain any abandoned search to idle BEFORE attaching new listeners /
        // starting a new search. Same discipline as desktop engine:play.
        await eng.stop()
        if (strategy.kind === 'weak') {
          // Below Stockfish's floor: calibrated engine-driven weakening. The
          // caller's movetime is honored as a soft cap so a sub-1320 bot can't
          // blow its clock on slow hardware.
          const budget = limit.kind === 'movetime' ? limit.value : WEAK_DEFAULT_MOVETIME_MS
          return weakPlay(eng, safe, strategy.elo, strategy.panic, budget)
        }
        eng.setOption('MultiPV', 1)
        if (strategy.kind === 'skill') {
          eng.setOption('UCI_LimitStrength', false)
          eng.setOption('Skill Level', strategy.skill)
        } else {
          eng.setOption('UCI_LimitStrength', true)
          eng.setOption('UCI_Elo', strategy.elo)
        }
        return eng.bestMove(safe, limit)
      }),

    playVariant: ({ kind, fen, level, movetimeMs }) =>
      serializeFairy(async () => {
        if (!VARIANT_FEN_RE.test(fen)) throw new Error('engine: invalid variant FEN')
        const l = intInRange(level, 1, 5, 'level')
        if (movetimeMs !== undefined) intInRange(movetimeMs, 20, 10000, 'movetimeMs')
        const target = await resolveFairyTarget(kind, deps)
        const eng = await fairyPool.get(target.variant, target.chess960, target.variantIni)
        // Drain any abandoned search to idle before touching options.
        await eng.stop()
        const cfg = FAIRY_LEVELS[l - 1]
        eng.setOption('UCI_LimitStrength', true)
        eng.setOption('UCI_Elo', cfg.elo)
        // The character allowlist above already blocked command smuggling; the
        // engine itself is the rules authority for the variant FEN dialect.
        return eng.bestMove(fen, { kind: 'movetime', value: movetimeMs ?? cfg.movetime })
      }),

    playGo: () => goBotsDesktopOnly(),
    estimateGo: () => goBotsDesktopOnly(),

    // Replay-viewer eval bar (chess family incl. customs). Shares the fairy
    // chain so an eval can never interleave with a variant bot's search.
    evalVariant: ({ kind, fen, movetimeMs }) =>
      serializeFairy(async (): Promise<EvalVariantResult> => {
        if (typeof kind !== 'string' || kind.length === 0 || kind.length > 64) {
          throw new Error('evalVariant: bad kind')
        }
        if (!VARIANT_FEN_RE.test(fen)) throw new Error('engine: invalid variant FEN')
        if (movetimeMs !== undefined) intInRange(movetimeMs, 50, 2000, 'movetimeMs')
        const target = await resolveFairyTarget(kind, deps)
        const eng = await fairyPool.get(target.variant, target.chess960, target.variantIni)
        await eng.stop() // drain any abandoned search: same discipline as playVariant
        // Full strength for an honest eval (playVariant may have weakened it).
        eng.setOption('UCI_LimitStrength', false)
        return evalOnce(eng, fen, movetimeMs ?? 300)
      }),

    status: async (): Promise<EngineStatus> => {
      const caps = await probeCapabilities()
      return {
        analysisReady: caps.chess,
        playReady: caps.chess,
        // Maia/lc0 and KataGo are native binaries. Desktop-only, honestly so.
        lc0Ready: false,
        fairyReady: caps.fairy,
        katagoReady: false,
        katagoHumanReady: false
      }
    },

    newGame: (instance) =>
      (instance === 'analysis' ? serializeAnalysis : serializePlay)(async () => {
        const eng = instance === 'analysis' ? await pool.getAnalysis() : await pool.getPlay()
        await eng.newGame()
        return { ok: true }
      }),

    onLine: (cb) => {
      lineSubs.add(cb)
      return () => {
        lineSubs.delete(cb)
      }
    },
    onBestmove: (cb) => {
      bestmoveSubs.add(cb)
      return () => {
        bestmoveSubs.delete(cb)
      }
    }
  }
}
