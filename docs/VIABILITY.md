# VIABILITY — Competing with chess.com/lichess by making paid features free

_Decision document. Synthesized 2026-07-10 from market, infra, web-port, and legal research. Every hard number is cited; estimates show their arithmetic and are marked **(est.)**._

---

## 1. Verdict

**The "undercut chess.com by making its paid features free, monetize with ads later" plan, taken literally, does not work as a business. A narrower version of it works as a modest one.**

Why the literal plan fails:

- **The free niche is already occupied — by lichess, not you.** Lichess already gives away most of what chess.com charges for (unlimited analysis, unlimited puzzles, studies, no ads) and does it as a trusted charity with 15 years of history, ~60.7M visits/month ([Semrush, Dec 2025](https://www.semrush.com/website/lichess.org/overview/)) and ~5M games/day ([lichess End of Year Update 2025](https://lichess.org/@/Lichess/blog/lichess-end-of-year-update-2025/YRiNKoaQ)). "Free chess.com features" is a pitch against lichess, and you cannot out-free a donation-funded charity whose all-in 2025 cost was **$789,389** ([Lichess Director of Operations, expense breakdown](https://www.youtube.com/watch?v=oEbW1Lv1vus); [rookreview.com](https://rookreview.com/news/lichess-2025-expensess-report)).
- **Chess ad money is cents per user, not dollars.** Chess.com itself — the best-monetized chess property on earth — makes ~$150M/yr of which **~88% is subscriptions and only ~10% ads** ([Yahoo Finance, Apr 2026](https://finance.yahoo.com/markets/stocks/articles/chess-com-surpassed-250-million-200425425.html); [Sherwood](https://sherwood.news/culture/how-the-chess-com-empire-makes-more-than-usd100m-a-year/)). $15M/yr of ads across an active base in the tens of millions is roughly **$0.30/active user/year (est.: $15M ÷ ~50M MAU proxy)**. An ads-funded clone of their paid features earns two orders of magnitude less per user than the subscriptions it is trying to kill.
- **Serving free chess is cheap; the model still can't fund a company.** Lichess proves the cost side: $789k/yr at ~4M actives ≈ **$0.20/user/yr all-in** — but that includes volunteer labor, donated moderation (100+ mods, 12 paid — [lichess blog](https://lichess.org/@/Lichess/blog/lichess-end-of-year-update-2025/YRiNKoaQ)), and a donation flywheel you don't have.

What **does** work:

- **A differentiated free platform, not a free clone.** nodechess already has things neither incumbent offers in one place: 20+ games (xiangqi, shogi, go, checkers, custom-variant editor), an offline-first desktop app, a 40-chapter school, and serverless P2P. That is a product wedge; "chess.com but free" is not.
- **Consumer-free / institution-paid.** Keep every chess.com paid feature free for individuals; charge schools/clubs for the School (cohort management, progress dashboards). This is the only monetization line in this analysis that can plausibly exceed $1/user/yr without ads.
- **Ads as a floor, not the plan.** Contextual web display at gaming rates ($1–3 CPM — [Techconda AdSense benchmarks 2025](https://www.techconda.com/2026/02/adsense-rpm-benchmarks.html)) plus lichess-style patron donations ($0.20/user/yr proven) covers infrastructure from ~10k MAU but never funds a team by itself.

**What kills it outright:** (a) failing the liquidity cold start (no opponents → no retention → no scale — see §5); (b) treating ads as the endgame (see table — at chess.com's own realized ad ARPU you need ~400k MAU just to pay one founder); (c) shipping the current persona/COPPA exposure onto a public web service (see §4); (d) chess.com moving one feature — e.g., making Game Review free — which they can do at any time and which erases the headline pitch overnight.

---

## 2. Economics table

**Market context (all cited):** chess.com: 268.6M members as of 2026-07-04 ([coopboardgames statistics](https://coopboardgames.com/statistics/chess/)), 8.7M DAU in Q4 2025 ([chess.com quarterly report](https://www.chess.com/board-reports/2025-q4)), 20M games/day at the 200M-member mark ([TechCrunch, 2025-04-24](https://techcrunch.com/2025/04/24/chess-com-reaches-200-million-members/)), ~2M paying subscribers, revenue ~$150M heading to a projected $300M ([Yahoo Finance, Apr 2026](https://finance.yahoo.com/markets/stocks/articles/chess-com-surpassed-250-million-200425425.html)). Prices being undercut: Gold ≈ $4.17/mo, Platinum ≈ $6.67/mo, Diamond ≈ $12.50/mo billed annually ([chess.com/membership](https://www.chess.com/membership); [pricing guide, 2026](https://www.jaideepass.com/guides/chess-com-premium-discount-2026)).

**Cost anchor:** lichess 2025 all-in expenses $789,389 (~$0.20/active/yr at ~4M actives (est.)). Its hosting fleet is ~30 bare-metal Hetzner/OVH boxes; the first 19 rows of its published server sheet ([lichess.org/costs](https://lichess.org/costs), fetched 2026-07-10) sum to **$50.6k/yr**, so full hosting ≈ **$75–90k/yr (est.)** — i.e., hosting is ~10% of costs; people (dev, mods, content, ops) are the rest. Comparable hardware today: Hetzner AX42 dedicated €97.30/mo, auction AX41 from ~€57/mo (hetzner.com price list, snapshot 2026-07-10).

**Ad ARPU bounds used below:**
- Low bound = chess.com's realized ads: ~$0.30/MAU/yr (est.: $15M ads ÷ ~50M MAU proxy from 8.7M DAU × ~5.7 DAU→MAU multiplier).
- High bound = aggressive web display: 100 pageviews/user/mo (est.: ~20 sessions × 5 pages; lichess sessions average 19m31s — [Semrush](https://www.semrush.com/website/lichess.org/overview/)) × $2–3 RPM = **$2.40–3.60/user/yr (est.)**. Gaming/entertainment RPM sources: $1–3 CPM AdSense ([Techconda](https://www.techconda.com/2026/02/adsense-rpm-benchmarks.html)); premium networks $15–40 RPM exist but skew US/finance, not international chess traffic ([eastondev comparison](https://eastondev.com/blog/en/posts/media/20260110-adsense-alternatives-comparison/)); entertainment can be as low as $0.50–2 CPM ([hasan, Medium 2025](https://hasan2026.medium.com/how-to-calculate-ad-revenue-per-1000-visitors-by-niche-2025-guide-cd4e052b622f)).
- Donations (proven): $0.20/user/yr (lichess covers costs; record month Dec 2025 >$80k — [lichess blog](https://lichess.org/@/Lichess/blog/lichess-end-of-year-update-2025/YRiNKoaQ)).

| MAU | Infra cost/yr (est.) | Ads low ($0.30/u/yr) | Ads high ($3.60/u/yr) | + Donations ($0.20/u/yr) | + School B2B (est.) | Net at blended mid |
|---|---|---|---|---|---|---|
| **1k** | $1.2k — one auction box + TURN + domain (€57–100/mo) | $300 | $3.6k | $200 | ~0 | **−$1k to +$2k** (hobby) |
| **10k** | $3k — 2 boxes + TURN bandwidth | $3k | $36k | $2k | $2–5k (a few clubs) | **+$5k–40k** (infra covered) |
| **100k** | $20–45k — 4–6 boxes + paid moderation stipends (lichess ratio: $0.20/u/yr × 100k = $20k) | $30k | $360k | $20k | $20–60k (est.: 100 institutions × $200–600/yr) | **+$50k–400k** (first salary possible) |
| **1M** | ~$200k — lichess-at-¼-scale incl. part-time staff (est.: $0.20/u/yr) | $300k | $3.6M | $200k | $150–500k (est.) | **+$0.5M–4M** (real business, high end requires tier-1 web traffic + high ad density you said you don't want) |

**Break-even points:**
- Infra-only break-even: **~5–10k MAU** (est.: $3k costs vs $3k+ low-bound ads + donations).
- One-founder break-even ($120k salary (est.) + infra): **~40k MAU** at the aggressive-ads bound, **~400k MAU** at chess.com's realized ad ARPU. Honest planning number: **~150k MAU at a blended ~$1/user/yr** (contextual ads + patron donations + early School B2B).
- Chess.com-scale revenue is unreachable on this mix: to match their $130M subscription line at $1/user/yr you'd need 130M MAU — more actives than chess.com has.

**Monetization mix that gets to break-even:** contextual (COPPA-safe) display ads on web surfaces only; lichess-style patron tier (cosmetics/badge, no gameplay features — keeps the "everything free" promise intact); School site licenses to clubs/schools/coaches (the one real revenue line — lichess's classroom demand signal: 10,000+ teachers, ~300k students in 2024, per its blog); keep desktop app donation-linked. Do **not** plan on affiliate/coaching-marketplace revenue until >100k MAU.

---

## 3. Web-port plan

The renderer is already web-stack (Vite + TS + chessground); the hard parts are engines, the 4.7M-puzzle DB, and multiplayer authority.

**Phase 0 — engine strategy (2–3 wks, est.).** Desktop uses native Stockfish 18 spawned from Electron main (see docs/architecture.md §6). Web must switch to **stockfish.wasm**: multithreaded build requires COOP/COEP headers + SharedArrayBuffer ([lichess-org/stockfish.wasm](https://github.com/lichess-org/stockfish.wasm)) — fine on your own domain since you control headers; expect meaningfully slower NNUE than native (research doc: native "full NNUE + true multithreading" is the fast path). Maia ports cleanly: CSSLab's own web frontend runs **both Stockfish (WASM) and Maia (ONNX via onnxruntime-web) fully client-side** ([maia-platform-frontend](https://github.com/csslab/maia-platform-frontend); [play-lc0 with WebGPU + WASM fallback](https://github.com/hunterchen7/play-lc0)). **KataGo has no browser build at meaningful strength — Go bots are server-side or absent in web v1.** Fairy-Stockfish has a WASM build (fairy-stockfish.wasm) for variants.

**Phase 1 — static free-tools site (4–8 wks, est.).** Analysis board + game review + puzzles + openings, no accounts. Puzzle DB: don't ship 4.7M rows; serve the CC0 lichess-derived sqlite via HTTP range reads (sql.js-httpvfs pattern) or a thin API; cache a few thousand puzzles in IndexedDB for offline PWA. This phase is pure marketing surface for the desktop app and the SEO beachhead. Zero legal-new-surface if §4 items are fixed first.

**Phase 2 — identity + P2P play in browser (4–6 wks, est.).** trystero/WebRTC is browser-native already; add your own coturn TURN relay (one €5–20 VPS; relayed-game bandwidth ~50–150 GB/mo per 1k games (est.) — recall the Shadowrocket fake-IP/UDP-STUN failure mode on your own Mac proves TURN fallback is mandatory, not optional). Friend links, clubs, school cohorts.

**Phase 3 — authoritative server (8–12 wks, est.).** The moment public ratings matter, P2P self-reported results are spoofable: you need a server that owns matchmaking, clocks, ratings (your glicko2 code moves server-side), and basic anti-cheat (engine-correlation batch jobs — this is where fishnet-style analysis costs appear; lichess dedicates multiple servers to it per its cost sheet). This is also where moderation labor starts (lichess pays 12 moderators). Do not build Phase 3 before Gate 2 (§6) passes.

**Risks:** iOS Safari memory/SAB restrictions on multithreaded WASM; engine-strength parity complaints vs desktop; puzzle-DB egress costs if not range-served; anti-cheat is an arms race you currently have zero staffing for; every line is GPL-3 so a better-funded actor can legally fork your web product the day it's good (mitigation: the community and the datasets pipeline are the moat, not code).

---

## 4. Legal must-fix list (ranked)

1. **Personas / right of publicity — fix before any public web launch.** Any bot, coach, or marketing that uses a real player's name, likeness, or identifiable style ("play against Magnus", GM-named bots) invites right-of-publicity claims; courts have sided with athletes against games using their likeness even without names (Keller v. EA line of cases — [Berkeley Tech LJ](https://btlj.org/2014/12/the-right-of-publicity-likeness-lawsuits-against-video-game-companies/); [Crowell on the EA sports cases](https://www.crowell.com/en/insights/client-alerts/sports-stars-take-on-video-game-makers-right-of-publicity-or-first-amendment-the-supreme-court-may-decide)). Chess.com's celebrity bots (Hikaru, Botez, etc.) are partnership-licensed. Action: audit every bot/persona name and avatar; fictional personas (Viktor) are fine; "Maia 1100–1900" is fine (research artifact names); delete or license anything mapping to a real person. Also drop "chess.com-grade" from any public copy — truthful comparative advertising is legal under the Lanham Act but naming their mark in your marketing is a cheap C&D magnet.
2. **COPPA — structural, because the School targets children.** On a web service with accounts + ads: no behavioral/targeted ads where under-13s are users; contextual ads are permitted under the internal-operations carveout ([FTC COPPA FAQ](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions); [FTC final rule, Jan 2025](https://www.ftc.gov/news-events/news/press-releases/2025/01/ftc-finalizes-changes-childrens-privacy-rule-limiting-companies-ability-monetize-kids-data)). Penalties: up to $53,088/violation/day; YouTube paid $170M ([case study](https://medium.com/golden-data/case-study-youtube-170m-coppa-fine-673f5d3086b)). Action: age gate at signup, contextual-only ad stack site-wide (simplest), zero ads on School surfaces, minimal data collection, parental-consent flow only if you ever need more.
3. **GPL/AGPL hygiene on the web service.** App is GPL-3-or-later — fine. But bundled lila sounds are **AGPL-3** (see THIRD-PARTY-NOTICES.md): serving them from a network service triggers AGPL's network-source clause; you're open-source anyway, so compliance = publish the web service's source and per-component notices on the site, including the Stockfish 18 corresponding-source pointer (tag `sf_18`) on the web build. Cost: a page. Risk if skipped: takedown ammunition for anyone who wants you gone.
4. **Trademark distance.** "nodechess" is defensible; register it, and never style anything to imply affiliation with Chess.com Inc. or lichess.org. It is plain ASCII, so unlike the old name it needs no store-safe alias — but check the term is clear in the classes you file under.
5. **Data provenance.** Lichess puzzles/openings are CC0 — clean (THIRD-PARTY-NOTICES.md). Never scrape chess.com content or import their game archives server-side (ToS); user-initiated import of the user's own games is standard practice and fine.
6. **Later, not now:** prize events (gambling/sweepstakes rules per state), GDPR rep if EU traffic grows, DSA transparency duties at scale (chess.com already files — [their DSA page](https://www.chess.com/article/view/digital-services-act-compliance)).

---

## 5. Cold-start strategy (the liquidity answer)

The failure mode: a new server with a 500-player pool has minute-long waits and mismatched ratings; players leave; pool shrinks. Concretely: sub-30s matching at one time control needs on the order of **~100 concurrent seekers per pool (est.: with 5-min games and 100 concurrent, arrivals ≈ 0.3–1/s → median pairing wait < 30s)**; three standard pools (bullet/blitz/rapid) ⇒ **~300 concurrent ≈ 15–30k MAU (est., at 1–2% concurrency ratios)** before open matchmaking feels alive. Lichess's pools for reference: 749,154 weekly blitz players, 441,345 rapid (lichess player leaderboards via [webgamedb](https://webgamedb.com/games/lichess.org), 2026).

So do not open with a lobby. Sequence:

1. **Friend-graph first (already built).** P2P invite links need exactly 2 players; zero liquidity required. Every desktop user is a seeder. Ship "challenge a friend on the web" as the first multiplayer surface.
2. **Bots as the always-on opponent.** Maia 1100–1900 in-browser (client-side ONNX, zero server cost) means "play a human-like game instantly" never fails. This is your empty-room insurance; lichess/chess.com both gate their best bot experiences.
3. **Cohorts, not crowds: School classrooms.** A classroom is a self-contained liquidity pool of 20–30 known players. Lichess's 10,000 teachers / ~300k students (2024, lichess blog) proves educators adopt free tools; your School + club licensing (§2) doubles as the seeding mechanism — every sold classroom is a live pool.
4. **Niches where YOU are the liquid market.** Don't fight for blitz players (lichess owns them). Seed pools where incumbents have nothing: **custom variants (your editor is unique — nobody else lets users publish playable variants), chess variants beyond lichess's 8, and the multi-game crowd (xiangqi/shogi/go/checkers in one client)**. Caveat honestly: dedicated incumbents exist per game (lishogi, OGS for go), so the pitch is "all games, one account, one rating identity, offline too" — not beating OGS at go.
5. **Async everything.** Correspondence/daily games tolerate zero concurrency. Cheap retention while pools grow.
6. **Only then open matchmaking**, one time control at a time, at fixed "arena hours" (concentrating players in time windows manufactures concurrency — the lichess tournament trick).

---

## 6. Decision tree — go/no-go gates

**Gate 0 — Legal scrub (now, ~2 wks, blocks everything).** Persona audit clean, COPPA ad plan written, license/notice page live. Trigger: checklist 100% done. No-go action: none — this gate is mandatory work, not a bet.

**Gate 1 — Web tools traction (≈ month 3–4).** Ship Phase 1 (analysis + puzzles + review, no accounts). GO if, within 90 days of launch with $0 paid acquisition: **≥5k MAU and ≥20% week-4 return rate**. NO-GO: nodechess stays a desktop product with a marketing site; you lose ~2 months, not a year.

**Gate 2 — Liquidity proof (≈ month 6–9).** Friend games + classrooms + one arena-hours pool. GO if: **≥300 peak concurrent, median match wait <30s in the seeded pool, and ≥30% of web games are human-vs-human** (i.e., bots are insurance, not the product). NO-GO: keep friends+bots+School (still a good product), skip the ratings server, skip ads infrastructure.

**Gate 3 — Monetization clears salary path (≈ month 12–15).** Ads (contextual) + patron + School B2B live. GO FULL-TIME if: **blended ARPU ≥ $1/user/yr AND MAU ≥ 100k AND trailing-quarter revenue run-rate ≥ $150k/yr** (founder + infra — est. threshold). NO-GO: run it as a self-sustaining side project (infra covered from ~10k MAU per §2) — that is a fine steady state, and the honest most-likely outcome.

**Standing kill condition (any time):** chess.com makes Game Review / lessons free-tier-unlimited, or lichess ships a multi-game platform — re-run §1; the differentiation-only strategy survives that, the undercut strategy does not.

---

## 7. What lichess and chess.com will do about you

Honestly: **for a long time, nothing — and that's the problem as much as the comfort.** Below ~1M MAU you are invisible to chess.com; their pattern when something does matter is acquisition or feature absorption — they bought Play Magnus Group (chess24, Chessable, Aimchess) for **$82.9M** in 2022 ([SportBusiness](https://www.sportbusiness.com/news/chess-com-to-acquire-play-magnus-group-in-82m-deal/); [Front Office Sports](https://frontofficesports.com/top-chess-player-platform-join-forces-in-82-9m-deal/)) and shut down/merged the overlap. If your free-game-review pitch ever bites, their cheapest counter is loosening free-tier limits for a quarter — they have ~$150M revenue and 2M subscribers of margin to spend, and they're actively building the ads business you'd be relying on ([Yahoo, Apr 2026](https://finance.yahoo.com/markets/stocks/articles/chess-com-surpassed-250-million-200425425.html)). They will not sue a GPL desktop app; they will out-market it. Lichess won't fight you at all — it will simply continue to exist, free, trusted, ad-free, at $0.20/user/yr costs, absorbing every user whose only reason to switch is price. Your GPL-3 code is also forkable by anyone, including motivated community members who dislike your ads. Conclusion: nothing in the competitive landscape punishes you for building the differentiated multi-game/School/offline product; everything punishes a pure price war.

---

_Primary sources index (accessed 2026-07-10): chess.com Q4 2025 board report; TechCrunch 2025-04-24; Yahoo Finance Apr 2026; Sherwood News; coopboardgames.com/statistics/chess; chess.com/membership; jaideepass.com 2026 pricing guide; lichess End-of-Year 2025 blog; lichess.org/costs sheet (local snapshot docs/…/lichess_costs.xlsx); Theo Wait expense video; Semrush lichess.org Dec 2025; webgamedb lichess player counts; Hetzner dedicated price list snapshot; Techconda AdSense benchmarks; eastondev ad-network comparison; FTC COPPA FAQ + Jan 2025 final rule; YouTube COPPA case study; Berkeley Tech LJ & Crowell right-of-publicity analyses; CSSLab maia-platform-frontend; hunterchen7/play-lc0; lichess-org/stockfish.wasm; SportBusiness / Front Office Sports on Play Magnus._
