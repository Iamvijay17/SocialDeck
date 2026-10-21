# Platform setup, eligibility and costs

Everything here uses **official APIs only** — no scraping, no browser automation, no collecting passwords.
"Implemented" means the adapter code exists and passes automated tests against *mocked* APIs. **None of the live
integrations has been verified against the real service yet.** After connecting each account, publish one test post and
check it on the platform before relying on it.

Information below was checked against the vendors' documentation in October 2026; vendors change access rules and
prices often, so re-check the linked pages before starting.

## Bluesky — implemented, unverified live

* Docs: <https://docs.bsky.app/> · post creation: <https://docs.bsky.app/docs/tutorials/creating-a-post>
* **Cost:** free. **Account:** any Bluesky account. No developer registration is needed.
* **Login:** AT Protocol OAuth (PKCE + DPoP + PAR) through Bluesky's maintained client library. You approve on
  Bluesky's own page; the app never sees your password and does not use app passwords.
* **Scopes requested:** `atproto repo:app.bsky.feed.post?action=create blob:image/*` (create posts, upload images —
  nothing else). If your server rejects granular scopes, set `BLUESKY_OAUTH_SCOPE="atproto transition:generic"`
  (broader, legacy).
* **Local installs:** use `PUBLIC_URL=http://127.0.0.1:<port>` (an IP literal, not `localhost`). The AT Protocol's
  loopback client rules allow this without publishing anything.
* **Non-local installs (e.g. reached over a VPN hostname):** Bluesky's server must be able to download the client
  metadata from `https://<your host>/api/oauth/bluesky/client-metadata.json`, so the app needs a publicly reachable
  HTTPS URL for that one file. If that is not acceptable, run Bluesky connections from the loopback install.
* **Limits handled:** 300 graphemes, 4 images, **1 MB per image** (protocol limit — large photos must be resized
  first), alt text, links and mentions become clickable facets. **Not supported:** video, GIFs, threads, replies.
* Sessions of apps that cannot authenticate themselves ("public clients") are shorter-lived; expect to reconnect now
  and then. The account shows *Reconnect needed* when that happens.

## Mastodon — implemented, unverified live

* Docs: <https://docs.joinmastodon.org/methods/statuses/>
* **Cost:** free (instance rules apply). **Account:** any account on a Mastodon-compatible server.
* **Login:** you type your server (e.g. `mastodon.social`); the app registers itself on that server
  (`POST /api/v1/apps`) and sends you to its OAuth screen. No developer account is needed. PKCE is used.
* **Scopes:** `profile write:statuses write:media` (`read:accounts` instead of `profile` on servers older than 4.3).
* **Limits:** characters, attachments and file sizes are read from your server (`/api/v2/instance`). Links count as
  23 characters. Images and video (video is processed asynchronously and polled).
* **Duplicates:** posts carry an `Idempotency-Key`, so a retry after a lost response cannot post twice (Mastodon keeps
  keys for about an hour).
* **Scheduling:** the app schedules with its own queue so every platform behaves the same. The adapter also supports
  Mastodon's native scheduled statuses (≥ 5 minutes ahead) but the UI does not use them.
* Servers on private/loopback addresses are blocked (SSRF protection); for a local test server set
  `ALLOW_PRIVATE_NETWORK_TARGETS=true`.

## Instagram — not implemented

* Docs: <https://developers.facebook.com/docs/instagram-platform/content-publishing/>
* **Eligible accounts:** Instagram **professional** accounts only (personal accounts cannot publish through the API).
* **You must:** create a Meta developer app; use either *Instagram API with Instagram Login*
  (`instagram_business_basic`, `instagram_business_content_publish`) or *with Facebook Login*
  (`instagram_basic`, `instagram_content_publish`, `pages_read_engagement`), and have Standard/Advanced Access for them.
* **Media:** Instagram **downloads media from a publicly reachable HTTPS URL**; JPEG is the only image format. See
  [media-hosting.md](media-hosting.md). Meta documents a limit of 100 API-published posts per account per 24 h.
* **Cost:** the API is free; hosting a public media URL may cost money or effort (a tunnel is free).
* Status: adapter is a stub; the app refuses to publish to it.

## Facebook Pages — not implemented

* Docs: <https://developers.facebook.com/docs/pages-api/posts/>
* **Eligible targets:** Pages you can manage (not personal profiles or groups).
* **You must:** Meta developer app + Facebook Login for a person with the right Page task access (create content,
  manage, moderate); permissions `pages_manage_posts`, `pages_read_engagement`, `pages_manage_engagement`,
  `pages_read_user_engagement` (+ `publish_video` for video); a **Page access token**. Whether Meta App Review is needed
  for your situation depends on whether the app users own/manage the Page — check their current rules.
* Text/links: `POST /{page_id}/feed`; photos: `POST /{page_id}/photos` (by URL). Status: stub.

## Threads — not implemented

* Docs: <https://developers.facebook.com/docs/threads/>
* **You must:** Meta developer app with the Threads use case and publishing permission (`threads_content_publish`).
  Media is fetched from a public URL. Check the *Get Started* and *Posts* guides for current limits. Status: stub.

## X — not enabled

* Docs: <https://developer.x.com/>
* Free/Basic/Pro plans reportedly no longer accept new developers and posting is **pay-per-use** (third-party reports
  from 2026 mention roughly $0.015 per post, more with links). This came from secondary sources, **not X's own pages** —
  verify the price on X's developer portal before deciding. Unlike the other platforms it is not free; the adapter is
  intentionally left disabled until you have confirmed access and cost.

## Unavoidable third-party requirements, summarised

| Platform | Cost | Developer registration | Public media URL |
|---|---|---|---|
| Bluesky | free | none | no |
| Mastodon | free | none (auto-registers per server) | no |
| Instagram | API free | Meta app, professional account | **yes** |
| Facebook Pages | API free | Meta app, Page permissions | for photos by URL |
| Threads | API free | Meta app | **yes** |
| X | **paid (pay-per-use)** | X developer account | no |

## Analytics

Only what the official APIs return and the adapter implements: Bluesky (likes, reposts, replies, quotes) and Mastodon
(favourites, boosts, replies) for already-published posts, loaded on demand from the dashboard. Everything else shows
"not available" — never a zero or an estimate.
