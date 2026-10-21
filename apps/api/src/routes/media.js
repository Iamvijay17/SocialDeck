import fsp from 'node:fs/promises';
import { Router } from 'express';
import multer from 'multer';
import { AppError, badRequest } from '@osh/shared';
import { listMediaQuerySchema, mediaUpdateSchema } from '@osh/validation';
import { idParams, validate } from '../middleware/validate.js';

export function mediaRoutes({ ctx }) {
  const { services, storage, config } = ctx;
  const r = Router();
  const owner = (req) => req.auth.user._id;

  // Files are streamed to a private temp directory first; the real type is decided by content sniffing in ingest().
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, storage.tmpDir),
      filename: (_req, _file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}.upload`),
    }),
    limits: { fileSize: Math.max(config.media.maxImageBytes, config.media.maxVideoBytes), files: 1, fields: 5, parts: 8 },
  });

  r.get('/', validate({ query: listMediaQuerySchema }), async (req, res) => {
    res.json(await services.media.list(owner(req), req.valid.query));
  });

  r.get('/usage', async (req, res) => {
    res.json(await services.media.usage(owner(req)));
  });

  r.post('/', upload.single('file'), async (req, res) => {
    if (!req.file) throw badRequest('Attach a file in the "file" field.');
    const asset = await services.media.ingest({ ownerId: owner(req), tmpPath: req.file.path, originalName: req.file.originalname, requestId: req.id });
    res.status(201).json({ media: asset });
  });

  r.get('/:id', validate({ params: idParams }), async (req, res) => {
    res.json({ media: await services.media.get(owner(req), req.valid.params.id) });
  });

  r.patch('/:id', validate({ params: idParams, body: mediaUpdateSchema }), async (req, res) => {
    res.json({ media: await services.media.updateAlt(owner(req), req.valid.params.id, req.valid.body.altText) });
  });

  r.delete('/:id', validate({ params: idParams }), async (req, res) => {
    await services.media.remove(owner(req), req.valid.params.id, { requestId: req.id });
    res.status(204).end();
  });

  // Authenticated, ownership-checked file delivery (used by <img>/<video> in the dashboard). Supports Range requests.
  r.get('/:id/file', validate({ params: idParams }), async (req, res, next) => {
    const asset = await services.media.get(owner(req), req.valid.params.id);
    sendMediaFile(res, storage, asset, next, { cache: 'private, max-age=3600' });
  });

  return r;
}

/** Public, signed-URL delivery for platforms that must fetch media over HTTPS. Disabled unless configured. */
export function publicMediaRoutes({ ctx }) {
  const { services, storage, config } = ctx;
  const r = Router();
  r.get('/:id', validate({ params: idParams }), async (req, res, next) => {
    if (!config.media.publicBaseUrl) throw new AppError(404, 'not_found', 'Not found.');
    const { id } = req.valid.params;
    if (!services.media.verifyPublicSignature(id, req.query.exp, req.query.sig)) throw new AppError(403, 'invalid_signature', 'The link is invalid or has expired.');
    const asset = await services.media.getForPublicDelivery(id);
    if (!asset) throw new AppError(404, 'not_found', 'Not found.');
    sendMediaFile(res, storage, asset, next, { cache: 'public, max-age=300' });
  });
  return r;
}

async function sendMediaFile(res, storage, asset, next, { cache }) {
  try {
    const abs = storage.absolutePath(asset.storageKey);
    await fsp.access(abs);
    res.sendFile(abs, {
      headers: {
        'Content-Type': asset.mimeType,
        'Content-Disposition': 'inline',
        'Cache-Control': cache,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': cache.startsWith('public') ? 'cross-origin' : 'same-origin',
      },
      dotfiles: 'deny',
    }, (err) => err && next(err));
  } catch (err) {
    next(err.code === 'ENOENT' ? new AppError(404, 'file_missing', 'The file is missing from storage.') : err);
  }
}
