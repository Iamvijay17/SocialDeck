import { Router } from 'express';
import { createPostSchema, listPostsQuerySchema, scheduleSchema, updatePostSchema, validatePostSchema } from '@osh/validation';
import { idParams, validate } from '../middleware/validate.js';

export function postRoutes({ ctx }) {
  const { posts } = ctx.services;
  const r = Router();
  const owner = (req) => req.auth.user._id;
  const meta = (req) => ({ requestId: req.id });

  r.get('/', validate({ query: listPostsQuerySchema }), async (req, res) => {
    res.json(await posts.list(owner(req), req.valid.query));
  });

  // Live per-account validation for the composer (no persistence).
  r.post('/validate', validate({ body: validatePostSchema }), async (req, res) => {
    res.json({ targets: await posts.validate(owner(req), req.valid.body) });
  });

  r.post('/', validate({ body: createPostSchema }), async (req, res) => {
    res.status(201).json({ post: await posts.create(owner(req), req.valid.body, meta(req)) });
  });

  r.get('/:id', validate({ params: idParams }), async (req, res) => {
    res.json({ post: await posts.get(owner(req), req.valid.params.id) });
  });

  r.patch('/:id', validate({ params: idParams, body: updatePostSchema }), async (req, res) => {
    res.json({ post: await posts.update(owner(req), req.valid.params.id, req.valid.body, meta(req)) });
  });

  r.delete('/:id', validate({ params: idParams }), async (req, res) => {
    await posts.remove(owner(req), req.valid.params.id, meta(req));
    res.status(204).end();
  });

  // 202: the work is queued; per-target results arrive asynchronously and are visible on the post.
  r.post('/:id/publish', validate({ params: idParams }), async (req, res) => {
    res.status(202).json({ post: await posts.publishNow(owner(req), req.valid.params.id, meta(req)) });
  });

  r.post('/:id/schedule', validate({ params: idParams, body: scheduleSchema }), async (req, res) => {
    res.status(202).json({ post: await posts.schedule(owner(req), req.valid.params.id, req.valid.body, meta(req)) });
  });

  r.post('/:id/cancel', validate({ params: idParams }), async (req, res) => {
    res.json({ post: await posts.cancel(owner(req), req.valid.params.id, meta(req)) });
  });

  return r;
}
