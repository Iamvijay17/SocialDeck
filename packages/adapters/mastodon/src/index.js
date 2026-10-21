import { createHash, randomBytes } from 'node:crypto';
import { ERROR_CLASS } from '@osh/shared';
import {
  PlatformAdapter,
  PlatformError,
  classifyHttpFailure,
  classifyNetworkError,
  defineCapabilities,
  mastodonLength,
  readJsonBody,
  validateAgainstCapabilities,
} from '@osh/platform-core';

/**
 * Mastodon adapter (official REST + OAuth 2 API, also works with API-compatible servers).
 * Docs: https://docs.joinmastodon.org/methods/statuses/
 *
 * - Per-instance dynamic app registration (POST /api/v1/apps), cached per (instance, redirect URI).
 * - Authorization code flow with PKCE (S256; ignored by servers that do not support it).
 * - Minimum scopes: `profile write:statuses write:media` (`read:accounts` replaces `profile` on servers older than 4.3).
 * - Posting uses an Idempotency-Key header (kept by Mastodon for up to one hour), so retries of ambiguous
 *   failures inside that window cannot create duplicate statuses.
 */

const FALLBACK_LIMITS = { maxCharacters: 500, maxMedia: 4, urlLength: 23, imageBytes: 16 * 1024 * 1024, videoBytes: 99 * 1024 * 1024 };
const INSTANCE_CACHE_MS = 10 * 60_000;
const MEDIA_POLL_INTERVAL_MS = 2000;
const MEDIA_POLL_MAX_MS = 90_000;

export const MASTODON_SCOPES_MODERN = ['profile', 'write:statuses', 'write:media'];
export const MASTODON_SCOPES_LEGACY = ['read:accounts', 'write:statuses', 'write:media'];

const CAPS = defineCapabilities({
  implemented: true,
  authType: 'oauth2',
  authInputs: [{ name: 'instance', label: 'Server', placeholder: 'mastodon.social', required: true }],
  requiredScopes: MASTODON_SCOPES_MODERN,
  text: { maxLength: 500, counting: 'mastodon' },
  media: {
    maxItems: 4,
    mixedTypes: false,
    altText: true,
    image: { mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], maxBytes: FALLBACK_LIMITS.imageBytes },
    video: { mimeTypes: ['video/mp4', 'video/webm'], maxBytes: FALLBACK_LIMITS.videoBytes, maxVideos: 1 },
  },
  scheduling: { native: true, minLeadSeconds: 300 },
  idempotentPublish: true,
  idempotencyWindowSeconds: 3600,
  tokenRefresh: 'none',
  analytics: { postMetrics: ['favourites', 'reblogs', 'replies'] },
  notes: [
    'Limits (characters, attachments, file sizes) come from the selected server and are checked against it.',
    'Access tokens do not expire but can be revoked by the user or the server at any time.',
    'Native scheduled statuses are supported by the adapter, but the app currently schedules with its own queue.',
  ],
});

export class MastodonAdapter extends PlatformAdapter {
  #instanceCache = new Map();

  get id() {
    return 'mastodon';
  }
  get label() {
    return 'Mastodon';
  }
  get capabilities() {
    return CAPS;
  }

  baseUrl(instance) {
    const insecure = this.deps.config?.allowInsecureInstances && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(instance);
    return `${insecure ? 'http' : 'https'}://${instance}`;
  }

  /** Fetch (and cache) instance info: version and limits. */
  async getInstanceInfo(instance, { force = false, signal } = {}) {
    const cached = this.#instanceCache.get(instance);
    if (!force && cached && Date.now() - cached.at < INSTANCE_CACHE_MS) return cached.info;
    const base = this.baseUrl(instance);
    let data;
    try {
      ({ data } = await this.#request('GET', `${base}/api/v2/instance`, { signal }));
    } catch (err) {
      if (!(err instanceof PlatformError) || err.status !== 404) throw this.#asInstanceError(err, instance);
      try {
        ({ data } = await this.#request('GET', `${base}/api/v1/instance`, { signal }));
      } catch (err2) {
        throw this.#asInstanceError(err2, instance);
      }
    }
    if (!data || typeof data !== 'object' || !(data.version || data.configuration)) {
      throw new PlatformError(`${instance} does not look like a Mastodon-compatible server.`, { kind: ERROR_CLASS.PERMANENT, code: 'not_mastodon' });
    }
    const cfg = data.configuration ?? {};
    const info = {
      version: String(data.version ?? ''),
      title: data.title,
      maxCharacters: cfg.statuses?.max_characters ?? data.max_toot_chars ?? FALLBACK_LIMITS.maxCharacters,
      maxMedia: cfg.statuses?.max_media_attachments ?? FALLBACK_LIMITS.maxMedia,
      urlLength: cfg.statuses?.characters_reserved_per_url ?? FALLBACK_LIMITS.urlLength,
      imageBytes: cfg.media_attachments?.image_size_limit ?? FALLBACK_LIMITS.imageBytes,
      videoBytes: cfg.media_attachments?.video_size_limit ?? FALLBACK_LIMITS.videoBytes,
      mimeTypes: cfg.media_attachments?.supported_mime_types ?? CAPS.media.image.mimeTypes.concat(CAPS.media.video.mimeTypes),
    };
    this.#instanceCache.set(instance, { at: Date.now(), info });
    return info;
  }

  #asInstanceError(err, instance) {
    if (err instanceof PlatformError && err.code === 'not_mastodon') return err;
    const msg = err instanceof PlatformError ? err.message : String(err?.message ?? err);
    return new PlatformError(`Could not contact ${instance}: ${msg}`, { kind: ERROR_CLASS.PERMANENT, code: 'instance_unreachable', cause: err });
  }

  scopesFor(version) {
    const [major, minor] = String(version).split('.').map((n) => parseInt(n, 10));
    const modern = Number.isFinite(major) && (major > 4 || (major === 4 && (minor ?? 0) >= 3));
    return modern ? MASTODON_SCOPES_MODERN : MASTODON_SCOPES_LEGACY;
  }

  async beginAuthorization({ ownerId, redirectUri, input, signal }) {
    const instance = input?.instance;
    if (!instance) throw new PlatformError('Enter the server you want to connect (for example mastodon.social).', { kind: ERROR_CLASS.PERMANENT, code: 'instance_required' });
    const base = this.baseUrl(instance);
    const info = await this.getInstanceInfo(instance, { force: true, signal });
    const scopes = this.scopesFor(info.version);

    const app = await this.#getOrRegisterApp({ instance, base, redirectUri, scopes, signal });
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await this.deps.kv.set(`state:${state}`, { ownerId, instance, verifier, redirectUri, scopes }, { ttlSeconds: 600 });

    const url = new URL(`${base}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: app.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return { authorizationUrl: url.toString() };
  }

  async #getOrRegisterApp({ instance, base, redirectUri, scopes, signal }) {
    const key = `app:${instance}|${redirectUri}|${scopes.join(' ')}`;
    const existing = await this.deps.kv.get(key);
    if (existing?.clientId && existing?.clientSecret) return existing;
    const { data } = await this.#request('POST', `${base}/api/v1/apps`, {
      signal,
      json: { client_name: this.deps.config?.appName ?? 'Private Social Manager', redirect_uris: redirectUri, scopes: scopes.join(' ') },
    });
    if (!data?.client_id || !data?.client_secret) {
      throw new PlatformError(`${instance} did not return application credentials.`, { kind: ERROR_CLASS.PERMANENT, code: 'app_registration_failed' });
    }
    const app = { clientId: data.client_id, clientSecret: data.client_secret };
    await this.deps.kv.set(key, app);
    return app;
  }

  async completeAuthorization({ ownerId, query, signal }) {
    const error = query.get('error');
    if (error) {
      throw new PlatformError(error === 'access_denied' ? 'Authorization was declined on the server.' : `The server returned an error: ${query.get('error_description') ?? error}`, {
        kind: ERROR_CLASS.PERMANENT,
        code: error,
      });
    }
    const state = query.get('state');
    const code = query.get('code');
    const pending = state ? await this.deps.kv.get(`state:${state}`) : null;
    if (!pending || !code) throw new PlatformError('The authorization session expired or is invalid. Please try connecting again.', { kind: ERROR_CLASS.PERMANENT, code: 'invalid_state' });
    await this.deps.kv.delete(`state:${state}`); // single use
    if (pending.ownerId !== ownerId) throw new PlatformError('The authorization session belongs to a different user.', { kind: ERROR_CLASS.PERMANENT, code: 'invalid_state' });

    const { instance, scopes } = pending;
    const base = this.baseUrl(instance);
    const app = await this.deps.kv.get(`app:${instance}|${pending.redirectUri}|${scopes.join(' ')}`);
    if (!app) throw new PlatformError('Application registration was lost. Please try connecting again.', { kind: ERROR_CLASS.PERMANENT, code: 'app_missing' });

    const { data: token } = await this.#request('POST', `${base}/oauth/token`, {
      signal,
      json: {
        grant_type: 'authorization_code',
        code,
        client_id: app.clientId,
        client_secret: app.clientSecret,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
        scope: scopes.join(' '),
      },
    });
    if (!token?.access_token) throw new PlatformError('The server did not return an access token.', { kind: ERROR_CLASS.PERMANENT, code: 'no_token' });

    const { data: me } = await this.#request('GET', `${base}/api/v1/accounts/verify_credentials`, { token: token.access_token, signal });
    if (!me?.username) throw new PlatformError('Could not read the account profile.', { kind: ERROR_CLASS.PERMANENT, code: 'no_profile' });
    return {
      identity: {
        externalId: `${me.username}@${instance}`.toLowerCase(),
        displayName: me.display_name || me.username,
        handle: `@${me.username}@${instance}`,
        avatarUrl: me.avatar,
        instance,
      },
      credentials: { instance, accessToken: token.access_token, clientId: app.clientId, clientSecret: app.clientSecret },
      scopes: String(token.scope ?? scopes.join(' ')).split(/\s+/).filter(Boolean),
      expiresAt: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000) : null,
    };
  }

  async validateContent(content, ctx = {}) {
    const instance = ctx.account?.instance;
    let info = null;
    if (instance) {
      try {
        info = await this.getInstanceInfo(instance);
      } catch {
        info = null; // fall back to defaults; the publish call will report real problems
      }
    }
    const caps = info
      ? defineCapabilities({
          ...CAPS,
          text: { maxLength: info.maxCharacters, counting: 'mastodon' },
          media: {
            ...CAPS.media,
            maxItems: info.maxMedia,
            image: { ...CAPS.media.image, maxBytes: info.imageBytes, mimeTypes: CAPS.media.image.mimeTypes.filter((t) => info.mimeTypes.includes(t)) },
            video: { ...CAPS.media.video, maxBytes: info.videoBytes, mimeTypes: CAPS.media.video.mimeTypes.filter((t) => info.mimeTypes.includes(t)) },
          },
        })
      : CAPS;
    return validateAgainstCapabilities(caps, content, (t) => mastodonLength(t, info?.urlLength));
  }

  async verifyCredentials({ credentials, signal }) {
    const base = this.baseUrl(credentials.instance);
    await this.#request('GET', `${base}/api/v1/accounts/verify_credentials`, { token: credentials.accessToken, signal });
    return { expiresAt: null };
  }

  async publish({ credentials, content, idempotencyKey, signal, markSending, options }) {
    const base = this.baseUrl(credentials.instance);
    const mediaIds = [];
    for (const m of content.media ?? []) {
      mediaIds.push(await this.#uploadMedia(base, credentials.accessToken, m, signal));
    }
    await markSending?.();
    const body = { status: content.text ?? '', visibility: options?.visibility ?? 'public' };
    if (mediaIds.length) body.media_ids = mediaIds;
    const { data } = await this.#request('POST', `${base}/api/v1/statuses`, {
      token: credentials.accessToken,
      signal,
      json: body,
      headers: { 'Idempotency-Key': idempotencyKey },
      mutating: true,
      idempotent: true,
    });
    if (!data?.id) {
      throw new PlatformError('The server accepted the request but returned no status id.', { kind: ERROR_CLASS.AMBIGUOUS, code: 'no_status_id' });
    }
    return { remoteId: String(data.id), url: data.url ?? data.uri ?? null, raw: { visibility: data.visibility } };
  }

  /**
   * Schedule natively on the instance (scheduled_at must be >= 5 minutes ahead).
   * Not wired into the default flow; provided because the API supports it.
   */
  async scheduleNative({ credentials, content, idempotencyKey, scheduledAt, signal }) {
    if (scheduledAt.getTime() - Date.now() < 5 * 60_000) {
      throw new PlatformError('Mastodon requires scheduled posts to be at least 5 minutes in the future.', { kind: ERROR_CLASS.PERMANENT, code: 'schedule_too_soon' });
    }
    const base = this.baseUrl(credentials.instance);
    const mediaIds = [];
    for (const m of content.media ?? []) mediaIds.push(await this.#uploadMedia(base, credentials.accessToken, m, signal));
    const body = { status: content.text ?? '', scheduled_at: scheduledAt.toISOString() };
    if (mediaIds.length) body.media_ids = mediaIds;
    const { data } = await this.#request('POST', `${base}/api/v1/statuses`, {
      token: credentials.accessToken, signal, json: body, headers: { 'Idempotency-Key': idempotencyKey }, mutating: true, idempotent: true,
    });
    return { remoteId: String(data.id), url: null, raw: { scheduled: true } };
  }

  async #uploadMedia(base, token, media, signal) {
    const form = new FormData();
    form.set('file', await media.blob(), `upload.${media.mimeType.split('/')[1] === 'jpeg' ? 'jpg' : media.mimeType.split('/')[1]}`);
    if (media.altText) form.set('description', media.altText);
    const { res, data } = await this.#request('POST', `${base}/api/v2/media`, { token, signal, form });
    if (!data?.id) throw new PlatformError('Media upload returned no id.', { kind: ERROR_CLASS.TRANSIENT, code: 'media_no_id' });
    if (res.status !== 202 && data.url) return String(data.id);

    // Asynchronous processing (videos, large images): poll until the attachment is ready.
    const deadline = Date.now() + MEDIA_POLL_MAX_MS;
    while (Date.now() < deadline) {
      await sleep(this.deps.config?.mediaPollIntervalMs ?? MEDIA_POLL_INTERVAL_MS, signal);
      const poll = await this.#request('GET', `${base}/api/v1/media/${encodeURIComponent(data.id)}`, { token, signal, acceptStatus: [206] });
      if (poll.res.status === 200) return String(data.id);
    }
    throw new PlatformError('The server is still processing the media. Try again later.', { kind: ERROR_CLASS.TRANSIENT, code: 'media_processing_timeout' });
  }

  async revoke({ credentials, signal }) {
    if (!credentials?.accessToken || !credentials?.clientId) return;
    try {
      await this.#request('POST', `${this.baseUrl(credentials.instance)}/oauth/revoke`, {
        signal,
        json: { client_id: credentials.clientId, client_secret: credentials.clientSecret, token: credentials.accessToken },
      });
    } catch (err) {
      this.deps.logger?.warn({ err: err.message, code: err.code }, 'mastodon token revocation failed (continuing disconnect)');
    }
  }

  async fetchPostMetrics({ credentials, remoteId, signal }) {
    const base = this.baseUrl(credentials.instance);
    const { data } = await this.#request('GET', `${base}/api/v1/statuses/${encodeURIComponent(remoteId)}`, { token: credentials.accessToken, signal });
    return { favourites: data.favourites_count ?? 0, reblogs: data.reblogs_count ?? 0, replies: data.replies_count ?? 0 };
  }

  /**
   * Single place for HTTP: builds the request, converts failures to classified PlatformErrors.
   * Never puts the token or response bodies into error messages beyond the server's own error text.
   */
  async #request(method, url, { token, json, form, headers = {}, signal, mutating = false, idempotent = false, acceptStatus = [] } = {}) {
    const h = { accept: 'application/json', ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) {
      body = form;
    }
    let res;
    try {
      res = await this.deps.fetch(url, { method, headers: h, body, signal });
    } catch (err) {
      throw classifyNetworkError(err, { mutating, idempotent });
    }
    if (res.status >= 300 && res.status < 400 && !acceptStatus.includes(res.status)) {
      const where = res.headers.get('location');
      throw new PlatformError(`The server redirected the request${where ? ` to ${new URL(where, url).host}` : ''}. Use the final server hostname.`, {
        kind: ERROR_CLASS.PERMANENT,
        code: 'redirected',
        status: res.status,
      });
    }
    let data;
    try {
      data = await readJsonBody(res);
    } catch (err) {
      throw classifyNetworkError(err, { mutating, idempotent });
    }
    if (!res.ok && !acceptStatus.includes(res.status)) {
      const c = classifyHttpFailure({ status: res.status, headers: res.headers, mutating, idempotent, body: data });
      throw new PlatformError(c.message, { kind: c.kind, code: c.code, status: res.status, retryAfterMs: c.retryAfterMs });
    }
    return { res, data };
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

export default MastodonAdapter;
