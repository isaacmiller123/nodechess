# nodechess

nodechess is a board-game app that runs on your own machine. It plays and analyses chess with
Stockfish, teaches it through a 40-chapter school, and ships about twenty other games —
chess variants, xiangqi, shogi, janggi, makruk, go, checkers, othello, connect four, gomoku, hex,
nine men's morris — each playable locally, against a bot, or online. There is one build for
Windows and macOS as a desktop app, and the same source builds a web version.

Single-player works with no network at all once the engine and puzzle database are imported.
Online play is peer-to-peer: two clients connect directly over WebRTC and there is no game server
in between. Games, ratings and school progress are stored on your machine, in SQLite on the
desktop and in browser storage on the web.

## What is in it

- **Analysis** — Stockfish with multi-line evaluation, and a full game review that classifies every
  move, scores accuracy per side, and estimates a rating with an error band.
- **Play** — the engine at any strength, plus Maia neural nets that play like real players in the
  1100–1900 range, plus 24 famous-player bots with their own openings and time habits.
- **Puzzles** — roughly 4.7 million from the Lichess database, with a local rating, theme filters,
  and rush/daily modes.
- **School** — 40 chapters from beginner to about 2000, taught by a coach persona named Viktor.
  Placement estimates where you are and unlocks up to that level.
- **Openings** — the 3,733-line Lichess ECO book, searchable, with live detection on the board.
- **Games** — every game above, in 2D, with 3D boards for chess, checkers, go, gomoku, othello and
  connect four. A variant editor lets you define your own rules and play them.

## Running it

Desktop builds are on the [releases page](https://github.com/isaacmiller123/nodechess/releases/latest):
`nodechess-Setup-*.exe` or the portable `.exe`/`.zip` for Windows, the `.dmg` matching your chip for
macOS. They are unsigned, so Windows shows a SmartScreen prompt (More info → Run anyway) and macOS
needs a right-click → Open on first launch. After installing, open Settings → Datasets and import
the engine and puzzle database once; everything else is bundled.

To host the web version:

```bash
docker compose up --build -d     # http://localhost:8080
```

Puzzles need `resources/data/puzzles.sqlite` (~2.1 GB, built by `npm run setup:puzzles &&
npm run build:puzzles`). Without it every other feature still works. TLS, reverse proxy, TURN and
backups are covered in [docs/WEB-DEPLOY.md](docs/WEB-DEPLOY.md); putting it on a public domain is
[deploy/DEPLOY.md](deploy/DEPLOY.md).

## Accounts

nodechess has no account server. Identity is a keypair derived from a 24-word phrase you hold, and
account data is a signed hash chain that peers store and witness for each other. Nobody can reset
your account for you, which is the point and also the risk — the phrase or the exported keyfile is
the only way back in.

This layer is built but **not finished**. The cryptography, the chain format, ratings, reputation
and the anti-cheat judge all exist and are tested. What does not work yet is the network: presence,
friends, mailbox and verdict publishing do not sync between peers, so those screens in the app show
sample data behind a `DEV_FIXTURE` badge rather than pretending to be live. The anti-cheat scoring
also still needs recalibration against real games before any rated play should count. Design and
parameters are in [docs/ACCOUNTS-SPEC.md](docs/ACCOUNTS-SPEC.md) and
[docs/ACCOUNTS-PARAMS.md](docs/ACCOUNTS-PARAMS.md); current state is in
[docs/STATUS.md](docs/STATUS.md).

Desktop single-player, analysis, puzzles, school and peer-to-peer multiplayer do not depend on any
of this and work today.

## Building from source

Node 24+, npm 11+, and Python 3 for the dataset scripts. Package on the OS you are targeting.

```bash
git clone https://github.com/isaacmiller123/nodechess.git
cd nodechess
npm install
npm run dev              # desktop app (electron-vite)
npm run dev:web          # web app
npm run typecheck        # node, web and server targets — all three must pass
npm run build            # renderer + main bundles
npm run package          # installers for the current OS
```

Large binaries and generated databases are not committed; `npm run setup` fetches and builds them.
Tests are standalone scripts under `scripts/` — run one with `node scripts/<name>.mjs`, or through
the matching `npm run test:*`. CI builds both platforms and runs the suites on each.

There is a third target, `npm run dev:seed`, which is a small standalone page that runs storage and
relay nodes for other players. It shares nothing with the app but the accounts code.

## Layout

```
src/main/      Electron main process — IPC, engine pools, SQLite, dataset importer
src/preload/   the single typed window.api bridge
src/renderer/  React UI; src/renderer/src/games holds the per-game rules and boards
src/shared/    types, wire protocol, and the accounts layer — no Node or DOM
src/web/       browser entry point and its storage/engine adapters
src/seed/      the standalone node runner
server/        Node server for the web build
scripts/       dataset builders and the test suites
docs/          architecture and the binding specs
```

## Licensing

GPL-3.0-or-later (see [LICENSE](LICENSE)), because the app distributes Stockfish and
Fairy-Stockfish. Bundled and imported third-party content is listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [docs/CREDITS.md](docs/CREDITS.md): engines
under GPL-3.0 or MIT, the Lichess puzzle and opening data under CC0, and piece sets, board
textures, 3D models and sounds under their own open licenses. No proprietary assets are included,
and the project is not affiliated with Lichess, Chess.com, or the Stockfish team.
