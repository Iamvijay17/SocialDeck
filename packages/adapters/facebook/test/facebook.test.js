import { describe, expect, it } from 'vitest';
import { FacebookAdapter } from '../src/index.js';

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const memoryKv = () => {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, structuredClone(v)), delete: async (k) => void m.delete(k) };
};

function fakeGraph(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? 'GET'} ${u.pathname.replace(/^\/v26\.0/, '')}`;
    const call = { key, url: u, init, form: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body };
    calls.push(call);
    const handler = routes[key];
    if (!handler) return json({ error: { code: 100, message: `no route ${key}` } }, { status: 404 });
    const r = await handler(call);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

const META = { appId: 'APP', appSecret: 'SECRET', graphVersion: 'v26.0' };
function make(routes = {}, meta = META) {
  const server = fakeGraph(routes);
  const kv = memoryKv();
  const adapter = new FacebookAdapter({ fetch: server.fetch, kv, logger: { warn() {}, info() {} }, config: { meta } });
  return { adapter, kv, ...server };
}

const REDIRECT = 'http://localhost:8080/api/accounts/facebook/callback';
const PAGES = {
  data: [
    { id: 'P1', name: 'My Page', access_token: 'PAGE_TOKEN_1', tasks: ['CREATE_CONTENT', 'MANAGE'], picture: { data: { url: 'https://cdn/p1.jpg' } }, instagram_business_account: { id: 'IG1', username: 'mypage_ig' } },
    { id: 'P2', name: 'Read-only Page', access_token: 'PAGE_TOKEN_2', tasks: ['ANALYZE'] },
  ],
};
const oauthRoutes = {
  'GET /oauth/access_token': ({ url }) => (url.searchParams.get('code') ? json({ access_token: 'SHORT' }) : json({ access_token: 'LONG', expires_in: 5_000_000 })),
  'GET /me/permissions': () => json({ data: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'].map((permission) => ({ permission, status: 'granted' })) }),
  'GET /me/accounts': () => json(PAGES),
  'GET /debug_token': () => json({ data: { expires_at: 0, data_access_expires_at: Math.floor(Date.now() / 1000) + 90 * 86400 } }),
};

describe('configuration', () => {
  it('is disabled until the Meta app id and secret are provided', () => {
    const t = make({}, { appId: '', appSecret: '', graphVersion: 'v26.0' });
    expect(t.adapter.configuration).toEqual({ configured: false, missing: ['META_APP_ID', 'META_APP_SECRET'] });
    expect(t.adapter.enabled).toBe(false);
    expect(make().adapter.enabled).toBe(true);
  });
});

describe('authorization', () => {
  it('sends the user to Facebook Login with the minimal Page permissions and a single-use state', async () => {
    const t = make();
    const { authorizationUrl } = await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT });
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth');
    expect(url.searchParams.get('scope')).toBe('pages_show_list,pages_manage_posts,pages_read_engagement');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('client_id')).toBe('APP');
    const state = url.searchParams.get('state');
    expect(state).toHaveLength(43);
    expect(await t.adapter.ownerFromCallback(new URLSearchParams({ state }))).toBe('u1');
    expect(await t.adapter.ownerFromCallback(new URLSearchParams({ state: 'nope' }))).toBeNull();
  });

  it('exchanges the code for a long-lived token and imports only Pages you can post to', async () => {
    const t = make(oauthRoutes);
    const { authorizationUrl } = await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT });
    const state = new URL(authorizationUrl).searchParams.get('state');
    const { accounts } = await t.adapter.completeAuthorization({ ownerId: 'u1', query: new URLSearchParams({ code: 'CODE', state }) });

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      platform: 'facebook',
      identity: { externalId: 'P1', displayName: 'My Page', avatarUrl: 'https://cdn/p1.jpg' },
      credentials: { pageId: 'P1', accessToken: 'PAGE_TOKEN_1' },
    });
    expect(accounts[0].scopes).toEqual(['pages_show_list', 'pages_manage_posts', 'pages_read_engagement']);
    expect(accounts[0].expiresAt).toBeInstanceOf(Date);

    const exchange = t.calls.filter((c) => c.key === 'GET /oauth/access_token');
    expect(exchange[0].url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(exchange[1].url.searchParams.get('grant_type')).toBe('fb_exchange_token');
    expect(exchange[1].url.searchParams.get('fb_exchange_token')).toBe('SHORT');
    expect(t.calls.find((c) => c.key === 'GET /me/accounts').url.searchParams.get('access_token')).toBe('LONG');
  });

  it('rejects replayed, foreign and unknown state values', async () => {
    const t = make(oauthRoutes);
    const { authorizationUrl } = await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT });
    const state = new URL(authorizationUrl).searchParams.get('state');
    const q = new URLSearchParams({ code: 'CODE', state });
    await expect(t.adapter.completeAuthorization({ ownerId: 'u2', query: q })).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(t.adapter.completeAuthorization({ ownerId: 'u1', query: q })).rejects.toMatchObject({ code: 'invalid_state' }); // consumed above
    await expect(t.adapter.completeAuthorization({ ownerId: 'u1', query: new URLSearchParams({ code: 'x', state: 'bogus' }) })).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('explains declined dialogs, missing permissions and an empty Page list', async () => {
    const t = make(oauthRoutes);
    await expect(t.adapter.completeAuthorization({ ownerId: 'u1', query: new URLSearchParams({ error: 'access_denied' }) })).rejects.toThrow(/cancelled/);

    const partial = make({ ...oauthRoutes, 'GET /me/permissions': () => json({ data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'pages_manage_posts', status: 'declined' }] }) });
    const s1 = new URL((await partial.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT })).authorizationUrl).searchParams.get('state');
    await expect(partial.adapter.completeAuthorization({ ownerId: 'u1', query: new URLSearchParams({ code: 'c', state: s1 }) })).rejects.toMatchObject({ code: 'permissions_missing' });

    const empty = make({ ...oauthRoutes, 'GET /me/accounts': () => json({ data: [] }) });
    const s2 = new URL((await empty.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT })).authorizationUrl).searchParams.get('state');
    await expect(empty.adapter.completeAuthorization({ ownerId: 'u1', query: new URLSearchParams({ code: 'c', state: s2 }) })).rejects.toMatchObject({ code: 'no_pages' });
  });
});

describe('publishing', () => {
  const creds = { pageId: 'P1', accessToken: 'PAGE_TOKEN_1' };
  const photo = (over = {}) => ({ id: 'm1', kind: 'image', mimeType: 'image/png', size: 4, altText: 'a cat', blob: async () => new Blob(['img'], { type: 'image/png' }), ...over });

  it('posts text to the Page feed, attaching a link preview for the first URL', async () => {
    const t = make({ 'POST /P1/feed': () => json({ id: 'P1_100' }) });
    const res = await t.adapter.publish({ credentials: creds, content: { text: 'Read https://example.com/post today', media: [] }, markSending: async () => {} });
    expect(res).toEqual({ remoteId: 'P1_100', url: 'https://www.facebook.com/P1_100' });
    const call = t.calls.find((c) => c.key === 'POST /P1/feed');
    expect(call.form).toMatchObject({ message: 'Read https://example.com/post today', link: 'https://example.com/post', access_token: 'PAGE_TOKEN_1' });
  });

  it('uploads photos unpublished first, then creates one post that attaches them; markSending comes last', async () => {
    const order = [];
    let n = 0;
    const t = make({
      'POST /P1/photos': () => (order.push('photo'), json({ id: `PH${++n}` })),
      'POST /P1/feed': () => (order.push('feed'), json({ id: 'P1_200' })),
    });
    await t.adapter.publish({
      credentials: creds,
      content: { text: 'two pics', media: [photo(), photo({ id: 'm2', altText: null })] },
      markSending: async () => void order.push('sending'),
    });
    expect(order).toEqual(['photo', 'photo', 'sending', 'feed']);
    const upload = t.calls.find((c) => c.key === 'POST /P1/photos');
    expect(upload.init.body.get('published')).toBe('false');
    expect(upload.init.body.get('alt_text_custom')).toBe('a cat');
    expect(upload.init.body.get('source')).toBeInstanceOf(Blob);
    const feed = t.calls.find((c) => c.key === 'POST /P1/feed');
    expect(JSON.parse(feed.form['attached_media[0]'])).toEqual({ media_fbid: 'PH1' });
    expect(JSON.parse(feed.form['attached_media[1]'])).toEqual({ media_fbid: 'PH2' });
    expect(feed.form.link).toBeUndefined();
  });

  it('uploads a video in a single request', async () => {
    const t = make({ 'POST /P1/videos': () => json({ id: 'V9' }) });
    const res = await t.adapter.publish({
      credentials: creds,
      content: { text: 'clip', media: [{ id: 'v', kind: 'video', mimeType: 'video/mp4', size: 3, blob: async () => new Blob(['v']) }] },
    });
    expect(res.remoteId).toBe('V9');
    expect(t.calls[0].init.body.get('description')).toBe('clip');
  });

  describe('failure handling', () => {
    const run = (route, path = 'POST /P1/feed') => make({ [path]: route }).adapter.publish({ credentials: creds, content: { text: 'x', media: [] } });
    it('expired token -> auth', async () => {
      await expect(run(() => json({ error: { code: 190, message: 'expired' } }, { status: 400 }))).rejects.toMatchObject({ kind: 'auth' });
    });
    it('rate limit -> rate_limited with a wait', async () => {
      await expect(run(() => json({ error: { code: 32, message: 'Page request limit reached' } }, { status: 400, headers: { 'retry-after': '120' } }))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    });
    it('server error on the creating request -> ambiguous (no idempotency key exists)', async () => {
      await expect(run(() => json({ error: { code: 2, message: 'unavailable' } }, { status: 500 }))).rejects.toMatchObject({ kind: 'ambiguous' });
      await expect(run(() => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).rejects.toMatchObject({ kind: 'ambiguous' });
    });
    it('invalid content -> permanent', async () => {
      await expect(run(() => json({ error: { code: 100, message: 'Invalid parameter' } }, { status: 400 }))).rejects.toMatchObject({ kind: 'permanent' });
    });
    it('a failed photo upload is retry-safe (nothing is visible yet)', async () => {
      const t = make({ 'POST /P1/photos': () => json({ error: { code: 2, message: 'unavailable' } }, { status: 500 }) });
      await expect(t.adapter.publish({ credentials: creds, content: { text: 'x', media: [photo()] } })).rejects.toMatchObject({ kind: 'transient' });
    });
    it('never puts the token in an error message', async () => {
      const e = await run(() => json({ error: { code: 100, message: 'bad access_token=PAGE_TOKEN_1' } }, { status: 400 })).catch((x) => x);
      expect(e.message).not.toContain('PAGE_TOKEN_1');
    });
  });
});

describe('validation and metrics', () => {
  const { adapter } = make();
  it('accepts long text and enforces image types, count and video exclusivity', () => {
    expect(adapter.validateContent({ text: 'x'.repeat(5000), media: [] })).toEqual([]);
    expect(adapter.validateContent({ text: 'x', media: [{ kind: 'image', mimeType: 'image/webp', size: 1 }] }).map((i) => i.code)).toContain('unsupported_media_type');
    expect(adapter.validateContent({ text: 'x', media: [{ kind: 'image', mimeType: 'image/png', size: 1 }, { kind: 'video', mimeType: 'video/mp4', size: 1 }] }).map((i) => i.code)).toContain('mixed_media');
    expect(adapter.validateContent({ text: '', media: [] }).map((i) => i.code)).toContain('empty');
  });
  it('reads reactions, comments and shares from the official API', async () => {
    const t = make({ 'GET /P1_100': () => json({ reactions: { summary: { total_count: 7 } }, comments: { summary: { total_count: 2 } }, shares: { count: 1 } }) });
    expect(await t.adapter.fetchPostMetrics({ credentials: creds(), remoteId: 'P1_100' })).toEqual({ reactions: 7, comments: 2, shares: 1 });
  });
});

function creds() {
  return { pageId: 'P1', accessToken: 'PAGE_TOKEN_1' };
}
