import { describe, expect, it } from 'vitest';
import { ThreadsAdapter, threadsLength } from '../src/index.js';

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const memoryKv = () => {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, structuredClone(v)), delete: async (k) => void m.delete(k) };
};

function fakeApi(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? 'GET'} ${u.pathname}`;
    const call = { key, url: u, init, form: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : undefined };
    calls.push(call);
    const h = routes[key];
    return h ? h(call) : json({ error: { code: 100, message: `no route ${key}` } }, { status: 404 });
  };
  return { fetch, calls };
}

function make(routes = {}, { configured = true, publicMediaConfigured = true } = {}) {
  const server = fakeApi(routes);
  const adapter = new ThreadsAdapter({
    fetch: server.fetch,
    kv: memoryKv(),
    logger: { warn() {}, info() {} },
    publicMedia: { isConfigured: async () => publicMediaConfigured },
    config: { threads: configured ? { appId: 'TAPP', appSecret: 'TSEC' } : { appId: '', appSecret: '' }, pollIntervalMs: 1, pollTimeoutMs: 200 },
  });
  return { adapter, ...server };
}

const creds = (over = {}) => ({ userId: 'U1', accessToken: 'TTOKEN', expiresAt: new Date(Date.now() + 50 * 86400_000).toISOString(), ...over });
const img = (n = 1) => ({ id: `m${n}`, kind: 'image', mimeType: 'image/jpeg', size: 10, publicUrl: `https://media.example/m/t${n}` });

describe('text length', () => {
  it('counts emoji by their UTF-8 byte size', () => {
    expect(threadsLength('abc')).toBe(3);
    expect(threadsLength('😀')).toBe(4);
    expect(threadsLength('a😀b')).toBe(6);
  });
});

describe('configuration and authorization', () => {
  it('needs the Threads app id and secret (not the main Meta app id)', () => {
    const t = make({}, { configured: false });
    expect(t.adapter.configuration).toEqual({ configured: false, missing: ['THREADS_APP_ID', 'THREADS_APP_SECRET'] });
    expect(t.adapter.enabled).toBe(false);
  });

  it('starts OAuth on threads.com with publish scopes', async () => {
    const t = make();
    const { authorizationUrl } = await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: 'http://localhost:8080/api/accounts/threads/callback' });
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://threads.com/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('threads_basic,threads_content_publish');
    expect(url.searchParams.get('client_id')).toBe('TAPP');
    expect(await t.adapter.ownerFromCallback(new URLSearchParams({ state: url.searchParams.get('state') }))).toBe('u1');
  });

  it('exchanges the code, upgrades to a 60-day token and reads the profile', async () => {
    const t = make({
      'POST /oauth/access_token': () => json({ access_token: 'SHORT', user_id: 99 }),
      'GET /access_token': () => json({ access_token: 'LONG', token_type: 'bearer', expires_in: 5_184_000 }),
      'GET /v1.0/me': () => json({ id: '99', username: 'alice', name: 'Alice', threads_profile_picture_url: 'https://cdn/a.jpg' }),
    });
    const redirect = 'http://localhost:8080/api/accounts/threads/callback';
    const state = new URL((await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: redirect })).authorizationUrl).searchParams.get('state');
    const res = await t.adapter.completeAuthorization({ ownerId: 'u1', query: new URLSearchParams({ code: 'CODE#_', state }) });

    expect(res.identity).toMatchObject({ externalId: '99', displayName: 'Alice', handle: '@alice' });
    expect(res.credentials).toMatchObject({ userId: '99', accessToken: 'LONG' });
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now() + 59 * 86400_000);
    const exchange = t.calls.find((c) => c.key === 'POST /oauth/access_token');
    expect(exchange.form).toMatchObject({ client_id: 'TAPP', client_secret: 'TSEC', code: 'CODE', grant_type: 'authorization_code', redirect_uri: redirect });
    expect(t.calls.find((c) => c.key === 'GET /access_token').url.searchParams.get('grant_type')).toBe('th_exchange_token');
  });

  it('rejects replayed state and declined authorization', async () => {
    const t = make({});
    await expect(t.adapter.completeAuthorization({ ownerId: 'u1', query: new URLSearchParams({ code: 'c', state: 'nope' }) })).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(t.adapter.completeAuthorization({ ownerId: 'u1', query: new URLSearchParams({ error: 'access_denied' }) })).rejects.toThrow(/cancelled/);
  });
});

describe('token refresh', () => {
  it('refreshes with th_refresh_token and returns the new expiry', async () => {
    const t = make({ 'GET /refresh_access_token': () => json({ access_token: 'NEW', expires_in: 5_184_000 }) });
    const res = await t.adapter.refreshCredentials({ credentials: creds() });
    expect(res.credentials.accessToken).toBe('NEW');
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now() + 59 * 86400_000);
    expect(t.calls[0].url.searchParams.get('grant_type')).toBe('th_refresh_token');
  });

  it('refreshes automatically before publishing when the token is close to expiry, and stores the new one', async () => {
    const saved = [];
    const t = make({
      'GET /refresh_access_token': () => json({ access_token: 'FRESH', expires_in: 5_184_000 }),
      'POST /v1.0/U1/threads': () => json({ id: 'C1' }),
      'GET /v1.0/C1': () => json({ status: 'FINISHED' }),
      'POST /v1.0/U1/threads_publish': () => json({ id: 'T1' }),
      'GET /v1.0/T1': () => json({ permalink: 'https://www.threads.com/@alice/post/abc' }),
    });
    const expiring = creds({ expiresAt: new Date(Date.now() + 3 * 86400_000).toISOString() });
    await t.adapter.publish({ credentials: expiring, content: { text: 'hi', media: [] }, onCredentialsUpdated: async (c, exp) => saved.push({ c, exp }) });
    expect(saved).toHaveLength(1);
    expect(saved[0].c.accessToken).toBe('FRESH');
    expect(t.calls.find((c) => c.key === 'POST /v1.0/U1/threads').form.access_token).toBe('FRESH');
  });

  it('asks for reconnection when the token is already dead', async () => {
    const t = make({ 'GET /refresh_access_token': () => json({ error: { code: 190, message: 'expired' } }, { status: 400 }) });
    await expect(t.adapter.publish({ credentials: creds({ expiresAt: new Date(Date.now() + 86400_000).toISOString() }), content: { text: 'x', media: [] }, onCredentialsUpdated: async () => {} })).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('publishing', () => {
  const okRoutes = {
    'POST /v1.0/U1/threads': () => json({ id: 'C1' }),
    'GET /v1.0/C1': () => json({ status: 'FINISHED' }),
    'POST /v1.0/U1/threads_publish': () => json({ id: 'T1' }),
    'GET /v1.0/T1': () => json({ permalink: 'https://www.threads.com/@alice/post/abc' }),
  };

  it('publishes text in two steps and attaches the first link', async () => {
    const t = make(okRoutes);
    const order = [];
    const res = await t.adapter.publish({ credentials: creds(), content: { text: 'see https://example.com now', media: [] }, markSending: async () => void order.push('sending') });
    expect(res).toEqual({ remoteId: 'T1', url: 'https://www.threads.com/@alice/post/abc' });
    expect(t.calls.find((c) => c.key === 'POST /v1.0/U1/threads').form).toMatchObject({ media_type: 'TEXT', text: 'see https://example.com now', link_attachment: 'https://example.com', access_token: 'TTOKEN' });
    expect(t.calls.map((c) => c.key).indexOf('POST /v1.0/U1/threads_publish')).toBeGreaterThan(t.calls.map((c) => c.key).indexOf('POST /v1.0/U1/threads'));
    expect(order).toEqual(['sending']);
  });

  it('publishes an image from the public address', async () => {
    const t = make(okRoutes);
    await t.adapter.publish({ credentials: creds(), content: { text: 'pic', media: [img()] } });
    expect(t.calls.find((c) => c.key === 'POST /v1.0/U1/threads').form).toMatchObject({ media_type: 'IMAGE', image_url: 'https://media.example/m/t1' });
  });

  it('publishes a video and a carousel', async () => {
    const t = make(okRoutes);
    await t.adapter.publish({ credentials: creds(), content: { text: 'clip', media: [{ id: 'v', kind: 'video', mimeType: 'video/mp4', size: 1, publicUrl: 'https://media.example/m/v' }] } });
    expect(t.calls.find((c) => c.key === 'POST /v1.0/U1/threads').form).toMatchObject({ media_type: 'VIDEO', video_url: 'https://media.example/m/v' });

    let n = 0;
    const car = make({ ...okRoutes, 'POST /v1.0/U1/threads': ({ form }) => json({ id: form.is_carousel_item ? `K${++n}` : 'C1' }), 'GET /v1.0/K1': () => json({ status: 'FINISHED' }), 'GET /v1.0/K2': () => json({ status: 'FINISHED' }) });
    await car.adapter.publish({ credentials: creds(), content: { text: 'two', media: [img(1), img(2)] } });
    const forms = car.calls.filter((c) => c.key === 'POST /v1.0/U1/threads').map((c) => c.form);
    expect(forms[2]).toMatchObject({ media_type: 'CAROUSEL', children: 'K1,K2', text: 'two' });
  });

  it('does not touch Threads when media has no public address', async () => {
    const t = make(okRoutes);
    await expect(t.adapter.publish({ credentials: creds(), content: { text: 'x', media: [{ ...img(), publicUrl: null }] } })).rejects.toMatchObject({ code: 'public_media_not_configured', kind: 'permanent' });
    expect(t.calls).toHaveLength(0);
  });

  describe('failures', () => {
    it('a container error is permanent', async () => {
      const t = make({ ...okRoutes, 'GET /v1.0/C1': () => json({ status: 'ERROR', error_message: 'Unsupported codec' }) });
      await expect(t.adapter.publish({ credentials: creds(), content: { text: 'x', media: [img()] } })).rejects.toMatchObject({ kind: 'permanent', code: 'container_error' });
    });
    it('a slow container is retry-safe and never publishes', async () => {
      const t = make({ ...okRoutes, 'GET /v1.0/C1': () => json({ status: 'IN_PROGRESS' }) });
      await expect(t.adapter.publish({ credentials: creds(), content: { text: 'x', media: [img()] } })).rejects.toMatchObject({ kind: 'transient' });
      expect(t.calls.some((c) => c.key === 'POST /v1.0/U1/threads_publish')).toBe(false);
    });
    it('a failure while publishing is ambiguous', async () => {
      const t = make({ ...okRoutes, 'POST /v1.0/U1/threads_publish': () => json({ error: { code: 2, message: 'unavailable' } }, { status: 503 }) });
      await expect(t.adapter.publish({ credentials: creds(), content: { text: 'x', media: [] } })).rejects.toMatchObject({ kind: 'ambiguous' });
    });
    it('rate limit and expired token map to the right classes', async () => {
      const limited = make({ 'POST /v1.0/U1/threads': () => json({ error: { code: 4, message: 'limit' } }, { status: 400, headers: { 'retry-after': '30' } }) });
      await expect(limited.adapter.publish({ credentials: creds(), content: { text: 'x', media: [] } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
      const dead = make({ 'POST /v1.0/U1/threads': () => json({ error: { code: 190, message: 'expired' } }, { status: 401 }) });
      await expect(dead.adapter.publish({ credentials: creds(), content: { text: 'x', media: [] } })).rejects.toMatchObject({ kind: 'auth' });
    });
  });
});

describe('validation', () => {
  it('enforces 500 (byte-weighted) characters, JPEG/PNG, and a public address for media only', async () => {
    const { adapter } = make();
    expect((await adapter.validateContent({ text: 'x'.repeat(501), media: [] })).map((i) => i.code)).toContain('text_too_long');
    expect((await adapter.validateContent({ text: '😀'.repeat(126), media: [] })).map((i) => i.code)).toContain('text_too_long'); // 126 * 4 bytes
    expect((await adapter.validateContent({ text: 'x', media: [{ kind: 'image', mimeType: 'image/gif', size: 1 }] })).map((i) => i.code)).toContain('unsupported_media_type');
    const noPublic = make({}, { publicMediaConfigured: false }).adapter;
    expect((await noPublic.validateContent({ text: 'text only', media: [] })).filter((i) => i.severity === 'error')).toEqual([]);
    expect((await noPublic.validateContent({ text: 'x', media: [{ kind: 'image', mimeType: 'image/jpeg', size: 1 }] })).map((i) => i.code)).toContain('public_media_not_configured');
  });
});
