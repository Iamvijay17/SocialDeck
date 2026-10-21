/**
 * Client-side character counting for live feedback only. The server (platform adapter) re-validates with the
 * authoritative rules – including limits read from the actual Mastodon instance – before anything is published.
 */
let segmenter;
const graphemes = (t) => {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let n = 0;
  for (const _ of segmenter.segment(t)) n++; // eslint-disable-line no-unused-vars
  return n;
};

export function countFor(counting, text) {
  const t = text ?? '';
  if (counting === 'graphemes') return graphemes(t);
  if (counting === 'mastodon') return [...t.replace(/\bhttps?:\/\/[^\s<>"']+/gi, 'x'.repeat(23))].length;
  return [...t].length;
}
