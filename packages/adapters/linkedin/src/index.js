import { randomBytes } from 'node:crypto';
import { ERROR_CLASS } from '@osh/shared';
import {
  PlatformAdapter,
  PlatformError,
  classifyHttpFailure,
  classifyNetworkError,
  codePointLength,
  defineCapabilities,
  readJsonBody,
  validateAgainstCapabilities,
} from '@osh/platform-core';

/**
 * LinkedIn adapter – posts to the signed-in member's PERSONAL profile.
 * Docs: https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
 *       https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 *
 * Uses two self-serve LinkedIn products: "Sign In with LinkedIn using OpenID Connect" (scopes openid, profile) to learn
 * who the member is, and "Share on LinkedIn" (scope w_member_social) to post. Company Pages need the Community
 * Management API, which requires LinkedIn's approval, and are therefore not supported.
 * Access tokens last 60 days and cannot be refreshed programmatically by ordinary apps, so the user reconnects.
 */

const AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const API = 'https://api.linkedin.com';
const SCOPES = ['openid', 'profile', 'w_member_social'];
const MAX_TEXT = 3000;

/** Characters with meaning in LinkedIn's "little" text format must be backslash-escaped to appear literally. */
export function escapeLinkedInText(text) {
  return String(text ?? '')
    .replace(/[\\|{}@[\]()<>*_~]/g, '\\$&')
    // '#' directly followed by a word is a hashtag and stays active; any other '#' is escaped.
    .replace(/#(?![\p{L}\p{N}_])/gu, '\\#');
}

const CAPS = defineCapabilities({
  implemented: true,
  authType: 'oauth2',
  authInputs: [],
  redirectBase: 'oauth',
  requiredScopes: SCOPES,
  text: { maxLength: MAX_TEXT, counting: 'characters' },
  media: {
    maxItems: 1,
    mixedTypes: false,
    requiresPublicUrl: false,
    altText: true,
    image: { mimeTypes: ['image/jpeg', 'image/png', 'image/gif'], maxBytes: 8 * 1024 * 1024 },
    video: { mimeTypes: [], maxBytes: 0 },
  },
  scheduling: { native: false, minLeadSeconds: 0 },
  idempotentPublish: false,
  tokenRefresh: 'reauthorize',
  analytics: { postMetrics: [] },
  docsUrl: 'https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin',
  notes: [
    'Posts to your personal profile only. Company Pages need LinkedIn\'s Community Management API, which requires approval – not supported.',
    'Needs a LinkedIn developer app (free) with the "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn" products. The app must be associated with a LinkedIn Page you administer (a free placeholder Page is enough).',
    'Text up to 3,000 characters and one image per post. Video, documents and multi-image posts are not supported.',
    'The access token lasts 60 days and cannot be refreshed automatically: reconnect before it expires (the account shows the date).',
    'LinkedIn documents a limit of 150 requests per member per day.',
    'Engagement metrics are not available to ordinary apps.',
  ],
});

export class LinkedInAdapter extends PlatformAdapter {
  get id() {
    return 'linkedin';
  }
  get label() {
    return 'LinkedIn';
  }
  get capabilities() {
    return CAPS;
  }
  get configuration() {
    const c = this.deps.config.linkedin ?? {};
    const missing = [];
    if (!c.clientId) missing.push('LINKEDIN_CLIENT_ID');
    if (!c.clientSecret) missing.push('LINKEDIN_CLIENT_SECRET');
    return { configured: missing.length === 0, missing };
  }

  async beginAuthorization({ ownerId, redirectUri }) {
    const state = randomBytes(32).toString('base64url');
    await this.deps.kv.set(`state:${state}`, { ownerId, redirectUri }, { ttlSeconds: 600 });
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.deps.config.linkedin.clientId,
      redirect_uri: redirectUri,
      state,
      scope: SCOPES.join(' '),
    }).toString();
    return { authorizationUrl: url.toString() };
  }

  async ownerFromCallback(query) {
    const state = query.get('state');
    const pending = state ? await this.deps.kv.get(`state:${state}`) : null;
    return pending?.ownerId ?? null;
  }

  async completeAuthorization({ ownerId, query, signal }) {
    const err = query.get('error');
    if (err) {
      const friendly = { user_cancelled_login: 'You cancelled the LinkedIn sign-in.', user_cancelled_authorize: 'Authorization was declined on LinkedIn.' }[err];
      throw new PlatformError(friendly ?? `LinkedIn returned an error: ${query.get('error_description') ?? err}`, { kind: ERROR_CLASS.PERMANENT, code: err });
    }
    const state = query.get('state');
    const code = query.get('code');
    const pending = state ? await this.deps.kv.get(`state:${state}`) : null;
    if (!pending || !code) throw new PlatformError('The authorization session expired or is invalid. Please try connecting again.', { kind: ERROR_CLASS.PERMANENT, code: 'invalid_state' });
    await this.deps.kv.delete(`state:${state}`);
    if (pending.ownerId !== ownerId) throw new PlatformError('The authorization session belongs to a different user.', { kind: ERROR_CLASS.PERMANENT, code: 'invalid_state' });

    const { clientId, clientSecret } = this.deps.config.linkedin;
    const { data: token } = await this.#request('POST', TOKEN_URL, {
      form: { grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: pending.redirectUri },
      signal,
    });
    if (!token?.access_token) throw new PlatformError('LinkedIn did not return an access token.', { kind: ERROR_CLASS.PERMANENT, code: 'no_token' });
    const granted = String(token.scope ?? '').split(/[\s,]+/).filter(Boolean);
    if (!granted.includes('w_member_social')) {
      throw new PlatformError('LinkedIn did not grant permission to post (w_member_social). Add the "Share on LinkedIn" product to your LinkedIn app, then connect again.', {
        kind: ERROR_CLASS.PERMANENT,
        code: 'permissions_missing',
      });
    }
    const { data: me } = await this.#request('GET', `${API}/v2/userinfo`, { token: token.access_token, signal });
    if (!me?.sub) throw new PlatformError('Could not read your LinkedIn profile.', { kind: ERROR_CLASS.PERMANENT, code: 'no_profile' });
    const expiresAt = token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000) : null;
    return {
      identity: { externalId: me.sub, displayName: me.name ?? [me.given_name, me.family_name].filter(Boolean).join(' ') ?? me.sub, avatarUrl: me.picture },
      credentials: { sub: me.sub, accessToken: token.access_token, expiresAt: expiresAt?.toISOString() ?? null },
      scopes: granted,
      expiresAt,
    };
  }

  validateContent(content) {
    return validateAgainstCapabilities(CAPS, content, codePointLength);
  }

  async verifyCredentials({ credentials, signal }) {
    await this.#request('GET', `${API}/v2/userinfo`, { token: credentials.accessToken, signal });
    return { expiresAt: credentials.expiresAt ? new Date(credentials.expiresAt) : null };
  }

  async publish({ credentials, content, markSending, signal }) {
    const { sub, accessToken: token } = credentials;
    if (credentials.expiresAt && Date.parse(credentials.expiresAt) <= Date.now()) {
      throw new PlatformError('The LinkedIn access token has expired. Reconnect the account.', { kind: ERROR_CLASS.AUTH, code: 'token_expired' });
    }
    const author = `urn:li:person:${sub}`;
    const media = content.media ?? [];
    const body = {
      author,
      commentary: escapeLinkedInText(content.text ?? ''),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };

    if (media[0]) {
      // Uploading registers an asset that is not visible anywhere, so failures here are safe to retry.
      const { data: init } = await this.#request('POST', `${API}/rest/images?action=initializeUpload`, {
        token,
        json: { initializeUploadRequest: { owner: author } },
        versioned: true,
        signal,
      });
      const uploadUrl = init?.value?.uploadUrl;
      const imageUrn = init?.value?.image;
      if (!uploadUrl || !imageUrn) throw new PlatformError('LinkedIn did not return an upload address.', { kind: ERROR_CLASS.TRANSIENT, code: 'upload_init_failed' });
      await this.#request('PUT', uploadUrl, { token, rawBody: await media[0].blob(), contentType: media[0].mimeType, signal });
      body.content = { media: { id: imageUrn, ...(media[0].altText ? { altText: media[0].altText.slice(0, 4000) } : {}) } };
    }

    await markSending?.();
    const { res } = await this.#request('POST', `${API}/rest/posts`, { token, json: body, versioned: true, mutating: true, signal });
    const urn = res.headers.get('x-restli-id');
    if (!urn) throw new PlatformError('LinkedIn accepted the post but did not return its id.', { kind: ERROR_CLASS.AMBIGUOUS, code: 'no_post_id' });
    return { remoteId: urn, url: `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/` };
  }

  async #request(method, url, { token, form, json, rawBody, contentType, versioned = false, mutating = false, signal } = {}) {
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (versioned) {
      headers['LinkedIn-Version'] = this.deps.config.linkedin.apiVersion;
      headers['X-Restli-Protocol-Version'] = '2.0.0';
    }
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form);
    } else if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (rawBody) {
      if (contentType) headers['content-type'] = contentType;
      body = rawBody;
    }
    let res;
    try {
      res = await this.deps.fetch(url, { method, headers, body, signal });
    } catch (err) {
      throw classifyNetworkError(err, { mutating, idempotent: false });
    }
    if (res.status >= 300 && res.status < 400) {
      throw new PlatformError('LinkedIn redirected the request, which is not allowed.', { kind: ERROR_CLASS.PERMANENT, code: 'redirected', status: res.status });
    }
    let data;
    try {
      data = await readJsonBody(res);
    } catch (err) {
      throw classifyNetworkError(err, { mutating });
    }
    if (!res.ok) {
      const c = classifyHttpFailure({ status: res.status, headers: res.headers, mutating, idempotent: false, body: { error: data?.code ?? data?.error, message: data?.message ?? data?.error_description } });
      const reconnect = c.kind === ERROR_CLASS.AUTH ? ' Reconnect the LinkedIn account.' : '';
      throw new PlatformError(`${c.message}${reconnect}`, { kind: c.kind, code: String(data?.serviceErrorCode ?? c.code), status: res.status, retryAfterMs: c.retryAfterMs });
    }
    return { res, data };
  }
}

export const linkedinAdapter = LinkedInAdapter;
export default LinkedInAdapter;
