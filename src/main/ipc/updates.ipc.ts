import { z } from 'zod'
import { handle } from './util'
import { checkForUpdates, downloadUpdate, getUpdateStatus } from '../updates/updateService'

// App updates (src/main/updates/updateService.ts). Status changes are also
// PUSHED to every window on 'updates:status'. These handlers cover the pull
// side (initial snapshot) and the two user actions.
export function registerUpdates(): void {
  handle('updates:status', z.object({}).strict(), () => getUpdateStatus())
  handle('updates:check', z.object({}).strict(), () => checkForUpdates())
  handle('updates:download', z.object({}).strict(), () => downloadUpdate())
}
