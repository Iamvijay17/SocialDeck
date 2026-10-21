import { randomUUID } from 'node:crypto';
import { ERROR_CLASS } from '@osh/shared';
import { PlatformAdapter, defineCapabilities, validateAgainstCapabilities } from './adapter.js';
import { PlatformError } from './errors.js';
import { graphemeLength } from './text.js';

/**
 * A simulated platform for local development, demos and automated tests.
 * It never contacts any network. It is only registered when ENABLE_MOCK_PLATFORM=true and is
 * labelled "development only" everywhere it appears.
 *
 * Failure behaviour can be triggered with markers in the post text:
 *   [mock:fail-permanent]  platform rejects the content
 *   [mock:fail-transient]  fails twice with a retryable error, then succeeds
 *   [mock:rate-limit]      first attempt is rate limited (retry-after 2s), then succeeds
 *   [mock:fail-ambiguous]  throws an ambiguous error (outcome unknown; not auto-retried)
 *   [mock:fail-auth]       credentials rejected (needs reauthorization)
 *   [mock:slow]            takes 3 seconds
 */
export class MockAdapter extends PlatformAdapter {
  /** attempts per idempotency key, to simulate "fails N times then succeeds" */
  #attempts = new Map();
  /** posts that "exist" on the fake platform, keyed by idempotency key (when idempotent) */
  published = new Map();

  get id() {
    return 'mock';
  }

  get label() {
    return 'Mock (development only)';
  }

  get capabilities() {
    return CAPS;
  }

  async beginAuthorization({ redirectUri, input }) {
    const label = (input?.handle ?? 'demo').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'demo';
    const state = randomUUID();
    await this.deps.kv.set(`state:${state}`, { label }, { ttlSeconds: 600 });
    const url = new URL(redirectUri);
    url.searchParams.set('code', 'mock-code');
    url.searchParams.set('state', state);
    return { authorizationUrl: url.toString() };
  }

  async completeAuthorization({ query }) {
    const state = query.get('state');
    const pending = state ? await this.deps.kv.get(`state:${state}`) : null;
    if (!pending) throw new PlatformError('Authorization session expired or invalid', { kind: ERROR_CLASS.PERMANENT, code: 'invalid_state' });
    await this.deps.kv.delete(`state:${state}`);
    return {
      identity: { externalId: `mock:${pending.label}`, displayName: `Demo account (${pending.label})`, handle: `@${pending.label}@mock.invalid` },
      credentials: { token: `mock-${randomUUID()}` },
      scopes: ['mock:write'],
      expiresAt: null,
    };
  }

  validateContent(content) {
    return validateAgainstCapabilities(CAPS, content, graphemeLength);
  }

  async verifyCredentials() {
    return { expiresAt: null };
  }

  async publish({ content, idempotencyKey, markSending, signal }) {
    const text = content.text ?? '';
    const attempt = (this.#attempts.get(idempotencyKey) ?? 0) + 1;
    this.#attempts.set(idempotencyKey, attempt);
    markSending?.();

    if (text.includes('[mock:slow]')) await sleep(3000, signal);
    if (text.includes('[mock:fail-permanent]')) {
      throw new PlatformError('Mock platform rejected this content.', { kind: ERROR_CLASS.PERMANENT, code: 'mock_rejected' });
    }
    if (text.includes('[mock:fail-auth]')) {
      throw new PlatformError('Mock platform rejected the credentials.', { kind: ERROR_CLASS.AUTH, code: 'mock_auth' });
    }
    if (text.includes('[mock:fail-ambiguous]')) {
      throw new PlatformError('Mock platform connection dropped after the request was sent.', { kind: ERROR_CLASS.AMBIGUOUS, code: 'mock_dropped' });
    }
    if (text.includes('[mock:fail-transient]') && attempt <= 2) {
      throw new PlatformError('Mock platform is temporarily unavailable.', { kind: ERROR_CLASS.TRANSIENT, code: 'mock_unavailable' });
    }
    if (text.includes('[mock:rate-limit]') && attempt === 1) {
      throw new PlatformError('Mock platform rate limit reached.', { kind: ERROR_CLASS.RATE_LIMITED, code: 'mock_rate_limited', retryAfterMs: 2000 });
    }

    const remoteId = `mock_${randomUUID()}`;
    this.published.set(idempotencyKey, remoteId);
    return { remoteId, url: `https://mock.invalid/posts/${remoteId}`, raw: { simulated: true } };
  }

  async revoke() {}

  async fetchPostMetrics() {
    // Honest: the mock platform has no metrics.
    throw new PlatformError('The mock platform provides no metrics.', { kind: ERROR_CLASS.PERMANENT, code: 'no_metrics' });
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}

const CAPS = defineCapabilities({
  implemented: true,
  authType: 'oauth2',
  authInputs: [{ name: 'handle', label: 'Demo account name', placeholder: 'demo', required: false }],
  requiredScopes: ['mock:write'],
  text: { maxLength: 280, counting: 'graphemes' },
  media: {
    maxItems: 4,
    altText: true,
    image: { mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], maxBytes: 5 * 1024 * 1024 },
    video: { mimeTypes: ['video/mp4'], maxBytes: 20 * 1024 * 1024 },
  },
  notes: ['Simulated platform for development and demos. Nothing is published anywhere.'],
});
