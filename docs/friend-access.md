# Optional trusted-friend access

Off by default. With `ENABLE_FRIEND_ACCESS=true` the owner can create one or more **friend** users who may write and
publish posts — but only to accounts the owner explicitly shares.

## Set up

```powershell
# 1. in .env
ENABLE_FRIEND_ACCESS=true         # then: docker compose up -d
# 2. create the friend (prompts for a password; there is no sign-up page)
npm run create-user -- --email friend@example.com --name "Sam"
# 3. in the web UI: Settings → Trusted friend access → switch on the accounts they may use
```

Remote access for your friend should go through a private VPN — see [security.md](security.md).

## What a friend can and cannot do

| | Friend | Owner |
|---|---|---|
| Write, schedule, publish posts (own posts only) | yes, to **shared** accounts | yes |
| Upload and use their own media | yes (separate library) | yes |
| See the owner's posts, media, activity log | **no** | yes |
| See tokens, passwords, scopes' secrets | **never** | never in the UI either |
| Connect, disconnect, verify accounts | **no** | yes |
| Grant or revoke sharing, see system settings | **no** | yes |

Publishing happens in the worker, which uses the owner's stored token on the friend's behalf; the token is never sent to
the friend's browser. Revoking a share cancels that friend's queued and scheduled posts for the account. Every grant,
revocation and publish is in the audit log.
