import { ERROR_CLASS } from '@osh/shared';
import { PlatformAdapter, PlatformError, codePointLength, defineCapabilities, validateAgainstCapabilities } from '@osh/platform-core';
import { FACEBOOK_SCOPES, GraphClient, MetaOAuth } from '@osh/adapter-meta-common';

/**
 * Facebook Pages adapter (official Graph API, Facebook Login).
 * Docs: https://developers.facebook.com/docs/pages-api/posts/
 *
 * Publishes to Pages you can create content on – not personal profiles or groups. Text and links go to
 * POST /{page-id}/feed, photos are uploaded as binary (no public URL needed) and attached to the post, and videos
 * are uploaded to /{page-id}/videos. Graph offers no idempotency key, so an ambiguous outcome is never retried
 * automatically.
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const CAPS = defineCapabilities({
  implemented: true,
  authType: 'oauth2',
  authInputs: [],
  redirectBase: 'oauth',
  requiredScopes: FACEBOOK_SCOPES,
  text: { maxLength: 63_206, counting: 'characters' },
  media: {
    maxItems: 10,
    mixedTypes: false,
    requiresPublicUrl: false,
    altText: true,
    image: { mimeTypes: ['image/jpeg', 'image/png', 'image/gif'], maxBytes: MAX_IMAGE_BYTES },
    video: { mimeTypes: ['video/mp4'], maxBytes: 100 * 1024 * 1024, maxVideos: 1 },
  },
  scheduling: { native: false, minLeadSeconds: 0 },
  idempotentPublish: false,
  tokenRefresh: 'reauthorize',
  analytics: { postMetrics: ['reactions', 'comments', 'shares'] },
  docsUrl: 'https://developers.facebook.com/docs/pages-api/posts/',
  notes: [
    'Publishes to Facebook Pages you can create content on. Personal profiles and groups are not supported by the API.',
    'Requires your own Meta developer app (free). While the app is in Development mode only people with a role on the app can use it – enough for your own Pages.',
    'Page tokens do not expire by time, but stop working if you remove the app, change your Facebook password or lose Page access. The account then shows "Reconnect needed".',
    'Removing the app on Facebook (Settings → Business integrations) is how to revoke access completely; disconnecting here deletes the stored token.',
    'Links in the text are attached as a link preview when the post has no images.',
  ],
});

export class FacebookAdapter extends PlatformAdapter {
  constructor(deps) {
    super(deps);
    this.meta =
      deps.metaOAuth ??
      new MetaOAuth({ fetch: deps.fetch, kv: deps.kv, meta: deps.config.meta, logger: deps.logger });
    this.graph = new GraphClient({ fetch: deps.fetch, baseUrl: `https://graph.facebook.com/${deps.config.meta.graphVersion}` });
  }

  get id() {
    return 'facebook';
  }
  get label() {
    return 'Facebook Pages';
  }
  get capabilities() {
    return CAPS;
  }
  get configuration() {
    return this.meta.configuration;
  }

  async beginAuthorization({ ownerId, redirectUri }) {
    return this.meta.begin({ ownerId, redirectUri, want: 'facebook' });
  }
  async completeAuthorization({ ownerId, query, signal }) {
    return this.meta.complete({ ownerId, query, signal });
  }
  ownerFromCallback(query) {
    return this.meta.ownerFromCallback(query);
  }

  validateContent(content) {
    const issues = validateAgainstCapabilities(CAPS, content, codePointLength);
    // GIFs and PNGs are fine; WebP is not accepted by the photos endpoint.
    return issues;
  }

  async verifyCredentials({ credentials, signal }) {
    await this.graph.request('GET', `/${credentials.pageId}`, { params: { fields: 'id,name' }, token: credentials.accessToken, signal });
    return { expiresAt: null };
  }

  async publish({ credentials, content, markSending, signal }) {
    const { pageId, accessToken: token } = credentials;
    const media = content.media ?? [];
    const text = content.text ?? '';

    // Video: one multipart request creates the post.
    if (media.length === 1 && media[0].kind === 'video') {
      const form = new FormData();
      form.set('source', await media[0].blob(), 'video.mp4');
      if (text) form.set('description', text);
      await markSending?.();
      const res = await this.graph.request('POST', `/${pageId}/videos`, { multipart: form, token, mutating: true, signal });
      return { remoteId: String(res.id), url: `https://www.facebook.com/watch/?v=${res.id}` };
    }

    // Photos: upload unpublished (safe to retry: nothing is visible yet), then attach to one feed post.
    const photoIds = [];
    for (const m of media) {
      const form = new FormData();
      form.set('source', await m.blob(), `photo.${m.mimeType.split('/')[1] === 'jpeg' ? 'jpg' : m.mimeType.split('/')[1]}`);
      form.set('published', 'false');
      if (m.altText) form.set('alt_text_custom', m.altText.slice(0, 1500));
      const res = await this.graph.request('POST', `/${pageId}/photos`, { multipart: form, token, mutating: false, signal });
      if (!res.id) throw new PlatformError('Facebook accepted the photo but returned no id.', { kind: ERROR_CLASS.TRANSIENT, code: 'photo_no_id' });
      photoIds.push(res.id);
    }

    const params = { message: text };
    photoIds.forEach((id, i) => {
      params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
    });
    if (!photoIds.length) {
      const link = text.match(/https?:\/\/[^\s<>"']+/i)?.[0];
      if (link) params.link = link;
    }
    await markSending?.();
    const res = await this.graph.request('POST', `/${pageId}/feed`, { params, token, mutating: true, signal });
    if (!res.id) throw new PlatformError('Facebook accepted the post but returned no id.', { kind: ERROR_CLASS.AMBIGUOUS, code: 'feed_no_id' });
    return { remoteId: String(res.id), url: `https://www.facebook.com/${res.id}` };
  }

  async fetchPostMetrics({ credentials, remoteId, signal }) {
    const res = await this.graph.request('GET', `/${remoteId}`, {
      params: { fields: 'reactions.summary(true).limit(0),comments.summary(true).limit(0),shares' },
      token: credentials.accessToken,
      signal,
    });
    return {
      reactions: res.reactions?.summary?.total_count ?? 0,
      comments: res.comments?.summary?.total_count ?? 0,
      shares: res.shares?.count ?? 0,
    };
  }
}

export const facebookAdapter = FacebookAdapter;
export default FacebookAdapter;
