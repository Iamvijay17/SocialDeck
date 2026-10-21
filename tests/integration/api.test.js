import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import { User } from '@osh/server-core';
import { createTestContext, drainQueue } from '../helpers/context.js';

const PASSWORD = 'correct horse battery staple';

/** Minimal valid PNG header (signature + IHDR) – enough for signature sniffing and dimension parsing. */
function tinyPng(width = 32, height = 16, extra = 0) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(extra, 1)]);
}

let ctx;
let app;
let agent;
let csrf;
let ownerId;

beforeAll(async () => {
  ctx = await createTestContext({ env: { MAX_IMAGE_MB: '1', OWNER_EMAIL: 'Owner@Example.com', OWNER_PASSWORD: PASSWORD } });
  app = createApp(ctx, { rateLimits: { loginPerAccount: 3, loginPerIp: 50 } });
  agent = request.agent(app);
});
afterAll(async () => ctx.close());

const post = (url, body) => agent.post(url).set('x-csrf-token', csrf).send(body);

describe('authentication and setup', () => {
  it('rejects unauthenticated access to private endpoints', async () => {
    for (const url of ['/api/dashboard/summary', '/api/posts', '/api/accounts', '/api/media', '/api/publishing/jobs', '/api/settings']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
      expect(res.body.error.requestId).toBeTruthy();
    }
  });

  it('has no public registration or setup endpoints', async () => {
    for (const url of ['/api/auth/setup', '/api/auth/register', '/api/auth/signup']) {
      const res = await request(app).post(url).send({ email: 'evil@example.com', password: PASSWORD });
      expect(res.status, url).toBe(404);
    }
  });

  it('cannot log in before the owner exists', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('creates the owner from the environment exactly once', async () => {
    expect(await ctx.services.auth.ensureOwner()).toBe('created');
    expect(await ctx.services.auth.ensureOwner()).toBe('exists');
    const res = await agent.post('/api/auth/login').send({ email: 'owner@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/osh_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(res.body.user).toMatchObject({ email: 'owner@example.com', role: 'owner' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|$argon2/);
    csrf = res.body.csrfToken;
    ownerId = res.body.user.id;
  });

  it('does not let a leftover OWNER_* env var create a second owner', async () => {
    await expect(ctx.services.auth.createUser({ email: 'second@example.com', password: PASSWORD, role: 'owner', isOwner: true })).rejects.toMatchObject({ status: 409 });
  });

  it('stores only a password hash (argon2id)', async () => {
    const user = await User.findOne({ email: 'owner@example.com' }).select('+passwordHash');
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('serves the session user and a CSRF token', async () => {
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.csrfToken).toBe(csrf);
  });

  it('requires a CSRF token on state-changing requests', async () => {
    const noToken = await agent.post('/api/posts').send({ text: 'hi' });
    expect(noToken.status).toBe(403);
    const wrong = await agent.post('/api/posts').set('x-csrf-token', 'nope').send({ text: 'hi' });
    expect(wrong.status).toBe(403);
  });

  it('blocks cross-origin login attempts', async () => {
    const res = await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: 'owner@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it('rejects bad credentials generically and rate limits repeated failures', async () => {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/api/auth/login').send({ email: 'owner@example.com', password: 'wrong-password-123' });
      statuses.push(res.status);
      if (res.status === 401) expect(res.body.error.message).toBe('Invalid email or password.');
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses).toContain(429);
  });

  it('logs out and invalidates the session', async () => {
    const second = request.agent(app);
    // The account limiter above is exhausted for this email; use a fresh limiter-free app instance for the happy path.
    const fresh = request.agent(createApp(ctx));
    const login = await fresh.post('/api/auth/login').send({ email: 'owner@example.com', password: PASSWORD });
    expect(login.status).toBe(200);
    const out = await fresh.post('/api/auth/logout').set('x-csrf-token', login.body.csrfToken);
    expect(out.status).toBe(204);
    expect((await fresh.get('/api/auth/me')).status).toBe(401);
    expect(second).toBeTruthy();
  });
});

describe('accounts', () => {
  let accountIds;

  it('connects accounts through the OAuth-style connect/callback flow and never returns credentials', async () => {
    accountIds = [];
    for (const handle of ['alpha', 'beta']) {
      const start = await agent.get(`/api/accounts/mock/connect?handle=${handle}`);
      expect(start.status).toBe(200);
      const url = new URL(start.body.authorizationUrl);
      const cb = await agent.get(url.pathname + url.search);
      expect(cb.status).toBe(302);
      expect(cb.headers.location).toMatch(/\/accounts\?connected=mock/);
    }
    const list = await agent.get('/api/accounts');
    expect(list.body.items).toHaveLength(2);
    accountIds = list.body.items.map((a) => a.id);
    expect(JSON.stringify(list.body)).not.toMatch(/credentials|mock-[0-9a-f]{8}-/);
  });

  it('rejects a callback with an unknown or reused state', async () => {
    const res = await agent.get('/api/accounts/mock/callback?code=x&state=does-not-exist');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);
  });

  it('refuses to connect unavailable or unconfigured platforms with a clear message', async () => {
    const paid = await agent.get('/api/accounts/x/connect');
    expect(paid.status).toBe(501);
    expect(paid.body.error.code).toBe('integration_unavailable');
    const unconfigured = await agent.get('/api/accounts/instagram/connect');
    expect(unconfigured.status).toBe(409);
    expect(unconfigured.body.error.code).toBe('platform_not_configured');
    expect(unconfigured.body.error.message).toMatch(/META_APP_ID/);
    expect((await agent.get('/api/accounts/threads/connect')).body.error.details.missing).toEqual(['THREADS_APP_ID', 'THREADS_APP_SECRET']);
    expect((await agent.get('/api/accounts/linkedin/connect')).status).toBe(409);
  });

  it('lists platform capabilities, marking unimplemented ones', async () => {
    const res = await agent.get('/api/platforms');
    const byId = Object.fromEntries(res.body.items.map((p) => [p.id, p]));
    expect(byId.bluesky.enabled).toBe(true);
    expect(byId.mastodon.capabilities.idempotentPublish).toBe(true);
    expect(byId.instagram).toMatchObject({ implemented: true, configured: false, enabled: false, missingConfig: ['META_APP_ID', 'META_APP_SECRET'] });
    expect(byId.facebook.configured).toBe(false);
    expect(byId.x).toMatchObject({ implemented: false, enabled: false, maturity: 'paid' });
    expect(byId.linkedin.capabilities.requiredScopes).toContain('w_member_social');
    expect(byId.mock.maturity).toBe('mock');
  });

  describe('posts', () => {
    it('validates per account and returns every problem', async () => {
      const res = await post('/api/posts/validate', { text: 'x'.repeat(300), mediaIds: [], targets: accountIds.map((accountId) => ({ accountId })) });
      expect(res.status).toBe(200);
      expect(res.body.targets.every((t) => !t.valid)).toBe(true);
      expect(res.body.targets[0].issues[0].code).toBe('text_too_long');
    });

    it('saves a draft, then publishes it to multiple accounts', async () => {
      const created = await post('/api/posts', { text: 'Hello everyone', targets: accountIds.map((accountId) => ({ accountId })) });
      expect(created.status).toBe(201);
      expect(created.body.post.status).toBe('draft');
      expect(created.body.post.targets).toHaveLength(2);

      const published = await post(`/api/posts/${created.body.post.id}/publish`, {});
      expect(published.status).toBe(202);
      expect(published.body.post.status).toBe('publishing');

      await drainQueue(ctx);
      const done = await agent.get(`/api/posts/${created.body.post.id}`);
      expect(done.body.post.status).toBe('published');
      expect(done.body.post.targets.map((t) => t.status)).toEqual(['published', 'published']);

      const jobs = await agent.get('/api/publishing/jobs?status=succeeded');
      expect(jobs.body.total).toBeGreaterThanOrEqual(2);
      expect(jobs.body.items[0].target.account.displayName).toBeTruthy();
    });

    it('returns 422 with per-account details when publishing invalid content, and queues nothing', async () => {
      const created = await post('/api/posts', { text: 'y'.repeat(400), targets: [{ accountId: accountIds[0] }] });
      const res = await post(`/api/posts/${created.body.post.id}/publish`, {});
      expect(res.status).toBe(422);
      expect(res.body.error.details.targets[0].issues[0].code).toBe('text_too_long');
      expect(ctx.queue.jobs.size).toBe(0);
    });

    it('schedules, lists by date range, and unschedules via PATCH', async () => {
      const created = await post('/api/posts', { text: 'scheduled post', targets: [{ accountId: accountIds[0] }] });
      const when = new Date(Date.now() + 86_400_000).toISOString();
      const sched = await post(`/api/posts/${created.body.post.id}/schedule`, { scheduledAt: when, timezone: 'Asia/Tokyo' });
      expect(sched.status).toBe(202);
      expect(sched.body.post.status).toBe('scheduled');

      const from = new Date(Date.now() + 80_000_000).toISOString();
      const to = new Date(Date.now() + 90_000_000).toISOString();
      const inRange = await agent.get(`/api/posts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      expect(inRange.body.items.map((p) => p.id)).toContain(created.body.post.id);

      const unsched = await agent.patch(`/api/posts/${created.body.post.id}`).set('x-csrf-token', csrf).send({ scheduledAt: null });
      expect(unsched.status).toBe(200);
      expect(unsched.body.post.status).toBe('draft');
      expect(ctx.queue.jobs.size).toBe(0);
    });

    it('rejects scheduling without an explicit UTC offset', async () => {
      const created = await post('/api/posts', { text: 'tz', targets: [{ accountId: accountIds[0] }] });
      const res = await post(`/api/posts/${created.body.post.id}/schedule`, { scheduledAt: '2099-01-01T10:00:00' });
      expect(res.status).toBe(422);
    });

    it('does not allow editing the content of a published post', async () => {
      const created = await post('/api/posts', { text: 'lock me', targets: [{ accountId: accountIds[0] }] });
      await post(`/api/posts/${created.body.post.id}/publish`, {});
      await drainQueue(ctx);
      const res = await agent.patch(`/api/posts/${created.body.post.id}`).set('x-csrf-token', csrf).send({ text: 'changed' });
      expect(res.status).toBe(409);
    });

    it('paginates and filters', async () => {
      const res = await agent.get('/api/posts?limit=2&page=1&status=published');
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(2);
      expect(res.body.total).toBeGreaterThanOrEqual(2);
      expect((await agent.get('/api/posts?limit=1000')).status).toBe(422);
    });

    it('rejects malformed ids and unknown accounts', async () => {
      expect((await agent.get('/api/posts/not-an-id')).status).toBe(422);
      const res = await post('/api/posts', { text: 'x', targets: [{ accountId: 'f'.repeat(24) }] });
      expect(res.status).toBe(404);
    });
  });

  describe('dashboard and settings', () => {
    it('summarises real data', async () => {
      const res = await agent.get('/api/dashboard/summary');
      expect(res.status).toBe(200);
      expect(res.body.counts.connectedAccounts).toBe(2);
      expect(res.body.counts.publishedPosts).toBeGreaterThanOrEqual(2);
      expect(res.body.recentActivity.length).toBeGreaterThan(0);
      expect(res.body.system).toHaveProperty('workerOnline');
    });

    it('updates preferences and validates the timezone', async () => {
      const ok = await agent.patch('/api/settings/preferences').set('x-csrf-token', csrf).send({ timezone: 'America/New_York' });
      expect(ok.body.user.preferences.timezone).toBe('America/New_York');
      const bad = await agent.patch('/api/settings/preferences').set('x-csrf-token', csrf).send({ timezone: 'Mars/Olympus' });
      expect(bad.status).toBe(422);
    });

    it('records an audit trail without secrets', async () => {
      const res = await agent.get('/api/settings/audit-log?limit=100');
      const actions = res.body.items.map((i) => i.action);
      expect(actions).toContain('auth.user_created');
      expect(actions).toContain('account.connect');
      expect(actions).toContain('post.publish');
      expect(JSON.stringify(res.body)).not.toMatch(/password|token|credentials/i);
    });
  });

  describe('analytics', () => {
    it('only reports data the app really holds and marks unavailable metrics', async () => {
      const res = await agent.get('/api/analytics/overview?days=7');
      expect(res.status).toBe(200);
      const mock = res.body.platformMetrics.find((p) => p.platform === 'mock');
      expect(mock.availableMetrics).toEqual([]);
      expect(res.body.publishing.some((r) => r.status === 'published')).toBe(true);
    });

    it('says why metrics are unavailable instead of returning zeros', async () => {
      const posts = await agent.get('/api/posts?status=published&limit=1');
      const targetId = posts.body.items[0].targets[0].id;
      const res = await agent.get(`/api/analytics/targets/${targetId}/metrics`);
      expect(res.body.available).toBe(false);
      expect(res.body.reason).toBeTruthy();
      expect(res.body).not.toHaveProperty('metrics');
    });
  });
});

describe('media', () => {
  let mediaId;

  it('accepts a valid image and records metadata', async () => {
    const res = await agent.post('/api/media').set('x-csrf-token', csrf).attach('file', tinyPng(640, 480), { filename: 'photo.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.media).toMatchObject({ mimeType: 'image/png', kind: 'image', width: 640, height: 480 });
    expect(res.body.media.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.media.storageKey).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    mediaId = res.body.media.id;
  });

  it('decides the type from file content, not the filename or declared type', async () => {
    const res = await agent.post('/api/media').set('x-csrf-token', csrf).attach('file', Buffer.from('<?php echo 1; ?> not an image at all, just text'), { filename: 'evil.png', contentType: 'image/png' });
    expect(res.status).toBe(415);
    const svg = await agent.post('/api/media').set('x-csrf-token', csrf).attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { filename: 'x.svg', contentType: 'image/svg+xml' });
    expect(svg.status).toBe(415);
  });

  it('enforces the configured size limit and leaves no temp files behind', async () => {
    const res = await agent.post('/api/media').set('x-csrf-token', csrf).attach('file', tinyPng(10, 10, 1.5 * 1024 * 1024), { filename: 'big.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
    expect(await ctx.storage.listTempFiles()).toHaveLength(0);
  });

  it('neutralises hostile filenames', async () => {
    const res = await agent.post('/api/media').set('x-csrf-token', csrf).attach('file', tinyPng(), { filename: '../../etc/passwd.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.media.storageKey).not.toContain('..');
    expect(res.body.media.originalName).not.toContain('/');
    await agent.delete(`/api/media/${res.body.media.id}`).set('x-csrf-token', csrf);
  });

  it('serves files only to the authenticated owner, with safe headers', async () => {
    const ok = await agent.get(`/api/media/${mediaId}/file`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/image\/png/);
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect((await request(app).get(`/api/media/${mediaId}/file`)).status).toBe(401);
  });

  it("does not let another user read or delete someone else's media", async () => {
    const other = await User.create({ email: 'other@example.com', passwordHash: 'x', role: 'member' });
    const { rawToken } = await (async () => {
      const { Session } = await import('@osh/server-core');
      const { randomToken, sha256Hex } = await import('@osh/server-core');
      const raw = randomToken(32);
      await Session.create({ tokenHash: sha256Hex(raw), userId: other._id, csrfToken: 'csrf-other', expiresAt: new Date(Date.now() + 3_600_000) });
      return { rawToken: raw };
    })();
    const get = await request(app).get(`/api/media/${mediaId}`).set('Cookie', `osh_session=${rawToken}`);
    expect(get.status).toBe(404);
    const del = await request(app).delete(`/api/media/${mediaId}`).set('Cookie', `osh_session=${rawToken}`).set('x-csrf-token', 'csrf-other');
    expect(del.status).toBe(404);
    const list = await request(app).get('/api/media').set('Cookie', `osh_session=${rawToken}`);
    expect(list.body.total).toBe(0);
  });

  it('refuses to delete media that is attached to a post, and deletes unused media', async () => {
    const accounts = (await agent.get('/api/accounts')).body.items;
    const created = await post('/api/posts', { text: 'with image', mediaIds: [mediaId], targets: [{ accountId: accounts[0].id }] });
    expect(created.status).toBe(201);
    const blocked = await agent.delete(`/api/media/${mediaId}`).set('x-csrf-token', csrf);
    expect(blocked.status).toBe(409);

    await agent.delete(`/api/posts/${created.body.post.id}`).set('x-csrf-token', csrf);
    const ok = await agent.delete(`/api/media/${mediaId}`).set('x-csrf-token', csrf);
    expect(ok.status).toBe(204);
    expect((await agent.get(`/api/media/${mediaId}`)).status).toBe(404);
  });

  it('reports storage usage', async () => {
    const res = await agent.get('/api/media/usage');
    expect(res.body).toHaveProperty('totalBytes');
    expect(res.body.limits.maxImageBytes).toBe(1024 * 1024);
  });
});

describe('error handling and logging', () => {
  it('returns the standard error envelope for unknown routes and bad JSON', async () => {
    const nf = await agent.get('/api/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('not_found');
    const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{not json');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_json');
  });

  it('sets security headers and echoes request ids', async () => {
    const res = await request(app).get('/api/health').set('x-request-id', 'trace-1234567890');
    expect(res.headers['x-request-id']).toBe('trace-1234567890');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('does not allow CORS from unknown origins', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never writes passwords, session tokens or the setup token to the log', () => {
    const logs = ctx.logText();
    expect(logs).not.toContain(PASSWORD);
    expect(logs).not.toMatch(/osh_session=[A-Za-z0-9_-]{20,}/);
    expect(logs).not.toMatch(/"authorization"/i);
    expect(ownerId).toBeTruthy();
  });
});
