import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { z } from 'zod'

// Origin allowlist: only our own LOCAL renderer. Remote navigation is blocked by
// hardenWindow, so the sender can only be the Vite dev server (dev) or the
// bundled renderer loaded via loadFile (file://) or a registered app:// protocol.
export function senderAllowed(e: IpcMainInvokeEvent): boolean {
  const raw = e.senderFrame?.url
  if (!raw) return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  // Bundled renderer (loadFile) or the future app:// protocol.
  if (u.protocol === 'app:' || u.protocol === 'file:') return true
  // Dev server only: exact host match (prefix matching would accept localhost.evil.com).
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true
  return false
}

// Every handler: assert sender origin, then zod-validate the payload before work.
export function handle<S extends z.ZodTypeAny, R>(
  channel: string,
  schema: S,
  fn: (arg: z.infer<S>, e: IpcMainInvokeEvent) => R | Promise<R>
): void {
  ipcMain.handle(channel, async (e, raw) => {
    if (!senderAllowed(e)) throw new Error(`IPC ${channel}: sender not allowed`)
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new Error(`IPC ${channel}: invalid payload`)
    return fn(parsed.data, e)
  })
}
