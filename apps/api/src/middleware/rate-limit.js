import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { sendError } from './errors.js';

function limiter({ windowMs, limit, keyGenerator, skipSuccessfulRequests = false, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    keyGenerator,
    handler: (req, res) => sendError(res, req, 429, 'rate_limited', message),
  });
}

const byIp = (req) => ipKeyGenerator(req.ip ?? '');

/**
 * In-memory limiters (appropriate for the single-instance self-hosted deployment).
 * Limits can be tightened/relaxed through `overrides` (tests).
 */
export function createRateLimiters(overrides = {}) {
  const o = { loginPerIp: 20, loginPerAccount: 5, setupPerIp: 10, api: 1200, windowMs: 15 * 60_000, ...overrides };
  return {
    loginIp: limiter({ windowMs: o.windowMs, limit: o.loginPerIp, keyGenerator: byIp, skipSuccessfulRequests: true, message: 'Too many sign-in attempts. Try again later.' }),
    // Per target account, so a distributed attacker still cannot hammer one email.
    loginAccount: limiter({
      windowMs: o.windowMs,
      limit: o.loginPerAccount,
      keyGenerator: (req) => `acct:${String(req.body?.email ?? '').toLowerCase().slice(0, 254)}`,
      skipSuccessfulRequests: true,
      message: 'Too many sign-in attempts for this account. Try again later.',
    }),
    setup: limiter({ windowMs: o.windowMs, limit: o.setupPerIp, keyGenerator: byIp, message: 'Too many setup attempts. Try again later.' }),
    api: limiter({ windowMs: 60_000, limit: o.api, keyGenerator: byIp, message: 'Too many requests. Slow down.' }),
    // Platform metric lookups hit third-party APIs.
    metrics: limiter({ windowMs: 60_000, limit: 30, keyGenerator: byIp, message: 'Too many metric requests. Try again shortly.' }),
  };
}
