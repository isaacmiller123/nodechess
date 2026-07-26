import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import type { ReviewMoveEval } from '@shared/types'
import type { TreeNode } from '../../state/gameTree'
import { displaySan } from '../../chess/notation'
import type { OpeningTrace } from '../../chess/openingTrace'
import { formatScore, toWhite } from '../../chess/scores'
import { badgeMeta, markClass, type BadgeMap } from './badges'

export interface MovesSectionProps {
  root: TreeNode
  currentId: string
  figurine: boolean
  onSelect: (id: string) => void
  /** Per-ply classification, present only once a review exists. */
  badges?: BadgeMap
  /** Per-ply eval, same condition: nothing outside a review knows these. */
  evals?: Map<number, ReviewMoveEval>
  /** Sticky opening identity for the line on the board. */
  trace: OpeningTrace
  /** Result of the game on the board, when one is actually known. */
  result: string | null
}

/** One row of the notation table: number, White, Black, and any branches that
 *  leave it. Branches are held to the end of the row so the three column grid
 *  never loses its alignment mid row. */
interface MvRow {
  num: number
  white: TreeNode | null
  black: TreeNode | null
  vars: TreeNode[]
}

/** Walk the mainline into table rows. Rebuilt every render on purpose: the game
 *  tree mutates in place, so memoizing on `root` identity would go stale. */
function buildRows(root: TreeNode): MvRow[] {
  const rows: MvRow[] = []
  let row: MvRow | null = null
  let cur = root
  while (cur.children.length > 0) {
    const main = cur.children[0]
    const alternatives = cur.children.slice(1)
    const num = Math.ceil(main.ply / 2)
    if (main.ply % 2 === 1) {
      row = { num, white: main, black: null, vars: [] }
      rows.push(row)
    } else if (row && row.black === null && row.num === num) {
      row.black = main
    } else {
      // Black to move at the root: a pasted FEN can start a row without White.
      row = { num, white: null, black: main, vars: [] }
      rows.push(row)
    }
    if (alternatives.length > 0) row.vars.push(...alternatives)
    cur = main
  }
  return rows
}

/** "White wins · 1–0". Only ever called with a result the app actually has. */
function resultLine(result: string): string {
  if (result === '1-0') return 'White wins · 1–0'
  if (result === '0-1') return 'Black wins · 0–1'
  if (result === '1/2-1/2') return 'Draw · ½–½'
  return result
}

export function MovesSection({
  root,
  currentId,
  figurine,
  onSelect,
  badges,
  evals,
  trace,
  result
}: MovesSectionProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the cursor visible WITHOUT scrollIntoView, which walks up and scrolls
  // every ancestor: in the sidebar that yanked the whole page on each move.
  // Only this box's own scrollTop is ever touched, and only when the cursor has
  // actually left the visible range.
  useEffect(() => {
    const scroller = listRef.current
    if (!scroller) return
    const el = scroller.querySelector<HTMLElement>('.is-cursor')
    if (!el) return
    if (scroller.scrollHeight <= scroller.clientHeight) return
    const sRect = scroller.getBoundingClientRect()
    const eRect = el.getBoundingClientRect()
    const top = eRect.top - sRect.top + scroller.scrollTop
    const bottom = top + eRect.height
    if (top < scroller.scrollTop) scroller.scrollTop = top
    else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight
    }
  }, [currentId])

  const rows = buildRows(root)
  const opening = trace.name ? [trace.eco, trace.name].filter(Boolean).join(' ') : null

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Moves</h2>
        {opening && (
          <span className="sec-count an-clip" title={opening}>
            {opening}
          </span>
        )}
      </div>

      <div className="well">
        {rows.length === 0 ? (
          <div className="empty">
            <p className="empty-line">No moves yet.</p>
            <p className="empty-line">Play a move on the board, or open a game below it.</p>
          </div>
        ) : (
          <div className="an-moves" ref={listRef} role="group" aria-label="Moves">
            {rows.map((row) => {
              const cells: ReactNode[] = [
                <span className="mv-no" key={`n${row.num}`}>
                  {row.num}
                </span>,
                <Cell
                  key={`w${row.white?.id ?? row.num}`}
                  node={row.white}
                  currentId={currentId}
                  figurine={figurine}
                  onSelect={onSelect}
                  badges={badges}
                  evals={evals}
                />,
                <Cell
                  key={`b${row.black?.id ?? row.num}`}
                  node={row.black}
                  currentId={currentId}
                  figurine={figurine}
                  onSelect={onSelect}
                  badges={badges}
                  evals={evals}
                />
              ]
              if (row.vars.length > 0) {
                cells.push(
                  <div className="an-var" key={`v${row.num}`}>
                    {row.vars.map((v) => (
                      <VarLine
                        key={v.id}
                        node={v}
                        currentId={currentId}
                        figurine={figurine}
                        onSelect={onSelect}
                      />
                    ))}
                  </div>
                )
              }
              return cells
            })}
            {result && <span className="an-result">{resultLine(result)}</span>}
          </div>
        )}
      </div>
    </section>
  )
}

/** One notation cell: san, mark, eval. The mark and eval columns are held open
 *  even when empty, so the numeric edge stays straight before a review exists
 *  and after one lands. */
function Cell({
  node,
  currentId,
  figurine,
  onSelect,
  badges,
  evals
}: {
  node: TreeNode | null
  currentId: string
  figurine: boolean
  onSelect: (id: string) => void
  badges?: BadgeMap
  evals?: Map<number, ReviewMoveEval>
}): JSX.Element {
  if (!node) return <span className="an-cell is-empty" aria-hidden />

  const badge = badges?.get(node.ply)
  const meta = badge ? badgeMeta(badge) : null
  const ev = evals?.get(node.ply)
  const evText = ev
    ? formatScore(
        toWhite({ cp: ev.playedEval.cp ?? undefined, mate: ev.playedEval.mate ?? undefined }, ev.color)
      )
    : ''
  const isCursor = node.id === currentId
  const rawSan = node.move?.san ?? ''
  const num = Math.ceil(node.ply / 2)
  const label = `${num}${node.ply % 2 === 1 ? '. ' : '... '}${rawSan}${meta ? `, ${meta.label}` : ''}`

  return (
    <button
      className={`an-cell${isCursor ? ' is-cursor' : ''}`}
      type="button"
      aria-current={isCursor ? 'true' : undefined}
      aria-label={label}
      onClick={() => onSelect(node.id)}
    >
      <span className="an-san">{displaySan(rawSan, figurine)}</span>
      <span className={badge ? `an-mk ${markClass(badge)}` : 'an-mk'} aria-hidden>
        {meta?.glyph ?? ''}
      </span>
      <span className="an-ev">{evText}</span>
    </button>
  )
}

/** A branch, written the way notation writes one: "( 12. Kb1 b4 13. Nd5 )".
 *  Review marks never appear here. Variation plies reuse mainline ply numbers,
 *  so a mark would be a different move's verdict. */
function VarLine({
  node,
  currentId,
  figurine,
  onSelect
}: {
  node: TreeNode
  currentId: string
  figurine: boolean
  onSelect: (id: string) => void
}): JSX.Element {
  const tokens: ReactNode[] = []
  let cur: TreeNode | null = node
  let first = true
  while (cur) {
    const n: TreeNode = cur
    const isWhite = n.ply % 2 === 1
    const prefix = isWhite ? `${Math.ceil(n.ply / 2)}.` : first ? `${Math.ceil(n.ply / 2)}…` : ''
    tokens.push(
      <button
        className={`an-varmove${n.id === currentId ? ' is-cursor' : ''}`}
        type="button"
        key={n.id}
        onClick={() => onSelect(n.id)}
      >
        {prefix ? `${prefix} ` : ''}
        {displaySan(n.move?.san ?? '', figurine)}
      </button>
    )
    first = false
    cur = n.children[0] ?? null
  }
  return (
    <div>
      {'( '}
      {tokens}
      {' )'}
    </div>
  )
}
