import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { Key } from 'chessground/types'
import type { Role } from 'chessops/types'
import { ChevronRight, Flag, GraduationCap, Loader2 } from 'lucide-react'
import { Board } from '../../board/Board'
import { pieceSetClass } from '../../board/pieceSets'
import { useSettings } from '../../state/settings'
import {
  applyMove,
  checkColor,
  destsFor,
  outcome,
  pvToSan,
  turnColor,
  uciToLastMove,
  type Color
} from '../../chess/chess'
import { chooseBotMove } from '../../chess/botStrength'
import { useEngineReady } from '../../hooks/useEngineReady'
import { EngineRequiredNotice } from '../../components/EngineRequiredNotice'
import { ViktorPanel } from './ViktorPanel'
import {
  EMPTY_DESTS,
  MoveStrip,
  ROLE_FROM_CHAR,
  isPromoMove,
  type BoardEnv
} from './segments'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

/** review:run is single-flight in the main process; a concurrent review rejects
 *  with "review:run: a review is already in progress" (Electron wraps the message,
 *  so match by substring). Anything else is a real failure. Don't wait on it. */
function isReviewBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('already in progress')
}

/** How long to wait for the shared review engine before placing conservatively.
 *  A depth-16 full-game Analysis review can take minutes, so waiting beats
 *  silently misplacing the learner at the fallback accuracy. */
const REVIEW_BUSY_WAIT_MS = 150_000
const REVIEW_BUSY_POLL_MS = 5_000

type Phase = 'intro' | 'playing' | 'scoring' | 'done'

interface MoveLog {
  fenBefore: string
  uci: string
  san: string
  byUser: boolean
}

/**
 * Placement game. The user plays ONE full game as White against a fixed
 * calibration engine level; when it ends, the game is reviewed for the user's
 * accuracy and that accuracy sets an INTERNAL estimated Elo (school:recordPlacementGame)
 * which unlocks chapters up to that band. The Elo number is NEVER shown. The
 * result screen is purely qualitative. A second game can be played to refine.
 *
 * All hooks run before any early return (React #300 guard).
 */
export function PlacementFlow({
  engineElo,
  onPlaced,
  onOpenSettings
}: {
  engineElo: number
  onPlaced: () => void
  /** Deep link to Settings → Datasets (the engine-required notice's CTA). */
  onOpenSettings?: () => void
}): JSX.Element {
  const { settings } = useSettings()
  const env: BoardEnv = useMemo(
    () => ({
      boardClass: `board-wrap board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`,
      coordinates: settings.coordinates,
      animation: settings.animation,
      showDests: settings.showLegal
    }),
    [settings.boardTheme, settings.pieceSet, settings.coordinates, settings.animation, settings.showLegal]
  )

  const userColor: Color = 'white'

  const [phase, setPhase] = useState<Phase>('intro')
  // Engine availability guard (fresh install: no Stockfish on disk). Probed on
  // the intro screen: same pattern as Play/Analysis (v1.1.4). Without it the
  // placement game dead-ends: the engine reply loop silently never answers, so
  // the learner sits on "thinking…" forever with the whole School locked
  // behind placement. Navigating to Settings and back remounts this flow, so
  // finishing the download is picked up on return.
  const { ready: engineReady } = useEngineReady(phase === 'intro')
  const [fen, setFen] = useState(START_FEN)
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>(undefined)
  const [thinking, setThinking] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [scoreNote, setScoreNote] = useState<string>('')

  const movesRef = useRef<MoveLog[]>([])
  const finishedRef = useRef(false)

  const dests = useMemo(
    () => (phase === 'playing' ? destsFor(fen) : EMPTY_DESTS),
    [phase, fen]
  )
  const turn = useMemo(() => turnColor(fen), [fen])
  const check = useMemo(() => checkColor(fen), [fen])

  const pushMove = useCallback(
    (fenBefore: string, uci: string, san: string, byUser: boolean) => {
      movesRef.current.push({ fenBefore, uci, san, byUser })
    },
    []
  )

  // Build a PGN, review it for the user's accuracy, and record the placement.
  const scoreGame = useCallback(
    async (resultToken: string) => {
      setPhase('scoring')
      const userMoves = movesRef.current.filter((m) => m.byUser).length
      const moveCount = Math.max(1, userMoves)
      const api = window.api
      let accuracy: number | null = null

      try {
        const sans = pvToSan(
          START_FEN,
          movesRef.current.map((m) => m.uci),
          movesRef.current.length
        )
        if (sans.length > 0 && api?.review) {
          const movetext = sans
            .map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san))
            .join(' ')
          const pgn = `[Event "Placement"]\n[White "You"]\n[Black "Viktor's champion"]\n[Result "${resultToken}"]\n\n${movetext} ${resultToken}\n`
          // review:run is single-flight and a full-game Analysis review can run for
          // minutes. While the engine is BUSY, keep waiting (and say so) rather than
          // silently misplacing the learner at the conservative fallback; any other
          // error falls through to the fallback immediately.
          let reviewed: Awaited<ReturnType<NonNullable<typeof api.review>['run']>> | null = null
          const busyDeadline = Date.now() + REVIEW_BUSY_WAIT_MS
          for (;;) {
            try {
              reviewed = await api.review.run({ pgn })
              break
            } catch (err) {
              if (!isReviewBusyError(err) || Date.now() + REVIEW_BUSY_POLL_MS > busyDeadline) {
                break
              }
              setScoreNote('Viktor is waiting for the analysis board to free up…')
              await new Promise((res) => setTimeout(res, REVIEW_BUSY_POLL_MS))
            }
          }
          setScoreNote('')
          if (reviewed) {
            const side = userColor === 'white' ? reviewed.review.white : reviewed.review.black
            if (side && side.moves > 0) accuracy = side.accuracy
          }
        }
      } catch {
        accuracy = null
      }

      // Fallback: if the game couldn't be reviewed (no engine / too short), place
      // conservatively so the foundation unlocks and the learner can test upward.
      const acc = accuracy ?? 52
      try {
        await api?.school?.recordPlacementGame({ engineElo, accuracy: acc, moveCount })
        setScoreNote(
          accuracy == null
            ? 'Viktor has set a starting point. Pass a chapter test any time to move up.'
            : 'Viktor has weighed your play and set where you begin.'
        )
      } catch {
        setScoreNote('Viktor has set a starting point.')
      }
      setPhase('done')
    },
    [engineElo, userColor]
  )

  const commitUser = useCallback(
    (orig: string, dest: string, promo?: Role) => {
      const before = fen
      const applied = applyMove(before, orig, dest, promo)
      if (!applied) {
        setNonce((n) => n + 1)
        return
      }
      pushMove(before, applied.uci, applied.san, true)
      setFen(applied.fen)
      setLastMove(uciToLastMove(applied.uci))
      const out = outcome(applied.fen)
      if (out.over && !finishedRef.current) {
        finishedRef.current = true
        void scoreGame(out.result ?? '1/2-1/2')
      }
    },
    [fen, pushMove, scoreGame]
  )

  const onUserMove = useCallback(
    (orig: Key, dest: Key) => {
      if (phase !== 'playing' || turn !== userColor) return
      const promo: Role | undefined = isPromoMove(fen, orig, dest) ? 'queen' : undefined
      commitUser(orig, dest, promo)
    },
    [phase, turn, userColor, fen, commitUser]
  )

  // Engine reply loop: runs on the bot's turn.
  useEffect(() => {
    if (phase !== 'playing') return
    if (turn === userColor) return
    if (finishedRef.current) return
    const out = outcome(fen)
    if (out.over) {
      finishedRef.current = true
      void scoreGame(out.result ?? '1/2-1/2')
      return
    }
    const engine = window.api?.engine
    if (!engine) return

    let cancelled = false
    setThinking(true)
    ;(async () => {
      const before = fen
      const uci = await chooseBotMove(before, engineElo, (req) => engine.play(req).catch(() => null))
      if (cancelled) return
      setThinking(false)
      if (finishedRef.current || !uci) return
      const promo = uci.length > 4 ? ROLE_FROM_CHAR[uci[4]] : undefined
      const applied = applyMove(before, uci.slice(0, 2), uci.slice(2, 4), promo)
      if (!applied) return
      pushMove(before, applied.uci, applied.san, false)
      setFen(applied.fen)
      setLastMove(uciToLastMove(applied.uci))
      const after = outcome(applied.fen)
      if (after.over && !finishedRef.current) {
        finishedRef.current = true
        void scoreGame(after.result ?? '1/2-1/2')
      }
    })()

    return () => {
      cancelled = true
      // The cancelled path above skips setThinking(false): clear it here so
      // "thinking…" can't outlive the game (e.g. resign mid-think, next game).
      setThinking(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, phase, engineElo])

  const startGame = useCallback(() => {
    movesRef.current = []
    finishedRef.current = false
    setFen(START_FEN)
    setLastMove(undefined)
    setNonce((n) => n + 1)
    void window.api?.engine?.newGame('play')
    setPhase('playing')
  }, [])

  const resign = useCallback(() => {
    if (phase !== 'playing' || finishedRef.current) return
    finishedRef.current = true
    void scoreGame('0-1')
  }, [phase, scoreGame])

  // -------- INTRO --------
  if (phase === 'intro') {
    return (
      <div className="placement">
        <div className="placement-hero">
          <span className="placement-eyebrow">
            <GraduationCap size={16} /> Placement
          </span>
          <h1 className="placement-title">First, a game with Viktor’s champion</h1>
          <p className="placement-lede">
            Play one game as White. Viktor watches how you handle it and sets where your studies
            begin. There is no pass or fail, just an honest starting point. You can move up any
            time by passing a chapter’s test.
          </p>
          {engineReady === false ? (
            // Fresh install: no Stockfish on disk. Same install CTA as
            // Play/Analysis instead of a game that dead-ends on "thinking…".
            <EngineRequiredNotice context="placement" onOpenSettings={onOpenSettings} />
          ) : (
            <button
              className="btn school-primary placement-cta"
              onClick={startGame}
              disabled={engineReady === null}
            >
              Begin the game <ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>
    )
  }

  // -------- SCORING --------
  if (phase === 'scoring') {
    return (
      <div className="placement">
        <div className="placement-hero">
          <span className="placement-eyebrow">
            <Loader2 size={16} className="spin" /> Assessing
          </span>
          <h1 className="placement-title">Viktor is reviewing your game…</h1>
          <p className="placement-lede">Weighing each move against the best continuation.</p>
          {scoreNote && <p className="muted small">{scoreNote}</p>}
        </div>
      </div>
    )
  }

  // -------- DONE --------
  if (phase === 'done') {
    return (
      <div className="placement">
        <div className="placement-hero">
          <span className="placement-eyebrow">
            <GraduationCap size={16} /> Placement complete
          </span>
          <h1 className="placement-title">Your school is ready</h1>
          <p className="placement-lede">{scoreNote}</p>
          <div className="placement-actions">
            <button className="btn school-primary placement-cta" onClick={onPlaced}>
              Enter the school <ChevronRight size={16} />
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                setScoreNote('')
                startGame()
              }}
            >
              Play another to refine
            </button>
          </div>
        </div>
      </div>
    )
  }

  // -------- PLAYING --------
  return (
    <div className="school-stage">
      <div className="school-board-col">
        <div className={env.boardClass}>
          <Board
            fen={fen}
            orientation={userColor}
            turnColor={turn}
            dests={dests}
            movableColor={userColor}
            lastMove={lastMove}
            check={check}
            showDests={env.showDests}
            coordinates={env.coordinates}
            animation={env.animation}
            onMove={onUserMove}
            syncNonce={nonce}
          />
        </div>
        <MoveStrip startFen={START_FEN} sans={movesRef.current.map((m) => m.san)} />
        <div className="school-board-controls">
          <button className="btn ghost" onClick={resign}>
            <Flag size={16} /> Resign &amp; place me
          </button>
          {thinking && <span className="muted small">Viktor’s champion is thinking…</span>}
        </div>
      </div>

      <ViktorPanel
        text="Play your game. I am watching how you think. There is no wrong place to begin."
        eyebrow="Placement"
        silent={false}
      >
        <div className="school-boss-facts">
          <span className="muted small">You play White</span>
        </div>
      </ViktorPanel>
    </div>
  )
}

export default PlacementFlow
