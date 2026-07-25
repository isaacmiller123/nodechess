import { INITIAL_FEN } from '../chess/chess'
import type { TreeNode } from './gameTree'

// Mainline PGN export (variations omitted for v0). Walks children[0] from root.
// Move numbering is derived from the ROOT position (so positions loaded from a
// custom FEN (including black-to-move) number correctly), and a [FEN]/[SetUp]
// tag pair is emitted for non-standard starts so a reader replays from the right
// position.
export function treeToPgn(root: TreeNode, headers: Record<string, string> = {}): string {
  const parts = root.fen.split(' ')
  const custom = root.fen !== INITIAL_FEN
  let num = Number.parseInt(parts[5] ?? '1', 10) || 1
  let whiteToMove = (parts[1] ?? 'w') === 'w'

  const allTags: Record<string, string> = custom
    ? { SetUp: '1', FEN: root.fen, ...headers }
    : { ...headers }
  const tags = Object.entries(allTags)
    .map(([k, v]) => `[${k} "${String(v).replace(/"/g, "'")}"]`)
    .join('\n')

  let movetext = ''
  let node = root
  let first = true
  while (node.children[0]) {
    const m = node.children[0]
    if (whiteToMove) movetext += `${num}. `
    else if (first) movetext += `${num}... `
    movetext += `${m.move?.san ?? ''} `
    if (!whiteToMove) num += 1
    whiteToMove = !whiteToMove
    first = false
    node = m
  }

  const result = headers.Result ?? '*'
  const body = `${movetext.trim()} ${result}`.trim()
  return (tags ? `${tags}\n\n` : '') + body + '\n'
}
