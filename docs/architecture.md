# Architecture and reliability

## Flow

```
Browser ──► nginx (web) ──► API (Express) ──► MongoDB   ◄── source of truth
                                  │
                                  └──► Redis / BullMQ ──► Worker ──► platform adapters ──► Bluesky / Mastodon / …
```

1. The composer saves a `Post` and one `PostTarget` per selected account.
2. *Publish now* or *Schedule* validates **each target independently** with its platform adapter (limits come from the
   adapter, and for Mastodon from the chosen server). If any target is invalid, nothing is queued and the response
   lists every problem per account.
3. For each valid target a `PublishJob` is created and a BullMQ message is added (delayed until the scheduled time).
4. The worker claims the job, calls the adapter, and writes the result to that target only.
5. The post's overall status is **derived** from its targets (`published`, `partially_published`, `failed`, …) and never
   overwrites a target's own result.

## Target lifecycle

`draft → scheduled → queued → publishing → published`, with `failed`, `needs_reauthorization` and `cancelled` as other
end states. A transient failure moves `publishing → queued` again (shown as "retrying"). `published` is final.
Timestamps are stored in UTC; the browser converts using the timezone chosen in Settings.

## What the system guarantees

* **At most one active job per target** — a partial unique index in MongoDB. Double clicks and races cannot queue twice.
* **A job body never runs concurrently** — an atomic compare-and-set claims it before any network call, so BullMQ
  redelivering a message (e.g. after a worker crash) is harmless.
* **Scheduled posts survive restarts** — delayed jobs live in Redis (append-only persistence in Compose) *and* in
  MongoDB. On worker start and every 30 s, recovery re-creates any missing queue entry from MongoDB. This was tested by
  restarting the API, worker and Redis containers while a post was scheduled.
* **Successful results are never erased** — each target stores its own `remoteId`/`remoteUrl`; a later failure on
  another account only changes that account's target.
* **Bounded retries with backoff** — exponential backoff with jitter, floored by the platform's `Retry-After`; at most
  `PUBLISH_MAX_ATTEMPTS` attempts.

## What it does NOT guarantee (exactly-once is impossible here)

Third-party APIs do not offer transactions with this app, so a request can succeed on the platform while the response is
lost. The engine therefore classifies every failure:

| Class | Example | Behaviour |
|---|---|---|
| transient | connection refused, DNS failure | retried automatically |
| rate_limited | HTTP 429 | retried after `Retry-After` |
| auth | 401, revoked token | target → `needs_reauthorization`, account flagged, not retried |
| permanent | 4xx validation | failed, not retried |
| **ambiguous** | timeout or 5xx **after** the creating request was sent; worker crash while sending | **never auto-retried** unless the platform supports idempotency keys |

* **Mastodon** accepts an `Idempotency-Key` (kept ~1 hour), so ambiguous failures *are* retried with the same key and
  cannot create a duplicate inside that window. After a crash older than ~54 minutes the engine stops trusting the key
  and treats the outcome as ambiguous.
* **Bluesky** has no idempotency key for creating posts, so an ambiguous outcome ends as `failed` with the message
  "outcome unknown — check the platform first". **Retry** then asks for explicit confirmation ("this may create a duplicate").
* Before the creating request is sent the job records `phase = sending` in MongoDB. If a worker dies in `preparing`
  (uploading media, nothing public yet) the job is restarted safely; if it dies in `sending`, see the table above.

## Token lifetimes

Threads tokens (60 days) are refreshed by the worker every 6 hours when they are within 14 days of expiry; accounts whose token can no
longer be refreshed are flagged *Reconnect needed* while there is still time. LinkedIn tokens (60 days) cannot be refreshed by
ordinary apps, so they show their expiry date and warn before it. Meta Page tokens do not expire by time but fail with an auth error
if revoked, which flags the account the same way.

## Components

* **API** — validation (Zod), sessions, CSRF, rate limits, REST endpoints. Never calls platforms while publishing.
* **Worker** — only place that talks to platforms for publishing. Graceful shutdown waits for in-flight jobs.
* **Adapters** — one package per platform behind a common contract: `beginAuthorization`, `completeAuthorization`,
  `validateContent`, `publish`, `verifyCredentials`, `revoke`, `fetchPostMetrics`, and declarative `capabilities`
  (limits, media types, scheduling, idempotency, analytics). Unimplemented adapters report `implemented: false` and are
  refused by the engine.
* **Key/value store** — encrypted (AES-256-GCM) storage for OAuth state, Mastodon app registrations and Bluesky sessions.
