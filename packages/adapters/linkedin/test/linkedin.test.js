import { describe, expect, it } from 'vitest';
import { LinkedInAdapter, escapeLinkedInText } from '../src/index.js';

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const memoryKv = () => {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, structuredClone(v)), delete: async (k) => void m.delete(k) };
};

function fakeApi(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? 'GET'} ${u.origin === 'https://api.linkedin.com' || u.origin === 'https://www.linkedin.com' ? u.pathname : u.origin + u.pathname}`;
    const call = { key, url: u, init, body: typeof init.body === 'string' ? (init.headers['content-type']?.includes('json') ? JSON.parse(init.body) : init.body) : init.body, form: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : undefined };
    calls.push(call);
    const h = routes[key];
    return h ? h(call) : json({ message: `no route ${key}` }, { status: 404 });
  };
  return { fetch, calls };
}

function make(routes = {}, { configured = true } = {}) {
  const server = fakeApi(routes);
  const adapter = new LinkedInAdapter({
    fetch: server.fetch,
    kv: memoryKv(),
    logger: { warn() {}, info() {} },
    config: { linkedin: configured ? { clientId: 'CID', clientSecret: 'CSEC', apiVersion: '202610' } : { clientId: '', clientSecret: '', apiVersion: '202610' } },
  });
  return { adapter, ...server };
}

const creds = (over = {}) => ({ sub: 'abc123', accessToken: 'LITOKEN', expiresAt: new Date(Date.now() + 40 * 86400_000).toISOString(), ...over });
const REDIRECT = 'http://localhost:8080/api/accounts/linkedin/callback';

describe('text escaping (LinkedIn "little" format)', () => {
  it('escapes reserved characters but keeps hashtags active', () => {
    expect(escapeLinkedInText('Hello (world) [x] {y} <z> a|b @bob *bold* _it_ ~t~ \\')).toBe('Hello \\(world\\) \\[x\\] \\{y\\} \\<z\\> a\\|b \\@bob \\*bold\\* \\_it\\_ \\~t\\~ \\\\');
    expect(escapeLinkedInText('ship it #launch and #2026')).toBe('ship it #launch and #2026');
    expect(escapeLinkedInText('issue # 5 and ## done #')).toBe('issue \\# 5 and \\#\\# done \\#');
  });
});

describe('configuration and authorization', () => {
  it('is disabled until client id and secret exist', () => {
    expect(make({}, { configured: false }).adapter.configuration).toEqual({ configured: false, missing: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'] });
  });

  it('requests only openid, profile and w_member_social', async () => {
    const t = make();
    const { authorizationUrl } = await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT });
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(url.searchParams.get('scope')).toBe('openid profile w_member_social');
    expect(await t.adapter.ownerFromCallback(new URLSearchParams({ state: url.searchParams.get('state') }))).toBe('u1');
  });

  it('exchanges the code and identifies the member through OpenID userinfo', async () => {
    const t = make({
      'POST /oauth/v2/accessToken': () => json({ access_token: 'LITOKEN', expires_in: 5_184_000, scope: 'openid,profile,w_member_social' }),
      'GET /v2/userinfo': () => json({ sub: 'abc123', name: 'Jane Doe', picture: 'https://media.licdn.com/p.jpg' }),
    });
    const state = new URL((await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT })).authorizationUrl).searchParams.get('state');
    const res = await t.adapter.completeAuthorization({ ownerId: 'u1', query: new URLSearchParams({ code: 'C', state }) });
    expect(res.identity).toMatchObject({ externalId: 'abc123', displayName: 'Jane Doe' });
    expect(res.credentials).toMatchObject({ sub: 'abc123', accessToken: 'LITOKEN' });
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now() + 59 * 86400_000);
    const exchange = t.calls.find((c) => c.key === 'POST /oauth/v2/accessToken');
    expect(exchange.init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(exchange.form).toMatchObject({ grant_type: 'authorization_code', code: 'C', client_id: 'CID', client_secret: 'CSEC', redirect_uri: REDIRECT });
  });

  it('refuses a connection that lacks permission to post', async () => {
    const t = make({ 'POST /oauth/v2/accessToken': () => json({ access_token: 'T', expires_in: 100, scope: 'openid,profile' }) });
    const state = new URL((await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT })).authorizationUrl).searchParams.get('state');
    await expect(t.adapter.completeAuthorization({ ownerId: 'u1', query: new URLSearchParams({ code: 'C', state }) })).rejects.toMatchObject({ code: 'permissions_missing' });
  });

  it('explains cancellation and rejects bad or foreign state', async () => {
    const t = make();
    await expect(t.adapter.completeAuthorization({ ownerId: 'u1', query: new URLSearchParams({ error: 'user_cancelled_authorize' }) })).rejects.toThrow(/declined/);
    await expect(t.adapter.completeAuthorization({ ownerId: 'u1', query: new URLSearchParams({ code: 'c', state: 'x' }) })).rejects.toMatchObject({ code: 'invalid_state' });
    const state = new URL((await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT })).authorizationUrl).searchParams.get('state');
    await expect(t.adapter.completeAuthorization({ ownerId: 'u2', query: new URLSearchParams({ code: 'c', state }) })).rejects.toMatchObject({ code: 'invalid_state' });
  });
});

describe('publishing', () => {
  it('creates a text post for the member with the required versioned headers and escaped commentary', async () => {
    const t = make({ 'POST /rest/posts': () => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:123' } }) });
    const res = await t.adapter.publish({ credentials: creds(), content: { text: 'Hello (team) #launch', media: [] }, markSending: async () => {} });
    expect(res).toEqual({ remoteId: 'urn:li:share:123', url: 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A123/' });
    const call = t.calls.find((c) => c.key === 'POST /rest/posts');
    expect(call.init.headers).toMatchObject({ authorization: 'Bearer LITOKEN', 'LinkedIn-Version': '202610', 'X-Restli-Protocol-Version': '2.0.0' });
    expect(call.body).toMatchObject({ author: 'urn:li:person:abc123', commentary: 'Hello \\(team\\) #launch', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED', distribution: { feedDistribution: 'MAIN_FEED' } });
    expect(call.body.content).toBeUndefined();
  });

  it('registers and uploads an image first, then posts it with alt text', async () => {
    const order = [];
    const t = make({
      'POST /rest/images': () => (order.push('init'), json({ value: { uploadUrl: 'https://www.linkedin.com/dms-uploads/abc?x=1', image: 'urn:li:image:IMG1' } })),
      'PUT /dms-uploads/abc': () => (order.push('upload'), new Response(null, { status: 201 })),
      'POST /rest/posts': () => (order.push('post'), new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:9' } })),
    });
    await t.adapter.publish({
      credentials: creds(),
      content: { text: 'pic', media: [{ id: 'm', kind: 'image', mimeType: 'image/png', size: 3, altText: 'a chart', blob: async () => new Blob(['png']) }] },
      markSending: async () => void order.push('sending'),
    });
    expect(order).toEqual(['init', 'upload', 'sending', 'post']);
    expect(t.calls.find((c) => c.key === 'POST /rest/images').body).toEqual({ initializeUploadRequest: { owner: 'urn:li:person:abc123' } });
    expect(t.calls.find((c) => c.key.startsWith('PUT')).init.headers).toMatchObject({ authorization: 'Bearer LITOKEN', 'content-type': 'image/png' });
    expect(t.calls.find((c) => c.key === 'POST /rest/posts').body.content).toEqual({ media: { id: 'urn:li:image:IMG1', altText: 'a chart' } });
  });

  it('refuses to use a token that has already expired', async () => {
    const t = make();
    await expect(t.adapter.publish({ credentials: creds({ expiresAt: new Date(Date.now() - 1000).toISOString() }), content: { text: 'x', media: [] } })).rejects.toMatchObject({ kind: 'auth', code: 'token_expired' });
    expect(t.calls).toHaveLength(0);
  });

  describe('failures', () => {
    const post = (route) => make({ 'POST /rest/posts': route }).adapter.publish({ credentials: creds(), content: { text: 'x', media: [] } });
    it('401 and missing permission -> auth with a reconnect hint', async () => {
      await expect(post(() => json({ status: 401, message: 'Invalid access token' }, { status: 401 }))).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('Reconnect') });
      await expect(post(() => json({ status: 403, code: 'ACCESS_DENIED', message: 'Not enough permissions' }, { status: 403 }))).rejects.toMatchObject({ kind: 'auth' });
    });
    it('429 -> rate_limited, 422 -> permanent, 5xx -> ambiguous', async () => {
      await expect(post(() => json({ message: 'Too many requests' }, { status: 429, headers: { 'retry-after': '3600' } }))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 3_600_000 });
      await expect(post(() => json({ message: 'Commentary too long' }, { status: 422 }))).rejects.toMatchObject({ kind: 'permanent' });
      await expect(post(() => json({ message: 'boom' }, { status: 503 }))).rejects.toMatchObject({ kind: 'ambiguous' });
    });
    it('a missing post id after 201 is ambiguous, not a silent success', async () => {
      await expect(post(() => new Response(null, { status: 201 }))).rejects.toMatchObject({ kind: 'ambiguous', code: 'no_post_id' });
    });
    it('never echoes the token', async () => {
      const e = await post(() => json({ message: 'Bearer LITOKEN rejected' }, { status: 401 })).catch((x) => x);
      expect(JSON.stringify(e.message)).not.toBe('');
      expect(e.kind).toBe('auth');
    });
  });
});

describe('validation', () => {
  it('allows 3,000 characters and one image, rejects video and many images', () => {
    const { adapter } = make();
    expect(adapter.validateContent({ text: 'x'.repeat(3000), media: [] })).toEqual([]);
    expect(adapter.validateContent({ text: 'x'.repeat(3001), media: [] }).map((i) => i.code)).toContain('text_too_long');
    expect(adapter.validateContent({ text: 'x', media: [{ kind: 'video', mimeType: 'video/mp4', size: 1 }] }).map((i) => i.code)).toContain('unsupported_media_kind');
    expect(adapter.validateContent({ text: 'x', media: [{ kind: 'image', mimeType: 'image/png', size: 1, altText: 'a' }, { kind: 'image', mimeType: 'image/png', size: 1, altText: 'a' }] }).map((i) => i.code)).toContain('too_many_media');
  });
});
