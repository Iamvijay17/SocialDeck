import { createStubAdapter } from '@osh/platform-core';

/**
 * Threads integration – NOT IMPLEMENTED. This module only declares the planned capabilities and the
 * access requirements users must know about. See docs/platforms.md.
 */
export const threadsAdapter = createStubAdapter({
  id: 'threads',
  label: 'Threads',
  docsUrl: 'https://developers.facebook.com/docs/threads/',
  requiredScopes: ['threads_basic', 'threads_content_publish'],
  notes: [
    'Planned. Publishing is not implemented.',
    'Requires a Meta developer app with the Threads API use case and the threads_basic and threads_content_publish permissions.',
    'Media is fetched by Threads from a publicly accessible HTTPS URL (see docs/media-hosting.md).',
  ],
  capabilities: { text: { maxLength: 500, counting: 'characters' }, media: { requiresPublicUrl: true, maxItems: 20 } },
});

export default threadsAdapter;
