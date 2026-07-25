import { getAppDb } from './database'
import type { CustomVariantRow } from '@shared/types'

// Variant Lab persistence: CRUD over the custom_variant table (migration v9).
// The renderer owns validation (ffish loadVariantConfig round-trip); main only
// stores the authored definition. Shapes cross IPC camelCased (CustomVariantRow).

interface DbRow {
  id: string
  name: string
  description: string
  ini_text: string
  board_files: number
  board_ranks: number
  created_at: number
  updated_at: number
}

function toRow(r: DbRow): CustomVariantRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    iniText: r.ini_text,
    boardFiles: r.board_files,
    boardRanks: r.board_ranks,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export interface SaveCustomVariantInput {
  id: string
  name: string
  description: string
  iniText: string
  boardFiles: number
  boardRanks: number
}

/** Insert or replace (same id = edit); preserves created_at on updates. */
export function saveCustomVariant(v: SaveCustomVariantInput): CustomVariantRow {
  const db = getAppDb()
  const now = Date.now()
  db.prepare(
    `INSERT INTO custom_variant (id,name,description,ini_text,board_files,board_ranks,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, description=excluded.description, ini_text=excluded.ini_text,
       board_files=excluded.board_files, board_ranks=excluded.board_ranks, updated_at=excluded.updated_at`
  ).run(v.id, v.name, v.description, v.iniText, v.boardFiles, v.boardRanks, now, now)
  const row = db.prepare('SELECT * FROM custom_variant WHERE id = ?').get(v.id) as unknown as DbRow
  return toRow(row)
}

export function listCustomVariants(): CustomVariantRow[] {
  const rows = getAppDb()
    .prepare('SELECT * FROM custom_variant ORDER BY updated_at DESC')
    .all() as unknown as DbRow[]
  return rows.map(toRow)
}

export function getCustomVariant(id: string): CustomVariantRow | null {
  const row = getAppDb().prepare('SELECT * FROM custom_variant WHERE id = ?').get(id) as
    | unknown
    | undefined
  return row ? toRow(row as DbRow) : null
}

export function deleteCustomVariant(id: string): boolean {
  const r = getAppDb().prepare('DELETE FROM custom_variant WHERE id = ?').run(id)
  return Number(r.changes) > 0
}
