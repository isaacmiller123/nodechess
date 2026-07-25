// Relay reachability probe for internet multiplayer (v2).
//
//   node scripts/check-relays.mjs
//
// Multiplayer v2 discovers peers over trystero's Nostr strategy (a pool of public
// wss:// relays) and traverses NAT with STUN/TURN. Neither is run by us, so this
// script answers one operational question: from THIS machine, right now, can we
// reach enough of that infrastructure for a game to connect?
//
//   1. NOSTR RELAYS: the exact default relay list trystero ships (imported from
//      the installed package, never hard-coded here, so it can't drift). For each
//      we open a WebSocket (node 26 has a global WebSocket, no `ws` dep), send a
//      minimal Nostr REQ, and count it reachable on ANY frame back (EVENT / EOSE /
//      NOTICE / anything). 5s timeout, all in parallel.
//   2. TURN HOSTS: the TURN hostnames parsed straight out of rtcTransport.ts's
//      ICE_SERVERS. We can't do a real TURN allocation without a UDP/ICE stack, so
//      we TCP-probe host:443 and host:80 (a TURN server listening there answers the
//      TCP handshake). 4s timeout each.
//
// Signaling only needs a couple of working relays, so: exit 0 if ≥2 Nostr relays
// are reachable, else exit 1. TURN reachability is reported but never gates the
// exit (STUN alone connects the vast majority of NATs; TURN is a best-effort
// fallback and openrelay is frequently rate-limited/down).

// Mute node's noisy "WebSocket over HTTP2 is experimental" warning so the probe
// table stays readable (the WS client works fine; the warning is just chatter).
process.removeAllListeners('warning')
process.on('warning', (w) => {
  if (!/WebSocket over HTTP2/.test(w.message)) console.warn(w)
})

import net from 'node:net'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// 10s (not 5s): node's global WebSocket negotiates HTTP/2 and its TLS handshakes
// to these relays are slow under parallel load. A raw TCP connect is instant but
// the TLS+WS upgrade routinely takes 2–6s here. The app holds relays open
// persistently so a slow first handshake is a non-issue; 5s produced false
// "down"s for relays that are genuinely reachable (verified by hand). TURN is a
// plain TCP probe and stays snappy.
const RELAY_TIMEOUT_MS = 10_000
const TURN_TIMEOUT_MS = 4_000

// ---- 1. the Nostr relay list, imported from the installed trystero -----------
// trystero re-exports its Nostr default relay URLs; pull them from the package so
// this probe always tests exactly what the app will use.
let RELAYS = []
try {
  const nostr = await import('trystero/nostr')
  RELAYS = Array.isArray(nostr.defaultRelayUrls) ? nostr.defaultRelayUrls.slice() : []
} catch (e) {
  console.error(`Could not import trystero/nostr defaultRelayUrls: ${e.message}`)
}
if (RELAYS.length === 0) {
  console.error('No Nostr relay URLs found. Is trystero installed? Aborting.')
  process.exit(1)
}

// ---- 2. TURN hostnames, parsed out of rtcTransport.ts ------------------------
function parseTurnHosts() {
  const file = resolve(ROOT, 'src/renderer/src/features/play/online/rtcTransport.ts')
  let src = ''
  try {
    src = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  // Match turn:host[:port][?transport=...] and keep the bare hostname.
  const hosts = new Set()
  const re = /turns?:([a-zA-Z0-9.-]+)(?::\d+)?/g
  let m
  while ((m = re.exec(src))) hosts.add(m[1])
  return [...hosts]
}
const TURN_HOSTS = parseTurnHosts()

// ---- Nostr relay probe -------------------------------------------------------
function probeRelay(url) {
  return new Promise((resolve) => {
    const started = Date.now()
    let ws
    let done = false
    const finish = (ok, note) => {
      if (done) return
      done = true
      try {
        ws && ws.close()
      } catch {
        /* ignore */
      }
      resolve({ url, ok, ms: Date.now() - started, note })
    }
    const timer = setTimeout(() => finish(false, 'timeout'), RELAY_TIMEOUT_MS)
    timer.unref?.()
    try {
      ws = new WebSocket(url)
    } catch (e) {
      clearTimeout(timer)
      return finish(false, `ctor: ${e.message}`)
    }
    ws.onopen = () => {
      // Minimal Nostr REQ: ask for one kind-0 (metadata) event. Any relay answers
      // with an EVENT and/or an EOSE: we only need a single frame to prove reach.
      try {
        ws.send(JSON.stringify(['REQ', 'chk', { kinds: [0], limit: 1 }]))
      } catch {
        /* the message handler / timeout will still resolve */
      }
    }
    ws.onmessage = () => {
      clearTimeout(timer)
      finish(true, 'reply')
    }
    ws.onerror = (ev) => {
      clearTimeout(timer)
      finish(false, `error${ev && ev.message ? `: ${ev.message}` : ''}`)
    }
    ws.onclose = () => {
      // A close BEFORE any message means it never answered.
      clearTimeout(timer)
      finish(false, 'closed')
    }
  })
}

// ---- TURN TCP probe (host:443, then host:80) ---------------------------------
function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const started = Date.now()
    const sock = net.connect({ host, port, timeout: TURN_TIMEOUT_MS })
    let done = false
    const finish = (ok, note) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve({ ok, ms: Date.now() - started, note, port })
    }
    sock.once('connect', () => finish(true, `tcp:${port}`))
    sock.once('timeout', () => finish(false, 'timeout'))
    sock.once('error', (e) => finish(false, e.code || e.message))
  })
}
async function probeTurn(host) {
  // 443 first (works through most firewalls); fall back to 80.
  const a = await tcpProbe(host, 443)
  if (a.ok) return { host, ...a }
  const b = await tcpProbe(host, 80)
  return { host, ...(b.ok ? b : a) }
}

// ---- run ---------------------------------------------------------------------
console.log(`Probing ${RELAYS.length} Nostr relays (${RELAY_TIMEOUT_MS / 1000}s timeout) …\n`)
const relayResults = await Promise.all(RELAYS.map(probeRelay))
relayResults.sort((a, b) => Number(b.ok) - Number(a.ok) || a.ms - b.ms)

const pad = (s, n) => String(s).padEnd(n)
console.log(pad('relay', 44), pad('status', 8), 'note')
console.log('-'.repeat(70))
for (const r of relayResults) {
  console.log(pad(r.url.replace(/^wss:\/\//, ''), 44), pad(r.ok ? '✓ OK' : '✗ down', 8), `${r.ms}ms ${r.note}`)
}
const relaysOk = relayResults.filter((r) => r.ok).length

let turnOk = 0
if (TURN_HOSTS.length) {
  console.log(`\nProbing ${TURN_HOSTS.length} TURN hosts (TCP 443/80, ${TURN_TIMEOUT_MS / 1000}s) …\n`)
  const turnResults = await Promise.all(TURN_HOSTS.map(probeTurn))
  console.log(pad('turn host', 44), pad('status', 8), 'note')
  console.log('-'.repeat(70))
  for (const t of turnResults) {
    console.log(pad(t.host, 44), pad(t.ok ? '✓ OK' : '✗ down', 8), `${t.ms}ms ${t.note}`)
  }
  turnOk = turnResults.filter((t) => t.ok).length
}

console.log(
  `\nRELAYS OK ${relaysOk}/${relayResults.length} reachable, TURN ${turnOk}/${TURN_HOSTS.length} reachable`
)
if (relaysOk >= 2) {
  console.log('✅ Signaling is viable from this machine (≥2 relays reachable).')
  process.exit(0)
} else {
  console.log('❌ Fewer than 2 Nostr relays reachable: signaling may fail from this network.')
  process.exit(1)
}
