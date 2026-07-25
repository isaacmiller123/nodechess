// Generic "save bytes via the OS save dialog" seam (dialog:saveFile).
//
// First consumer: Replay Theater's .webm export (renderer records the 3D
// canvas with MediaRecorder and hands the finished bytes here). Kept generic:
// name/filter/extension come from the caller, so future exports (PGN, SGF,
// screenshots) reuse the same channel. The renderer never sees a filesystem
// path picker; main owns the dialog + the write.

import { BrowserWindow, app, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { handle } from './util'

/** Hard cap on payload size (a long 60fps VP9 take stays well under this). */
const MAX_BYTES = 512 * 1024 * 1024

const saveFileSchema = z
  .object({
    /** Pre-filled file name (sanitized here; no path separators survive). */
    suggestedName: z.string().min(1).max(180),
    /** Dialog filter label, e.g. 'WebM video'. */
    filterName: z.string().min(1).max(60),
    extensions: z.array(z.string().regex(/^[a-z0-9]{1,8}$/)).min(1).max(4),
    data: z.instanceof(Uint8Array).refine((d) => d.byteLength > 0 && d.byteLength <= MAX_BYTES, {
      message: 'payload empty or too large'
    })
  })
  .strict()

/** Videos dir when the OS has one, else Downloads. Never throws. */
function defaultDir(): string {
  for (const name of ['videos', 'downloads'] as const) {
    try {
      return app.getPath(name)
    } catch {
      /* some platforms lack the folder: try the next */
    }
  }
  return app.getPath('home')
}

export function registerDialog(): void {
  handle('dialog:saveFile', saveFileSchema, async (req, e) => {
    const name = req.suggestedName.replace(/[/\\:*?"<>|]/g, '-').trim() || 'export'
    const options: Electron.SaveDialogOptions = {
      defaultPath: path.join(defaultDir(), name),
      filters: [{ name: req.filterName, extensions: req.extensions }]
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    await writeFile(res.filePath, req.data)
    return { ok: true, path: res.filePath }
  })
}
