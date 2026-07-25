// Service receipts (src/shared/accounts/receipts.ts).
//
//   node scripts/test-accounts-receipts.mjs
//
// The property under test is the one the seam exists for: a node cannot mint
// evidence of its own usefulness. Everything else is shape/replay hygiene.

import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { bundleFixture } from './lib/accounts-fixture.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

let passed = 0
let failures = 0
function ok(cond, msg) {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.log(`  ✗ ${msg}`)
  }
}
const eq = (a, b, msg) =>
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/receipts-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
  try {
    const entry = resolve(outdir, 'entry.ts')
    writeFileSync(entry, `export * from '@shared/accounts'\n`)
    const out = resolve(outdir, 'bundle.mjs')
    await bundleFixture(entry, out, 'node')
    const A = await import(pathToFileURL(out).href)

    const kp = (b) => {
      const priv = new Uint8Array(32).fill(b)
      const pub = A.ed25519.getPublicKey(priv)
      return { priv, pub, pubB: A.toB64u(pub) }
    }
    const server = kp(1)
    const client = kp(2)
    const NOW = 1_700_000_000_000
    const bodyOf = (over = {}) => ({
      v: 1,
      server: server.pubB,
      client: client.pubB,
      kind: 'shard-read',
      bytes: 4096,
      ts: NOW,
      ...over,
    })

    console.log('· signing + verification …')
    const r = A.signServiceReceipt(bodyOf(), client.pubB, client.priv)
    ok(A.verifyServiceReceipt(r), 'a client-signed receipt verifies')
    ok(!A.verifyServiceReceipt({ ...r, sig: A.toB64u(new Uint8Array(64)) }), 'a bad signature is rejected')
    ok(
      !A.verifyServiceReceipt({ ...r, body: { ...r.body, bytes: 999_999 } }),
      'tampering with the byte count breaks the signature',
    )

    console.log('\n· the point: a server cannot sign its own receipts …')
    {
      // The server holds its OWN key, so it can produce a well-formed, correctly
      // signed object — but only ever with itself as client, which is refused.
      const selfDealt = A.signServiceReceipt(
        bodyOf({ client: server.pubB }),
        server.pubB,
        server.priv,
      )
      ok(!A.verifyServiceReceipt(selfDealt), 'server === client is refused even with a valid signature')

      // Forging a receipt from a real client needs that client's key.
      let forged = null
      try {
        forged = A.signServiceReceipt(bodyOf(), client.pubB, server.priv)
      } catch {
        /* expected: priv/key disagreement is caught at signing time */
      }
      eq(forged, null, "a server cannot sign as a client it doesn't hold the key for")
    }

    console.log('\n· bounds + shape …')
    {
      let threw = false
      try {
        A.signServiceReceipt(bodyOf({ bytes: A.MAX_RECEIPT_BYTES + 1 }), client.pubB, client.priv)
      } catch {
        threw = true
      }
      ok(threw, 'a receipt over MAX_RECEIPT_BYTES is refused at signing')
      let negThrew = false
      try {
        A.signServiceReceipt(bodyOf({ bytes: -1 }), client.pubB, client.priv)
      } catch {
        negThrew = true
      }
      ok(negThrew, 'a negative byte count is refused')
      ok(!A.verifyServiceReceipt({ ...r, body: { ...r.body, kind: 'flattery' } }), 'an unknown kind is rejected')
    }

    console.log('\n· creditedBytes: replay + hostile bundles …')
    {
      const other = kp(3)
      const r2 = A.signServiceReceipt(bodyOf({ ts: NOW + 1 }), client.pubB, client.priv)
      eq(A.creditedBytes(server.pubB, [r, r2]), 8192, 'two distinct receipts sum')
      eq(A.creditedBytes(server.pubB, [r, r, r, r2]), 8192, 'a replayed receipt is counted once')
      eq(
        A.creditedBytes(server.pubB, [r, { ...r, sig: A.toB64u(new Uint8Array(64)) }]),
        4096,
        'an invalid receipt contributes zero rather than poisoning the total',
      )
      const forOther = A.signServiceReceipt(bodyOf({ server: other.pubB }), client.pubB, client.priv)
      eq(A.creditedBytes(server.pubB, [r, forOther]), 4096, "another server's receipts are not credited here")
      eq(A.creditedBytes(server.pubB, []), 0, 'an empty bundle credits nothing')
    }
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(
    `\n${failures ? `❌ ${failures} FAILED — ` : 'ALL GREEN — '}${passed} assertions${failures ? `, ${failures} failures` : ''}`,
  )
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
