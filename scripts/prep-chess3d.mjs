#!/usr/bin/env node
// prep-chess3d.mjs — build the photoreal chess 3D asset pack from Poly Haven's
// "Chess Set" (CC0, by Riley Queen; https://polyhaven.com/a/chess_set).
//
// Downloads the 2k glTF release (API: https://api.polyhaven.com/files/chess_set),
// extracts ONE representative geometry per piece type × color (+ the board) and
// re-exports each as a compact geometry-only GLB (no embedded textures — the
// three PBR texture sets are shared across pieces, so they ship once as JPEGs).
// Output → resources/games-art/chess3d/:
//   king_white.glb … pawn_black.glb (12), board.glb,
//   textures/{pieces_white,pieces_black,board}_{diff,normal,arm}.jpg,
//   manifest.json  { pieces→file/tris/bytes, squareSize, boardTopY, totalMB, license }
//   LICENSE.txt (CC0-1.0)
// Texture mix: diffuse 2k, normal+ARM 1k — measured ≤15MB total pack budget.
// ARM = glTF ORM packing (R=AO, G=roughness, B=metalness).
//
// Loader counterpart: src/renderer/src/games/three/chessSet.ts (reads manifest,
// rebuilds materials from the shared textures). Keep names in sync.
//
// Usage: node scripts/prep-chess3d.mjs        (cache: $TMPDIR/chess3d-src)
//        node scripts/prep-chess3d.mjs --force-download

import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'resources', 'games-art', 'chess3d')
const CACHE = path.join(tmpdir(), 'chess3d-src')
const FORCE = process.argv.includes('--force-download')
const BUDGET_MB = 15

const DL = 'https://dl.polyhaven.org/file/ph-assets/Models'
/** Downloads: source scene + mixed-res textures (diff 2k for detail, normal/arm 1k). */
const SOURCES = {
  gltf: { url: `${DL}/gltf/2k/chess_set/chess_set_2k.gltf`, file: 'chess_set_2k.gltf' },
  bin: { url: `${DL}/gltf/8k/chess_set/chess_set.bin`, file: 'chess_set.bin' }
}
const TEXTURES = []
for (const group of ['pieces_white', 'pieces_black', 'board']) {
  TEXTURES.push(
    { out: `${group}_diff.jpg`, url: `${DL}/jpg/2k/chess_set/chess_set_${group}_diff_2k.jpg` },
    { out: `${group}_normal.jpg`, url: `${DL}/jpg/1k/chess_set/chess_set_${group}_nor_gl_1k.jpg` },
    { out: `${group}_arm.jpg`, url: `${DL}/jpg/1k/chess_set/chess_set_${group}_arm_1k.jpg` }
  )
}

/** Source node name → shipped piece id. One representative per type × color. */
const PIECE_NODES = {
  piece_king_white: 'king_white',
  piece_queen_white: 'queen_white',
  piece_rook_white_01: 'rook_white',
  piece_bishop_white_01: 'bishop_white',
  piece_knight_white_01: 'knight_white',
  piece_pawn_white_01: 'pawn_white',
  piece_king_black: 'king_black',
  piece_queen_black: 'queen_black',
  piece_rook_black_01: 'rook_black',
  piece_bishop_black_01: 'bishop_black',
  piece_knight_black_01: 'knight_black',
  piece_pawn_black_01: 'pawn_black',
  board: 'board'
}

async function download(url, dest) {
  if (!FORCE && existsSync(dest) && (await stat(dest)).size > 0) return
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`)
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
}

// ---- minimal glTF accessor reader (handles optional byteStride) -------------

const COMP = {
  5120: { array: Int8Array, bytes: 1 },
  5121: { array: Uint8Array, bytes: 1 },
  5122: { array: Int16Array, bytes: 2 },
  5123: { array: Uint16Array, bytes: 2 },
  5125: { array: Uint32Array, bytes: 4 },
  5126: { array: Float32Array, bytes: 4 }
}
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }

function readAccessor(gltf, bin, index) {
  const acc = gltf.accessors[index]
  const bv = gltf.bufferViews[acc.bufferView]
  const comp = COMP[acc.componentType]
  const n = NUM[acc.type]
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const out = new comp.array(acc.count * n)
  const stride = bv.byteStride ?? comp.bytes * n
  if (stride === comp.bytes * n) {
    out.set(new comp.array(bin.buffer, bin.byteOffset + start, acc.count * n))
  } else {
    const dv = new DataView(bin.buffer, bin.byteOffset)
    const get = { 1: 'getUint8', 2: 'getUint16', 4: 'getUint32' } // eslint-disable-line
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < n; c++) {
        const off = start + i * stride + c * comp.bytes
        out[i * n + c] =
          acc.componentType === 5126
            ? dv.getFloat32(off, true)
            : dv[
                acc.componentType === 5125
                  ? 'getUint32'
                  : comp.bytes === 2
                    ? 'getUint16'
                    : 'getUint8'
              ](off, true)
      }
    }
  }
  return out
}

// ---- GLB writer --------------------------------------------------------------

function writeGlb(json, binBuffer) {
  let jsonText = JSON.stringify(json)
  while (jsonText.length % 4 !== 0) jsonText += ' '
  const jsonBuf = Buffer.from(jsonText, 'utf8')
  const binPad = (4 - (binBuffer.length % 4)) % 4
  const binChunk = binPad ? Buffer.concat([binBuffer, Buffer.alloc(binPad)]) : binBuffer
  const total = 12 + 8 + jsonBuf.length + 8 + binChunk.length
  const out = Buffer.alloc(total)
  out.writeUInt32LE(0x46546c67, 0) // 'glTF'
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonBuf.length, 12)
  out.writeUInt32LE(0x4e4f534a, 16) // 'JSON'
  jsonBuf.copy(out, 20)
  out.writeUInt32LE(binChunk.length, 20 + jsonBuf.length)
  out.writeUInt32LE(0x004e4942, 24 + jsonBuf.length) // 'BIN\0'
  binChunk.copy(out, 28 + jsonBuf.length)
  return out
}

/** Merge a mesh's primitives (all share one material here) into one packed GLB. */
function buildPieceGlb(gltf, bin, node, pieceId) {
  const mesh = gltf.meshes[node.mesh]
  const positions = []
  const normals = []
  const uvs = []
  const indices = []
  let vtxBase = 0
  let materialName = null
  for (const prim of mesh.primitives) {
    const matName = gltf.materials[prim.material]?.name ?? 'chess_set'
    if (materialName === null) materialName = matName
    else if (materialName !== matName)
      throw new Error(`${pieceId}: mixed materials in one mesh (${materialName} vs ${matName})`)
    const pos = readAccessor(gltf, bin, prim.attributes.POSITION)
    const nor = readAccessor(gltf, bin, prim.attributes.NORMAL)
    const uv = readAccessor(gltf, bin, prim.attributes.TEXCOORD_0)
    const idx = readAccessor(gltf, bin, prim.indices)
    positions.push(pos)
    normals.push(nor)
    uvs.push(uv)
    for (let i = 0; i < idx.length; i++) indices.push(idx[i] + vtxBase)
    vtxBase += pos.length / 3
  }
  const pos = concatF32(positions)
  const nor = concatF32(normals)
  const uv = concatF32(uvs)
  const idxArr = vtxBase > 0xffff ? Uint32Array.from(indices) : Uint16Array.from(indices)

  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      if (pos[i + c] < min[c]) min[c] = pos[i + c]
      if (pos[i + c] > max[c]) max[c] = pos[i + c]
    }
  }

  const chunks = [pos, nor, uv, idxArr]
  const views = []
  let offset = 0
  const bufParts = []
  for (const c of chunks) {
    const b = Buffer.from(c.buffer, c.byteOffset, c.byteLength)
    views.push({ buffer: 0, byteOffset: offset, byteLength: b.length })
    const padded = (4 - (b.length % 4)) % 4
    bufParts.push(b)
    if (padded) bufParts.push(Buffer.alloc(padded))
    offset += b.length + padded
  }
  views[0].target = 34962
  views[1].target = 34962
  views[2].target = 34962
  views[3].target = 34963
  const binOut = Buffer.concat(bufParts)

  const json = {
    asset: {
      version: '2.0',
      generator: 'nodechess prep-chess3d',
      copyright: 'Poly Haven "Chess Set" by Riley Queen — CC0-1.0 (polyhaven.com/a/chess_set)'
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: pieceId }],
    meshes: [
      {
        name: pieceId,
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }
        ]
      }
    ],
    materials: [
      {
        name: materialName,
        doubleSided: false,
        pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 }
      }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: nor.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: uv.length / 2, type: 'VEC2' },
      {
        bufferView: 3,
        componentType: idxArr instanceof Uint32Array ? 5125 : 5123,
        count: idxArr.length,
        type: 'SCALAR'
      }
    ],
    bufferViews: views,
    buffers: [{ byteLength: binOut.length }]
  }
  return { glb: writeGlb(json, binOut), tris: idxArr.length / 3, material: materialName }
}

function concatF32(arrays) {
  let len = 0
  for (const a of arrays) len += a.length
  const out = new Float32Array(len)
  let o = 0
  for (const a of arrays) {
    out.set(a, o)
    o += a.length
  }
  return out
}

// ---- main --------------------------------------------------------------------

async function main() {
  await mkdir(CACHE, { recursive: true })
  await mkdir(path.join(OUT_DIR, 'textures'), { recursive: true })

  console.log('downloading source (cached at ' + CACHE + ') …')
  await download(SOURCES.gltf.url, path.join(CACHE, SOURCES.gltf.file))
  await download(SOURCES.bin.url, path.join(CACHE, SOURCES.bin.file))
  for (const t of TEXTURES) await download(t.url, path.join(CACHE, path.basename(t.url)))

  const gltf = JSON.parse(await readFile(path.join(CACHE, SOURCES.gltf.file), 'utf8'))
  const bin = await readFile(path.join(CACHE, SOURCES.bin.file))

  // world scale facts from the source scene (meters)
  const nodeByName = Object.fromEntries(gltf.nodes.map((n) => [n.name, n]))
  const px = (name) => nodeByName[name].translation[0]
  const squareSize = Math.abs(px('piece_pawn_white_01') - px('piece_pawn_white_02'))
  const boardTopY = nodeByName.piece_king_white.translation[1] // pieces rest on the board top

  const manifest = {
    asset: 'Poly Haven "Chess Set"',
    author: 'Riley Queen',
    license: 'CC0',
    source: 'https://polyhaven.com/a/chess_set',
    units: 'meters',
    squareSize: round6(squareSize),
    boardTopY: round6(boardTopY),
    pieces: {},
    textures: {
      pieces_white: texEntry('pieces_white'),
      pieces_black: texEntry('pieces_black'),
      board: texEntry('board')
    },
    totalMB: 0
  }

  let totalBytes = 0
  console.log('\npiece            tris     bytes')
  for (const [nodeName, pieceId] of Object.entries(PIECE_NODES)) {
    const node = nodeByName[nodeName]
    if (!node) throw new Error(`source node missing: ${nodeName}`)
    const { glb, tris, material } = buildPieceGlb(gltf, bin, node, pieceId)
    const file = `${pieceId}.glb`
    await writeFile(path.join(OUT_DIR, file), glb)
    manifest.pieces[pieceId] = { file, tris, bytes: glb.length, material }
    totalBytes += glb.length
    console.log(`${pieceId.padEnd(14)} ${String(tris).padStart(6)} ${String(glb.length).padStart(9)}`)
  }

  console.log('\ntextures')
  for (const t of TEXTURES) {
    const src = path.join(CACHE, path.basename(t.url))
    const dest = path.join(OUT_DIR, 'textures', t.out)
    await copyFile(src, dest)
    const bytes = (await stat(dest)).size
    totalBytes += bytes
    console.log(`${t.out.padEnd(28)} ${String(bytes).padStart(9)}`)
  }

  manifest.totalMB = round2(totalBytes / (1024 * 1024))
  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(
    path.join(OUT_DIR, 'LICENSE.txt'),
    'Poly Haven "Chess Set" by Riley Queen\nhttps://polyhaven.com/a/chess_set\n\n' +
      'License: CC0 1.0 Universal (public domain dedication)\n' +
      'https://creativecommons.org/publicdomain/zero/1.0/\n\n' +
      'Repackaged for nodechess: per-piece geometry GLBs re-exported from the 2k glTF\n' +
      'release; textures are the official 2k diffuse and 1k normal/ARM JPEGs.\n'
  )

  console.log(`\nsquareSize ${manifest.squareSize} m, boardTopY ${manifest.boardTopY} m`)
  console.log(`TOTAL ${manifest.totalMB} MB (budget ${BUDGET_MB} MB)`)
  if (totalBytes > BUDGET_MB * 1024 * 1024) {
    console.error('FAIL: over budget')
    process.exit(1)
  }
  console.log('OK → ' + OUT_DIR)
}

function texEntry(group) {
  return {
    diff: `textures/${group}_diff.jpg`,
    normal: `textures/${group}_normal.jpg`,
    arm: `textures/${group}_arm.jpg`
  }
}
const round6 = (x) => Math.round(x * 1e6) / 1e6
const round2 = (x) => Math.round(x * 100) / 100

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
