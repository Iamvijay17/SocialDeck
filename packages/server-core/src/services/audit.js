import { AuditLog } from '../models/index.js';

/**
 * Audit trail for important account and publishing actions. Metadata must be non-sensitive:
 * ids, platform names, counts and status values only – never tokens, passwords or post bodies.
 */
export function createAuditService({ logger }) {
  return {
    async record({ actorId = null, action, resourceType, resourceId, metadata = {}, requestId }) {
      try {
        await AuditLog.create({
          actorId,
          action,
          resourceType,
          resourceId: resourceId ? String(resourceId) : undefined,
          metadata,
          requestId,
        });
      } catch (err) {
        // Auditing must never break the user-facing action.
        logger.error({ err, action }, 'failed to write audit log');
      }
    },

    async list({ page = 1, limit = 50, actorId } = {}) {
      const filter = actorId ? { actorId } : {};
      const [items, total] = await Promise.all([
        AuditLog.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean({ virtuals: false }),
        AuditLog.countDocuments(filter),
      ]);
      return {
        items: items.map(({ _id, ...rest }) => ({ id: String(_id), ...rest, actorId: rest.actorId ? String(rest.actorId) : null })),
        page,
        limit,
        total,
      };
    },
  };
}
