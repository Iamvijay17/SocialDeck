import { randomBytes } from 'node:crypto';
import { ERROR_CLASS } from '@osh/shared';
import {
  PlatformAdapter,
  PlatformError,
  classifyHttpFailure,
  classifyNetworkError,
  defineCapabilities,
  graphemeLength,
  parseRetryAfter,
  validateAgainstCapabilities,
} from '@osh/platform-core';
import { Agent, RichText } from '@atproto/api';
import { NodeOAuthClient, buildAtprotoLoopbackClientMetadata } from '@atproto/oauth-client-node';

/**
 * Bluesky adapter (official AT Protocol).
 * Docs: https://docs.bsky.app/docs/tutorials/creating-a-post
 *
 * Authentication uses the official AT Protocol OAuth profile (PKCE + DPoP + PAR) via the maintained
 * `@atproto/oauth-client-node` library. The app never sees the user's password, and no app passwords are collected.
 * Tokens and DPoP keys live in the encrypted key/value store handed in as `deps.kv`.
 *
 * Supported: text posts with links/mentions (facets), up to 4 images with alt text.
 * Not supported yet: video (needs the video service + service auth), GIF/external embeds, threads, replies.
 */

export const DEFAULT_BLUESKY_SCOPE = 'atproto repo:app.bsky.feed.post?action=create blob:image/*';
/** Legacy broad scope, usable if a server does not support granular permission scopes. */
export const LEGACY_BLUESKY_SCOPE = 'atproto transition:generic';

const MAX_IMAGE_BYTES = 1_000_000; // app.bsky.embed.images maxSize

const CAPS = defineCapabilities({
  implemented: true,
  authType: 'oauth2-atproto',
  authInputs: [{ name: 'handle', label: 'Handle or server', placeholder: 'alice.bsky.social', required: false }],
  requiredScopes: DEFAULT_BLUESKY_SCOPE.split(' '),
  text: { maxLength: 300, counting: 'graphemes' },
  media: {
    maxItems: 4,
    mixedTypes: false,
    altText: true,
    image: { mimeTypes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: MAX_IMAGE_BYTES },
    video: { mimeTypes: [], maxBytes: 0 },
  },
  scheduling: { native: false, minLeadSeconds: 0 },
  idempotentPublish: false,
  tokenRefresh: 'automatic',
  analytics: { postMetrics: ['likes', 'reposts', 'replies', 'quotes'] },
  notes: [
    'Sign-in uses Bluesky OAuth; your password is never shared with this app.',
    'Images must be 1 MB or smaller (a Bluesky protocol limit). Large photos need to be resized first.',
    'Video posts are not supported yet.',
    'Apps that cannot authenticate themselves ("public clients") get shorter-lived sessions, so you may need to reconnect periodically.',
    'On a non-local installation the app must be reachable over public HTTPS so Bluesky can read its OAuth client metadata.',
  ],
});

/**
 * Build the OAuth client metadata document. For a local (loopback) installation the AT Protocol's
 * special loopback client is used, otherwise the metadata must be published at `client_id` over HTTPS.
 */
export function buildClientMetadata({ publicUrl, redirectUri, scope = DEFAULT_BLUESKY_SCOPE, appName = 'Private Social Manager' }) {
  const url = new URL(publicUrl);
  if (isLoopbackHost(url.hostname)) {
    return buildAtprotoLoopbackClientMetadata({ scope, redirect_uris: [redirectUri] });
  }
  if (url.protocol !== 'https:') {
    throw new PlatformError('Bluesky sign-in requires PUBLIC_URL to be an https:// URL (or a loopback address such as http://127.0.0.1 for local use).', {
      kind: ERROR_CLASS.PERMANENT,
      code: 'public_url_not_https',
    });
  }
  return {
    client_id: `${url.origin}/api/oauth/bluesky/client-metadata.json`,
    client_name: appName,
    client_uri: url.origin,
    redirect_uris: [redirectUri],
    scope,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    application_type: 'web',
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true,
  };
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '[::1]' || host === 'localhost';
}

const AUTH_ERROR_NAMES = new Set(['TokenRefreshError', 'TokenRevokedError', 'TokenInvalidError', 'AuthMethodUnsatisfiableError']);
const AUTH_XRPC_CODES = new Set(['ExpiredToken', 'InvalidToken', 'AuthMissing', 'AuthenticationRequired', 'AccountTakedown']);

export class BlueskyAdapter extends PlatformAdapter {
  #clients = new Map();

  get id() {
    return 'bluesky';
  }
  get label() {
    return 'Bluesky';
  }
  get capabilities() {
    return CAPS;
  }

  get scope() {
    return this.deps.config?.scope || DEFAULT_BLUESKY_SCOPE;
  }

  clientMetadata(redirectUri) {
    return buildClientMetadata({ publicUrl: this.deps.config.publicUrl, redirectUri, scope: this.scope, appName: this.deps.config.appName });
  }

  /** Per-owner client so that OAuth state and sessions are isolated between users. */
  #client(ownerId, redirectUri) {
    const key = `${ownerId}|${redirectUri}`;
    let client = this.#clients.get(key);
    if (!client) {
      const ns = `bsky:${ownerId}:`;
      const factory = this.deps.bluesky?.createClient ?? ((opts) => new NodeOAuthClient(opts));
      client = factory({
        clientMetadata: this.clientMetadata(redirectUri),
        stateStore: kvStore(this.deps.kv, `${ns}state:`, 600),
        sessionStore: kvStore(this.deps.kv, `${ns}session:`),
      });
      this.#clients.set(key, client);
    }
    return client;
  }

  #agent(session) {
    return this.deps.bluesky?.createAgent ? this.deps.bluesky.createAgent(session) : new Agent(session);
  }

  async beginAuthorization({ ownerId, redirectUri, input, signal }) {
    const target = (input?.handle ?? '').trim().replace(/^@/, '') || 'https://bsky.social';
    const client = this.#client(ownerId, redirectUri);
    try {
      const url = await client.authorize(target, { scope: this.scope, state: randomBytes(16).toString('base64url'), signal });
      return { authorizationUrl: url.toString() };
    } catch (err) {
      throw this.#authFlowError(err, 'start');
    }
  }

  async completeAuthorization({ ownerId, redirectUri, query }) {
    if (query.get('error')) {
      const e = query.get('error');
      throw new PlatformError(e === 'access_denied' ? 'Authorization was declined on Bluesky.' : `Bluesky returned an error: ${query.get('error_description') ?? e}`, {
        kind: ERROR_CLASS.PERMANENT,
        code: e,
      });
    }
    const client = this.#client(ownerId, redirectUri);
    let session;
    try {
      ({ session } = await client.callback(query));
    } catch (err) {
      throw this.#authFlowError(err, 'finish');
    }
    const agent = this.#agent(session);
    let profile = {};
    try {
      ({ data: profile } = await agent.getProfile({ actor: session.did }));
    } catch {
      // The profile is cosmetic; the DID is the identity.
    }
    let info = {};
    try {
      info = await session.getTokenInfo(false);
    } catch {
      /* optional */
    }
    return {
      identity: {
        externalId: session.did,
        displayName: profile.displayName || profile.handle || session.did,
        handle: profile.handle ? `@${profile.handle}` : undefined,
        avatarUrl: profile.avatar,
      },
      credentials: { did: session.did },
      scopes: String(info.scope ?? this.scope).split(/\s+/).filter(Boolean),
      // The short-lived access token is refreshed automatically; the session itself has no expiry we can report.
      expiresAt: null,
    };
  }

  validateContent(content) {
    return validateAgainstCapabilities(CAPS, content, graphemeLength);
  }

  async #restore(credentials, ownerId, redirectUri) {
    const client = this.#client(ownerId, redirectUri);
    try {
      return await client.restore(credentials.did, 'auto');
    } catch (err) {
      throw this.#toPlatformError(err, { mutating: false });
    }
  }

  async verifyCredentials({ credentials, ownerId, redirectUri }) {
    await this.#restore(credentials, ownerId, redirectUri);
    return { expiresAt: null };
  }

  async publish({ credentials, account, content, markSending, signal }) {
    const ownerId = account.ownerId;
    const session = await this.#restore(credentials, ownerId, this.deps.config.redirectUri);
    const agent = this.#agent(session);

    // 1. Upload media. Uploads create unreferenced blobs only, so failures here are safely retryable.
    const images = [];
    for (const m of content.media ?? []) {
      if (m.kind !== 'image') {
        throw new PlatformError('Bluesky video posts are not supported yet.', { kind: ERROR_CLASS.PERMANENT, code: 'unsupported_media' });
      }
      const bytes = new Uint8Array(await (await m.blob()).arrayBuffer());
      try {
        const res = await agent.uploadBlob(bytes, { encoding: m.mimeType, signal });
        const image = { image: res.data.blob, alt: m.altText ?? '' };
        if (m.width && m.height) image.aspectRatio = { width: m.width, height: m.height };
        images.push(image);
      } catch (err) {
        throw this.#toPlatformError(err, { mutating: false });
      }
    }

    // 2. Facets (links, mentions) – resolving mentions may use the network but creates nothing.
    const rt = new RichText({ text: content.text ?? '' });
    try {
      await rt.detectFacets(agent);
    } catch {
      // Without facets the post is still valid plain text.
    }

    // 3. Create the post. From here on a failure may or may not have created the record.
    const record = { text: rt.text, createdAt: new Date().toISOString() };
    if (rt.facets?.length) record.facets = rt.facets;
    if (images.length) record.embed = { $type: 'app.bsky.embed.images', images };
    await markSending?.();
    try {
      const res = await agent.post(record);
      const rkey = res.uri.split('/').pop();
      return { remoteId: res.uri, url: `https://bsky.app/profile/${session.did}/post/${rkey}`, raw: { cid: res.cid } };
    } catch (err) {
      throw this.#toPlatformError(err, { mutating: true });
    }
  }

  async revoke({ credentials, ownerId }) {
    try {
      const client = this.#client(ownerId, this.deps.config.redirectUri);
      await client.revoke(credentials.did);
    } catch (err) {
      this.deps.logger?.warn({ err: err.message }, 'bluesky session revocation failed (continuing disconnect)');
    }
  }

  async fetchPostMetrics({ credentials, account, remoteId }) {
    const session = await this.#restore(credentials, account.ownerId, this.deps.config.redirectUri);
    const agent = this.#agent(session);
    try {
      const { data } = await agent.getPosts({ uris: [remoteId] });
      const post = data.posts?.[0];
      if (!post) throw new PlatformError('The post was not found on Bluesky.', { kind: ERROR_CLASS.PERMANENT, code: 'not_found' });
      return { likes: post.likeCount ?? 0, reposts: post.repostCount ?? 0, replies: post.replyCount ?? 0, quotes: post.quoteCount ?? 0 };
    } catch (err) {
      throw this.#toPlatformError(err, { mutating: false });
    }
  }

  #authFlowError(err, phase) {
    if (err instanceof PlatformError) return err;
    const message = String(err?.message ?? err);
    if (/PUBLIC_URL|https/.test(message) && err?.code === 'public_url_not_https') return err;
    return new PlatformError(
      phase === 'start'
        ? `Could not start Bluesky sign-in: ${message}`
        : `Bluesky sign-in could not be completed: ${message}`,
      { kind: ERROR_CLASS.PERMANENT, code: 'oauth_failed', cause: err },
    );
  }

  /** Map XRPC / OAuth session / network errors to classified PlatformErrors. */
  #toPlatformError(err, { mutating }) {
    if (err instanceof PlatformError) return err;
    if (AUTH_ERROR_NAMES.has(err?.name)) {
      return new PlatformError('The Bluesky session is no longer valid. Please reconnect the account.', { kind: ERROR_CLASS.AUTH, code: err.name, cause: err });
    }
    if (typeof err?.status === 'number' && err.status >= 100) {
      if (AUTH_XRPC_CODES.has(err.error)) {
        return new PlatformError('Bluesky rejected the credentials. Please reconnect the account.', { kind: ERROR_CLASS.AUTH, code: err.error, status: err.status, cause: err });
      }
      const h = err.headers ?? {};
      const retryAfter = parseRetryAfter(h['retry-after']) ?? resetToMs(h['ratelimit-reset']);
      const c = classifyHttpFailure({ status: err.status, headers: { 'retry-after': h['retry-after'] }, mutating, idempotent: false, body: { error: err.error, message: err.message } });
      return new PlatformError(c.message, { kind: c.kind, code: c.code, status: err.status, retryAfterMs: c.retryAfterMs ?? retryAfter, cause: err });
    }
    return classifyNetworkError(err, { mutating, idempotent: false });
  }
}

function resetToMs(value) {
  const epoch = Number(value);
  if (!Number.isFinite(epoch)) return undefined;
  return Math.max(0, epoch * 1000 - Date.now());
}

/** Adapt the namespaced KV to the SimpleStore interface expected by @atproto/oauth-client. */
function kvStore(kv, prefix, ttlSeconds) {
  return {
    async get(key) {
      return (await kv.get(prefix + key)) ?? undefined;
    },
    async set(key, value) {
      await kv.set(prefix + key, value, ttlSeconds ? { ttlSeconds } : undefined);
    },
    async del(key) {
      await kv.delete(prefix + key);
    },
  };
}

export default BlueskyAdapter;
