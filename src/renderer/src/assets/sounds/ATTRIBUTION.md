# Sound asset attribution

## `standard/`: Lichess standard sound set

The files in `standard/` are the "standard" sound set from
[Lichess](https://lichess.org), copied from the
[lichess-org/lila](https://github.com/lichess-org/lila) repository at commit
[`ecf6f39ed8b5`](https://github.com/lichess-org/lila/tree/ecf6f39ed8b5dc6d9b5d6847954e8cd332127b1d/public/sound/standard)
(`public/sound/standard/`) and renamed to this app's sound-event names:

| File here | Upstream file |
| --- | --- |
| `standard/move.mp3` | `public/sound/standard/Move.mp3` |
| `standard/capture.mp3` | `public/sound/standard/Capture.mp3` |
| `standard/gameStart.mp3` | `public/sound/standard/GenericNotify.mp3` |
| `standard/lowTime.mp3` | `public/sound/standard/LowTime.mp3` |
| `standard/puzzleSolved.mp3` | `public/sound/standard/Confirmation.mp3` |
| `standard/puzzleFailed.mp3` | `public/sound/standard/Error.mp3` |

Notes on fidelity: Lichess has no dedicated castle/check/promote sounds
(`Check.mp3` upstream is a symlink to `Silence.mp3`), and its
Victory/Defeat/Draw cues are all symlinks to `GenericNotify.mp3`. This app
mirrors that by aliasing castle/check/promote to `move.mp3` and the game-end
event to `gameStart.mp3` (both are `GenericNotify.mp3` upstream) in
`src/renderer/src/sound/SoundManager.ts`.

**License:** GNU Affero General Public License v3 or any later version
(AGPL-3.0-or-later). Per lila's
[COPYING.md](https://github.com/lichess-org/lila/blob/ecf6f39ed8b5dc6d9b5d6847954e8cd332127b1d/COPYING.md),
every file that does not state otherwise and is not listed as an exception is
"part of lila and copyright (c) 2012-2026 the lila authors";
`public/sound/standard` is not listed as an exception. The full license text
is available at <https://www.gnu.org/licenses/agpl-3.0.txt>. Copyright
(c) 2012-2026 the lila authors
(<https://github.com/lichess-org/lila/graphs/contributors>).

These sound files are unmodified apart from renaming. They are distributed as
data assets alongside (not linked into) this GPL-3.0-or-later application.

## `classic/`, `real/` and `games/`, generated in-repo

The WAV files in `classic/` and `real/` are original works synthesized
offline by `scripts/gen-sounds.mjs` in this repository (pure-Node procedural
audio; no third-party recordings or samples). The files in `games/` (the
games-platform events: goStone, discFlip, discPlace, discDrop,
pieceSlideCapture, penStroke, shogiPiece, gameStartGong) are likewise
synthesized by `scripts/gen-game-sounds.mjs`; that directory is a
theme-agnostic pool served under all three themes (see
`src/renderer/src/sound/SoundManager.ts`). All are covered by this
project's own license (GPL-3.0-or-later, see /LICENSE).

Regenerate with:

```sh
node scripts/fetch-lichess-sounds.mjs   # standard/ (network required)
node scripts/gen-sounds.mjs             # classic/ + real/ (offline)
node scripts/gen-game-sounds.mjs        # games/ (offline)
node scripts/check-game-sounds.mjs      # verify games/ (levels/size gate)
```
