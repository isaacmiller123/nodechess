# nodechess

nodechess is a board-game app that runs on your own machine. It plays and analyses chess with
Stockfish, teaches it through a 40-chapter school, and ships about twenty other games: chess
variants, xiangqi, shogi, janggi, makruk, go, checkers, othello, connect four, gomoku, hex and
nine men's morris. Each one is playable locally, against a bot, or online. There is one build for
Windows and macOS as a desktop app, and the same source builds a web version.

Single-player works with no network at all once the engine and puzzle database are imported.
Online play is peer-to-peer: two clients connect directly over WebRTC and there is no game server
in between. Games, ratings and school progress are stored on your machine, in SQLite on the
desktop and in browser storage on the web.

## What is in it

- **Analysis**: Stockfish with multi-line evaluation, and a full game review that classifies every
  move, scores accuracy per side, and estimates a rating with an error band.
- **Play**: the engine at any strength, plus Maia neural nets that play like real players in the
  1100–1900 range, plus 24 famous-player bots with their own openings and time habits.
- **Puzzles**: roughly 4.7 million from the Lichess database, with a local rating, theme filters,
  and rush/daily modes.
- **School**: 40 chapters from beginner to about 2000, taught by a coach persona named Viktor.
  Placement estimates where you are and unlocks up to that level.
- **Openings**: the 3,733-line Lichess ECO book, searchable, with live detection on the board.
- **Games**: every game above, in 2D, with 3D boards for chess, checkers, go, gomoku, othello and
  connect four. A variant editor lets you define your own rules and play them.

## Running it

Desktop builds are on the [releases page](https://github.com/isaacmiller123/nodechess/releases/latest):
`nodechess-Setup-*.exe` or the portable `.exe`/`.zip` for Windows, the `.dmg` matching your chip for
macOS. They are unsigned, so Windows shows a SmartScreen prompt (More info → Run anyway) and macOS
needs a right-click → Open on first launch. After installing, open Settings → Datasets and import
the engine and puzzle database once; everything else is bundled.

The web version ships static, with no backend. `npm run build:web` writes the site to `dist-web`,
and `npm run build:puzzle-chunks` writes the puzzle database to `dist-puzzles` as range-readable
chunks the browser queries directly. The two are uploaded separately, because the chunks need a
host that answers HTTP Range requests and a static site host may not. Click by click, from an empty
domain to a live site, is [docs/DEPLOY-WEB.md](docs/DEPLOY-WEB.md).

Self-hosting a server is the alternative:

```bash
docker compose up --build -d     # http://localhost:8080
```

That image serves the SPA from a Fastify server and keeps accounts and per-user game DBs in the
`/data` volume (`DATA_DIR`), which is the only thing it has to back up. TLS, reverse proxy, TURN
and backups are covered in [docs/WEB-DEPLOY.md](docs/WEB-DEPLOY.md); the full public stack, relay
and TURN included, is [deploy/DEPLOY.md](deploy/DEPLOY.md). The static build has no server and no
server-side state, so there is nothing there to back up.

Either route needs `resources/data/puzzles.sqlite` (2.15 GB, built by `npm run setup:puzzles &&
npm run build:puzzles`, see [docs/DATASETS.md](docs/DATASETS.md)). Without it every other feature
still works.

## Accounts

nodechess has no account server. Identity is a keypair derived from a 24-word phrase you hold, and
account data is a signed hash chain that peers store and witness for each other. Nobody can reset
your account for you, which is the point and also the risk. The phrase or the exported keyfile is
the only way back in.

This layer is live, not a preview. Identity, the chain format, ratings, reputation and the
anti-cheat judge are built and tested, and they run on the wire: two strangers pair with no room
code, a third client witnesses the game, and the countersigned result lands in both players'
chains. `npm run smoke:acceptance` asserts that end to end.

What the account screen does today: make an account from a name and password; sign in on a machine
that has never seen it, which resolves your chain over the overlay and enrolls a fresh per-machine
device key; sign in with the 24 words when the password is gone; and pair a second device by
scanning a QR code, which carries a public key and a nonce and never the seed.

The gap is scale rather than function. Rated ladders need real opponents before they mean anything,
and peer discovery over public relays is the part that has not been proven outside a local harness.
Design and parameters are in [docs/ACCOUNTS-SPEC.md](docs/ACCOUNTS-SPEC.md) and
[docs/ACCOUNTS-PARAMS.md](docs/ACCOUNTS-PARAMS.md); current state is in
[docs/STATUS.md](docs/STATUS.md).

Desktop single-player, analysis, puzzles, school and peer-to-peer multiplayer do not depend on any
of this and work today.

## Building from source

Node 26+, npm 11+, and Python 3 for the dataset scripts (3.14+ for its stdlib zstd, or
`pip install zstandard` on older). Package on the OS you are targeting.

```bash
git clone https://github.com/isaacmiller123/nodechess.git
cd nodechess
npm install
npm run dev              # desktop app (electron-vite)
npm run dev:web          # web app
npm run typecheck        # three targets: node, web, server; all must pass
npm run build            # renderer + main bundles
npm run package          # installers for the current OS
```

Large binaries and generated databases are not committed; `npm run setup` fetches and builds them.
Tests are standalone scripts under `scripts/`: run one with `node scripts/<name>.mjs`, or through
the matching `npm run test:*`. CI builds both platforms and runs the suites on each.

There is a third target, `npm run dev:seed`, which is a small standalone page that runs storage and
relay nodes for other players. It shares nothing with the app but the accounts code.

## Layout

```
src/main/      Electron main process: IPC, engine pools, SQLite, dataset importer
src/preload/   the single typed window.api bridge
src/renderer/  React UI; src/renderer/src/games holds the per-game rules and boards
src/shared/    types, wire protocol, and the accounts layer (no Node or DOM)
src/web/       browser entry point and its storage/engine adapters
src/seed/      the standalone node runner
server/        Node server for the self-hosted (Docker) web route
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
