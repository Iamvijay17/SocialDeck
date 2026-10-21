import { ERROR_CLASS } from '@osh/shared';
import { PlatformAdapter, PlatformError, codePointLength, defineCapabilities, validateAgainstCapabilities } from '@osh/platform-core';
import { FACEBOOK_SCOPES, GraphClient, INSTAGRAM_SCOPES, MetaOAuth } from '@osh/adapter-meta-common';

/**
 * Instagram adapter: Instagram API with Facebook Login, content publishing.
 * Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/content-publishing
 *
 * Requirements (see docs/platforms.md): an Instagram *professional* account linked to a Facebook Page, the same
 * Meta app as Facebook Pages, and media that Instagram can download from a public HTTPS URL – provided by the
 * media gateway behind a tunnel. Flow: create container(s) -> wait until FINISHED -> media_publish.
 * Single JPEG image, single video (published as a Reel) or an image carousel (2-10).
 */

const MAX_CAPTION = 2200;
const MAX_HASHTAGS = 30;
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60_000;

const CAPS = defineCapabilities({
  implemented: true,
  authType: 'oauth2',
  authInputs: [],
  redirectBase: 'oauth',
  requiredScopes: [...FACEBOOK_SCOPES, ...INSTAGRAM_SCOPES],
  text: { maxLength: MAX_CAPTION, counting: 'characters' },
  media: {
    maxItems: 10,
    mixedTypes: false,
    requiresPublicUrl: true,
    altText: true,
    image: { mimeTypes: ['image/jpeg'], maxBytes: 8 * 1024 * 1024 },
    video: { mimeTypes: ['video/mp4'], maxBytes: 100 * 1024 * 1024, maxVideos: 1 },
  },
  scheduling: { native: false, minLeadSeconds: 0 },
  idempotentPublish: false,
  tokenRefresh: 'reauthorize',
  analytics: { postMetrics: ['likes', 'comments'] },
  docsUrl: 'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/content-publishing',
  notes: [
    'Only Instagram professional (Business or Creator) accounts can publish through the API, and the account must be linked to a Facebook Page.',
    'Every post needs at least one image or video – text-only posts do not exist on Instagram.',
    'Images must be JPEG (PNG and WebP are rejected by Instagram). A single video is published as a Reel.',
    'Instagram downloads your media from a public HTTPS address, so the media gateway and a tunnel must be set up (Settings → Public media address). Nothing else of your computer is exposed.',
    'Meta documents a limit of about 100 API-published posts per account per 24 hours.',
    'Alt text is sent for single-image posts only.',
    'Uses the same Meta app and Facebook login as Facebook Pages.',
  ],
});

export class InstagramAdapter extends PlatformAdapter {
  constructor(deps) {
    super(deps);
    this.meta =
      deps.metaOAuth ??
      new MetaOAuth({ fetch: deps.fetch, kv: deps.kv, meta: deps.config.meta, logger: deps.logger });
    this.graph = new GraphClient({ fetch: deps.fetch, baseUrl: `https://graph.facebook.com/${deps.config.meta.graphVersion}` });
  }

  get id() {
    return 'instagram';
  }
  get label() {
    return 'Instagram';
  }
  get capabilities() {
    return CAPS;
  }
  get configuration() {
    return this.meta.configuration;
  }
  /** Instagram rides on Facebook Login, so Meta redirects to the Facebook callback route. */
  get authCallbackPlatform() {
    return 'facebook';
  }

  async beginAuthorization({ ownerId, redirectUri }) {
    return this.meta.begin({ ownerId, redirectUri, want: 'instagram' });
  }
  async completeAuthorization({ ownerId, query, signal }) {
    return this.meta.complete({ ownerId, query, signal });
  }
  ownerFromCallback(query) {
    return this.meta.ownerFromCallback(query);
  }

  async validateContent(content) {
    const issues = validateAgainstCapabilities(CAPS, content, codePointLength);
    const media = content.media ?? [];
    if (media.length === 0) {
      // "Add some text or media" from the generic check is replaced by the Instagram-specific rule.
      return [{ code: 'media_required', severity: 'error', message: 'Instagram posts need at least one image or video.' }];
    }
    const hashtags = (content.text ?? '').match(/(^|\s)#[\p{L}\p{N}_]+/gu)?.length ?? 0;
    if (hashtags > MAX_HASHTAGS) {
      issues.push({ code: 'too_many_hashtags', severity: 'error', message: `Instagram allows at most ${MAX_HASHTAGS} hashtags (${hashtags} used).` });
    }
    if (this.deps.publicMedia && !(await this.deps.publicMedia.isConfigured())) {
      issues.push({
        code: 'public_media_not_configured',
        severity: 'error',
        message: 'Instagram downloads media from a public HTTPS address. Set it up under Settings → Public media address (see docs/platforms.md), or post manually.',
      });
    }
    return issues;
  }

  async verifyCredentials({ credentials, signal }) {
    await this.graph.request('GET', `/${credentials.igUserId}`, { params: { fields: 'id,username' }, token: credentials.accessToken, signal });
    return { expiresAt: null };
  }

  async publish({ credentials, content, markSending, signal }) {
    const { igUserId, accessToken: token } = credentials;
    const media = content.media ?? [];
    if (media.length === 0) throw new PlatformError('Instagram posts need at least one image or video.', { kind: ERROR_CLASS.PERMANENT, code: 'media_required' });
    if (media.some((m) => !m.publicUrl)) {
      throw new PlatformError('No public media address is configured, so Instagram cannot download the file. Set it up under Settings → Public media address.', {
        kind: ERROR_CLASS.PERMANENT,
        code: 'public_media_not_configured',
      });
    }

    // Container creation only registers media with Instagram; nothing is visible, so failures here are safe to retry.
    let containerId;
    if (media.length === 1) {
      const m = media[0];
      const params = { caption: content.text ?? '' };
      if (m.kind === 'video') Object.assign(params, { media_type: 'REELS', video_url: m.publicUrl });
      else Object.assign(params, { image_url: m.publicUrl, ...(m.altText ? { alt_text: m.altText.slice(0, 1000) } : {}) });
      containerId = (await this.graph.request('POST', `/${igUserId}/media`, { params, token, signal })).id;
    } else {
      const children = [];
      for (const m of media) {
        const res = await this.graph.request('POST', `/${igUserId}/media`, { params: { image_url: m.publicUrl, is_carousel_item: 'true' }, token, signal });
        children.push(res.id);
      }
      for (const id of children) await this.#waitUntilFinished(id, token, signal);
      containerId = (await this.graph.request('POST', `/${igUserId}/media`, { params: { media_type: 'CAROUSEL', children: children.join(','), caption: content.text ?? '' }, token, signal })).id;
    }
    if (!containerId) throw new PlatformError('Instagram returned no container id.', { kind: ERROR_CLASS.TRANSIENT, code: 'no_container' });
    await this.#waitUntilFinished(containerId, token, signal);

    await markSending?.();
    const published = await this.graph.request('POST', `/${igUserId}/media_publish`, { params: { creation_id: containerId }, token, mutating: true, signal });
    if (!published.id) throw new PlatformError('Instagram accepted the post but returned no media id.', { kind: ERROR_CLASS.AMBIGUOUS, code: 'publish_no_id' });

    let url = null;
    try {
      url = (await this.graph.request('GET', `/${published.id}`, { params: { fields: 'permalink' }, token, signal })).permalink ?? null;
    } catch {
      /* the post exists; the link is a convenience */
    }
    return { remoteId: String(published.id), url };
  }

  async #waitUntilFinished(containerId, token, signal) {
    const interval = this.deps.config?.pollIntervalMs ?? POLL_INTERVAL_MS;
    const deadline = Date.now() + (this.deps.config?.pollTimeoutMs ?? POLL_TIMEOUT_MS);
    for (;;) {
      const res = await this.graph.request('GET', `/${containerId}`, { params: { fields: 'status_code,status' }, token, signal });
      if (res.status_code === 'FINISHED') return;
      if (res.status_code === 'ERROR') {
        throw new PlatformError(`Instagram could not process the media${res.status ? `: ${String(res.status).slice(0, 300)}` : ''}. Check the format and size.`, { kind: ERROR_CLASS.PERMANENT, code: 'container_error' });
      }
      if (res.status_code === 'EXPIRED') {
        throw new PlatformError('The Instagram upload expired before it was published. Try again.', { kind: ERROR_CLASS.TRANSIENT, code: 'container_expired' });
      }
      if (Date.now() >= deadline) {
        throw new PlatformError('Instagram is still processing the media. It will be retried.', { kind: ERROR_CLASS.TRANSIENT, code: 'container_not_ready' });
      }
      await sleep(interval, signal);
    }
  }

  async fetchPostMetrics({ credentials, remoteId, signal }) {
    const res = await this.graph.request('GET', `/${remoteId}`, { params: { fields: 'like_count,comments_count' }, token: credentials.accessToken, signal });
    return { likes: res.like_count ?? 0, comments: res.comments_count ?? 0 };
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

export const instagramAdapter = InstagramAdapter;
export default InstagramAdapter;
