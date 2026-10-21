import { PlatformError } from './errors.js';
import { ERROR_CLASS } from '@osh/shared';

/**
 * @typedef {object} MediaInput
 * @property {string} id
 * @property {'image'|'video'} kind
 * @property {string} mimeType
 * @property {number} size
 * @property {string|null} altText
 * @property {number|null} [width]
 * @property {number|null} [height]
 * @property {() => Promise<Blob>} blob  file-backed Blob (does not load the whole file into memory)
 * @property {string|null} [publicUrl]   short-lived public HTTPS URL, only for platforms that need one
 *
 * @typedef {object} AccountIdentity
 * @property {string} externalId   stable id on the platform (DID, `acct@instance`, ...)
 * @property {string} displayName
 * @property {string} [handle]
 * @property {string} [avatarUrl]
 * @property {string} [instance]
 *
 * @typedef {object} AuthorizationResult
 * @property {AccountIdentity} identity
 * @property {object} credentials  adapter-defined, JSON-serialisable. Encrypted at rest by the caller.
 * @property {string[]} scopes
 * @property {Date|null} [expiresAt]
 *
 * @typedef {object} PublishContext
 * @property {object} credentials
 * @property {AccountIdentity & {id: string}} account
 * @property {{text: string, media: MediaInput[]}} content
 * @property {string} idempotencyKey  stable for all attempts of one target
 * @property {AbortSignal} [signal]
 * @property {(credentials: object, expiresAt?: Date|null) => Promise<void>} [onCredentialsUpdated]
 * @property {() => void} [markSending] called immediately before the first byte of a publishing request is sent
 *
 * @typedef {object} PublishResult
 * @property {string} remoteId
 * @property {string|null} [url]
 * @property {object} [raw] small, non-sensitive details worth keeping
 *
 * @typedef {object} ValidationIssue
 * @property {string} code
 * @property {string} message
 * @property {'error'|'warning'} severity
 *
 * @typedef {object} AdapterDeps
 * @property {typeof fetch} fetch  SSRF-safe fetch (or a mock in tests)
 * @property {{get: Function, set: Function, delete: Function}} kv  namespaced, encrypted key/value store with TTL
 * @property {object} logger
 * @property {object} [config]
 */

export const DEFAULT_CAPABILITIES = Object.freeze({
  implemented: false,
  authType: 'none',
  authInputs: [],
  requiredScopes: [],
  text: { maxLength: 0, counting: 'characters' },
  media: {
    maxItems: 0,
    mixedTypes: false,
    requiresPublicUrl: false,
    altText: false,
    image: { mimeTypes: [], maxBytes: 0 },
    video: { mimeTypes: [], maxBytes: 0 },
  },
  scheduling: { native: false, minLeadSeconds: 0 },
  idempotentPublish: false,
  tokenRefresh: 'none',
  analytics: { postMetrics: [] },
  notes: [],
});

/** Merge adapter-specific capabilities over the defaults (deep for nested capability groups). */
export function defineCapabilities(partial) {
  const d = DEFAULT_CAPABILITIES;
  return Object.freeze({
    ...d,
    ...partial,
    text: { ...d.text, ...partial.text },
    media: {
      ...d.media,
      ...partial.media,
      image: { ...d.media.image, ...partial.media?.image },
      video: { ...d.media.video, ...partial.media?.video },
    },
    scheduling: { ...d.scheduling, ...partial.scheduling },
    analytics: { ...d.analytics, ...partial.analytics },
  });
}

/**
 * Base class for platform adapters. Adapters must not assume other platforms behave identically:
 * they declare `capabilities` and implement only what the platform's official API supports.
 */
export class PlatformAdapter {
  /** @param {AdapterDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  /** @returns {string} */
  get id() {
    throw new Error('Adapter must define id');
  }

  get label() {
    return this.id;
  }

  /** @returns {ReturnType<typeof defineCapabilities>} */
  get capabilities() {
    return DEFAULT_CAPABILITIES;
  }

  /** Whether publishing is enabled for this adapter. Stubs return false. */
  get enabled() {
    return this.capabilities.implemented;
  }

  /**
   * Start the official authorization flow.
   * @param {{ownerId: string, redirectUri: string, input: Record<string,string|undefined>, signal?: AbortSignal}} ctx
   * @returns {Promise<{authorizationUrl: string}>}
   */
  // eslint-disable-next-line no-unused-vars
  async beginAuthorization(ctx) {
    throw notImplemented(this.id, 'authorization');
  }

  /**
   * Finish authorization from the provider callback.
   * @param {{ownerId: string, redirectUri: string, query: URLSearchParams, signal?: AbortSignal}} ctx
   * @returns {Promise<AuthorizationResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async completeAuthorization(ctx) {
    throw notImplemented(this.id, 'authorization');
  }

  /**
   * Pure content validation (no network). Returns every problem found, not just the first.
   * @param {{text: string, media: Array<{kind: string, mimeType: string, size: number, altText?: string|null}>}} content
   * @param {{account?: object}} [ctx]
   * @returns {Promise<ValidationIssue[]>|ValidationIssue[]}
   */
  // eslint-disable-next-line no-unused-vars
  validateContent(content, ctx) {
    return [];
  }

  /**
   * Verify credentials are still accepted and refresh them if the platform supports it.
   * Must throw PlatformError(kind=auth) when reauthorization is required.
   * @param {{credentials: object, account: object, onCredentialsUpdated?: Function}} ctx
   * @returns {Promise<{expiresAt?: Date|null}>}
   */
  // eslint-disable-next-line no-unused-vars
  async verifyCredentials(ctx) {
    throw notImplemented(this.id, 'credential verification');
  }

  /**
   * @param {PublishContext} ctx
   * @returns {Promise<PublishResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async publish(ctx) {
    throw notImplemented(this.id, 'publishing');
  }

  /**
   * Best-effort revocation of platform-side authorization when the user disconnects.
   * Failures must not prevent local disconnection.
   * @param {{credentials: object, ownerId: string, account: object}} ctx
   */
  // eslint-disable-next-line no-unused-vars
  async revoke(ctx) {}

  /**
   * Optional: fetch engagement metrics for a published post. Only implement when the official API supports it.
   * @param {{credentials: object, account: object, remoteId: string}} ctx
   * @returns {Promise<Record<string, number>>}
   */
  // eslint-disable-next-line no-unused-vars
  async fetchPostMetrics(ctx) {
    throw notImplemented(this.id, 'analytics');
  }
}

function notImplemented(id, what) {
  return new PlatformError(`${what} is not implemented for ${id}`, { kind: ERROR_CLASS.PERMANENT, code: 'not_implemented' });
}

/**
 * Shared validation of text length and media against declared capabilities. Adapters call this and then add
 * platform-specific rules. `measure` returns the length as the platform counts it.
 */
export function validateAgainstCapabilities(caps, content, measure) {
  /** @type {ValidationIssue[]} */
  const issues = [];
  const text = content.text ?? '';
  const media = content.media ?? [];
  const len = measure(text);

  if (!text.trim() && media.length === 0) {
    issues.push({ code: 'empty', severity: 'error', message: 'Add some text or media.' });
  }
  if (caps.text.maxLength && len > caps.text.maxLength) {
    issues.push({
      code: 'text_too_long',
      severity: 'error',
      message: `Text is ${len - caps.text.maxLength} over the ${caps.text.maxLength} character limit (${len}/${caps.text.maxLength}).`,
    });
  }
  if (media.length > caps.media.maxItems) {
    issues.push({
      code: 'too_many_media',
      severity: 'error',
      message:
        caps.media.maxItems === 0
          ? 'This platform integration does not support media.'
          : `At most ${caps.media.maxItems} media attachment(s) are supported (${media.length} selected).`,
    });
  }
  const kinds = new Set(media.map((m) => m.kind));
  if (kinds.size > 1 && !caps.media.mixedTypes) {
    issues.push({ code: 'mixed_media', severity: 'error', message: 'Images and videos cannot be combined in one post on this platform.' });
  }
  if (kinds.has('video') && media.filter((m) => m.kind === 'video').length > 1 && caps.media.maxVideos !== undefined && caps.media.maxVideos < 2) {
    issues.push({ code: 'too_many_videos', severity: 'error', message: 'Only one video per post is supported.' });
  }
  for (const m of media) {
    const group = caps.media[m.kind];
    if (!group || group.mimeTypes.length === 0) {
      issues.push({ code: 'unsupported_media_kind', severity: 'error', message: `${m.kind === 'video' ? 'Videos are' : 'Images are'} not supported by this integration.` });
      continue;
    }
    if (!group.mimeTypes.includes(m.mimeType)) {
      issues.push({ code: 'unsupported_media_type', severity: 'error', message: `${m.mimeType} is not supported (allowed: ${group.mimeTypes.join(', ')}).` });
    }
    if (group.maxBytes && m.size > group.maxBytes) {
      issues.push({
        code: 'media_too_large',
        severity: 'error',
        message: `${m.kind === 'video' ? 'Video' : 'Image'} is ${formatBytes(m.size)}; the limit is ${formatBytes(group.maxBytes)}.`,
      });
    }
    if (caps.media.altText && !m.altText) {
      issues.push({ code: 'missing_alt_text', severity: 'warning', message: 'Consider adding alt text for accessibility.' });
    }
  }
  return issues;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
