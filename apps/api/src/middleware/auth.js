import { forbidden, unauthorized } from '@osh/shared';
import { safeEqual } from '@osh/server-core';

export const SESSION_COOKIE = 'osh_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Resolve the session cookie (if any) into req.auth = { user, session }. Never throws for a missing session. */
export function loadSession({ services }) {
  return async (req, _res, next) => {
    const raw = req.cookies?.[SESSION_COOKIE];
    req.auth = raw ? await services.auth.resolveSession(raw) : null;
    req.sessionToken = raw;
    next();
  };
}

/** Owner-only actions: connecting/disconnecting accounts, granting access, system information. */
export function requireOwner(req, _res, next) {
  if (!req.auth) throw unauthorized();
  if (!req.auth.user.isOwner) throw forbidden('Only the owner can do this.');
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.auth) throw unauthorized();
  next();
}

/**
 * CSRF defence for cookie-authenticated requests:
 *  1. unsafe methods must carry the per-session token in X-CSRF-Token (a cross-site page cannot read it), and
 *  2. if the browser sent an Origin header it must be an allowed origin.
 * SameSite=Lax cookies add a third layer.
 */
export function requireCsrf(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const token = req.get('x-csrf-token');
  if (!req.auth || !token || !safeEqual(token, req.auth.session.csrfToken)) {
    throw forbidden('Missing or invalid CSRF token.');
  }
  next();
}

/** Reject unsafe cross-origin requests that arrive without a session yet (login / setup). */
export function requireSameOrigin({ allowedOrigins }) {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    if (origin && !allowedOrigins.includes(origin)) throw forbidden('Cross-origin request blocked.');
    if (!req.is('application/json')) throw forbidden('Content-Type must be application/json.');
    next();
  };
}

export function cookieOptions(config, maxAgeMs) {
  return { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: maxAgeMs };
}
