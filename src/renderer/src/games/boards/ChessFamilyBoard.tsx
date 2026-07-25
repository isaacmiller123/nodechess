// ChessFamilyBoard: ONE chessgroundx board for all 14 chess-family kinds
// (docs/GAMES-PLATFORM-SPEC.md §Approved stack: chessgroundx, same API family
// as the app's chessground: the wrapper pattern mirrors board/Board.tsx).
//
// Parameterized entirely by GameBoardProps + the registry entry:
//   - dimensions from spec.board (8x8 cells, 9x9 shogi cells, 9x10
//     xiangqi/janggi INTERSECTIONS. Rendered with the classic offset-grid
//     trick: pieces live in cells, the line grid is drawn through cell
//     centers by an SVG overlay incl. palace diagonals + river),
//   - dests grouped from spec.legalMoves(state) (drop moves 'P@e4' become
//     chessgroundx DropOrig entries → pocket UI),
//   - pockets for crazyhouse, shogi hands and the placement drop phase
//     (piece counts come from the state FEN's [..] bracket, which chessops
//     and ffish both emit),
//   - promotion dialogs per family: chess role picker (antichess adds king),
//     shogi promote/keep prompt (auto when forced), makruk auto-met (ffish
//     emits exactly one candidate),
//   - last-move + check highlights, OTB rotate via `orientation`.
//
// The board never validates rules: it proposes `onMove(<canonical move>)` and
// the owner answers by advancing spec state; every gesture is followed by a
// re-sync to the authoritative state fen (rejected moves snap back).
//
// Piece art: chess kinds use the app piece sets via the GENERATED
// chess-family-pieces.css (scoped to .cfb-wrap; .pieces-<set> ancestor
// switches sets, exactly like the classic board). Xiangqi/janggi/shogi art is
// injected from resources/games-art by chessFamilyArt.ts; if a set is missing
// the .cfb-noart CSS fallback (disc + traditional glyph) keeps the board
// rendering.

import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
// NOTE: deep import. Chessgroundx ships no package.json `main`/`types`, so
// the bare specifier resolves for Vite (module field) but not for tsc.
import { Chessground } from 'chessgroundx/chessground'
import type { Api } from 'chessgroundx/api'
import type { Config } from 'chessgroundx/config'
import type * as cg from 'chessgroundx/types'
import { read as readFen } from 'chessgroundx/fen'
import { letterOf, roleOf } from 'chessgroundx/util'
import type { GameBoardProps } from '../registry'
import { getGame } from '../registry'
import type { GameKind } from '../kernel'
import type { ChessVariantState } from '../chessVariants'
import { ffishStateCheck } from '../ffishVariants'
import { isFfishReady } from '../ffish'
import { ensureChessFamilyArtCss, hasBoardArt } from './chessFamilyArt'
import { keyToUciSquare, uciSquareToKey } from './cgKeys'
import './chess-family-pieces.css'
import './chess-family-board.css'

// ---------------------------------------------------------------------------
// Kind tables

const FFISH_KINDS: ReadonlySet<GameKind> = new Set(['xiangqi', 'shogi', 'janggi', 'makruk', 'placement'])

const POCKET_ROLES: Partial<Record<GameKind, cg.Role[]>> = {
  crazyhouse: ['p-piece', 'n-piece', 'b-piece', 'r-piece', 'q-piece'],
  shogi: ['p-piece', 'l-piece', 'n-piece', 's-piece', 'g-piece', 'b-piece', 'r-piece'],
  placement: ['q-piece', 'r-piece', 'b-piece', 'n-piece', 'k-piece']
}

const PROMO_LABEL: Record<string, string> = {
  q: 'Queen',
  r: 'Rook',
  b: 'Bishop',
  n: 'Knight',
  k: 'King',
  m: 'Met'
}

// ---------------------------------------------------------------------------
// Move codec (kernel canonical strings ↔ chessgroundx keys)
//
// Kernel/UCI squares use numeric ranks ('a10'); chessgroundx keys use
// single-character ranks (rank 10 = ':', so a10 is key 'a:'). ALL squares
// handed to / received from chessground go through boards/cgKeys.ts, a raw
// `as cg.Key` cast on a UCI square breaks rank 10 (immobile xiangqi/janggi
// back-rank pieces). parseMove/destsOf/lastMoveOf are pure and exported for
// scripts/test-cg-keys.mjs.

interface ParsedMove {
  /** chessgroundx orig. Board key ('a:') or drop orig ('P@') */
  orig: cg.Orig
  /** chessgroundx dest key ('a:') */
  dest: cg.Key
  /** promotion suffix: chess 'q|r|b|n|k', shogi '+', makruk 'm', else '' */
  suffix: string
}

// files a–p / ranks 1–16 = chessgroundx limits (fairy-sf largeboard tops out
// at l10 (see games/customVariants.ts) comfortably inside).
const BOARD_MOVE_RE = /^([a-p](?:1[0-6]|[1-9]))([a-p](?:1[0-6]|[1-9]))([a-z+]?)$/
const DROP_MOVE_RE = /^([A-Z])@([a-p](?:1[0-6]|[1-9]))$/

export function parseMove(move: string): ParsedMove | null {
  const drop = DROP_MOVE_RE.exec(move)
  if (drop) {
    const dest = uciSquareToKey(drop[2])
    return dest ? { orig: `${drop[1]}@` as cg.Orig, dest, suffix: '' } : null
  }
  const m = BOARD_MOVE_RE.exec(move)
  if (!m) return null
  const orig = uciSquareToKey(m[1])
  const dest = uciSquareToKey(m[2])
  if (!orig || !dest) return null
  return { orig, dest, suffix: m[3] }
}

/** Group legal moves by origin. Same-square moves (janggi pass) are skipped:
 *  they cannot be a board gesture; owners surface them as a Pass control. */
export function destsOf(moves: readonly string[]): cg.Dests {
  const dests = new Map<cg.Orig, cg.Key[]>()
  for (const move of moves) {
    const p = parseMove(move)
    if (!p || p.orig === p.dest) continue
    const list = dests.get(p.orig)
    if (!list) dests.set(p.orig, [p.dest])
    else if (!list.includes(p.dest)) list.push(p.dest)
  }
  return dests
}

export function lastMoveOf(moves: readonly string[]): cg.Orig[] | undefined {
  const last = moves.length > 0 ? moves[moves.length - 1] : undefined
  if (!last) return undefined
  const p = parseMove(last)
  if (!p) return undefined
  return p.orig === p.dest ? undefined : p.orig.endsWith('@') ? [p.dest] : [p.orig, p.dest]
}

// ---------------------------------------------------------------------------
// State narrowing: every chess-family spec state carries fen + moves.

interface CfState {
  fen: string
  moves: readonly string[]
}

function narrow(state: unknown): CfState {
  const s = state as Partial<CfState> | null
  return { fen: typeof s?.fen === 'string' ? s.fen : '8/8/8/8/8/8/8/8 w - - 0 1', moves: s?.moves ?? [] }
}

function turnOf(fen: string, moves: readonly string[]): cg.Color {
  const token = fen.split(' ')[1]
  if (token === 'b') return 'black'
  if (token === 'w') return 'white'
  return moves.length % 2 === 0 ? 'white' : 'black'
}

/** Is the side to move in check? (highlight only; never rules-authoritative) */
function checkOf(kind: GameKind, state: unknown): boolean {
  try {
    if (FFISH_KINDS.has(kind)) return isFfishReady() ? ffishStateCheck(state as never) : false
    const pos = (state as ChessVariantState).pos
    return typeof pos?.isCheck === 'function' ? pos.isCheck() : false
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Promotion dialog

interface PromoChoice {
  move: string
  role: cg.Role
  label: string
}

interface PromoPrompt {
  color: cg.Color
  ally: boolean
  title: string
  choices: PromoChoice[]
}

function promoPromptOf(
  kind: GameKind,
  candidates: string[],
  fen: string,
  dims: cg.BoardDimensions,
  turn: cg.Color,
  orientation: cg.Color
): PromoPrompt {
  const ally = turn === orientation
  if (kind === 'shogi') {
    // keep vs promote: derive the moving piece's role from the current fen
    const orig = parseMove(candidates[0])!.orig as cg.Key
    const piece = readFen(fen, dims).pieces.get(orig)
    const base: cg.Role = piece?.role ?? 'p-piece'
    const choices = candidates
      .map((move) => {
        const promoted = move.endsWith('+')
        return {
          move,
          role: promoted ? (`p${base}` as cg.Role) : base,
          label: promoted ? 'Promote' : 'Keep'
        }
      })
      .sort((a, b) => (a.label === 'Promote' ? -1 : b.label === 'Promote' ? 1 : 0))
    return { color: turn, ally, title: 'Promote?', choices }
  }
  // chess family: candidates differ by suffix letter (q/r/b/n, antichess +k, makruk m)
  const choices = candidates.map((move) => {
    const suffix = parseMove(move)?.suffix ?? ''
    return {
      move,
      role: roleOf((suffix || 'q') as cg.Letter),
      label: PROMO_LABEL[suffix] ?? suffix.toUpperCase()
    }
  })
  return { color: turn, ally, title: 'Promote to', choices }
}

// ---------------------------------------------------------------------------
// Grid overlays (intersection boards + shogi lines)

function line(x1: number, y1: number, x2: number, y2: number, w = 0.045): JSX.Element {
  return (
    <line
      key={`${x1},${y1},${x2},${y2}`}
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke="var(--cfb-line)"
      strokeWidth={w}
      strokeLinecap="round"
    />
  )
}

/** Corner ticks marking a cannon/soldier start point (xiangqi). */
function pointTicks(x: number, y: number, files: number): JSX.Element[] {
  const g = 0.12
  const l = 0.22
  const out: JSX.Element[] = []
  for (const sx of [-1, 1]) {
    if ((x <= 0.5 && sx < 0) || (x >= files - 0.5 && sx > 0)) continue
    for (const sy of [-1, 1]) {
      out.push(
        <path
          key={`t${x},${y},${sx},${sy}`}
          d={`M ${x + sx * (g + l)} ${y + sy * g} H ${x + sx * g} V ${y + sy * (g + l)}`}
          fill="none"
          stroke="var(--cfb-line)"
          strokeWidth={0.035}
          strokeLinecap="round"
        />
      )
    }
  }
  return out
}

function IntersectionGrid({ kind, files, ranks }: { kind: GameKind; files: number; ranks: number }): JSX.Element {
  const river = kind === 'xiangqi'
  const top = 0.5
  const bottom = ranks - 0.5
  const left = 0.5
  const right = files - 0.5
  const els: JSX.Element[] = []
  for (let r = 0; r < ranks; r++) els.push(line(left, r + 0.5, right, r + 0.5))
  for (let f = 0; f < files; f++) {
    const x = f + 0.5
    if (river && f > 0 && f < files - 1) {
      els.push(line(x, top, x, ranks / 2 - 0.5))
      els.push(line(x, ranks / 2 + 0.5, x, bottom))
    } else {
      els.push(line(x, top, x, bottom))
    }
  }
  // palaces (both games): 3 center files, first/last 3 ranks
  const pl = files / 2 - 1
  const pr = files / 2 + 1
  els.push(line(pl, top, pr, top + 2, 0.035))
  els.push(line(pr, top, pl, top + 2, 0.035))
  els.push(line(pl, bottom - 2, pr, bottom, 0.035))
  els.push(line(pr, bottom - 2, pl, bottom, 0.035))
  if (river) {
    // cannon + soldier start points
    for (const [x, y] of [
      [1.5, 2.5],
      [7.5, 2.5],
      [1.5, 7.5],
      [7.5, 7.5]
    ]) {
      els.push(...pointTicks(x, y, files))
    }
    for (const y of [3.5, 6.5]) {
      for (let f = 0; f < files; f += 2) els.push(...pointTicks(f + 0.5, y, files))
    }
    // river banks stay open: border frame
    els.push(
      <rect
        key="frame"
        x={left - 0.06}
        y={top - 0.06}
        width={right - left + 0.12}
        height={bottom - top + 0.12}
        fill="none"
        stroke="var(--cfb-line)"
        strokeWidth={0.07}
      />
    )
  }
  return (
    <svg className="cfb-grid" viewBox={`0 0 ${files} ${ranks}`} aria-hidden>
      {els}
    </svg>
  )
}

function ShogiGrid({ files, ranks }: { files: number; ranks: number }): JSX.Element {
  const els: JSX.Element[] = []
  for (let f = 1; f < files; f++) els.push(line(f, 0, f, ranks, 0.03))
  for (let r = 1; r < ranks; r++) els.push(line(0, r, files, r, 0.03))
  els.push(
    <rect
      key="frame"
      x={0.035}
      y={0.035}
      width={files - 0.07}
      height={ranks - 0.07}
      fill="none"
      stroke="var(--cfb-line)"
      strokeWidth={0.07}
    />
  )
  for (const [x, y] of [
    [3, 3],
    [6, 3],
    [3, 6],
    [6, 6]
  ]) {
    els.push(<circle key={`s${x},${y}`} cx={x} cy={y} r={0.07} fill="var(--cfb-line)" />)
  }
  return (
    <svg className="cfb-grid" viewBox={`0 0 ${files} ${ranks}`} aria-hidden>
      {els}
    </svg>
  )
}

/** <piece> custom element (chessgroundx piece-art selectors apply). */
function PieceGlyph({ cls }: { cls: string }): JSX.Element {
  return createElement('piece', { className: cls })
}

// ---------------------------------------------------------------------------
// Component

export default function ChessFamilyBoard({
  kind,
  state,
  orientation,
  interactive,
  onMove
}: GameBoardProps): JSX.Element {
  const entry = getGame(kind)
  const spec = entry?.spec
  const files = spec?.board.files ?? 8
  const ranks = spec?.board.ranks ?? 8
  const intersections = spec?.board.layout === 'intersections'
  const cells8 = !intersections && files === 8 && ranks === 8
  const pocketRoles = POCKET_ROLES[kind]

  const { fen, moves } = narrow(state)
  const turn = turnOf(fen, moves)

  const elRef = useRef<HTMLDivElement>(null)
  const pocketTopRef = useRef<HTMLDivElement>(null)
  const pocketBottomRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<Api | null>(null)
  const [promo, setPromo] = useState<PromoPrompt | null>(null)
  // bump → force a config re-sync (snap back rejected/cancelled gestures)
  const [nonce, setNonce] = useState(0)

  ensureChessFamilyArtCss()
  const art = hasBoardArt(kind)

  const legal = useMemo<readonly string[]>(() => {
    if (!spec) return []
    try {
      return spec.legalMoves(state)
    } catch {
      return [] // ffish not preloaded yet: owner shows the shimmer first
    }
  }, [spec, state])

  const dests = useMemo(() => (interactive ? destsOf(legal) : new Map<cg.Orig, cg.Key[]>()), [legal, interactive])
  const lastMove = lastMoveOf(moves)
  const inCheck = useMemo(() => checkOf(kind, state), [kind, state])

  // Everything the gesture handlers need, without re-binding chessground events.
  const liveRef = useRef({ legal, fen, turn, orientation, kind, onMove, dims: { width: files, height: ranks } })
  liveRef.current = { legal, fen, turn, orientation, kind, onMove, dims: { width: files, height: ranks } }

  const config = (): Config => ({
    fen,
    orientation,
    turnColor: turn,
    check: inCheck ? turn : false,
    lastMove,
    coordinates: cells8,
    dimensions: { width: files, height: ranks },
    // Board.tsx lesson: never CREATE the board viewOnly. Gate via movable/
    // draggable/selectable so listeners stay bound.
    viewOnly: false,
    highlight: { lastMove: true, check: true },
    animation: { enabled: true, duration: 200 },
    movable: {
      free: false,
      color: interactive ? turn : undefined,
      dests,
      showDests: true,
      events: {
        after: (orig, dest) => {
          const live = liveRef.current
          const candidates = live.legal.filter((m) => {
            const p = parseMove(m)
            return p !== null && p.orig === orig && p.dest === dest
          })
          if (candidates.length === 1) {
            live.onMove(candidates[0])
          } else if (candidates.length > 1) {
            setPromo(
              promoPromptOf(live.kind, candidates, live.fen, live.dims, live.turn, live.orientation)
            )
          }
          setNonce((n) => n + 1) // re-sync to authoritative state (reject → snap back)
        },
        afterNewPiece: (piece, key) => {
          const live = liveRef.current
          const letter = letterOf(piece.role, true)
          // key is a cg key ('a:' on rank 10): kernel moves want 'a10'
          live.onMove(`${letter}@${keyToUciSquare(key)}`)
          setNonce((n) => n + 1)
        }
      }
    },
    premovable: { enabled: false },
    draggable: { enabled: interactive },
    selectable: { enabled: interactive },
    drawable: { enabled: true, visible: true, eraseOnClick: true },
    ...(pocketRoles ? { pocketRoles: { white: pocketRoles, black: pocketRoles } } : {})
  })
  const configRef = useRef(config)
  configRef.current = config

  // Create (and re-create on kind/orientation change; pockets bind their color
  // sides at creation time; see chessgroundx renderPocketsInitial).
  useEffect(() => {
    if (!elRef.current) return
    apiRef.current = Chessground(
      elRef.current,
      configRef.current(),
      pocketTopRef.current ?? undefined,
      pocketBottomRef.current ?? undefined
    )
    return () => {
      apiRef.current?.destroy()
      apiRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, orientation, pocketRoles])

  // Sync on every meaningful prop change.
  useEffect(() => {
    apiRef.current?.set(configRef.current())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, turn, interactive, dests, inCheck, lastMove?.join(''), nonce])

  // A new position invalidates any pending promotion prompt.
  useEffect(() => setPromo(null), [fen])

  const style = {
    '--cfb-files': files,
    '--cfb-ranks': ranks
  } as CSSProperties

  const wrapCls = [
    'cfb-wrap',
    `cfb-${kind}`,
    cells8 ? 'cfb-cells8' : '',
    intersections ? 'cfb-int' : '',
    art ? '' : 'cfb-noart'
  ]
    .filter(Boolean)
    .join(' ')

  const label = interactive
    ? `${spec?.title ?? kind} board, ${orientation} side, ${turn} to move`
    : `${spec?.title ?? kind} board, view only`

  return (
    <div className={wrapCls} style={style}>
      {pocketRoles && <div ref={pocketTopRef} className="cfb-pocket" aria-label="Opponent pocket" />}
      <div className="cfb-board" role="group" aria-label={label}>
        {intersections && <IntersectionGrid kind={kind} files={files} ranks={ranks} />}
        {kind === 'shogi' && <ShogiGrid files={files} ranks={ranks} />}
        {kind === 'xiangqi' && (
          <div className="cfb-river" aria-hidden>
            <span>楚 河</span>
            <span>漢 界</span>
          </div>
        )}
        <div ref={elRef} className="cfb-cg" />
        {promo && (
          <div
            className="cfb-promo"
            onClick={() => {
              setPromo(null)
              setNonce((n) => n + 1)
            }}
          >
            <div className="cfb-promo-card" onClick={(e) => e.stopPropagation()}>
              <p className="cfb-promo-title">{promo.title}</p>
              {promo.choices.map((c) => (
                <button
                  key={c.move}
                  type="button"
                  className="cfb-promo-choice"
                  aria-label={c.label}
                  onClick={() => {
                    onMove(c.move)
                    setPromo(null)
                    setNonce((n) => n + 1)
                  }}
                >
                  <PieceGlyph cls={`${c.role} ${promo.color} ${promo.ally ? 'ally' : 'enemy'}`} />
                  <span>{c.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {pocketRoles && <div ref={pocketBottomRef} className="cfb-pocket" aria-label="Your pocket" />}
    </div>
  )
}
