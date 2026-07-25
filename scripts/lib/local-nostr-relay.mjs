// A minimal in-process Nostr relay for the A6 M1 live-slice smoke — the sanctioned
// "localhost signaling harness" that KEEPS the real trystero
// transport when public relays are rate-limited/flaky from bare node (they are:
// three peers in one process trip "you note too much"). It speaks exactly the
// slice of NIP-01 trystero's Nostr strategy uses — REQ/EVENT/CLOSE in, EVENT/
// EOSE/OK out — and simply FANS OUT every published event to every OTHER socket's
// matching subscriptions (client-side crypto + topic filtering do the rest). No
// storage, no auth: signaling only. werift still does the real WebRTC (ICE over
// 127.0.0.1 host candidates), so the transport under test is 100% real.
//
// Raw RFC-6455 because `ws` is not a dependency (node 26 ships only a WS client).
// Text frames only; handles 7/16/64-bit lengths, client masking, ping→pong, close.

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const acceptKey = (key) => createHash('sha1').update(key + WS_GUID).digest('base64')

/** Encode one server→client TEXT frame (unmasked, single fragment). */
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

/** Pull complete frames out of a socket's accumulated buffer. Returns
 *  { messages: string[], rest: Buffer, close: boolean } — partial trailing
 *  bytes stay in `rest` for the next chunk. */
function drainFrames(buf) {
  const messages = []
  let close = false
  let off = 0
  while (off + 2 <= buf.length) {
    const b0 = buf[off]
    const b1 = buf[off + 1]
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let p = off + 2
    if (len === 126) {
      if (p + 2 > buf.length) break
      len = buf.readUInt16BE(p)
      p += 2
    } else if (len === 127) {
      if (p + 8 > buf.length) break
      len = Number(buf.readBigUInt64BE(p))
      p += 8
    }
    let mask
    if (masked) {
      if (p + 4 > buf.length) break
      mask = buf.subarray(p, p + 4)
      p += 4
    }
    if (p + len > buf.length) break // frame not fully arrived yet
    let payload = buf.subarray(p, p + len)
    if (masked) {
      const out = Buffer.alloc(len)
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]
      payload = out
    }
    off = p + len
    if (opcode === 0x8) { close = true; break } // close
    else if (opcode === 0x9) continue // ping — caller could pong; harmless to skip for a closed test
    else if (opcode === 0x1 || opcode === 0x0) messages.push(payload.toString('utf8'))
  }
  return { messages, rest: buf.subarray(off), close }
}

/**
 * Start a local Nostr signaling relay. Returns { url, port, close, clients }.
 * `close()` stops the server + drops all sockets.
 */
export async function startLocalNostrRelay(port = 0, opts = {}) {
  const server = createServer()
  const dbg = opts.debug ? (...a) => console.log('[relay]', ...a) : () => {}
  /** socket → { buf, subs: Map<subId, Set<topic>> } */
  const clients = new Map()

  const send = (sock, arr) => {
    try { sock.write(encodeFrame(JSON.stringify(arr))) } catch { /* dead socket */ }
  }

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    if (!key) { socket.destroy(); return }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    )
    const state = { buf: Buffer.alloc(0), subs: new Map() }
    clients.set(socket, state)

    socket.on('data', (chunk) => {
      state.buf = Buffer.concat([state.buf, chunk])
      const { messages, rest, close } = drainFrames(state.buf)
      state.buf = rest
      for (const raw of messages) handleMessage(socket, state, raw)
      if (close) { clients.delete(socket); try { socket.end() } catch {} }
    })
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
  })

  const topicsOf = (filter) => {
    // trystero subscribes with a `#x` tag filter (the room topic); accept `#d` too.
    const out = new Set()
    for (const k of ['#x', '#d', '#t']) for (const v of filter?.[k] ?? []) out.add(v)
    return out
  }
  const eventTopics = (event) => {
    const out = new Set()
    for (const tag of event?.tags ?? []) if (['x', 'd', 't'].includes(tag[0])) out.add(tag[1])
    return out
  }

  function handleMessage(socket, state, raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    const type = msg[0]
    if (type === 'REQ') {
      const subId = msg[1]
      const topics = new Set()
      for (let i = 2; i < msg.length; i++) for (const t of topicsOf(msg[i])) topics.add(t)
      state.subs.set(subId, topics)
      dbg(`REQ sub ${subId.slice(0, 6)} topics=[${[...topics].map((t) => t.slice(0, 6))}]`)
      send(socket, ['EOSE', subId]) // no stored history — ephemeral signaling
    } else if (type === 'CLOSE') {
      state.subs.delete(msg[1])
    } else if (type === 'EVENT') {
      const event = msg[1]
      const topics = eventTopics(event)
      let fanout = 0
      // Fan out to every OTHER socket's subscriptions whose topic filter matches.
      for (const [sock, st] of clients) {
        if (sock === socket) continue
        for (const [subId, subTopics] of st.subs) {
          const match = subTopics.size === 0 || [...topics].some((t) => subTopics.has(t))
          if (match) { send(sock, ['EVENT', subId, event]); fanout++ }
        }
      }
      dbg(`EVENT kind=${event?.kind} topics=[${[...topics].map((t) => t.slice(0, 6))}] → fanout=${fanout}`)
      send(socket, ['OK', event?.id ?? '', true, ''])
    }
  }

  server.on('connection', () => dbg('tcp connection'))
  await new Promise((res) => server.listen(port, '127.0.0.1', res))
  const actualPort = server.address().port
  return {
    url: `ws://127.0.0.1:${actualPort}`,
    port: actualPort,
    clients,
    async close() {
      for (const sock of clients.keys()) { try { sock.destroy() } catch {} }
      clients.clear()
      await new Promise((res) => server.close(res))
    },
  }
}
