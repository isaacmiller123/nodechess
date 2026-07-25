// Persistent opening recognition over a game tree.
//
// useOpeningTrace walks the CURRENT path (root -> tree.current) and reports the
// DEEPEST openings-DB hit along it (window.api.openings.lookup; an EPD-keyed
// local table in the main process). Because the deepest hit on the path is
// reported rather than a per-position lookup, the opening name PERSISTS after
// the game leaves theory instead of vanishing: past that point the trace keeps
// the name with stillInBook=false and lastBookPly marking where theory ended.
//
// Lookups are cached per NODE ID in a ref (node fens are immutable, ids are
// unique per tree generation), so navigating back and forth across known nodes
// is free; only newly created nodes, or a whole new tree after reset(),
// touch the API. Everything degrades to "no opening" when the preload bridge
// is absent.

import { createElement as h, useEffect, useRef, useState, type ReactElement } from 'react'
import { BookOpen } from 'lucide-react'
import type { OpeningInfo } from '@shared/types'
import type { GameTree, TreeNode } from '../state/gameTree'
import './opening-tag.css'

export interface OpeningTrace {
  /** Name of the deepest opening matched on the current path (sticky), or null. */
  name: string | null
  /** ECO code of that opening, or null when no opening matched. */
  eco: string | null
  /** Ply of the deepest book position on the path (0 = none, or the root). */
  lastBookPly: number
  /** True while the CURRENT position itself is a known book position. */
  stillInBook: boolean
}

const EMPTY_TRACE: OpeningTrace = { name: null, eco: null, lastBookPly: 0, stillInBook: false }

/**
 * Sticky opening identity for the line currently on the board.
 *
 * Resolution is asynchronous: new nodes show the deepest already-cached
 * ancestor hit until their own lookup lands (one IPC per new node, then
 * cached forever for that tree).
 */
export function useOpeningTrace(tree: GameTree): OpeningTrace {
  // node.id -> lookup result (null = position not in the openings table).
  const cacheRef = useRef<Map<string, OpeningInfo | null>>(new Map())
  // Ids with a lookup in flight (also absorbs StrictMode's double effect run).
  const pendingRef = useRef<Set<string>>(new Set())
  const rootIdRef = useRef<string | null>(null)
  // Bumped when an async lookup lands so the derivation below re-runs.
  const [, setResolved] = useState(0)

  const current = tree.current
  const rootId = tree.root.id

  useEffect(() => {
    const api = window.api?.openings
    if (!api) return // no preload bridge: trace stays empty
    // reset() renews every node id: drop the previous tree's cache.
    if (rootIdRef.current !== rootId) {
      rootIdRef.current = rootId
      cacheRef.current.clear()
      pendingRef.current.clear()
    }
    // Request every unresolved node on the path (normally just the newest one;
    // a loaded game enqueues its whole line once).
    for (let n: TreeNode | null = current; n; n = n.parent) {
      const id = n.id
      if (cacheRef.current.has(id) || pendingRef.current.has(id)) continue
      pendingRef.current.add(id)
      api
        .lookup(n.fen)
        .then(
          ({ opening }) => {
            // Ignore results for a tree that was reset while in flight.
            if (rootIdRef.current === rootId) cacheRef.current.set(id, opening)
          },
          () => {
            // The lookup is a local, deterministic table read: treat failure
            // as "not in book" rather than retry-looping.
            if (rootIdRef.current === rootId) cacheRef.current.set(id, null)
          }
        )
        .then(() => {
          pendingRef.current.delete(id)
          setResolved((v) => v + 1)
        })
    }
  }, [current, rootId])

  // Derive the trace: walking UP from the current node, the first cached hit
  // found is by construction the deepest one on the path.
  let deepest: { info: OpeningInfo; ply: number } | null = null
  for (let n: TreeNode | null = current; n; n = n.parent) {
    const hit = cacheRef.current.get(n.id)
    if (hit) {
      deepest = { info: hit, ply: n.ply }
      break
    }
  }
  if (!deepest) return EMPTY_TRACE
  return {
    name: deepest.info.name,
    eco: deepest.info.eco,
    lastBookPly: deepest.ply,
    stillInBook: deepest.ply === current.ply
  }
}

export interface OpeningTagProps {
  trace: OpeningTrace
  /** Mirrors MoveList's figurine mode for call-site symmetry. Opening names
   *  carry no SAN today, so it is accepted but currently has no effect. */
  figurine?: boolean
}

/**
 * Compact one-line opening identity for panel headers, e.g.
 * "Ruy Lopez: Berlin Defence · ECO C65 · book to move 8", or "· in book"
 * while the current position is still theory. Renders nothing until the trace
 * has a name. (This module is a .ts file, so the tiny DOM is built with
 * createElement rather than JSX.)
 */
export function OpeningTag(props: OpeningTagProps): ReactElement | null {
  const { trace } = props
  if (!trace.name) return null
  const eco = trace.eco ? `ECO ${trace.eco}` : null
  // lastBookPly 0 = a root position that is itself in book: there is no
  // meaningful "book to move N", so the status collapses to just the name.
  const book = trace.stillInBook
    ? 'in book'
    : trace.lastBookPly > 0
      ? `book to move ${Math.ceil(trace.lastBookPly / 2)}`
      : null
  const title = [trace.name, eco, book].filter(Boolean).join(' · ')
  return h(
    'div',
    { className: 'opening-tag', title },
    h(BookOpen, { size: 12, className: 'opening-tag-icon', 'aria-hidden': true }),
    h('span', { className: 'opening-tag-name' }, trace.name),
    eco && h('span', { className: 'opening-tag-eco num' }, eco),
    book && h('span', { className: `opening-tag-book${trace.stillInBook ? ' is-book' : ''}` }, book)
  )
}
