# nodechess: project instructions

Offline-first chess app: Electron desktop (mac + Windows), a web target, and a standalone seed
node, all built from the same source. A 40-chapter school, 20+ board games, online multiplayer, and
a decentralized account system. Stockfish and the ~4.7M Lichess puzzles are imported at runtime,
not bundled (`docs/DATASETS.md`).

## Build / run

Node, npm and brew live at `/opt/homebrew/bin`, which is NOT on the default PATH. Prepend it
before any npm/node command.

| | |
|---|---|
| Desktop dev | `npm run dev` (electron-vite) |
| Web dev | `npm run dev:web`. The web target ships STATIC: `npm run build:web` + `npm run build:puzzle-chunks` (`docs/DEPLOY-WEB.md`). `npm run start:web` builds SPA + server and serves it, which is the Docker route (`docs/WEB-DEPLOY.md`) |
| Seed node | `npm run dev:seed` / `npm run build:seed`; tray desktop build is `npm run dev:seed:desktop` / `npm run build:seed:desktop` |
| Typecheck | `npm run typecheck` runs three targets (node, web, server); all must be green |
| Tests | `npm run test:*` / `npm run smoke:*`, one script per area under `scripts/` |
| Datasets | `npm run setup` fetches engines + puzzles and builds the derived DBs |

Docs live flat in `docs/`. Start with `docs/architecture.md`; `docs/STATUS.md` is the phase log.

## Chess School is governed by a binding spec

**[docs/SCHOOL-SPEC.md](docs/SCHOOL-SPEC.md) is the source of truth for all School work**:
curriculum, lessons, tests, placement/Elo, and UI. Read it before any School change and conform to
it exactly. It outranks any code comment or prior plan; changes need the owner's approval. The
40-chapter arc it governs is in [docs/school-curriculum.md](docs/school-curriculum.md).

Non-negotiables from that spec:
- **Scale:** beginner → 2000 Elo. A lesson teaches an opening or idea, the scenarios it produces and
  how to exploit them, plus Elo-appropriate warm-up and cool-down puzzles.
- **Placement & unlock:** placement games estimate Elo from accuracy vs engine level; lessons unlock
  up to the user's Elo. Elo is internal grouping only and is never shown.
- **Chapter test:** 10–15 questions, ≥70% to pass, 2 attempts, correct answers hidden on fail,
  failing both means retaking the chapter. 2–4 multiple-choice "key idea" questions, the rest played
  on a board.
- **Look:** chess.com/Lichess-grade, not merely consistent.
- Coach persona is **Viktor**, an exacting old-school master.

## Gotchas

- Keep every React hook above any early return. A hook after a return caused a prior #300 crash.
- Cross-platform desktop: engine and puzzle DB resolve through `src/main/datasets` (imported copies
  first, then bundled). See `docs/DATASETS.md`.
- UI-v1: `src/renderer/src/styles/{tokens,palettes,shell,brand,board-pieces}.css` are installed
  verbatim from `design-lab/v1` and are not edited. `styles/components.css` is the only place for
  additions, and only for surfaces v1 never drew.
- Never show fabricated data in the UI. If a surface needs the network and the network isn't there,
  say so in the UI rather than rendering samples or fixtures.
- No emojis in product UI chrome, labels, buttons, or navigation.
