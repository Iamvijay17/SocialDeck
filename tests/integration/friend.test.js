import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import { createTestContext, drainQueue } from '../helpers/context.js';

const PW = 'correct horse battery staple';
let ctx;
let app;
let owner;
let friend;
let accountId;

async function login(email) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password: PW });
  expect(res.status).toBe(200);
  return { agent, csrf: res.body.csrfToken, user: res.body.user };
}
const call = (s, method, url, body) => {
  const r = s.agent[method](url).set('x-csrf-token', s.csrf);
  return body === undefined ? r : r.send(body);
};

beforeAll(async () => {
  ctx = await createTestContext({ env: { ENABLE_FRIEND_ACCESS: 'true' } });
  app = createApp(ctx, { rateLimits: { loginPerAccount: 50, loginPerIp: 50 } });
  await ctx.services.auth.createUser({ email: 'owner@example.com', password: PW, role: 'owner', isOwner: true });
  await ctx.services.auth.createUser({ email: 'friend@example.com', password: PW, role: 'friend' });
  owner = await login('owner@example.com');
  friend = await login('friend@example.com');
  const start = await owner.agent.get('/api/accounts/mock/connect?handle=shared');
  const u = new URL(start.body.authorizationUrl);
  await owner.agent.get(u.pathname + u.search);
  accountId = (await owner.agent.get('/api/accounts')).body.items[0].id;
});
afterAll(async () => ctx.close());

describe('optional trusted-friend access', () => {
  it('shows a friend nothing until the owner grants access', async () => {
    expect((await friend.agent.get('/api/accounts')).body.items).toEqual([]);
    expect((await friend.agent.get(`/api/accounts/${accountId}`)).status).toBe(404);
    const blocked = await call(friend, 'post', '/api/posts', { text: 'sneaky', targets: [{ accountId }] });
    expect(blocked.status).toBe(404);
  });

  it('keeps account management owner-only', async () => {
    expect((await friend.agent.get('/api/accounts/mock/connect')).status).toBe(403);
    expect((await call(friend, 'post', `/api/accounts/${accountId}/verify`)).status).toBe(403);
    expect((await call(friend, 'delete', `/api/accounts/${accountId}`)).status).toBe(403);
    expect((await call(friend, 'put', `/api/accounts/${accountId}/grants/${friend.user.id}`)).status).toBe(403);
    expect((await friend.agent.get('/api/users')).status).toBe(403);
  });

  it('lets only the owner list users and grant access, never to the owner', async () => {
    const users = await owner.agent.get('/api/users');
    expect(users.body.enabled).toBe(true);
    expect(users.body.items.map((u) => u.email)).toEqual(['friend@example.com']);
    expect((await call(owner, 'put', `/api/accounts/${accountId}/grants/${owner.user.id}`)).status).toBe(400);
    const grant = await call(owner, 'put', `/api/accounts/${accountId}/grants/${friend.user.id}`);
    expect(grant.body).toMatchObject({ granted: true });
    const again = await call(owner, 'put', `/api/accounts/${accountId}/grants/${friend.user.id}`);
    expect(again.status).toBe(200);
    const acct = (await owner.agent.get(`/api/accounts/${accountId}`)).body.account;
    expect(acct.grants).toHaveLength(1);
  });

  it('exposes a granted account to the friend without credentials or grant details', async () => {
    const list = await friend.agent.get('/api/accounts');
    expect(list.body.items).toHaveLength(1);
    const a = list.body.items[0];
    expect(a.shared).toBe(true);
    expect(a.grants).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toMatch(/credentials|mock-[0-9a-f]{8}-/);
  });

  it("publishes the friend's post through the owner's connection, and keeps content private per user", async () => {
    const created = await call(friend, 'post', '/api/posts', { text: 'hi from the friend', targets: [{ accountId }] });
    expect(created.status).toBe(201);
    expect((await call(friend, 'post', `/api/posts/${created.body.post.id}/publish`, {})).status).toBe(202);
    await drainQueue(ctx);
    const done = await friend.agent.get(`/api/posts/${created.body.post.id}`);
    expect(done.body.post.status).toBe('published');

    // The owner's and friend's posts, media and jobs are separate.
    expect((await owner.agent.get(`/api/posts/${created.body.post.id}`)).status).toBe(404);
    expect((await owner.agent.get('/api/posts')).body.total).toBe(0);
    expect((await friend.agent.get('/api/posts')).body.total).toBe(1);
  });

  it("cancels the friend's scheduled posts when access is revoked, and blocks new ones", async () => {
    const created = await call(friend, 'post', '/api/posts', { text: 'later', targets: [{ accountId }] });
    await call(friend, 'post', `/api/posts/${created.body.post.id}/schedule`, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    const revoke = await call(owner, 'delete', `/api/accounts/${accountId}/grants/${friend.user.id}`);
    expect(revoke.body.granted).toBe(false);
    const after = await friend.agent.get(`/api/posts/${created.body.post.id}`);
    expect(after.body.post.targets[0].status).toBe('cancelled');
    expect((await friend.agent.get('/api/accounts')).body.items).toEqual([]);
    const blocked = await call(friend, 'post', '/api/posts', { text: 'again', targets: [{ accountId }] });
    expect(blocked.status).toBe(404);
  });
});
