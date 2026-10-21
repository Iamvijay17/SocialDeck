import { createStubAdapter } from '@osh/platform-core';

/**
 * X integration – INTENTIONALLY NOT IMPLEMENTED.
 *
 * X's official API is paid (pay-per-use as of 2026, per secondary sources – verify on developer.x.com), and this
 * project only uses free official APIs. The adapter exists so X shows up as "Disabled (paid API)" and so a manual
 * fallback (copy caption + open X) can be offered. Nothing here ever contacts X.
 */
export const xAdapter = createStubAdapter({
  id: 'x',
  label: 'X',
  docsUrl: 'https://developer.x.com/',
  requiredScopes: [],
  notes: [
    'Disabled on purpose: X\'s official API for posting is a paid product, and this app uses free official APIs only.',
    'Use the manual option: copy the caption and open X to post it yourself.',
  ],
  capabilities: { text: { maxLength: 280, counting: 'characters' } },
});

export default xAdapter;
