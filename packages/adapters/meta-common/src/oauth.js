import { randomBytes } from 'node:crypto';
import { ERROR_CLASS } from '@osh/shared';
import { PlatformError } from '@osh/platform-core';
import { GraphClient } from './graph.js';

export const FACEBOOK_SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'];
export const INSTAGRAM_SCOPES = ['instagram_basic', 'instagram_content_publish'];

/**
 * One Facebook Login for both Facebook Pages and Instagram (Instagram API with Facebook Login): the user picks the
 * Pages to share in Facebook's dialog; every selected Page becomes a Facebook account, and a Page's linked Instagram
 * professional account becomes an Instagram account. The stored credential is the Page access token, which does not
 * expire by time (it stops working if the user revokes the app or changes their password).
 *
 * The OAuth `state` is random, single use, bound to the owner, and kept (encrypted) in the key/value store, so the
 * callback can be completed without the dashboard session cookie – needed when Meta redirects to http://localhost
 * while the dashboard runs on http://127.0.0.1.
 */
export class MetaOAuth {
  /**
   * @param {object} deps
   * @param {Function} deps.fetch
   * @param {{get: Function, set: Function, delete: Function}} deps.kv
   * @param {{appId: string, appSecret: string, graphVersion: string}} deps.meta
   * @param {object} [deps.logger]
   */
  constructor({ fetch, kv, meta, logger }) {
    this.kv = kv;
    this.meta = meta;
    this.logger = logger;
    this.graph = new GraphClient({ fetch, baseUrl: `https://graph.facebook.com/${meta.graphVersion}` });
  }

  get configuration() {
    const missing = [];
    if (!this.meta.appId) missing.push('META_APP_ID');
    if (!this.meta.appSecret) missing.push('META_APP_SECRET');
    return { configured: missing.length === 0, missing };
  }

  scopesFor(want) {
    return want === 'instagram' ? [...FACEBOOK_SCOPES, ...INSTAGRAM_SCOPES] : FACEBOOK_SCOPES;
  }

  /** @param {{ownerId: string, redirectUri: string, want: 'facebook'|'instagram'}} ctx */
  async begin({ ownerId, redirectUri, want }) {
    const state = randomBytes(32).toString('base64url');
    await this.kv.set(`state:${state}`, { ownerId, redirectUri, want }, { ttlSeconds: 600 });
    const url = new URL(`https://www.facebook.com/${this.meta.graphVersion}/dialog/oauth`);
    url.search = new URLSearchParams({
      client_id: this.meta.appId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      scope: this.scopesFor(want).join(','),
    }).toString();
    return { authorizationUrl: url.toString() };
  }

  async ownerFromCallback(query) {
    const state = query.get('state');
    const pending = state ? await this.kv.get(`state:${state}`) : null;
    return pending?.ownerId ?? null;
  }

  /** @returns {Promise<{accounts: object[]}>} */
  async complete({ ownerId, query, signal }) {
    const denied = query.get('error');
    if (denied) {
      throw new PlatformError(
        denied === 'access_denied' ? 'Authorization was cancelled on Facebook.' : `Facebook returned an error: ${query.get('error_description') ?? denied}`,
        { kind: ERROR_CLASS.PERMANENT, code: denied },
      );
    }
    const state = query.get('state');
    const code = query.get('code');
    const pending = state ? await this.kv.get(`state:${state}`) : null;
    if (!pending || !code) {
      throw new PlatformError('The authorization session expired or is invalid. Please try connecting again.', { kind: ERROR_CLASS.PERMANENT, code: 'invalid_state' });
    }
    await this.kv.delete(`state:${state}`); // single use
    if (pending.ownerId !== ownerId) {
      throw new PlatformError('The authorization session belongs to a different user.', { kind: ERROR_CLASS.PERMANENT, code: 'invalid_state' });
    }

    const { appId, appSecret } = this.meta;
    const short = await this.graph.request('GET', '/oauth/access_token', {
      params: { client_id: appId, client_secret: appSecret, redirect_uri: pending.redirectUri, code },
      signal,
    });
    const long = await this.graph.request('GET', '/oauth/access_token', {
      params: { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token },
      signal,
    });
    const userToken = long.access_token ?? short.access_token;

    const granted = await this.#grantedPermissions(userToken, signal);
    const missing = this.scopesFor(pending.want).filter((s) => !granted.includes(s));
    if (missing.length) {
      throw new PlatformError(`These permissions were not granted: ${missing.join(', ')}. Connect again and approve everything that is requested.`, {
        kind: ERROR_CLASS.PERMANENT,
        code: 'permissions_missing',
      });
    }

    const pages = await this.#listPages(userToken, signal);
    const publishable = pages.filter((p) => !Array.isArray(p.tasks) || p.tasks.includes('CREATE_CONTENT'));
    if (!publishable.length) {
      throw new PlatformError(
        'No Facebook Pages you can post to were shared with the app. Connect again, choose the Pages in Facebook\'s dialog, and make sure you can create content on them.',
        { kind: ERROR_CLASS.PERMANENT, code: 'no_pages' },
      );
    }

    const expiresAt = await this.#tokenExpiry(userToken, signal);
    const accounts = [];
    for (const page of publishable) {
      if (pending.want === 'facebook') {
        accounts.push({
          platform: 'facebook',
          identity: { externalId: page.id, displayName: page.name, handle: page.username ? `@${page.username}` : undefined, avatarUrl: page.picture?.data?.url },
          credentials: { pageId: page.id, accessToken: page.access_token },
          scopes: granted.filter((s) => FACEBOOK_SCOPES.includes(s)),
          expiresAt,
        });
      } else if (page.instagram_business_account?.id) {
        const ig = page.instagram_business_account;
        accounts.push({
          platform: 'instagram',
          identity: { externalId: ig.id, displayName: ig.username ?? ig.name ?? ig.id, handle: ig.username ? `@${ig.username}` : undefined, avatarUrl: ig.profile_picture_url },
          credentials: { pageId: page.id, igUserId: ig.id, accessToken: page.access_token },
          scopes: granted.filter((s) => [...FACEBOOK_SCOPES, ...INSTAGRAM_SCOPES].includes(s)),
          expiresAt,
        });
      }
    }
    if (!accounts.length) {
      throw new PlatformError(
        'None of your Pages has an Instagram professional account linked. In Instagram: Settings → Account type → switch to Professional, then link it to your Facebook Page, and connect again.',
        { kind: ERROR_CLASS.PERMANENT, code: 'no_instagram_account' },
      );
    }
    return { accounts };
  }

  async #grantedPermissions(token, signal) {
    const res = await this.graph.request('GET', '/me/permissions', { token, signal });
    return (res.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission);
  }

  async #listPages(token, signal) {
    const fields = 'id,name,username,access_token,tasks,picture{url},instagram_business_account{id,username,name,profile_picture_url}';
    const pages = [];
    let after;
    for (let i = 0; i < 10; i++) {
      const res = await this.graph.request('GET', '/me/accounts', { params: { fields, limit: 50, after }, token, signal });
      pages.push(...(res.data ?? []));
      after = res.paging?.cursors?.after;
      if (!res.paging?.next || !after) break;
    }
    return pages;
  }

  /** Best effort: when Meta says the user's data access lapses, show it as the connection's expiry. */
  async #tokenExpiry(token, signal) {
    try {
      const res = await this.graph.request('GET', '/debug_token', {
        params: { input_token: token },
        token: `${this.meta.appId}|${this.meta.appSecret}`,
        signal,
      });
      const d = res.data ?? {};
      const secs = [d.data_access_expires_at, d.expires_at].filter((n) => Number.isFinite(n) && n > 0);
      return secs.length ? new Date(Math.min(...secs) * 1000) : null;
    } catch (err) {
      this.logger?.warn({ code: err.code }, 'could not read Meta token expiry');
      return null;
    }
  }
}
