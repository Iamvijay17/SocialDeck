import { describe, expect, it } from 'vitest';
import { GraphClient, classifyGraphError, redact } from '../src/index.js';

const err = (status, error, headers = {}, mutating = false) =>
  classifyGraphError({ status, body: { error }, headers: new Headers(headers), mutating });

describe('Graph error classification', () => {
  it('expired or revoked tokens need reauthorization', () => {
    expect(err(400, { code: 190, message: 'Error validating access token: Session has expired' })).toMatchObject({ kind: 'auth', code: 'token_invalid' });
    expect(err(400, { code: 102, error_subcode: 463, message: 'expired' }).kind).toBe('auth');
    expect(err(401, { message: 'x' }).kind).toBe('auth');
  });
  it('permission problems need reauthorization with a clear message', () => {
    const e = err(403, { code: 200, message: '(#200) Requires pages_manage_posts permission' });
    expect(e.kind).toBe('auth');
    expect(e.message).toMatch(/Reconnect the account/);
    expect(err(400, { code: 10, message: 'no permission' }).kind).toBe('auth');
  });
  it('throttling is rate_limited and honours Retry-After or the usage header', () => {
    expect(err(400, { code: 4, message: 'App request limit reached' }, { 'retry-after': '90' })).toMatchObject({ kind: 'rate_limited', retryAfterMs: 90_000 });
    expect(err(400, { code: 17 }).retryAfterMs).toBe(15 * 60_000);
    const usage = JSON.stringify({ 12345: [{ type: 'pages', estimated_time_to_regain_access: 7 }] });
    expect(err(400, { code: 32 }, { 'x-business-use-case-usage': usage }).retryAfterMs).toBe(7 * 60_000);
    expect(err(400, { code: 80002 }).kind).toBe('rate_limited');
  });
  it('transient server errors are ambiguous when they happened on a creating request', () => {
    expect(err(500, { code: 2, message: 'Service temporarily unavailable', is_transient: true }, {}, false).kind).toBe('transient');
    expect(err(500, { code: 2, message: 'unavailable', is_transient: true }, {}, true).kind).toBe('ambiguous');
    expect(err(502, {}, {}, true).kind).toBe('ambiguous');
  });
  it('instagram "media not ready" is safe to retry and invalid parameters are permanent', () => {
    expect(err(400, { code: 9007, message: 'Media ID is not available' }, {}, true).kind).toBe('transient');
    expect(err(400, { code: 100, message: 'Invalid parameter' }).kind).toBe('permanent');
    expect(err(400, { code: 368 }).kind).toBe('permanent');
  });
  it('never lets tokens through in messages', () => {
    const e = err(400, { code: 100, message: 'Bad request access_token=EAAB1234567890abcdefghij&foo=1' });
    expect(e.message).not.toContain('EAAB1234567890');
    expect(redact('client_secret=abc123 and EAAGm0PX4ZCpsBAKzzzzzzzzzzzzzzzzzzzz')).not.toMatch(/abc123|EAAGm0/);
  });
});

describe('GraphClient', () => {
  const ok = (body, init) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

  it('sends tokens in the query for GET and in the body for POST, never in the path', async () => {
    const seen = [];
    const client = new GraphClient({ baseUrl: 'https://graph.example/v1', fetch: async (url, init) => (seen.push({ url, init }), ok({ id: '1' })) });
    await client.request('GET', '/me', { params: { fields: 'id' }, token: 'TOK' });
    await client.request('POST', '/1/feed', { params: { message: 'hi' }, token: 'TOK', mutating: true });
    expect(seen[0].url).toBe('https://graph.example/v1/me?fields=id&access_token=TOK');
    expect(seen[1].url).toBe('https://graph.example/v1/1/feed');
    expect(String(seen[1].init.body)).toContain('access_token=TOK');
    expect(seen[1].init.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('turns Graph error bodies into classified PlatformErrors', async () => {
    const client = new GraphClient({ baseUrl: 'https://g/v1', fetch: async () => ok({ error: { code: 190, message: 'expired' } }, { status: 400 }) });
    await expect(client.request('GET', '/me', { token: 'T' })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('classifies connection failures by whether a creating request could have been sent', async () => {
    const reset = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    const client = new GraphClient({ baseUrl: 'https://g/v1', fetch: reset });
    await expect(client.request('POST', '/1/feed', { mutating: true })).rejects.toMatchObject({ kind: 'ambiguous' });
    await expect(client.request('GET', '/1')).rejects.toMatchObject({ kind: 'transient' });
  });

  it('refuses redirects', async () => {
    const client = new GraphClient({ baseUrl: 'https://g/v1', fetch: async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }) });
    await expect(client.request('GET', '/me')).rejects.toMatchObject({ code: 'redirected' });
  });
});
