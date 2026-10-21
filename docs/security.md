# Security and private access

This is a small private tool, not a hardened multi-user service. It has not been independently audited.

## What is built in

* **No public registration.** The owner is created from `OWNER_EMAIL` / `OWNER_PASSWORD` when the database has no
  users (the variable is ignored afterwards). Any other user is created from the command line.
* **Passwords:** Argon2id (OWASP parameters). Login attempts are rate limited per IP and per account; failed and
  successful logins are written to the audit log (no secrets).
* **Sessions:** random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` when `PUBLIC_URL` is https);
  only a hash is stored. Idle timeout 24 h, absolute lifetime 7 days (configurable). Logout deletes the session.
* **CSRF:** every state-changing request needs the per-session `X-CSRF-Token`, plus an `Origin` check.
* **Strict CORS** (same origin by default), Helmet headers, a strict CSP on the web container, request validation
  with Zod on every endpoint, consistent error envelope without stack traces in production.
* **Social tokens** are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`); they are never returned by the API or
  written to logs (log redaction + tests that assert it). The friend role never receives credentials.
* **OAuth callbacks** are completed from a random, single-use, owner-bound `state` (encrypted at rest, 10-minute lifetime); replayed, expired or foreign states are rejected. Only the owner can start a flow.
* **Public media gateway:** a separate service that serves only signed, expiring links to individual files, with no database, no API and read-only file access (see [media-hosting.md](media-hosting.md)). Never point a tunnel at the dashboard or API.
* **SSRF protection:** server names you type (Mastodon) are checked at connect time against private, loopback,
  link-local and metadata addresses, redirects are not followed.
* **Uploads:** type decided from file contents (not name or MIME), size limits, server-generated names, path
  traversal checks, no SVG, per-user ownership checks, files served only to the signed-in owner with `nosniff` and a
  sandbox CSP. EXIF metadata (including GPS) is **not** stripped — remove it first if that matters.
* **Network:** the API binds to `127.0.0.1`; Compose publishes only the web port on `127.0.0.1`; MongoDB and Redis
  are on an internal Docker network with passwords and no published ports.

## Secrets

* `.env` is git-ignored; `.env.example` has no secrets. Never commit `.env`, backups or `data/`.
* **Back up `ENCRYPTION_KEY` separately** (password manager). Backups made by `npm run backup` deliberately do not
  contain it. Without it the stored connections cannot be decrypted and every account must be reconnected.
* **Rotate the key:** put the new key in `ENCRYPTION_KEY`, move the old one to `ENCRYPTION_KEY_PREVIOUS`, run
  `npm run rotate-key`, then remove the old key.
* Change a password with `npm run reset-password` (this ends all sessions for that user).

## Remote access

The default is localhost only. If you need access from your phone or a friend's computer:

1. **Preferred: a private VPN** such as [Tailscale](https://tailscale.com) (free for personal use) or WireGuard. Install
   it on the host and on the devices, then set `PSM_PUBLIC_URL` to the VPN address (e.g. `https://psm.tailnet-name.ts.net`,
   using Tailscale's HTTPS certificates) and `TRUST_PROXY` as needed. Do **not** forward router ports.
2. If you must expose it, put it behind a reverse proxy with HTTPS and an additional access layer (VPN, mTLS or an
   identity-aware proxy); keep the web port bound to loopback and let the proxy forward to it.
3. **Never** publish MongoDB (27017) or Redis (6379). Compose does not.
4. When `PUBLIC_URL` is https the cookie becomes `Secure`. The app refuses to start in production with an
   `http://` non-loopback `PUBLIC_URL`.

## Known limitations

* Rate limiting is in-memory (fine for one instance).
* No two-factor authentication.
* Bluesky "public client" sessions expire sooner than confidential-client sessions would.
* Anyone with the host's Docker access or `.env` can read everything; treat the machine accordingly.
