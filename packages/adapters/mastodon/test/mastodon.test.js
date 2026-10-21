import { beforeEach, describe, expect, it } from 'vitest';
import { MastodonAdapter } from '../src/index.js';

/** In-memory encrypted-KV stand-in. */
function memoryKv() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, structuredClone(v)), delete: async (k) => void m.delete(k) };
}

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

/** Route table keyed by "METHOD path"; records every call. */
function fakeServer(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? 'GET'} ${u.pathname}`;
    const handler = routes[key];
    calls.push({ key, url: u, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    if (!handler) return json({ error: `no route ${key}` }, { status: 404 });
    const r = await handler({ url: u, init, calls });
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

const INSTANCE = {
  version: '4.3.1',
  configuration: {
    statuses: { max_characters: 500, max_media_attachments: 4, characters_reserved_per_url: 23 },
    media_attachments: { image_size_limit: 10_000_000, video_size_limit: 40_000_000, supported_mime_types: ['image/jpeg', 'image/png', 'video/mp4'] },
  },
};

function make(routes, { appName = 'Test Manager' } = {}) {
  const server = fakeServer({ 'GET /api/v2/instance': () => json(INSTANCE), ...routes });
  const kv = memoryKv();
  const adapter = new MastodonAdapter({ fetch: server.fetch, kv, logger: { warn() {}, info() {} }, config: { appName, mediaPollIntervalMs: 1 } });
  return { adapter, kv, ...server };
}

const REDIRECT = 'http://127.0.0.1:5173/api/accounts/mastodon/callback';

describe('mastodon authorization', () => {
  let t;
  beforeEach(() => {
    t = make({
      'POST /api/v1/apps': () => json({ client_id: 'cid', client_secret: 'csecret' }),
      'POST /oauth/token': () => json({ access_token: 'tok-123', scope: 'profile write:statuses write:media', token_type: 'Bearer' }),
      'GET /api/v1/accounts/verify_credentials': () => json({ username: 'Alice', display_name: 'Alice A', avatar: 'https://m.example/a.png' }),
    });
  });

  it('registers an app per instance, requests minimal scopes and uses PKCE + state', async () => {
    const { authorizationUrl } = await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT, input: { instance: 'm.example' } });
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://m.example/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('profile write:statuses write:media');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toHaveLength(43);
    expect(url.searchParams.get('client_id')).toBe('cid');

    const reg = t.calls.find((c) => c.key === 'POST /api/v1/apps');
    expect(reg.body).toMatchObject({ client_name: 'Test Manager', redirect_uris: REDIRECT, scopes: 'profile write:statuses write:media' });
  });

  it('reuses the registered app for later connections to the same instance', async () => {
    await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT, input: { instance: 'm.example' } });
    await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT, input: { instance: 'm.example' } });
    expect(t.calls.filter((c) => c.key === 'POST /api/v1/apps')).toHaveLength(1);
  });

  it('falls back to read:accounts on servers older than 4.3', async () => {
    const old = make({
      'GET /api/v2/instance': () => json({ ...INSTANCE, version: '4.2.8' }),
      'POST /api/v1/apps': () => json({ client_id: 'c', client_secret: 's' }),
    });
    const { authorizationUrl } = await old.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT, input: { instance: 'old.example' } });
    expect(new URL(authorizationUrl).searchParams.get('scope')).toBe('read:accounts write:statuses write:media');
  });

  it('exchanges the code, verifies the account and returns identity + credentials', async () => {
    const { authorizationUrl } = await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT, input: { instance: 'm.example' } });
    const state = new URL(authorizationUrl).searchParams.get('state');
    const result = await t.adapter.completeAuthorization({ ownerId: 'u1', redirectUri: REDIRECT, query: new URLSearchParams({ code: 'abc', state }) });
    expect(result.identity).toMatchObject({ externalId: 'alice@m.example', displayName: 'Alice A', instance: 'm.example', handle: '@Alice@m.example' });
    expect(result.credentials).toMatchObject({ accessToken: 'tok-123', instance: 'm.example', clientId: 'cid' });
    expect(result.scopes).toEqual(['profile', 'write:statuses', 'write:media']);
    const exchange = t.calls.find((c) => c.key === 'POST /oauth/token');
    expect(exchange.body).toMatchObject({ grant_type: 'authorization_code', code: 'abc', redirect_uri: REDIRECT });
    expect(exchange.body.code_verifier).toBeTruthy();
  });

  it('rejects replayed, unknown and foreign state values', async () => {
    const { authorizationUrl } = await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT, input: { instance: 'm.example' } });
    const state = new URL(authorizationUrl).searchParams.get('state');
    const q = new URLSearchParams({ code: 'abc', state });
    await expect(t.adapter.completeAuthorization({ ownerId: 'u2', redirectUri: REDIRECT, query: q })).rejects.toMatchObject({ code: 'invalid_state' });
    // state is single-use: even the rightful owner cannot replay it afterwards
    await expect(t.adapter.completeAuthorization({ ownerId: 'u1', redirectUri: REDIRECT, query: q })).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(t.adapter.completeAuthorization({ ownerId: 'u1', redirectUri: REDIRECT, query: new URLSearchParams({ code: 'abc', state: 'bogus' }) })).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('reports a declined authorization clearly', async () => {
    await expect(t.adapter.completeAuthorization({ ownerId: 'u1', redirectUri: REDIRECT, query: new URLSearchParams({ error: 'access_denied' }) })).rejects.toThrow(/declined/);
  });

  it('rejects servers that are not Mastodon-compatible or unreachable', async () => {
    const notMastodon = make({ 'GET /api/v2/instance': () => json({ hello: 'world' }) });
    await expect(notMastodon.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT, input: { instance: 'blog.example' } })).rejects.toMatchObject({ code: 'not_mastodon' });
    const down = make({ 'GET /api/v2/instance': () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) });
    await expect(down.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT, input: { instance: 'nope.example' } })).rejects.toMatchObject({ code: 'instance_unreachable' });
    await expect(t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT, input: {} })).rejects.toMatchObject({ code: 'instance_required' });
  });
});

describe('mastodon publishing', () => {
  const creds = { instance: 'm.example', accessToken: 'tok-123', clientId: 'cid', clientSecret: 'csecret' };
  const blobOf = (bytes = 'img') => async () => new Blob([bytes], { type: 'image/png' });

  it('publishes text with an idempotency key and bearer token', async () => {
    const t = make({ 'POST /api/v1/statuses': () => json({ id: '110', url: 'https://m.example/@a/110', visibility: 'public' }) });
    const res = await t.adapter.publish({ credentials: creds, content: { text: 'hello', media: [] }, idempotencyKey: 'osh-1', markSending: async () => {} });
    expect(res).toMatchObject({ remoteId: '110', url: 'https://m.example/@a/110' });
    const call = t.calls.find((c) => c.key === 'POST /api/v1/statuses');
    expect(call.init.headers['Idempotency-Key']).toBe('osh-1');
    expect(call.init.headers.authorization).toBe('Bearer tok-123');
    expect(call.body).toEqual({ status: 'hello', visibility: 'public' });
  });

  it('calls markSending only after media uploads, immediately before the creating request', async () => {
    const order = [];
    const t = make({
      'POST /api/v2/media': () => (order.push('upload'), json({ id: 'm1', url: 'https://cdn/x.png' })),
      'POST /api/v1/statuses': () => (order.push('status'), json({ id: '1', url: 'u' })),
    });
    await t.adapter.publish({
      credentials: creds,
      content: { text: 'pic', media: [{ id: 'a', kind: 'image', mimeType: 'image/png', size: 3, altText: 'a cat', blob: blobOf() }] },
      idempotencyKey: 'k',
      markSending: async () => void order.push('sending'),
    });
    expect(order).toEqual(['upload', 'sending', 'status']);
    const up = t.calls.find((c) => c.key === 'POST /api/v2/media');
    expect(up.body.get('description')).toBe('a cat');
    expect(t.calls.find((c) => c.key === 'POST /api/v1/statuses').body.media_ids).toEqual(['m1']);
  });

  it('polls asynchronously processed media until ready', async () => {
    let polls = 0;
    const t = make({
      'POST /api/v2/media': () => json({ id: 'v1', url: null }, { status: 202 }),
      'GET /api/v1/media/v1': () => (++polls < 3 ? json({ id: 'v1', url: null }, { status: 206 }) : json({ id: 'v1', url: 'https://cdn/v.mp4' })),
      'POST /api/v1/statuses': () => json({ id: '2', url: 'u' }),
    });
    await t.adapter.publish({
      credentials: creds,
      content: { text: 'video', media: [{ id: 'a', kind: 'video', mimeType: 'video/mp4', size: 3, blob: async () => new Blob(['v']) }] },
      idempotencyKey: 'k2',
    });
    expect(polls).toBe(3);
  });

  describe('error classification', () => {
    const publish = (route) => {
      const t = make({ 'POST /api/v1/statuses': route });
      return t.adapter.publish({ credentials: creds, content: { text: 'x', media: [] }, idempotencyKey: 'k' });
    };
    it('401 -> auth (needs reauthorization)', async () => {
      await expect(publish(() => json({ error: 'The access token is invalid' }, { status: 401 }))).rejects.toMatchObject({ kind: 'auth' });
    });
    it('422 -> permanent, surfacing the server message', async () => {
      await expect(publish(() => json({ error: 'Validation failed: Text character limit of 500 exceeded' }, { status: 422 }))).rejects.toMatchObject({ kind: 'permanent', message: expect.stringContaining('character limit') });
    });
    it('429 -> rate_limited with Retry-After', async () => {
      await expect(publish(() => json({ error: 'Too many requests' }, { status: 429, headers: { 'retry-after': '42' } }))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 42_000 });
    });
    it('5xx -> transient, because the request carries an Idempotency-Key', async () => {
      await expect(publish(() => json({ error: 'boom' }, { status: 503 }))).rejects.toMatchObject({ kind: 'transient' });
    });
    it('connection reset after sending -> transient (idempotent), connection refused -> transient', async () => {
      await expect(publish(() => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).rejects.toMatchObject({ kind: 'transient' });
      await expect(publish(() => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).rejects.toMatchObject({ kind: 'transient' });
    });
    it('redirects are reported, not followed', async () => {
      await expect(publish(() => new Response(null, { status: 302, headers: { location: 'https://other.example/api/v1/statuses' } }))).rejects.toMatchObject({ code: 'redirected', kind: 'permanent' });
    });
    it('never leaks the token into error messages', async () => {
      const err = await publish(() => json({ error: 'nope' }, { status: 500 })).catch((e) => e);
      expect(`${err.message} ${JSON.stringify(err.code)}`).not.toContain('tok-123');
    });
  });

  it('declares idempotent publishing', () => {
    expect(make({}).adapter.capabilities.idempotentPublish).toBe(true);
  });
});

describe('mastodon validation and misc', () => {
  const acct = { instance: 'm.example', id: 'a1' };
  it('uses limits advertised by the instance', async () => {
    const t = make({
      'GET /api/v2/instance': () => json({ ...INSTANCE, configuration: { ...INSTANCE.configuration, statuses: { max_characters: 100, max_media_attachments: 1, characters_reserved_per_url: 23 } } }),
    });
    const issues = await t.adapter.validateContent({ text: 'x'.repeat(101), media: [] }, { account: acct });
    expect(issues.map((i) => i.code)).toContain('text_too_long');
    const media = await t.adapter.validateContent(
      { text: 'ok', media: [{ kind: 'image', mimeType: 'image/png', size: 10 }, { kind: 'image', mimeType: 'image/png', size: 10 }] },
      { account: acct },
    );
    expect(media.map((i) => i.code)).toContain('too_many_media');
  });

  it('counts URLs as 23 characters', async () => {
    const t = make({});
    const url = 'https://example.com/' + 'a'.repeat(300);
    const issues = await t.adapter.validateContent({ text: `read ${url}`, media: [] }, { account: acct });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('rejects mixing images and video, and unsupported types', async () => {
    const t = make({});
    const issues = await t.adapter.validateContent(
      { text: 'x', media: [{ kind: 'image', mimeType: 'image/png', size: 1 }, { kind: 'video', mimeType: 'video/mp4', size: 1 }] },
      { account: acct },
    );
    expect(issues.map((i) => i.code)).toContain('mixed_media');
    const gif = await t.adapter.validateContent({ text: 'x', media: [{ kind: 'image', mimeType: 'image/gif', size: 1 }] }, { account: acct });
    expect(gif.map((i) => i.code)).toContain('unsupported_media_type'); // instance did not advertise gif
  });

  it('schedules natively only 5+ minutes ahead', async () => {
    const t = make({ 'POST /api/v1/statuses': () => json({ id: 's1', scheduled_at: 'x' }) });
    const creds = { instance: 'm.example', accessToken: 't' };
    await expect(t.adapter.scheduleNative({ credentials: creds, content: { text: 'x', media: [] }, idempotencyKey: 'k', scheduledAt: new Date(Date.now() + 60_000) })).rejects.toMatchObject({ code: 'schedule_too_soon' });
    const ok = await t.adapter.scheduleNative({ credentials: creds, content: { text: 'x', media: [] }, idempotencyKey: 'k', scheduledAt: new Date(Date.now() + 600_000) });
    expect(ok.remoteId).toBe('s1');
    expect(t.calls.at(-1).body.scheduled_at).toMatch(/Z$/);
  });

  it('revokes the token on disconnect and tolerates failures', async () => {
    const t = make({ 'POST /oauth/revoke': () => json({}) });
    await t.adapter.revoke({ credentials: { instance: 'm.example', accessToken: 't', clientId: 'c', clientSecret: 's' } });
    expect(t.calls.at(-1).body).toMatchObject({ token: 't', client_id: 'c' });
    const failing = make({ 'POST /oauth/revoke': () => json({}, { status: 500 }) });
    await expect(failing.adapter.revoke({ credentials: { instance: 'm.example', accessToken: 't', clientId: 'c', clientSecret: 's' } })).resolves.toBeUndefined();
  });

  it('fetches post metrics from the official status endpoint', async () => {
    const t = make({ 'GET /api/v1/statuses/110': () => json({ favourites_count: 3, reblogs_count: 1, replies_count: 0 }) });
    expect(await t.adapter.fetchPostMetrics({ credentials: { instance: 'm.example', accessToken: 't' }, remoteId: '110' })).toEqual({ favourites: 3, reblogs: 1, replies: 0 });
  });
});
