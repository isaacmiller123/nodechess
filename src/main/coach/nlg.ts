/**
 * Template-based NLG (docs/content-coaching.md §3.5).
 *
 * Slot-fill templates keyed by (verdict) x (primary motif). 3-5 surface variants
 * per cell, chosen by a DETERMINISTIC hash of (ply, fen) so wording varies
 * without an LLM yet stays reproducible. A guaranteed fallback always exists.
 *
 * All strings are authored FRESH for this project. No AGPL puzzleTheme.xml /
 * learn.xml text is copied. Verdict words and praise vocabulary are generic.
 */

import type { MotifKey } from './motifs'

export interface Slots {
  playedSan?: string
  bestSan?: string
  pieceName?: string
  square?: string
  attackerSan?: string
  targetName?: string
  evalBand?: string // already phrased: "equal" / "clearly better" / "with a forced mate in 3"
  evalBefore?: string
  evalAfter?: string
  motifDetail?: string
  n?: string
  pvNarration?: string
}

export type Verdict = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'mateLost' | 'mateCreated'

/** Deterministic 32-bit FNV-1a hash of a string. */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Pick a deterministic variant for a (ply, fen) key. */
export function pickVariant<T>(variants: T[], ply: number, fen: string): T {
  if (variants.length === 0) throw new Error('pickVariant: empty variants')
  const idx = hash32(`${ply}|${fen}`) % variants.length
  return variants[idx]
}

/** Fill `{slot}` placeholders; drop the sentence-safe way if a slot is missing. */
export function fill(template: string, slots: Slots): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = (slots as Record<string, string | undefined>)[key]
    return v ?? ''
  })
}

/** Capitalize, collapse double spaces, ensure terminal punctuation. */
export function tidy(text: string): string {
  let t = text.replace(/\s+/g, ' ').replace(/\s+([.!,?])/g, '$1').trim()
  if (t.length === 0) return t
  t = t.charAt(0).toUpperCase() + t.slice(1)
  if (!/[.!?]$/.test(t)) t += '.'
  return t
}

/**
 * Template table: cell key = `${verdict}:${motif}`. Each cell has variants.
 * A cell describes a BAD played move (verdict mistake/blunder/inaccuracy) by
 * referencing what went wrong, or a GOOD move (best/good) by explaining the
 * idea behind the best move.
 */
const CELLS: Record<string, string[]> = {
  // --- bad move walked into / allowed a motif against the mover ---
  'blunder:hangingPiece': [
    'Blunder. After {playedSan}, your {pieceName} on {square} is left hanging: {bestSan} keeps the position {evalBand}.',
    'Blunder. {playedSan} drops the {pieceName} on {square} for nothing. {bestSan} stays {evalBand}.',
    'Blunder. {playedSan} leaves the {pieceName} on {square} undefended. {bestSan} was best, staying {evalBand}.'
  ],
  'mistake:hangingPiece': [
    'Mistake. {playedSan} hangs the {pieceName} on {square}; {bestSan} would have kept things {evalBand}.',
    'Mistake. After {playedSan} the {pieceName} on {square} can simply be taken. Better was {bestSan} ({evalBand}).'
  ],
  'blunder:fork': [
    'Blunder. {playedSan} walks into a fork on the {targetName}. {bestSan} was best, staying {evalBand}.',
    'Blunder. After {playedSan} comes a fork winning the {targetName}; {bestSan} avoids it and stays {evalBand}.'
  ],
  'mistake:fork': [
    'Mistake. {playedSan} allows a fork hitting the {targetName}. {bestSan} keeps it {evalBand}.',
    'Mistake. {playedSan} runs into a fork on the {targetName}; {bestSan} was safer ({evalBand}).'
  ],
  'blunder:mate': [
    'Blunder. {playedSan} allows a forced mate. {bestSan} was best, staying {evalBand}.',
    'Blunder. After {playedSan} there is a forced checkmate. {bestSan} holds, {evalBand}.'
  ],
  // --- best/good move: explain the idea ---
  'best:fork': [
    '{bestSan}! The {pieceName} forks the {targetName}: you win material and end up {evalBand}.',
    '{bestSan}! A fork hitting the {targetName}; material falls and you are {evalBand}.',
    '{bestSan} is best. The fork on the {targetName} wins material, leaving you {evalBand}.'
  ],
  'best:pin': [
    '{bestSan}! {motifDetail}, and you can pile up on it, staying {evalBand}.',
    '{bestSan} is best: {motifDetail}. That leaves you {evalBand}.'
  ],
  'best:skewer': [
    '{bestSan}! A skewer ({motifDetail}) winning material and leaving you {evalBand}.',
    '{bestSan} is best: {motifDetail}, so the piece behind falls and you are {evalBand}.'
  ],
  'best:hangingPiece': [
    '{bestSan}! It simply wins {motifDetail}, leaving you {evalBand}.',
    '{bestSan} is best, grabbing {motifDetail} for free and staying {evalBand}.'
  ],
  'best:deflection': [
    '{bestSan}! A deflection that {motifDetail}, and the rest follows. You end up {evalBand}.',
    '{bestSan} is best: it {motifDetail}, leaving you {evalBand}.'
  ],
  'best:interference': [
    '{bestSan}! An interference ({motifDetail}) and material falls, leaving you {evalBand}.',
    '{bestSan} is best: {motifDetail}, cutting the defence and staying {evalBand}.'
  ],
  'best:overloaded': [
    '{bestSan}! It punishes an overloaded defender: {motifDetail}. Leaving you {evalBand}.',
    '{bestSan} is best: {motifDetail}, so something must give and you are {evalBand}.'
  ],
  'best:capturingDefender': [
    '{bestSan}! By {motifDetail}, the piece behind it falls, leaving you {evalBand}.',
    '{bestSan} is best: {motifDetail}, then you collect material and stay {evalBand}.'
  ],
  'best:discoveredAttack': [
    '{bestSan}! A discovered attack springs the piece behind. You end up {evalBand}.',
    '{bestSan} is best: the discovery wins material, leaving you {evalBand}.'
  ],
  'best:discoveredCheck': [
    '{bestSan}! A discovered check, and you collect material, ending up {evalBand}.',
    '{bestSan} is best: the discovered check lands and you are {evalBand}.'
  ],
  'best:doubleCheck': [
    '{bestSan}! Double check. Only the king can move, and you are {evalBand}.',
    '{bestSan} is best: a double check the king cannot answer, leaving you {evalBand}.'
  ],
  'best:backRankMate': [
    '{bestSan}! The back rank is fatal, {evalBand}.',
    '{bestSan} is best: a back-rank mate, {evalBand}.'
  ],
  'best:xRay': [
    '{bestSan}! An x-ray ({motifDetail}) leaving you {evalBand}.',
    '{bestSan} is best: {motifDetail}, and you stay {evalBand}.'
  ],
  // --- mate-specific verdicts ---
  'mateLost:mate': [
    'Blunder. {playedSan} throws away a forced mate: {bestSan} was mating.',
    'Blunder. {playedSan} lets the win slip; {bestSan} forced mate.'
  ],
  'mateCreated:mate': [
    'Blunder. {playedSan} allows a forced mate against you. {bestSan} was best, staying {evalBand}.',
    'Blunder. After {playedSan} you are mated; {bestSan} would have held ({evalBand}).'
  ]
}

/** Generic per-verdict fallbacks when no motif fired. */
const GENERIC: Record<Verdict, string[]> = {
  best: [
    '{bestSan} is the strongest move here, keeping you {evalBand}.{pvNarration}',
    '{bestSan} was best, leaving you {evalBand}.{pvNarration}'
  ],
  good: [
    '{playedSan} is fine: {bestSan} was the engine pick, keeping you {evalBand}.',
    'A solid move. {bestSan} was best, staying {evalBand}.'
  ],
  inaccuracy: [
    'Inaccuracy. {playedSan} leaves you {evalBand}; {bestSan} kept more pressure.{pvNarration}',
    'Slightly inaccurate. {bestSan} was a touch better, staying {evalBand}.'
  ],
  mistake: [
    'Mistake. {playedSan} slips to {evalBand}; {bestSan} was clearly better.{pvNarration}',
    'Mistake. {bestSan} was best here: {playedSan} leaves you {evalBand}.'
  ],
  blunder: [
    'Blunder. {playedSan} leaves you {evalBand}. {bestSan} was best.{pvNarration}',
    'Blunder. {bestSan} was the move. After {playedSan} you are {evalBand}.{pvNarration}'
  ],
  mateLost: ['Blunder. {playedSan} throws away a forced mate. {bestSan} was mating.'],
  mateCreated: ['Blunder. {playedSan} allows a forced mate. {bestSan} was best, staying {evalBand}.']
}

/** The absolute last-resort template, always valid. */
const HARD_FALLBACK = '{bestSan} was the strongest move here.'

export interface RenderArgs {
  verdict: Verdict
  motif: MotifKey | null
  slots: Slots
  ply: number
  fen: string
}

/**
 * Render the coaching sentence. Tries the (verdict x motif) cell, then a
 * per-verdict generic, then the hard fallback. Deterministic variant choice.
 */
export function render(args: RenderArgs): string {
  const { verdict, motif, slots, ply, fen } = args
  let template: string | null = null
  if (motif) {
    const cell = CELLS[`${verdict}:${motif}`]
    if (cell && cell.length) template = pickVariant(cell, ply, fen)
  }
  if (!template) {
    const generic = GENERIC[verdict]
    if (generic && generic.length) template = pickVariant(generic, ply, fen)
  }
  if (!template) template = HARD_FALLBACK
  const body = fill(template, slots)
  const tidied = tidy(body)
  return tidied.length > 3 ? tidied : tidy(fill(HARD_FALLBACK, slots))
}

/** Prefix the eval transition like "(+3.1 → +0.2) ". */
export function evalPrefix(before: string, after: string): string {
  return `(${before} → ${after}) `
}
