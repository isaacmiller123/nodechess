# nodechess: Going Live (web + infrastructure)

> **This is the relay and TURN stack** (Caddy + a Nostr relay + coturn), plus the web container in
> front of it. For the live web deployment (static SPA on Cloudflare Pages, puzzle chunks in R2)
> see [../docs/DEPLOY-WEB.md](../docs/DEPLOY-WEB.md); for self-hosting the Docker image on its own
> see [../docs/WEB-DEPLOY.md](../docs/WEB-DEPLOY.md).

This is the runbook to put nodechess on the public internet so anyone in the world
can make an account and play. Desktop app releases (mac/win installers) are a
separate flow, covered in [docs/RELEASE.md](../docs/RELEASE.md).

Because nodechess is **decentralized peer-to-peer** (gameplay rides WebRTC data
channels; there is no central game server or game database), "hosting for a
million players" is just three cheap, horizontal pieces:

| Piece | What it does | Load model |
|-------|--------------|-----------|
| **web** (`app.DOMAIN`)   | serves the static SPA (+ COOP/COEP headers) | static, CDN-frontable, tiny |
| **relay** (`relay.DOMAIN`) | Nostr signaling rendezvous (peers find each other) | small ephemeral events; add replicas to scale |
| **turn** (`turn.DOMAIN`) | coturn: relays media for pairs behind strict NAT | only ~10–20% of pairs; bandwidth-bound |

Everything else (the actual games, ratings, witnessing, storage) happens
**between players' browsers/apps**, not on your servers.

---

## What you must provide (the only non-automatable bits)

1. **A server**: any Linux VPS with a public IPv4 (a $5–20/mo box is plenty to
   start; scale later). Docker + Docker Compose installed.
2. **A domain** you control DNS for (e.g. `example.com`).
3. **DNS records**: three `A` records → your server's public IP:
   ```
   app.example.com     A   <server-ip>
   relay.example.com   A   <server-ip>
   turn.example.com    A   <server-ip>
   ```
   (Optionally `example.com` + `www` too: they redirect to `app.`.)
4. **Firewall / security-group** open on the server:
   ```
   80/tcp, 443/tcp         (web + relay, via Caddy: also needed for TLS certs)
   3478/tcp, 3478/udp      (TURN)
   49160-65535/udp         (TURN relay port range)
   ```

That's it. No cloud console clicking beyond DNS + a firewall.

---

## Deploy (one time, ~5 minutes)

```bash
# on the server, in a clone of this repo:
cd deploy
cp .env.production.example .env.production
$EDITOR .env.production      # set DOMAIN, ACME_EMAIL, EXTERNAL_IP, TURN_PASSWORD,
                             # and update VITE_ICE_SERVERS + VITE_NOSTR_RELAYS to
                             # match (replace example.com + the password)

docker compose --env-file .env.production -f docker-compose.prod.yml up --build -d
```

Caddy auto-issues Let's Encrypt certs for all three hostnames on first boot
(give DNS a minute to propagate first). Then open **https://app.example.com**,
make an account, and you're live.

Check it:
```bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps
curl -sf https://app.example.com/healthz && echo OK
# TURN reachable?  (from anywhere)
#   npx -y stun  turn.example.com:3478    # or any STUN/TURN checker
```

### Verifying real strangers can play
- Two people on **different networks** open `https://app.example.com`, sign up,
  and start a rated game (needs a 3rd person online anywhere to witness; see
  below). Casual games need just the two.
- If a pair can't connect, it's almost always NAT/TURN: confirm the UDP range is
  open and `EXTERNAL_IP` is correct. Enable `turns://:5349` (below) for players
  behind port-443-only corporate firewalls.

---

## The two build-time values (important)

`VITE_ICE_SERVERS` and `VITE_NOSTR_RELAYS` are **baked into the web app at build
time** (Vite inlines them). The compose passes them as build args, so they must
be set **before `up --build`** and must point at the coturn + relay you're
deploying. If you change them, rebuild: `up --build -d` again.

- Leaving them unset still produces a working app that uses public defaults
  (fine for a quick demo, rate-limited under load, not for a million).
- The **desktop apps** read the same `VITE_*` values at *their* build time. Set
  them in CI before packaging (see `docs/RELEASE.md`) so installed apps use your
  relays too.

---

## Scaling notes (a million concurrent)

- **Web**: it's static. Put Cloudflare (or any CDN) in front of `app.DOMAIN` and
  origin load is near zero. One small container already handles a lot.
- **Relay**: the real signaling load. nostr-rs-relay is efficient, but as you
  grow, run **several relay hostnames** (`relay1`, `relay2`, …) and list them all
  in `VITE_NOSTR_RELAYS`. Trystero spreads peers across them and tolerates any
  being down (proven: our acceptance test survives individual relay failures).
  This is also the anti-rate-limit answer vs. public relays.
- **TURN**: only strict/symmetric-NAT pairs relay here, but those carry *full
  media bandwidth*. Watch coturn's bandwidth; add coturn nodes and list them all
  in `VITE_ICE_SERVERS`. Budget generous egress. Most pairs connect directly and
  never touch it.
- **Witnesses**: rated play needs ≥3 people online (2 players + any 1 witness).
  In a large population this is automatic. For the early/empty phase, run an
  always-on "operator" peer as a reliable witness (roadmap: post-A-final
  self-sufficiency). Casual play works with just 2 regardless.

---

## Hardening (do these once it matters)

- **`turns://` on 5349** (corporate-firewall players): get a cert for
  `turn.DOMAIN` and uncomment the TLS block in `turnserver.conf`, mount the cert
  into the coturn container at `/certs`, redeploy. The app already advertises
  `turns:5349`, so no rebuild is needed.
- **Rotate `TURN_PASSWORD`**: change it in `.env.production`, rebuild web (it's
  baked into `VITE_ICE_SERVERS`), restart coturn. For zero-downtime rotation use
  coturn's `use-auth-secret` (time-limited REST creds) instead of the static
  user. That is a later upgrade.
- **Back up** `web-data` volume if you rely on the interim server-account
  fallback; with decentralized accounts (default) it's essentially stateless.
- Keep images patched: `docker compose ... pull && ... up -d`.
