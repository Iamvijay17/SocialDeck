#!/usr/bin/env node
// End-to-end smoke test of a RUNNING installation using the mock platform (requires ENABLE_MOCK_PLATFORM=true).
//   node scripts/smoke.js [--url http://127.0.0.1:8080] [--schedule-seconds 45]
// Reads OWNER_EMAIL / OWNER_PASSWORD from the environment or .env. Creates a draft, publishes it to two mock accounts
// (one rigged to fail) and optionally schedules a third post so you can restart containers while it is pending.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const base = arg('url', process.env.PSM_PUBLIC_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const scheduleSeconds = Number(arg('schedule-seconds', 0));
const { OWNER_EMAIL: email, OWNER_PASSWORD: password } = process.env;
if (!email || !password) throw new Error('Set OWNER_EMAIL and OWNER_PASSWORD (in .env or the environment).');

let cookie = '';
let csrf = '';
async function api(method, url, body, { follow = false } = {}) {
  const res = await fetch(base + url, {
    method,
    redirect: follow ? 'follow' : 'manual',
    headers: { 'content-type': 'application/json', origin: base, cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  const json = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  return { status: res.status, body: json, headers: res.headers };
}
const step = (msg) => console.log(`• ${msg}`);
const must = (cond, msg) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

step(`logging in to ${base}`);
const login = await api('POST', '/api/auth/login', { email, password });
must(login.status === 200, `login returned ${login.status}`);
csrf = login.body.csrfToken;

step('connecting two mock accounts (official-style connect/callback flow)');
const ids = [];
for (const handle of ['smoke-a', 'smoke-b']) {
  const start = await api('GET', `/api/accounts/mock/connect?handle=${handle}`);
  must(start.status === 200, `connect returned ${start.status} (${JSON.stringify(start.body)}). Is ENABLE_MOCK_PLATFORM=true?`);
  const u = new URL(start.body.authorizationUrl);
  const cb = await api('GET', u.pathname + u.search);
  must(cb.status === 302, `callback returned ${cb.status}`);
}
const accounts = (await api('GET', '/api/accounts')).body.items.filter((a) => a.platform === 'mock' && a.handle?.includes('smoke'));
must(accounts.length === 2, 'expected two smoke accounts');
accounts.forEach((a) => ids.push(a.id));

step('publishing one post to both accounts (second one is rigged to fail permanently)');
const created = await api('POST', '/api/posts', { text: `smoke test ${new Date().toISOString()}`, targets: [{ accountId: ids[0] }, { accountId: ids[1], text: 'rigged [mock:fail-permanent]' }] });
must(created.status === 201, `create returned ${created.status}`);
const postId = created.body.post.id;
const pub = await api('POST', `/api/posts/${postId}/publish`, {});
must(pub.status === 202, `publish returned ${pub.status}`);

let post;
for (let i = 0; i < 40; i++) {
  post = (await api('GET', `/api/posts/${postId}`)).body.post;
  if (!post.targets.some((t) => ['queued', 'publishing'].includes(t.status))) break;
  await sleep(500);
}
const byStatus = post.targets.map((t) => t.status).sort().join(',');
must(byStatus === 'failed,published', `expected one published and one failed target, got ${byStatus} (is the worker running?)`);
must(post.status === 'partially_published', `post status ${post.status}`);
step(`results are independent: ${byStatus}; post status = ${post.status}`);

if (scheduleSeconds > 0) {
  const when = new Date(Date.now() + scheduleSeconds * 1000).toISOString();
  const sp = await api('POST', '/api/posts', { text: `scheduled smoke ${when}`, targets: [{ accountId: ids[0] }] });
  const s = await api('POST', `/api/posts/${sp.body.post.id}/schedule`, { scheduledAt: when });
  must(s.status === 202, `schedule returned ${s.status}: ${JSON.stringify(s.body)}`);
  step(`scheduled post ${sp.body.post.id} for ${when}. Restart containers now if you want to test recovery; waiting for it to publish…`);
  let final;
  for (let i = 0; i < (scheduleSeconds + 90) * 2; i++) {
    final = (await api('GET', `/api/posts/${sp.body.post.id}`)).body?.post;
    if (final?.status === 'published') break;
    await sleep(500);
  }
  must(final?.status === 'published', `scheduled post ended as ${final?.status}`);
  step('scheduled post published at its time');
}
console.log('\nSmoke test passed.');
