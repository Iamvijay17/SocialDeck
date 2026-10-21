let segmenter;
function getSegmenter() {
  segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  return segmenter;
}

/** Length in extended grapheme clusters (what Bluesky counts against its 300 limit). */
export function graphemeLength(text) {
  let n = 0;
  for (const _ of getSegmenter().segment(text ?? '')) n++;
  return n;
}

/** Length in Unicode code points (what X and many APIs count). */
export function codePointLength(text) {
  return [...(text ?? '')].length;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const MENTION_RE = /(^|[^/\w])@([a-z0-9_]+(?:[a-z0-9_.-]+[a-z0-9_]+)?)(@[a-z0-9.-]+[a-z0-9]+)?/gi;

/**
 * Mastodon's counting rules: every URL counts as `urlLength` (default 23) characters regardless of
 * its real length, and the domain part of a remote @mention is not counted.
 */
export function mastodonLength(text, urlLength = 23) {
  const normalised = (text ?? '')
    .replace(URL_RE, 'x'.repeat(urlLength))
    .replace(MENTION_RE, (_m, pre, user) => `${pre}@${user}`);
  return codePointLength(normalised);
}
