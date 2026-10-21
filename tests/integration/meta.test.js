import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { signMediaToken, verifyMediaToken } from '@osh/shared/media-token';
import { SocialAccount } from '@osh/server-core';
import { createApp } from '../../apps/api/src/app.js';
import { createTestContext, drainQueue } from '../helpers/context.js';

/**
 * Facebook Pages, Instagram, Threads and LinkedIn through the real application stack (HTTP API, services,
 * publishing engine, encrypted storage) with only the outbound HTTP faked. Nothing here talks to a real platform.
 */

const PW = 'correct horse battery staple';
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const calls = [];
const routes = {};
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const method = init.method ?? 'GET';
  const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body;
  const call = { method, host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers: init.headers };
  calls.push(call);
  const handler = routes[`${method} ${u.host}${u.pathname}`];
  return handler ? handler(call) : json({ error: { code: 100, message: `unexpected ${method} ${u.host}${u.pathname}` } }, { status: 404 });
}
const G = 'graph.facebook.com/v26.0';
const T = 'graph.threads.com';

function jpegBytes() {
  const b = Buffer.alloc(64);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]).copy(b);
  return b;
}

let ctx;
let app;
let agent;
let csrf;

const post = (url, body) => agent.post(url).set('x-csrf-token', csrf).send(body);
const put = (url, body) => agent.put(url).set('x-csrf-token', csrf).send(body);

async function connect(platform, query = '') {
  const start = await agent.get(`/api/accounts/${platform}/connect${query}`);
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const authUrl = new URL(start.body.authorizationUrl);
  return { authUrl, state: authUrl.searchParams.get('state') };
}

beforeAll(async () => {
  ctx = await createTestContext({
    adapterDeps: { fetch: fakeFetch },
    env: {
      META_APP_ID: 'META_APP',
      META_APP_SECRET: 'META_SECRET_VALUE',
      THREADS_APP_ID: 'TH_APP',
      THREADS_APP_SECRET: 'TH_SECRET_VALUE',
      LINKEDIN_CLIENT_ID: 'LI_ID',
      LINKEDIN_CLIENT_SECRET: 'LI_SECRET_VALUE',
      OAUTH_REDIRECT_BASE_URL: 'http://localhost:8080',
      MEDIA_SIGNING_KEY: 'ab'.repeat(32),
    },
  });
  app = createApp(ctx, { rateLimits: { loginPerAccount: 50, loginPerIp: 50 } });
  agent = request.agent(app);
  await ctx.services.auth.createUser({ email: 'owner@example.com', password: PW, role: 'owner', isOwner: true });
  const login = await agent.post('/api/auth/login').send({ email: 'owner@example.com', password: PW });
  csrf = login.body.csrfToken;

  Object.assign(routes, {
    [`GET ${G}/oauth/access_token`]: ({ query }) => (query.code ? json({ access_token: 'SHORT_USER' }) : json({ access_token: 'LONG_USER' })),
    [`GET ${G}/me/permissions`]: () => json({ data: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'].map((permission) => ({ permission, status: 'granted' })) }),
    [`GET ${G}/me/accounts`]: () => json({ data: [{ id: 'P1', name: 'Acme Page', access_token: 'PAGE_TOKEN_SECRET', tasks: ['CREATE_CONTENT'], instagram_business_account: { id: 'IG1', username: 'acme' } }] }),
    [`GET ${G}/debug_token`]: () => json({ data: { expires_at: 0, data_access_expires_at: Math.floor(Date.now() / 1000) + 80 * 86400 } }),
    [`POST ${G}/P1/feed`]: () => json({ id: 'P1_555' }),
    [`POST ${G}/IG1/media`]: () => json({ id: 'CONTAINER1' }),
    [`GET ${G}/CONTAINER1`]: () => json({ status_code: 'FINISHED' }),
    [`POST ${G}/IG1/media_publish`]: () => json({ id: 'IGMEDIA1' }),
    [`GET ${G}/IGMEDIA1`]: () => json({ permalink: 'https://www.instagram.com/p/xyz/' }),
    'GET media.example.net/healthz': () => new Response('ok\n', { headers: { 'x-socialdeck-gateway': '1' } }),
    [`POST ${T}/oauth/access_token`]: () => json({ access_token: 'SHORT_TH', user_id: 77 }),
    [`GET ${T}/access_token`]: () => json({ access_token: 'LONG_TH_SECRET', expires_in: 5_184_000 }),
    [`GET ${T}/v1.0/me`]: () => json({ id: '77', username: 'acme_threads', name: 'Acme' }),
    [`GET ${T}/refresh_access_token`]: () => json({ access_token: 'REFRESHED_TH', expires_in: 5_184_000 }),
    'POST www.linkedin.com/oauth/v2/accessToken': () => json({ access_token: 'LI_TOKEN_SECRET', expires_in: 5_184_000, scope: 'openid,profile,w_member_social' }),
    'GET api.linkedin.com/v2/userinfo': () => json({ sub: 'liuser1', name: 'Jane Doe' }),
    'POST api.linkedin.com/rest/posts': () => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:42' } }),
  });
});
afterAll(async () => ctx.close());

describe('platform availability', () => {
  it('reports configured platforms as enabled, and X as a paid, disabled option', async () => {
    const byId = Object.fromEntries((await agent.get('/api/platforms')).body.items.map((p) => [p.id, p]));
    for (const id of ['facebook', 'instagram', 'threads', 'linkedin']) expect(byId[id], id).toMatchObject({ implemented: true, configured: true, enabled: true });
    expect(byId.x).toMatchObject({ enabled: false, implemented: false, maturity: 'paid' });
    expect(byId.linkedin.capabilities.notes.join(' ')).toMatch(/personal profile/i);
    expect(byId.facebook.capabilities.redirectBase).toBe('oauth');
  });
});

describe('Meta login (Facebook Pages + Instagram)', () => {
  it('sends Meta the localhost redirect URI, and Instagram reuses the Facebook callback', async () => {
    const fb = await connect('facebook');
    expect(fb.authUrl.host).toBe('www.facebook.com');
    expect(fb.authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:8080/api/accounts/facebook/callback');
    const ig = await connect('instagram');
    expect(ig.authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:8080/api/accounts/facebook/callback');
    expect(ig.authUrl.searchParams.get('scope')).toContain('instagram_content_publish');
  });

  it('completes the callback from the single-use state alone (no session cookie on the other origin) and stores tokens encrypted', async () => {
    const { state } = await connect('facebook');
    const cb = await request(app).get(`/api/accounts/facebook/callback?code=CODE&state=${state}`); // no cookie
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain('/accounts?connected=facebook&count=1');

    const list = (await agent.get('/api/accounts')).body.items.filter((a) => a.platform === 'facebook');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ displayName: 'Acme Page', status: 'active' });
    expect(list[0].tokenExpiresAt).toBeTruthy();
    expect(JSON.stringify(list)).not.toMatch(/PAGE_TOKEN_SECRET|credentials/);

    const stored = await SocialAccount.findOne({ platform: 'facebook' }).select('+credentials');
    expect(stored.credentials).not.toContain('PAGE_TOKEN_SECRET');
    expect(ctx.cipher.decryptJson(stored.credentials, 'social-account-credentials')).toMatchObject({ pageId: 'P1', accessToken: 'PAGE_TOKEN_SECRET' });

    // the state is single use
    const replay = await request(app).get(`/api/accounts/facebook/callback?code=CODE&state=${state}`);
    expect(replay.headers.location).toMatch(/error=/);
  });

  it('turns the linked Instagram professional account into an Instagram account via the same callback', async () => {
    const { state } = await connect('instagram');
    const cb = await request(app).get(`/api/accounts/facebook/callback?code=CODE&state=${state}`);
    expect(cb.headers.location).toContain('connected=instagram');
    const ig = (await agent.get('/api/accounts')).body.items.find((a) => a.platform === 'instagram');
    expect(ig).toMatchObject({ displayName: 'acme', handle: '@acme' });
  });

  it('rejects forged or unknown state values', async () => {
    const res = await request(app).get('/api/accounts/facebook/callback?code=CODE&state=forged');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=session_expired');
  });
});

describe('Facebook Pages publishing through the engine', () => {
  it('publishes to the Page and records the result and link; the token never reaches the log', async () => {
    const fb = (await agent.get('/api/accounts')).body.items.find((a) => a.platform === 'facebook');
    const created = await post('/api/posts', { text: 'Hello Facebook', targets: [{ accountId: fb.id }] });
    expect((await post(`/api/posts/${created.body.post.id}/publish`, {})).status).toBe(202);
    await drainQueue(ctx);
    const done = (await agent.get(`/api/posts/${created.body.post.id}`)).body.post;
    expect(done.status).toBe('published');
    expect(done.targets[0]).toMatchObject({ status: 'published', remoteId: 'P1_555', remoteUrl: 'https://www.facebook.com/P1_555' });
    const call = calls.find((c) => c.path.endsWith('/P1/feed'));
    expect(call.body).toMatchObject({ message: 'Hello Facebook', access_token: 'PAGE_TOKEN_SECRET' });
    expect(ctx.logText()).not.toMatch(/PAGE_TOKEN_SECRET|META_SECRET_VALUE/);
  });

  it('marks the account for reconnection when Meta says the token is no longer valid', async () => {
    const fb = (await agent.get('/api/accounts')).body.items.find((a) => a.platform === 'facebook');
    const original = routes[`POST ${G}/P1/feed`];
    routes[`POST ${G}/P1/feed`] = () => json({ error: { code: 190, message: 'Error validating access token' } }, { status: 400 });
    try {
      const created = await post('/api/posts', { text: 'Will fail auth', targets: [{ accountId: fb.id }] });
      await post(`/api/posts/${created.body.post.id}/publish`, {});
      await drainQueue(ctx);
      const done = (await agent.get(`/api/posts/${created.body.post.id}`)).body.post;
      expect(done.targets[0].status).toBe('needs_reauthorization');
      expect((await agent.get(`/api/accounts/${fb.id}`)).body.account.status).toBe('needs_reauthorization');
    } finally {
      routes[`POST ${G}/P1/feed`] = original;
      await SocialAccount.updateOne({ platform: 'facebook' }, { status: 'active', statusReason: null });
    }
  });
});

describe('public media address and Instagram', () => {
  let mediaId;
  let igId;

  it('refuses unsafe public addresses', async () => {
    for (const baseUrl of ['http://media.example.net', 'https://127.0.0.1:4100', 'https://localhost', 'not a url', 'https://user:pw@media.example.net']) {
      const res = await put('/api/settings/public-media', { baseUrl });
      expect(res.status, baseUrl).toBe(400);
    }
  });

  it('blocks Instagram posts with a clear message until a public address exists, then explains how to fix it', async () => {
    igId = (await agent.get('/api/accounts')).body.items.find((a) => a.platform === 'instagram').id;
    const up = await agent.post('/api/media').set('x-csrf-token', csrf).attach('file', jpegBytes(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(up.status).toBe(201);
    mediaId = up.body.media.id;

    const created = await post('/api/posts', { text: 'ig post', mediaIds: [mediaId], targets: [{ accountId: igId }] });
    const blocked = await post(`/api/posts/${created.body.post.id}/publish`, {});
    expect(blocked.status).toBe(422);
    const issue = blocked.body.error.details.targets[0].issues.find((i) => i.code === 'public_media_not_configured');
    expect(issue.message).toMatch(/Public media address|post manually/i);
    expect(calls.some((c) => c.path.includes('/IG1/media'))).toBe(false);
  });

  it('tests the address from the server, then accepts it', async () => {
    const test = await post('/api/settings/public-media/test', { baseUrl: 'https://media.example.net' });
    expect(test.body).toMatchObject({ reachable: true });
    const notGateway = routes['GET media.example.net/healthz'];
    routes['GET media.example.net/healthz'] = () => new Response('<html>dashboard</html>', { status: 200 });
    expect((await post('/api/settings/public-media/test', { baseUrl: 'https://media.example.net' })).body).toMatchObject({ reachable: false });
    routes['GET media.example.net/healthz'] = notGateway;

    const saved = await put('/api/settings/public-media', { baseUrl: 'https://media.example.net/' });
    expect(saved.body.baseUrl).toBe('https://media.example.net');
    expect((await agent.get('/api/settings/public-media')).body.baseUrl).toBe('https://media.example.net');
  });

  it('publishes to Instagram using a signed gateway link for exactly that file', async () => {
    const created = await post('/api/posts', { text: 'ig with media #test', mediaIds: [mediaId], targets: [{ accountId: igId }] });
    expect((await post(`/api/posts/${created.body.post.id}/publish`, {})).status).toBe(202);
    await drainQueue(ctx);
    const done = (await agent.get(`/api/posts/${created.body.post.id}`)).body.post;
    expect(done.targets[0]).toMatchObject({ status: 'published', remoteId: 'IGMEDIA1', remoteUrl: 'https://www.instagram.com/p/xyz/' });

    const container = calls.find((c) => c.path.endsWith('/IG1/media') && c.method === 'POST');
    expect(container.body.image_url).toMatch(/^https:\/\/media\.example\.net\/m\//);
    const token = container.body.image_url.split('/m/')[1];
    const media = (await agent.get(`/api/media/${mediaId}`)).body.media;
    const claims = verifyMediaToken({ key: Buffer.from('ab'.repeat(32), 'hex'), token });
    expect(claims).toMatchObject({ storageKey: media.storageKey, mimeType: 'image/jpeg' });
    // the link is short lived
    expect(claims.expiresAtSeconds - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(1800);
    expect(verifyMediaToken({ key: Buffer.from('cd'.repeat(32), 'hex'), token })).toBeNull();
    expect(signMediaToken).toBeTypeOf('function');
  });

  it('can clear the address again', async () => {
    const cleared = await put('/api/settings/public-media', { baseUrl: null });
    expect(cleared.body.baseUrl).toBeNull();
  });
});

describe('Threads', () => {
  it('connects with its own app credentials and stores the long-lived token with its expiry', async () => {
    const { authUrl, state } = await connect('threads');
    expect(authUrl.host).toBe('threads.com');
    expect(authUrl.searchParams.get('client_id')).toBe('TH_APP');
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:8080/api/accounts/threads/callback');
    const cb = await request(app).get(`/api/accounts/threads/callback?code=TC&state=${state}`);
    expect(cb.headers.location).toContain('connected=threads');
    const acct = (await agent.get('/api/accounts')).body.items.find((a) => a.platform === 'threads');
    expect(acct).toMatchObject({ displayName: 'Acme', handle: '@acme_threads' });
    expect(new Date(acct.tokenExpiresAt).getTime()).toBeGreaterThan(Date.now() + 59 * 86400_000);
    expect(JSON.stringify(acct)).not.toContain('LONG_TH_SECRET');
  });

  it('publishes text without any public media address', async () => {
    routes[`POST ${T}/v1.0/77/threads`] = () => json({ id: 'TC1' });
    routes[`GET ${T}/v1.0/TC1`] = () => json({ status: 'FINISHED' });
    routes[`POST ${T}/v1.0/77/threads_publish`] = () => json({ id: 'TP1' });
    routes[`GET ${T}/v1.0/TP1`] = () => json({ permalink: 'https://www.threads.com/@acme_threads/post/1' });
    const acct = (await agent.get('/api/accounts')).body.items.find((a) => a.platform === 'threads');
    const created = await post('/api/posts', { text: 'hello threads', targets: [{ accountId: acct.id }] });
    await post(`/api/posts/${created.body.post.id}/publish`, {});
    await drainQueue(ctx);
    const done = (await agent.get(`/api/posts/${created.body.post.id}`)).body.post;
    expect(done.targets[0]).toMatchObject({ status: 'published', remoteId: 'TP1' });
  });

  it('refreshes tokens that are close to expiry (daily sweep) and leaves healthy ones alone', async () => {
    const acct = await SocialAccount.findOne({ platform: 'threads' });
    await SocialAccount.updateOne({ _id: acct._id }, { tokenExpiresAt: new Date(Date.now() + 5 * 86400_000) });
    const summary = await ctx.services.accounts.refreshExpiring();
    expect(summary.refreshed).toBe(1);
    const after = await ctx.services.accounts.getWithCredentials(acct._id);
    expect(after.credentials.accessToken).toBe('REFRESHED_TH');
    expect(after.account.tokenExpiresAt.getTime()).toBeGreaterThan(Date.now() + 59 * 86400_000);
    expect((await ctx.services.accounts.refreshExpiring()).refreshed).toBe(0);
  });

  it('flags the account for reconnection when the token can no longer be refreshed', async () => {
    const acct = await SocialAccount.findOne({ platform: 'threads' });
    await SocialAccount.updateOne({ _id: acct._id }, { tokenExpiresAt: new Date(Date.now() + 2 * 86400_000) });
    const original = routes[`GET ${T}/refresh_access_token`];
    routes[`GET ${T}/refresh_access_token`] = () => json({ error: { code: 190, message: 'expired' } }, { status: 400 });
    try {
      expect((await ctx.services.accounts.refreshExpiring()).reauthorize).toBe(1);
      expect((await SocialAccount.findById(acct._id)).status).toBe('needs_reauthorization');
    } finally {
      routes[`GET ${T}/refresh_access_token`] = original;
    }
  });
});

describe('LinkedIn (personal profile)', () => {
  it('connects, shows the 60-day expiry, and publishes', async () => {
    const { authUrl, state } = await connect('linkedin');
    expect(authUrl.searchParams.get('scope')).toBe('openid profile w_member_social');
    const cb = await request(app).get(`/api/accounts/linkedin/callback?code=LC&state=${state}`);
    expect(cb.headers.location).toContain('connected=linkedin');
    const acct = (await agent.get('/api/accounts')).body.items.find((a) => a.platform === 'linkedin');
    expect(acct).toMatchObject({ displayName: 'Jane Doe' });
    expect(new Date(acct.tokenExpiresAt).getTime()).toBeGreaterThan(Date.now() + 59 * 86400_000);

    const created = await post('/api/posts', { text: 'Hello LinkedIn (team)', targets: [{ accountId: acct.id }] });
    await post(`/api/posts/${created.body.post.id}/publish`, {});
    await drainQueue(ctx);
    const done = (await agent.get(`/api/posts/${created.body.post.id}`)).body.post;
    expect(done.targets[0]).toMatchObject({ status: 'published', remoteId: 'urn:li:share:42' });
    const call = calls.find((c) => c.path === '/rest/posts');
    expect(JSON.parse(call.body)).toMatchObject({ author: 'urn:li:person:liuser1', commentary: 'Hello LinkedIn \\(team\\)' });
    expect(ctx.logText()).not.toMatch(/LI_TOKEN_SECRET|LI_SECRET_VALUE/);
  });
});

describe('X stays disabled', () => {
  it('cannot be connected or published to', async () => {
    const res = await agent.get('/api/accounts/x/connect');
    expect(res.status).toBe(501);
    expect(calls.some((c) => c.host.includes('x.com') || c.host.includes('twitter'))).toBe(false);
  });
});
