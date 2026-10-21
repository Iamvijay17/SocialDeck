import { Router } from 'express';
import { listJobsQuerySchema, retrySchema } from '@osh/validation';
import { idParams, validate } from '../middleware/validate.js';

export function publishingRoutes({ ctx }) {
  const { publishing } = ctx.services;
  const r = Router();
  const owner = (req) => req.auth.user._id;

  r.get('/jobs', validate({ query: listJobsQuerySchema }), async (req, res) => {
    res.json(await publishing.listJobs(owner(req), req.valid.query));
  });

  r.get('/jobs/:id', validate({ params: idParams }), async (req, res) => {
    res.json({ job: await publishing.getJob(owner(req), req.valid.params.id) });
  });

  r.post('/jobs/:id/retry', validate({ params: idParams, body: retrySchema }), async (req, res) => {
    const job = await publishing.retryJob(owner(req), req.valid.params.id, req.valid.body);
    res.status(202).json({ job: await publishing.getJob(owner(req), job._id) });
  });

  r.post('/jobs/:id/cancel', validate({ params: idParams }), async (req, res) => {
    await publishing.cancelJob(owner(req), req.valid.params.id);
    res.json({ job: await publishing.getJob(owner(req), req.valid.params.id) });
  });

  return r;
}
