// Checkers / International draughts board. Clean React implementation
// (no vendored draughtsground: AGPL + heavy for this window; checkers geometry
// is simple enough to own).
//
// kind === 'checkers'       8x8 American (PDN squares 1..32, black at top)
// kind === 'checkers-intl'  10x10 international (FMJD squares 1..50)
//
// Interaction: click-through multi-jump selection over the spec codec
// ('from-to' quiet, 'NxNxN' full landing chains, see games/checkers.ts):
// click a piece that owns at least one legal move, then click landings one by
// one; every prefix narrows the candidate set and intermediate landings are
// highlighted until exactly one complete chain remains, which fires onMove
// with the canonical move string. Quiet moves are the same flow with a single
// landing. Selection resets whenever the owner advances the state.
//
// Pieces are rendered on an absolute layer keyed by STABLE ids (a per-move
// reconciler transfers the mover's id origin→destination) so CSS transitions
// animate slides; captured men fade out in place; a man reaching the crown
// row pops its new crown. Orientation flips render instantly (no cross-board
// slides): the pieces layer is remounted via key={orientation}, so a flip
// creates fresh DOM with the rotated transforms already in place and the
// slide transition can never lerp pieces across the board (a one-render
// "suppress transitions" class was tried first and lost the race: the
// selection-reset effect re-renders before the browser's next style recalc,
// which restored transitions while the flip delta was still unpainted).

import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import './boards.css'
import type { GameBoardProps } from '../registry'
import {
  AMERICAN_CHECKERS_SPEC,
  INTL_CHECKERS_SPEC,
  americanPiecesOf,
  intlPiecesOf,
  type AmericanCheckersState,
  type CheckersPieceView,
  type IntlCheckersState
} from '../checkers'
import type { PlayerColor } from '../kernel'
import { rcToSquare, squareToRC, viewRC } from './orient'
import { useBoardSound } from './useBoardSound'

interface ParsedLegal {
  str: string
  /** Landing chain: [origin, ...landings] (quiet move = [from, to]). */
  path: number[]
}

interface RenderPiece {
  id: number
  square: number
  color: PlayerColor
  king: boolean
  /** True on the render where a man just crowned (plays the pop animation). */
  crowned: boolean
  /** True once removed from the board. Kept one reconcile for the fade-out. */
  captured: boolean
}

interface PieceModel {
  state: unknown
  moves: readonly string[]
  pieces: RenderPiece[]
  nextId: number
}

function movesOf(state: unknown): readonly string[] {
  return (state as { moves: readonly string[] }).moves
}

const CROWN_PATH = 'M27 63 L23 39 L38 50 L50 30 L62 50 L77 39 L73 63 Z'

function Man({ color, king }: { color: PlayerColor; king: boolean }): JSX.Element {
  return (
    <div className={`ck-man is-${color}`}>
      {king && (
        <svg className="ck-crown" viewBox="0 0 100 100" aria-hidden>
          <path d={CROWN_PATH} fill="#e9b949" stroke="#8a6414" strokeWidth="4" strokeLinejoin="round" />
          <rect x="25" y="64" width="50" height="8" rx="3" fill="#e9b949" stroke="#8a6414" strokeWidth="3" />
        </svg>
      )}
    </div>
  )
}

export default function CheckersBoard({ kind, state, orientation, interactive, onMove }: GameBoardProps): JSX.Element {
  const isAmerican = kind === 'checkers'
  const n = isAmerican ? 8 : 10

  useBoardSound(kind, state)

  const [sel, setSel] = useState<number[]>([])
  useEffect(() => setSel([]), [state, interactive, kind])

  const legals = useMemo<ParsedLegal[]>(() => {
    if (!interactive) return []
    const strs = isAmerican
      ? AMERICAN_CHECKERS_SPEC.legalMoves(state as AmericanCheckersState)
      : INTL_CHECKERS_SPEC.legalMoves(state as IntlCheckersState)
    return strs.map((str) => ({ str, path: str.split(/[x-]/).map(Number) }))
  }, [isAmerican, state, interactive])

  const origins = useMemo(() => new Set(legals.map((m) => m.path[0])), [legals])
  const matches = useMemo(
    () => (sel.length === 0 ? [] : legals.filter((m) => sel.every((sq, i) => m.path[i] === sq))),
    [legals, sel]
  )
  const targets = useMemo(() => {
    const out = new Set<number>()
    for (const m of matches) {
      const next = m.path[sel.length]
      if (next !== undefined) out.add(next)
    }
    return out
  }, [matches, sel])

  const clickSquare = (sq: number): void => {
    if (!interactive) return
    if (sel.length > 0 && targets.has(sq)) {
      const next = [...sel, sq]
      const nextMatches = legals.filter((m) => next.every((s, i) => m.path[i] === s))
      const complete = nextMatches.find((m) => m.path.length === next.length)
      if (complete && nextMatches.length === 1) {
        setSel([])
        onMove(complete.str)
        return
      }
      setSel(next)
      return
    }
    if (origins.has(sq)) {
      setSel(sel.length === 1 && sel[0] === sq ? [] : [sq])
      return
    }
    setSel([])
  }

  // ---- piece reconciler: stable ids across moves for slide/capture/crown ----
  const modelRef = useRef<PieceModel | null>(null)
  const pieces = ((): RenderPiece[] => {
    const m = modelRef.current
    if (m && m.state === state) return m.pieces
    const now: CheckersPieceView[] = isAmerican
      ? americanPiecesOf(state as AmericanCheckersState)
      : intlPiecesOf(state as IntlCheckersState)
    const moves = movesOf(state)
    let nextId = m?.nextId ?? 0
    let out: RenderPiece[]
    const oneStep =
      m !== null &&
      moves.length === m.moves.length + 1 &&
      (m.moves.length === 0 || moves[m.moves.length - 1] === m.moves[m.moves.length - 1])
    if (m && oneStep) {
      const nums = moves[moves.length - 1].split(/[x-]/).map(Number)
      const origin = nums[0]
      const dest = nums[nums.length - 1]
      const old = new Map(m.pieces.filter((p) => !p.captured).map((p) => [p.square, p]))
      out = now.map((p) => {
        const prev = old.get(p.square) ?? (p.square === dest ? old.get(origin) : undefined)
        return {
          id: prev ? prev.id : nextId++,
          square: p.square,
          color: p.color,
          king: p.king,
          crowned: prev !== undefined && !prev.king && p.king,
          captured: false
        }
      })
      const nowSquares = new Set(now.map((p) => p.square))
      for (const p of m.pieces) {
        if (p.captured || p.square === origin || nowSquares.has(p.square)) continue
        out.push({ ...p, crowned: false, captured: true })
      }
    } else {
      out = now.map((p) => ({ ...p, id: nextId++, crowned: false, captured: false }))
    }
    out.sort((a, b) => a.id - b.id)
    modelRef.current = { state, moves, pieces: out, nextId }
    return out
  })()

  // Last move: origin + destination tint.
  const lastEnds = useMemo(() => {
    const moves = movesOf(state)
    const last = moves[moves.length - 1]
    if (!last) return new Set<number>()
    const nums = last.split(/[x-]/).map(Number)
    return new Set([nums[0], nums[nums.length - 1]])
  }, [state])

  const selSet = useMemo(() => new Set(sel), [sel])

  // ---- squares ----
  const cells: JSX.Element[] = []
  const flipped = orientation !== 'white'
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const { row, col } = viewRC(r, c, n, flipped)
      const sq = rcToSquare(row, col, n)
      if (sq === null) {
        cells.push(<div key={`${r}-${c}`} className="ck-sq is-light" />)
        continue
      }
      const isSel = selSet.has(sq) && sel[0] === sq
      const isPath = selSet.has(sq) && !isSel
      const cls = [
        'ck-sq is-dark',
        interactive && (origins.has(sq) || targets.has(sq)) ? ' is-playable' : '',
        lastEnds.has(sq) && sel.length === 0 ? ' is-last' : '',
        isSel ? ' is-selected' : '',
        isPath ? ' is-path' : '',
        targets.has(sq) ? ' is-target' : ''
      ].join('')
      cells.push(
        <div key={`${r}-${c}`} className={cls} onClick={() => clickSquare(sq)}>
          <span className="ck-num">{sq}</span>
        </div>
      )
    }
  }

  const cellPct = 100 / n
  return (
    <div className={`ckboard is-${kind}`}>
      <div className="ckboard-grid" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
        {cells}
        {/* key={orientation}: a flip remounts the layer so transforms never
            transition across the board (instant 180° repaint). */}
        <div className="ck-pieces" key={orientation}>
          {pieces.map((p) => {
            const rc = squareToRC(p.square, n)
            const { row: r, col: c } = viewRC(rc.row, rc.col, n, flipped)
            return (
              <div
                key={p.id}
                className={`ck-piece${p.captured ? ' is-captured' : ''}${p.crowned ? ' is-crowned' : ''}`}
                style={{
                  width: `${cellPct}%`,
                  height: `${cellPct}%`,
                  transform: `translate(${c * 100}%, ${r * 100}%)`
                }}
              >
                <Man color={p.color} king={p.king} />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
