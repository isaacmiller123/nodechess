# nodechess web: deployment guide

The web target ships as **one Docker image**: the SPA (`dist-web`), the Fastify
server + IPC bridge bundles (`dist-server`), and the static content trees the
server serves (games-art, curriculum, famous, personas, openings, manuals).
Running it locally and deploying it to a VPS use the same artifact. See
`docs/WEB-PORT-SPEC.md` for the architecture.

Two pieces of state live OUTSIDE the image:

| What | Where | Why |
| --- | --- | --- |
| Accounts + per-user game DBs | volume at `/data` (`DATA_DIR`) | the only thing you must back up |
| Puzzle DB (`puzzles.sqlite`, ~2.1 GB) | read-only mount (default) or baked into the image | keeps the image lean |

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

Both `-v` mounts are optional: without `/data` the accounts DB lives in an
anonymous volume (fine for a throwaway), and without the puzzle mount the app
runs with puzzle features honestly reporting "not installed".

### docker compose (recommended)

```sh
docker compose up --build -d
# → http://localhost:8080
```

`docker-compose.yml` maps `./data-web → /data` and
`./resources/data → /puzzles` (read-only) and sets
`PUZZLES_PATH=/puzzles/puzzles.sqlite`. That's the whole deployment.

## The puzzle database

`resources/data/puzzles.sqlite` (~2.1 GB, built from the Lichess puzzle dump
via `npm run setup:puzzles && npm run build:puzzles`, or copied from a dev
machine). Three supported configurations:

1. **Volume mount (default).** The DB stays on the host; compose mounts it
   read-only and points `PUZZLES_PATH` at it. Image stays ~small, DB updates
   don't require a rebuild. The DB is in `.dockerignore`, so it never bloats
   the build context either.
2. **Baked into the image.** Useful for single-artifact platforms (registry →
   Fly/Cloud Run style). The Dockerfile takes the DB as a *named build
   context*, which is exempt from `.dockerignore`. No repo edits needed:

   ```sh
   docker build -t nodechess-web \
     --build-arg WITH_PUZZLES=true \
     --build-context puzzles-db=resources/data .
   ```

   The file lands at `/app/resources/data/puzzles.sqlite`, the image's
   default `PUZZLES_PATH`, so no runtime configuration is needed. Expect a
   ~2.3 GB image.
3. **No puzzle DB.** Everything else works; puzzle surfaces show their honest
   "not installed" state.

## Environment variables

All optional: the image defaults are a complete configuration.

| Variable | Image default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `WEB_ROOT` | `/app/dist-web` | Built SPA directory (source default: `<bundle>/../dist-web`). |
| `GAMES_ART_ROOT` | `/app/resources/games-art` | 3D tabletop textures/pieces, served at `/games-art`. Missing dir = procedural fallbacks, warning logged. |
| `DATA_DIR` | `/data` | Server state: `server.sqlite` (accounts + sessions), `users/<id>/app.sqlite` (per-user data), plus the shared anonymous DB for logged-out reads. Source default: `./data-web`. |
| `PUZZLES_PATH` | `/app/resources/data/puzzles.sqlite` | Puzzle DB file. Compose overrides to `/puzzles/puzzles.sqlite`. Missing file = puzzles report "not installed". |
| `TRUST_PROXY` | unset (off) | `1` = trust `X-Forwarded-*` from the reverse proxy in front. **Set this whenever you run behind a proxy**. It is what gives rate limiting real client IPs and lets `X-Forwarded-Proto` mark the session cookie `Secure`. Leave off only when clients hit the container directly (a trusted header would then be client-spoofable). Compose sets it. |
| `COOKIE_SECURE` | unset (auto) | Session-cookie `Secure` flag. Auto = on for https requests **and whenever `NODE_ENV=production`** (so a misconfigured proxy can't downgrade it). `1` forces it on, `0` turns it off: only for plain-http LAN/localhost hosting (Safari refuses `Secure` cookies on `http://localhost`; Chrome/Firefox accept them). |
| `MAX_ACCOUNTS` | `500` | Signup ceiling: each account is an on-disk per-user DB, so an open server refuses account #501 with `403 signups-closed`. |
| `AUTH_RATE_LOGIN` | `10` | Login attempts allowed per IP per minute (429 beyond). |
| `AUTH_RATE_SIGNUP` | `5` | Signups allowed per IP per hour (429 beyond). |
| `MAX_OPEN_USER_DBS` | `32` | Per-user SQLite handles kept open (LRU; cold ones close and reopen on demand). |
| `LOG_LEVEL` | `info` | Pino log level (`silent`…`trace`). |
| `NODE_ENV` | `production` | Set by the image. Also drives the cookie `Secure` default above. |

## Data & backups

Everything worth backing up is `DATA_DIR` (`/data`, i.e. `./data-web` with
compose): accounts, sessions, and every user's games/ratings/school
progress/settings. The puzzle DB and everything in the image are
reproducible, so don't bother backing them up.

```sh
docker compose stop web
cp -a data-web "backup-$(date +%F)"
docker compose start web
```

Stopping first guarantees consistent SQLite files. For a hot backup, use
SQLite's online backup instead of a raw copy (`sqlite3 app.sqlite
".backup out.sqlite"` per file). Restore = put the directory back and start
the container.

Accounts are deliberately friends-scale: username + password (argon2id),
httpOnly session cookie, no email verification or self-service reset. Session
tokens are stored **hashed** (sha256), so a leaked `server.sqlite` does not
yield replayable sessions. The argon2 password hashes do live there, so
treat backups accordingly. Login and signup are rate-limited per IP and
signups stop at `MAX_ACCOUNTS`. One accepted friends-scale limitation:
usernames are enumerable (signup answers 409 for a taken name); login timing
does not leak them, but don't host with the expectation of anonymous
membership.

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

One machine + one volume (SQLite has a single writer; do not scale out):

```sh
fly launch --no-deploy          # detects the Dockerfile, writes fly.toml
fly volumes create data --size 4
```

`fly.toml` essentials:

```toml
[http_service]
  internal_port = 8080
  force_https = true

[[mounts]]
  source = "data"
  destination = "/data"
```

Puzzle DB, either: upload it to the same volume once with
`fly sftp shell` → `put resources/data/puzzles.sqlite /data/puzzles.sqlite`
and set `PUZZLES_PATH=/data/puzzles.sqlite` (`fly secrets set` or `[env]`);
or bake it into the image (option 2 above) and deploy the bigger image.
Then `fly deploy` and keep it at one machine (`fly scale count 1`).

### Hetzner / DigitalOcean (any VPS)

```sh
# on the server (Docker + compose plugin installed)
git clone <your-fork> nodechess && cd nodechess
# copy the puzzle DB from wherever you built it (optional):
#   rsync --progress dev-box:nodechess/resources/data/puzzles.sqlite resources/data/
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
