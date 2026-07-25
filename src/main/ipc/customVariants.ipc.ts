import { z } from 'zod'
import { handle } from './util'
import {
  deleteCustomVariant,
  getCustomVariant,
  listCustomVariants,
  saveCustomVariant
} from '../db/customVariants.repo'

// Variant Lab IPC: persistence only. Rules validation lives in the renderer
// (games/customVariants.ts runs the ini through ffish WASM before save), so
// main just enforces shape/limits and stores the definition. Board limits
// mirror the fairy-sf largeboard build (12 files × 10 ranks, min 4).

const idSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a lowercase slug')

export function registerCustomVariants(): void {
  handle(
    'customVariants:save',
    z
      .object({
        id: idSchema,
        name: z.string().min(1).max(80),
        description: z.string().max(400),
        iniText: z.string().min(1).max(20_000),
        boardFiles: z.number().int().min(4).max(12),
        boardRanks: z.number().int().min(4).max(10)
      })
      .strict(),
    (v) => ({ variant: saveCustomVariant(v) })
  )

  handle('customVariants:list', z.object({}).strict(), () => ({
    variants: listCustomVariants()
  }))

  handle('customVariants:get', z.object({ id: idSchema }).strict(), ({ id }) => ({
    variant: getCustomVariant(id)
  }))

  handle('customVariants:delete', z.object({ id: idSchema }).strict(), ({ id }) => ({
    ok: deleteCustomVariant(id)
  }))
}
