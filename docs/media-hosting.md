# Media storage and public delivery

Uploads live in `MEDIA_DIR` (`./data/media` with Docker). Files get random names (`YYYY/MM/<uuid>.<ext>`), are validated by
content, and the dashboard shows them only to the signed-in owner through `/api/media/:id/file`. The folder is never
exposed over HTTP.

## Who needs a public address?

| Platform | Needs the file at a public HTTPS URL? |
|---|---|
| Bluesky, Mastodon, Facebook Pages, LinkedIn | **No** — SocialDeck uploads the bytes itself |
| Threads | Only for posts with images/video (text-only posts need nothing) |
| Instagram | **Yes**, always (every post has media) |

If you only use the first group you can ignore this page.

## The media gateway (what gets exposed — and nothing else)

Instagram and Threads fetch your media from the internet, so *something* must be reachable. SocialDeck does not expose the
dashboard or the API for that. It ships a separate tiny service, the **media gateway** (`apps/media-gateway`, port 4100):

* serves only `GET/HEAD /m/<signed-token>` and `GET /healthz` — every other path, including `/`, `/api/...` and any file
  path, is a 404 (tested);
* a token names **exactly one file** and expires (30 minutes by default). It is an HMAC-signed claim; guessing, editing or
  reusing a different file's token fails, and expired, tampered and unknown tokens all give the same 404;
* has **no database, no sessions, no API**, a **read-only** view of the media folder, and holds only the link-signing key
  (`MEDIA_SIGNING_KEY`) — not your encryption key, tokens or passwords;
* in Docker it runs read-only, with all Linux capabilities dropped, on a separate network from MongoDB and Redis;
* links are minted only at the moment a post is being published, for the files in that post.

You then point a tunnel at the gateway (port 4100), never at the dashboard (8080/5173) or the API (4000).

## Free options (investigated)

| Option | Cost | Stable address? | Notes |
|---|---|---|---|
| **Cloudflare quick tunnel** (`cloudflared tunnel --url …`) | free, **no account, no domain** | no — a new `*.trycloudflare.com` address on every start | Cloudflare describes quick tunnels as for testing/development: no uptime guarantee, 200 concurrent requests, no SSE. Fine for occasional posts. |
| Cloudflare named tunnel | free tunnel, but needs a **domain you own** on Cloudflare (domains cost money) | yes | Best if you already own a domain. Free account required. |
| Tailscale Funnel | free on the Personal plan | yes (`<machine>.<tailnet>.ts.net`) | Needs a Tailscale account, HTTPS + MagicDNS enabled, ports 443/8443/10000; fixed, unpublished bandwidth limits. Make it forward **only** the gateway port. |
| Your own VPS / reverse proxy | VPS costs money | yes | Not free; not recommended here. |
| Post manually | free | — | Instagram/Threads media posts can always be done by hand: the composer's *Post manually* copies the caption. |

Important: a tunnel makes **whatever it points at** public. The gateway is built to be that thing; the dashboard is not.

### Verified here: Cloudflare quick tunnel

With the Docker stack running, a free quick tunnel was started, `Test connection` in Settings succeeded through it, a signed
link for an uploaded JPEG was downloaded through the public address byte-for-byte, and a tampered link, `/`, `/api/auth/me`
and `/api/media` all returned 404 on the same address. (Facebook/Instagram/Threads themselves were *not* contacted.)

## Setup with Docker (recommended)

```powershell
# 1. make sure .env has MEDIA_SIGNING_KEY (npm run setup:env generates it; add one by hand if your .env is older):
#    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
docker compose --profile tunnel up -d     # gateway + free Cloudflare quick tunnel
npm run tunnel:url                        # prints https://<random>.trycloudflare.com
```

Then in the dashboard: **Settings → Public media address** → paste the address → **Save** → **Test connection**
(it must say the gateway answered over HTTPS). When you are finished: `docker compose --profile tunnel stop cloudflared`.

The quick-tunnel address changes whenever the tunnel container restarts: run `npm run tunnel:url` and paste the new one.
Posts already scheduled keep working as long as the address in Settings is current when they are published, because links are
created at publish time.

Using your own tunnel (named Cloudflare tunnel, Tailscale Funnel, …) instead: `docker compose --profile media up -d` starts
only the gateway on `127.0.0.1:4100`; point your tunnel at `http://127.0.0.1:4100`.

## Setup without Docker (development)

```powershell
npm run dev:gateway                                   # gateway on 127.0.0.1:4100 (needs MEDIA_SIGNING_KEY in .env)
winget install Cloudflare.cloudflared                 # once
cloudflared tunnel --url http://127.0.0.1:4100        # prints the https://….trycloudflare.com address
```

## What happens when it is not set up

* The composer validates **per account**: an Instagram target says *"Instagram downloads media from a public HTTPS address.
  Set it up under Settings → Public media address … or post manually."* and nothing is queued. Threads text-only posts are unaffected.
* If the address disappears after a post was queued, the attempt fails with a permanent, clear error — it is never reported as published.

## Cleanup

`npm run cleanup-media` (also run by the worker every 6 hours) removes files on disk that are not in the database and stale
temp uploads (only when older than an hour). Deleting media in the UI is refused while a post still references it.
