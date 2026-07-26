import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { Key } from 'chessground/types'
import type { Role } from 'chessops/types'
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
import { Coach, LessonChromeProvider, Scene, Turn, type BoardEnv } from './SchoolScene'
import { EMPTY_DESTS, ROLE_FROM_CHAR, isPromoMove } from './segments'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

/** review:run is single-flight in the main process; a concurrent review rejects
 *  with "review:run: a review is already in progress" (Electron wraps the message,
 *  so match by substring). Anything else is a real failure. Don't wait on it. */
function isReviewBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('already in progress')
}

/** How long to wait for the shared review engine before giving up on the score.
 *  A depth-16 full-game Analysis review can take minutes, so waiting beats
 *  throwing a played game away and asking for another one. */
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
 * accuracy and that accuracy sets an INTERNAL estimated Elo
 * (school:recordPlacementGame) which unlocks chapters up to that band. The Elo
 * number is NEVER shown. The result screen is purely qualitative. A second game
 * can be played to refine.
 *
 * A game that cannot be reviewed produces NO placement. There is no fallback
 * accuracy: an unmeasured number would still set the estimate and decide which
 * chapters open, so the result screen says the game could not be scored and asks
 * for another one.
 *
 * The game itself is the lesson page with no lesson around it: the same board,
 * the same boardbar, the same Viktor. The three screens either side of it are a
 * head, a coach panel and a foot, which is how every boardless School screen is
 * built.
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
    [
      settings.boardTheme,
      settings.pieceSet,
      settings.coordinates,
      settings.animation,
      settings.showLegal
    ]
  )

  const userColor: Color = 'white'

  const [phase, setPhase] = useState<Phase>('intro')
  // Engine availability guard (fresh install: no Stockfish on disk). Probed on
  // the intro screen and again on the result screen: same pattern as
  // Play/Analysis (v1.1.4). Without it the placement game dead-ends: the engine
  // reply loop silently never answers, so the learner sits on "thinking…"
  // forever with the whole School locked behind placement. Navigating to
  // Settings and back remounts this flow, so finishing the download is picked up
  // on return; the result screen re-probes because a game that could not be
  // scored has to say whether a missing engine is the reason.
  const { ready: engineReady } = useEngineReady(phase === 'intro' || phase === 'done')
  const [fen, setFen] = useState(START_FEN)
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>(undefined)
  const [thinking, setThinking] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [scoreNote, setScoreNote] = useState<string>('')
  // Did the finished game actually set a starting point? A game we could not
  // measure sets nothing, and the result screen says so instead of pretending.
  const [placed, setPlaced] = useState(false)

  const movesRef = useRef<MoveLog[]>([])
  const finishedRef = useRef(false)

  const dests = useMemo(() => (phase === 'playing' ? destsFor(fen) : EMPTY_DESTS), [phase, fen])
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
          // dropping a played game; any other error gives up at once, and then the
          // placement simply does not happen.
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
              setScoreNote('I am waiting for the analysis board to free up.')
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

      // No accuracy means no measurement, and a placement is a measurement. An
      // invented number here would set the internal Elo and therefore which
      // chapters open, so nothing is recorded and the learner is told plainly.
      if (accuracy == null) {
        setPlaced(false)
        setScoreNote(
          userMoves === 0
            ? 'There was no game there to weigh. I set nothing on nothing.'
            : 'I could not review that game, so I have set nothing.'
        )
        setPhase('done')
        return
      }

      try {
        // The state that comes back IS the proof it was recorded. Without it
        // (no bridge, a rejected write) the placement did not happen, and the
        // result screen must not say it did.
        const saved = await api?.school?.recordPlacementGame({ engineElo, accuracy, moveCount })
        setPlaced(Boolean(saved?.placed))
        setScoreNote(
          saved?.placed
            ? 'I have weighed your play and set where you begin.'
            : 'I weighed the game, but nothing was saved.'
        )
      } catch {
        setPlaced(false)
        setScoreNote('I weighed the game, but nothing was saved.')
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
      const uci = await chooseBotMove(before, engineElo, (req) =>
        engine.play(req).catch(() => null)
      )
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

  const head = (title: string, note: string): JSX.Element => (
    <div className="sch-head">
      <div className="lbl">Placement</div>
      <h1 className="sch-title">{title}</h1>
      <p className="sec-note">{note}</p>
    </div>
  )

  // -------- INTRO --------
  if (phase === 'intro') {
    return (
      <div className="col-single">
        {head(
          'First, a game with Viktor’s champion',
          'Play one game as White. Viktor watches how you handle it and sets where your studies begin. There is no pass or fail, just an honest starting point. You can move up any time by passing a chapter’s test.'
        )}
        <section className="sec">
          <Coach
            said={[
              'I do not want your rating from another site. I want to see you play. One game, and I will know where to start you.'
            ]}
          >
            {engineReady === false && (
              // Fresh install: no Stockfish on disk. Same install CTA as
              // Play/Analysis instead of a game that dead-ends on "thinking…".
              <EngineRequiredNotice context="placement" onOpenSettings={onOpenSettings} />
            )}
          </Coach>
        </section>
        {engineReady !== false && (
          <div className="lesson-foot">
            <p className="foot-note">One game. It takes as long as it takes.</p>
            <button
              className="btn is-primary"
              type="button"
              onClick={startGame}
              disabled={engineReady === null}
            >
              Begin the game
            </button>
          </div>
        )}
      </div>
    )
  }

  // -------- SCORING --------
  if (phase === 'scoring') {
    return (
      <div className="col-single" aria-busy="true">
        {head(
          'Viktor is reviewing your game',
          'Weighing each move against the best continuation.'
        )}
        <section className="sec">
          <Coach said={scoreNote ? [scoreNote] : []} thinking={!scoreNote} />
        </section>
      </div>
    )
  }

  // -------- DONE, BUT NOTHING WAS SET --------
  // The game could not be measured, so no placement exists. Say that, say what
  // to do about it, and offer no door into a school that is still locked.
  if (phase === 'done' && !placed) {
    return (
      <div className="col-single">
        {head(
          'That game could not be scored',
          'Placement sets where you begin by weighing your moves against the best ones. This game was never weighed, so nothing has been set.'
        )}
        <section className="sec">
          <Coach
            said={[
              scoreNote,
              'I will not guess a level for you. A guess starts you in the wrong chapters, and you would feel it in the first lesson.',
              'Play one more game. That is all I need.'
            ]}
          >
            {engineReady === false && (
              <EngineRequiredNotice context="placement" onOpenSettings={onOpenSettings} />
            )}
          </Coach>
        </section>
        {engineReady !== false && (
          <div className="lesson-foot">
            <p className="foot-note">The school opens once one game has been scored.</p>
            <button
              className="btn is-primary"
              type="button"
              onClick={() => {
                setScoreNote('')
                startGame()
              }}
              disabled={engineReady === null}
            >
              Play the game again
            </button>
          </div>
        )}
      </div>
    )
  }

  // -------- DONE --------
  if (phase === 'done') {
    return (
      <div className="col-single">
        {head('Your school is ready', 'Placement is done, and it is only a starting point.')}
        <section className="sec">
          <Coach said={[scoreNote]} />
        </section>
        <div className="lesson-foot">
          <button
            className="btn is-quiet"
            type="button"
            onClick={() => {
              setScoreNote('')
              startGame()
            }}
          >
            Play another to refine
          </button>
          <button className="btn is-primary" type="button" onClick={onPlaced}>
            Enter the school
          </button>
        </div>
      </div>
    )
  }

  // -------- PLAYING --------
  const chrome = {
    head: (
      <div className="sch-head board-under">
        <div className="lbl">Placement</div>
        <h1 className="sch-title">One game, as White</h1>
        <p className="sec-note">
          Viktor is not scoring the result. He is watching how you choose your moves.
        </p>
      </div>
    ),
    side: null,
    trace: null
  }

  return (
    <LessonChromeProvider chrome={chrome}>
      <Scene
        env={env}
        board={
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
        }
        turn={<Turn color={turn} note={thinking ? 'thinking' : undefined} />}
        actions={
          <button className="btn is-quiet" type="button" onClick={resign}>
            Resign and place me
          </button>
        }
        said={['Play your game. I am watching how you think. There is no wrong place to begin.']}
        moves={{ startFen: START_FEN, sans: movesRef.current.map((m) => m.san) }}
      />
    </LessonChromeProvider>
  )
}

export default PlacementFlow
