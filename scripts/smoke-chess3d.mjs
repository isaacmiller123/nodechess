#!/usr/bin/env node
// smoke-chess3d.mjs. Gate for the chess3d asset pack: parse every GLB in
// resources/games-art/chess3d/ with three's real GLTFLoader (the same code path
// the renderer uses), verify geometry attributes + manifest consistency, and
// check the shared textures exist. Exits non-zero on any failure.

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'resources', 'games-art', 'chess3d')

const PIECES = [
  'king_white',
  'queen_white',
  'rook_white',
  'bishop_white',
  'knight_white',
  'pawn_white',
  'king_black',
  'queen_black',
  'rook_black',
  'bishop_black',
  'knight_black',
  'pawn_black',
  'board'
]

function parseGlb(loader, buf) {
  return new Promise((resolve, reject) => {
    loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', resolve, reject)
  })
}

let failed = false
const fail = (msg) => {
  console.error('FAIL: ' + msg)
  failed = true
}

const manifest = JSON.parse(await readFile(path.join(DIR, 'manifest.json'), 'utf8'))
if (manifest.license !== 'CC0') fail('manifest license must be CC0')
if (!(manifest.squareSize > 0.01 && manifest.squareSize < 0.2)) fail('squareSize implausible')

const loader = new GLTFLoader()
for (const id of PIECES) {
  const entry = manifest.pieces[id]
  if (!entry) {
    fail(`manifest missing piece ${id}`)
    continue
  }
  const file = path.join(DIR, entry.file)
  let gltf
  try {
    gltf = await parseGlb(loader, await readFile(file))
  } catch (err) {
    fail(`${entry.file}: GLTFLoader parse error: ${err?.message ?? err}`)
    continue
  }
  let mesh = null
  gltf.scene.traverse((o) => {
    if (o.isMesh && !mesh) mesh = o
  })
  if (!mesh) {
    fail(`${entry.file}: no mesh in scene`)
    continue
  }
  const geo = mesh.geometry
  for (const attr of ['position', 'normal', 'uv']) {
    if (!geo.getAttribute(attr)) fail(`${entry.file}: missing ${attr} attribute`)
  }
  if (!geo.index) fail(`${entry.file}: not indexed`)
  const tris = geo.index ? geo.index.count / 3 : 0
  if (tris !== entry.tris) fail(`${entry.file}: tris ${tris} != manifest ${entry.tris}`)
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  const h = bb.max.y - bb.min.y
  if (id !== 'board' && !(h > 0.02 && h < 0.15)) fail(`${entry.file}: piece height ${h} implausible`)
  if (id === 'board' && !(bb.max.x - bb.min.x > manifest.squareSize * 8))
    fail('board.glb narrower than 8 squares')
  const matName = mesh.material?.name ?? ''
  if (matName !== entry.material) fail(`${entry.file}: material ${matName} != ${entry.material}`)
  console.log(
    `ok ${entry.file.padEnd(18)} tris=${String(tris).padStart(5)} h=${h.toFixed(3)}m mat=${matName}`
  )
}

for (const group of Object.values(manifest.textures)) {
  for (const rel of Object.values(group)) {
    try {
      const s = await stat(path.join(DIR, rel))
      if (s.size < 10_000) fail(`${rel}: suspiciously small (${s.size}B)`)
    } catch {
      fail(`${rel}: missing`)
    }
  }
}

if (manifest.totalMB > 15) fail(`pack ${manifest.totalMB}MB over 15MB budget`)
console.log(failed ? 'SMOKE FAILED' : `SMOKE OK, ${PIECES.length} GLBs, ${manifest.totalMB} MB`)
process.exit(failed ? 1 : 0)
