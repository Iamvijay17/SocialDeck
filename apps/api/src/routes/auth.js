import { Router } from 'express';
import { loginSchema, preferencesSchema } from '@osh/validation';
import { SESSION_COOKIE, cookieOptions, requireAuth, requireCsrf, requireSameOrigin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

export function authRoutes({ ctx, limiters }) {
  const { services, config } = ctx;
  const r = Router();
  const sameOrigin = requireSameOrigin({ allowedOrigins: config.allowedOrigins });

  r.get('/status', (_req, res) => {
    res.json({ appName: config.appName });
  });

  r.post('/login', limiters.loginIp, sameOrigin, validate({ body: loginSchema }), limiters.loginAccount, async (req, res) => {
    const result = await services.auth.login(req.valid.body, { requestId: req.id, userAgent: req.get('user-agent') });
    res.cookie(SESSION_COOKIE, result.rawToken, cookieOptions(config, result.maxAgeMs));
    res.json({ user: result.user, csrfToken: result.csrfToken });
  });

  r.post('/logout', requireAuth, requireCsrf, async (req, res) => {
    await services.auth.logout(req.sessionToken, { actorId: req.auth.user._id, requestId: req.id });
    res.clearCookie(SESSION_COOKIE, { ...cookieOptions(config), maxAge: undefined });
    res.status(204).end();
  });

  r.get('/me', requireAuth, (req, res) => {
    res.json({ user: services.auth.publicUser(req.auth.user), csrfToken: req.auth.session.csrfToken, appName: config.appName });
  });

  r.patch('/preferences', requireAuth, requireCsrf, validate({ body: preferencesSchema }), async (req, res) => {
    const user = await services.auth.updatePreferences(req.auth.user._id, req.valid.body);
    res.json({ user });
  });

  return r;
}
