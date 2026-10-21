import { randomUUID } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Attach a request id (reusing a sane incoming X-Request-Id) and echo it back for correlation. */
export function requestId() {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}
