// nodechess web server (docs/WEB-PORT-SPEC.md): W1 statics + W3/W4 API.
//
// One Fastify process: serves the SPA (dist-web) with the cross-origin-
// isolation headers the W2 WASM engines need, the games-art static tree, a
// health probe, and the account/persistence API:
//   /api/auth/*        signup/login/logout/me       (server/auth.ts)
//   /api/ipc/<channel> the desktop IPC bridge       (server/bridge.ts)
//   /api/review/*      client-computed review store (server/review.ts)
// The bridge handlers live in a SEPARATE esbuild artifact
// (dist-server/ipc-bridge.cjs, built by scripts/build-ipc-bridge.mjs) that is
// require()d at runtime; when it is absent the API namespace stays an honest
// 503 coming-online and the static server still works.
//
// Bundled by scripts/build-server.mjs (esbuild → dist-server/index.cjs,
// self-contained: the Docker runtime stage carries no node_modules).
//
// Env:
//   PORT            listen port           (default 8080)
//   HOST            bind address          (default 0.0.0.0)
//   WEB_ROOT        built SPA directory   (default <bundle>/../dist-web)
//   GAMES_ART_ROOT  resources/games-art   (default <bundle>/../resources/games-art)
//   DATA_DIR        server state: server.sqlite + anon/ + users/<id>/
//                                         (default <bundle>/../.webdata)
//   PUZZLES_PATH    read-only puzzle DB   (default <bundle>/../resources/data/puzzles.sqlite)
//   RESOURCES_ROOT  content tree (curriculum/famous/personas/openings)
//                                         (default <bundle>/../resources)
//   BRIDGE_PATH     ipc bridge bundle     (default <bundle>/ipc-bridge.cjs)
//   TRUST_PROXY     '1' to trust X-Forwarded-* from a TLS-terminating proxy
//                   (real client IPs for rate limiting + req.protocol='https';
//                   REQUIRED behind a reverse proxy, default off)
//   COOKIE_SECURE   sid cookie Secure flag: unset = https or production,
//                   '1' = always, '0' = never (plain-http LAN/localhost hosting)
//   MAX_ACCOUNTS    signup ceiling (default 500; each account is a per-user
//                   on-disk DB)
//   ACCOUNTS_DECENTRALIZED  A-final switch (server/afinal.ts, spec §14):
//                   1 = decentralized accounts: interim /api/auth/* answers
//                   410 superseded; 0 = interim system fully intact (the
//                   emergency fallback). Unset: shipped builds default ON
//                   (build-server.mjs injects the default); ad-hoc bundles
//                   without the define default OFF (pre-A-final test rigs).
//   AUTH_RATE_LOGIN   login attempts per IP per minute      (default 10)
//   AUTH_RATE_SIGNUP  signup attempts per IP per hour       (default 5)
//   MAX_OPEN_USER_DBS open per-user SQLite handles kept warm (default 32)

import path from 'node:path'
import fs from 'node:fs'
import Fastify, { type FastifyReply } from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyCookie from '@fastify/cookie'
import fastifyRateLimit from '@fastify/rate-limit'
import { createApi, registerIpcRoutes } from './bridge'
import { AuthStore, registerAuthRoutes } from './auth'
import { registerReviewRoutes } from './review'
import { accountsDecentralized, registerInterimAuthGate } from './afinal'

// __dirname works because the bundle is CommonJS (build-server.mjs).
const bundleDir = __dirname

const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'
const WEB_ROOT = path.resolve(process.env.WEB_ROOT ?? path.join(bundleDir, '../dist-web'))
const GAMES_ART_ROOT = path.resolve(
  process.env.GAMES_ART_ROOT ?? path.join(bundleDir, '../resources/games-art')
)
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(bundleDir, '../.webdata'))
const PUZZLES_PATH = path.resolve(
  process.env.PUZZLES_PATH ?? path.join(bundleDir, '../resources/data/puzzles.sqlite')
)
const RESOURCES_ROOT = path.resolve(
  process.env.RESOURCES_ROOT ?? path.join(bundleDir, '../resources')
)
const BRIDGE_PATH = path.resolve(process.env.BRIDGE_PATH ?? path.join(bundleDir, 'ipc-bridge.cjs'))

declare const __WEB_APP_VERSION__: string
const VERSION = typeof __WEB_APP_VERSION__ === 'string' ? __WEB_APP_VERSION__ : 'dev'

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(WEB_ROOT, 'index.html'))) {
    console.error(`WEB_ROOT has no index.html: ${WEB_ROOT}. Run \`npm run build:web\` first`)
    process.exit(1)
  }

  // TRUST_PROXY=1: honor X-Forwarded-Proto from a TLS-terminating reverse
  // proxy so req.protocol reads 'https' and the sid cookie gets its Secure
  // flag (server/auth.ts). Opt-in: enabling it unconditionally would let
  // clients that connect directly spoof the header.
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: process.env.TRUST_PROXY === '1'
  })

  // Cross-origin isolation on EVERY response: multi-threaded Stockfish WASM
  // (W2) needs SharedArrayBuffer, which browsers grant only when the whole
  // context is COOP/COEP-isolated. The Vite dev/preview servers set the same
  // pair (vite.web.config.ts) so dev and prod behave identically.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cross-Origin-Opener-Policy', 'same-origin')
    reply.header('Cross-Origin-Embedder-Policy', 'require-corp')
  })

  // CSRF backstop on top of the sid cookie's SameSite=Lax: browsers attach an
  // Origin header to cross-site POSTs, so a mutating /api call whose Origin
  // does not match the host it arrived at is refused before any route runs.
  // Same-origin fetches match, and non-browser clients (curl, the test
  // suites) send no Origin at all. Both pass untouched. `req.host` honors
  // X-Forwarded-Host only under TRUST_PROXY, mirroring the cookie logic.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD') return
    if (!req.url.startsWith('/api/')) return
    const origin = req.headers.origin
    if (origin === undefined) return
    let originHost: string | null = null
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = null // 'null' (sandboxed frames) or malformed: refuse
    }
    if (!originHost || (originHost !== req.host && originHost !== req.hostname)) {
      return reply.code(403).send({ error: 'bad-origin' })
    }
  })

  // Per-IP rate limits. Registered global:false; only the routes that carry a
  // config (login/signup in server/auth.ts) are limited. Keying uses req.ip,
  // which is the X-Forwarded-For client only under TRUST_PROXY.
  await app.register(fastifyRateLimit, { global: false })

  // The SPA. Hashed /assets/* are immutable; index.html revalidates so a
  // fresh deploy is picked up on refresh (the web app's whole update story).
  await app.register(fastifyStatic, {
    root: WEB_ROOT,
    // cacheControl:false. The module's own header would overwrite setHeaders.
    cacheControl: false,
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      } else {
        res.setHeader('Cache-Control', 'no-cache')
      }
    }
  })

  // 3D tabletop PBR textures + piece art (main.web.tsx points
  // window.__gamesArtBase here in production). Optional: a source checkout
  // without the art pipeline output still serves the app. The renderer keeps
  // its procedural fallbacks.
  if (fs.existsSync(GAMES_ART_ROOT)) {
    await app.register(fastifyStatic, {
      root: GAMES_ART_ROOT,
      prefix: '/games-art/',
      decorateReply: false,
      cacheControl: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=86400')
      }
    })
  } else {
    app.log.warn(`games-art root missing (${GAMES_ART_ROOT}): 3D textures fall back to procedural`)
  }

  app.get('/healthz', async () => ({ ok: true, version: VERSION, ts: Date.now() }))

  // ---- W3/W4 API: accounts + the IPC bridge + review persistence ----------
  // The bridge bundle is a separate build artifact; a checkout that has only
  // run build:server (not build:ipc-bridge) still serves the SPA, and the
  // whole /api namespace stays 503 coming-online below.
  await app.register(fastifyCookie)

  // A-final switch (spec §14, server/afinal.ts): when the decentralized
  // accounts are live, the interim /api/auth namespace answers 410 superseded.
  // Registered regardless of bridge presence (superseded, not
  // coming-online). The content plane (/api/ipc, /api/review, statics) is
  // untouched either way, and existing interim session cookies still resolve
  // there (only the account-lifecycle endpoints are refused; reversible OFF
  // via ACCOUNTS_DECENTRALIZED=0).
  const accountsFlag = accountsDecentralized()
  app.log.info(
    `accounts: ${
      accountsFlag.on
        ? 'decentralized (interim /api/auth endpoints disabled, 410)'
        : 'interim server accounts live'
    } [${accountsFlag.source}]`
  )
  if (accountsFlag.on) registerInterimAuthGate(app)

  if (fs.existsSync(BRIDGE_PATH)) {
    const api = createApi({
      dataDir: DATA_DIR,
      puzzlesPath: PUZZLES_PATH,
      resourcesRoot: RESOURCES_ROOT,
      bridgePath: BRIDGE_PATH
    })
    const auth = new AuthStore(DATA_DIR)
    // Flag ON: the interim auth endpoints are 410-gated above and their
    // routes are simply not registered. AuthStore itself stays constructed:
    // ipc/review still resolve EXISTING session cookies (per-user data stays
    // reachable; no new session can be minted with login/signup refused).
    if (!accountsFlag.on) registerAuthRoutes(app, auth)
    registerIpcRoutes(app, api, auth)
    registerReviewRoutes(app, api, auth)
    if (!api.puzzlesInstalled()) {
      app.log.warn(
        `puzzle DB missing (${PUZZLES_PATH}): puzzle channels degrade to empty results`
      )
    }
  } else {
    app.log.warn(
      `ipc bridge bundle missing (${BRIDGE_PATH}): /api stays coming-online ` +
        `(run node scripts/build-ipc-bridge.mjs)`
    )
  }

  // Catch-all for the REST of the API namespace: anything the routers above
  // did not claim answers an honest 503, NOT the SPA fallback, so client fetch
  // errors stay legible. Registered for the bare path AND the subtree:
  // find-my-way's wildcard does not match the prefix itself, and the SPA shell
  // answering GET /api would read as a broken API, not a reserved one.
  // (Static routes and /api/ipc/:channel take precedence over the wildcard.)
  const apiComingOnline = async (_req: unknown, reply: FastifyReply): Promise<unknown> => {
    return reply.code(503).send({
      error: 'coming-online',
      message: 'The nodechess web API is coming online. This endpoint is not implemented yet.'
    })
  }
  app.all('/api', apiComingOnline)
  app.all('/api/*', apiComingOnline)

  // SPA fallback: any other GET/HEAD renders the app shell (client-side
  // routing): EXCEPT asset-shaped paths (hashed /assets/*, /games-art/*, or
  // anything with a file extension), which can never be client routes: a
  // stale tab requesting a redeployed chunk must get a clean 404, not
  // index.html served as JavaScript. Non-GET methods 404 like normal.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const pathname = req.url.split('?')[0]
      const assetShaped =
        pathname.startsWith('/assets/') ||
        pathname.startsWith('/games-art/') ||
        path.extname(pathname) !== ''
      if (assetShaped) return reply.code(404).send({ error: 'not-found' })
      return reply.code(200).type('text/html').sendFile('index.html')
    }
    return reply.code(404).send({ error: 'not-found' })
  })

  const address = await app.listen({ port: PORT, host: HOST })
  // Parsed by scripts/test-web-server.mjs: keep the shape stable.
  console.log(`nodechess-web listening ${address}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
