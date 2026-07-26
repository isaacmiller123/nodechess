/**
 * "I have written it down", remembered per account, on this device.
 *
 * v1's account page flips the readout's NEXT slot on that click, and a flag
 * held in component state would put "Save your recovery phrase" back on the
 * strip every time the view remounts. The answer is local: another device
 * holding the same account has its own copy of the phrase to write down, so
 * this is a device fact and never goes near the chain. Stored under the same
 * key convention as the shell's own chrome state (nc.rail).
 */

import { useSyncExternalStore } from 'react'

const KEY = 'nc.account.recovery.saved.v1'

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

let saved = load()
const listeners = new Set<() => void>()

/** Has the phrase for this account been marked written down on this device? */
export function recoverySaved(rootPub: string | null): boolean {
  return rootPub !== null && saved.has(rootPub)
}

export function markRecoverySaved(rootPub: string): void {
  if (saved.has(rootPub)) return
  saved = new Set(saved).add(rootPub)
  try {
    localStorage.setItem(KEY, JSON.stringify([...saved]))
  } catch {
    /* storage may be unavailable; the flag then lasts for this session only */
  }
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** React bridge. House useSyncExternalStore convention; the snapshot is a
 *  boolean, so identity comparison is stable without any caching. */
export function useRecoverySaved(rootPub: string | null): boolean {
  const read = (): boolean => recoverySaved(rootPub)
  return useSyncExternalStore(subscribe, read, read)
}
