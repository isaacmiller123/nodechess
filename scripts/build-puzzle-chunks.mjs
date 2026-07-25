#!/usr/bin/env node
// build-puzzle-chunks.mjs: turn the 2 GB bundled puzzle DB into a static,
// range-readable artifact for the serverless web target (Cloudflare Pages).
//
// Pages' free tier caps a file at 25 MiB and a site at 20,000 files, and gives
// us no server at all, so the browser reads SQLite itself, over HTTP Range
// requests, through sql.js-httpvfs' chunked VFS (src/web/data/). That library
// maps a byte range onto `<prefix><nnn>` split files, so all this script has to
// produce is a byte-exact split plus the numbers the reader needs to plan its
// queries.
//
// It does NOT just `split` the desktop DB, because two of its properties make
// range reading slow or impossible:
//
//  1. ROW ORDER. Desktop rows sit in CSV order, so the 24-row rating window
//     that `nextPuzzle` reads is 24 rowid lookups scattered across 2 GB, 24
//     round-trips over HTTP. We re-insert `puzzles` ordered by (Rating,
//     PuzzleId) with an explicit ROW_NUMBER() rowid, which makes rowid the rank
//     in that order. Rating windows become CONTIGUOUS rowid ranges: one range
//     read, and the reader can compute the range offline from the rating
//     histogram in the manifest instead of descending an index to find it.
//     Every rowid-arithmetic query in src/web/data/puzzleSource.ts depends on
//     this invariant; it is verified below before anything is written.
//
//  2. FULL-TABLE AGGREGATES. `listThemes()` is a GROUP BY over 21M junction
//     rows: hundreds of MB across the wire for 73 numbers. It is computed here
//     and shipped in the manifest instead.
//
// The junction table is rebuilt WITHOUT ROWID so its primary key IS its
// storage: same page reads as the desktop's idx_pt covering index, roughly half
// the bytes.
//
// Usage:  npm run build:puzzle-chunks -- [--src <db>] [--out <dir>] [...]
// Output: <out>/puzzles.sqlite.000..NNN + puzzles.manifest.json (+ a .gitignore
// that ignores the whole directory, since this is a ~2 GB build artifact).

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 24 MiB: comfortably under the 25 MiB (26,214,400 B) Pages limit, and an exact
// multiple of every page size we allow. A SQLite page must never straddle two
// split files, or a single-page request would need two HTTP round-trips (and
// sql.js-httpvfs' range mapper does not stitch them).
const DEFAULT_CHUNK_BYTES = 24 * 1024 * 1024
// 8 KiB pages: half the request count of the desktop's 4 KiB pages for the
// windowed scans that dominate, without doubling the waste of a point lookup.
const DEFAULT_PAGE_SIZE = 8192
const PAGES_FILE_LIMIT = 25 * 1024 * 1024
const PAGES_FILE_COUNT_LIMIT = 20_000
const SUFFIX_LENGTH = 3
const CHUNK_PREFIX = 'puzzles.sqlite.'
const MANIFEST_NAME = 'puzzles.manifest.json'

// The deterministic daily draws from this band (src/main/db/daily.repo.ts). Only
// echoed into the manifest so the reader can assert the band is populated.
const DAILY_RATING_LO = 1200
const DAILY_RATING_HI = 1800

function usage() {
  return `build-puzzle-chunks: split the puzzle DB into static, range-readable chunks

  --src <path>        source SQLite (default resources/data/puzzles.sqlite)
  --out <dir>         output directory (default dist-puzzles/)
  --chunk-bytes <n>   bytes per chunk file (default ${DEFAULT_CHUNK_BYTES}, max ${PAGES_FILE_LIMIT})
  --page-size <n>     SQLite page size of the rebuilt DB (default ${DEFAULT_PAGE_SIZE})
  --cache-mb <n>      SQLite page cache while building (default 512)
  --keep-work         keep the intermediate rebuilt DB instead of deleting it
  --help`
}

function parseArgs(argv) {
  const opts = {
    src: resolve(ROOT, 'resources/data/puzzles.sqlite'),
    out: resolve(ROOT, 'dist-puzzles'),
    chunkBytes: DEFAULT_CHUNK_BYTES,
    pageSize: DEFAULT_PAGE_SIZE,
    cacheMb: 512,
    keepWork: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      const v = argv[++i]
      if (v === undefined) fail(`${a} needs a value`)
      return v
    }
    if (a === '--help' || a === '-h') {
      console.log(usage())
      process.exit(0)
    } else if (a === '--src') opts.src = resolve(process.cwd(), val())
    else if (a === '--out') opts.out = resolve(process.cwd(), val())
    else if (a === '--chunk-bytes') opts.chunkBytes = Number(val())
    else if (a === '--page-size') opts.pageSize = Number(val())
    else if (a === '--cache-mb') opts.cacheMb = Number(val())
    else if (a === '--keep-work') opts.keepWork = true
    else fail(`unknown argument ${a}\n\n${usage()}`)
  }
  if (!Number.isInteger(opts.chunkBytes) || opts.chunkBytes <= 0) fail('--chunk-bytes must be a positive integer')
  if (opts.chunkBytes > PAGES_FILE_LIMIT) {
    fail(`--chunk-bytes ${opts.chunkBytes} exceeds the 25 MiB per-file limit of Cloudflare Pages`)
  }
  // Powers of two only: the range mapper divides by chunkBytes, and the page
  // size must divide it exactly (see DEFAULT_CHUNK_BYTES).
  if (![512, 1024, 2048, 4096, 8192, 16384, 32768, 65536].includes(opts.pageSize)) {
    fail('--page-size must be a power of two between 512 and 65536')
  }
  if (opts.chunkBytes % opts.pageSize !== 0) {
    fail(`--chunk-bytes (${opts.chunkBytes}) must be a multiple of --page-size (${opts.pageSize}) so no page straddles two files`)
  }
  return opts
}

function fail(msg) {
  console.error(`\nbuild-puzzle-chunks: ${msg}\n`)
  process.exit(1)
}

const started = Date.now()
const fmtMs = (ms) => (ms < 90_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}min`)
const fmtBytes = (b) => `${(b / 1e9).toFixed(2)} GB`
let phaseAt = Date.now()
function phase(msg) {
  const now = Date.now()
  console.log(`[${fmtMs(now - started)}] ${msg}`)
  phaseAt = now
}
function done(msg) {
  console.log(`           ${msg} (${fmtMs(Date.now() - phaseAt)})`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  const srcStat = await stat(opts.src).catch(() => null)
  if (!srcStat?.isFile()) {
    fail(
      `source database not found: ${opts.src}\n` +
        `  Build it first (it is git-ignored and ~2 GB):\n` +
        `    npm run setup:puzzles && npm run build:puzzles\n` +
        `  or point at an existing copy with --src <path>.`
    )
  }
  if (srcStat.size < 1_000_000) {
    fail(`source database ${opts.src} is only ${srcStat.size} B. That is not the puzzle DB`)
  }

  await mkdir(opts.out, { recursive: true })
  await assertSpace(opts.out, srcStat.size * 2)

  // Old chunks from a previous run would silently survive a shorter build and
  // be served as trailing garbage, so the output starts clean every time.
  const stale = (await readdir(opts.out)).filter((f) => f.startsWith(CHUNK_PREFIX) || f === MANIFEST_NAME)
  if (stale.length) {
    phase(`clearing ${stale.length} file(s) from a previous build`)
    await Promise.all(stale.map((f) => rm(join(opts.out, f), { force: true })))
  }

  const workPath = join(opts.out, 'puzzles.web.sqlite')
  await rm(workPath, { force: true })

  const stats = buildWebDb(opts, workPath)
  const dbStat = await stat(workPath)
  const chunkCount = Math.ceil(dbStat.size / opts.chunkBytes)
  if (chunkCount > PAGES_FILE_COUNT_LIMIT) {
    fail(`${chunkCount} chunks exceeds the 20,000-file limit of Cloudflare Pages. Raise --chunk-bytes`)
  }

  phase(`splitting ${fmtBytes(dbStat.size)} into ${chunkCount} chunks of ${opts.chunkBytes} B`)
  const sha256 = await split(workPath, dbStat.size, opts)
  done(`sha256 ${sha256.slice(0, 16)}…`)

  const manifest = {
    format: 1,
    builtAt: new Date().toISOString(),
    // Every chunk URL carries this as a cache-buster. Serving pages from two
    // different builds to one reader yields garbage rows, not an error, so a
    // rebuild MUST invalidate anything a browser or CDN still holds.
    buildId: sha256.slice(0, 16),
    sha256,
    source: { path: opts.src.slice(ROOT.length + 1), bytes: srcStat.size, mtimeMs: Math.round(srcStat.mtimeMs) },
    db: {
      bytes: dbStat.size,
      pageSize: opts.pageSize,
      chunkBytes: opts.chunkBytes,
      chunkCount,
      prefix: CHUNK_PREFIX,
      suffixLength: SUFFIX_LENGTH
    },
    ...stats
  }
  await writeFile(join(opts.out, MANIFEST_NAME), `${JSON.stringify(manifest)}\n`)
  // A self-ignoring output directory: this is a multi-GB build artifact and must
  // never reach git, whatever --out the operator picked.
  await writeFile(join(opts.out, '.gitignore'), '# build artifact, never committed\n*\n')

  if (!opts.keepWork) await rm(workPath, { force: true })

  const maxChunk = Math.min(opts.chunkBytes, dbStat.size)
  console.log(`
build-puzzle-chunks: done in ${fmtMs(Date.now() - started)}
  out            ${opts.out}
  puzzles        ${stats.puzzleCount.toLocaleString()} (${stats.ratingMin}–${stats.ratingMax} rating)
  theme rows     ${stats.themeRowCount.toLocaleString()} across ${stats.themes.length} themes
  artifact       ${fmtBytes(dbStat.size)} = ${chunkCount} files, largest ${(maxChunk / 1048576).toFixed(1)} MiB
  manifest       ${MANIFEST_NAME} (${stats.themes.length} theme counts + ${stats.ratingCumulative.length} histogram entries)

Deploy: copy the whole directory to <site>/puzzles/ (the default base URL the
reader looks under), or serve it anywhere same-origin and pass baseUrl.
The host must answer Range requests with 206; chunks are immutable per build,
so serve them with:  Cache-Control: public, max-age=31536000, immutable
`)
}

/** Refuse to start a ~40-minute build that cannot finish. */
async function assertSpace(dir, needBytes) {
  try {
    const fs = await statfs(dir)
    const free = fs.bavail * fs.bsize
    if (free < needBytes) {
      fail(
        `not enough free space on ${dir}: ${fmtBytes(free)} available, ~${fmtBytes(needBytes)} needed ` +
          `(the rebuilt DB plus its chunk copies)`
      )
    }
  } catch {
    // statfs is best-effort; a missing figure must not block the build.
  }
}

/** Rebuild the DB clustered by (Rating, PuzzleId) and collect everything the
 *  browser reader needs to plan queries without touching the network. */
function buildWebDb(opts, workPath) {
  const db = new DatabaseSync(workPath)
  try {
    // page_size only takes effect while the file has no pages, so it must come
    // before any DDL. journal/synchronous are off because a crash here just
    // means re-running the script.
    db.exec(`PRAGMA page_size=${opts.pageSize}`)
    db.exec('PRAGMA journal_mode=OFF')
    db.exec('PRAGMA synchronous=OFF')
    db.exec(`PRAGMA cache_size=${-Math.max(64, opts.cacheMb) * 1024}`)
    db.exec(`ATTACH DATABASE '${srcUri(opts.src)}' AS src`)

    // No PRIMARY KEY on the table: the sorted CREATE INDEX afterwards is far
    // cheaper than 4.7M random B-tree inserts, and a unique index gives the
    // identical plan for `WHERE PuzzleId=?`. Column set + types match the
    // desktop schema exactly (scripts/build_puzzles_db.py) so the reader's rows
    // are the desktop's rows.
    phase('rebuilding `puzzles` clustered by (Rating, PuzzleId): several minutes')
    db.exec(`CREATE TABLE puzzles(
      PuzzleId TEXT NOT NULL, FEN TEXT NOT NULL, Moves TEXT NOT NULL,
      Rating INTEGER NOT NULL, RatingDeviation INTEGER, Popularity INTEGER,
      NbPlays INTEGER, Themes TEXT, GameUrl TEXT, OpeningTags TEXT)`)
    db.exec(`INSERT INTO puzzles(rowid,PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags)
             SELECT ROW_NUMBER() OVER (ORDER BY Rating, PuzzleId),
                    PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
               FROM src.puzzles
              ORDER BY Rating, PuzzleId`)
    const puzzleCount = one(db, 'SELECT COUNT(*) AS n FROM puzzles').n
    done(`${puzzleCount.toLocaleString()} rows`)

    phase('indexing PuzzleId')
    db.exec('CREATE UNIQUE INDEX idx_puzzle_id ON puzzles(PuzzleId)')
    done('idx_puzzle_id')

    // Size of the puzzles table + its id index, measured before the junction
    // table exists. The reader divides it by the row count to decide whether a
    // themed batch is cheaper as a contiguous scan or as point lookups, so it
    // has to exclude the junction bytes to mean anything.
    const puzzleSectionBytes = one(db, 'PRAGMA page_count').page_count * opts.pageSize

    phase('rebuilding `puzzle_themes` (WITHOUT ROWID: the key IS the storage), several minutes')
    db.exec(`CREATE TABLE puzzle_themes(
      Theme TEXT NOT NULL, Rating INTEGER NOT NULL, PuzzleId TEXT NOT NULL,
      PRIMARY KEY (Theme, Rating, PuzzleId)) WITHOUT ROWID`)
    // OR IGNORE: the desktop junction table has no uniqueness constraint, and a
    // duplicated (theme, puzzle) pair upstream must not abort a 40-minute build.
    db.exec('INSERT OR IGNORE INTO puzzle_themes(Theme,Rating,PuzzleId) SELECT Theme,Rating,PuzzleId FROM src.puzzle_themes')
    const themeRowCount = one(db, 'SELECT COUNT(*) AS n FROM puzzle_themes').n
    done(`${themeRowCount.toLocaleString()} rows`)

    // ANALYZE walks every attached database and src is read-only, so detach
    // first. The stats matter more here than on desktop: a mis-planned query in
    // the browser costs round-trips, not microseconds.
    db.exec('DETACH DATABASE src')
    phase('ANALYZE')
    db.exec('ANALYZE')
    done('sqlite_stat1 written')

    phase('collecting manifest statistics')
    const themes = db
      .prepare('SELECT Theme AS key, COUNT(*) AS count FROM puzzle_themes GROUP BY Theme ORDER BY count DESC')
      .all()
    const histogram = db.prepare('SELECT Rating AS rating, COUNT(*) AS n FROM puzzles GROUP BY Rating ORDER BY Rating').all()
    if (!histogram.length) fail('the rebuilt database has no puzzles')
    const ratingMin = histogram[0].rating
    const ratingMax = histogram[histogram.length - 1].rating

    // ratingCumulative[i] = puzzles rated BELOW ratingMin + i. With rowid ==
    // rank in (Rating, PuzzleId) order, that is exactly the rowid of the last
    // puzzle rated below ratingMin + i, which is how the reader turns any
    // rating band into a rowid range with no index descent at all.
    const span = ratingMax - ratingMin + 1
    const ratingCumulative = new Array(span + 1).fill(0)
    const byRating = new Map(histogram.map((r) => [r.rating, r.n]))
    for (let i = 0; i < span; i++) ratingCumulative[i + 1] = ratingCumulative[i] + (byRating.get(ratingMin + i) ?? 0)
    if (ratingCumulative[span] !== puzzleCount) {
      fail(`histogram sums to ${ratingCumulative[span]} but the table holds ${puzzleCount} rows`)
    }
    verifyClustering(db, puzzleCount, ratingMin, ratingCumulative)
    done(`${themes.length} themes, ratings ${ratingMin}–${ratingMax}`)

    const dailyBand = one(
      db,
      'SELECT COUNT(*) AS n FROM puzzles WHERE Rating>=? AND Rating<=?',
      DAILY_RATING_LO,
      DAILY_RATING_HI
    ).n
    if (dailyBand <= 0) fail(`no puzzles in the daily band ${DAILY_RATING_LO}–${DAILY_RATING_HI}`)

    return {
      puzzleCount,
      themeRowCount,
      puzzleRowBytes: Math.round(puzzleSectionBytes / puzzleCount),
      ratingMin,
      ratingMax,
      ratingCumulative,
      themes,
      daily: { ratingLo: DAILY_RATING_LO, ratingHi: DAILY_RATING_HI, bandCount: dailyBand }
    }
  } finally {
    db.close()
  }
}

/** The reader's whole query plan rests on rowid == rank in (Rating, PuzzleId)
 *  order. SQLite assigns rowids in SELECT order here, but "in practice" is not
 *  good enough for an invariant that fails silently as wrong puzzles, so prove
 *  it on a spread of rows before shipping 2 GB. */
function verifyClustering(db, puzzleCount, ratingMin, ratingCumulative) {
  const bounds = one(db, 'SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM puzzles')
  if (bounds.lo !== 1 || bounds.hi !== puzzleCount) {
    fail(`rowids are not 1..${puzzleCount} (got ${bounds.lo}..${bounds.hi}). The clustered rebuild did not take`)
  }
  const probe = db.prepare('SELECT rowid AS rowid, Rating, PuzzleId FROM puzzles WHERE rowid>=? ORDER BY rowid LIMIT 2')
  const step = Math.max(1, Math.floor(puzzleCount / 500))
  let prev = null
  for (let r = 1; r <= puzzleCount; r += step) {
    for (const row of probe.all(r)) {
      if (prev && (row.Rating < prev.Rating || (row.Rating === prev.Rating && row.PuzzleId < prev.PuzzleId))) {
        fail(`row ${row.rowid} (${row.Rating}/${row.PuzzleId}) sorts before row ${prev.rowid}. Table is not clustered`)
      }
      // The histogram must agree with where the row actually landed, or every
      // rowid the reader computes from it is off.
      const below = ratingCumulative[Math.max(0, Math.min(ratingCumulative.length - 1, row.Rating - ratingMin))]
      const above = ratingCumulative[Math.min(ratingCumulative.length - 1, row.Rating - ratingMin + 1)]
      if (row.rowid <= below || row.rowid > above) {
        fail(`row ${row.rowid} rated ${row.Rating} falls outside its histogram range (${below}, ${above}]`)
      }
      prev = row
    }
  }
}

/** SQLite URI for a read-only ATTACH. */
function srcUri(path) {
  if (path.includes("'")) fail(`--src path contains a quote, which cannot be passed to ATTACH: ${path}`)
  return `file:${encodeURI(path).replace(/\?/g, '%3f').replace(/#/g, '%23')}?mode=ro`
}

function one(db, sql, ...params) {
  const row = db.prepare(sql).get(...params)
  if (!row) fail(`query returned no rows: ${sql}`)
  return row
}

/** Byte-exact fixed-size split, hashing the whole file as it goes. Streamed a
 *  chunk at a time so a 2 GB DB never lands in memory. */
async function split(path, size, opts) {
  const hash = createHash('sha256')
  const count = Math.ceil(size / opts.chunkBytes)
  for (let i = 0; i < count; i++) {
    const start = i * opts.chunkBytes
    const end = Math.min(start + opts.chunkBytes, size) - 1
    const name = `${CHUNK_PREFIX}${String(i).padStart(SUFFIX_LENGTH, '0')}`
    // Hash in a pass-through rather than a 'data' listener, which would put the
    // stream in flowing mode before pipeline() wires up the destination.
    const tap = new Transform({
      transform(buf, _enc, cb) {
        hash.update(buf)
        cb(null, buf)
      }
    })
    await pipeline(createReadStream(path, { start, end }), tap, createWriteStream(join(opts.out, name)))
    if ((i + 1) % 10 === 0 || i + 1 === count) console.log(`           chunk ${i + 1}/${count}`)
  }
  return hash.digest('hex')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
