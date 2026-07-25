// In-page entry for the browser TURN proof (scripts/smoke-turn-browser.mjs).
// Uses the SAME native-WebRTC transport the production app uses: this repo's
// trystero fork over the browser's native RTCPeerConnection (NO werift), with
// the EXACT room API browserFabric.ts / acceptancePeerWorker.ts use,
// makeAction(ns,{kind:'message',onMessage}) → {send}; onPeerJoin is an
// assignable property; relays via relayConfig:{urls,redundancy}. ICE is forced
// relay-only (iceTransportPolicy:'relay') so host + srflx candidates are
// FORBIDDEN: ALL media MUST transit the configured TURN server. Signaling
// rides real public Nostr relays. window.__CFG is injected by the served HTML.
import { joinRoom } from 'trystero'

const cfg = window.__CFG
window.__got = []
window.__ready = false
window.__connected = false
window.__err = null

try {
  const room = joinRoom(
    {
      appId: cfg.appId,
      relayConfig: { urls: cfg.relayUrls, redundancy: cfg.relayUrls.length },
      rtcConfig: { iceServers: cfg.iceServers, iceTransportPolicy: 'relay' },
    },
    cfg.roomId,
  )

  const action = room.makeAction('t', {
    kind: 'message',
    onMessage: (data) => {
      window.__connected = true
      window.__got.push(typeof data === 'string' ? data : JSON.stringify(data))
    },
  })

  const fire = () => {
    for (let i = 0; i < 2; i++) action.send(`hello-from-${cfg.role}#${i}`)
  }
  // onPeerJoin is an assignable hook on this fork's room (see acceptancePeerWorker).
  room.onPeerJoin = (id) => {
    window.__connected = true
    window.__peer = id
    fire()
  }
  // Heartbeat so both directions are covered even if one onPeerJoin is missed.
  // A broadcast reaches any peer whose relay-only channel is up.
  setInterval(fire, 2500)

  window.__ready = true
} catch (e) {
  window.__err = String((e && e.stack) || e)
}
