import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Role } from 'chessops/types'
import type { Key } from 'chessground/types'
import type { MaiaLevel, Persona } from '../../../../shared/types'
import { useGameTree } from '../../state/gameTree'
import { useSettings } from '../../state/settings'
import { treeToPgn } from '../../state/pgn'
import {
  applyMove,
  checkColor,
  destsFor,
  isPromotion,
  outcome,
  turnColor,
  uciToLastMove,
  INITIAL_FEN,
  type Color,
  type GameResult
} from '../../chess/chess'
import { chooseBotMove, randomLegalUci, ENGINE_ELO_FLOOR } from '../../chess/botStrength'
import { measuredElo } from '@shared/botStrength'
import {
  DEEP_THINK_MS,
  ENGINE_OVERHEAD_MS,
  ENGINE_SLICE_MAX_MS,
  ENGINE_SLICE_MIN_MS,
  TIME_PERSONALITIES,
  complexityMultiplier,
  fullmoveOf,
  instantClassOf,
  materialPhaseFromFen,
  memoAfterMove,
  personalityForElo,
  planThink,
  runComplexityProbe,
  signalsFromProbe,
  timeStyleForPersona,
  type ProbeMemo,
  type ProbeReading,
  type ThinkClass,
  type ThinkPlan,
  type TimePersonality
} from './botTime'
import type { StartSpec } from './setupTypes'
import { PlaySetup } from './PlaySetup'
import OnlineTab from './OnlineTab'
import { useOnlineGame } from './online/useOnlineGame'
import { GameView, type GameViewBanner } from './GameView'
import type { ViewKey } from '../../components/Layout'
import { useEngineReady } from '../../hooks/useEngineReady'
import { pieceSetClass } from '../../board/pieceSets'
import { useSound } from '../../sound'
import { useChessClock } from './useChessClock'
import { DEFAULT_TIME_CONTROL_ID, timeControlById, type TimeControl } from './timeControl'
import './play.css'

const ROLE_FROM_CHAR: Record<string, Role> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }

type Phase = 'setup' | 'game'

// The resolved opponent for an in-progress game. Captured at game start so the
// reply loop and save/report paths stay consistent even if setup changes later.
// Persona games carry their DISPLAY/rating elo (modernElo when known, else
// peakElo): the in-game chrome, saved game and rating report all use it. The
// move strength itself is resolved in main (personas:move caps near peakElo).
// 'maia' is the "Human" style: the maia-<level> lc0 net at nodes=1 (engine:play
// level.maia); elo = the net's nominal band, which measuredElo passes through.
// 'human' is Over-the-board: two people on one machine, no engine loop. Both
// player names + the auto-flip preference are frozen at start.
type Opponent =
  | { kind: 'engine'; elo: number }
  | { kind: 'maia'; level: MaiaLevel; elo: number }
  | { kind: 'persona'; persona: Persona; elo: number }
  | { kind: 'human'; whiteName: string; blackName: string; autoFlip: boolean }

interface BannerState {
  result: GameResult
  reason: string
  delta?: number
  newRating?: number
  /** Row id of the just-saved game, for the "Analyze this game" action. */
  gameId?: number
}

function yyyymmdd(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}.${m}.${day}`
}

// User-perspective score (1 win / 0.5 draw / 0 loss) for reportResult.
function userScore(result: GameResult, userColor: Color): number {
  if (result === '1/2-1/2') return 0.5
  const userWon = (result === '1-0' && userColor === 'white') || (result === '0-1' && userColor === 'black')
  return userWon ? 1 : 0
}

function outcomeForUser(result: GameResult, userColor: Color): 'win' | 'loss' | 'draw' {
  const s = userScore(result, userColor)
  return s === 1 ? 'win' : s === 0.5 ? 'draw' : 'loss'
}

function opponentName(o: Opponent): string {
  if (o.kind === 'persona') return o.persona.name
  if (o.kind === 'human') return o.blackName // unused for OTB chrome (computed per-side below)
  if (o.kind === 'maia') return `Maia ${o.level}`
  return 'Stockfish'
}

function opponentElo(o: Opponent): number {
  return o.kind === 'human' ? 0 : o.elo
}

export interface PlayViewProps {
  /** Open a finished game in Analysis by its saved-game row id. */
  onAnalyzeGame?: (gameId: number) => void
  /** Open a famous game in Analysis by famous-game id (e.g. "morphy-g1"):
   *  consumed by the persona detail pane's "Famous games" list (ids come from
   *  Persona.famousGameIds). */
  onOpenFamousGame?: (famousId: string) => void
  /** Deep link to Settings → Datasets (the engine-required install CTA). */
  onOpenSettings?: () => void
  /** Leave Play. "While you wait" needs it and has nowhere to go without it;
   *  App.tsx does not pass it yet, so that row is simply not drawn. */
  onNavigate?: (view: ViewKey) => void
}

export function PlayView({
  onAnalyzeGame,
  onOpenFamousGame,
  onOpenSettings,
  onNavigate
}: PlayViewProps = {}) {
  const { settings } = useSettings()
  const { play, playMove } = useSound()

  const [phase, setPhase] = useState<Phase>('setup')
  // The live online session. It outlives this component (the store is
  // app-lifetime), so a running game is rendered straight from it rather than
  // from any local phase of ours.
  const online = useOnlineGame()

  // ---- Engine availability guard (fresh install: no Stockfish on disk) ----
  // Probed on the setup screen (and re-probed on every return to it, so
  // finishing the Settings → Datasets download is picked up). When the engine
  // is missing the Bot section swaps its commit row for the install CTA, and
  // startGame refuses rather than dead-ending into a rejected spawn.
  const { ready: engineReady, recheck: recheckEngine } = useEngineReady(phase === 'setup')
  // Belt-and-braces: set when engine:newGame rejects at start despite the probe
  // (e.g. a corrupt/deleted binary). Same CTA, a re-download fixes it.
  const [engineStartError, setEngineStartError] = useState<string | null>(null)
  const engineMissing = engineReady === false || engineStartError !== null

  // Resolved at game start.
  const [userColor, setUserColor] = useState<Color>('white')
  const [orientation, setOrientation] = useState<Color>('white')
  const [opponent, setOpponent] = useState<Opponent>({ kind: 'engine', elo: 1500 })
  const [timeControl, setTimeControl] = useState<TimeControl>(() => timeControlById(DEFAULT_TIME_CONTROL_ID))

  // In-game runtime.
  const tree = useGameTree()
  const [thinking, setThinking] = useState(false)
  // Long allocation (>= DEEP_THINK_MS): GameView shows the calm dots variant.
  const [deepThink, setDeepThink] = useState(false)
  const [pendingPromo, setPendingPromo] = useState<{ orig: string; dest: string } | null>(null)
  const [nonce, setNonce] = useState(0)
  const [banner, setBanner] = useState<BannerState | null>(null)
  // Bumped at each game start to reset the clocks (even for an identical control).
  const [gameKey, setGameKey] = useState(0)

  // save+report fire exactly once per game; a ref so async paths see the latest value.
  const savedRef = useRef(false)

  // What the bot's last probed think expected the user to reply (botTime's
  // surprise signal). Cleared on game start and on takeback. An expectation
  // about a line that no longer exists must never inflate a think.
  const lastProbeRef = useRef<ProbeMemo | null>(null)

  // The in-progress think's commitment. Browsing history mid-think cancels the
  // reply effect (existing behavior); on return to the tip the effect re-fires
  // for the SAME fen and must RESUME the original deadline. The bot's clock
  // ticked through the scrub, and wiggling the move list must neither buy the
  // bot extra thinking nor let the user drain it into a flag by re-triggering
  // fresh allocations. Cleared when the reply lands, on takeback, on new game.
  const thinkLedgerRef = useRef<{
    fen: string
    /** The bot's clock reading at which it committed to reply. */
    targetRemainingMs: number
    cls: ThinkClass
    panic: boolean
    complexity: number
    probe: ProbeReading | null
  } | null>(null)

  // The last thing that was started, so a rematch replays exactly it (a
  // 'random' colour re-rolls, which is what a rematch means) instead of
  // reading a form the sections own and may have changed since.
  const [lastSpec, setLastSpec] = useState<StartSpec | null>(null)

  const fen = tree.currentFen
  const dests = useMemo(() => destsFor(fen), [fen])
  const turn = turnColor(fen)
  const check = checkColor(fen)
  const lastMove = tree.current.move ? uciToLastMove(tree.current.move.uci) : undefined
  const over = banner !== null || outcome(fen).over
  // The live game position is the mainline tip (a node with no continuation).
  // When the user navigates to a PAST move, we're not at the tip. The board is
  // read-only and the engine must NOT move (it already replied at the tip).
  const atTip = tree.current.children.length === 0

  // Side to move in the LIVE game, from the mainline tip, NOT the displayed
  // node. While browsing history `turn` is whoever was to move in that past
  // position; ticking the clock off it would drain the wrong side's time. The
  // clock must always follow the tip. (`tree.root` is mutated in place, so
  // `tree.current` (which changes identity on every move AND on takeback)
  // tracks tip growth/shrink.)
  const liveTip = useMemo(() => {
    let n = tree.root
    while (n.children[0]) n = n.children[0]
    return n
  // tree.current.children.length: a takeback can cut the tree at the very node
  // `current` already sits on (browsing at the cut point), same node identity,
  // fewer children. Without it the memo would keep returning the detached old
  // tip and the clock would tick the wrong side.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.root, tree.current, tree.current.children.length])
  const liveFen = liveTip.fen
  const liveTurn = turnColor(liveFen)

  // Clock personality for this opponent: persona.timeStyle (with botTime's
  // by-id fallback while the catalog loader doesn't pass the field through),
  // or the Elo-tier mapping for plain-engine games.
  const botPersonality = useMemo<TimePersonality>(
    () =>
      opponent.kind === 'persona'
        ? TIME_PERSONALITIES[timeStyleForPersona(opponent.persona)]
        : personalityForElo(
            opponent.kind === 'engine' || opponent.kind === 'maia' ? opponent.elo : 1500
          ),
    [opponent]
  )

  const oppName = opponentName(opponent)
  const oppElo = opponentElo(opponent)
  const isOtb = opponent.kind === 'human'
  // Board names. OTB uses the two frozen player names; vs-engine/persona put the
  // user on their chosen color and the opponent opposite.
  const whiteName = isOtb
    ? opponent.whiteName || 'White'
    : userColor === 'white'
      ? settings.username
      : oppName
  const blackName = isOtb
    ? opponent.blackName || 'Black'
    : userColor === 'white'
      ? oppName
      : settings.username

  const finishGame = useCallback(
    async (result: GameResult, reason: string) => {
      if (savedRef.current) return
      savedRef.current = true

      const isPersona = opponent.kind === 'persona'
      const otb = opponent.kind === 'human'
      const event = otb
        ? 'Over the board'
        : isPersona
          ? `Play vs ${oppName} style`
          : opponent.kind === 'maia'
            ? 'Play vs Maia'
            : 'Play vs Stockfish'
      const headers: Record<string, string> = {
        Event: event,
        Site: 'nodechess',
        Date: yyyymmdd(),
        White: whiteName,
        Black: blackName,
        Result: result
      }
      const pgn = treeToPgn(tree.root, headers)

      // Save and report independently, and NEVER let either failure block the
      // game-over banner: a rejected IPC here used to leave the board frozen with
      // no banner and no retry (savedRef already latched). On failure the banner
      // simply omits the rating delta / "Analyze this game" action. savedRef stays
      // latched even then: un-latching would re-arm the opponent-reply effect in
      // an already-ended game.
      let saved: { gameId: number } | undefined
      try {
        saved = await window.api?.games.save(
          otb
            ? {
                pgn,
                whiteName,
                blackName,
                result,
                opponentKind: 'human',
                source: 'play'
              }
            : {
                pgn,
                whiteName,
                blackName,
                userColor,
                result,
                opponentKind: isPersona ? 'persona' : opponent.kind === 'maia' ? 'maia' : 'engine',
                opponentLabel: oppName,
                opponentElo: oppElo,
                source: 'play'
              }
        )
      } catch {
        saved = undefined // game not persisted; still end the game in the UI
      }

      // Over-the-board games don't move the vs-bot ladder. No rating report.
      let rep: { ratingAfter: number; delta: number } | undefined
      if (!otb) {
        try {
          rep = await window.api?.games.reportResult({
            // The NOMINAL label: main maps it through measuredElo (sub-floor
            // engine levels play stronger than their labels; maia nets rate at
            // their nominal training band) before rating.
            botElo: oppElo,
            score: userScore(result, userColor),
            opponentKind: isPersona ? 'persona' : opponent.kind === 'maia' ? 'maia' : 'engine'
          })
        } catch {
          rep = undefined // rating unchanged; banner shows no delta
        }
      }
      setBanner({
        result,
        reason,
        delta: rep?.delta,
        newRating: rep?.ratingAfter,
        gameId: saved?.gameId
      })
      play('gameEnd')
    },
    [opponent, oppName, oppElo, tree.root, userColor, whiteName, blackName, play]
  )

  // ---- Clock --------------------------------------------------------------
  // A flag fall ends the game as a time loss for whichever side ran out. The
  // winner is simply the other color; finishGame handles save + report.
  const onFlag = useCallback(
    (loser: Color) => {
      if (savedRef.current) return
      const result: GameResult = loser === 'white' ? '0-1' : '1-0'
      void finishGame(result, 'time')
    },
    [finishGame]
  )

  // Gate the ticking warning on the live setting (the clock reads the callback
  // through a ref, so toggling mid-game takes effect immediately).
  const onLowTime = useCallback(() => {
    if (settings.lowTimeWarning) play('lowTime')
  }, [play, settings.lowTimeWarning])

  const clock = useChessClock({
    timeControl,
    gameKey,
    // The clock ticks the side to move in the LIVE game (mainline tip). Using the
    // displayed node's `turn` here drained the wrong side while browsing history.
    turn: liveTurn,
    // White's clock starts ticking the moment the game is live (standard chess).
    running: phase === 'game',
    over,
    onFlag,
    onLowTime
  })

  // Opponent reply loop: driven by fen changes. Also fires on game start when the
  // opponent plays first (user chose Black). Routes through personas.move in GM
  // mode and engine.play otherwise. Only mutates the tree.
  //
  // BOT TIME MANAGER (timed games only, Unlimited keeps the original fixed
  // settings.playThinkMs behavior verbatim): the bot's reply latency and its
  // clock spend are the same real thing. Per move we
  //   1. classify: forced/instant (skip everything), theory (openings.lookup
  //      hit => 0.5-3s), panic (time trouble => 0.4-1.2s + strength collapse),
  //      or normal, which runs a depth-8/MultiPV-3 probe on the ANALYSIS
  //      channel to derive a 0.3x..4x complexity multiplier;
  //   2. allocate T via planThink (base = remaining/H + 0.8*inc, personality
  //      and complexity scaled, log-normal noise, floors/ceilings/reserve);
  //   3. hand the engine a movetime slice of T and then wait out the remainder,
  //      never replying early, never billing fake time. The clock keeps
  //      ticking the bot through all of it, so a bot that thinks past zero
  //      genuinely FLAGS (onFlag ends the game; savedRef discards this reply).
  useEffect(() => {
    if (phase !== 'game') return
    if (opponent.kind === 'human') return // Over-the-board: no engine loop at all
    if (!atTip) return // viewing history, so don't auto-move the engine
    if (turn === userColor) return
    if (outcome(fen).over) return

    let cancelled = false
    let waitTimer: ReturnType<typeof setTimeout> | undefined
    setThinking(true)

    const timed = clock.active
    const opponentSide: Color = userColor === 'white' ? 'black' : 'white'
    // Remaining time captured as the think starts (fresh: this effect fires on
    // the very render that put the bot on move). Elapsed wall time below keeps
    // later reads honest without depending on the ticking clock state.
    const startRemainingMs = clock.times[opponentSide]
    const incrementMs = timeControl.incMs
    const t0 = performance.now()
    // The move that produced this position. The user's move, except at game
    // start as Black (bot opens; no previous move, no surprise signal).
    const prevMove =
      tree.current.move != null
        ? { uci: tree.current.move.uci, capture: tree.current.move.capture }
        : null

    ;(async () => {
      // ---- 1+2: classify and allocate (timed games only) ----
      let plan: ThinkPlan | null = null
      let probe: ProbeReading | null = null
      if (timed) {
        const ledger = thinkLedgerRef.current
        if (ledger && ledger.fen === fen) {
          // RESUME an interrupted think (the user scrubbed history and came
          // back): hold the original deadline. What's left = current clock
          // minus the committed reply reading; overdue clamps to 0 (reply asap).
          probe = ledger.probe
          plan = {
            totalMs: Math.max(0, Math.round(startRemainingMs - ledger.targetRemainingMs)),
            cls: ledger.cls,
            panic: ledger.panic,
            complexity: ledger.complexity
          }
        } else {
          const instant = instantClassOf(fen, prevMove)
          let cls: 'instant' | 'book' | 'normal' = instant !== null ? 'instant' : 'normal'
          let complexity = 1
          // Probe/lookup only when the move deserves a real think and there is
          // time to spend it (planThink re-derives panic itself; checking here
          // just skips burning probe time in a scramble).
          const panicNow = startRemainingMs < Math.max(15_000, 8 * incrementMs)
          if (!panicNow && instant === null) {
            // Move 1 is theory by definition (the openings table only starts
            // AFTER the first move; persona books also cover it in main).
            let theory = fullmoveOf(fen) === 1
            if (!theory) {
              try {
                theory = (await window.api?.openings.lookup(fen))?.opening != null
              } catch {
                theory = false // lookup failure = just not theory
              }
              if (cancelled) return
            }
            if (theory) {
              cls = 'book'
            } else {
              probe = await runComplexityProbe(fen)
              if (cancelled) return
              complexity = complexityMultiplier(
                signalsFromProbe(probe, lastProbeRef.current, prevMove?.uci ?? null)
              )
            }
          }
          // Bill the probe/lookup against the allocation: budget from what is
          // left NOW, and enforce total latency from t0 below.
          const remainingAtPlan = Math.max(0, startRemainingMs - (performance.now() - t0))
          plan = planThink({
            remainingMs: remainingAtPlan,
            incrementMs,
            moveNumber: fullmoveOf(fen),
            materialPhase: materialPhaseFromFen(fen),
            personality: botPersonality,
            cls,
            complexity
          })
          thinkLedgerRef.current = {
            fen,
            targetRemainingMs: remainingAtPlan - plan.totalMs,
            cls: plan.cls,
            panic: plan.panic,
            complexity: plan.complexity,
            probe
          }
        }
        setDeepThink(plan.totalMs >= DEEP_THINK_MS)
      }

      // ---- 3: the real search, on a movetime slice of the allocation ----
      // (Unlimited: the original fixed budget, exactly as before.)
      const engineMs = plan
        ? Math.max(
            ENGINE_SLICE_MIN_MS,
            Math.min(
              Math.round(plan.totalMs - (performance.now() - t0) - ENGINE_OVERHEAD_MS),
              ENGINE_SLICE_MAX_MS
            )
          )
        : settings.playThinkMs

      let bestmove: string | undefined
      if (opponent.kind === 'persona') {
        const res = await window.api?.personas
          .move({
            fen,
            personaId: opponent.persona.id,
            // personas:move accepts 50..10000ms; in panic the slice is already
            // tiny (<= ~1.1s). The persona's strength collapse.
            movetimeMs: Math.max(50, Math.min(engineMs, 10_000))
          })
          .catch(() => null)
        // Same failure discipline as the maia/generic branches: a rejected or
        // empty persona reply must never stall the turn loop on 'thinking'.
        bestmove = res?.bestmove ?? randomLegalUci(fen) ?? undefined
      } else if (opponent.kind === 'maia') {
        // "Human" style: the maia net's policy head at nodes=1 IS the player.
        // The engine slice is irrelevant (a single NN eval answers in ~ms); the
        // time manager's plan still paces the REPLY below, so a Maia opponent
        // spends clock like a person instead of premoving everything.
        const res = await window.api?.engine
          .play({ fen, level: { maia: opponent.level }, limit: { kind: 'nodes', value: 1 } })
          .catch(() => null)
        bestmove = res?.bestmove ?? randomLegalUci(fen) ?? undefined
      } else {
        bestmove =
          (await chooseBotMove(
            fen,
            opponent.elo,
            async (req) => (window.api ? await window.api.engine.play(req) : null),
            engineMs,
            plan?.panic ?? false
          )) ?? undefined
      }
      if (cancelled) return

      // Never reply early: sleep out whatever the engine left of the
      // allocation. The bot's clock ticks through this: it may flag here.
      if (plan) {
        const remainderMs = plan.totalMs - (performance.now() - t0)
        if (remainderMs > 0) {
          await new Promise<void>((resolve) => {
            waitTimer = setTimeout(resolve, remainderMs)
          })
        }
        if (cancelled) return
      }

      setThinking(false)
      setDeepThink(false)
      // Game ended out-of-band while the opponent was thinking (resign, flag
      // fall mid-think, takeback re-arms via cancelled instead). Discard.
      if (savedRef.current || !bestmove) return
      const uci = bestmove
      const promo = uci.length > 4 ? ROLE_FROM_CHAR[uci[4]] : undefined
      const m = applyMove(fen, uci.slice(0, 2), uci.slice(2, 4), promo)
      if (cancelled || !m) return
      // Remember what this think expected for next turn's surprise signal
      // (null when no probe ran or the pick left the probe's candidates), and
      // retire the think ledger. This commitment is fulfilled.
      lastProbeRef.current = memoAfterMove(probe, uci)
      thinkLedgerRef.current = null
      tree.addMove(m)
      // The opponent just moved: credit its increment. `turn` here is the
      // opponent's color (we only enter this branch when it's their move).
      clock.addIncrement(turn)
      playMove(m)
      const out = outcome(m.fen)
      if (out.over && out.result) void finishGame(out.result, out.reason ?? 'draw')
    })().catch(() => {
      // A mid-game engine failure (probe/play IPC rejection, e.g. the engine
      // process died) must never become an unhandled rejection that leaves
      // "thinking…" stuck on forever; clear the indicators and let the user
      // retry/resign. Start-time availability is guarded in startGame.
      if (!cancelled) {
        setThinking(false)
        setDeepThink(false)
      }
    })

    return () => {
      cancelled = true
      if (waitTimer !== undefined) clearTimeout(waitTimer)
      // Clear the indicators on every re-run/unmount: browsing history (or a
      // takeback) mid-think re-fires this effect straight into its `!atTip` /
      // user-turn early returns, which otherwise left "thinking" stuck on.
      setThinking(false)
      setDeepThink(false)
    }
    // clock/timeControl/settings are read imperatively on purpose: the ticking
    // clock must not re-arm the think loop every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, phase, userColor, opponent, atTip, botPersonality])

  const commit = useCallback(
    (orig: string, dest: string, promotion?: Role) => {
      const m = applyMove(fen, orig, dest, promotion)
      if (!m) {
        setNonce((n) => n + 1) // illegal: re-sync board to truth
        return
      }
      tree.addMove(m)
      // Credit the increment to the side that just moved.
      clock.addIncrement(turnColor(fen))
      playMove(m)
      // Over-the-board auto-flip: spin the board to face whoever is now on move
      // (m.fen's side to move) so the next player looks at their own pieces.
      if (opponent.kind === 'human' && opponent.autoFlip) setOrientation(turnColor(m.fen))
      const out = outcome(m.fen)
      if (out.over && out.result) void finishGame(out.result, out.reason ?? 'draw')
      // else (vs engine/persona): the fen change re-triggers the opponent-reply effect.
    },
    [fen, tree, finishGame, playMove, clock, opponent]
  )

  const onMove = useCallback(
    (orig: Key, dest: Key) => {
      if (isPromotion(fen, orig, dest)) {
        // Auto-queen skips the picker entirely (settings.autoQueen).
        if (settings.autoQueen) commit(orig, dest, 'queen')
        else setPendingPromo({ orig, dest })
      } else commit(orig, dest)
    },
    [fen, commit, settings.autoQueen]
  )

  const onPromo = useCallback(
    (role: Role) => {
      if (pendingPromo) commit(pendingPromo.orig, pendingPromo.dest, role)
      setPendingPromo(null)
    },
    [pendingPromo, commit]
  )

  const onPromoCancel = useCallback(() => {
    setPendingPromo(null)
    setNonce((n) => n + 1)
  }, [])

  const startGame = useCallback(
    async (spec: StartSpec) => {
    // Resolve the opponent now so an in-progress game ignores later setup edits.
    const otb = spec.kind === 'otb'
    // Every non-OTB opponent here runs on the main-process Stockfish. While the
    // dataset is missing the Bot section is already showing the install CTA in
    // place of Start, so just refuse to dead-end.
    if (!otb && engineMissing) return
    const resolved: Opponent =
      spec.kind === 'otb'
        ? {
            kind: 'human',
            whiteName: spec.whiteName.trim() || 'White',
            blackName: spec.blackName.trim() || 'Black',
            autoFlip: spec.autoFlip
          }
        : spec.kind === 'persona'
          ? // Present (and rate) the persona at its honest modern strength when
            // the catalog provides one; peakElo otherwise.
            { kind: 'persona', persona: spec.persona, elo: spec.persona.modernElo ?? spec.persona.peakElo }
          : spec.kind === 'maia'
            ? // Human style: the selected maia net; its nominal band doubles as
              // the rating/display elo (measuredElo passes 'maia' through).
              { kind: 'maia', level: spec.level, elo: spec.level }
            : { kind: 'engine', elo: spec.elo }
    setOpponent(resolved)
    setLastSpec(spec)

    // Freeze the time control for this game so later setup edits don't apply.
    setTimeControl(spec.tc)

    // OTB always opens with White on move and the board White-side-up (auto-flip
    // then spins it per move); vs engine/persona uses the picked/rolled color.
    const c: Color = otb
      ? 'white'
      : spec.color === 'random'
        ? Math.random() < 0.5
          ? 'white'
          : 'black'
        : (spec.color as Color)
    setUserColor(c)
    setOrientation(c)
    savedRef.current = false
    lastProbeRef.current = null
    thinkLedgerRef.current = null
    setBanner(null)
    setPendingPromo(null)
    setThinking(false)
    setDeepThink(false)
    // OTB never touches the engine; only arm the play instance for bot games.
    // A rejected spawn (fresh install / broken binary) must NOT dead-end the
    // click as an unhandled rejection with no board and no error (the audit
    // CRITICAL): stay on setup and surface the install CTA instead.
    if (!otb) {
      try {
        await window.api?.engine.newGame('play')
      } catch (e) {
        setEngineStartError(e instanceof Error ? e.message : String(e))
        recheckEngine()
        return
      }
    }
    tree.reset(INITIAL_FEN)
    // Bump the game key so the clock resets to base time (even for an unchanged
    // control). Unlimited is a no-op clock. The hook parks itself.
    setGameKey((k) => k + 1)
    setPhase('game')
    play('gameStart')
    // vs engine/persona: the fen effect fires; if the user is Black, the
    // opponent replies as White. OTB: the effect early-returns (no bot).
    },
    [tree, play, engineMissing, recheckEngine]
  )

  const onResign = useCallback(() => {
    if (over) return
    // OTB: the player on move resigns (the button belongs to whoever's turn it
    // is). vs engine/persona: the user resigns.
    const loser: Color = opponent.kind === 'human' ? liveTurn : userColor
    const result: GameResult = loser === 'white' ? '0-1' : '1-0'
    void finishGame(result, 'resignation')
  }, [over, userColor, liveTurn, opponent, finishGame])

  // ---- Takeback (settings.allowTakebacks) ----------------------------------
  // Takes back a full move pair from the LIVE tip: the user's last move plus
  // the bot's reply when it already landed (n=2); if the bot is still thinking
  // only the user's move exists, so n=1, and the tree change re-runs the reply
  // effect, whose teardown cancels the in-flight reply (an already-searching
  // engine result is discarded via the `cancelled` guard). Repeatable, one pair
  // per click. CLOCK POLICY: no refund. Thinking time stays spent and earned
  // increments stay banked (per-move spend isn't tracked anywhere cheap, and
  // useChessClock exposes no rewind; this mirrors casual OTB takebacks).
  // OTB takes back a single ply (whoever just moved); vs engine/persona takes a
  // full user+bot pair (see below). Both need at least one move on the board.
  const otbGame = opponent.kind === 'human'
  const takebackFloor = otbGame ? 1 : userColor === 'white' ? 1 : 2
  const canTakeback = !over && liveTip.ply >= takebackFloor
  const onTakeback = useCallback(() => {
    if (savedRef.current) return // banner up / result recorded, too late
    let tip = tree.root
    while (tip.children[0]) tip = tip.children[0]
    if (otbGame) {
      // Pass-and-play: undo just the last move; auto-flip back to that mover so
      // they retry from their own view.
      if (tip.ply < 1) return
      tree.undoPlies(1)
      if (opponent.kind === 'human' && opponent.autoFlip) {
        // After removing one ply the new tip's side to move is the player who
        // just took their move back.
        let nt = tree.root
        while (nt.children[0]) nt = nt.children[0]
        setOrientation(turnColor(nt.fen))
      }
      setPendingPromo(null)
      return
    }
    if (tip.ply < (userColor === 'white' ? 1 : 2)) return // no user move yet
    // Ply parity: odd plies are White's moves. If the last mainline move is the
    // user's, the bot hasn't replied (it's mid-think): take 1; else take 2.
    const lastIsUser = (tip.ply % 2 === 1) === (userColor === 'white')
    tree.undoPlies(lastIsUser ? 1 : 2)
    // Expectations/commitments refer to a line that no longer exists. Clearing
    // the ledger matters doubly: replaying into the SAME fen after a takeback
    // must be a fresh think, not a resume against a stale deadline.
    lastProbeRef.current = null
    thinkLedgerRef.current = null
    setPendingPromo(null)
  }, [tree, userColor, otbGame, opponent])

  const onFlip = useCallback(() => setOrientation((o) => (o === 'white' ? 'black' : 'white')), [])

  const onNewGame = useCallback(() => {
    setPhase('setup')
    setBanner(null)
    setPendingPromo(null)
    setThinking(false)
    setDeepThink(false)
  }, [])

  // A live online game outranks everything: the store survives navigation, so
  // returning to Play with a game running has to land on the board. The lobby
  // half of OnlineTab is never reached from here; this page draws that.
  if (online.phase === 'game') return <OnlineTab />

  if (phase === 'setup') {
    return (
      <PlaySetup
        onStart={(spec) => void startGame(spec)}
        engineMissing={engineMissing}
        onOpenSettings={onOpenSettings}
        onOpenFamousGame={onOpenFamousGame}
        onNavigate={onNavigate}
      />
    )
  }

  // OTB has no "you": show a color-named headline ("White wins") and a neutral
  // win/draw accent. vs engine/persona keeps the from-the-user's-seat outcome.
  const otbBannerTitle =
    banner == null
      ? undefined
      : banner.result === '1/2-1/2'
        ? 'Draw'
        : banner.result === '1-0'
          ? `${whiteName} wins`
          : `${blackName} wins`
  const gameBanner: GameViewBanner | null = banner
    ? {
        result: banner.result,
        reason: banner.reason,
        outcomeForUser: isOtb
          ? banner.result === '1/2-1/2'
            ? 'draw'
            : 'win'
          : outcomeForUser(banner.result, userColor),
        title: isOtb ? otbBannerTitle : undefined,
        delta: banner.delta,
        newRating: banner.newRating
      }
    : null

  // OTB maps the two chips to BOARD SIDES (bottom = orientation color), so a
  // flip (manual or auto) keeps each name/clock beside its own pieces. The
  // side to move is resolved separately (GameView's `otb` flag makes the board
  // movable for `turn`, not for a fixed color). vs engine/persona keeps the
  // classic user-at-bottom mapping.
  const bottomColor: Color = isOtb ? orientation : userColor
  const topColor: Color = bottomColor === 'white' ? 'black' : 'white'

  // Personas are billed at their modern strength estimate (the elo captured at
  // game start), which the "~" flags as approximate. Sub-floor engine levels
  // show their MEASURED strength (shared/botStrength calibration) next to the
  // selected level: the number the rating update actually uses.
  const opponentSub = isOtb
    ? topColor === 'white'
      ? 'White'
      : 'Black'
    : opponent.kind === 'persona'
      ? `~${oppElo} Elo · modern strength`
      : opponent.kind === 'maia'
        ? `plays like a ~${oppElo} human`
        : opponent.elo < ENGINE_ELO_FLOOR
          ? `Level ${opponent.elo} · plays ~${measuredElo({ kind: 'engine', elo: opponent.elo })} Elo`
          : `${oppElo} Elo`
  const opponentStyleLine = opponent.kind === 'persona' ? `in the style of ${opponent.persona.name}` : undefined

  const clockLive = clock.active && !over
  // Highlight follows liveTurn (the side actually ticking), so browsing history
  // never shows the wrong clock as running.
  const topClock = {
    ms: clock.times[topColor],
    active: clockLive && liveTurn === topColor
  }
  const bottomClock = {
    ms: clock.times[bottomColor],
    active: clockLive && liveTurn === bottomColor
  }

  // Chip identity per side. OTB uses the two player names + a pawn glyph avatar;
  // vs engine/persona keeps the user avatar on the bottom and the opponent
  // (Stockfish/persona) up top.
  const bottomName = isOtb ? (bottomColor === 'white' ? whiteName : blackName) : settings.username
  const topName = isOtb ? (topColor === 'white' ? whiteName : blackName) : oppName

  return (
    <GameView
      otb={isOtb}
      fen={fen}
      orientation={orientation}
      turn={turn}
      userColor={bottomColor}
      dests={dests}
      lastMove={lastMove}
      check={check}
      thinking={thinking}
      over={over}
      atTip={atTip}
      pendingPromo={pendingPromo}
      nonce={nonce}
      boardTheme={settings.boardTheme}
      pieceSetClass={pieceSetClass(settings.pieceSet)}
      showLegal={settings.showLegal}
      coordinates={settings.coordinates}
      animation={settings.animation}
      deepThink={deepThink}
      allowTakebacks={settings.allowTakebacks}
      canTakeback={canTakeback}
      onTakeback={onTakeback}
      userName={bottomName}
      userAvatar={isOtb ? null : settings.avatar}
      opponentName={topName}
      opponentSub={opponentSub}
      opponentStyleLine={opponentStyleLine}
      opponentPhoto={opponent.kind === 'persona' ? opponent.persona.photo : null}
      clockActive={clock.active}
      opponentClock={topClock}
      userClock={bottomClock}
      confirmResign={settings.confirmResign}
      // No engine assistance or coach in Over-the-board play.
      hintsEnabled={isOtb ? false : settings.hintsEnabled}
      tree={tree}
      banner={gameBanner}
      onMove={onMove}
      onPromo={onPromo}
      onPromoCancel={onPromoCancel}
      onResign={onResign}
      onNewGame={onNewGame}
      onFlip={onFlip}
      // Rematch replays the spec this game was started from: same opponent and
      // time control; a 'random' colour choice re-rolls (standard rematch
      // semantics).
      onRematch={lastSpec ? () => void startGame(lastSpec) : undefined}
      onAnalyze={
        banner?.gameId != null && onAnalyzeGame
          ? () => onAnalyzeGame(banner.gameId as number)
          : undefined
      }
    />
  )
}

export default PlayView
