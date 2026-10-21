import { createStubAdapter } from '@osh/platform-core';

/**
 * X integration – NOT IMPLEMENTED. This module only declares the planned capabilities and the
 * access requirements users must know about. See docs/platforms.md.
 */
export const xAdapter = createStubAdapter({
  id: 'x',
  label: 'X',
  docsUrl: 'https://developer.x.com/',
  requiredScopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  notes: [
    'Not enabled. API access tiers, pricing and posting quotas change frequently and must be re-verified before this adapter is enabled (see docs/platforms.md).',
    'Posting through the official API may require a paid developer plan.',
  ],
  capabilities: { text: { maxLength: 280, counting: 'characters' }, media: { maxItems: 4 } },
});

export default xAdapter;
