# Games Platform: binding spec (v1, foundations)

Multi-game library for nodechess: every game gets ONLINE (v3 P2P session, game-agnostic) + LOCAL
OTB (accurate flip policy) + 5-level bots + an authored manual (rules + strategy) + Steam-grade
visuals (2D always; 3D per the tier table). User-approved stack (2026-07-06); visual appeal is
PARAMOUNT and gating, like docs/SCHOOL-SPEC.md's look bar.

## Approved stack
- Chess family rules: chessops (8 lichess variants) + ffish-es6 WASM (xiangqi/shogi/janggi/
  makruk/placement + runtime custom variants via variants.ini text).
- Chess family 2D board: chessgroundx (replaces chessground app-wide; same API family).
- Go: @sabaki/shudan (render; Preact, mounted via a preact island or preact/compat) + tenuki
  (rules: captures, superko, dead-stone marking, Chinese+Japanese scoring).
- Checkers: draughtsground vendored from RoepStoep/lidraughts (AGPL; keep as an isolated
  vendored module with attribution; repo is public = compliant) + rapid-draughts (8×8 rules+AI,
  MIT) + @jortvl/draughts (10×10 rules, MPL; audit majority-capture before trust).
- Small games (othello, gomoku, connect4, hex, morris, TTT): hand-rolled rules + bots
  (bitboard negamax/threat-eval; design refs only from unlicensed repos, NO code copying).
- Engines (native, spawned like Stockfish, per-platform artifacts in datasets ENGINE_ARTIFACTS):
  Fairy-Stockfish (all chess-family bots; Skill −20..20, UCI_Elo floor 500; VariantPath for
  custom variants; win-x64 official, mac-arm64 self-compiled), KataGo eigen (go; 5MB binary,
  nets runtime-downloaded: b6c96 4.7MB, b10c128 13.8MB, b18 Human-SL 94.5MB, and the human-like
  levels are the flagship), lc0 + Maia nets (human-like chess 1100–1900, nodes=1).
- 3D/art: ONE shared react-three-fiber tabletop renderer. Poly Haven chess set (CC0, ship
  ~5–15MB GLB); ambientCG CC0 PBR textures for ALL boards (2D + 3D); Kadagaden xiangqi/janggi +
  Ka-hu shogi SVGs (CC-BY → credits screen; also rasterized as 3D disc/wedge decals); lichess
  piece sets ONLY the CC0/MIT/Apache ones. Everything except chess pieces is procedural
  geometry (instanced stones/discs/wedges).

## 3D tiers (user-approved)
WILL: chess+variants, checkers, go, gomoku, othello, connect four. CAN (2D-first): xiangqi,
janggi, shogi, makruk, morris, custom-piece games (decal-token fallback). WON'T: TTT, hex.
2D is first-class for every game; 3D is a per-game toggle; WebGL failure auto-falls back to 2D.

## Architecture
### Game kernel: src/renderer/src/games/kernel.ts
```ts
export interface GameSpec<S = unknown> {
  kind: GameKind                      // 'chess' | 'crazyhouse' | ... | 'go' | 'checkers-intl' | ...
  family: 'chess' | 'draughts' | 'go' | 'grid'
  title: string; tagline: string
  players: ['white','black'] | ['black','white']  // move order, first entry moves first
  board: { layout: 'cells' | 'intersections'; files: number; ranks: number }
  flipPolicy: 'rotate' | 'none'       // OTB auto-flip; go/gomoku/othello/hex/c4 = 'none'
  clock: { supported: boolean; byoyomi?: boolean }   // go gets byo-yomi later; Fischer now
  init(options?: unknown): S
  legalMoves(s: S): string[]          // canonical move strings (game-defined codec)
  play(s: S, move: string): S | null  // null = illegal
  result(s: S): GameResult | null     // null = ongoing
  moveMeta(s: S, move: string): { capture?: boolean; sound?: SoundName }
  serializeOptions?(o: unknown): string   // for wire start config
}
```
Registry: `games/registry.ts` maps kind → GameSpec + renderer component + bot provider +
manual id. Everything (library UI, online, OTB, bots) consumes the registry ONLY.

### Wire v4 (game-agnostic online)
> **The wire is at 6 now** (`src/shared/mp/wire.ts`, `PROTOCOL_VERSION`): v5 added byo-yomi and v6
> added signed play + the witness seat. The game-agnostic design below is unchanged and still
> current; only the number moved. Delta summary in `docs/MP-V3-SPEC.md`.

PROTOCOL_VERSION = 4 (at the time of this phase). MpGameConfig gains `game: { kind: string; options?: unknown }`
(default chess). wire.ts move schema: uci regex → non-empty string ≤ 64 chars (kernel
validates; HOST validates via GameSpec.play before relaying, so authority is unchanged). start/
resync carry game kind+options. Session/clock/suspend/rematch logic UNCHANGED (game-agnostic
already). onlineStore: board-specific bits (fen/chessops) move behind the kernel: store keeps
`moves: string[]` + `gameState: S` via spec.play; terminal via spec.result. Chess stays the
default so EXISTING online chess is untouched behaviorally (regression: test-mp suites green).

### Bots: games/bots.ts
`interface BotProvider { levels: 5; describe(level): string; move(s, level): Promise<string> }`
Chess family → engine.ipc (Fairy-Stockfish; Maia levels where kind==='chess'); go → KataGo GTP
ipc; checkers-8 → rapid-draughts alphaBeta; others → in-process workers. UI: one clean
strength row (1–5) + optional "style" selector when multiple engines exist (e.g. chess:
Classic (SF) / Human (Maia) / Weak-calibrated). Never more than two controls.

### Library UI
New top-level tab **Games** (rail icon): card grid (per-game live-board thumbnail, NOT stock
icons), each card → game page with sub-tabs Play (Local OTB / vs Bot / Online, the same trio as
chess Play), Manual. Online reuses the online machinery parameterized by kind (host card shows
the game name; join code works across games: start config carries kind; joiner UI renders it).
The shared live-game chrome is `features/play/online/OnlineChrome.tsx`, rendered around both the
chess `GameView` and the kernel path (`features/play/online/KernelOnlineGame.tsx`).
Manuals: `resources/manuals/<kind>.md` (rules, how to read the board, 3 beginner principles,
2 classic traps/patterns with diagrams) rendered in-app with board diagrams (FEN/position
snippets rendered by the game's 2D board component, read-only).

## Bot side-quests (user-requested, this phase)
1. **Sub-1320 Stockfish refinement**: current sub-floor path = main-process MultiPV softmax.
   Candidates to evaluate and CALIBRATE: (a) Fairy-Stockfish UCI_Elo (floor 500) as the new
   sub-1320 backend for standard chess; (b) improved softmax w/ eval-gap temperature +
   blunder-rate targets per band; (c) Maia-1100 for the 1100–1320 band. Deliver: measured
   move-match/blunder-rate calibration harness + the chosen implementation wired in.
2. **Maia**: lc0 binary (mac-arm64 self-build or homebrew bottle extraction; win-x64 official
   release) + maia-1100..1900 weights via datasets (small files). Play at nodes=1. Expose as
   the "Human" style for chess bots 1100–1900.

## Phases
- **P1 foundations: DONE** (commit 1822c36): kernel + registry; wire v4 + store genericization
  (chess regression green); Games tab shell + library cards; chess-variant wave via chessops
  (chess + 8 variants playable local+online+bots via existing SF path); bot side-quests
  (sub-1320 calibration + Maia groundwork) started.
- **P2: DONE** (commits 09015df, d985ece): ffish family (xiangqi/shogi/janggi/makruk +
  placement), checkers both, go+gomoku (Shudan+tenuki), othello/c4/hex/morris/TTT; Fairy-SF +
  KataGo + lc0 published in datasets for BOTH platforms; manuals authored for all **23** games,
  one per `GameKind` (`resources/manuals/`, `scripts/test-manuals.mjs` green).
- **P3: DONE** (commits d552b10..2110058): 3D shared renderer + assets (Tabletop3D lazy chunk,
  Poly Haven chess set, per-game 2D/3D toggle per the tier table) DONE; custom variant editor
  (Variant Lab: variants.ini builder UI + ffish.loadVariantConfig + Fairy-SF VariantPath) DONE;
  visual polish audits per game DONE (305bf3d).
- **Shipped, status as of 2026-07-27 (app v1.3.0).** Both P3 open items are closed.
  `.github/workflows/build.yml` now runs the game and platform suites on BOTH OS legs, not just
  typecheck+build+package. And the games platform ships in tagged releases: P1 through P3 are all
  contained in **v1.1.0** (`git tag --contains 1822c36`), and tags now run through **v1.3.0**,
  matching `package.json`.

## Quality gates (every phase)
typecheck+build clean; test-mp/test-mp-store stay green (chess online untouched); new
games/kernel suites headless in node; per-game screenshot audit vs reference before "shipped";
no game bot ships without BOTH platforms' binaries wired in datasets.
