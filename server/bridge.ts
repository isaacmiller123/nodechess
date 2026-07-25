// The IPC bridge (build contract, shared decision 1): the desktop's own
// zod-validated ipc handlers, prebundled by scripts/build-ipc-bridge.mjs into
// dist-server/ipc-bridge.cjs (electron aliased to server/electron-shim.ts) and
// require()d here at runtime. Every channel is served as
//
//   POST /api/ipc/<channel>   (JSON body = the payload object;
//                              response  = the handler's result JSON)
//
// Channel gating: PUBLIC_CHANNELS run without a session against the shared
// DATA_DIR/anon DB (content reads — puzzles/school/famous/personas/coach/
// openings — so logged-out visitors get real content but never touch a real
// user's rows); everything else answers 401 auth-required without a valid sid.
// Logged-in calls (public or not) run against DATA_DIR/users/<id>.

import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { FastifyInstance } from 'fastify'
import type * as BridgeEntry from './bridge-entry'
import { createUserDbPool, type UserDbPool } from './users'
import { requireUser, type AuthStore } from './auth'

export type BridgeModule = typeof BridgeEntry

/** Channels served WITHOUT a session, against the anon DB (contract list plus
 *  puzzles:daily, whose logged-out answer is the anon user's — null — result;
 *  puzzles:recordDaily stays auth-only). */
export const PUBLIC_CHANNELS: ReadonlySet<string> = new Set([
  'app:ping',
  'app:dataVersion',
  'puzzles:next',
  'puzzles:get',
  'puzzles:themes',
  'puzzles:batch',
  'puzzles:daily',
  'famous:list',
  'famous:get',
  'school:chapters',
  'school:chapter',
  'school:narrate',
  'school:debrief',
  'personas:list',
  'coach:explainMove',
  'coach:positional',
  'openings:lookup'
])

// The ipc handle() wrapper origin-checks e.senderFrame.url; file: is allowed
// (the bundled-renderer origin), so the bridge presents itself as one.
const BRIDGE_EVENT: BridgeEntry.BridgeIpcEvent = {
  senderFrame: { url: 'file:///nodechess-web-bridge' }
}

export interface Api {
  bridge: BridgeModule
  pool: UserDbPool
  channels: ReadonlyMap<string, BridgeEntry.BridgeIpcHandler>
  puzzlesInstalled(): boolean
}

export interface ApiOptions {
  dataDir: string
  puzzlesPath: string
  resourcesRoot: string
  bridgePath: string
}

export function createApi(opts: ApiOptions): Api {
  // Content repos resolve through the packaged branch (see electron-shim.ts) —
  // point resourcesPath at the real resources tree BEFORE the bundle loads.
  ;(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = opts.resourcesRoot

  // Loaded at runtime, not bundled: the bridge is its own esbuild artifact.
  const requireRuntime = createRequire(__filename)
  const bridge = requireRuntime(opts.bridgePath) as BridgeModule

  fs.mkdirSync(opts.dataDir, { recursive: true })
  bridge.configureDb({
    // Fallback singleton dir only — every bridge call runs under setDbOverride,
    // so a stray un-overridden getAppDb() lands on the anon DB, never a user's.
    appDbDir: path.join(opts.dataDir, 'anon'),
    puzzles: {
      resolvePath: () => opts.puzzlesPath,
      installed: () => fs.existsSync(opts.puzzlesPath)
    }
  })
  bridge.registerBridgeIpc()

  return {
    bridge,
    pool: createUserDbPool(bridge, opts.dataDir),
    channels: bridge.getRegisteredHandlers(),
    puzzlesInstalled: () => fs.existsSync(opts.puzzlesPath)
  }
}

export function registerIpcRoutes(app: FastifyInstance, api: Api, auth: AuthStore): void {
  app.post<{ Params: { channel: string } }>('/api/ipc/:channel', async (req, reply) => {
    const channel = req.params.channel
    const handler = api.channels.get(channel)
    // Not a bridge channel (typo, or a desktop-only excluded domain like
    // engine/review/datasets/updates/dialog): an honest 404, not the 503
    // coming-online catch-all — this namespace IS online.
    if (!handler) return reply.code(404).send({ error: 'unknown-channel', channel })

    const user = requireUser(auth, req, reply)
    if (!user && !PUBLIC_CHANNELS.has(channel)) {
      return reply.code(401).send({ error: 'auth-required' })
    }

    const dir = user ? api.pool.dirFor(user.id) : api.pool.anonDir
    const payload: unknown = req.body ?? {}
    try {
      const result = await api.pool.withUserDb(dir, () => handler(BRIDGE_EVENT, payload))
      return reply.send(result ?? null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // handle() throws 'IPC <channel>: invalid payload' on a zod reject.
      if (message.includes('invalid payload')) {
        return reply.code(400).send({ error: 'invalid-payload', channel })
      }
      req.log.error({ err, channel }, 'bridge channel failed')
      return reply.code(500).send({ error: 'ipc-error', channel, message })
    }
  })
}
