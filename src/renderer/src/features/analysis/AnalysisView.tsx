import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Role } from 'chessops/types'
import type { Key } from 'chessground/types'
import type { DrawShape } from 'chessground/draw'
import type { GameReview, GameRow, ReviewMoveEval, ReviewProgress } from '@shared/types'
import { Board } from '../../board/Board'
import { PromotionPicker } from '../../board/PromotionPicker'
import { pieceSetClass } from '../../board/pieceSets'
import { useReadoutSlot } from '../../components/Layout'
import { useSound } from '../../sound'
import { EngineSection, LINE_COUNTS } from './EngineSection'
import { ReviewSection } from './ReviewSection'
import { MoveNote } from './MoveNote'
import { MovesSection } from './MovesSection'
import { GameLibrary } from './GameLibrary'
import { detailToPgn } from './famousData'
import { AnnotationsLayer } from './AnnotationsLayer'
import { useAnnotations } from './annotations'
import { parsePgnToGame, type LoadedGame } from './shareGame'
import { isMistakeBadge, type ReviewBadge } from './badges'
import { useGameTree, type TreeNode } from '../../state/gameTree'
import { useSettings } from '../../state/settings'
import { useAnalysis } from '../../hooks/useAnalysis'
import { useEngineReady } from '../../hooks/useEngineReady'
import { useOpeningTrace } from '../../chess/openingTrace'
import { treeToPgn } from '../../state/pgn'
import {
  applyMove,
  checkColor,
  destsFor,
  isPromotion,
  outcome,
  position,
  turnColor,
  uciToLastMove,
  type AppliedMove,
  type Color
} from '../../chess/chess'
import { formatScore, toWhite, whiteWinPercent } from '../../chess/scores'
import './analysis.css'

const ROLE_FROM_CHAR: Record<string, Role> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }

/* A FEN is one line of eight rank fields. A PGN is anything else worth trying:
   the single Load field takes both, and the shape decides which error the user
   gets back when it fails. */
const FEN_SHAPE = /^(?:[pnbrqkPNBRQK1-8]+\/){7}[pnbrqkPNBRQK1-8]+(?:\s|$)/

export function AnalysisView({
  gameId,
  famousId,
  onOpenSettings
}: { gameId?: number; famousId?: string; onOpenSettings?: () => void } = {}) {
  const { settings, update: updateSettings } = useSettings()
  const { playMove } = useSound()
  const tree = useGameTree()
  const [orientation, setOrientation] = useState<Color>('white')
  const [engineOn, setEngineOn] = useState(true)
  const [multipv, setMultipv] = useState(settings.analysisMultiPV)
  // Depth cap for the live search: null is the infinite analysis this screen
  // has always run. Session state, not a preference: there is no settings key
  // for it yet (see the report).
  const [depthCap, setDepthCap] = useState<number | null>(null)
  const [figurine, setFigurine] = useState(false)
  const [pendingPromo, setPendingPromo] = useState<{ orig: string; dest: string } | null>(null)
  const [nonce, setNonce] = useState(0)
  const [loadInput, setLoadInput] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'fen' | 'pgn' | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Players/result of the currently-loaded game. The result is the only thing
  // the move list can put in its footer without inventing one.
  const [gameHeader, setGameHeader] = useState<{
    white?: string
    black?: string
    result?: string
  } | null>(null)

  // Persist the MultiPV preference so it survives navigation/restart.
  const changeMultipv = useCallback(
    (n: number) => {
      setMultipv(n)
      updateSettings({ analysisMultiPV: n })
    },
    [updateSettings]
  )

  // The retired range control could store 2 or 4; the three chips are the only
  // way in now, so a stored value they cannot show is snapped once at mount
  // rather than left running behind an unpressed control.
  useEffect(() => {
    if (!LINE_COUNTS.includes(multipv)) changeMultipv(3)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Board element (for the annotations overlay to attach right-click drawing).
  const [boardEl, setBoardEl] = useState<HTMLDivElement | null>(null)

  // Per-node user annotations (right-click arrows/circles); persist while
  // navigating the line because they are keyed by the current node id.
  const annotations = useAnnotations(tree.current.id)

  // Queue used to load a pasted game's mainline into the tree across renders
  // (gameTree.addMove advances from the rendered current node, so moves must be
  // applied one render-tick at a time).
  const loadQueue = useRef<{ moves: AppliedMove[]; index: number; expectFen: string } | null>(null)

  // Set when a game load should land on the ROOT position (move 1 about to be
  // played) once the queue drains, instead of the final position. One-shot: the
  // drain effect clears it before jumping, and every path that abandons the
  // queue (user move, new FEN) clears it so an old load can't yank the board.
  const jumpToStartRef = useRef(false)

  // ---- Review state ----
  const [review, setReview] = useState<GameReview | null>(null)
  const [reviewRunning, setReviewRunning] = useState(false)
  const [reviewProgress, setReviewProgress] = useState(0)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const reviewSeq = useRef(0)

  // The saved-game row backing the current tree, if any. Set by the gameId-prop
  // load; cleared the moment the tree departs from that stored game (new FEN,
  // pasted/famous game, or any user move) so review:run never attributes an
  // edited line to the stored game. When set, reviews run by gameId, which lets
  // the main process persist per-side accuracy on the game row and cache the
  // review for review:get.
  const [loadedGameId, setLoadedGameId] = useState<number | null>(null)

  // Drop the current review AND orphan any in-flight one: bumping the seq makes
  // a pending review:run resolve into a no-op, so a review started for game A
  // can never paint its accuracy/eval graph onto a freshly loaded game B.
  const invalidateReview = useCallback(() => {
    reviewSeq.current++
    setReview(null)
    setReviewError(null)
    setReviewRunning(false)
    setReviewProgress(0)
  }, [])

  // ---- Opening identity ----
  // Persistent trace over the current line: the deepest book hit sticks even
  // after the game leaves theory (openings-DB lookups are cached per node).
  const openingTrace = useOpeningTrace(tree)

  const fen = tree.currentFen
  const dests = useMemo(() => destsFor(fen), [fen])
  const turn = turnColor(fen)
  const check = checkColor(fen)
  const lastMove = tree.current.move ? uciToLastMove(tree.current.move.uci) : undefined
  const currentPly = tree.current.ply

  // The mainline, walked fresh every render: the tree mutates in place, so
  // anything memoized on its identity goes stale.
  const mainline: TreeNode[] = []
  for (let n = tree.root; n.children[0]; ) {
    n = n.children[0]
    mainline.push(n)
  }
  const totalMoves = Math.ceil(mainline.length / 2)
  const onMainline = mainline.length === 0 ? currentPly === 0 : mainline.some((n) => n === tree.current) || currentPly === 0
  const graphCurrentPly = onMainline ? currentPly : -1

  const { lines, stats, error: engineError } = useAnalysis(fen, engineOn, multipv, depthCap)
  // Stockfish-on-disk probe (datasets:status().engine): when the engine dataset
  // was never imported the Engine panel swaps its lines for the install CTA
  // instead of sitting at depth 0 forever.
  const { ready: engineReady } = useEngineReady(engineOn)
  const engineMissing = engineOn && engineReady === false
  const best = lines.find((l) => l.multipv === 1) ?? lines[0]
  // Null (not a confident +0.00) when the engine is off or before the first line.
  const score = best ? toWhite({ cp: best.scoreCp, mate: best.mate }, turn) : null

  // Engine top-line arrows on the board: best move is a solid green arrow, the
  // 2nd/3rd lines are progressively fainter. Re-derived as the engine streams.
  // settings.showEngineArrows hides them without touching the engine toggle.
  // The sidebar lines keep streaming, only the board arrows go away.
  const engineShapes = useMemo<DrawShape[]>(() => {
    if (!engineOn || !settings.showEngineArrows) return []
    const brushByRank = ['green', 'paleBlue', 'paleGrey'] as const
    const out: DrawShape[] = []
    for (const l of lines) {
      const uci = l.pv?.[0]
      if (!uci || uci.length < 4) continue
      const rank = (l.multipv ?? 1) - 1
      out.push({
        orig: uci.slice(0, 2) as Key,
        dest: uci.slice(2, 4) as Key,
        brush: brushByRank[Math.min(rank, brushByRank.length - 1)]
      })
    }
    return out
  }, [lines, engineOn, settings.showEngineArrows])

  // Per-ply review data for the move list. Both maps are empty without a review,
  // which is what keeps the mark and eval columns blank rather than borrowing
  // the live engine's number for a move it never looked at.
  const badges = useMemo(() => {
    const map = new Map<number, ReviewBadge>()
    if (review) for (const m of review.moveEvals) map.set(m.ply, m.badge)
    return map
  }, [review])

  const moveEvalsByPly = useMemo(() => {
    const map = new Map<number, ReviewMoveEval>()
    if (review) for (const m of review.moveEvals) map.set(m.ply, m)
    return map
  }, [review])

  const currentMoveEval: ReviewMoveEval | null = useMemo(
    () => moveEvalsByPly.get(currentPly) ?? null,
    [moveEvalsByPly, currentPly]
  )

  // Every move the review flagged, in order, and the next one after the cursor.
  const flaggedPlies = useMemo(() => {
    if (!review) return []
    return review.moveEvals.filter((m) => isMistakeBadge(m.badge)).map((m) => m.ply)
  }, [review])

  const nextMistakePly = useMemo(() => {
    if (flaggedPlies.length === 0) return null
    return flaggedPlies.find((p) => p > currentPly) ?? flaggedPlies[0]
  }, [flaggedPlies, currentPly])

  const commit = useCallback(
    (orig: string, dest: string, promotion?: Role) => {
      const m = applyMove(fen, orig, dest, promotion)
      if (m) {
        // A user move departs from any stored/loading game: the tree no longer
        // matches the saved PGN (so don't review it under the old gameId), a
        // half-drained load queue must never resume into this edited line, and
        // a pending jump-to-start must not yank the board off the user's move.
        loadQueue.current = null
        jumpToStartRef.current = false
        setLoadedGameId(null)
        tree.addMove(m)
        playMove(m)
      } else setNonce((n) => n + 1) // illegal: re-sync board to truth
    },
    [fen, tree, playMove]
  )

  const onMove = useCallback(
    (orig: string, dest: string) => {
      if (isPromotion(fen, orig, dest)) {
        // Auto-queen skips the picker entirely (settings.autoQueen).
        if (settings.autoQueen) commit(orig, dest, 'queen')
        else setPendingPromo({ orig, dest })
      } else commit(orig, dest)
    },
    [fen, commit, settings.autoQueen]
  )

  const playUci = useCallback(
    (uci: string) => {
      const promo = uci.length > 4 ? ROLE_FROM_CHAR[uci[4]] : undefined
      commit(uci.slice(0, 2), uci.slice(2, 4), promo)
    },
    [commit]
  )

  // Jump the board to the position AFTER the move at `ply`. The eval graph and
  // the mistake walk are mainline-only, so we seek by walking the mainline and
  // go to it by id (never landing on a variation node).
  const seekToPly = useCallback(
    (ply: number) => {
      let n = tree.root
      while (n.children[0] && n.ply < ply) n = n.children[0]
      tree.goTo(n.id)
    },
    [tree]
  )

  // ---- Review progress subscription (mounts once) ----
  useEffect(() => {
    const reviewApi = window.api?.review
    if (!reviewApi) return
    return reviewApi.onProgress((p: ReviewProgress) => {
      setReviewProgress(p.total > 0 ? Math.min(1, p.ply / p.total) : 0)
    })
  }, [])

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
  }, [])

  const runReview = useCallback(() => {
    const reviewApi = window.api?.review
    if (!reviewApi) {
      setReviewError('Review is unavailable.')
      return
    }
    const pgn = treeToPgn(tree.root, {})
    const seq = ++reviewSeq.current
    setReviewRunning(true)
    setReviewProgress(0)
    setReviewError(null)
    reviewApi
      // Review a stored game by id (main process pulls the stored PGN, persists
      // accuracy_white/black onto the game row and caches for review:get); a raw
      // PGN review is ephemeral.
      .run(loadedGameId != null ? { gameId: loadedGameId } : { pgn })
      .then(({ review: r }) => {
        if (reviewSeq.current !== seq) return // a newer review superseded this one
        setReview(r)
        setReviewRunning(false)
        setReviewProgress(1)
      })
      .catch(() => {
        if (reviewSeq.current !== seq) return
        setReviewRunning(false)
        setReviewError('Review failed. Please try again.')
      })
  }, [tree.root, loadedGameId])

  // Keyboard navigation (lichess-style). Skips typing/contenteditable targets and
  // modifier chords, and prevents the default scroll on the handled arrow keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t && t.isContentEditable)
      )
        return
      if (e.key === 'ArrowLeft') tree.prev()
      else if (e.key === 'ArrowRight') tree.next()
      else if (e.key === 'ArrowUp') tree.first()
      else if (e.key === 'ArrowDown') tree.last()
      else if (e.key === 'f') setOrientation((o) => (o === 'white' ? 'black' : 'white'))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tree])

  // ---- Load a pasted game into the tree (mainline) ----
  const loadGame = useCallback(
    (game: LoadedGame) => {
      tree.reset(game.startFen)
      invalidateReview()
      // Pasted/famous games have no stored row; loadSavedGame re-sets the id
      // right after calling us when the load IS a saved game.
      setLoadedGameId(null)
      setGameHeader(
        game.white || game.black || game.result
          ? { white: game.white, black: game.black, result: game.result }
          : null
      )
      // Defer move application to the queue effect: addMove must run one move
      // per render so each call sees the freshly-selected current node. Once the
      // queue drains, land on the ROOT so the game starts at move 1.
      loadQueue.current =
        game.moves.length > 0 ? { moves: game.moves, index: 0, expectFen: game.startFen } : null
      jumpToStartRef.current = game.moves.length > 0
    },
    [tree, invalidateReview]
  )

  // ---- Load a SAVED game row (the library's "Your games", or the gameId prop) ----
  // On top of loadGame: runs future reviews under the stored id, orients the
  // board to the side the user played, prefers the row's player names, and
  // hydrates a cached review instead of forcing a multi-minute re-run.
  const loadSavedGame = useCallback(
    (row: GameRow) => {
      const loaded = parsePgnToGame(row.pgn)
      if (!loaded) return
      loadGame(loaded)
      setLoadedGameId(row.id)
      const uc = row.user_color
      if (uc === 'white' || uc === 'black') setOrientation(uc)
      if (row.white_name || row.black_name || row.result) {
        setGameHeader({
          white: row.white_name ?? loaded.white,
          black: row.black_name ?? loaded.black,
          result: row.result ?? loaded.result
        })
      }
      // loadGame bumped reviewSeq; a further bump (user re-ran or loaded
      // something else meanwhile) means this stale cache read must be dropped.
      const seq = reviewSeq.current
      window.api?.review
        .get(row.id)
        .then(({ review: cached }) => {
          if (reviewSeq.current !== seq || !cached) return
          setReview(cached)
          setReviewProgress(1)
        })
        .catch(() => {})
    },
    [loadGame]
  )

  // One field, two formats. The shape of the text decides which failure the
  // user is told about; guessing would answer the wrong question.
  const loadFromInput = useCallback(() => {
    const v = loadInput.trim()
    if (!v) return
    if (FEN_SHAPE.test(v)) {
      try {
        position(v) // throws if invalid
      } catch {
        setLoadError('That is not a valid FEN.') // keep input; surface inline
        return
      }
      tree.reset(v)
      loadQueue.current = null // abandon any half-drained game load
      jumpToStartRef.current = false // ...and its pending jump-to-start
      setLoadedGameId(null) // no longer looking at a stored game
      invalidateReview() // a new position invalidates prior AND in-flight reviews
      setGameHeader(null)
      setLoadInput('')
      setLoadError(null)
      return
    }
    const game = parsePgnToGame(v)
    if (!game) {
      setLoadError('Could not read a game from that PGN.')
      return
    }
    loadGame(game)
    setLoadInput('')
    setLoadError(null)
  }, [loadInput, tree, invalidateReview, loadGame])

  const copy = useCallback((text: string, which: 'fen' | 'pgn') => {
    const clip = navigator.clipboard
    if (!clip?.writeText) return
    clip
      .writeText(text)
      .then(() => {
        setCopied(which)
        if (copyTimer.current) clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopied(null), 1400)
      })
      .catch(() => {
        /* clipboard denied: silently no-op */
      })
  }, [])

  // Drives the load queue: applies the next move once the board has settled on
  // the previously-added position. Self-terminates when the line is exhausted,
  // then jumps to the root exactly once so loaded games start at move 1 (the
  // effect runs every render; the one-shot ref keeps the jump from repeating).
  useEffect(() => {
    const q = loadQueue.current
    if (!q) {
      if (jumpToStartRef.current) {
        jumpToStartRef.current = false
        tree.goTo(tree.root.id)
      }
      return
    }
    if (tree.currentFen !== q.expectFen) return // wait for the prior addMove to land
    const m = q.moves[q.index]
    if (!m) {
      loadQueue.current = null
      return
    }
    q.index += 1
    q.expectFen = m.fen
    if (q.index >= q.moves.length) loadQueue.current = null
    tree.addMove(m)
  }, [tree])

  // ---- Open a saved game by id (clicked from Home/Progress/Continue) ----
  useEffect(() => {
    if (gameId == null) return
    const gamesApi = window.api?.games
    if (!gamesApi) return
    let cancelled = false
    gamesApi
      .get(gameId)
      .then((r) => {
        if (cancelled || !r?.game?.pgn) return
        loadSavedGame(r.game)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // Load once when the opened game id changes. loadSavedGame is intentionally
    // NOT a dependency: useGameTree returns a fresh object every render, so its
    // identity changes each render, including it here re-fired this effect on
    // every render and looped the game-load (opening + header flickering).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId])

  // ---- Open a famous game by id (persona gallery "see their famous games") ----
  // Mirrors the gameId effect above: fetch the detail, convert to PGN, parse into
  // a LoadedGame and load the mainline (same path the library clicks take).
  useEffect(() => {
    if (famousId == null) return
    const famousApi = window.api?.famous
    if (!famousApi) return
    let cancelled = false
    famousApi
      .get(famousId)
      .then((r) => {
        if (cancelled || !r?.game) return
        const loaded = parsePgnToGame(detailToPgn(r.game))
        if (loaded) loadGame(loaded)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // Load once when the opened famous id changes. loadGame is intentionally NOT
    // a dependency: same unstable-identity reason as the gameId effect above
    // (it closes over the per-render useGameTree object).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [famousId])

  const hasMoves = mainline.length > 0
  const currentPgn = useMemo(() => treeToPgn(tree.root, {}), [tree.root, tree.current.id])

  // Result of the game on the board: the loaded game's header, or a mainline
  // that actually ends in a terminal position. A freely explored line has none
  // and the move list simply has no footer.
  const tipFen = mainline.length > 0 ? mainline[mainline.length - 1].fen : tree.root.fen
  const terminal = outcome(tipFen)
  const headerResult = gameHeader?.result
  const gameResult =
    headerResult === '1-0' || headerResult === '0-1' || headerResult === '1/2-1/2'
      ? headerResult
      : (terminal.over && terminal.result) || null

  // ---- The readout's NEXT ----
  const flaggedCount = flaggedPlies.length
  const readoutNext = !hasMoves
    ? 'Paste a FEN or open a game'
    : !review
      ? 'Review the game to classify every move'
      : flaggedCount > 0
        ? `Look again at ${flaggedCount} ${flaggedCount === 1 ? 'move' : 'moves'}`
        : null
  useReadoutSlot(readoutNext, hasMoves ? Math.min(1, currentPly / mainline.length) : null)

  const leader = score
    ? (score.mate ?? score.cp ?? 0) > 0
      ? 'white'
      : (score.mate ?? score.cp ?? 0) < 0
        ? 'black'
        : 'level'
    : null
  const evalText = score ? formatScore(score) : null
  const barPercent = score ? whiteWinPercent(score) : 50
  const barLabel = score
    ? `Evaluation, ${leader === 'level' ? 'level' : leader === 'white' ? 'White' : 'Black'} ${evalText}`
    : 'Evaluation unavailable'
  const evalUnavailable =
    engineMissing || engineError != null ? 'unavailable' : engineOn ? 'thinking' : 'engine off'

  // "Move 12 of 28 · reviewed": where the board is standing in the game, and
  // whether what it is saying came from a review.
  let source: string | null = null
  if (hasMoves) {
    if (currentPly === 0) source = `Start · ${totalMoves} moves`
    else if (onMainline) source = `Move ${Math.ceil(currentPly / 2)} of ${totalMoves}`
    else source = `Move ${Math.ceil(currentPly / 2)} · variation`
    if (review) source += ' · reviewed'
  }

  return (
    <div className="lesson">
      {/* ============ THE BOARD ============ */}
      <div className="lesson-main">
        <div className={`board-area${settings.showEvalBar ? '' : ' is-nobar'}`}>
          {/* The one number this column exists to produce, on the board's own
              left edge. */}
          <div className="an-strip">
            <div className="an-plate">
              <span className="lbl">Eval</span>
              {evalText ? (
                <>
                  <span className="an-eval">{evalText}</span>
                  <span className="tag">{leader}</span>
                </>
              ) : (
                <span className="tag">{evalUnavailable}</span>
              )}
              {source && <span className="an-src">{source}</span>}
            </div>
          </div>

          <div className="board-stage">
            {settings.showEvalBar && (
              <div className="an-evalbar" role="img" aria-label={barLabel}>
                <div
                  className={`an-evalfill${orientation === 'black' ? ' is-flipped' : ''}`}
                  style={{ '--an-fill': `${barPercent.toFixed(1)}%` } as CSSProperties}
                />
                <div className="an-evalmid" />
              </div>
            )}

            <div
              ref={setBoardEl}
              className={`board-wrap board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`}
            >
              <Board
                fen={fen}
                orientation={orientation}
                turnColor={turn}
                dests={dests}
                lastMove={lastMove}
                check={check}
                shapes={engineShapes}
                showDests={settings.showLegal}
                coordinates={settings.coordinates}
                animation={settings.animation}
                onMove={onMove}
                syncNonce={nonce}
              />
              <AnnotationsLayer boardEl={boardEl} orientation={orientation} store={annotations} />
              {pendingPromo && (
                <PromotionPicker
                  color={turn}
                  onSelect={(role) => {
                    commit(pendingPromo.orig, pendingPromo.dest, role)
                    setPendingPromo(null)
                  }}
                  onCancel={() => {
                    setPendingPromo(null)
                    setNonce((n) => n + 1)
                  }}
                />
              )}
            </div>
          </div>

          <div className="an-strip">
            <div className="boardbar">
              <span className="turn">
                <span className={`turn-chip${turn === 'black' ? ' is-black' : ''}`} />
                {turn === 'white' ? 'White to move' : 'Black to move'}
              </span>
              <span className="an-nav">
                <button
                  className="key"
                  type="button"
                  title="Start"
                  aria-label="Start"
                  disabled={!tree.canPrev}
                  onClick={tree.first}
                >
                  {'|<'}
                </button>
                <button
                  className="key"
                  type="button"
                  title="Back"
                  aria-label="Back"
                  disabled={!tree.canPrev}
                  onClick={tree.prev}
                >
                  {'<'}
                </button>
                <button
                  className="key"
                  type="button"
                  title="Forward"
                  aria-label="Forward"
                  disabled={!tree.canNext}
                  onClick={tree.next}
                >
                  {'>'}
                </button>
                <button
                  className="key"
                  type="button"
                  title="End"
                  aria-label="End"
                  disabled={!tree.canNext}
                  onClick={tree.last}
                >
                  {'>|'}
                </button>
              </span>
              <span className="chips">
                <button
                  className="chip"
                  type="button"
                  aria-pressed={orientation === 'black'}
                  onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
                >
                  Flip
                </button>
                <button
                  className="chip"
                  type="button"
                  aria-pressed={engineOn}
                  onClick={() => setEngineOn((v) => !v)}
                >
                  Engine
                </button>
                <button
                  className="chip"
                  type="button"
                  aria-pressed={figurine}
                  onClick={() => setFigurine((f) => !f)}
                >
                  Figurine
                </button>
                {annotations.hasAny && (
                  <button className="chip" type="button" onClick={annotations.clear}>
                    Clear annotations
                  </button>
                )}
              </span>
            </div>
          </div>

          <div className="an-strip">
            <div className="an-under">
              <section className="sec">
                <div className="sec-head">
                  <h2 className="lbl">Position</h2>
                  <span className="sec-count">FEN</span>
                </div>
                <div className="an-fen">
                  <span className="an-fen-text">{fen}</span>
                  <button className="btn is-quiet" type="button" onClick={() => copy(fen, 'fen')}>
                    {copied === 'fen' ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    className="btn is-quiet"
                    type="button"
                    disabled={!hasMoves}
                    onClick={() => copy(currentPgn, 'pgn')}
                  >
                    {copied === 'pgn' ? 'Copied' : 'Copy PGN'}
                  </button>
                </div>
                <div className="an-load">
                  <input
                    className="filter-input"
                    type="text"
                    aria-label="Paste a FEN or a PGN"
                    placeholder="Paste a FEN or a PGN"
                    value={loadInput}
                    onChange={(e) => {
                      setLoadInput(e.target.value)
                      if (loadError) setLoadError(null)
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && loadFromInput()}
                  />
                  <button className="btn" type="button" onClick={loadFromInput}>
                    Load
                  </button>
                </div>
                {loadError && (
                  <p className="an-error" role="alert">
                    {loadError}
                  </p>
                )}
              </section>

              <GameLibrary onLoadSavedGame={loadSavedGame} onLoadGame={loadGame} />
            </div>
          </div>
        </div>
      </div>

      {/* ============ ENGINE, REVIEW, MOVES ============ */}
      <aside className="side">
        <EngineSection
          fen={fen}
          turn={turn}
          lines={lines}
          stats={stats}
          enabled={engineOn}
          depthCap={depthCap}
          multipv={multipv}
          showArrows={settings.showEngineArrows}
          figurine={figurine}
          engineMissing={engineMissing}
          error={engineError}
          onDepthCap={setDepthCap}
          onMultipv={changeMultipv}
          onToggleArrows={() => updateSettings({ showEngineArrows: !settings.showEngineArrows })}
          onStop={() => setEngineOn(false)}
          onPlayUci={playUci}
          onOpenSettings={onOpenSettings}
        />

        <ReviewSection
          review={review}
          running={reviewRunning}
          progress={reviewProgress}
          canReview={hasMoves}
          error={reviewError}
          currentPly={graphCurrentPly}
          onRun={runReview}
          onSeek={seekToPly}
          nextMistakePly={nextMistakePly}
        />

        <MoveNote moveEval={currentMoveEval} hasReview={review !== null} figurine={figurine} />

        <MovesSection
          root={tree.root}
          currentId={tree.current.id}
          figurine={figurine}
          onSelect={tree.goTo}
          badges={review ? badges : undefined}
          evals={review ? moveEvalsByPly : undefined}
          trace={openingTrace}
          result={gameResult}
        />
      </aside>
    </div>
  )
}
