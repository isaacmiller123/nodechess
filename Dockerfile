# syntax=docker/dockerfile:1
# nodechess web (docs/WEB-PORT-SPEC.md, deploy guide: docs/WEB-DEPLOY.md).
#
# One image = the whole web app: SPA + Fastify server + IPC bridge + the static
# content trees the server serves. `docker run -p 8080:8080` is the local host
# AND the deploy artifact (same image on any VPS).
#
#   docker build -t nodechess-web .
#   docker run --rm -p 8080:8080 -v "$PWD/data-web:/data" nodechess-web
#
# Puzzle DB (~2.1 GB resources/data/puzzles.sqlite). Two options:
#   1. VOLUME (default, keeps the image lean): mount it read-only at runtime and
#      point PUZZLES_PATH at it, which is what docker-compose.yml does. The DB
#      is .dockerignore'd, so the build context stays small either way.
#   2. BAKE-IN: pass the DB directory as a NAMED BUILD CONTEXT (named contexts
#      are not subject to this repo's .dockerignore), plus the build arg:
#        docker build -t nodechess-web \
#          --build-arg WITH_PUZZLES=true \
#          --build-context puzzles-db=resources/data .
#      The baked file lands at /app/resources/data/puzzles.sqlite, which is the
#      image's default PUZZLES_PATH, so no runtime env is needed.
# Without either, the app still runs; puzzle features report "not installed"
# honestly in the UI.

ARG WITH_PUZZLES=false

# ---- build stage --------------------------------------------------------------
FROM node:26-alpine AS build
WORKDIR /app

# --ignore-scripts: skips electron's binary download (desktop-only). The one
# install script the web build DOES need (ffish CSP patch) runs explicitly.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
# Production P2P config baked into the SPA at build time (vite inlines
# import.meta.env.VITE_*). Unset => the app keeps its safe public-relay/STUN
# defaults (iceConfig.ts / relayConfig.ts both fall back cleanly), so a plain
# `docker build` still produces a working image.
#   VITE_ICE_SERVERS    JSON RTCIceServer[] (OUR coturn TURN + STUN)
#   VITE_NOSTR_RELAYS   comma list or JSON array of OUR wss:// signaling relays
ARG VITE_ICE_SERVERS=""
ARG VITE_NOSTR_RELAYS=""
ENV VITE_ICE_SERVERS=$VITE_ICE_SERVERS \
    VITE_NOSTR_RELAYS=$VITE_NOSTR_RELAYS
# build:server emits EVERYTHING dist-server needs at runtime (index.cjs +
# ipc-bridge.cjs). The npm script is the single source of truth, so dev/CI/
# Docker can never drift.
RUN node scripts/patch-ffish-csp.mjs \
  && npm run build:web \
  && npm run build:server

# ---- optional puzzle-DB layer ---------------------------------------------------
# `FROM puzzles-${WITH_PUZZLES}` picks one of these two stages; BuildKit prunes
# the other, so the `puzzles-db` named context is only required when
# WITH_PUZZLES=true.
FROM node:26-alpine AS puzzles-false
RUN mkdir /bundled

FROM node:26-alpine AS puzzles-true
COPY --from=puzzles-db puzzles.sqlite /bundled/puzzles.sqlite

FROM puzzles-${WITH_PUZZLES} AS puzzles-layer

# ---- runtime stage ------------------------------------------------------------
# dist-server/*.cjs are self-contained esbuild bundles: no node_modules.
FROM node:26-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    WEB_ROOT=/app/dist-web \
    GAMES_ART_ROOT=/app/resources/games-art \
    DATA_DIR=/data \
    PUZZLES_PATH=/app/resources/data/puzzles.sqlite

WORKDIR /app

COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/dist-server ./dist-server
# Static content the server serves / the IPC bridge reads. The bridge runs with
# process.resourcesPath = /app/resources (see docs/WEB-PORT-SPEC.md):
#   games-art    3D tabletop textures + piece art (served at /games-art)
#   curriculum   School chapters (school:* channels)
#   famous       famous games + persona game archives (famous:* channels)
#   personas     persona bots: styles, books, photos (personas:* channels)
#   openings     openings book (openings:lookup)
#   manuals      authored game manuals (inlined in the SPA today; kept for the
#                planned manuals-over-IPC serving, 144 KB)
COPY --from=build /app/resources/games-art ./resources/games-art
COPY --from=build /app/resources/curriculum ./resources/curriculum
COPY --from=build /app/resources/famous ./resources/famous
COPY --from=build /app/resources/personas ./resources/personas
COPY --from=build /app/resources/openings ./resources/openings
COPY --from=build /app/resources/manuals ./resources/manuals
# Empty dir by default; puzzles.sqlite when built with WITH_PUZZLES=true.
COPY --from=puzzles-layer /bundled/ ./resources/data/

# Accounts DB + per-user game DBs live here (DATA_DIR). Pre-create it owned by
# the unprivileged runtime user so both the anonymous-volume and bind-mount
# stories start writable.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

EXPOSE 8080
USER node

# node:26 ships global fetch. No curl/wget dependency for the probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/index.cjs"]
