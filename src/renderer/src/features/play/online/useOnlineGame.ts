// useOnlineGame: the React binding for the module-level onlineStore.
//
// The store lives OUTSIDE React (onlineStore.ts) so a live game survives any
// component unmount (navigating away and back re-attaches; MP-01/L2). This hook
// is the only bridge: useSyncExternalStore subscribes to the store's snapshot,
// so a component re-renders exactly when the store notifies. No polling, no
// stale closures, and concurrent-mode safe.
//
// It also PUSHES the live settings the store can't read from React context.
// The username (PGN/name headers) and the low-time-warning gate. Into the store
// whenever they change. And it wires the store's SOUND SINK (see the seam note in
// onlineStore.ts): the store can't import the Vite-glob SoundManager itself, so
// this module (which only ever loads in the real renderer, never bare node)
// registers the singleton's play() once, at module load.

import { useEffect, useSyncExternalStore } from 'react'
import { getSoundManager } from '../../../sound/SoundManager'
import { useSettings } from '../../../state/settings'
import { onlineStore, type OnlineState } from './onlineStore'
// A6 M1, LEAD INTEGRATION side-effect: wire the live account net (signing-key
// provider + segment publisher + per-client account peer on sign-in + the dev/ops
// witness surface). It registers on the store and starts the peer ONLY when
// signed in: casual/signed-out play is a byte-identical no-op. Renderer-only, so
// the bare-node store test (which mocks `mp`) never loads it. See the module head.
import '../../account/net/accountNetBoot'

// One-time sound-sink registration (app lifetime, like the store's mp.onEvent
// subscription). play() itself gates on the manager's enabled/volume settings.
// The A6 account-net registrations (signing-key provider, segment publisher, the
// account peer, the witness surface) ride the side-effect import above.
onlineStore.setSoundSink((name) => getSoundManager().play(name))

// Debug/preview handle: the renderer-preview harness (browser, no electron;
// see devMock.ts) drives the store's event pump through this to render online
// screens without a live peer. Renderer-only module, so bare-node tests never
// see it; harmless in production (same power as devtools already has).
;(globalThis as { __onlineStore?: typeof onlineStore }).__onlineStore = onlineStore

/** Subscribe to the live online-game snapshot. Re-renders on every store change. */
export function useOnlineGame(): OnlineState {
  const state = useSyncExternalStore(
    (cb) => onlineStore.subscribe(cb),
    () => onlineStore.getState(),
    () => onlineStore.getState()
  )

  // Keep the store's settings snapshot in sync with the live prefs. Cheap: it
  // only runs when username or lowTimeWarning actually change.
  const { settings } = useSettings()
  useEffect(() => {
    onlineStore.setSettings({
      username: settings.username,
      lowTimeWarning: settings.lowTimeWarning
    })
  }, [settings.username, settings.lowTimeWarning])

  return state
}

/** Re-export the store so views can call actions without a second import. The
 *  hook gives state; the store gives host/join/playMove/resign/… (§4). */
export { onlineStore }
