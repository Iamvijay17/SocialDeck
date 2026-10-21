# API reference

Base path `/api`. JSON in and out. Authentication is the `osh_session` cookie; every non-GET request must also send
`X-CSRF-Token` (returned by `POST /auth/login` and `GET /auth/me`). Every response carries `X-Request-Id`.

Errors always look like:

```json
{ "error": { "code": "validation_failed", "message": "The request is invalid.", "details": { "fields": [{ "path": "text", "message": "…" }] }, "requestId": "…" } }
```

Statuses: `400` bad request · `401` not signed in · `403` forbidden/CSRF · `404` not found · `409` conflict (e.g. already
publishing, ambiguous outcome) · `413/415` upload too large/unsupported · `422` validation (per-account details under
`details.targets`) · `429` rate limited · `501` integration not implemented. Lists accept `page` and `limit` (≤ 100) and
return `{ items, page, limit, total }`.

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /health`, `GET /ready` | liveness / MongoDB + Redis readiness | public |
| `GET /auth/status` | app name | public |
| `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` | session | login is rate limited; no registration endpoint exists |
| `PATCH /auth/preferences` · `PATCH /settings/preferences` | timezone | IANA name |
| `GET /platforms` | adapters, capabilities, maturity, notes | |
| `GET /accounts` · `GET /accounts/:id` | accounts you own or are granted | never contains credentials |
| `GET /accounts/:platform/connect?instance=&handle=` | returns `{ authorizationUrl }` | owner only |
| `GET /accounts/:platform/callback` | OAuth return; redirects to `/accounts?connected=…` | owner session required |
| `POST /accounts/:id/verify` · `DELETE /accounts/:id` | check / disconnect (revokes upstream, cancels pending posts) | owner only |
| `PUT/DELETE /accounts/:id/grants/:userId` | friend access | owner only, needs `ENABLE_FRIEND_ACCESS` |
| `GET /users` | friend users | owner only |
| `GET /posts` | filters: `status`, `platform`, `from`, `to`, `q`, `sort` | targets and media included |
| `POST /posts/validate` | per-account validation without saving | |
| `POST /posts` · `GET/PATCH/DELETE /posts/:id` | drafts | content is locked once a target is in flight or published |
| `POST /posts/:id/publish` | queue all eligible targets now | `202`; `422` lists problems per account and queues nothing |
| `POST /posts/:id/schedule` | `{ scheduledAt, timezone }` | `scheduledAt` must include an offset (e.g. `Z`) |
| `POST /posts/:id/cancel` | cancel everything not started | |
| `GET /publishing/jobs` · `GET /publishing/jobs/:id` | job history | |
| `POST /publishing/jobs/:id/retry` | `{ acknowledgeDuplicateRisk }` | needed after an ambiguous outcome |
| `POST /publishing/jobs/:id/cancel` | only before it starts | |
| `GET /media` · `POST /media` (multipart `file`) · `GET/PATCH/DELETE /media/:id` · `GET /media/:id/file` · `GET /media/usage` | media library | delete refused while used by a post |
| `GET /dashboard/summary` | counts, activity, upcoming, integrations, worker state | |
| `GET /analytics/overview` · `GET /analytics/targets/:id/metrics` | real publishing stats; live platform metrics when the API offers them | `available:false` + reason otherwise |
| `GET /settings` · `GET /settings/audit-log` | system info, audit trail | |
| `GET /public-media/:id?exp=&sig=` | signed public delivery | disabled unless `PUBLIC_MEDIA_BASE_URL` is set |
| `GET /oauth/bluesky/client-metadata.json` | Bluesky OAuth client metadata | only used for non-loopback installs |
