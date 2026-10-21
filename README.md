# Private Social Manager

A private, self-hosted dashboard for **one owner** (and, optionally, one trusted friend) to write a post once, pick
several connected accounts, publish or schedule it, and watch the result for every account separately.

Not a SaaS: no public sign-up, no billing, no multi-tenancy. It runs on your own machine (Windows 11 friendly) with
free tools only — MongoDB, Redis, Node.js and Docker Desktop.

## Integration status (read this first)

| Platform | State | What that means |
|---|---|---|
| **Bluesky** | Implemented, **not verified live** | Official AT Protocol OAuth (no passwords or app passwords). Text, links, up to 4 images with alt text. Covered by tests against *mocked* APIs only. |
| **Mastodon** | Implemented, **not verified live** | Official OAuth 2 with per-server app registration, text + images/video, idempotent posting. Covered by tests against *mocked* APIs only. |
| Instagram | Not implemented | Needs a professional account, a Meta developer app and publicly reachable media. See [docs/platforms.md](docs/platforms.md). |
| Facebook Pages | Not implemented | Pages only (not personal profiles), Meta app + permissions. |
| Threads | Not implemented | Meta app with the Threads API; public media URLs. |
| X | Not enabled | Access and pricing must be re-checked before building; reportedly pay-per-use. |
| Mock | Development only | A simulated platform (`ENABLE_MOCK_PLATFORM=true`) so you can try everything with no developer accounts. |

"Implemented" means the code exists and passes its automated tests. **No integration is claimed to work against the
real service until you have connected a real account and published a test post** — that needs your own accounts and
cannot be done on your behalf. [docs/platforms.md](docs/platforms.md) lists exactly what to do for each platform.

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

## How it is built

```
apps/web        React + Vite + Tailwind + shadcn-style components, React Router, TanStack Query
apps/api        Express REST API (auth, posts, accounts, media, dashboard)
apps/worker     BullMQ worker + scheduler/recovery sweep that actually publishes
packages/platform-core   adapter contract, error classification, retry maths, SSRF-safe fetch, mock adapter
packages/adapters/*      bluesky, mastodon (implemented); instagram, facebook, threads, x (documented stubs)
packages/validation      Zod schemas shared by API and UI
packages/shared          statuses/lifecycle, platform ids, errors
packages/server-core     models, services (publishing engine, media, auth…) used by both API and worker
tests/                   integration tests (real MongoDB, optional real Redis)
docs/                    guides
```

`server-core` is an addition to the originally suggested layout: the API and the worker must run exactly the same
publishing logic and data models, so they live in one package instead of the worker importing from the API.

More: [architecture & reliability guarantees](docs/architecture.md) · [platform setup & costs](docs/platforms.md) ·
[security & remote access](docs/security.md) · [media delivery](docs/media-hosting.md) ·
[friend access](docs/friend-access.md) · [API reference](docs/api.md) · [operations & troubleshooting](docs/operations.md)

## Troubleshooting

* **Dashboard says "worker is not running"** — start it (`docker compose up -d worker` or `npm run dev:worker`). Queued and scheduled posts wait safely.
* **Cannot sign in** — passwords are only read from `OWNER_PASSWORD` when no user exists yet. Use `npm run reset-password`.
* **"Could not decrypt"/connections lost after changing `.env`** — `ENCRYPTION_KEY` must stay the same (see [docs/security.md](docs/security.md)).
* **Bluesky sign-in redirects fail** — use `127.0.0.1`, not `localhost`, in `PUBLIC_URL` (see [docs/platforms.md](docs/platforms.md)).
* **Port 8080 or 5173 already in use** — set `PSM_PORT` in `.env` (Docker) or stop the other process.
