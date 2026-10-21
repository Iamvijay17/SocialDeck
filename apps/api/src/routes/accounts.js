import { Router } from 'express';
import { User } from '@osh/server-core';
import { PLATFORM_IDS, badRequest } from '@osh/shared';
import { connectQuerySchema, objectId, z } from '@osh/validation';
import { requireAuth, requireCsrf, requireOwner } from '../middleware/auth.js';
import { idParams, validate } from '../middleware/validate.js';

const platformParams = z.object({ platform: z.enum(PLATFORM_IDS) });
const grantParams = z.object({ id: objectId, userId: objectId });

export function accountRoutes({ ctx }) {
  const { services, config } = ctx;
  const r = Router();

  // The provider redirects the browser here. Who started the flow is read from the single-use `state` that only the
  // owner could have created, NOT from the session cookie: Meta, Threads and LinkedIn may redirect to a different
  // origin (http://localhost) than the dashboard (http://127.0.0.1), and cookies do not cross origins.
  // Bluesky's flow has no such state lookup and still needs the cookie.
  r.get('/:platform/callback', validate({ params: platformParams }), async (req, res) => {
    const { platform } = req.valid.params;
    const back = (params) => res.redirect(`${config.publicUrl}/accounts?${new URLSearchParams(params).toString()}`);
    const query = new URLSearchParams(req.query);
    try {
      const fromState = await services.accounts.ownerFromCallback(platform, query);
      const fromSession = req.auth ? String(req.auth.user._id) : null;
      if (fromState && fromSession && fromState !== fromSession) return back({ error: 'wrong_user', message: 'This sign-in was started by a different user.' });
      const ownerId = fromState ?? fromSession;
      const owner = ownerId ? await User.findById(ownerId) : null;
      if (!owner?.isOwner) return back({ error: 'session_expired', message: 'Your session expired. Sign in and connect the account again.' });
      const accounts = await services.accounts.completeConnect(owner._id, platform, query, { requestId: req.id });
      const platforms = [...new Set(accounts.map((a) => a.platform))];
      return back({ connected: platforms.join(','), count: String(accounts.length) });
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
  r.get('/:platform/connect', requireOwner, validate({ params: platformParams, query: connectQuerySchema }), async (req, res) => {
    const { platform } = req.valid.params;
    const result = await services.accounts.beginConnect(req.auth.user._id, platform, req.valid.query);
    if (!result?.authorizationUrl) throw badRequest('The platform did not provide an authorization URL.');
    res.json({ authorizationUrl: result.authorizationUrl });
  });

  r.get('/:id', validate({ params: idParams }), async (req, res) => {
    res.json({ account: await services.accounts.get(req.auth.user._id, req.valid.params.id) });
  });

  r.post('/:id/verify', requireOwner, validate({ params: idParams }), async (req, res) => {
    res.json({ account: await services.accounts.verify(req.auth.user._id, req.valid.params.id, { requestId: req.id }) });
  });

  r.put('/:id/grants/:userId', requireOwner, validate({ params: grantParams }), async (req, res) => {
    res.json(await services.accounts.setGrant(req.valid.params.userId, req.valid.params.id, true, { actorId: req.auth.user._id, requestId: req.id }));
  });

  r.delete('/:id/grants/:userId', requireOwner, validate({ params: grantParams }), async (req, res) => {
    res.json(await services.accounts.setGrant(req.valid.params.userId, req.valid.params.id, false, { actorId: req.auth.user._id, requestId: req.id }));
  });

  r.delete('/:id', requireOwner, validate({ params: idParams }), async (req, res) => {
    res.json(await services.accounts.disconnect(req.auth.user._id, req.valid.params.id, { requestId: req.id }));
  });

  return r;
}
