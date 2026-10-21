import { MockAdapter, createSafeFetch } from '@osh/platform-core';
import { BlueskyAdapter } from '@osh/adapter-bluesky';
import { MastodonAdapter } from '@osh/adapter-mastodon';
import { InstagramAdapter } from '@osh/adapter-instagram';
import { FacebookAdapter } from '@osh/adapter-facebook';
import { ThreadsAdapter } from '@osh/adapter-threads';
import { LinkedInAdapter } from '@osh/adapter-linkedin';
import { MetaOAuth } from '@osh/adapter-meta-common';
import { xAdapter } from '@osh/adapter-x';
import { PLATFORM_META } from '@osh/shared';
import { createKv } from './kv.js';

/**
 * Build the registry of platform adapters. Adapters receive their collaborators explicitly, so tests can
 * inject mocked fetch implementations and key/value stores.
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.logger
 * @param {object} deps.cipher
 * @param {Function} [deps.fetch]  override outbound fetch (tests)
 * @param {(ns: string) => object} [deps.kvFactory] override kv (tests)
 * @param {{isConfigured: () => Promise<boolean>}} [deps.publicMedia] tells adapters whether media can be fetched publicly
 * @param {object} [deps.overrides] map of platform id -> adapter instance (tests)
 */
export function createAdapterRegistry({ config, logger, cipher, fetch, kvFactory, publicMedia, overrides = {} }) {
  const safeFetch = fetch ?? createSafeFetch({ allowPrivate: config.allowPrivateNetworkTargets });
  const kvFor = kvFactory ?? ((ns) => createKv(cipher, ns));
  const mk = (id, extraConfig = {}, extra = {}) => ({
    fetch: safeFetch,
    kv: kvFor(id),
    logger: logger.child({ platform: id }),
    publicMedia,
    config: {
      publicUrl: config.publicUrl,
      appName: config.appName,
      meta: config.meta,
      threads: config.threads,
      linkedin: config.linkedin,
      ...extraConfig,
    },
    ...extra,
  });

  // Facebook Pages and Instagram share ONE Facebook Login (and one OAuth state store).
  const metaOAuth = new MetaOAuth({ fetch: safeFetch, kv: kvFor('meta'), meta: config.meta, logger: logger.child({ platform: 'meta' }) });

  const adapters = {
    bluesky: new BlueskyAdapter(mk('bluesky', { scope: config.blueskyScope, redirectUri: callbackUrl(config, 'bluesky') })),
    mastodon: new MastodonAdapter(mk('mastodon', { allowInsecureInstances: config.allowPrivateNetworkTargets })),
    instagram: new InstagramAdapter(mk('instagram', {}, { metaOAuth })),
    facebook: new FacebookAdapter(mk('facebook', {}, { metaOAuth })),
    threads: new ThreadsAdapter(mk('threads')),
    linkedin: new LinkedInAdapter(mk('linkedin')),
    x: new xAdapter(mk('x')),
  };
  if (config.enableMockPlatform) adapters.mock = new MockAdapter(mk('mock'));
  Object.assign(adapters, overrides);

  return {
    /** @returns {import('@osh/platform-core').PlatformAdapter|undefined} */
    get: (platform) => adapters[platform],
    list: () => Object.values(adapters),
    ids: () => Object.keys(adapters),
    /** Public description of every platform, safe to send to the browser. Never includes credentials. */
    describe: () =>
      Object.values(adapters).map((a) => ({
        id: a.id,
        label: a.label,
        maturity: a.id === 'mock' ? 'mock' : (PLATFORM_META[a.id]?.maturity ?? 'planned'),
        implemented: a.capabilities.implemented,
        configured: a.configuration.configured,
        missingConfig: a.configuration.missing,
        enabled: a.enabled,
        capabilities: a.capabilities,
      })),
  };
}

/**
 * OAuth redirect URI for a platform. Platforms that insist on https/localhost (Meta, Threads, LinkedIn) use
 * OAUTH_REDIRECT_BASE_URL; the rest use PUBLIC_URL. Instagram shares Facebook's callback.
 */
export function callbackUrl(config, platform, adapter) {
  const callbackPlatform = adapter?.authCallbackPlatform ?? platform;
  const base = adapter?.capabilities.redirectBase === 'oauth' ? config.oauthRedirectBase : config.publicUrl;
  return `${base}/api/accounts/${callbackPlatform}/callback`;
}
