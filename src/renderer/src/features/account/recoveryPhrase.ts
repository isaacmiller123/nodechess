/**
 * Recovery-phrase input: everything that can be decided WITHOUT touching the
 * key material, decided here.
 *
 * The point of this file is that a mistyped phrase costs nothing. Key
 * derivation, storage reads and the network are all downstream of it, so a
 * phrase that cannot possibly be right is rejected before any of that runs and
 * the person is told which part is wrong in the same breath.
 *
 * Pure: no React, no DOM, no storage, no clock. The word list is the BIP39
 * english list the export itself is written from, so "not one of the words" is
 * a fact about the phrase, not a guess.
 */

import { wordlist } from '@scure/bip39/wordlists/english.js'
import { validateMnemonic } from '@scure/bip39'

/** A recovery phrase is the 32-byte seed, which is exactly this many words. */
export const PHRASE_WORDS = 24

const WORDS = new Set<string>(wordlist)

/**
 * Split what someone typed or pasted into words. Tolerant on purpose: paper is
 * copied with stray capitals, line breaks, tabs and double spaces, and none of
 * those are mistakes worth failing over.
 */
export function phraseWords(raw: string): string[] {
  const t = raw.normalize('NFKD').trim().toLowerCase()
  return t === '' ? [] : t.split(/\s+/)
}

export type PhraseProblem =
  | { kind: 'empty' }
  | { kind: 'count'; count: number }
  | { kind: 'word'; position: number; word: string }
  | { kind: 'checksum' }

export interface PhraseCheck {
  words: string[]
  /** The canonical single-spaced phrase, only when there is no problem. */
  normalized: string | null
  problem: PhraseProblem | null
}

/**
 * The whole pre-flight, in reading order: is there anything, is it the right
 * length, is every word a real one, and do the words check out together.
 *
 * Order matters. Reporting "not a valid phrase" when the real fault is that
 * word nine is spelled wrong sends someone back to check all 24.
 */
export function checkPhrase(raw: string): PhraseCheck {
  const words = phraseWords(raw)
  if (words.length === 0) return { words, normalized: null, problem: { kind: 'empty' } }
  if (words.length !== PHRASE_WORDS)
    return { words, normalized: null, problem: { kind: 'count', count: words.length } }
  for (let i = 0; i < words.length; i++) {
    if (!WORDS.has(words[i]))
      return {
        words,
        normalized: null,
        problem: { kind: 'word', position: i + 1, word: words[i] },
      }
  }
  const normalized = words.join(' ')
  if (!validateMnemonic(normalized, wordlist))
    return { words, normalized: null, problem: { kind: 'checksum' } }
  return { words, normalized, problem: null }
}

/**
 * What to say. Plain, specific, and never about how any of it works
 * underneath: nothing here mentions checksums, seeds, entropy or BIP39.
 */
export function phraseProblemMessage(p: PhraseProblem): string {
  switch (p.kind) {
    case 'empty':
      return 'Enter your recovery phrase.'
    case 'count':
      return p.count < PHRASE_WORDS
        ? `That is ${p.count} word${p.count === 1 ? '' : 's'}. A recovery phrase is ${PHRASE_WORDS}.`
        : `That is ${p.count} words. A recovery phrase is ${PHRASE_WORDS}.`
    case 'word':
      return `Word ${p.position}, "${p.word}", is not one of the recovery words. Check that one.`
    case 'checksum':
      return 'Those 24 words are not a recovery phrase. Check the spelling and the order.'
  }
}
