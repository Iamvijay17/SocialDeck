# SocialDeck

A private, self-hosted dashboard for **one owner** (and, optionally, one trusted friend) to write a post once, pick
several connected accounts, publish or schedule it, and watch the result for every account separately.

Not a SaaS: no public sign-up, no billing, no multi-tenancy. It runs on your own machine (Windows 11 friendly) with
free tools only — MongoDB, Redis, Node.js and Docker Desktop.

## Integration status (read this first)

| Platform | State | What that means |
|---|---|---|
| **Bluesky** | Implemented, **not verified live** | Official AT Protocol OAuth (no passwords). Text, links, up to 4 images with alt text. Needs no setup. |
| **Mastodon** | Implemented, **not verified live** | Official OAuth 2, per-server app registration, text + images/video, duplicate-safe retries. Needs no setup. |
| **Facebook Pages** | Implemented, **not verified live**, needs your Meta app | Text, links, images, video to Pages you manage. |
| **Instagram** | Implemented, **not verified live**, needs your Meta app + a public media address | Professional accounts linked to a Page: JPEG image, carousel, or Reel. |
| **Threads** | Implemented, **not verified live**, needs the Threads part of your Meta app | Text, images, video, carousels; tokens refreshed automatically. Media needs a public address. |
| **LinkedIn** | Implemented, **not verified live**, needs your LinkedIn app | **Personal profile only** (free "Share on LinkedIn"): text + one image. Company Pages need LinkedIn approval — not supported. |
| X | **Disabled — paid API** | Not implemented on purpose (your ₹0 rule). Use the manual *copy caption + open X* option. |
| Mock | Development only | Simulated platform (`ENABLE_MOCK_PLATFORM=true`) to try everything with no accounts. |

Platforms that need developer credentials show **Needs setup** (with the exact variables to add) until you provide them. Anything
unavailable or unconfigured also gets a **manual fallback** in the composer. No manual post is ever recorded as published.

"Implemented" means the code exists and passes its automated tests. **No integration is claimed to work against the
real service until you have connected a real account and published a test post** — that needs your own accounts and
developer apps. **[docs/platforms.md](docs/platforms.md) is the setup guide**: every developer app, permission, account requirement,
environment variable and manual step, per platform. Instagram/Threads media additionally need a free tunnel to the
[media gateway](docs/media-hosting.md) (a free Cloudflare quick tunnel was verified to work).

## Quick start (Docker, recommended)

Requirements: Windows 11 (or macOS/Linux), [Node.js 22+](https://nodejs.org), [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```powershell
npm install
npm run setup:env -- you@example.com     # creates .env with fresh secrets and prints your owner password once
docker compose up -d --build
```

Open <http://127.0.0.1:8080> and sign in with the email and password printed by `setup:env`.
Afterwards delete the `OWNER_PASSWORD` line from `.env` (the owner already exists in the database).

Want to try it without any developer accounts? Re-run with `npm run setup:env -- you@example.com --demo` on a fresh
checkout (or set `ENABLE_MOCK_PLATFORM=true`) and connect the "Mock" platform on the Social Accounts page.

Check the installation end to end: `node scripts/smoke.js` (needs the mock platform enabled).

**Back up two things:** the `ENCRYPTION_KEY` from `.env` (password manager) and, regularly, `npm run backup`.

## Development mode

```powershell
npm install
npm run setup:env -- you@example.com --demo
docker compose -f docker-compose.dev.yml up -d     # MongoDB + Redis on 127.0.0.1 (or: npm run dev:mongo, plus any local Redis)
npm run dev                                         # API :4000, worker, web http://127.0.0.1:5173
npm test                                            # unit + integration tests (starts its own temporary MongoDB)
npm run lint
```

Integration tests that need a real Redis (BullMQ) are skipped unless `TEST_REDIS_URL` is set, e.g.
`$env:TEST_REDIS_URL="redis://127.0.0.1:6379/5"; npm test`.

## Everyday commands

| Command | Purpose |
|---|---|
| `docker compose up -d --build` / `down` / `logs -f` | Run, stop, inspect the stack |
| `npm run backup` / `npm run restore -- backups/<folder> --yes` | MongoDB dump + media copy ([docs/operations.md](docs/operations.md)) |
| `npm run create-user` / `reset-password` / `list-users` | Account administration (CLI only) |
| `npm run rotate-key` | Re-encrypt stored tokens after changing `ENCRYPTION_KEY` |
| `npm run cleanup-media` | Remove orphaned files from the media folder |
| `docker compose --profile tunnel up -d` / `npm run tunnel:url` | Media gateway + free Cloudflare quick tunnel; prints its address |
| `npm run dev:gateway` | Run the media gateway without Docker |

## How it is built

```
apps/web        React + Vite + Tailwind + shadcn-style components, React Router, TanStack Query
apps/api        Express REST API (auth, posts, accounts, media, dashboard)
apps/worker     BullMQ worker + scheduler/recovery sweep that actually publishes (and refreshes expiring tokens)
apps/media-gateway  tiny read-only service that serves signed, expiring links to single media files (for Instagram/Threads)
packages/platform-core   adapter contract, error classification, retry maths, SSRF-safe fetch, mock adapter
packages/adapters/*      bluesky, mastodon, facebook, instagram, threads, linkedin (implemented); meta-common (shared Graph client + Meta login); x (disabled stub)
packages/validation      Zod schemas shared by API and UI
packages/shared          statuses/lifecycle, platform ids, errors
packages/server-core     models, services (publishing engine, media, auth…) used by both API and worker
tests/                   integration tests (real MongoDB, optional real Redis)
docs/                    guides
```

`server-core` is an addition to the originally suggested layout: the API and the worker must run exactly the same
publishing logic and data models, so they live in one package instead of the worker importing from the API.

More: [architecture & reliability guarantees](docs/architecture.md) · [platform setup guide & costs](docs/platforms.md) ·
[security & remote access](docs/security.md) · [media delivery](docs/media-hosting.md) ·
[friend access](docs/friend-access.md) · [API reference](docs/api.md) · [operations & troubleshooting](docs/operations.md)

## Troubleshooting

* **Dashboard says "worker is not running"** — start it (`docker compose up -d worker` or `npm run dev:worker`). Queued and scheduled posts wait safely.
* **Cannot sign in** — passwords are only read from `OWNER_PASSWORD` when no user exists yet. Use `npm run reset-password`.
* **"Could not decrypt"/connections lost after changing `.env`** — `ENCRYPTION_KEY` must stay the same (see [docs/security.md](docs/security.md)).
* **Bluesky sign-in redirects fail** — use `127.0.0.1`, not `localhost`, in `PUBLIC_URL` (see [docs/platforms.md](docs/platforms.md)).
* **Port 8080 or 5173 already in use** — set `PSM_PORT` in `.env` (Docker) or stop the other process.
