import { createStubAdapter } from '@osh/platform-core';

/**
 * Facebook Pages integration – NOT IMPLEMENTED. This module only declares the planned capabilities and the
 * access requirements users must know about. See docs/platforms.md.
 */
export const facebookAdapter = createStubAdapter({
  id: 'facebook',
  label: 'Facebook Pages',
  docsUrl: 'https://developers.facebook.com/docs/graph-api/',
  requiredScopes: ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list'],
  notes: [
    'Planned. Publishing is not implemented.',
    'Publishes to Facebook Pages (not personal profiles) and requires Page-level permissions granted by a user who can manage the Page.',
    'Requires a Meta developer app; permissions beyond your own test users need Meta App Review.',
  ],
  capabilities: { text: { maxLength: 63206, counting: 'characters' }, media: { maxItems: 10 } },
});

export default facebookAdapter;
