import { Router } from 'express';
import { PLATFORM_IDS, badRequest } from '@osh/shared';
import { connectQuerySchema, z } from '@osh/validation';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { idParams, validate } from '../middleware/validate.js';

const platformParams = z.object({ platform: z.enum(PLATFORM_IDS) });

export function accountRoutes({ ctx }) {
  const { services, config } = ctx;
  const r = Router();

  // The provider redirects the browser here. The session cookie (SameSite=Lax) accompanies top-level navigations.
  // Registered before the auth gate for :id routes so that failures redirect back to the UI instead of returning JSON.
  r.get('/:platform/callback', validate({ params: platformParams }), async (req, res) => {
    const { platform } = req.valid.params;
    const back = (params) => res.redirect(`${config.publicUrl}/accounts?${new URLSearchParams(params).toString()}`);
    if (!req.auth) return back({ error: 'session_expired', message: 'Your session expired. Sign in and connect the account again.' });
    try {
      const account = await services.accounts.completeConnect(req.auth.user._id, platform, new URLSearchParams(req.query), { requestId: req.id });
      return back({ connected: platform, account: String(account._id) });
    } catch (err) {
      ctx.logger.warn({ platform, code: err.code, requestId: req.id }, 'account connection failed');
      return back({ error: err.code ?? 'connect_failed', message: err.status && err.status < 500 ? err.message : 'The account could not be connected.' });
    }
  });

  r.use(requireAuth, requireCsrf);

  r.get('/', async (req, res) => {
    res.json({ items: await services.accounts.list(req.auth.user._id) });
  });

  // Starts the official authorization flow; returns the URL the browser should be sent to.
  r.get('/:platform/connect', validate({ params: platformParams, query: connectQuerySchema }), async (req, res) => {
    const { platform } = req.valid.params;
    const result = await services.accounts.beginConnect(req.auth.user._id, platform, req.valid.query);
    if (!result?.authorizationUrl) throw badRequest('The platform did not provide an authorization URL.');
    res.json({ authorizationUrl: result.authorizationUrl });
  });

  r.get('/:id', validate({ params: idParams }), async (req, res) => {
    res.json({ account: await services.accounts.get(req.auth.user._id, req.valid.params.id) });
  });

  r.post('/:id/verify', validate({ params: idParams }), async (req, res) => {
    res.json({ account: await services.accounts.verify(req.auth.user._id, req.valid.params.id, { requestId: req.id }) });
  });

  r.delete('/:id', validate({ params: idParams }), async (req, res) => {
    res.json(await services.accounts.disconnect(req.auth.user._id, req.valid.params.id, { requestId: req.id }));
  });

  return r;
}
