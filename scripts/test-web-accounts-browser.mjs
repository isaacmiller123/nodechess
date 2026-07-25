// REAL-browser determinism gate for the accounts tree (spec §14 quality gate:
// "browser worst-case exercised in CI for at least chain verification").
//
//   node scripts/test-web-accounts-browser.mjs
//
// Builds the SAME fixture bundle as scripts/test-web-accounts.mjs
// (platform=browser, nothing stubbed), serves it over plain-node http WITH
// COOP/COEP headers (the production isolation semantics, server/index.ts),
// drives headless chromium via playwright-core, runs the full flow IN PAGE
// (argon2id derivation → SLIP-0010 → chain build → verifyChain →
// chainToBytes), and asserts byte-parity of every digest against the node
// oracle run in this same process + the recorded goldens.
//
// Browser provisioning: uses playwright-core's registry; if no chromium is
// present it attempts `npx playwright-core install chromium-headless-shell`.
// If that fails (offline): SKIP (exit 0) locally, HARD FAIL (exit 1) when
// process.env.CI is set. CI must never silently skip the gate.
//
// Style: failures counter, per-assert one-line output, exit(failures ? 1 : 0).

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, resolve, extname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import {
  GOLDENS,
  FIXTURE_ENTRY_TS,
  FIXTURE_HTML,
  JUDGE_GOLDENS,
  JUDGE_FIXTURE_ENTRY_TS,
  JUDGE_FIXTURE_HTML,
  JUDGE_ENGINE_ENTRY_TS,
  JUDGE_ENGINE_HTML,
  JUDGE_PARITY_POSITIONS,
  bundleFixture,
  findNodeBuiltinRefs,
} from './lib/accounts-fixture.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ---- tiny check kit ---------------------------------------------------------
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
function eq(a, b, msg) {
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

// ---- browser provisioning -----------------------------------------------------
async function launchChromium(chromium) {
  try {
    return { browser: await chromium.launch({ headless: true }) }
  } catch (err) {
    return { err }
  }
}

async function ensureBrowser(chromium) {
  let attempt = await launchChromium(chromium)
  if (attempt.browser) return attempt.browser
  console.log('· no chromium available: attempting `npx playwright-core install chromium-headless-shell` …')
  // shell:true on Windows: 'npx' is npx.cmd there, and spawning .cmd files
  // directly is both ENOENT-prone and blocked by node's batch-file hardening.
  const res = spawnSync('npx', ['playwright-core', 'install', 'chromium-headless-shell'], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 300_000,
    shell: process.platform === 'win32',
  })
  // res.error (spawn failure, e.g. ENOENT) never sets status. Check BOTH,
  // and say WHY provisioning failed instead of silently skipping.
  if (res.error || res.status !== 0) {
    console.error(
      `· provisioning failed: ${res.error ? String(res.error) : `exit status ${res.status}`}`,
    )
  } else {
    attempt = await launchChromium(chromium)
    if (attempt.browser) return attempt.browser
  }
  if (process.env.CI) {
    console.error('❌ CI is set and no browser could be provisioned. The browser gate MUST run in CI.')
    console.error(String(attempt.err))
    process.exit(1)
  }
  console.log('SKIP (no browser available)')
  process.exit(0)
}

// ---- static file server with production isolation headers --------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
}

function serveDir(dir) {
  const server = createServer((req, res) => {
    const path = resolve(dir, '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]))
    if (!path.startsWith(dir)) {
      res.writeHead(403).end()
      return
    }
    let body
    try {
      body = readFileSync(path)
    } catch {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      // Same two headers the production server sets (server/index.ts /
      // vite.web.config.ts): the page must work under full cross-origin
      // isolation. The strictest environment the app ever runs in.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cache-control': 'no-store',
    })
    res.end(body)
  })
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise(server))
  })
}

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/web-accounts-browser-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
  try {
    await run(outdir)
  } finally {
    // cleanup on failure paths too. A crashed run must not leak temp dirs
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(outdir) {
  // ---- build fixture bundles --------------------------------------------------
  console.log('· building the fixture (browser bundle + node oracle) …')
  const entry = resolve(outdir, 'fixture.entry.ts')
  writeFileSync(entry, FIXTURE_ENTRY_TS)
  const browserOut = resolve(outdir, 'fixture.browser.mjs')
  const nodeOut = resolve(outdir, 'fixture.node.mjs')
  await bundleFixture(entry, browserOut, 'browser')
  await bundleFixture(entry, nodeOut, 'node')
  writeFileSync(resolve(outdir, 'index.html'), FIXTURE_HTML)
  eq(findNodeBuiltinRefs(readFileSync(browserOut, 'utf8')).length, 0, 'browser bundle carries no node builtins')

  // ---- node oracle run ----------------------------------------------------------
  console.log('· running the node oracle …')
  const oracle = await (await import(pathToFileURL(nodeOut).href)).runFixture()
  eq(oracle.seedHex, GOLDENS.seedHex, 'node oracle seed matches the argon2 KAT')
  eq(oracle.verifyDigest, GOLDENS.chainVerifyDigest, 'node oracle verify digest matches the chain-suite golden')

  // ---- browser ---------------------------------------------------------------
  const { chromium } = await import('playwright-core')
  const browser = await ensureBrowser(chromium)
  console.log(`· chromium launched (${browser.version()})`)

  const server = await serveDir(outdir)
  const port = server.address().port
  let page
  try {
    page = await browser.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })

    const isolated = await page.evaluate('self.crossOriginIsolated')
    eq(isolated, true, 'page is crossOriginIsolated (COOP/COEP served, production semantics)')

    // The in-page flow: argon2id (~sub-second) + chain build + verify.
    await page.waitForFunction('window.__result !== undefined || window.__error !== undefined', {
      timeout: 120_000,
    })
    const pageError = await page.evaluate('window.__error')
    if (pageError) {
      ok(false, `in-page fixture flow completed without error (got: ${pageError})`)
    } else {
      ok(true, 'in-page fixture flow completed without error')
      const result = JSON.parse(await page.evaluate('window.__result'))

      console.log('\n· byte-parity: browser vs node oracle, field by field …')
      const fields = Object.keys(oracle).sort()
      eq(Object.keys(result).sort().join(','), fields.join(','), 'browser run emits the same field set')
      for (const f of fields) eq(result[f], oracle[f], `browser === node: ${f}`)

      console.log('\n· browser digests vs recorded goldens …')
      eq(result.paramsDigest, GOLDENS.paramsDigest, 'in-browser params digest matches the frozen golden')
      eq(result.seedHex, GOLDENS.seedHex, 'in-browser argon2id seed matches the KAT')
      eq(result.tag, GOLDENS.tag, `in-browser tag is '${GOLDENS.tag}'`)
      eq(result.verifyOk, true, 'in-browser verifyChain(golden fixture) is ok')
      eq(result.verifyDigest, GOLDENS.chainVerifyDigest, 'in-browser verify digest matches the chain-suite golden')
      eq(result.chainFileSha256, GOLDENS.chainFileSha256, 'in-browser chain file sha256 matches the chain-suite golden')
      eq(result.identityVerifyOk, true, 'in-browser identity-chain verify is ok')
      eq(result.identityVerifyDigest, GOLDENS.identityChainVerifyDigest, 'in-browser identity-chain verify digest matches its golden')
      eq(result.identityChainFileSha256, GOLDENS.identityChainFileSha256, 'in-browser identity-chain file sha256 matches its golden')

      console.log('\n· browser unicode display-name fixture vs goldens …')
      eq(result.unicodeFoldedName, 'zo\u00eb', "in-browser unicode name folds to 'zo\u00eb' (NFC)")
      eq(result.unicodeSeedHex, GOLDENS.unicodeSeedHex, 'in-browser unicode argon2id seed matches its golden')
      eq(result.unicodeNfdSeedHex, result.unicodeSeedHex, 'in-browser NFD name+password input derives the identical seed')
      eq(result.unicodeTag, GOLDENS.unicodeTag, `in-browser unicode tag is '${GOLDENS.unicodeTag}'`)
      eq(result.unicodeVerifyOk, true, 'in-browser unicode chain verifies ok')
      eq(result.unicodeVerifyDigest, GOLDENS.unicodeChainVerifyDigest, 'in-browser unicode verify digest matches its golden')
      eq(result.unicodeChainFileSha256, GOLDENS.unicodeChainFileSha256, 'in-browser unicode chain file sha256 matches its golden')

      console.log('\n· browser A3/A4 parity (detmath, RS, routing, a4 fold) vs goldens …')
      eq(result.detmathDigest, GOLDENS.detmathDigest, 'in-browser detmath float64 bit-grid digest matches its golden')
      eq(result.rsRoundtripOk, true, 'in-browser RS 12-of-40 reconstruct is byte-identical')
      eq(result.rsDigest, GOLDENS.rsDigest, 'in-browser RS digest matches its golden')
      eq(result.routingDigest, GOLDENS.routingDigest, 'in-browser overlay routing digest matches its golden')
      eq(result.a4ParamsDigest, GOLDENS.a4ParamsDigest, 'in-browser PARAMS_A4 digest matches its golden')
      eq(result.a4VerifyOk, true, 'in-browser rated a4 fixture chain verifies ok')
      eq(result.a4CkptDeepOk, true, 'in-browser a4-v1 checkpoint verifies deeply')
      eq(result.a4StateHash, GOLDENS.a4StateHash, 'in-browser a4-v1 fold state hash matches its golden')
    }
    eq(pageErrors.length, 0, `no uncaught page errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`)

    // ═══ A5 J6: judge verdict-bit parity (spec §14-A5 cross-platform gate) ═══
    // Section 1 (always): tier1Record + windowVerdict + anchor digests over
    // FIXED synthetic inputs: the browser must compute the same verdict bits
    // as node, byte for byte, no engine required.
    console.log('\n· A5 judge core parity: tier1Record + windowVerdict, browser vs node …')
    const judgeEntry = resolve(outdir, 'judge.entry.ts')
    writeFileSync(judgeEntry, JUDGE_FIXTURE_ENTRY_TS)
    const judgeBrowserOut = resolve(outdir, 'judge.browser.mjs')
    const judgeNodeOut = resolve(outdir, 'judge.node.mjs')
    await bundleFixture(judgeEntry, judgeBrowserOut, 'browser')
    await bundleFixture(judgeEntry, judgeNodeOut, 'node')
    writeFileSync(resolve(outdir, 'judge.html'), JUDGE_FIXTURE_HTML)
    eq(findNodeBuiltinRefs(readFileSync(judgeBrowserOut, 'utf8')).length, 0, 'judge browser bundle carries no node builtins')

    const judgeOracle = (await import(pathToFileURL(judgeNodeOut).href)).runJudgeFixture()
    eq(judgeOracle.judgeParamsDigest, JUDGE_GOLDENS.paramsDigest, 'node judge oracle names the current PARAMS_A5_DIGEST')
    eq(judgeOracle.syntheticOutputDigest, JUDGE_GOLDENS.syntheticOutputDigest, 'node synthetic JudgeOutput digest matches its golden')
    eq(judgeOracle.tier1RecordDigest, JUDGE_GOLDENS.tier1RecordDigest, 'node tier1Record digest matches its golden')
    eq(judgeOracle.anchorsJudgeDigest, JUDGE_GOLDENS.anchorsJudgeDigest, 'node TIER2_ANCHORS_JUDGE digest matches its golden')
    eq(judgeOracle.windowVerdictJson, JUDGE_GOLDENS.windowVerdictJson, 'node windowVerdict bits match their golden')

    const judgePage = await browser.newPage()
    const judgePageErrors = []
    judgePage.on('pageerror', (e) => judgePageErrors.push(String(e)))
    await judgePage.goto(`http://127.0.0.1:${port}/judge.html`, { waitUntil: 'load' })
    await judgePage.waitForFunction('window.__judgeResult !== undefined || window.__judgeError !== undefined', {
      timeout: 60_000,
    })
    const judgeError = await judgePage.evaluate('window.__judgeError')
    if (judgeError) {
      ok(false, `in-browser judge fixture completed without error (got: ${judgeError})`)
    } else {
      ok(true, 'in-browser judge fixture completed without error')
      const judgeResult = JSON.parse(await judgePage.evaluate('window.__judgeResult'))
      const jFields = Object.keys(judgeOracle).sort()
      eq(Object.keys(judgeResult).sort().join(','), jFields.join(','), 'browser judge run emits the same field set')
      for (const f of jFields) eq(judgeResult[f], judgeOracle[f], `browser === node: judge ${f}`)
    }
    eq(judgePageErrors.length, 0, `no uncaught judge-page errors${judgePageErrors.length ? `: ${judgePageErrors[0]}` : ''}`)
    await judgePage.close()

    // Section 2 (engine, LOCAL-ONLY): the REAL web judge adapter
    // (src/web/engines/judge.ts: hash-verified pinned wasm in a dedicated
    // worker) judges 3 of J1's golden positions at the TRUE Tier-1 config;
    // the digest must equal the node adapter's LIVE digest for the same
    // subset. Engine work never runs in default CI suites (A5 convention,
    // test-judge-node gating): CI prints the skip loudly and the cheap
    // section above still proves verdict-bit parity there.
    if (process.env.CI) {
      console.log('\n· A5 judge ENGINE parity: SKIP under CI (engine-heavy suites are local-only, test-judge-node convention)')
    } else {
      console.log('\n· A5 judge ENGINE parity: real web adapter, 3 golden positions at TRUE t1 (≈1 min) …')
      const enginesDirPath = resolve(outdir, 'engines')
      mkdirSync(enginesDirPath, { recursive: true })
      const ENGINE_JS = resolve(ROOT, 'node_modules/stockfish/bin/stockfish-18-lite-single.js')
      const ENGINE_WASM = resolve(ROOT, 'node_modules/stockfish/bin/stockfish-18-lite-single.wasm')
      writeFileSync(resolve(enginesDirPath, 'stockfish-18-lite-single.js'), readFileSync(ENGINE_JS))
      writeFileSync(resolve(enginesDirPath, 'stockfish-18-lite-single.wasm'), readFileSync(ENGINE_WASM))

      // node oracle: the Node adapter over the SAME subset, digest computed live
      const nodeJudgeEntry = resolve(outdir, 'judge-node-adapter.entry.ts')
      writeFileSync(
        nodeJudgeEntry,
        `export * as core from '${resolve(ROOT, 'src/shared/accounts/judge/index.ts').replace(/\\/g, '/')}'\n` +
          `export * as adapter from '${resolve(ROOT, 'server/judge/nodeAdapter.ts').replace(/\\/g, '/')}'\n`,
      )
      const nodeJudgeOut = resolve(outdir, 'judge-node-adapter.mjs')
      await bundleFixture(nodeJudgeEntry, nodeJudgeOut, 'node')
      const { core, adapter } = await import(pathToFileURL(nodeJudgeOut).href)
      const nodeEng = await adapter.newNodeJudgeEngine({ enginePath: ENGINE_JS, wasmPath: ENGINE_WASM })
      let nodeDigest
      try {
        const nodeOut = await core.judgeGame(nodeEng, JUDGE_PARITY_POSITIONS, core.judgeConfigForTier(1))
        nodeDigest = core.judgeOutputDigest(nodeOut)
        eq(nodeOut.config.nodes, 200000, 'node engine parity run used the TRUE t1 node count')
      } finally {
        await nodeEng.close()
      }

      const engineEntry = resolve(outdir, 'judge-engine.entry.ts')
      writeFileSync(engineEntry, JUDGE_ENGINE_ENTRY_TS)
      const engineBrowserOut = resolve(outdir, 'judge-engine.browser.mjs')
      await bundleFixture(engineEntry, engineBrowserOut, 'browser')
      writeFileSync(resolve(outdir, 'judge-engine.html'), JUDGE_ENGINE_HTML)

      const enginePage = await browser.newPage()
      await enginePage.goto(`http://127.0.0.1:${port}/judge-engine.html`, { waitUntil: 'load' })
      await enginePage.waitForFunction('window.__engineResult !== undefined || window.__engineError !== undefined', {
        timeout: 300_000,
      })
      const engineError = await enginePage.evaluate('window.__engineError')
      if (engineError) {
        ok(false, `in-browser judge ENGINE run completed without error (got: ${engineError})`)
      } else {
        ok(true, 'in-browser judge ENGINE run completed (hash-verified pinned wasm, dedicated worker)')
        const engineResult = JSON.parse(await enginePage.evaluate('window.__engineResult'))
        eq(engineResult.positions, JUDGE_PARITY_POSITIONS.length, `browser judged all ${JUDGE_PARITY_POSITIONS.length} parity positions`)
        eq(engineResult.params, 'ok', 'browser JudgeOutput config echo names PARAMS_A5_DIGEST')
        eq(engineResult.digest, nodeDigest, 'VERDICT-BIT PARITY: browser judgeOutputDigest === node adapter digest (TRUE t1 config, live)')
      }
      await enginePage.close()
    }
  } finally {
    await browser.close().catch(() => {})
    server.close()
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.stack || err}`)
  process.exit(1)
})
