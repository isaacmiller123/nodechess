// Per-user DB routing (build contract, shared decision 2). Each account gets
// its own fully migrated app.sqlite under DATA_DIR/users/<id> (logged-out
// public reads run against DATA_DIR/anon), opened via the bridge bundle's
// openAppDb into an LRU-capped handle cache and rerouted per request via
// setDbOverride.
//
// ALL bridge work runs through ONE global FIFO mutex: acquire → point the shim
// userData + DB override at the caller's dir → await the handler → clear both →
// release. node:sqlite is synchronous and fast, so serializing at friends-scale
// costs nothing and buys total isolation (no handler can ever observe another
// user's override).

import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { BridgeModule } from './bridge'

/** Positive-integer env knob with a default (0/garbage falls back). */
function envInt(name: string, dflt: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : dflt
}

export interface UserDbPool {
  /** DB dir for logged-out public-channel calls. */
  anonDir: string
  /** DB dir for one account. */
  dirFor(userId: number): string
  /** Run fn with the app DB + shim userData routed at `dir` (FIFO-serialized). */
  withUserDb<T>(dir: string, fn: () => T | Promise<T>): Promise<T>
}

export function createUserDbPool(bridge: BridgeModule, dataDir: string): UserDbPool {
  const anonDir = path.join(dataDir, 'anon')
  // LRU of open handles, capped so accounts can't grow the process without
  // bound (every handle pins file descriptors + SQLite page cache). Map
  // iteration order is insertion order; dbFor re-inserts on every hit, so the
  // first key is always the coldest. The anon DB is pinned (every logged-out
  // content read uses it). Eviction only ever runs inside the FIFO mutex, so a
  // closed handle can never be in use.
  const maxOpen = Math.max(2, envInt('MAX_OPEN_USER_DBS', 32))
  const open = new Map<string, DatabaseSync>()
  // FIFO mutex: each call chains off the current tail; the tail never rejects
  // (failures propagate to their own caller, not to the next queued call).
  let tail: Promise<unknown> = Promise.resolve()

  const dbFor = (dir: string): DatabaseSync => {
    let db = open.get(dir)
    if (db) {
      open.delete(dir) // re-insert: most-recently-used goes last
      open.set(dir, db)
      return db
    }
    db = bridge.openAppDb(dir) // creates + runs the full migration chain
    open.set(dir, db)
    if (open.size > maxOpen) {
      for (const [coldDir, coldDb] of open) {
        if (coldDir === anonDir || coldDir === dir) continue
        open.delete(coldDir)
        try {
          coldDb.close()
        } catch {
          // Already closed/broken: dropping the reference is the point.
        }
        break
      }
    }
    return db
  }

  const withUserDb = <T>(dir: string, fn: () => T | Promise<T>): Promise<T> => {
    const task = async (): Promise<T> => {
      const db = dbFor(dir)
      bridge.setShimUserDataDir(dir)
      bridge.setDbOverride(() => db)
      try {
        return await fn()
      } finally {
        bridge.setDbOverride(null)
        bridge.setShimUserDataDir(null)
      }
    }
    const run = tail.then(task, task)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  return {
    anonDir,
    dirFor: (userId: number) => path.join(dataDir, 'users', String(userId)),
    withUserDb
  }
}
