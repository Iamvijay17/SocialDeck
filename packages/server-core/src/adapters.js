import { MockAdapter, createSafeFetch } from '@osh/platform-core';
import { BlueskyAdapter } from '@osh/adapter-bluesky';
import { MastodonAdapter } from '@osh/adapter-mastodon';
import { instagramAdapter } from '@osh/adapter-instagram';
import { facebookAdapter } from '@osh/adapter-facebook';
import { threadsAdapter } from '@osh/adapter-threads';
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
 * @param {object} [deps.overrides] map of platform id -> adapter instance (tests)
 */
export function createAdapterRegistry({ config, logger, cipher, fetch, kvFactory, overrides = {} }) {
  const safeFetch = fetch ?? createSafeFetch({ allowPrivate: config.allowPrivateNetworkTargets });
  const mk = (id, extraConfig = {}) => ({
    fetch: safeFetch,
    kv: (kvFactory ?? ((ns) => createKv(cipher, ns)))(id),
    logger: logger.child({ platform: id }),
    config: { publicUrl: config.publicUrl, appName: config.appName, ...extraConfig },
  });

  const adapters = {
    bluesky: new BlueskyAdapter(
      mk('bluesky', { scope: config.blueskyScope, redirectUri: callbackUrl(config, 'bluesky') }),
    ),
    mastodon: new MastodonAdapter(mk('mastodon', { allowInsecureInstances: config.allowPrivateNetworkTargets })),
    instagram: new instagramAdapter(mk('instagram')),
    facebook: new facebookAdapter(mk('facebook')),
    threads: new threadsAdapter(mk('threads')),
    x: new xAdapter(mk('x')),
  };
  if (config.enableMockPlatform) adapters.mock = new MockAdapter(mk('mock'));
  Object.assign(adapters, overrides);

  return {
    /** @returns {import('@osh/platform-core').PlatformAdapter|undefined} */
    get: (platform) => adapters[platform],
    list: () => Object.values(adapters),
    ids: () => Object.keys(adapters),
    /** Public description of every platform, safe to send to the browser. */
    describe: () =>
      Object.values(adapters).map((a) => ({
        id: a.id,
        label: a.label,
        maturity: a.id === 'mock' ? 'mock' : (PLATFORM_META[a.id]?.maturity ?? 'planned'),
        enabled: a.enabled,
        capabilities: a.capabilities,
      })),
  };
}

export function callbackUrl(config, platform) {
  return `${config.publicUrl}/api/accounts/${platform}/callback`;
}
