import { describe, expect, it, vi } from 'vitest';
import { BlueskyAdapter, DEFAULT_BLUESKY_SCOPE, buildClientMetadata } from '../src/index.js';

const REDIRECT_LOCAL = 'http://127.0.0.1:4000/api/accounts/bluesky/callback';

function memoryKv() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, structuredClone(v)), delete: async (k) => void m.delete(k) };
}

class XRPCError extends Error {
  constructor(status, error, message, headers = {}) {
    super(message ?? error);
    this.status = status;
    this.error = error;
    this.headers = headers;
  }
}

/** Fake atproto OAuth client + agent so no network or real PDS is involved. */
function make({ publicUrl = 'http://127.0.0.1:4000', agent: agentOverrides = {}, client: clientOverrides = {} } = {}) {
  const session = { did: 'did:plc:alice', getTokenInfo: async () => ({ scope: DEFAULT_BLUESKY_SCOPE }) };
  const agent = {
    getProfile: vi.fn(async () => ({ data: { handle: 'alice.test', displayName: 'Alice', avatar: 'https://cdn/a.jpg' } })),
    uploadBlob: vi.fn(async (_b, opts) => ({ data: { blob: { $type: 'blob', ref: { $link: 'bafy' }, mimeType: opts.encoding, size: 3 } } })),
    post: vi.fn(async () => ({ uri: 'at://did:plc:alice/app.bsky.feed.post/3kabc', cid: 'cid1' })),
    getPosts: vi.fn(async () => ({ data: { posts: [{ likeCount: 4, repostCount: 2, replyCount: 1, quoteCount: 0 }] } })),
    resolveHandle: vi.fn(async () => ({ data: { did: 'did:plc:bob' } })),
    ...agentOverrides,
  };
  const client = {
    authorize: vi.fn(async () => new URL('https://bsky.social/oauth/authorize?request_uri=urn:abc')),
    callback: vi.fn(async () => ({ session, state: 's' })),
    restore: vi.fn(async () => session),
    revoke: vi.fn(async () => {}),
    ...clientOverrides,
  };
  const created = [];
  const adapter = new BlueskyAdapter({
    fetch: vi.fn(),
    kv: memoryKv(),
    logger: { warn() {}, info() {} },
    config: { publicUrl, appName: 'PSM', redirectUri: REDIRECT_LOCAL },
    bluesky: { createClient: (opts) => (created.push(opts), client), createAgent: () => agent },
  });
  return { adapter, agent, client, session, created };
}

const publishCtx = (content, extra = {}) => ({
  credentials: { did: 'did:plc:alice' },
  account: { id: 'a1', ownerId: 'u1' },
  content,
  idempotencyKey: 'k',
  markSending: async () => {},
  ...extra,
});
const image = (over = {}) => ({ id: 'm', kind: 'image', mimeType: 'image/png', size: 100, altText: 'alt', width: 10, height: 5, blob: async () => new Blob([new Uint8Array([1, 2, 3])]), ...over });

describe('client metadata', () => {
  it('uses the AT Protocol loopback client for local installations', () => {
    const meta = buildClientMetadata({ publicUrl: 'http://127.0.0.1:4000', redirectUri: REDIRECT_LOCAL });
    expect(meta.client_id).toMatch(/^http:\/\/localhost\?/);
    expect(meta.redirect_uris).toEqual([REDIRECT_LOCAL]);
    expect(meta.scope).toBe(DEFAULT_BLUESKY_SCOPE);
  });
  it('publishes a web client document when reachable over https', () => {
    const meta = buildClientMetadata({ publicUrl: 'https://psm.example.net', redirectUri: 'https://psm.example.net/api/accounts/bluesky/callback' });
    expect(meta).toMatchObject({
      client_id: 'https://psm.example.net/api/oauth/bluesky/client-metadata.json',
      dpop_bound_access_tokens: true,
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    });
  });
  it('refuses plain-http, non-loopback installations', () => {
    expect(() => buildClientMetadata({ publicUrl: 'http://psm.lan', redirectUri: 'http://psm.lan/cb' })).toThrow(/https/);
  });
  it('requests minimal granular scopes by default', () => {
    expect(DEFAULT_BLUESKY_SCOPE).toBe('atproto repo:app.bsky.feed.post?action=create blob:image/*');
  });
});

describe('authorization', () => {
  it('starts OAuth for a handle or defaults to bsky.social', async () => {
    const t = make();
    const { authorizationUrl } = await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT_LOCAL, input: { handle: '@alice.test' } });
    expect(authorizationUrl).toContain('bsky.social/oauth/authorize');
    expect(t.client.authorize).toHaveBeenCalledWith('alice.test', expect.objectContaining({ scope: DEFAULT_BLUESKY_SCOPE }));
    await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT_LOCAL, input: {} });
    expect(t.client.authorize.mock.calls[1][0]).toBe('https://bsky.social');
  });

  it('isolates OAuth state/session storage per owner', async () => {
    const t = make();
    await t.adapter.beginAuthorization({ ownerId: 'u1', redirectUri: REDIRECT_LOCAL, input: {} });
    await t.adapter.beginAuthorization({ ownerId: 'u2', redirectUri: REDIRECT_LOCAL, input: {} });
    expect(t.created).toHaveLength(2);
    await t.created[0].sessionStore.set('did:plc:x', { tokenSet: 1 });
    expect(await t.created[1].sessionStore.get('did:plc:x')).toBeUndefined();
    expect([...t.adapter.deps.kv.m.keys()][0]).toContain('bsky:u1:session:');
  });

  it('completes the callback and returns identity without storing tokens in credentials', async () => {
    const t = make();
    const res = await t.adapter.completeAuthorization({ ownerId: 'u1', redirectUri: REDIRECT_LOCAL, query: new URLSearchParams({ code: 'c', state: 's', iss: 'https://bsky.social' }) });
    expect(res.identity).toMatchObject({ externalId: 'did:plc:alice', displayName: 'Alice', handle: '@alice.test' });
    expect(res.credentials).toEqual({ did: 'did:plc:alice' });
    expect(res.scopes).toContain('atproto');
  });

  it('turns OAuth failures into readable permanent errors', async () => {
    const t = make({ client: { callback: vi.fn(async () => { throw new Error('state mismatch'); }) } });
    await expect(t.adapter.completeAuthorization({ ownerId: 'u1', redirectUri: REDIRECT_LOCAL, query: new URLSearchParams({ code: 'c', state: 'bad' }) })).rejects.toMatchObject({ kind: 'permanent', code: 'oauth_failed' });
    await expect(t.adapter.completeAuthorization({ ownerId: 'u1', redirectUri: REDIRECT_LOCAL, query: new URLSearchParams({ error: 'access_denied' }) })).rejects.toThrow(/declined/);
  });
});

describe('publishing', () => {
  it('creates a text post and returns the at:// uri plus a bsky.app link', async () => {
    const t = make();
    const res = await t.adapter.publish(publishCtx({ text: 'hello world', media: [] }));
    expect(res).toEqual({ remoteId: 'at://did:plc:alice/app.bsky.feed.post/3kabc', url: 'https://bsky.app/profile/did:plc:alice/post/3kabc', raw: { cid: 'cid1' } });
    expect(t.agent.post.mock.calls[0][0]).toMatchObject({ text: 'hello world' });
  });

  it('uploads images with alt text and aspect ratio before posting, and marks sending only afterwards', async () => {
    const t = make();
    const order = [];
    t.agent.uploadBlob.mockImplementation(async (_b, o) => (order.push('upload'), { data: { blob: { mimeType: o.encoding } } }));
    t.agent.post.mockImplementation(async () => (order.push('post'), { uri: 'at://x/y/z', cid: 'c' }));
    await t.adapter.publish(publishCtx({ text: 'pic', media: [image()] }, { markSending: async () => void order.push('sending') }));
    expect(order).toEqual(['upload', 'sending', 'post']);
    const record = t.agent.post.mock.calls[0][0];
    expect(record.embed).toMatchObject({ $type: 'app.bsky.embed.images', images: [{ alt: 'alt', aspectRatio: { width: 10, height: 5 } }] });
  });

  it('detects link facets', async () => {
    const t = make();
    await t.adapter.publish(publishCtx({ text: 'see https://example.com now', media: [] }));
    const record = t.agent.post.mock.calls[0][0];
    expect(record.facets?.[0].features[0]).toMatchObject({ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' });
  });

  it('refuses video', async () => {
    const t = make();
    await expect(t.adapter.publish(publishCtx({ text: 'v', media: [image({ kind: 'video', mimeType: 'video/mp4' })] }))).rejects.toMatchObject({ code: 'unsupported_media' });
  });

  describe('error classification', () => {
    const failPost = (err) => {
      const t = make({ agent: { post: vi.fn(async () => { throw err; }) } });
      return t.adapter.publish(publishCtx({ text: 'x', media: [] }));
    };
    it('expired/invalid token -> auth', async () => {
      await expect(failPost(new XRPCError(400, 'ExpiredToken', 'Token has expired'))).rejects.toMatchObject({ kind: 'auth' });
      await expect(failPost(new XRPCError(401, 'AuthenticationRequired'))).rejects.toMatchObject({ kind: 'auth' });
    });
    it('revoked OAuth session -> auth', async () => {
      const t = make({ client: { restore: vi.fn(async () => { throw Object.assign(new Error('revoked'), { name: 'TokenRevokedError' }); }) } });
      await expect(t.adapter.publish(publishCtx({ text: 'x', media: [] }))).rejects.toMatchObject({ kind: 'auth' });
    });
    it('429 -> rate_limited using ratelimit-reset', async () => {
      const reset = Math.floor(Date.now() / 1000) + 30;
      const err = await failPost(new XRPCError(429, 'RateLimitExceeded', 'slow down', { 'ratelimit-reset': String(reset) })).catch((e) => e);
      expect(err.kind).toBe('rate_limited');
      expect(err.retryAfterMs).toBeGreaterThan(20_000);
    });
    it('5xx while creating -> ambiguous (Bluesky has no idempotency key)', async () => {
      await expect(failPost(new XRPCError(502, 'UpstreamFailure'))).rejects.toMatchObject({ kind: 'ambiguous' });
    });
    it('network drop while creating -> ambiguous; 400 -> permanent', async () => {
      await expect(failPost(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).rejects.toMatchObject({ kind: 'ambiguous' });
      await expect(failPost(new XRPCError(400, 'InvalidRequest', 'Record/text must not be longer than 3000'))).rejects.toMatchObject({ kind: 'permanent' });
    });
    it('failures while uploading media are safely retryable (nothing public exists yet)', async () => {
      const t = make({ agent: { uploadBlob: vi.fn(async () => { throw new XRPCError(503, 'Unavailable'); }) } });
      await expect(t.adapter.publish(publishCtx({ text: 'x', media: [image()] }))).rejects.toMatchObject({ kind: 'transient' });
    });
  });

  it('declares that publishing is not idempotent', () => {
    expect(make().adapter.capabilities.idempotentPublish).toBe(false);
  });
});

describe('validation', () => {
  const v = (content) => make().adapter.validateContent(content);
  it('counts graphemes against the 300 limit', () => {
    expect(v({ text: '🇩🇪'.repeat(300), media: [] })).toEqual([]);
    expect(v({ text: 'a'.repeat(301), media: [] }).map((i) => i.code)).toContain('text_too_long');
  });
  it('enforces the 1 MB image limit, 4 images, and no video', () => {
    expect(v({ text: 'x', media: [{ kind: 'image', mimeType: 'image/jpeg', size: 1_000_001, altText: 'a' }] }).map((i) => i.code)).toContain('media_too_large');
    const five = Array.from({ length: 5 }, () => ({ kind: 'image', mimeType: 'image/png', size: 10, altText: 'a' }));
    expect(v({ text: 'x', media: five }).map((i) => i.code)).toContain('too_many_media');
    expect(v({ text: 'x', media: [{ kind: 'video', mimeType: 'video/mp4', size: 10 }] }).map((i) => i.severity)).toContain('error');
  });
  it('warns, but does not fail, when alt text is missing', () => {
    const issues = v({ text: 'x', media: [{ kind: 'image', mimeType: 'image/png', size: 10, altText: null }] });
    expect(issues).toEqual([expect.objectContaining({ code: 'missing_alt_text', severity: 'warning' })]);
  });
});

describe('maintenance', () => {
  it('revokes the session on disconnect and swallows failures', async () => {
    const t = make({ client: { revoke: vi.fn(async () => { throw new Error('offline'); }) } });
    await expect(t.adapter.revoke({ credentials: { did: 'did:plc:alice' }, ownerId: 'u1' })).resolves.toBeUndefined();
    expect(t.client.revoke).toHaveBeenCalledWith('did:plc:alice');
  });
  it('reads real engagement counts from the official API', async () => {
    const t = make();
    expect(await t.adapter.fetchPostMetrics({ credentials: { did: 'did:plc:alice' }, account: { ownerId: 'u1' }, remoteId: 'at://x' })).toEqual({ likes: 4, reposts: 2, replies: 1, quotes: 0 });
  });
});
