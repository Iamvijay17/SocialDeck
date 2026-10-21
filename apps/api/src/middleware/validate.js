import { objectId, z } from '@osh/validation';

export const idParams = z.object({ id: objectId });

/**
 * Validate request parts with Zod. Parsed values land in req.valid (Express 5 makes req.query read-only,
 * and the originals are intentionally left untouched).
 *
 * @param {{body?: import('zod').ZodType, query?: import('zod').ZodType, params?: import('zod').ZodType}} schemas
 */
export function validate(schemas) {
  return (req, _res, next) => {
    req.valid ??= {};
    if (schemas.params) req.valid.params = schemas.params.parse(req.params);
    if (schemas.query) req.valid.query = schemas.query.parse(req.query);
    if (schemas.body) req.valid.body = schemas.body.parse(req.body ?? {});
    next();
  };
}
