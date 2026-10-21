# Platform setup guide

SocialDeck publishes only through **official, free APIs**. No scraping, no browser automation, no passwords. Anything
that costs money stays disabled. This guide lists, for every platform, what you must create or approve yourself.

> **Honesty note.** "Implemented" means the adapter exists and passes automated tests against *mocked* API responses.
> **None of the platforms has been tried against its real service** — that needs your accounts and developer apps.
> After connecting each account, publish one test post and check it on the platform. Vendor dashboards change their
> wording often; where I could not confirm a screen name I say so. Facts below were checked against the vendors'
> documentation in October 2026.

## At a glance

| Platform | Cost | Developer app you create | Account needed | Needs public media URL | Review/approval |
|---|---|---|---|---|---|
| Bluesky | free | none | any account | no | none |
| Mastodon | free | none (auto-registers per server) | any account | no | none |
| Facebook Pages | free | Meta app | a Page you manage | no | none while the app stays in Development mode with you as admin¹ |
| Instagram | free | same Meta app | Professional account linked to a Page | **yes** (images/video) | same as above¹ |
| Threads | free | Threads use case in the same Meta app | Threads account | **yes**, only for posts with media | same as above¹ |
| LinkedIn | free | LinkedIn developer app | personal LinkedIn profile | no | self-serve products² |
| X | **paid** | — | — | — | **disabled** (see bottom) |

¹ Meta lets people who have a role on your app (you, as admin) use the permissions without App Review while the app is
in Development mode. Publishing your *own* content to *your own* Pages/accounts is exactly that case. If Meta's dashboard
asks you to complete App Review, you do not need to for this use — do not switch the app to Live. Meta can change this;
check the "Permissions and features" page of your app.
² LinkedIn describes "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect" as self-serve products. I could
not confirm whether your account will see an extra review step.

Everything is configured in `.env` (copy of `.env.example`). A platform shows **Needs setup** on the *Social Accounts*
page until its variables are set, and **Disabled (paid API)** for X. Restart the API after editing `.env`
(`docker compose up -d`, or restart `npm run dev`).

## 0. One decision first: the redirect address

Meta, Threads and LinkedIn send your browser back to a "redirect URI" you register in their developer dashboard.

* Meta accepts plain `http://` only for **`http://localhost`** and only while the app is in Development mode (not
  `127.0.0.1`). SocialDeck therefore uses `OAUTH_REDIRECT_BASE_URL`, default `http://localhost:8080` in Docker
  (`http://localhost:5173` for `npm run dev`).
* The callback is completed from a secret one-time `state` value, not from your login cookie, so it works even though the
  dashboard itself is on `127.0.0.1`.
* LinkedIn's docs say callback URLs must be HTTPS and I could not confirm an exception for `localhost`. Threads' docs show
  only HTTPS examples. If either rejects the `http://localhost` address, use a private HTTPS address instead — for
  example [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) (free, reachable only from your own devices):
  run `tailscale serve --bg 8080` (check Tailscale's docs; the syntax varies by version), then set
  `PSM_OAUTH_REDIRECT_BASE_URL=https://<your-machine>.<tailnet>.ts.net` (Docker) or `OAUTH_REDIRECT_BASE_URL=...` (dev)
  and register callbacks with that base.
* Bluesky and Mastodon keep using `PUBLIC_URL` (`http://127.0.0.1:...`) as before.

The callback paths to register are:

| Platform | Redirect URI |
|---|---|
| Facebook Pages **and** Instagram | `<base>/api/accounts/facebook/callback` |
| Threads | `<base>/api/accounts/threads/callback` |
| LinkedIn | `<base>/api/accounts/linkedin/callback` |

where `<base>` is `http://localhost:8080` (Docker) or `http://localhost:5173` (dev), or your HTTPS base.

---

## Bluesky — implemented, not verified live

Docs: <https://docs.bsky.app/docs/tutorials/creating-a-post>

* **You do:** nothing in advance. Social Accounts → Connect → Bluesky → enter your handle (or leave empty for bsky.social) →
  approve on Bluesky.
* **Permissions requested:** `atproto repo:app.bsky.feed.post?action=create blob:image/*` (create posts and upload images
  only). If a server rejects granular scopes, set `BLUESKY_OAUTH_SCOPE="atproto transition:generic"`.
* **Limits:** 300 characters, 4 images (each ≤ 1 MB — resize large photos), alt text. No video, GIF or threads.
* **Local vs remote:** works from `http://127.0.0.1:<port>`. A non-local install needs a public HTTPS address so Bluesky can
  read the client metadata (`/api/oauth/bluesky/client-metadata.json`).
* **Env:** none.

## Mastodon — implemented, not verified live

Docs: <https://docs.joinmastodon.org/methods/statuses/>

* **You do:** nothing in advance. Connect → Mastodon → type your server (e.g. `mastodon.social`) → approve. SocialDeck
  registers itself on that server automatically.
* **Permissions:** `profile write:statuses write:media` (`read:accounts` instead of `profile` on servers older than 4.3).
* **Limits:** read from your server (characters, attachments, sizes). Duplicate-safe retries via `Idempotency-Key`.
* **Env:** none (`ALLOW_PRIVATE_NETWORK_TARGETS=true` only for a test server on your own network).

## Facebook Pages — implemented, not verified live

Docs: <https://developers.facebook.com/docs/pages-api/posts/>

**Account requirements:** a Facebook **Page** you manage (a role that can create content). Personal profiles and groups
cannot be posted to through the API.

**What you must do manually**

1. Go to <https://developers.facebook.com/>, log in with the Facebook account that manages the Page, and register as a
   developer if asked (free).
2. **My Apps → Create App.** Pick use cases that include **Facebook Login** and managing your **Page** content. (The exact
   use-case names change; what matters is that the app can request the permissions below.) Keep the app in **Development** mode.
3. **Facebook Login → Settings → Valid OAuth Redirect URIs:** add
   `http://localhost:8080/api/accounts/facebook/callback` (Docker) and/or `http://localhost:5173/api/accounts/facebook/callback` (dev).
4. **App settings → Basic:** copy **App ID** and **App Secret**.
5. Put them in `.env`:
   ```
   META_APP_ID=...
   META_APP_SECRET=...
   ```
   and restart.
6. Social Accounts → Connect → **Facebook Pages**. In Facebook's dialog choose the Page(s) and approve **all** permissions.

**Permissions requested:** `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`.

**What it publishes:** text (63,206 chars), links (first URL becomes a preview when there are no images), up to 10 images
(JPEG/PNG/GIF, uploaded directly — no public URL needed), or one MP4 video. No scheduling by Facebook; SocialDeck schedules.

**Caveats:** if the Page is managed through a Meta Business portfolio you may be asked for `business_management` — not
requested by default. Page tokens do not expire by time but stop working if you remove the app, change your password or lose
the Page role; the account then shows *Reconnect needed*. Revoke completely via Facebook → Settings → Business integrations.

## Instagram — implemented, not verified live

Docs: <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/content-publishing>

**Account requirements:** an Instagram **Professional** account (Business or Creator — personal accounts cannot use the
API) **linked to a Facebook Page** you manage. SocialDeck uses *Instagram API with Facebook Login*, so it shares the Meta app and
login with Facebook Pages.

**What you must do manually**

1. In the Instagram app: Settings → Account type and tools → switch to **Professional** (Creator or Business).
2. Link it to your Facebook Page (Instagram: Edit profile → Page, or Page settings → Linked accounts; wording varies).
3. Complete the Facebook Pages steps above (same Meta app, same `META_APP_ID` / `META_APP_SECRET`, same redirect URI).
4. In the Meta app, make sure the **Instagram** permissions `instagram_basic` and `instagram_content_publish` are available
   to your app (they are requested during login).
5. **Set up public media delivery** — see [media-hosting.md](media-hosting.md). Instagram downloads your media itself.
6. Social Accounts → Connect → **Instagram**; choose the Page that has the Instagram account, approve everything.

**Permissions requested:** `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`.

**What it publishes:** a **JPEG** image, a single video (as a **Reel**), or a carousel of 2–10 JPEG images, with caption
(≤ 2,200 characters, ≤ 30 hashtags). **No text-only posts**; PNG/WebP are rejected by Instagram. Alt text is sent for single
images. Meta documents roughly 100 API posts per account per 24 hours.

## Threads — implemented, not verified live

Docs: <https://developers.facebook.com/docs/threads/> (get started, posts, long-lived tokens)

**Account requirements:** a Threads account. While your app is in Development mode the account must be a **Threads Tester**
of the app.

**What you must do manually**

1. In the same Meta app, add the **Threads** use case / product. Meta then shows a separate **Threads App ID** and **Threads
   App Secret** (the docs: "there will be 2 app IDs and app secrets").
2. Add permissions `threads_basic` and `threads_content_publish` for the app.
3. In the Threads settings of the app add the redirect URI `http://localhost:8080/api/accounts/threads/callback`
   (or your HTTPS base — see section 0).
4. **App roles → Roles → Add People → Threads Tester**: add your Threads account, then accept the invitation in Threads
   (Settings → Account → Website permissions).
5. `.env`:
   ```
   THREADS_APP_ID=...
   THREADS_APP_SECRET=...
   ```
6. For posts with images/video set up public media delivery ([media-hosting.md](media-hosting.md)). Text-only posts need nothing.
7. Social Accounts → Connect → **Threads**.

**What it publishes:** text up to 500 characters (emoji count by byte size), JPEG/PNG up to 8 MB, MP4 video, carousels (2–20).
Meta documents 250 posts per profile per 24 hours.

**Tokens:** long-lived tokens last 60 days. The worker refreshes them automatically (every 6 hours it refreshes any that expire
within 14 days). If SocialDeck is off for longer than the remaining time you must reconnect; the Accounts page and dashboard
warn when expiry is near.

## LinkedIn (personal profile) — implemented, not verified live

Docs: [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin),
[Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api)

**Is it free and allowed?** Yes for **your own personal profile**: LinkedIn's "Share on LinkedIn" product grants
`w_member_social`, and "Sign In with LinkedIn using OpenID Connect" identifies you. Both are listed as self-serve.
**Company Pages are not supported** — they need the Community Management API (`w_organization_social`), which requires
LinkedIn's approval.

**What you must do manually**

1. Go to <https://www.linkedin.com/developers/apps> → **Create app**. LinkedIn requires the app to be associated with a
   LinkedIn **Page** you administer; if you have none, create a free placeholder Page first. A Page administrator must verify
   the association.
2. **Products** tab: add **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect**. If a product says it needs
   review, wait for LinkedIn's decision — SocialDeck cannot work around that.
3. **Auth** tab: add the redirect URL `http://localhost:8080/api/accounts/linkedin/callback` (LinkedIn's docs require
   HTTPS; if it rejects `http://localhost`, use the HTTPS base from section 0). Copy **Client ID** and **Client Secret**.
4. `.env`:
   ```
   LINKEDIN_CLIENT_ID=...
   LINKEDIN_CLIENT_SECRET=...
   ```
5. Social Accounts → Connect → **LinkedIn**.

**What it publishes:** text (≤ 3,000 characters; reserved characters are escaped so your text appears literally, while
`#hashtag` stays a hashtag; `@mentions` are not supported) and **one image** with alt text, visible to everyone (PUBLIC).
No video, documents or multi-image posts. LinkedIn documents 150 requests per member per day.

**Tokens:** access tokens last **60 days** and ordinary apps cannot refresh them automatically. The account shows its
expiry; reconnect before it lapses (a posts scheduled after expiry fail with *Reconnect needed* rather than disappearing).

## X — deliberately disabled (paid)

X's official posting API is paid. Secondary sources from 2026 describe pay-per-use pricing (around $0.015 per post, more with
links) and closed free/Basic/Pro tiers — **not confirmed from X's own pages**; check <https://developer.x.com/>. This project
only uses free APIs, so there is no X adapter. X appears as **Disabled (paid API)**, and the composer's *Post manually*
panel copies your caption and opens X's own post page so you can post it yourself. SocialDeck records nothing for manual posts.

## Manual fallback

For every platform without a working connected account (not set up, unavailable, or paid) the composer shows **Post manually
on other platforms**: *Copy caption* and *Open <platform>*. Bluesky, Threads and X open with the caption pre-filled through
their public "web intent" links; LinkedIn, Facebook, Instagram and Mastodon open the site/app and you paste the copied caption.
A failed publish also offers **Post manually**. No status is recorded for manual posts, so the dashboard never shows a fake
success.

## Environment variables

| Variable | Needed for | Notes |
|---|---|---|
| `META_APP_ID`, `META_APP_SECRET` | Facebook Pages, Instagram | Meta app settings → Basic |
| `META_GRAPH_VERSION` | — | default `v26.0` |
| `THREADS_APP_ID`, `THREADS_APP_SECRET` | Threads | the **Threads** app id/secret, not the main app's |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | LinkedIn | LinkedIn app → Auth |
| `LINKEDIN_API_VERSION` | — | default `202610` (YYYYMM, must be an active LinkedIn API version) |
| `OAUTH_REDIRECT_BASE_URL` / `PSM_OAUTH_REDIRECT_BASE_URL` (Docker) | Meta, Threads, LinkedIn | `http://localhost:<port>` or an HTTPS base |
| `MEDIA_SIGNING_KEY` | Instagram / Threads media | generated by `npm run setup:env` |
| `PUBLIC_MEDIA_BASE_URL` | Instagram / Threads media | optional; normally set in the dashboard |
| `BLUESKY_OAUTH_SCOPE` | Bluesky | optional override |

Secrets live only in `.env` (git-ignored); they are never sent to the browser or written to logs, and the tokens they
produce are encrypted in MongoDB.

## What has and has not been verified

| | Mocked-API tests | Real service |
|---|---|---|
| Bluesky, Mastodon | ✔ | ✘ not yet |
| Facebook Pages, Instagram, Threads, LinkedIn | ✔ (OAuth, publishing, retries, error classes, token refresh) | ✘ not yet |
| Media gateway + free Cloudflare quick tunnel | ✔ | ✔ a signed link was fetched through a real quick tunnel; everything else on it returned 404 |
