import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Role } from 'chessops/types'
import type { Key } from 'chessground/types'
import type { DrawShape } from 'chessground/draw'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FlipVertical2,
  Cpu,
  Type as TypeIcon,
  ClipboardCopy,
  Library
} from 'lucide-react'
import type { GameReview, GameRow, ReviewMoveEval, ReviewProgress } from '@shared/types'
import { Board } from '../../board/Board'
import { EvalBar } from '../../board/EvalBar'
import { PromotionPicker } from '../../board/PromotionPicker'
import { pieceSetClass } from '../../board/pieceSets'
import { useSound } from '../../sound'
import { EnginePanel } from '../../panels/EnginePanel'
import { MoveList } from '../../panels/MoveList'
import { CoachPanel } from '../../panels/CoachPanel'
import { ReviewPanel } from './ReviewPanel'
import { SharePanel } from './SharePanel'
import { FamousBrowser } from './FamousBrowser'
import { detailToPgn } from './famousData'
import { MyGamesBrowser } from './MyGamesBrowser'
import { AnnotationsLayer } from './AnnotationsLayer'
import { useAnnotations } from './annotations'
import { parsePgnToGame, type LoadedGame } from './shareGame'
import type { ReviewBadge } from './badges'
import { useGameTree } from '../../state/gameTree'
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
  position,
  turnColor,
  uciToLastMove,
  type AppliedMove,
  type Color
} from '../../chess/chess'
import { toWhite } from '../../chess/scores'
import './analysis.css'

const ROLE_FROM_CHAR: Record<string, Role> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }

// Tone suffix (-> .fg-result-*) for the loaded-game header chip.
function headerResultTone(result?: string): 'white' | 'black' | 'draw' | 'open' {
  if (result === '1-0') return 'white'
  if (result === '0-1') return 'black'
  if (result === '1/2-1/2') return 'draw'
  return 'open'
}

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
  const [figurine, setFigurine] = useState(false)
  const [pendingPromo, setPendingPromo] = useState<{ orig: string; dest: string } | null>(null)
  const [nonce, setNonce] = useState(0)
  const [fenInput, setFenInput] = useState('')
  const [fenError, setFenError] = useState<string | null>(null)

  // Game library drawer (Your games | Famous) in the sidebar.
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryTab, setLibraryTab] = useState<'mine' | 'famous'>('mine')

  // Players/result of the currently-loaded game, for the compact header strip.
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

  // Whether the current node lies on the mainline (root.children[0] chain). The
  // eval graph is mainline-only, so its current-ply marker must hide when we are
  // off in a variation (otherwise it points at an unrelated mainline ply).
  const onMainline = useMemo(() => {
    let n = tree.root
    while (n !== tree.current && n.children[0]) n = n.children[0]
    return n === tree.current
  }, [tree.root, tree.current])
  const graphCurrentPly = onMainline ? currentPly : -1

  const { lines, depth, error: engineError } = useAnalysis(fen, engineOn, multipv)
  // Stockfish-on-disk probe (datasets:status().engine): when the engine dataset
  // was never imported, EnginePanel swaps "analyzing… depth 0" for the install
  // CTA. The fresh-install Analysis hang from the audit.
  const { ready: engineReady } = useEngineReady(engineOn)
  const engineMissing = engineOn && engineReady === false
  const best = lines.find((l) => l.multipv === 1) ?? lines[0]
  // Null (not a confident +0.00) when the engine is off or before the first line;
  // the eval bar renders a neutral, dimmed state for null.
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

  // Per-ply badge map for the move list (only meaningful once a review exists).
  // ReviewBadge widens the shared MoveBadge with 'Miss', which the review engine
  // already emits over IPC.
  const badges = useMemo(() => {
    const map = new Map<number, ReviewBadge>()
    if (review) for (const m of review.moveEvals) map.set(m.ply, m.badge)
    return map
  }, [review])

  // Review eval for the move that produced the current position (null at root).
  const currentMoveEval: ReviewMoveEval | null = useMemo(() => {
    if (!review) return null
    return review.moveEvals.find((m) => m.ply === currentPly) ?? null
  }, [review, currentPly])

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

  // Jump the board to the position AFTER the move at `ply`. The eval graph it
  // serves is mainline-only, so we seek by walking the mainline to the matching
  // node and go to it by id (never landing on a variation node).
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

  const loadFen = () => {
    const v = fenInput.trim()
    if (!v) return
    try {
      position(v) // throws if invalid
      tree.reset(v)
      loadQueue.current = null // abandon any half-drained game load
      jumpToStartRef.current = false // ...and its pending jump-to-start
      setLoadedGameId(null) // no longer looking at a stored game
      invalidateReview() // a new position invalidates prior AND in-flight reviews
      setGameHeader(null)
      setFenInput('')
      setFenError(null)
    } catch {
      setFenError('That is not a valid FEN.') // keep input; surface inline
    }
  }

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
      setLibraryOpen(false)
      // Defer move application to the queue effect: addMove must run one move
      // per render so each call sees the freshly-selected current node. Once the
      // queue drains, land on the ROOT so the game starts at move 1.
      loadQueue.current =
        game.moves.length > 0 ? { moves: game.moves, index: 0, expectFen: game.startFen } : null
      jumpToStartRef.current = game.moves.length > 0
    },
    [tree, invalidateReview]
  )

  // ---- Load a SAVED game row (sidebar "Your games" or the gameId prop) ----
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
  // a LoadedGame and load the mainline (same path FamousBrowser clicks take).
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

  const hasMoves = tree.root.children.length > 0
  const currentPgn = useMemo(() => treeToPgn(tree.root, {}), [tree.root, tree.current.id])

  return (
    <div className="analysis-view">
      <div className="board-area">
        {gameHeader && (gameHeader.white || gameHeader.black) && (
          <div className="game-header-strip">
            <span className="game-header-players">
              {gameHeader.white ?? 'White'} <span className="game-header-vs muted">vs</span>{' '}
              {gameHeader.black ?? 'Black'}
            </span>
            {gameHeader.result && (
              <span className={`fg-result-chip fg-result-${headerResultTone(gameHeader.result)}`}>
                {gameHeader.result}
              </span>
            )}
          </div>
        )}
        <div className="board-stage">
          {settings.showEvalBar && <EvalBar score={score} orientation={orientation} />}
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
        <div className="board-controls">
          <button className="icon-btn" onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))} title="Flip board (f)">
            <FlipVertical2 size={18} />
          </button>
          <div className="nav-group">
            <button className="icon-btn" onClick={tree.first} disabled={!tree.canPrev} title="First">
              <ChevronsLeft size={18} />
            </button>
            <button className="icon-btn" onClick={tree.prev} disabled={!tree.canPrev} title="Previous (←)">
              <ChevronLeft size={18} />
            </button>
            <button className="icon-btn" onClick={tree.next} disabled={!tree.canNext} title="Next (→)">
              <ChevronRight size={18} />
            </button>
            <button className="icon-btn" onClick={tree.last} disabled={!tree.canNext} title="Last">
              <ChevronsRight size={18} />
            </button>
          </div>
          <button className={`icon-btn ${figurine ? 'active' : ''}`} onClick={() => setFigurine((f) => !f)} title="Figurine / letters">
            <TypeIcon size={18} />
          </button>
          <button className={`icon-btn ${engineOn ? 'active' : ''}`} onClick={() => setEngineOn((v) => !v)} title="Toggle engine">
            <Cpu size={18} />
          </button>
        </div>
      </div>

      <aside className="analysis-sidebar">
        <EnginePanel
          fen={fen}
          lines={lines}
          depth={depth}
          enabled={engineOn}
          multipv={multipv}
          figurineMode={figurine}
          engineMissing={engineMissing}
          error={engineError}
          onOpenSettings={onOpenSettings}
          onToggle={() => setEngineOn((v) => !v)}
          onMultipv={changeMultipv}
          onPlayUci={playUci}
        />

        <ReviewPanel
          review={review}
          running={reviewRunning}
          progress={reviewProgress}
          canReview={hasMoves}
          error={reviewError}
          currentPly={graphCurrentPly}
          onRun={runReview}
          onSeek={seekToPly}
        />

        {review && <CoachPanel moveEval={currentMoveEval} figurineMode={figurine} />}

        <div className="panel move-panel">
          <div className="panel-head">
            <span className="panel-title">Moves</span>
          </div>
          {/* Opening identity renders inside MoveList (OpeningTag header, driven
              by the persistent trace: it no longer clears when out of book). */}
          <MoveList
            root={tree.root}
            currentId={tree.current.id}
            figurineMode={figurine}
            onSelect={tree.goTo}
            badges={review ? badges : undefined}
            trace={openingTrace}
          />
        </div>
        <div className="panel fen-panel">
          <div className="fen-row">
            <input
              className="fen-input num"
              placeholder="Paste FEN to load a position…"
              value={fenInput}
              onChange={(e) => {
                setFenInput(e.target.value)
                if (fenError) setFenError(null)
              }}
              onKeyDown={(e) => e.key === 'Enter' && loadFen()}
            />
            <button className="btn" onClick={loadFen}>
              Load
            </button>
          </div>
          {fenError && (
            <p className="share-error" role="alert">
              {fenError}
            </p>
          )}
          <button className="btn ghost copy-fen" onClick={() => navigator.clipboard?.writeText(fen)}>
            <ClipboardCopy size={14} /> Copy current FEN
          </button>
        </div>

        <SharePanel
          pgn={currentPgn}
          fen={fen}
          canClearAnnotations={annotations.hasAny}
          onClearAnnotations={annotations.clear}
          onLoadGame={loadGame}
        />

        <div className="panel famous-panel">
          <button
            type="button"
            className="panel-head famous-toggle"
            aria-expanded={libraryOpen}
            onClick={() => setLibraryOpen((o) => !o)}
          >
            <span className="panel-title">
              <Library size={14} className="famous-toggle-icon" /> Game library
            </span>
            <span className="famous-toggle-chevron">{libraryOpen ? '−' : '+'}</span>
          </button>
          {libraryOpen && (
            <div className="famous-drawer">
              <div className="library-tabs" role="tablist" aria-label="Game library source">
                <button
                  type="button"
                  role="tab"
                  aria-selected={libraryTab === 'mine'}
                  className={`library-tab${libraryTab === 'mine' ? ' is-active' : ''}`}
                  onClick={() => setLibraryTab('mine')}
                >
                  Your games
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={libraryTab === 'famous'}
                  className={`library-tab${libraryTab === 'famous' ? ' is-active' : ''}`}
                  onClick={() => setLibraryTab('famous')}
                >
                  Famous
                </button>
              </div>
              {libraryTab === 'mine' ? (
                <MyGamesBrowser onLoadGame={loadSavedGame} />
              ) : (
                <FamousBrowser onLoadGame={loadGame} />
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
