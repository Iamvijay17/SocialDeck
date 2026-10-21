import { randomBytes } from 'node:crypto';
import { ERROR_CLASS } from '@osh/shared';
import { PlatformAdapter, PlatformError, defineCapabilities, validateAgainstCapabilities } from '@osh/platform-core';
import { GraphClient } from '@osh/adapter-meta-common';

/**
 * Threads adapter (official Threads API).
 * Docs: https://developers.facebook.com/docs/threads/
 *
 * Uses the Threads app id/secret that sit inside your Meta app (the "Threads use case"). Posts are two steps –
 * create a media container, then publish it. Media is downloaded by Threads from a public HTTPS address (media
 * gateway + tunnel); text-only posts need nothing public. Long-lived tokens last 60 days and are refreshed
 * automatically before they expire.
 */

const AUTH_URL = 'https://threads.com/oauth/authorize';
const GRAPH = 'https://graph.threads.com';
const SCOPES = ['threads_basic', 'threads_content_publish'];
const MAX_TEXT = 500;
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60_000;
const REFRESH_WITHIN_MS = 14 * 86_400_000;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

/** Threads counts text in characters, except that emoji count as their UTF-8 byte length. */
export function threadsLength(text) {
  let n = 0;
  for (const ch of text ?? '') n += EMOJI_RE.test(ch) ? Buffer.byteLength(ch, 'utf8') : 1;
  return n;
}

const CAPS = defineCapabilities({
  implemented: true,
  authType: 'oauth2',
  authInputs: [],
  redirectBase: 'oauth',
  requiredScopes: SCOPES,
  text: { maxLength: MAX_TEXT, counting: 'threads' },
  media: {
    maxItems: 20,
    mixedTypes: true,
    requiresPublicUrl: true, // only when the post has media; text-only posts need nothing public
    altText: false,
    image: { mimeTypes: ['image/jpeg', 'image/png'], maxBytes: 8 * 1024 * 1024 },
    video: { mimeTypes: ['video/mp4'], maxBytes: 100 * 1024 * 1024 },
  },
  scheduling: { native: false, minLeadSeconds: 0 },
  idempotentPublish: false,
  tokenRefresh: 'automatic',
  analytics: { postMetrics: [] },
  docsUrl: 'https://developers.facebook.com/docs/threads/',
  notes: [
    'Needs the Threads use case in your Meta app (free) and its separate Threads app ID and secret. Your Threads account must be added as a Threads Tester while the app is in Development mode.',
    'Posts are limited to 500 characters (emoji count by their byte size). Images: JPEG/PNG up to 8 MB. Video: MP4, up to 5 minutes.',
    'Text-only posts need nothing else. Posts with images or video need the public media address (Settings → Public media address), because Threads downloads the files itself.',
    'Tokens last 60 days and are refreshed automatically while the worker runs. If the app is offline for longer than that you must reconnect.',
    'Meta documents a limit of 250 posts per profile per 24 hours.',
    'Engagement metrics are not collected (they need an extra permission that is intentionally not requested).',
  ],
});

export class ThreadsAdapter extends PlatformAdapter {
  constructor(deps) {
    super(deps);
    this.graph = new GraphClient({ fetch: deps.fetch, baseUrl: GRAPH });
  }

  get id() {
    return 'threads';
  }
  get label() {
    return 'Threads';
  }
  get capabilities() {
    return CAPS;
  }
  get configuration() {
    const t = this.deps.config.threads ?? {};
    const missing = [];
    if (!t.appId) missing.push('THREADS_APP_ID');
    if (!t.appSecret) missing.push('THREADS_APP_SECRET');
    return { configured: missing.length === 0, missing };
  }

  async beginAuthorization({ ownerId, redirectUri }) {
    const state = randomBytes(32).toString('base64url');
    await this.deps.kv.set(`state:${state}`, { ownerId, redirectUri }, { ttlSeconds: 600 });
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.deps.config.threads.appId,
      redirect_uri: redirectUri,
      scope: SCOPES.join(','),
      response_type: 'code',
      state,
    }).toString();
    return { authorizationUrl: url.toString() };
  }

  async ownerFromCallback(query) {
    const state = query.get('state');
    const pending = state ? await this.deps.kv.get(`state:${state}`) : null;
    return pending?.ownerId ?? null;
  }

  async completeAuthorization({ ownerId, query, signal }) {
    if (query.get('error')) {
      const e = query.get('error');
      throw new PlatformError(e === 'access_denied' ? 'Authorization was cancelled on Threads.' : `Threads returned an error: ${query.get('error_description') ?? e}`, {
        kind: ERROR_CLASS.PERMANENT,
        code: e,
      });
    }
    const state = query.get('state');
    // Threads appends "#_" to the code in some flows; it is not part of the code.
    const code = query.get('code')?.replace(/#_$/, '');
    const pending = state ? await this.deps.kv.get(`state:${state}`) : null;
    if (!pending || !code) throw new PlatformError('The authorization session expired or is invalid. Please try connecting again.', { kind: ERROR_CLASS.PERMANENT, code: 'invalid_state' });
    await this.deps.kv.delete(`state:${state}`);
    if (pending.ownerId !== ownerId) throw new PlatformError('The authorization session belongs to a different user.', { kind: ERROR_CLASS.PERMANENT, code: 'invalid_state' });

    const { appId, appSecret } = this.deps.config.threads;
    const short = await this.graph.request('POST', '/oauth/access_token', {
      params: { client_id: appId, client_secret: appSecret, code, grant_type: 'authorization_code', redirect_uri: pending.redirectUri },
      signal,
    });
    const long = await this.graph.request('GET', '/access_token', {
      params: { grant_type: 'th_exchange_token', client_secret: appSecret, access_token: short.access_token },
      signal,
    });
    const accessToken = long.access_token ?? short.access_token;
    const expiresAt = long.expires_in ? new Date(Date.now() + Number(long.expires_in) * 1000) : null;
    const me = await this.graph.request('GET', '/v1.0/me', { params: { fields: 'id,username,name,threads_profile_picture_url' }, token: accessToken, signal });
    const userId = String(me.id ?? short.user_id);

    return {
      identity: {
        externalId: userId,
        displayName: me.name || me.username || userId,
        handle: me.username ? `@${me.username}` : undefined,
        avatarUrl: me.threads_profile_picture_url,
      },
      credentials: { userId, accessToken, expiresAt: expiresAt?.toISOString() ?? null },
      scopes: SCOPES,
      expiresAt,
    };
  }

  async validateContent(content) {
    const issues = validateAgainstCapabilities(CAPS, content, threadsLength);
    const media = content.media ?? [];
    if (media.length > 0 && this.deps.publicMedia && !(await this.deps.publicMedia.isConfigured())) {
      issues.push({
        code: 'public_media_not_configured',
        severity: 'error',
        message: 'Threads downloads media from a public HTTPS address. Set it up under Settings → Public media address (see docs/platforms.md), post text only, or post manually.',
      });
    }
    return issues;
  }

  /** Exchange the current long-lived token for a fresh 60-day one (needs to be >= 24 h old and unexpired). */
  async refreshCredentials({ credentials, signal }) {
    const res = await this.graph.request('GET', '/refresh_access_token', {
      params: { grant_type: 'th_refresh_token' },
      token: credentials.accessToken,
      signal,
    });
    const expiresAt = res.expires_in ? new Date(Date.now() + Number(res.expires_in) * 1000) : null;
    return { credentials: { ...credentials, accessToken: res.access_token, expiresAt: expiresAt?.toISOString() ?? null }, expiresAt };
  }

  async #maybeRefresh(credentials, onCredentialsUpdated, signal) {
    const exp = credentials.expiresAt ? Date.parse(credentials.expiresAt) : null;
    if (!exp || exp - Date.now() > REFRESH_WITHIN_MS || !onCredentialsUpdated) return credentials;
    try {
      const fresh = await this.refreshCredentials({ credentials, signal });
      await onCredentialsUpdated(fresh.credentials, fresh.expiresAt);
      return fresh.credentials;
    } catch (err) {
      if (err instanceof PlatformError && err.kind === ERROR_CLASS.AUTH) throw err; // truly expired: user must reconnect
      this.deps.logger?.warn({ code: err.code }, 'threads token refresh failed; continuing with the current token');
      return credentials;
    }
  }

  async verifyCredentials({ credentials, onCredentialsUpdated, signal }) {
    const current = await this.#maybeRefresh(credentials, onCredentialsUpdated, signal);
    await this.graph.request('GET', '/v1.0/me', { params: { fields: 'id,username' }, token: current.accessToken, signal });
    return { expiresAt: current.expiresAt ? new Date(current.expiresAt) : null };
  }

  async publish({ credentials: stored, content, markSending, onCredentialsUpdated, signal }) {
    const credentials = await this.#maybeRefresh(stored, onCredentialsUpdated, signal);
    const { userId, accessToken: token } = credentials;
    const media = content.media ?? [];
    const text = content.text ?? '';
    if (media.some((m) => !m.publicUrl)) {
      throw new PlatformError('No public media address is configured, so Threads cannot download the file. Set it up under Settings → Public media address.', {
        kind: ERROR_CLASS.PERMANENT,
        code: 'public_media_not_configured',
      });
    }
    const create = (params) => this.graph.request('POST', `/v1.0/${userId}/threads`, { params, token, signal });
    const mediaParams = (m) => (m.kind === 'video' ? { media_type: 'VIDEO', video_url: m.publicUrl } : { media_type: 'IMAGE', image_url: m.publicUrl });

    // Containers only register content with Threads; nothing is visible, so failures here are safe to retry.
    let containerId;
    if (media.length === 0) {
      const link = text.match(/https?:\/\/[^\s<>"']+/i)?.[0];
      containerId = (await create({ media_type: 'TEXT', text, ...(link ? { link_attachment: link } : {}) })).id;
    } else if (media.length === 1) {
      containerId = (await create({ ...mediaParams(media[0]), text })).id;
    } else {
      const children = [];
      for (const m of media) children.push((await create({ ...mediaParams(m), is_carousel_item: 'true' })).id);
      for (const id of children) await this.#waitUntilFinished(id, token, signal);
      containerId = (await create({ media_type: 'CAROUSEL', children: children.join(','), text })).id;
    }
    if (!containerId) throw new PlatformError('Threads returned no container id.', { kind: ERROR_CLASS.TRANSIENT, code: 'no_container' });
    await this.#waitUntilFinished(containerId, token, signal);

    await markSending?.();
    const published = await this.graph.request('POST', `/v1.0/${userId}/threads_publish`, { params: { creation_id: containerId }, token, mutating: true, signal });
    if (!published.id) throw new PlatformError('Threads accepted the post but returned no id.', { kind: ERROR_CLASS.AMBIGUOUS, code: 'publish_no_id' });

    let url = null;
    try {
      url = (await this.graph.request('GET', `/v1.0/${published.id}`, { params: { fields: 'permalink' }, token, signal })).permalink ?? null;
    } catch {
      /* the post exists; the link is a convenience */
    }
    return { remoteId: String(published.id), url };
  }

  async #waitUntilFinished(containerId, token, signal) {
    const interval = this.deps.config?.pollIntervalMs ?? POLL_INTERVAL_MS;
    const deadline = Date.now() + (this.deps.config?.pollTimeoutMs ?? POLL_TIMEOUT_MS);
    for (;;) {
      const res = await this.graph.request('GET', `/v1.0/${containerId}`, { params: { fields: 'status,error_message' }, token, signal });
      if (res.status === 'FINISHED' || res.status === 'PUBLISHED') return;
      if (res.status === 'ERROR') {
        throw new PlatformError(`Threads could not process the media${res.error_message ? `: ${String(res.error_message).slice(0, 300)}` : ''}.`, { kind: ERROR_CLASS.PERMANENT, code: 'container_error' });
      }
      if (res.status === 'EXPIRED') throw new PlatformError('The Threads upload expired before it was published. Try again.', { kind: ERROR_CLASS.TRANSIENT, code: 'container_expired' });
      if (Date.now() >= deadline) throw new PlatformError('Threads is still processing the media. It will be retried.', { kind: ERROR_CLASS.TRANSIENT, code: 'container_not_ready' });
      await sleep(interval, signal);
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}

export const threadsAdapter = ThreadsAdapter;
export default ThreadsAdapter;
