import { useEffect, useRef, type ReactNode } from 'react'
import type { TreeNode } from '../state/gameTree'
import { displaySan } from '../chess/notation'
import { OpeningTag, type OpeningTrace } from '../chess/openingTrace'
import { badgeMeta, markClass, type BadgeMap } from '../features/analysis/badges'

export interface MoveListProps {
  root: TreeNode
  currentId: string
  figurineMode: boolean
  onSelect: (id: string) => void
  /** Optional per-ply review classifications. Keyed by half-move ply (1-based). */
  badges?: BadgeMap
  /** Optional persistent opening trace (chess/openingTrace.ts). When provided,
   *  the current opening renders as a slim OpeningTag header inside the move
   *  box. Sticky by design: it names the line even after it leaves theory. */
  trace?: OpeningTrace
}

/* ------------------------------------------------------------------------- */
/* Table model                                                                */
/* ------------------------------------------------------------------------- */

/** One full-move table row: number gutter + White cell + Black cell.
 *  `white: null` renders an "…" continuation cell (the row resumes after a
 *  variation block); `black: null` is an "…" cell when `blackEllipsis` is set
 *  (variations split the row) and a blank cell at the end of the line. */
interface MoveRow {
  num: number
  white: TreeNode | null
  black: TreeNode | null
  blackEllipsis: boolean
}

type ListItem =
  | { kind: 'row'; key: string; row: MoveRow }
  | { kind: 'vars'; key: string; vars: TreeNode[] }

/** Flatten the mainline into table rows, splicing each move's alternative
 *  branches in as an indented variation block directly under the row where
 *  they branch (lichess-style). The mainline itself stays a clean table.
 *  Rebuilt every render on purpose: the game tree mutates in place, so
 *  memoizing on `root` identity would go stale. */
function buildItems(root: TreeNode): ListItem[] {
  const items: ListItem[] = []
  let open: MoveRow | null = null // row still waiting for its Black move

  const flush = (interrupted: boolean): void => {
    if (!open) return
    open.blackEllipsis = interrupted && open.black === null
    const anchor = open.white ?? open.black
    items.push({ kind: 'row', key: `r${anchor?.id ?? open.num}`, row: open })
    open = null
  }

  let cur = root
  while (cur.children.length > 0) {
    const main = cur.children[0]
    const alternatives = cur.children.slice(1) // variations branching off `main`
    const isWhite = main.ply % 2 === 1
    const num = Math.ceil(main.ply / 2)

    if (isWhite) {
      flush(false) // defensive: a row can't normally be open here
      open = { num, white: main, black: null, blackEllipsis: false }
    } else if (open) {
      open.black = main
    } else {
      // Black continuation after an interrupt: "N. … <black move>".
      open = { num, white: null, black: main, blackEllipsis: false }
    }

    if (alternatives.length > 0) {
      // Variations interrupt the table under the move they branch from; a
      // half-open row (White move with alternatives) closes with an "…" cell.
      flush(true)
      items.push({ kind: 'vars', key: `v${main.id}`, vars: alternatives })
    } else if (open !== null && open.black !== null) {
      flush(false)
    }
    cur = main
  }
  flush(false)
  return items
}

/* ------------------------------------------------------------------------- */
/* Component                                                                  */
/* ------------------------------------------------------------------------- */

/** The app's one move list, in v1's vocabulary: a `.moves` grid of `.mv-no`
 *  and `.mv`, with `.mv.is-next` on the move the board is showing. Without
 *  `badges` it is a plain table; with a review every move carries its
 *  classification mark; branches render as indented blocks between rows. */
export function MoveList({ root, currentId, figurineMode, onSelect, badges, trace }: MoveListProps) {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the active move visible as the user navigates. WITHOUT scrollIntoView.
  // scrollIntoView walks up and scrolls EVERY ancestor scroll container, so in
  // Analysis it also yanked the sidebar/page down on each move (the user had to
  // scroll back up after every move). Instead we scroll ONLY this list's own
  // overflow:auto box (.moves.is-scroll, ref below), and only when the current
  // token is actually outside its visible range, and never when the list isn't
  // overflowing (nothing to scroll).
  useEffect(() => {
    const scroller = listRef.current
    if (!scroller) return
    const el = scroller.querySelector<HTMLElement>('.is-next')
    if (!el) return
    // No overflow → nothing to scroll (and no reason to touch scrollTop).
    if (scroller.scrollHeight <= scroller.clientHeight) return
    // Measure the token's position RELATIVE to the scroller's viewport via rects
    // (independent of offsetParent/positioning). Convert to the scroller's
    // scroll coordinate space by adding the current scrollTop.
    const sRect = scroller.getBoundingClientRect()
    const eRect = el.getBoundingClientRect()
    const top = eRect.top - sRect.top + scroller.scrollTop
    const bottom = top + eRect.height
    const viewTop = scroller.scrollTop
    const viewBottom = viewTop + scroller.clientHeight
    if (top < viewTop) {
      scroller.scrollTop = top // above the fold → bring to the top edge
    } else if (bottom > viewBottom) {
      scroller.scrollTop = bottom - scroller.clientHeight // below → to bottom edge
    }
    // Already fully visible: leave scrollTop untouched (no page/sidebar jump).
  }, [currentId])

  // Slim opening header, OUTSIDE the scrolling list so it never scrolls away.
  // Shown in the empty state too: a pasted mid-opening FEN is already in book.
  const header = trace ? <OpeningTag trace={trace} figurine={figurineMode} /> : null

  if (root.children.length === 0) {
    return (
      <>
        {header}
        <div className="empty" role="status">
          <p className="empty-line">No moves yet.</p>
          <p className="empty-line">Play a move on the board to start a line.</p>
        </div>
      </>
    )
  }

  const items = buildItems(root)

  return (
    <>
      {header}
      <div className="moves is-scroll" role="group" aria-label="Move list" ref={listRef}>
        {items.map((item) =>
          // A row is three cells laid straight into the grid, not a wrapper
          // around them: .moves is the three column grid and every cell in it
          // is a direct child, which is what keeps the columns aligned across
          // the branch blocks that interrupt them.
          item.kind === 'row'
            ? [
                <span className="mv-no" key={`n${item.key}`} aria-hidden>
                  {item.row.num}
                </span>,
                <MoveCell
                  key={`w${item.key}`}
                  node={item.row.white}
                  ellipsis={item.row.white === null}
                  currentId={currentId}
                  figurineMode={figurineMode}
                  onSelect={onSelect}
                  badges={badges}
                />,
                <MoveCell
                  key={`b${item.key}`}
                  node={item.row.black}
                  ellipsis={item.row.blackEllipsis}
                  currentId={currentId}
                  figurineMode={figurineMode}
                  onSelect={onSelect}
                  badges={badges}
                />
              ]
            : item.vars.map((v) => (
                <div key={`${item.key}-${v.id}`} className="mv-var">
                  {'( '}
                  <VarToken
                    node={v}
                    forceNum
                    current={v.id === currentId}
                    figurineMode={figurineMode}
                    onSelect={onSelect}
                  />
                  <VarTail
                    node={v}
                    currentId={currentId}
                    figurineMode={figurineMode}
                    onSelect={onSelect}
                  />
                  {' )'}
                </div>
              ))
        )}
      </div>
    </>
  )
}

/** A mainline cell: the move button with its classification mark, or an inert
 *  "…"/blank placeholder when the row has no move on that side. */
function MoveCell({
  node,
  ellipsis,
  currentId,
  figurineMode,
  onSelect,
  badges
}: {
  node: TreeNode | null
  ellipsis: boolean
  currentId: string
  figurineMode: boolean
  onSelect: (id: string) => void
  badges?: BadgeMap
}) {
  if (!node) {
    return (
      <span className="mv is-gap" aria-hidden>
        {ellipsis ? '…' : ''}
      </span>
    )
  }
  const isWhite = node.ply % 2 === 1
  const num = Math.ceil(node.ply / 2)
  const rawSan = node.move?.san ?? ''
  const san = displaySan(rawSan, figurineMode)
  // Once a review exists, EVERY reviewed move carries its classification mark
  // (chess.com-style): no notable-only filtering. The mark is coloured and the
  // move text is not, which is the answer the Analysis list already gives.
  const badge = badges?.get(node.ply)
  const meta = badge ? badgeMeta(badge) : undefined
  const current = node.id === currentId
  // Spoken label uses the plain SAN (never the figurine glyph) plus move number
  // and side, and appends the classification word so it is not color-only.
  const label = `${num}${isWhite ? '. ' : '... '}${rawSan}${meta ? `, ${meta.label}` : ''}`
  return (
    <button
      type="button"
      className={`mv${current ? ' is-next' : ''}`}
      aria-current={current ? 'true' : undefined}
      aria-label={label}
      onClick={() => onSelect(node.id)}
    >
      <span className="mv-san">{san}</span>
      {badge && meta && (
        <span className={`mv-mk ${markClass(badge)}`} title={meta.label} aria-hidden>
          {meta.glyph}
        </span>
      )}
    </button>
  )
}

/** Flowing continuation of a variation line: mainline-of-the-variation tokens
 *  with nested sub-variations in parentheses. */
function VarTail({
  node,
  currentId,
  figurineMode,
  onSelect
}: {
  node: TreeNode
  currentId: string
  figurineMode: boolean
  onSelect: (id: string) => void
}) {
  const out: ReactNode[] = []
  let cur = node
  let needNum = false
  while (cur.children.length > 0) {
    const main = cur.children[0]
    out.push(
      <VarToken
        key={main.id}
        node={main}
        forceNum={needNum}
        current={main.id === currentId}
        figurineMode={figurineMode}
        onSelect={onSelect}
      />
    )
    if (cur.children.length > 1) {
      for (const v of cur.children.slice(1)) {
        out.push(
          <span className="mv-subvar" key={`v${v.id}`}>
            {'( '}
            <VarToken
              node={v}
              forceNum
              current={v.id === currentId}
              figurineMode={figurineMode}
              onSelect={onSelect}
            />
            <VarTail node={v} currentId={currentId} figurineMode={figurineMode} onSelect={onSelect} />
            {') '}
          </span>
        )
      }
      needNum = true
    } else {
      needNum = false
    }
    cur = main
  }
  return <>{out}</>
}

/** One clickable move token inside a variation block. Variation plies reuse
 *  mainline ply numbers, so review badges (keyed by mainline ply) are never
 *  shown here. They would be the wrong move's classification. */
function VarToken({
  node,
  forceNum,
  current,
  figurineMode,
  onSelect
}: {
  node: TreeNode
  forceNum: boolean
  current: boolean
  figurineMode: boolean
  onSelect: (id: string) => void
}) {
  const isWhite = node.ply % 2 === 1
  const num = Math.ceil(node.ply / 2)
  const prefix = isWhite ? `${num}.` : forceNum ? `${num}…` : ''
  const rawSan = node.move?.san ?? ''
  const san = displaySan(rawSan, figurineMode)
  const label = `variation, ${num}${isWhite ? '. ' : '... '}${rawSan}`
  return (
    <button
      type="button"
      className={`mv-varmove${current ? ' is-next' : ''}`}
      aria-current={current ? 'true' : undefined}
      aria-label={label}
      onClick={() => onSelect(node.id)}
    >
      {prefix ? `${prefix} ` : ''}
      {san}
    </button>
  )
}
