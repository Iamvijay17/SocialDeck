import { createStubAdapter } from '@osh/platform-core';

/**
 * Instagram integration – NOT IMPLEMENTED. This module only declares the planned capabilities and the
 * access requirements users must know about. See docs/platforms.md.
 */
export const instagramAdapter = createStubAdapter({
  id: 'instagram',
  label: 'Instagram',
  docsUrl: 'https://developers.facebook.com/docs/instagram-platform/',
  requiredScopes: ['instagram_business_basic', 'instagram_business_content_publish'],
  notes: [
    'Planned. Publishing is not implemented.',
    'Requires an Instagram professional (Business or Creator) account; personal accounts are not eligible for the content publishing API.',
    'Requires a Meta developer app, the relevant permissions and, for other people\'s accounts, Meta App Review.',
    'Media must be fetched by Instagram from a publicly accessible HTTPS URL (see docs/media-hosting.md).',
  ],
  capabilities: { media: { requiresPublicUrl: true, maxItems: 10, image: { mimeTypes: ['image/jpeg'] }, video: { mimeTypes: ['video/mp4'] } }, text: { maxLength: 2200, counting: 'characters' } },
});

export default instagramAdapter;
