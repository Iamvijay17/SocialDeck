# Operations: backup, restore, upgrades, troubleshooting

## What lives where

| Data | Location | Back up? |
|---|---|---|
| Posts, accounts (encrypted tokens), audit log | MongoDB volume `mongo-data` | **yes** (`npm run backup`) |
| Media files | `./data/media` | **yes** (included in `npm run backup`) |
| `ENCRYPTION_KEY`, other secrets | `.env` | **yes, separately** (password manager) — never inside the backup |
| Queue state | Redis volume `redis-data` | no — rebuilt from MongoDB on worker start |

## Backup

```powershell
npm run backup            # → backups/<timestamp>/{mongo.archive.gz, media/, MANIFEST.txt}
```

Needs the stack running (`docker compose up -d`). Copy the `backups` folder somewhere off the machine regularly
(external disk, encrypted cloud folder). The tokens inside are encrypted, but protect the folder anyway.

## Restore

```powershell
docker compose up -d mongo
npm run restore -- backups/<timestamp> --yes     # REPLACES the database and media
docker compose up -d --build
```

Use the same `ENCRYPTION_KEY` that was active when the backup was made, otherwise connected accounts must be
reconnected. Anything that was scheduled is picked up by the worker's recovery on start.

## Upgrade

```powershell
git pull                  # or copy the new version over
npm install
docker compose up -d --build
```

Indexes are created automatically at start. Take a backup first.

## Stop / start

`docker compose stop` lets in-flight publishes finish (up to 70 s). Data persists in volumes. `docker compose down -v`
**deletes the volumes** — don't, unless you want a clean slate.

## Windows notes

* Use Docker Desktop with the WSL 2 backend. The `data/media` bind mount lives on your Windows disk.
* Run commands in PowerShell or Windows Terminal from the project folder.
* If Docker complains about line endings or file sharing, make sure the drive is shared in Docker Desktop settings.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `docker compose up` says `run "npm run setup:env" first` | `.env` is missing `MONGO_PASSWORD`/`REDIS_PASSWORD` — run `npm run setup:env` (it never overwrites an existing `.env`; add the two variables by hand if you have one). |
| Sign-in fails with the right password | The owner is only created when no users exist. Use `npm run reset-password -- --email you@…`. |
| Dashboard: "worker is not running" | `docker compose logs worker`; start it. Nothing is lost while it is down. |
| A target says "outcome is unknown" | A request may have reached the platform. Check the platform, then use **Retry** (and confirm) only if the post is not there. |
| Account shows "Reconnect needed" | The platform revoked or expired the authorization. Social Accounts → Reconnect. |
| Bluesky: "invalid redirect" | `PUBLIC_URL` must use `127.0.0.1` for local installs, or a public https URL (see platforms.md). |
| Mastodon: "does not look like a Mastodon server" | Check the hostname (no path). Private-network servers need `ALLOW_PRIVATE_NETWORK_TARGETS=true`. |
| 413 on upload | Raise `MAX_IMAGE_MB`/`MAX_VIDEO_MB` (and nginx `client_max_body_size` in `apps/web/nginx.conf`). |
| Time looks wrong | Set the timezone under Settings; times are stored in UTC. |

## Health checks

* API: `GET /api/health` (liveness), `GET /api/ready` (MongoDB + Redis).
* Containers report health in `docker compose ps`; the worker is healthy while its scheduler heartbeat is fresh.
