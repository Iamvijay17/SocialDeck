/**
 * Static platform registry metadata (no behaviour). Adapters in packages/adapters/* provide the behaviour.
 *
 * `maturity` is intentionally conservative. Nothing is marked "verified" until real-platform
 * verification has been performed and documented in docs/platforms.md.
 *   - mock:        development-only simulated platform
 *   - implemented: code complete + covered by mocked-API tests; NOT yet verified against the live service
 *   - paid:        the official API is paid; deliberately disabled (this project is free-tools-only)
 *   - planned:     adapter skeleton and documentation only; publishing is disabled
 */
export const PLATFORM_IDS = Object.freeze([
  'bluesky',
  'mastodon',
  'instagram',
  'facebook',
  'threads',
  'linkedin',
  'x',
  'mock',
]);

export const PLATFORM_META = Object.freeze({
  bluesky: { label: 'Bluesky', maturity: 'implemented' },
  mastodon: { label: 'Mastodon', maturity: 'implemented' },
  instagram: { label: 'Instagram', maturity: 'implemented' },
  facebook: { label: 'Facebook Pages', maturity: 'implemented' },
  threads: { label: 'Threads', maturity: 'implemented' },
  linkedin: { label: 'LinkedIn', maturity: 'implemented' },
  x: { label: 'X', maturity: 'paid' },
  mock: { label: 'Mock (development only)', maturity: 'mock' },
});

export function isPlatformId(value) {
  return PLATFORM_IDS.includes(value);
}

export const MEDIA_KIND = Object.freeze({ IMAGE: 'image', VIDEO: 'video' });

/** MIME types the media library accepts. Anything else is rejected at upload. */
export const ALLOWED_MEDIA_TYPES = Object.freeze({
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/gif': { kind: 'image', ext: 'gif' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
  'video/webm': { kind: 'video', ext: 'webm' },
});

export const DEFAULT_TIMEZONE = 'UTC';
