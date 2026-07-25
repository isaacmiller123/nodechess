// The renderer-wide multiplayer singleton the UI imports. Binds the pure session
// authority (MpNetSession) to the real trystero/WebRTC transport. Import `mp`
// anywhere in the renderer to host/join and drive an internet game.

import { MpNetSession, type MpSigningConfig } from './mpSession'
import { createRtcTransport } from './rtcTransport'
import { deviceSigningKey } from '../../../../../web/accounts'

export const mp = new MpNetSession(createRtcTransport)

/**
 * A6 (Lane C): the signed-in device's signing config for v6 signed RATED play,
 * or null when signed out (⇒ casual/unsigned). `deviceSigningKey()` already
 * returns `{priv,key,root}`, a structural `MpSigningConfig` (the per-game
 * `oppRoot` pin is added by the matchmaker later). The app boot wires this into
 * the store as its signing-key provider, next to the sound-sink registration:
 *
 *   onlineStore.setSigningKeyProvider(mpSigningKey)   // useOnlineGame.ts
 *
 * It lives HERE, renderer-only, beside `mp`. ON PURPOSE: the bare-node store
 * test mocks this whole module, so `onlineStore` never statically bundles the
 * accounts/argon2/ed25519 stack, and casual play never pays for it.
 */
export function mpSigningKey(): MpSigningConfig | null {
  return deviceSigningKey()
}
