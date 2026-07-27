# Getting nodechess online, click by click

> **This is the live deployment: the static SPA on Cloudflare Pages, puzzle chunks in R2.** For
> self-hosting the Docker image see `docs/WEB-DEPLOY.md`; for the relay and TURN stack see
> `deploy/DEPLOY.md`.

Everything here is a real link and a real button. Follow it top to bottom. Do not skip Part 0.

Total hands-on time is about 40 minutes, plus two waits you can walk away from: the domain going
live (up to a few hours) and the puzzle upload (about 1.4 GB).

**The puzzles are a separate deploy.** Parts 1 to 5 put the site up. The puzzle database goes
somewhere else entirely, in Part 6, and until you have done Part 6 the Puzzles screen has nothing to
read. If you are following this for the first time, do all six.

---

## Part 0. The one thing that will silently ruin this

Cloudflare Pages will offer to connect your GitHub repo and build for you. **Do not do that.**

The puzzle database is not in the repo. `dist-puzzles/` is 1.41 GB, ignored by git on purpose, and
lives only on your Mac. It is also not part of the site upload any more, because **Cloudflare Pages
cannot serve the puzzle files at all** (Part 6 explains, with the measurement). A Cloudflare-built
site would succeed, load, play chess, and have an empty Puzzles screen, and it would give you no
way to point the app at the puzzle data.

So we build on your Mac and upload the finished folder. That is what Parts 1 and 3 do, and the
puzzle data goes to its own bucket in Part 6.

---

## Part 1. Build the site (5 min)

Open Terminal and paste these one at a time.

**1.1** Go to the project:

    cd ~/chess/chess-sharp

**1.2** Make node available (it is not on the default PATH on this machine):

    export PATH=/opt/homebrew/bin:$PATH

**1.3** Build:

    npm run build:web

Wait for it to finish. It prints a list of files and ends without an error.

> Once you have done Part 6, this command changes: it needs to be told where the puzzles live.
> Step 6.8 sets that up once so you can keep typing `npm run build:web`.

**1.4** Check the size:

    du -sh dist-web

**It should be around 70 MB.** If it is over a gigabyte you are on an old checkout that still copies
the puzzle database into the site; the puzzle files belong in the bucket from Part 6, not here.

**1.5** Check the puzzle database exists on this Mac. Part 6 uploads it:

    ls dist-puzzles/puzzles.sqlite.* | wc -l

**It must print 60.** If it prints 0, run `npm run setup` to fetch and build the puzzle database.
That takes a while and can run while you do Parts 2 to 5.

---

## Part 2. Put the domain on Cloudflare (10 min, then a wait)

**2.1** Make a Cloudflare account, or sign in:

  https://dash.cloudflare.com/sign-up

**2.2** Click **Add a site** (or go straight to https://dash.cloudflare.com/?to=/:account/add-site ).

**2.3** Type your domain, exactly like `nodechess.com`, no `www`, no `https://`. Click **Continue**.

**2.4** Choose the **Free** plan. Click **Continue**.

**2.5** Cloudflare shows a list of DNS records it found.

> **Stop and look at this list.** If you use email on this domain, find the rows whose Type is
> **MX** and make sure they are all there. This is the only step in this whole guide that can break
> something you already have. If your email is elsewhere and no MX rows appear, take a screenshot of
> your current Namecheap DNS before continuing so you can put them back.

Click **Continue**.

**2.6** Cloudflare now shows **two nameservers**, like:

    dana.ns.cloudflare.com
    rick.ns.cloudflare.com

Yours will be different words. Leave this tab open. You need both.

**2.7** In a new tab, sign in to Namecheap:

  https://www.namecheap.com/myaccount/login/

**2.8** Go to your domain list:

  https://ap.www.namecheap.com/domains/list/

**2.9** Click the **MANAGE** button on the right of your domain.

**2.10** Scroll to the **NAMESERVERS** section. It is a dropdown currently reading
**Namecheap BasicDNS**.

**2.11** Change the dropdown to **Custom DNS**.

**2.12** Two empty boxes appear. Paste the first Cloudflare nameserver in the first box and the
second one in the second box. Do not add `http://` and do not add a trailing dot.

**2.13** Click the small **green tick** to the right to save. Namecheap does not have a Save button
here; the tick is the save.

**2.14** Go back to the Cloudflare tab and click **Continue** then **Check nameservers now**.

Now you wait. Usually 5 to 30 minutes, occasionally a few hours. Cloudflare emails you when the
domain is active. **You can do Part 3 while you wait.**

---

## Part 3. Upload the site (10 min, mostly waiting on the upload)

Back in Terminal, in the same folder.

**3.1** Log wrangler in to Cloudflare. This opens a browser window; click **Allow**:

    npx wrangler login

**3.2** Create the project. Say yes if it asks to install wrangler:

    npx wrangler pages project create nodechess --production-branch main

If it asks "Enter the production branch name", type `main` and press Enter.

**3.3** Upload:

    npx wrangler pages deploy dist-web --project-name nodechess --branch main

This uploads about 70 MB, so it takes a minute or two. Later deploys only send what changed.

> **Why `--branch main` is written out.** Work happens on the `web-port` branch, and the deploy
> commands in this guide are run from that checkout. With no `--branch` flag wrangler takes the
> branch name from the checkout, so the upload arrives tagged `web-port`, which is not the
> project's production branch (3.2 set that to `main`) and lands as a preview deployment: it gets
> its own URL, and your custom domain keeps serving the previous build. Naming the branch makes
> every deploy a production deploy regardless of what is checked out.
>
> The repo also has a `cloudflare-pages-main` branch. It carries no commits of its own (it is an
> ancestor of `web-port`) and nothing is built from it: it is a marker recording the commit last
> deployed to Pages. Moving it after a deploy is optional bookkeeping, not part of the deploy.

**3.4** When it finishes it prints a URL like `https://nodechess.pages.dev`. Open it. The landing
page should appear and you should be able to play a game against the engine.

Puzzles will not work yet. There is nothing wrong: the puzzle database has not been uploaded
anywhere. That is Part 6.

---

## Part 4. Point the domain at the site (2 min)

Only do this after Cloudflare has emailed to say the domain is active.

**4.1** Go to https://dash.cloudflare.com and click **Workers & Pages** in the left sidebar.

**4.2** Click the **nodechess** project.

**4.3** Click the **Custom domains** tab.

**4.4** Click **Set up a domain**.

**4.5** Type your domain (`nodechess.com`) and click **Continue**, then **Activate domain**.
Cloudflare writes the DNS record itself. There is nothing more to do at Namecheap.

**4.6** Repeat 4.4 and 4.5 with `www.nodechess.com` so both work.

Give it a minute, then open your domain. It should load the site with a padlock.

---

## Part 5. The check that fails silently (1 min)

Do this one. If it is wrong, the site looks completely fine and half the game bots quietly stop
working.

**5.1** Open your live site, then open the browser console:
Chrome on Mac is **Option + Command + J**.

**5.2** Type this and press Enter:

    crossOriginIsolated

**5.3** It must print `true`.

If it prints `false`: chess still works, so it is easy to miss, but the multithreaded engine drops
to the slower single-threaded one and Fairy-Stockfish stops entirely, which means every variant bot
(Crazyhouse, Atomic, Xiangqi, Shogi and the rest) goes dead. The fix is that `dist-web/_headers`
must have uploaded. Confirm with:

    curl -sI https://your-domain.com/ | grep -i cross-origin

You want two lines back: `cross-origin-opener-policy: same-origin` and
`cross-origin-embedder-policy: require-corp`.

---

## Part 6. The puzzles (20 min of typing, then a 1.4 GB upload you can walk away from)

### Why the puzzles are not on the site

The app does not download the puzzle database. It reads it the way a database is read: 4.7 million
puzzles live in 60 files of 24 MiB each, and opening one puzzle asks for a few 8 KiB windows out of
the middle of one file, using an HTTP `Range` request. A whole session of puzzles costs single-digit
megabytes.

**Cloudflare Pages does not do that.** Asked for 1,024 bytes of a chunk, it sends the entire
25,165,824-byte file, with a `200` instead of a `206`, while still advertising `accept-ranges:
bytes`. Measured on the live site on 26 July 2026: one 1 KB read took 15.6 seconds and pulled 24 MB,
a 24,576x overfetch. It is not compression and not a cold cache; it is that the Pages asset server
does not implement byte serving. The same request against the local dev server returns `206` and
1,024 bytes, which is why this looks fine while you are developing.

Bytes-wrong matters more than bytes-slow here: the reader takes the body it is given as the bytes it
asked for, so a whole-file `200` is read as if it were the middle of the file, and the database
comes back as nonsense. (The app's offline worker now cuts the right window out of a whole-file
response rather than trusting it, so a misconfigured origin is slow instead of wrong. It is a
safety net, not a fix.)

So the puzzle files go in **Cloudflare R2**, an object store on the same account that does serve
ranges, and charges nothing for egress. The site stays on Pages and is told where to look.

### 6.1 Log wrangler in

Same terminal, same folder as Part 3. If you did Part 3 in this session you are already logged in.

    cd ~/chess/chess-sharp
    export PATH=/opt/homebrew/bin:$PATH
    npx wrangler login

### 6.2 Create the bucket

    npx wrangler r2 bucket create nodechess-puzzles

If it says the name is taken, pick another and use it everywhere below.

> The first time you use R2 on an account, Cloudflare asks you to accept the R2 terms in the
> dashboard. If the command refuses, open https://dash.cloudflare.com , click **R2** in the left
> sidebar, accept, then run the command again.

### 6.3 Upload the 61 files

Paste this whole block. It uploads the 60 chunks and the manifest that describes them.

    for f in dist-puzzles/puzzles.sqlite.*; do
      npx wrangler r2 object put "nodechess-puzzles/$(basename "$f")" \
        --file="$f" --remote \
        --content-type=application/octet-stream \
        --cache-control="public, max-age=31536000, immutable"
    done
    npx wrangler r2 object put nodechess-puzzles/puzzles.manifest.json \
      --file=dist-puzzles/puzzles.manifest.json --remote \
      --content-type=application/json \
      --cache-control="public, max-age=0, must-revalidate"

> **`--remote` is not optional.** Without it wrangler writes to a simulated bucket in a folder on
> your Mac, prints exactly the same success messages, and uploads nothing. This is the same class of
> mistake as Part 0 and it costs you 1.4 GB of typing to find out.

It prints a line per file and takes a while: 1.4 GB over your upload link. Leave it running.

If it stops partway, run the same block again. Re-uploading a file that is already there just
replaces it, so there is no harm in repeating the whole thing.

### 6.4 Let the site read the bucket

A browser will not let a page read files from another hostname unless that hostname says it may.
Two separate permissions are involved and **both** matter: one to read at all, one to see the
headers that say which bytes came back.

Create the rules file. Paste this whole block, **including the last line, which must be the word
`JSON` with nothing in front of it**:

```
cat > /tmp/puzzles-cors.json <<'JSON'
{
  "rules": [
    {
      "allowed": {
        "origins": [
          "https://nodechess.com",
          "https://www.nodechess.com",
          "https://nodechess.pages.dev"
        ],
        "methods": ["GET", "HEAD"],
        "headers": ["range", "if-match", "if-none-match"]
      },
      "exposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"],
      "maxAgeSeconds": 86400
    }
  ]
}
JSON
```

Now open that file and fix the origins:

    open -e /tmp/puzzles-cors.json

The three `origins` lines must be the exact addresses your site is served from, with `https://` and
no trailing slash. **Every hostname people reach the site on has to be listed**, including the
`.pages.dev` one you test with. A missing hostname is not a partial failure: puzzles are dead on
that hostname and fine on the others. Save and close.

Then apply it:

    npx wrangler r2 bucket cors set nodechess-puzzles --file=/tmp/puzzles-cors.json

What the parts do, because getting one wrong fails in a way that is hard to read:

- `origins` is who may read. Wrong or missing means the browser blocks the read outright and the
  Puzzles screen reports that it cannot reach the database.
- `methods` needs `HEAD` as well as `GET`. The reader checks the file is there with a `HEAD` before
  it reads anything.
- `headers` lists `range` so the request that carries it is allowed.
- `exposeHeaders` is the one that is easy to miss. Without `Content-Range` in that list the bytes
  arrive but the page is not allowed to see which bytes they were, so nothing can be cached and the
  console warns that the server does not support byte serving. Puzzles work and are slow forever.

Check it took:

    npx wrangler r2 bucket cors list nodechess-puzzles

### 6.5 Give the bucket a hostname

R2 buckets are private and have no address until you give them one. Use a subdomain of your own
domain, which is both faster (it is cached at Cloudflare's edge) and unlimited.

**6.5.1** Get your Zone ID: go to https://dash.cloudflare.com , click your domain, and on the
**Overview** page look in the right-hand column under **API**. **Zone ID** is a 32-character
hex string. Click to copy it.

**6.5.2** Attach the subdomain, pasting your Zone ID at the end:

    npx wrangler r2 bucket domain add nodechess-puzzles \
      --domain puzzles.nodechess.com --zone-id PASTE_ZONE_ID_HERE

Cloudflare writes the DNS record and issues the certificate itself. Give it a minute or two.

> **No domain yet?** There is a stopgap: `npx wrangler r2 bucket dev-url enable nodechess-puzzles`
> prints a `https://pub-....r2.dev` address that works the same way. Cloudflare rate limits it and
> tells you not to use it for production traffic, so treat it as a way to finish the setup today and
> come back to 6.5.2 when the domain is live.

### 6.6 The check that decides whether any of this worked

This is the one that matters. Substitute your own hostname.

    curl -s -o /dev/null -D - -H "Range: bytes=0-1023" \
      https://puzzles.nodechess.com/puzzles.sqlite.000 \
      -w "\nSTATUS %{http_code}  BYTES %{size_download}\n"

**You want, in the output:**

    HTTP/2 206
    content-range: bytes 0-1023/25165824
    STATUS 206  BYTES 1024

`206` and `1024`. That is a server doing byte serving, and it is the whole point of Part 6.

If you get `STATUS 200 BYTES 25165824`, run the command a second time; the first request to a file
can be the edge pulling it into its cache. If it is still `200`, stop here and say so. Do not
rebuild the site: it would work but every puzzle would cost 24 MB, which is the problem you are
fixing.

Now check the permissions from 6.4 came through:

    curl -s -o /dev/null -D - -H "Origin: https://nodechess.com" -H "Range: bytes=0-15" \
      https://puzzles.nodechess.com/puzzles.sqlite.000 | grep -i "access-control"

You want two lines: `access-control-allow-origin: https://nodechess.com` (your hostname, echoed
back) and `access-control-expose-headers:` with `Content-Range` in it. If the first is missing, the
origin is not in your `origins` list. If the second is missing, `exposeHeaders` did not apply.

And check the manifest is really there, since it is the file everything else hangs off:

    curl -s https://puzzles.nodechess.com/puzzles.manifest.json | head -c 80

You want JSON starting `{"format":1,`.

### 6.7 Confirm all 60 chunks made it

    curl -sI https://puzzles.nodechess.com/puzzles.sqlite.059 -o /dev/null -w "%{http_code}\n"

**It must print 200.** `059` is the last chunk, so it is the one a half-finished upload loses. If it
prints 404, run the upload block in 6.3 again.

(That is a `HEAD` request, which is also the one the app makes before it reads anything, so a `200`
here means both the file and the `HEAD` method are working.)

### 6.8 Tell the site where the puzzles are

The app has to be built knowing this address. Write it down once, in a file at the top of the
project, so no future build can forget it:

    cd ~/chess/chess-sharp
    echo 'VITE_PUZZLE_BASE_URL=https://puzzles.nodechess.com/' > .env.production

Use your own hostname, keep the trailing slash. This file holds no secret and is a normal part of
the project.

Then rebuild and redeploy:

    export PATH=/opt/homebrew/bin:$PATH
    npm run build:web
    npx wrangler pages deploy dist-web --project-name nodechess --branch main

Check the address really got baked in:

    grep -c "puzzles.nodechess.com" dist-web/sw.js

**It must print 1 or more.** If it prints 0, the build did not see `.env.production`: confirm the
file is at `~/chess/chess-sharp/.env.production` and rebuild.

### 6.9 Open Puzzles

Open your site and click **Puzzles**. A puzzle should appear within a second or two.

To see it working properly: open DevTools (**Option + Command + I**), click the **Network** tab,
then load another puzzle. You should see requests to `puzzles.nodechess.com` with status **206** and
sizes in **kilobytes**. Statuses of `200` with sizes in megabytes mean 6.6 was not really passing.

### If it does not work

- **"could not reach the puzzle database"**, and the console says something about CORS or
  `Access-Control-Allow-Origin`: the hostname you are viewing the site on is not in the `origins`
  list from 6.4. Add it and re-run the `cors set` command.
- **The console mentions `Cross-Origin-Resource-Policy` or "blocked by ERR_BLOCKED_BY_RESPONSE"**:
  this site runs cross-origin isolated (Part 5), and one more permission is wanted on the bucket's
  responses. In the dashboard: your domain, then **Rules**, then **Overview**, then create a rule
  that modifies **response headers**, matching hostname `puzzles.nodechess.com`, setting a static
  header `Cross-Origin-Resource-Policy` to `cross-origin`. Deploy the rule and reload the site.
- **A console warning that the server did not respond with `Accept-Ranges: bytes`**: `exposeHeaders`
  in 6.4 is missing `Accept-Ranges`.
- **Puzzles work but each one takes many seconds**: the origin is answering `200` to range requests.
  Go back to 6.6.

---

## Doing it again later

After any code change, from the working branch (`web-port`):

    cd ~/chess/chess-sharp
    export PATH=/opt/homebrew/bin:$PATH
    npm run build:web
    npx wrangler pages deploy dist-web --project-name nodechess --branch main

That is the whole loop. Parts 2, 4, 5 and 6 are one-time, and `.env.production` from 6.8 is what
keeps the puzzle address attached to every build without you thinking about it. Keep `--branch main`
on the deploy: without it the upload is tagged with whatever branch is checked out and lands as a
preview, leaving the custom domain on the previous build (3.3).

**After a change to the puzzle database only** (you re-ran `npm run build:puzzles` or
`build-puzzle-chunks`), the chunks have changed and the bucket has the old ones. Upload again with
the block in 6.3, then rebuild and redeploy the site so it picks up the new manifest. The app keys
its cached puzzle data to the artifact's build id, so nobody has to clear anything.

---

## Desktop releases

Different flow, different doc: `docs/RELEASE.md`.
