# Media storage and public delivery

Uploads live in `MEDIA_DIR` (`./data/media` with Docker, bind-mounted so Windows can browse and back it up). Files get
random names (`YYYY/MM/<uuid>.<ext>`), are validated by content, and are served **only** through the authenticated
`/api/media/:id/file` endpoint. The folder is never exposed over HTTP.

## Which platforms need a public URL?

* **Bluesky, Mastodon** — the app uploads the file bytes itself. No public URL needed.
* **Instagram, Threads** (not implemented yet) — the platform **downloads the media from an HTTPS URL** you provide.
* **Facebook Pages** photos can be posted by URL as well.

## Option: signed short-lived URLs (prepared, used by future adapters)

Set `PUBLIC_MEDIA_BASE_URL=https://media.example.net`. The API can then mint links such as
`/api/public-media/<id>?exp=<unix>&sig=<hmac>` that work **only for that one file**, expire after
`PUBLIC_MEDIA_URL_TTL_SECONDS` (default 15 minutes) and cannot be forged without `ENCRYPTION_KEY`. Nothing else under
`/api` needs to be reachable from the internet; configure the tunnel/proxy to forward only `/api/public-media/*`.

| Way to make that path reachable | Cost | Trade-offs |
|---|---|---|
| **Cloudflare Tunnel** (`cloudflared`) | free | Needs a domain on Cloudflare; traffic passes through Cloudflare; restrict to the `/api/public-media/*` path. |
| **Tailscale Funnel** | free personal tier | Exposes one port publicly; simple, but exposes the whole web port unless you add a path-restricting proxy in front. |
| **Reverse proxy on a VPS** | VPS cost | Full control and a stable address; you maintain a server. |
| **Object storage (S3/R2/B2) copy** | usually pennies, sometimes free tier | Cleanest isolation (nothing of your home network is exposed) but needs an upload step and cleanup; not implemented. |

None of this is required for Bluesky or Mastodon.

## Cleanup

`npm run cleanup-media` (also run by the worker every 6 hours) removes files that exist on disk but not in the
database (e.g. after a crash mid-upload) and stale temp uploads, only when older than an hour. Deleting media in the UI
is refused while any post still references it.
