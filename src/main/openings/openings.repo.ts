import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { parseFen, makeFen } from 'chessops/fen'

// Opening-name lookup over the committed resources/openings/openings.json, which
// maps EPD (first 4 FEN fields: placement, side, castling, ep) -> { eco, name }.
// The JSON is generated offline by scripts/build-openings.mjs from the CC0
// lichess-org/chess-openings dataset. Loaded lazily and cached for the process.

export interface OpeningInfo {
  eco: string
  name: string
}

let table: Record<string, OpeningInfo> | null = null

function openingsPath(): string {
  // In dev the whole main bundle is out/main/index.js, so __dirname is
  // <root>/out/main and ../../resources resolves to the repo's resources dir
  // (mirrors src/main/db/database.ts). In a packaged build the JSON ships under
  // process.resourcesPath/openings.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'openings', 'openings.json')
    : path.join(__dirname, '../../resources/openings/openings.json')
}

function load(): Record<string, OpeningInfo> {
  if (!table) {
    try {
      const raw = fs.readFileSync(openingsPath(), 'utf-8')
      table = JSON.parse(raw) as Record<string, OpeningInfo>
    } catch {
      // Missing/corrupt data must not crash lookups: treat as "no openings".
      table = {}
    }
  }
  return table
}

/** Look up an opening by its EPD (placement side castling ep). */
export function lookupByEpd(epd: string): OpeningInfo | null {
  return load()[epd] ?? null
}

/**
 * Look up an opening by a full FEN. Normalises to an EPD (first 4 fields) via
 * chessops so halfmove/fullmove counters and formatting don't affect the match.
 */
export function lookupByFen(fen: string): OpeningInfo | null {
  const setup = parseFen(fen)
  if (setup.isErr) return null
  const epd = makeFen(setup.value, { epd: true })
  return lookupByEpd(epd)
}
