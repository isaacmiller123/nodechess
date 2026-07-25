// Accounts + sessions (build contract, shared decision 3).
//
// Storage: DATA_DIR/server.sqlite,
//   users(id, username UNIQUE COLLATE NOCASE, email NULL, pass_hash, created_at)
//   sessions(token PK = sha256(cookie value), user_id, created_at, expires_at)
// Passwords: argon2id (hash-wasm, WASM; no native build), encoded format so the
// salt+params travel with the hash. Session cookie: sid, httpOnly, SameSite=Lax,
// Path=/, 30-day ROLLING expiry (every authenticated hit re-stamps the DB row
// and re-issues the cookie), Secure when the request is https OR the server
// runs in production (COOKIE_SECURE overrides both ways).
//
// Sessions at rest are hashed: the DB stores sha256(token), the raw 256-bit
// token lives only in the cookie, and lookups hash the presented value. A
// server.sqlite read can no longer replay anyone's live session.
//
// Abuse bounds: login/signup carry @fastify/rate-limit per-IP configs
// (registered in server/index.ts), all argon2 work runs through a small
// concurrency gate (each hash costs ~19 MiB + a CPU burst; an unbounded burst
// is a memory-exhaustion vector), signups stop at MAX_ACCOUNTS, and login burns
// the same argon2 cost whether or not the username exists (timing oracle).
// Usernames remain enumerable through signup 409s. Accepted at friends scale,
// documented in docs/WEB-DEPLOY.md.
//
// Endpoints:
//   POST /api/auth/signup {username, password, email?} -> {user}  (409 taken,
//                                                          403 signups-closed)
//   POST /api/auth/login  {username, password}         -> {user}  (401 invalid)
//   POST /api/auth/logout {}                           -> {ok:true}
//   GET  /api/auth/me                                  -> {user: {id,username}|null}

import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { argon2id, argon2Verify } from 'hash-wasm'
import { z } from 'zod'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import '@fastify/cookie' // type augmentation (req.cookies / reply.setCookie)

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SID_COOKIE = 'sid'
// Contract: 3–24 chars, letters/digits/underscore/hyphen.
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/

// A real argon2id hash (same parameters as hashPassword) of a random throwaway
// password: login verifies unknown usernames against it so the response takes
// the same time as a wrong password for a real account.
const DECOY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$xjA6YpAiFUdNMKr2o5W3+A$A992Yle/5VukQRoiS7OxTRqaPcDQCkrVdn0OHRjiGgQ'

// ---- argon2 concurrency gate -------------------------------------------------
// FIFO semaphore with direct slot hand-off (the finisher passes its slot to the
// next waiter, so a burst can never overshoot the limit between microtasks).

const ARGON_CONCURRENCY = 2

class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
      // Slot inherited from the finisher: `active` already counts it.
    } else {
      this.active++
    }
    try {
      return await fn()
    } finally {
      const next = this.queue.shift()
      if (next) next()
      else this.active--
    }
  }
}

const argonGate = new Semaphore(ARGON_CONCURRENCY)

/** sha256 hex of a session token. The only form that ever touches the DB. */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export interface AuthUser {
  id: number
  username: string
}

interface SessionRow {
  expires_at: number
  id: number
  username: string
}

async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: crypto.randomBytes(16),
    // OWASP argon2id envelope: 19 MiB memory, 2 iterations, 1 lane.
    parallelism: 1,
    iterations: 2,
    memorySize: 19456, // KiB
    hashLength: 32,
    outputType: 'encoded'
  })
}

export class AuthStore {
  private readonly db: DatabaseSync

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(path.join(dataDir, 'server.sqlite'))
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email TEXT,
        pass_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions(
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `)
    this.migrate()
  }

  /** user_version 1: sessions.token becomes sha256(cookie value). v0 rows hold
   *  the raw token: the cookie value IS the preimage, so hashing the stored
   *  value in place converts every live session without logging anyone out.
   *  Wrapped in a transaction: the token rewrite + the version bump commit
   *  together, so a crash mid-migration rolls back (user_version stays 0) and
   *  the next boot re-runs cleanly: no half-migrated DB that would double-hash
   *  already-converted rows on retry. */
  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined
    const version = Number(row?.user_version ?? 0)
    if (version < 1) {
      // PRAGMA user_version is transactional here: on ROLLBACK it reverts to 0
      // along with the row rewrite (verified), so the whole migration is
      // all-or-nothing and a retry after a crash never double-hashes.
      this.db.exec('BEGIN')
      try {
        const sessions = this.db.prepare('SELECT token FROM sessions').all() as { token: string }[]
        const update = this.db.prepare('UPDATE sessions SET token = ? WHERE token = ?')
        for (const s of sessions) update.run(hashToken(s.token), s.token)
        this.db.exec('PRAGMA user_version = 1')
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
  }

  /** Total accounts. Signup refuses past MAX_ACCOUNTS. */
  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    return Number(row.n)
  }

  /** Create an account; 'username-taken' on a (case-insensitive) collision. */
  async createUser(
    username: string,
    password: string,
    email?: string
  ): Promise<AuthUser | 'username-taken'> {
    const passHash = await argonGate.run(() => hashPassword(password))
    try {
      const r = this.db
        .prepare('INSERT INTO users(username,email,pass_hash,created_at) VALUES (?,?,?,?)')
        .run(username, email ?? null, passHash, Date.now())
      return { id: Number(r.lastInsertRowid), username }
    } catch (err) {
      if (String(err).includes('UNIQUE constraint failed')) return 'username-taken'
      throw err
    }
  }

  /** Verify credentials; null on unknown user OR wrong password. The response
   *  body is identical either way, and an unknown username still burns a full
   *  argon2 verify (against DECOY_HASH) so response TIMING doesn't distinguish
   *  the two. Signup's 409 still reveals which usernames exist. An accepted
   *  friends-scale trade-off (docs/WEB-DEPLOY.md). */
  async verifyLogin(username: string, password: string): Promise<AuthUser | null> {
    const row = this.db
      .prepare('SELECT id, username, pass_hash FROM users WHERE username = ?')
      .get(username) as { id: number; username: string; pass_hash: string } | undefined
    const ok = await argonGate.run(() =>
      argon2Verify({ password, hash: row?.pass_hash ?? DECOY_HASH }).catch(() => false)
    )
    return ok && row ? { id: row.id, username: row.username } : null
  }

  createSession(userId: number): string {
    const token = crypto.randomBytes(32).toString('base64url')
    const now = Date.now()
    // Lazy sweep: expired rows go whenever a new session is minted.
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
    this.db
      .prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)')
      .run(hashToken(token), userId, now, now + SESSION_TTL_MS)
    return token
  }

  /** Resolve a session token; rolls the 30-day expiry on every valid hit. */
  getSession(token: string): AuthUser | null {
    const tokenHash = hashToken(token)
    const row = this.db
      .prepare(
        `SELECT s.expires_at, u.id, u.username
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ?`
      )
      .get(tokenHash) as unknown as SessionRow | undefined
    if (!row) return null
    const now = Date.now()
    if (row.expires_at <= now) {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash)
      return null
    }
    this.db
      .prepare('UPDATE sessions SET expires_at = ? WHERE token = ?')
      .run(now + SESSION_TTL_MS, tokenHash)
    return { id: row.id, username: row.username }
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(hashToken(token))
  }
}

/** Secure unless plainly told otherwise: an https request always gets it, and
 *  production defaults to it even when the proxy forgets X-Forwarded-Proto /
 *  TRUST_PROXY (the cookie would otherwise ship replayable over any http hit).
 *  COOKIE_SECURE=1 forces it on, =0 turns it off. The escape hatch for
 *  plain-http LAN/localhost hosting (Safari drops Secure cookies there). */
function cookieSecure(req: FastifyRequest): boolean {
  if (process.env.COOKIE_SECURE === '1') return true
  if (process.env.COOKIE_SECURE === '0') return false
  return req.protocol === 'https' || process.env.NODE_ENV === 'production'
}

function setSidCookie(req: FastifyRequest, reply: FastifyReply, token: string): void {
  reply.setCookie(SID_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(req),
    maxAge: Math.floor(SESSION_TTL_MS / 1000)
  })
}

/**
 * The session gate every protected route uses: resolve the sid cookie, roll the
 * expiry, re-issue the cookie (so the browser's 30-day window rolls too).
 * Returns null when there is no valid session. The caller answers 401.
 */
export function requireUser(
  auth: AuthStore,
  req: FastifyRequest,
  reply: FastifyReply
): AuthUser | null {
  const token = req.cookies?.[SID_COOKIE]
  if (!token) return null
  const user = auth.getSession(token)
  if (!user) return null
  setSidCookie(req, reply, token)
  return user
}

const signupSchema = z
  .object({
    username: z.string().regex(USERNAME_RE),
    password: z.string().min(8).max(256),
    email: z.email().max(190).optional()
  })
  .strict()

const loginSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(256)
  })
  .strict()

/** Positive-integer env knob with a default (0/garbage falls back). */
function envInt(name: string, dflt: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : dflt
}

export function registerAuthRoutes(app: FastifyInstance, auth: AuthStore): void {
  // Per-IP limits (@fastify/rate-limit, registered global:false in index.ts;
  // only these two routes carry a config). Signup is the expensive+scarce one:
  // an argon2 hash AND a per-user DB dir. Knobs documented in WEB-DEPLOY.md.
  const loginLimit = {
    config: { rateLimit: { max: envInt('AUTH_RATE_LOGIN', 10), timeWindow: 60_000 } }
  }
  const signupLimit = {
    config: { rateLimit: { max: envInt('AUTH_RATE_SIGNUP', 5), timeWindow: 60 * 60_000 } }
  }

  app.post('/api/auth/signup', signupLimit, async (req, reply) => {
    const parsed = signupSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-payload',
        message: 'username must be 3-24 chars [a-zA-Z0-9_-]; password at least 8 chars'
      })
    }
    // Hard ceiling on accounts: every signup creates an on-disk per-user DB,
    // so an open server must not accept them without bound.
    if (auth.countUsers() >= envInt('MAX_ACCOUNTS', 500)) {
      return reply.code(403).send({
        error: 'signups-closed',
        message: 'This server is not accepting new accounts right now.'
      })
    }
    const { username, password, email } = parsed.data
    const created = await auth.createUser(username, password, email)
    if (created === 'username-taken') {
      return reply.code(409).send({ error: 'username-taken' })
    }
    setSidCookie(req, reply, auth.createSession(created.id))
    return { user: created }
  })

  app.post('/api/auth/login', loginLimit, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid-payload' })
    const user = await auth.verifyLogin(parsed.data.username, parsed.data.password)
    if (!user) return reply.code(401).send({ error: 'invalid-credentials' })
    setSidCookie(req, reply, auth.createSession(user.id))
    return { user }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[SID_COOKIE]
    if (token) auth.deleteSession(token)
    reply.clearCookie(SID_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/api/auth/me', async (req, reply) => {
    return { user: requireUser(auth, req, reply) }
  })
}
