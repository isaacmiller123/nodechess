// Assistance panel for Play vs a bot: a 3-stage hint ladder plus two live
// helper toggles ("Show best move" / "Show weaknesses"), drawn on the board as
// auto-shapes in the School visual language (annotations.ts is the single
// source of truth for the brushes/glow/ring/highlight looks).
//
// Engine usage: ONE shot per user turn — a modest depth-limited analyze of the
// current position, started only when something actually needs it (a toggle is
// on or the ladder was stepped). Results are tagged with the fen of the search
// that produced them (via the handle -> fen map, NOT the current render's fen),
// so a line that lands mid-position-change can never be attributed to the new
// position — the stale-lines-on-fen-change class of bug is impossible by
// construction. The main process keeps a single analysis search alive, so a
// CoachHint read may silently replace ours; we simply keep the deepest PV we
// streamed (fine at these depths) and re-analyze on the next move.
//
// Threats note: analyzing "as if the opponent were to move" (a null move) is
// unsound, so "Show weaknesses" draws the opponent's best reply within the
// engine's top line — ply 2 of the PV — as a red arrow, plus a direct-attack
// count of loose pieces (yours, non-pawn, attacked more times than defended,
// computed with chessops' attacksTo helper; batteries/x-rays are not counted).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { ChevronDown, Lightbulb, Wand2 } from 'lucide-react'
import type { Key } from 'chessground/types'
import type { DrawShape } from 'chessground/draw'
import type { Chess } from 'chessops/chess'
import type { Role } from 'chessops/types'
import { makeSquare } from 'chessops/util'
import type { EngineBestmove, EngineLine } from '@shared/types'
import { annotationToShape, hintShapes, type SchoolHintStage } from '../school/annotations'
import { position, pvToSan, type Color } from '../../chess/chess'

/** Modest one-shot search depth: strong enough to trust, quick enough to feel live. */
const ASSIST_DEPTH = 14

// ---------------------------------------------------------------------------
// Persisted toggles
// ---------------------------------------------------------------------------

const PREFS_KEY = 'oct.play.assist.v1'

interface AssistPrefs {
  showBest: boolean
  showThreats: boolean
}

function loadPrefs(): AssistPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<AssistPrefs>
      return { showBest: p.showBest === true, showThreats: p.showThreats === true }
    }
  } catch {
    /* corrupt or unavailable storage — fall through to defaults */
  }
  return { showBest: false, showThreats: false }
}

// ---------------------------------------------------------------------------
// One-shot, fen-tagged engine read (streams while it deepens)
// ---------------------------------------------------------------------------

interface AssistAnalysis {
  /** Top line (UCI) for the CURRENT fen; empty until the first line arrives. */
  pv: string[]
  depth: number
  /** True once the search for the current fen finished (bestmove received). */
  done: boolean
}

const NO_ANALYSIS: AssistAnalysis = { pv: [], depth: 0, done: false }

function useAssistAnalysis(fen: string, enabled: boolean): AssistAnalysis {
  const [state, setState] = useState<AssistAnalysis & { fen: string }>({
    fen,
    pv: [],
    depth: 0,
    done: false
  })
  // The in-flight search: results are tagged with THIS fen (the position the
  // search was started for), never the render-time fen.
  const searchRef = useRef<{ handleId: number; fen: string } | null>(null)
  // Last fen we completed successfully — lets a re-enable (toggle flip) or a
  // return-to-tip reuse the finished read instead of searching again.
  const lastDoneRef = useRef<string | null>(null)

  useEffect(() => {
    const engine = window.api?.engine
    if (!engine) return
    const offLine = engine.onLine((l: EngineLine) => {
      const s = searchRef.current
      if (!s || l.handleId !== s.handleId) return
      if ((l.multipv ?? 1) !== 1 || !l.pv || l.pv.length === 0) return
      const pv = l.pv
      setState({ fen: s.fen, pv, depth: l.depth ?? 0, done: false })
    })
    const offBest = engine.onBestmove((bm: EngineBestmove) => {
      const s = searchRef.current
      if (!s || bm.handleId !== s.handleId) return
      searchRef.current = null
      const fallback = bm.bestmove && bm.bestmove !== '(none)' ? [bm.bestmove] : []
      lastDoneRef.current = fallback.length > 0 ? s.fen : null
      setState((prev) =>
        prev.fen === s.fen && prev.pv.length > 0
          ? { ...prev, done: true }
          : { fen: s.fen, pv: fallback, depth: 0, done: true }
      )
    })
    return () => {
      offLine()
      offBest()
    }
  }, [])

  useEffect(() => {
    const engine = window.api?.engine
    if (!engine) return
    let cancelled = false

    const stopCurrent = (): void => {
      const s = searchRef.current
      if (s) {
        searchRef.current = null
        void engine.stop(s.handleId)
      }
    }
    stopCurrent()

    // Skip the search if we already completed one for this exact position
    // (the finished result is still in state, tagged with this fen).
    if (enabled && lastDoneRef.current !== fen) {
      engine
        .analyze({ fen, multipv: 1, limit: { kind: 'depth', value: ASSIST_DEPTH } })
        .then(({ handleId }) => {
          if (cancelled) void engine.stop(handleId)
          else searchRef.current = { handleId, fen }
        })
        .catch(() => undefined)
    }

    return () => {
      cancelled = true
      stopCurrent()
    }
  }, [fen, enabled])

  // Only surface results that belong to the position on the board.
  return state.fen === fen ? state : NO_ANALYSIS
}

// ---------------------------------------------------------------------------
// Loose ("hanging") pieces — direct attackers vs direct defenders
// ---------------------------------------------------------------------------

export interface LoosePiece {
  square: Key
  role: Role
}

const ROLE_LETTER: Partial<Record<Role, string>> = {
  knight: 'N',
  bishop: 'B',
  rook: 'R',
  queen: 'Q'
}

/** `color`'s non-pawn pieces attacked more times than defended (direct attacks
 *  only — chessops' attacksTo via Chess.kingAttackers; batteries/x-rays are not
 *  counted, so treat this as a first-pass tactical smell test, not SEE). */
export function loosePieces(fen: string, color: Color): LoosePiece[] {
  let pos: Chess
  try {
    pos = position(fen)
  } catch {
    return []
  }
  const occupied = pos.board.occupied
  const opp: Color = color === 'white' ? 'black' : 'white'
  const out: LoosePiece[] = []
  for (const sq of pos.board[color]) {
    const piece = pos.board.get(sq)
    if (!piece || piece.role === 'king' || piece.role === 'pawn') continue
    const attackers = pos.kingAttackers(sq, opp, occupied).size()
    if (attackers === 0) continue
    const defenders = pos.kingAttackers(sq, color, occupied).size()
    if (attackers > defenders) out.push({ square: makeSquare(sq) as Key, role: piece.role })
  }
  return out
}

// ---------------------------------------------------------------------------
// useAssist — all assist state; the host renders <AssistPanel assist={...}/>
// and forwards `shapes` / `shapesNonce` to its Board.
// ---------------------------------------------------------------------------

export interface UseAssistArgs {
  /** Displayed position (FEN). */
  fen: string
  /** Side to move in the displayed position. */
  turn: Color
  userColor: Color
  /** True when the displayed position is the live mainline tip. */
  atTip: boolean
  /** Game over (result banner up or terminal position). */
  over: boolean
  /** Master switch — settings.hintsEnabled. Off hides the panel entirely. */
  enabled: boolean
}

export interface AssistState {
  /** Board auto-shapes; [] whenever assistance is inactive. */
  shapes: DrawShape[]
  /** Bumps whenever `shapes` meaningfully change. Board.tsx's shapesKey() only
   *  hashes orig/dest/brush, so customSvg-only changes (glow/ring/highlight)
   *  need a syncNonce nudge — add this to the Board's existing nonce. */
  shapesNonce: number
  /** Render the panel at all? (hintsEnabled and the game is still running). */
  visible: boolean
  /** Shapes/readouts are live (user's turn, at the tip). */
  live: boolean
  open: boolean
  toggleOpen: () => void
  stage: SchoolHintStage
  hintLabel: string
  hintDisabled: boolean
  onHint: () => void
  showBest: boolean
  showThreats: boolean
  setShowBest: (on: boolean) => void
  setShowThreats: (on: boolean) => void
  bestSan: string | null
  threatSan: string | null
  loose: LoosePiece[]
  /** Engine finished reading the current position. */
  done: boolean
  /** One-line muted status (why assistance is idle / that it's thinking). */
  statusNote: string | null
}

const HINT_NEXT_LABEL: Record<SchoolHintStage, string> = {
  0: 'Hint',
  1: 'Stronger hint',
  2: 'Hint: show the move',
  3: 'Move shown'
}

export function useAssist({ fen, turn, userColor, atTip, over, enabled }: UseAssistArgs): AssistState {
  const engineMissing = typeof window === 'undefined' || !window.api?.engine

  const [open, setOpen] = useState(true)
  const [prefs, setPrefs] = useState<AssistPrefs>(loadPrefs)
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      /* storage may be unavailable */
    }
  }, [prefs])

  // Hint ladder, reset on every new position. The reset is synchronous
  // (render-time state adjust, same pattern as useAnalysis) so a stepped ladder
  // can never leak stage 3 onto the NEXT position's fresh analysis.
  const [hint, setHint] = useState<{ fen: string; stage: SchoolHintStage }>({ fen, stage: 0 })
  if (hint.fen !== fen) setHint({ fen, stage: 0 })
  const stage: SchoolHintStage = hint.fen === fen ? hint.stage : 0

  const visible = enabled && !over
  const userTurn = turn === userColor
  const live = visible && userTurn && atTip

  // One engine read serves the ladder, the best-move arrow and the threat
  // arrow. Only runs when something needs it.
  const wantAnalysis = live && !engineMissing && (stage > 0 || prefs.showBest || prefs.showThreats)
  const analysis = useAssistAnalysis(fen, wantAnalysis)

  // Legality gate (belt + braces on top of fen tagging): SAN conversion walks
  // the PV from the displayed fen and stops at the first illegal move, so a
  // best/threat move is only ever drawn if it is legal here and now.
  const sans = useMemo(
    () => (live && analysis.pv.length > 0 ? pvToSan(fen, analysis.pv, 2) : []),
    [live, analysis.pv, fen]
  )
  const bestUci = sans.length >= 1 ? analysis.pv[0] : null
  const threatUci = sans.length >= 2 ? analysis.pv[1] : null
  const bestSan = sans[0] ?? null
  const threatSan = sans[1] ?? null

  const loose = useMemo(
    () => (live && prefs.showThreats ? loosePieces(fen, userColor) : []),
    [live, prefs.showThreats, fen, userColor]
  )

  const shapes = useMemo<DrawShape[]>(() => {
    if (!live) return []
    const out: DrawShape[] = []
    if (stage > 0 && bestUci) {
      for (const s of hintShapes(bestUci, stage)) {
        // Stage 3 draws the focus arrow — redundant (and visually stacked)
        // when the green best-move arrow is already on. Keep the glow only.
        if (prefs.showBest && s.dest) continue
        out.push(s)
      }
    }
    if (prefs.showBest && bestUci) {
      const s = annotationToShape({
        kind: 'arrow',
        from: bestUci.slice(0, 2),
        to: bestUci.slice(2, 4),
        color: 'good'
      })
      if (s) out.push(s)
    }
    if (prefs.showThreats && threatUci) {
      const s = annotationToShape({
        kind: 'arrow',
        from: threatUci.slice(0, 2),
        to: threatUci.slice(2, 4),
        color: 'bad'
      })
      if (s) out.push(s)
    }
    if (prefs.showThreats) {
      for (const h of loose) {
        const s = annotationToShape({ kind: 'highlight', square: h.square, color: 'bad' })
        if (s) out.push(s)
      }
    }
    return out
  }, [live, stage, bestUci, threatUci, prefs.showBest, prefs.showThreats, loose])

  // Turn "the shapes changed in any way" (including customSvg-only changes,
  // invisible to Board's shapesKey) into a monotonic number. Idempotent
  // render-time cache: same signature -> same nonce.
  const sig = shapes
    .map((s) => `${s.orig}|${s.dest ?? ''}|${s.brush ?? ''}|${s.customSvg?.html ?? ''}`)
    .join(';')
  const nonceRef = useRef({ sig: '', n: 0 })
  if (nonceRef.current.sig !== sig) nonceRef.current = { sig, n: nonceRef.current.n + 1 }

  const toggleOpen = useCallback(() => setOpen((o) => !o), [])
  const onHint = useCallback(() => {
    setHint((h) =>
      h.fen === fen && h.stage < 3 ? { fen, stage: (h.stage + 1) as SchoolHintStage } : h
    )
  }, [fen])
  const setShowBest = useCallback((on: boolean) => setPrefs((p) => ({ ...p, showBest: on })), [])
  const setShowThreats = useCallback(
    (on: boolean) => setPrefs((p) => ({ ...p, showThreats: on })),
    []
  )

  const working = wantAnalysis && analysis.pv.length === 0 && !analysis.done
  let statusNote: string | null = null
  if (engineMissing) statusNote = 'Engine assistance is available in the desktop app.'
  else if (visible && !atTip) statusNote = 'Go to the latest move to use assistance.'
  else if (visible && !userTurn) statusNote = 'Assistance is available on your turn.'
  else if (working) statusNote = 'Reading the position…'

  return {
    shapes,
    shapesNonce: nonceRef.current.n,
    visible,
    live,
    open,
    toggleOpen,
    stage,
    hintLabel: stage >= 3 && bestSan ? bestSan : HINT_NEXT_LABEL[stage],
    hintDisabled: !live || engineMissing || stage >= 3,
    onHint,
    showBest: prefs.showBest,
    showThreats: prefs.showThreats,
    setShowBest,
    setShowThreats,
    bestSan,
    threatSan,
    loose,
    done: analysis.done,
    statusNote
  }
}

// ---------------------------------------------------------------------------
// Panel UI (presentational; host renders it only when assist.visible)
// ---------------------------------------------------------------------------

export function AssistPanel({ assist }: { assist: AssistState }): JSX.Element {
  const {
    live,
    open,
    toggleOpen,
    stage,
    hintLabel,
    hintDisabled,
    onHint,
    showBest,
    showThreats,
    setShowBest,
    setShowThreats,
    bestSan,
    threatSan,
    loose,
    done,
    statusNote
  } = assist

  const pending = done ? '·' : '…'

  return (
    <div className="panel assist-panel">
      <button
        type="button"
        className="panel-head assist-head"
        onClick={toggleOpen}
        aria-expanded={open}
      >
        <span className="panel-title">
          <Wand2 size={15} /> Assistance
        </span>
        <ChevronDown size={16} className={`assist-chevron${open ? ' is-open' : ''}`} />
      </button>

      {open && (
        <div className="assist-body">
          <button
            type="button"
            className="btn ghost assist-hint-btn"
            onClick={onHint}
            disabled={hintDisabled}
            title="Step the hint ladder: piece, square, move"
          >
            <Lightbulb size={14} aria-hidden />
            <span className="assist-hint-label">{hintLabel}</span>
            <span className="assist-hint-steps" aria-hidden>
              {([1, 2, 3] as const).map((i) => (
                <i key={i} className={`assist-step${stage >= i ? ' is-on' : ''}`} />
              ))}
            </span>
          </button>

          <label className="assist-row">
            <span className="assist-row-label">Show best move</span>
            <input
              type="checkbox"
              className="assist-switch"
              checked={showBest}
              onChange={(e) => setShowBest(e.target.checked)}
            />
          </label>
          <label className="assist-row">
            <span className="assist-row-label">Show weaknesses</span>
            <input
              type="checkbox"
              className="assist-switch"
              checked={showThreats}
              onChange={(e) => setShowThreats(e.target.checked)}
            />
          </label>

          {live && (showBest || showThreats) && (
            <div className="assist-readouts">
              {showBest && (
                <div className="assist-readout">
                  <span className="assist-dot is-best" aria-hidden />
                  <span className="assist-readout-label">Best move</span>
                  <span className="assist-readout-value">{bestSan ?? pending}</span>
                </div>
              )}
              {showThreats && (
                <div className="assist-readout">
                  <span className="assist-dot is-threat" aria-hidden />
                  <span className="assist-readout-label">Expected reply</span>
                  <span className="assist-readout-value">{threatSan ?? pending}</span>
                </div>
              )}
              {showThreats && (
                <div className="assist-readout">
                  <span className="assist-dot is-threat" aria-hidden />
                  <span className="assist-readout-label">Loose pieces</span>
                  {loose.length > 0 ? (
                    <span className="assist-loose">
                      {loose.map((p) => (
                        <span key={p.square} className="assist-loose-chip">
                          {ROLE_LETTER[p.role] ?? ''}
                          {p.square}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="assist-readout-value is-quiet">none</span>
                  )}
                </div>
              )}
            </div>
          )}

          {statusNote && <p className="muted small assist-note">{statusNote}</p>}
        </div>
      )}
    </div>
  )
}

export default AssistPanel
