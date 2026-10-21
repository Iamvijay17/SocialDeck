import { describe, expect, it } from 'vitest';
import { InstagramAdapter } from '../src/index.js';

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const memoryKv = () => {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, structuredClone(v)), delete: async (k) => void m.delete(k) };
};

function fakeGraph(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? 'GET'} ${u.pathname.replace(/^\/v26\.0/, '')}`;
    const call = { key, url: u, init, form: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : undefined };
    calls.push(call);
    const h = routes[key];
    if (!h) return json({ error: { code: 100, message: `no route ${key}` } }, { status: 404 });
    return h(call);
  };
  return { fetch, calls };
}

function make(routes = {}, { publicMediaConfigured = true } = {}) {
  const server = fakeGraph(routes);
  const adapter = new InstagramAdapter({
    fetch: server.fetch,
    kv: memoryKv(),
    logger: { warn() {}, info() {} },
    publicMedia: { isConfigured: async () => publicMediaConfigured },
    config: { meta: { appId: 'APP', appSecret: 'SEC', graphVersion: 'v26.0' }, pollIntervalMs: 1, pollTimeoutMs: 200 },
  });
  return { adapter, ...server };
}

const creds = { pageId: 'P1', igUserId: 'IG1', accessToken: 'PAGE_TOKEN' };
const img = (n = 1, over = {}) => ({ id: `m${n}`, kind: 'image', mimeType: 'image/jpeg', size: 1000, altText: 'alt', publicUrl: `https://media.example/m/tok${n}`, ...over });
const vid = { id: 'v1', kind: 'video', mimeType: 'video/mp4', size: 1000, publicUrl: 'https://media.example/m/vid' };

describe('Instagram shares Facebook Login', () => {
  it('redirects through the Facebook callback and requests Page + Instagram permissions', async () => {
    const t = make();
    expect(t.adapter.authCallbackPlatform).toBe('facebook');
    expect(t.adapter.capabilities.redirectBase).toBe('oauth');
    const { authorizationUrl } = await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: 'http://localhost:8080/api/accounts/facebook/callback' });
    expect(new URL(authorizationUrl).searchParams.get('scope')).toBe('pages_show_list,pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish');
  });

  it('imports the Instagram professional account linked to each Page (and nothing for Pages without one)', async () => {
    const t = make({
      'GET /oauth/access_token': ({ url }) => (url.searchParams.get('code') ? json({ access_token: 'S' }) : json({ access_token: 'L' })),
      'GET /me/permissions': () => json({ data: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'].map((permission) => ({ permission, status: 'granted' })) }),
      'GET /me/accounts': () => json({ data: [{ id: 'P1', name: 'Page', access_token: 'PT1', tasks: ['CREATE_CONTENT'], instagram_business_account: { id: 'IG1', username: 'shop', profile_picture_url: 'https://cdn/i.jpg' } }, { id: 'P2', name: 'NoIG', access_token: 'PT2', tasks: ['CREATE_CONTENT'] }] }),
      'GET /debug_token': () => json({ data: { expires_at: 0 } }),
    });
    const state = new URL((await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: 'http://localhost/cb' })).authorizationUrl).searchParams.get('state');
    const { accounts } = await t.adapter.completeAuthorization({ ownerId: 'u1', query: new URLSearchParams({ code: 'c', state }) });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      platform: 'instagram',
      identity: { externalId: 'IG1', displayName: 'shop', handle: '@shop' },
      credentials: { pageId: 'P1', igUserId: 'IG1', accessToken: 'PT1' },
    });
  });

  it('explains how to link an Instagram professional account when none is found', async () => {
    const t = make({
      'GET /oauth/access_token': () => json({ access_token: 'T' }),
      'GET /me/permissions': () => json({ data: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'].map((permission) => ({ permission, status: 'granted' })) }),
      'GET /me/accounts': () => json({ data: [{ id: 'P2', name: 'NoIG', access_token: 'PT2', tasks: ['CREATE_CONTENT'] }] }),
      'GET /debug_token': () => json({ data: {} }),
    });
    const state = new URL((await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: 'http://localhost/cb' })).authorizationUrl).searchParams.get('state');
    await expect(t.adapter.completeAuthorization({ ownerId: 'u1', query: new URLSearchParams({ code: 'c', state }) })).rejects.toMatchObject({ code: 'no_instagram_account' });
  });
});

describe('validation', () => {
  it('requires media, JPEG images, at most 30 hashtags and 2,200 characters', async () => {
    const { adapter } = make();
    expect((await adapter.validateContent({ text: 'text only', media: [] })).map((i) => i.code)).toEqual(['media_required']);
    expect((await adapter.validateContent({ text: 'x', media: [img(1, { mimeType: 'image/png' })] })).map((i) => i.code)).toContain('unsupported_media_type');
    expect((await adapter.validateContent({ text: 'x'.repeat(2201), media: [img()] })).map((i) => i.code)).toContain('text_too_long');
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
    expect((await adapter.validateContent({ text: tags, media: [img()] })).map((i) => i.code)).toContain('too_many_hashtags');
    expect((await adapter.validateContent({ text: 'ok #one #two', media: [img()] })).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('flags a missing public media address instead of failing later', async () => {
    const { adapter } = make({}, { publicMediaConfigured: false });
    const issues = await adapter.validateContent({ text: 'x', media: [img()] });
    expect(issues.find((i) => i.code === 'public_media_not_configured')).toMatchObject({ severity: 'error' });
  });

  it('allows one video (a Reel) but not several, and no mixing', async () => {
    const { adapter } = make();
    expect((await adapter.validateContent({ text: 'x', media: [vid] })).filter((i) => i.severity === 'error')).toEqual([]);
    expect((await adapter.validateContent({ text: 'x', media: [vid, { ...vid, id: 'v2' }] })).map((i) => i.code)).toContain('too_many_videos');
    expect((await adapter.validateContent({ text: 'x', media: [img(), vid] })).map((i) => i.code)).toContain('mixed_media');
  });
});

describe('publishing', () => {
  it('creates a container, waits until FINISHED, then publishes (markSending only right before media_publish)', async () => {
    const order = [];
    let polls = 0;
    const t = make({
      'POST /IG1/media': () => (order.push('container'), json({ id: 'C1' })),
      'GET /C1': () => (order.push('poll'), json({ status_code: ++polls < 3 ? 'IN_PROGRESS' : 'FINISHED' })),
      'POST /IG1/media_publish': () => (order.push('publish'), json({ id: 'MEDIA1' })),
      'GET /MEDIA1': () => json({ permalink: 'https://www.instagram.com/p/abc/' }),
    });
    const res = await t.adapter.publish({ credentials: creds, content: { text: 'hello #world', media: [img()] }, markSending: async () => void order.push('sending') });
    expect(res).toEqual({ remoteId: 'MEDIA1', url: 'https://www.instagram.com/p/abc/' });
    expect(order).toEqual(['container', 'poll', 'poll', 'poll', 'sending', 'publish']);
    const container = t.calls.find((c) => c.key === 'POST /IG1/media');
    expect(container.form).toMatchObject({ image_url: 'https://media.example/m/tok1', caption: 'hello #world', alt_text: 'alt', access_token: 'PAGE_TOKEN' });
    expect(t.calls.find((c) => c.key === 'POST /IG1/media_publish').form.creation_id).toBe('C1');
  });

  it('publishes a single video as a Reel', async () => {
    const t = make({
      'POST /IG1/media': () => json({ id: 'C2' }),
      'GET /C2': () => json({ status_code: 'FINISHED' }),
      'POST /IG1/media_publish': () => json({ id: 'M2' }),
      'GET /M2': () => json({}),
    });
    const res = await t.adapter.publish({ credentials: creds, content: { text: 'reel', media: [vid] } });
    expect(res).toEqual({ remoteId: 'M2', url: null });
    expect(t.calls.find((c) => c.key === 'POST /IG1/media').form).toMatchObject({ media_type: 'REELS', video_url: 'https://media.example/m/vid' });
  });

  it('builds a carousel from child containers', async () => {
    let n = 0;
    const t = make({
      'POST /IG1/media': ({ form }) => json({ id: form.is_carousel_item ? `CH${++n}` : 'CAR' }),
      'GET /CH1': () => json({ status_code: 'FINISHED' }),
      'GET /CH2': () => json({ status_code: 'FINISHED' }),
      'GET /CAR': () => json({ status_code: 'FINISHED' }),
      'POST /IG1/media_publish': () => json({ id: 'M3' }),
      'GET /M3': () => json({ permalink: 'https://www.instagram.com/p/car/' }),
    });
    await t.adapter.publish({ credentials: creds, content: { text: 'two', media: [img(1), img(2)] } });
    const creates = t.calls.filter((c) => c.key === 'POST /IG1/media');
    expect(creates[0].form).toMatchObject({ is_carousel_item: 'true', image_url: 'https://media.example/m/tok1' });
    expect(creates[2].form).toMatchObject({ media_type: 'CAROUSEL', children: 'CH1,CH2', caption: 'two' });
  });

  it('fails permanently without a public address and never calls Instagram', async () => {
    const t = make();
    await expect(t.adapter.publish({ credentials: creds, content: { text: 'x', media: [img(1, { publicUrl: null })] } })).rejects.toMatchObject({ code: 'public_media_not_configured', kind: 'permanent' });
    expect(t.calls).toHaveLength(0);
  });

  describe('failures', () => {
    const container = { 'POST /IG1/media': () => json({ id: 'C' }) };
    it('processing ERROR is permanent and says what to check', async () => {
      const t = make({ ...container, 'GET /C': () => json({ status_code: 'ERROR', status: 'Error: Media upload has failed' }) });
      await expect(t.adapter.publish({ credentials: creds, content: { text: 'x', media: [img()] } })).rejects.toMatchObject({ kind: 'permanent', code: 'container_error' });
    });
    it('a container that never finishes is retry-safe (nothing is public yet)', async () => {
      const t = make({ ...container, 'GET /C': () => json({ status_code: 'IN_PROGRESS' }) });
      await expect(t.adapter.publish({ credentials: creds, content: { text: 'x', media: [img()] } })).rejects.toMatchObject({ kind: 'transient', code: 'container_not_ready' });
      expect(t.calls.some((c) => c.key === 'POST /IG1/media_publish')).toBe(false);
    });
    it('a failure while publishing is ambiguous and is never retried blindly', async () => {
      const t = make({ ...container, 'GET /C': () => json({ status_code: 'FINISHED' }), 'POST /IG1/media_publish': () => json({ error: { code: 2, message: 'unavailable' } }, { status: 500 }) });
      await expect(t.adapter.publish({ credentials: creds, content: { text: 'x', media: [img()] } })).rejects.toMatchObject({ kind: 'ambiguous' });
    });
    it('"media not ready" at publish time is transient', async () => {
      const t = make({ ...container, 'GET /C': () => json({ status_code: 'FINISHED' }), 'POST /IG1/media_publish': () => json({ error: { code: 9007, error_subcode: 2207027, message: 'Media ID is not available' } }, { status: 400 }) });
      await expect(t.adapter.publish({ credentials: creds, content: { text: 'x', media: [img()] } })).rejects.toMatchObject({ kind: 'transient' });
    });
    it('revoked permissions -> auth', async () => {
      const t = make({ 'POST /IG1/media': () => json({ error: { code: 190, message: 'expired' } }, { status: 400 }) });
      await expect(t.adapter.publish({ credentials: creds, content: { text: 'x', media: [img()] } })).rejects.toMatchObject({ kind: 'auth' });
    });
    it('rate limit -> rate_limited', async () => {
      const t = make({ 'POST /IG1/media': () => json({ error: { code: 4, message: 'limit' } }, { status: 400, headers: { 'retry-after': '60' } }) });
      await expect(t.adapter.publish({ credentials: creds, content: { text: 'x', media: [img()] } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 });
    });
  });

  it('reads like and comment counts', async () => {
    const t = make({ 'GET /M1': () => json({ like_count: 5, comments_count: 1 }) });
    expect(await t.adapter.fetchPostMetrics({ credentials: creds, remoteId: 'M1' })).toEqual({ likes: 5, comments: 1 });
  });
});
