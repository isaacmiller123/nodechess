import { useCallback, useMemo, useRef, useState } from 'react'
import { INITIAL_FEN, type AppliedMove } from '../chess/chess'

let counter = 0
const newId = (): string => `n${++counter}`

export interface MoveInfo {
  san: string
  uci: string
  capture: boolean
  check: boolean
}

export interface TreeNode {
  id: string
  ply: number // half-moves from root
  move?: MoveInfo // move that led here (undefined at root)
  fen: string
  parent: TreeNode | null
  children: TreeNode[] // children[0] is the mainline continuation
}

function makeRoot(fen: string): TreeNode {
  return { id: newId(), ply: 0, fen, parent: null, children: [] }
}

export interface GameTree {
  root: TreeNode
  current: TreeNode
  currentFen: string
  pathIds: Set<string>
  canPrev: boolean
  canNext: boolean
  addMove: (m: AppliedMove) => void
  goTo: (id: string) => void
  prev: () => void
  next: () => void
  first: () => void
  last: () => void
  reset: (fen?: string) => void
  /**
   * TAKEBACK SUPPORT (additive; every existing member is untouched): remove
   * the last `n` mainline plies at the TIP of the mainline (the children[0]
   * chain from the root), regardless of where `current` points. The removed
   * subtree (including any variations hanging off the removed nodes) is
   * forgotten, and `current` jumps to the new tip. No-ops when n <= 0 or the
   * mainline is already at (or shorter than) the requested cut. Play's game
   * tree is strictly linear; if a caller ever had variations at the cut node,
   * the next sibling would inherit mainline status (documented, not used).
   */
  undoPlies: (n: number) => void
}

export function useGameTree(initialFen: string = INITIAL_FEN): GameTree {
  const rootRef = useRef<TreeNode>(makeRoot(initialFen))
  const mapRef = useRef<Map<string, TreeNode>>(new Map([[rootRef.current.id, rootRef.current]]))
  const [currentId, setCurrentId] = useState(rootRef.current.id)
  const [, bump] = useState(0)
  const rerender = () => bump((n) => n + 1)

  const current = mapRef.current.get(currentId) ?? rootRef.current

  const pathIds = useMemo(() => {
    const ids = new Set<string>()
    let n: TreeNode | null = current
    while (n) {
      ids.add(n.id)
      n = n.parent
    }
    return ids
  }, [current])

  const addMove = useCallback(
    (m: AppliedMove) => {
      const node = mapRef.current.get(currentId) ?? rootRef.current
      let child = node.children.find((c) => c.move?.uci === m.uci)
      if (!child) {
        child = {
          id: newId(),
          ply: node.ply + 1,
          move: { san: m.san, uci: m.uci, capture: m.capture, check: m.check },
          fen: m.fen,
          parent: node,
          children: []
        }
        node.children.push(child)
        mapRef.current.set(child.id, child)
      }
      setCurrentId(child.id)
    },
    [currentId]
  )

  const goTo = useCallback((id: string) => {
    if (mapRef.current.has(id)) setCurrentId(id)
  }, [])

  const prev = useCallback(() => {
    const n = mapRef.current.get(currentId)
    if (n?.parent) setCurrentId(n.parent.id)
  }, [currentId])

  const next = useCallback(() => {
    const n = mapRef.current.get(currentId)
    if (n?.children[0]) setCurrentId(n.children[0].id)
  }, [currentId])

  const first = useCallback(() => setCurrentId(rootRef.current.id), [])

  const last = useCallback(() => {
    let n = mapRef.current.get(currentId) ?? rootRef.current
    while (n.children[0]) n = n.children[0]
    setCurrentId(n.id)
  }, [currentId])

  const undoPlies = useCallback((n: number) => {
    if (n <= 0) return
    // Find the mainline tip, then the node n plies above it (clamped at root).
    let tip = rootRef.current
    while (tip.children[0]) tip = tip.children[0]
    let target: TreeNode = tip
    for (let i = 0; i < n && target.parent; i++) target = target.parent
    const drop = target.children[0]
    if (!drop) return // nothing below the cut. Already the tip
    target.children.splice(0, 1)
    // Forget every removed node so goTo can never resurrect a cut position.
    const stack: TreeNode[] = [drop]
    while (stack.length > 0) {
      const node = stack.pop() as TreeNode
      mapRef.current.delete(node.id)
      for (const c of node.children) stack.push(c)
    }
    setCurrentId(target.id)
    // The root object is mutated in place; force a re-read even when `current`
    // already sat on the new tip (same discipline as reset()).
    rerender()
  }, [])

  const reset = useCallback((fen: string = INITIAL_FEN) => {
    const root = makeRoot(fen)
    rootRef.current = root
    mapRef.current = new Map([[root.id, root]])
    setCurrentId(root.id)
    rerender()
  }, [])

  return {
    root: rootRef.current,
    current,
    currentFen: current.fen,
    pathIds,
    canPrev: current.parent !== null,
    canNext: current.children.length > 0,
    addMove,
    goTo,
    prev,
    next,
    first,
    last,
    reset,
    undoPlies
  }
}
