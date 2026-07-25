// Minimal typed event emitter. The browser stand-in for node:events that
// desktop UciEngine extends. Only what the engine layer needs: on/off/once/
// emit, with listener snapshots so handlers detaching themselves (or each
// other) mid-emit can never skip a peer.

type AnyListener = (...args: unknown[]) => void

export class Emitter<E extends Record<string, unknown[]>> {
  private listeners = new Map<keyof E, Set<AnyListener>>()

  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn as unknown as AnyListener)
  }

  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const wrapper = (...args: E[K]): void => {
      this.off(event, wrapper)
      fn(...args)
    }
    // Keep a reference so off(event, fn) after once() still detaches.
    ;(wrapper as unknown as { __orig?: unknown }).__orig = fn
    this.on(event, wrapper)
  }

  off<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const l of set) {
      if ((l as unknown) === (fn as unknown) || (l as { __orig?: unknown }).__orig === fn) {
        set.delete(l)
      }
    }
  }

  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const l of [...set]) l(...(args as unknown[]))
  }
}
