# nodechess web: self-hosting the Docker image

> **This is the self-hosted route.** For the live deployment (static SPA on Cloudflare Pages,
> puzzle chunks in R2) see `docs/DEPLOY-WEB.md`; for the relay and TURN stack see
> `deploy/DEPLOY.md`.

This image is **one way to host the same static SPA yourself**, with COOP/COEP
already set: the SPA (`dist-web`), the Fastify server + IPC bridge bundles
(`dist-server`), and the static content trees the server serves (games-art,
curriculum, famous, personas, openings, manuals). Running it locally and
deploying it to a VPS use the same artifact. See `docs/WEB-PORT-SPEC.md` for the
architecture.

**Where the app's data actually lives: the browser.** The shipped web client
talks to no server for game data. Games, ratings, settings, puzzle attempts,
stored reviews and School progress are all browser-local
(`src/web/webApi.ts`: "NOTHING here talks to a server"), and accounts are
decentralized (`docs/ACCOUNTS-SPEC.md`). What this container adds on top of a
plain static host is the cross-origin-isolation headers, the games-art tree, and
a legacy `/api/ipc` bridge that the shipped client does not call. Read that
before you plan backups: **`DATA_DIR` is not where a player's games live.**

| What | Where | Why |
| --- | --- | --- |
| Per-player games, ratings, School progress | the player's own browser | no server copy exists; clearing site data clears it |
| Interim accounts + per-user DBs (`ACCOUNTS_DECENTRALIZED=0` only) | volume at `/data` (`DATA_DIR`) | empty and unused on a default build |
| Puzzle chunks the browser reads | wherever `VITE_PUZZLE_BASE_URL` points (baked at build time) | see "The puzzle database" below |
| Puzzle DB (`puzzles.sqlite`, ~2.1 GB) for the `/api/ipc` bridge | read-only mount or baked into the image | not read by the shipped browser client |

## Quickstart

### docker run

```sh
docker build -t nodechess-web .
docker run -d --name chess-web \
  -p 8080:8080 \
  -v "$PWD/data-web:/data" \
  -v "$PWD/resources/data:/puzzles:ro" \
  -e PUZZLES_PATH=/puzzles/puzzles.sqlite \
  --restart unless-stopped \
  nodechess-web
# → http://localhost:8080
```

Both `-v` mounts are optional, and on a default build neither carries player
data: `/data` is only used by the interim accounts (off by default, see the env
table), and the puzzle mount feeds the `/api/ipc` bridge, which the browser
client does not call. **Browser puzzles need the separate step below.**

### docker compose (recommended)

```sh
docker compose up --build -d
# → http://localhost:8080
```

`docker-compose.yml` maps `./data-web → /data` and
`./resources/data → /puzzles` (read-only) and sets
`PUZZLES_PATH=/puzzles/puzzles.sqlite`. That's the whole deployment.

## The puzzle database

**Read this before mounting 2.1 GB of anything.** The browser does not ask the
server for puzzles. It reads a **chunked copy** of the puzzle DB directly over
HTTP `Range`: 60 files of 24 MiB plus a manifest, built by
`npm run build:puzzle-chunks` into `dist-puzzles/`. The address it reads from is
`VITE_PUZZLE_BASE_URL`, **baked into the SPA at build time**, defaulting to
`<base>puzzles/` (`src/web/data/puzzleSource.ts`). `PUZZLES_PATH` and the
`puzzles.sqlite` mount below feed only the `/api/ipc` bridge, which the shipped
client never calls.

`.env.production` is operator-local and git-ignored, so a fresh clone has none
and the build falls back to same-origin `<base>puzzles/`. **If you copied a
`.env.production` from somewhere, check it**: a value pointing at another
operator's bucket bakes in an address your users cannot read, because that
bucket's CORS rules list that operator's origins and not yours. Pick one of
these:

1. **Serve the chunks from your own container.** Build them
   (`npm run build:puzzle-chunks`), copy `dist-puzzles/*` into the SPA directory
   under `puzzles/` (i.e. `$WEB_ROOT/puzzles/`, which is the default base), and
   rebuild the image or bind-mount it in. Adds ~1.4 GB to whatever you copy it
   into. Then run the `206` check from `docs/DEPLOY-WEB.md` 6.6 against your own
   host: an origin that answers `200` with the whole 24 MiB chunk makes every
   puzzle read pull 24 MB, which is the failure this is all about.
2. **Serve them from an object store.** Any origin that does real byte serving
   and allows your site's origin in CORS with `Content-Range` in
   `exposeHeaders`. Set `VITE_PUZZLE_BASE_URL=https://your-host/` in
   `.env.production` **before** `npm run build:web`, then rebuild the image.
   The exact header set and the verification curls are in `docs/DEPLOY-WEB.md`
   Part 6.
3. **No puzzle chunks.** Everything else works; puzzle surfaces show their
   honest "not installed" state and `datasets.status` reports `puzzles:false`.

### The server-side `puzzles.sqlite` (bridge only)

`resources/data/puzzles.sqlite` (~2.1 GB, built from the Lichess puzzle dump via
`npm run setup:puzzles && npm run build:puzzles`, or copied from a dev machine)
is what `PUZZLES_PATH` points at. It is read by the `/api/ipc` puzzle channels
only, so on a default build you can skip it entirely. If you do want it:

- **Volume mount (what compose does).** The DB stays on the host, mounted
  read-only, `PUZZLES_PATH` pointed at it. The DB is in `.dockerignore`, so it
  never bloats the build context.
- **Baked into the image.** For single-artifact platforms (registry →
  Fly/Cloud Run style). The Dockerfile takes the DB as a *named build context*,
  which is exempt from `.dockerignore`:

  ```sh
  docker build -t nodechess-web \
    --build-arg WITH_PUZZLES=true \
    --build-context puzzles-db=resources/data .
  ```

  The file lands at `/app/resources/data/puzzles.sqlite`, the image's default
  `PUZZLES_PATH`. Expect a ~2.3 GB image.

## Environment variables

All optional: the image defaults are a complete configuration.

Rows marked **(interim accounts only)** do nothing on a default build.
`scripts/build-server.mjs` bakes `ACCOUNTS_DECENTRALIZED` **on** into every
shipped bundle, so `server/index.ts` registers the 410 gate instead of the auth
routes and `/api/auth/*` answers `410 Gone, superseded`. They come back only if
you restart with `ACCOUNTS_DECENTRALIZED=0`, which is the reversible emergency
fallback described in `server/afinal.ts`, not a supported deployment.

| Variable | Image default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `WEB_ROOT` | `/app/dist-web` | Built SPA directory (source default: `<bundle>/../dist-web`). Also where `puzzles/` goes if you self-serve the chunks. |
| `GAMES_ART_ROOT` | `/app/resources/games-art` | 3D tabletop textures/pieces, served at `/games-art`. Missing dir = procedural fallbacks, warning logged. |
| `ACCOUNTS_DECENTRALIZED` | `on` (baked in at build) | `0`/`off` re-enables the interim server accounts and every row below marked interim. `server/afinal.ts`. |
| `DATA_DIR` | `/data` | Server state: `server.sqlite` (accounts + sessions), `users/<id>/app.sqlite`, plus the shared anonymous DB. **Not where a player's games live** (those are in the browser). Effectively unused on a default build. Source default: `./data-web`. |
| `PUZZLES_PATH` | `/app/resources/data/puzzles.sqlite` | Puzzle DB for the `/api/ipc` bridge only; the browser reads the chunked artifact instead. Compose overrides to `/puzzles/puzzles.sqlite`. Missing file = the bridge's puzzle channels degrade to empty results. |
| `RESOURCES_ROOT` | unset → `/app/resources` | Content tree the bridge reads: curriculum, famous, personas, openings. Source default is `<bundle>/../resources`, which the image layout resolves to `/app/resources`. |
| `BRIDGE_PATH` | unset → `/app/dist-server/ipc-bridge.cjs` | The prebundled IPC bridge. Absent file = `/api/ipc` stays an honest 503 and the static server still works. |
| `TRUST_PROXY` | unset (off) | `1` = trust `X-Forwarded-*` from the reverse proxy in front. **Set this whenever you run behind a proxy**: it is what gives rate limiting real client IPs. (It also lets `X-Forwarded-Proto` mark the session cookie `Secure`, which matters only with interim accounts.) Leave off only when clients hit the container directly (a trusted header would then be client-spoofable). Compose sets it. |
| `COOKIE_SECURE` | unset (auto) | **(interim accounts only)** Session-cookie `Secure` flag. Auto = on for https requests **and whenever `NODE_ENV=production`**. `1` forces it on, `0` turns it off: only for plain-http LAN/localhost hosting (Safari refuses `Secure` cookies on `http://localhost`; Chrome/Firefox accept them). |
| `MAX_ACCOUNTS` | `500` | **(interim accounts only)** Signup ceiling: each account is an on-disk per-user DB, so an open server refuses account #501 with `403 signups-closed`. |
| `AUTH_RATE_LOGIN` | `10` | **(interim accounts only)** Login attempts allowed per IP per minute (429 beyond). |
| `AUTH_RATE_SIGNUP` | `5` | **(interim accounts only)** Signups allowed per IP per hour (429 beyond). |
| `MAX_OPEN_USER_DBS` | `32` | **(interim accounts only)** Per-user SQLite handles kept open (LRU; cold ones close and reopen on demand). |
| `LOG_LEVEL` | `info` | Pino log level (`silent`…`trace`). |
| `NODE_ENV` | `production` | Set by the image. Also drives the cookie `Secure` default above. |

## Data & backups

**On a default build there is nothing on the server to back up.** Player data
lives in each player's browser, so `DATA_DIR` stays effectively empty, and the
image, the puzzle chunks and the content trees are all reproducible from the
repo. What a self-hoster owes their players is not a backup policy but honesty:
clearing site data, or a browser that evicts storage, loses that player's games.
Accounts are decentralized (`docs/ACCOUNTS-SPEC.md`) and their recovery story is
the account's own, not the host's.

If you deliberately run with `ACCOUNTS_DECENTRALIZED=0`, then `DATA_DIR`
(`/data`, i.e. `./data-web` with compose) holds accounts, sessions and every
user's games/ratings/school progress/settings, and it is the only thing you must
back up:

```sh
docker compose stop web
cp -a data-web "backup-$(date +%F)"
docker compose start web
```

Stopping first guarantees consistent SQLite files. For a hot backup, use
SQLite's online backup instead of a raw copy (`sqlite3 app.sqlite
".backup out.sqlite"` per file). Restore = put the directory back and start
the container.

Those interim accounts are deliberately friends-scale: username + password
(argon2id), httpOnly session cookie, no email verification or self-service
reset. Session tokens are stored **hashed** (sha256), so a leaked
`server.sqlite` does not yield replayable sessions. The argon2 password hashes
do live there, so treat backups accordingly. Login and signup are rate-limited
per IP and signups stop at `MAX_ACCOUNTS`. One accepted friends-scale
limitation: usernames are enumerable (signup answers 409 for a taken name);
login timing does not leak them, but don't host with the expectation of
anonymous membership.

## Reverse proxy & TLS

Run the container on localhost and put your TLS proxy in front. Four things
matter:

1. **Set `TRUST_PROXY=1` on the container.** Without it the server ignores
   `X-Forwarded-*` entirely: every request appears to come from the proxy's
   IP (making the per-IP auth rate limits one shared bucket) and
   `X-Forwarded-Proto` is not honored. Compose already sets it.
2. **Do not strip or override `Cross-Origin-Opener-Policy` /
   `Cross-Origin-Embedder-Policy`.** The server sets
   `same-origin` / `require-corp` on every response; the browser only grants
   `SharedArrayBuffer` (multi-threaded Stockfish WASM) in that isolated
   context. Boilerplate "security headers" proxy snippets that set their own
   `Cross-Origin-*` values will silently break the engines.
3. **Forward `X-Forwarded-Proto` and preserve `Host`** (the snippets below do
   both). The proto marks session cookies `Secure`. The Host header is what
   the same-origin check on mutating `/api` calls compares against. In
   production the cookie is `Secure` even if the proxy forgets the proto
   header (see `COOKIE_SECURE`).
4. **WebSockets: nothing to configure.** Online multiplayer is trystero over
   WebRTC. The *browser* talks to public relays and peers directly; your
   server never carries game traffic and exposes no WebSocket endpoints.

Caddy is the two-line option (automatic TLS, preserves upstream headers,
forwards `X-Forwarded-Proto`):

```caddyfile
chess.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx equivalent:

```nginx
server {
    listen 443 ssl http2;
    server_name chess.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Do NOT add your own Cross-Origin-* headers here.
    }
}
```

Optional: enable gzip/brotli at the proxy. The WASM engine and SPA chunks
are multi-megabyte and compress well (the Node server serves them
uncompressed).

## Hosting sketches

### Fly.io

On a default build the container is stateless, so this is just "run the image":

```sh
fly launch --no-deploy          # detects the Dockerfile, writes fly.toml
```

`fly.toml` essentials:

```toml
[http_service]
  internal_port = 8080
  force_https = true
```

Add a volume only if you are running the interim accounts
(`ACCOUNTS_DECENTRALIZED=0`), in which case SQLite has a single writer, so it is
one machine (`fly scale count 1`) and one volume:

```sh
fly volumes create data --size 4
```
```toml
[[mounts]]
  source = "data"
  destination = "/data"
```

Puzzles: build the chunks and either put them in an object store and set
`VITE_PUZZLE_BASE_URL` before building the image, or copy them into the SPA
directory as `dist-web/puzzles/`. The `puzzles.sqlite` volume upload only feeds
the `/api/ipc` bridge and is not needed for the browser.

### Hetzner / DigitalOcean (any VPS)

```sh
# on the server (Docker + compose plugin installed)
git clone <your-fork> nodechess && cd nodechess
# set your own puzzle chunk address BEFORE building, or the SPA bakes in the
# project's bucket, which will not serve your origin:
#   echo 'VITE_PUZZLE_BASE_URL=https://your-host/' > .env.production
docker compose up --build -d
```

Put Caddy/nginx in front as above, point DNS at the box, done. To update, run
`git pull && docker compose up --build -d`. Clients pick up the new version
on refresh (`index.html` is served no-cache; hashed assets are immutable).

## Health & operations

- `GET /healthz` → `{ ok: true, version, ts }`; the image's `HEALTHCHECK`
  polls it, so `docker ps` shows `(healthy)`.
- Logs: structured JSON on stdout (`docker logs chess-web`), verbosity via
  `LOG_LEVEL`.
- The container runs as the unprivileged `node` user; `/data` is pre-created
  and writable. If you bind-mount a host directory over `/data` on Linux,
  make sure it's writable by uid 1000 (`chown 1000:1000 data-web`).
