// fetch-lichess-sounds.mjs: download the Lichess "standard" sound set for the
// 'standard' (Lichess-style) sound theme.
//
//   node scripts/fetch-lichess-sounds.mjs
//
// Sources files from the lichess-org/lila repository (public/sound/standard),
// pinned to a specific commit for reproducibility, renames them to nodechess's
// sound-event vocabulary, and writes an ATTRIBUTION.md next to the assets.
//
// Licensing: per lila's COPYING.md, files not listed as exceptions are
// "part of lila and copyright (c) 2012-2026 the lila authors" under the
// GNU AGPL v3 (or any later version). public/sound/standard is NOT listed as
// an exception, so these sounds are AGPLv3+. nodechess is GPL-3.0-or-later, and
// these files remain under their own AGPLv3+ terms (see ATTRIBUTION.md).
//
// Event mapping (what Lichess actually plays):
//   move        <- Move.mp3
//   capture     <- Capture.mp3
//   gameStart   <- GenericNotify.mp3   (round start "dong")
//   gameEnd     <- (alias of gameStart in SoundManager: Victory/Defeat/Draw
//                   are all symlinks to GenericNotify.mp3 upstream)
//   lowTime     <- LowTime.mp3
//   puzzleSolved  <- Confirmation.mp3
//   puzzleFailed  <- Error.mp3
//   castle/check/promote. No dedicated Lichess sound (Check.mp3 is literally a
//   symlink to Silence); SoundManager aliases them to 'move' for this theme.
//
// No dependencies; Node 18+ (global fetch).

import { mkdir, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** lila commit these assets are pinned to (master @ 2026-07-02). */
const LILA_COMMIT = 'ecf6f39ed8b5dc6d9b5d6847954e8cd332127b1d'
const RAW_BASE = `https://raw.githubusercontent.com/lichess-org/lila/${LILA_COMMIT}/public/sound/standard`

const OUT_DIR = path.resolve(__dirname, '../src/renderer/src/assets/sounds/standard')
const ATTRIBUTION_PATH = path.resolve(__dirname, '../src/renderer/src/assets/sounds/ATTRIBUTION.md')

/** Our event file name -> upstream lila file name. */
const FILES = [
  ['move.mp3', 'Move.mp3'],
  ['capture.mp3', 'Capture.mp3'],
  ['gameStart.mp3', 'GenericNotify.mp3'],
  ['lowTime.mp3', 'LowTime.mp3'],
  ['puzzleSolved.mp3', 'Confirmation.mp3'],
  ['puzzleFailed.mp3', 'Error.mp3']
]

/** A real MP3 starts with an ID3 tag or an MPEG frame sync, never ASCII text
 *  (the repo stores some "files" as symlink path text; reject those). */
function looksLikeMp3(buf) {
  if (buf.length < 512) return false
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true // 'ID3'
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 // frame sync
}

async function fetchOne(ourName, theirName) {
  const url = `${RAW_BASE}/${theirName}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!looksLikeMp3(buf)) {
    throw new Error(`${theirName}: payload does not look like an MP3 (${buf.length} bytes)`)
  }
  const outPath = path.join(OUT_DIR, ourName)
  await writeFile(outPath, buf)
  return { ourName, theirName, bytes: buf.length }
}

const ATTRIBUTION = `# Sound asset attribution

## \`standard/\`: Lichess standard sound set

The files in \`standard/\` are the "standard" sound set from
[Lichess](https://lichess.org), copied from the
[lichess-org/lila](https://github.com/lichess-org/lila) repository at commit
[\`${LILA_COMMIT.slice(0, 12)}\`](https://github.com/lichess-org/lila/tree/${LILA_COMMIT}/public/sound/standard)
(\`public/sound/standard/\`) and renamed to this app's sound-event names:

| File here | Upstream file |
| --- | --- |
${FILES.map(([ours, theirs]) => `| \`standard/${ours}\` | \`public/sound/standard/${theirs}\` |`).join('\n')}

Notes on fidelity: Lichess has no dedicated castle/check/promote sounds
(\`Check.mp3\` upstream is a symlink to \`Silence.mp3\`), and its
Victory/Defeat/Draw cues are all symlinks to \`GenericNotify.mp3\`. This app
mirrors that by aliasing castle/check/promote to \`move.mp3\` and the game-end
event to \`gameStart.mp3\` (both are \`GenericNotify.mp3\` upstream) in
\`src/renderer/src/sound/SoundManager.ts\`.

**License:** GNU Affero General Public License v3 or any later version
(AGPL-3.0-or-later). Per lila's
[COPYING.md](https://github.com/lichess-org/lila/blob/${LILA_COMMIT}/COPYING.md),
every file that does not state otherwise and is not listed as an exception is
"part of lila and copyright (c) 2012-2026 the lila authors";
\`public/sound/standard\` is not listed as an exception. The full license text
is available at <https://www.gnu.org/licenses/agpl-3.0.txt>. Copyright
(c) 2012-2026 the lila authors
(<https://github.com/lichess-org/lila/graphs/contributors>).

These sound files are unmodified apart from renaming. They are distributed as
data assets alongside (not linked into) this GPL-3.0-or-later application.

## \`classic/\` and \`real/\`, generated in-repo

The WAV files in \`classic/\` and \`real/\` are original works synthesized
offline by \`scripts/gen-sounds.mjs\` in this repository (pure-Node procedural
audio; no third-party recordings or samples). They are covered by this
project's own license (GPL-3.0-or-later, see /LICENSE).

Regenerate with:

\`\`\`sh
node scripts/fetch-lichess-sounds.mjs   # standard/ (network required)
node scripts/gen-sounds.mjs             # classic/ + real/ (offline)
\`\`\`
`

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const results = []
  for (const [ours, theirs] of FILES) {
    const r = await fetchOne(ours, theirs)
    results.push(r)
    console.log(`  ${r.ourName.padEnd(18)} <- ${r.theirName.padEnd(20)} ${r.bytes} bytes`)
  }
  await writeFile(ATTRIBUTION_PATH, ATTRIBUTION)
  const total = results.reduce((n, r) => n + r.bytes, 0)
  console.log(`standard theme: ${results.length} files, ${(total / 1024).toFixed(1)} KiB total`)
  console.log(`attribution: ${path.relative(process.cwd(), ATTRIBUTION_PATH)}`)
  await stat(ATTRIBUTION_PATH) // sanity: throws if the write silently failed
}

main().catch((err) => {
  console.error('fetch-lichess-sounds failed:', err.message)
  process.exitCode = 1
})
