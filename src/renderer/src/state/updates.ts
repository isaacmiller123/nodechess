// Renderer-side update state. A tiny module singleton over window.api.updates.
// One snapshot for the whole app: the Settings → Updates card, the startup
// toast (components/UpdateToast) and the online lobby's mismatch hint all read
// the SAME status via useUpdates(), so a check kicked off anywhere updates
// everywhere. Main pushes changes on 'updates:status'; we also pull the
// initial snapshot once on first use.

import { useSyncExternalStore } from 'react'
import type { UpdateActionResult, UpdateStatus } from '@shared/types'

let status: UpdateStatus | null = null
const listeners = new Set<() => void>()
let inited = false

function emit(): void {
  for (const l of listeners) l()
}

function ensureInit(): void {
  if (inited) return
  inited = true
  const api = typeof window !== 'undefined' ? window.api?.updates : undefined
  if (!api) return
  api.onStatus((s) => {
    status = s
    emit()
  })
  void api
    .status()
    .then((s) => {
      // The push channel may already have delivered something fresher.
      if (!status) {
        status = s
        emit()
      }
    })
    .catch(() => {})
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Live update status, or null until the first snapshot lands (browser mock
 *  included: it just stays 'idle'). */
export function useUpdates(): UpdateStatus | null {
  ensureInit()
  return useSyncExternalStore(subscribe, () => status)
}

/** Manual "Check for updates". Resolves with the post-check status. */
export function checkForUpdates(): Promise<UpdateStatus | null> {
  const api = window.api?.updates
  if (!api) return Promise.resolve(null)
  return api.check().then((s) => {
    status = s
    emit()
    return s
  })
}

/** The "Update now" action: install (win, ready) / open the browser download
 *  (mac). See UpdateActionResult for what actually happened. */
export function applyUpdate(): Promise<UpdateActionResult> {
  const api = window.api?.updates
  if (!api) return Promise.resolve({ ok: false, action: 'none' as const })
  return api.download()
}
