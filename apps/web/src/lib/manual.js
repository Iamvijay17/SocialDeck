/**
 * Manual fallback: for platforms that are unavailable, unconfigured, or disabled (X is a paid API) the app can still
 * help – copy the caption and open the platform's own page. Nothing is posted by SocialDeck and no publishing status
 * is ever recorded for these, so there is no way to show a fake "published".
 */
const enc = encodeURIComponent;
const MAX_PREFILL = 1200; // keep URLs short enough for every browser/server

export const MANUAL_TARGETS = {
  bluesky: { label: 'Bluesky', open: (t) => `https://bsky.app/intent/compose?text=${enc(t)}`, prefilled: true },
  threads: { label: 'Threads', open: (t) => `https://www.threads.com/intent/post?text=${enc(t)}`, prefilled: true },
  x: { label: 'X', open: (t) => `https://x.com/intent/post?text=${enc(t)}`, prefilled: true },
  linkedin: { label: 'LinkedIn', open: () => 'https://www.linkedin.com/feed/', prefilled: false },
  facebook: { label: 'Facebook', open: () => 'https://www.facebook.com/', prefilled: false },
  instagram: { label: 'Instagram', open: () => 'https://www.instagram.com/', prefilled: false },
  mastodon: { label: 'Mastodon', open: () => 'https://joinmastodon.org/servers', prefilled: false },
};

export function manualUrl(platform, text) {
  const target = MANUAL_TARGETS[platform];
  if (!target) return null;
  return target.prefilled && text && text.length <= MAX_PREFILL ? target.open(text) : target.open('');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = Object.assign(document.createElement('textarea'), { value: text });
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand?.('copy') ?? false;
    el.remove();
    return ok;
  }
}
