import { AppError } from '@osh/shared';
import { z } from '@osh/validation';

/** Consistent JSON error envelope: { error: { code, message, details?, requestId } } */
export function sendError(res, req, status, code, message, details) {
  res.status(status).json({ error: { code, message, ...(details !== undefined ? { details } : {}), requestId: req.id } });
}

export function notFoundHandler() {
  return (req, res) => sendError(res, req, 404, 'not_found', 'Route not found.');
}

export function errorHandler({ logger, isProduction }) {

  return (err, req, res, _next) => {
    if (res.headersSent) return res.end();

    if (err instanceof AppError) {
      if (err.status >= 500) logger.error({ err, requestId: req.id }, 'request failed');
      return sendError(res, req, err.status, err.code, err.message, err.details);
    }
    if (err instanceof z.ZodError) {
      const fields = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return sendError(res, req, 422, 'validation_failed', 'The request is invalid.', { fields });
    }
    if (err?.type === 'entity.parse.failed') return sendError(res, req, 400, 'invalid_json', 'The request body is not valid JSON.');
    if (err?.type === 'entity.too.large') return sendError(res, req, 413, 'payload_too_large', 'The request body is too large.');
    if (err?.name === 'MulterError') {
      if (err.code === 'LIMIT_FILE_SIZE') return sendError(res, req, 413, 'file_too_large', 'The file is too large.');
      return sendError(res, req, 400, 'upload_error', 'The upload could not be processed.');
    }
    if (err?.code === 11000) return sendError(res, req, 409, 'conflict', 'That resource already exists.');
    if (err?.name === 'CastError') return sendError(res, req, 400, 'bad_request', 'Invalid identifier.');

    logger.error({ err, requestId: req.id }, 'unhandled error');
    // Never leak internals (stack traces, driver messages) in production.
    return sendError(res, req, 500, 'internal_error', isProduction ? 'Something went wrong.' : String(err?.message ?? 'Something went wrong.'));
  };
}
