import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { ALLOWED_MEDIA_TYPES, AppError, conflict, notFound } from '@osh/shared';
import { MediaAsset, Post } from '../models/index.js';
import { detectMedia, readImageSize } from '../media/sniff.js';
import { hmacHex, safeEqual } from '../crypto.js';

const HEAD_BYTES = 512 * 1024;

export function createMediaService({ config, storage, cipher, audit, logger }) {
  const signingKey = cipher.deriveKey('public-media-url');

  async function sha256File(file) {
    const h = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) h.update(chunk);
    return h.digest('hex');
  }

  async function discard(file) {
    await fsp.rm(file, { force: true }).catch(() => {});
  }

  const sign = (id, exp) => hmacHex(signingKey, `${id}.${exp}`);

  return {
    /**
     * Validate an uploaded temp file (by content, not by claimed type), move it into storage and record it.
     * The temp file is always removed on failure.
     */
    async ingest({ ownerId, tmpPath, originalName, requestId }) {
      try {
        const st = await fsp.stat(tmpPath);
        if (st.size === 0) throw new AppError(422, 'empty_file', 'The uploaded file is empty.');

        const fd = await fsp.open(tmpPath, 'r');
        let head;
        try {
          const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
          const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
          head = buf.subarray(0, bytesRead);
        } finally {
          await fd.close();
        }

        const detected = detectMedia(head);
        if (!detected) {
          throw new AppError(415, 'unsupported_media_type', `Unsupported file type. Allowed: ${Object.keys(ALLOWED_MEDIA_TYPES).join(', ')}.`);
        }
        const limit = detected.kind === 'image' ? config.media.maxImageBytes : config.media.maxVideoBytes;
        if (st.size > limit) {
          throw new AppError(413, 'file_too_large', `${detected.kind === 'image' ? 'Images' : 'Videos'} may be at most ${Math.floor(limit / 1024 / 1024)} MB.`);
        }

        const { ext } = ALLOWED_MEDIA_TYPES[detected.mime];
        const dims = detected.kind === 'image' ? readImageSize(head, detected.mime) : null;
        const checksum = await sha256File(tmpPath);
        const key = storage.newKey(ext);
        await storage.commit(tmpPath, key);

        try {
          const asset = await MediaAsset.create({
            ownerId,
            storageKey: key,
            originalName: sanitizeName(originalName),
            mimeType: detected.mime,
            kind: detected.kind,
            size: st.size,
            checksumSha256: checksum,
            width: dims?.width,
            height: dims?.height,
          });
          await audit.record({ actorId: ownerId, action: 'media.upload', resourceType: 'media', resourceId: asset._id, metadata: { kind: detected.kind, size: st.size }, requestId });
          return asset;
        } catch (err) {
          await storage.remove(key).catch(() => {});
          throw err;
        }
      } finally {
        await discard(tmpPath);
      }
    },

    async list(ownerId, { page = 1, limit = 20, kind } = {}) {
      const filter = { ownerId, ...(kind ? { kind } : {}) };
      const [items, total] = await Promise.all([
        MediaAsset.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
        MediaAsset.countDocuments(filter),
      ]);
      const ids = items.map((i) => i._id);
      const used = ids.length ? await Post.aggregate([{ $match: { mediaIds: { $in: ids } } }, { $unwind: '$mediaIds' }, { $match: { mediaIds: { $in: ids } } }, { $group: { _id: '$mediaIds', count: { $sum: 1 } } }]) : [];
      const usage = new Map(used.map((u) => [String(u._id), u.count]));
      return { items: items.map((i) => ({ ...i.toJSON(), usedByPosts: usage.get(String(i._id)) ?? 0 })), page, limit, total };
    },

    async get(ownerId, id) {
      const asset = await MediaAsset.findOne({ _id: id, ownerId });
      if (!asset) throw notFound('Media not found.');
      return asset;
    },

    async updateAlt(ownerId, id, altText) {
      const asset = await MediaAsset.findOneAndUpdate({ _id: id, ownerId }, { altText: altText || null }, { returnDocument: 'after' });
      if (!asset) throw notFound('Media not found.');
      return asset;
    },

    /** Delete only media that no post references. */
    async remove(ownerId, id, { requestId } = {}) {
      const asset = await this.get(ownerId, id);
      const usedBy = await Post.countDocuments({ mediaIds: asset._id });
      if (usedBy > 0) {
        throw conflict(`This file is attached to ${usedBy} post${usedBy === 1 ? '' : 's'}. Remove it from those posts (or delete them) first.`, { usedByPosts: usedBy });
      }
      await MediaAsset.deleteOne({ _id: asset._id });
      await storage.remove(asset.storageKey).catch((err) => logger.warn({ err }, 'failed to remove media file'));
      await audit.record({ actorId: ownerId, action: 'media.delete', resourceType: 'media', resourceId: asset._id, requestId });
    },

    async usage(ownerId) {
      const [agg] = await MediaAsset.aggregate([{ $match: { ownerId } }, { $group: { _id: null, bytes: { $sum: '$size' }, count: { $sum: 1 } } }]);
      return {
        fileCount: agg?.count ?? 0,
        totalBytes: agg?.bytes ?? 0,
        limits: { maxImageBytes: config.media.maxImageBytes, maxVideoBytes: config.media.maxVideoBytes },
        disk: await storage.diskSpace(),
      };
    },

    /** Verify ownership of a set of media ids and return them in the requested order. */
    async getMany(ownerId, ids) {
      if (!ids.length) return [];
      const docs = await MediaAsset.find({ _id: { $in: ids }, ownerId });
      const byId = new Map(docs.map((d) => [String(d._id), d]));
      return ids.map((id) => {
        const d = byId.get(String(id));
        if (!d) throw notFound(`Media ${id} not found.`);
        return d;
      });
    },

    /** Short-lived signed URL for platforms that must fetch media over public HTTPS. Null when not configured. */
    publicUrl(asset, ttlSeconds = config.media.publicUrlTtlSeconds) {
      if (!config.media.publicBaseUrl) return null;
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      return `${config.media.publicBaseUrl}/api/public-media/${asset.id ?? asset._id}?exp=${exp}&sig=${sign(String(asset._id), exp)}`;
    },

    verifyPublicSignature(id, exp, sig) {
      const e = Number(exp);
      if (!Number.isFinite(e) || e < Date.now() / 1000) return false;
      return typeof sig === 'string' && safeEqual(sig, sign(String(id), e));
    },

    async getForPublicDelivery(id) {
      return MediaAsset.findById(id);
    },

    /**
     * Remove files that are on disk but unknown to the database (e.g. a crash between move and insert) and stale
     * temp uploads. Only files older than `olderThanMs` are touched so in-flight uploads are safe.
     */
    async cleanupOrphans({ olderThanMs = 60 * 60_000 } = {}) {
      const cutoff = Date.now() - olderThanMs;
      const files = await storage.listFiles();
      const old = files.filter((f) => f.mtimeMs < cutoff);
      const known = new Set((await MediaAsset.find({ storageKey: { $in: old.map((f) => f.key) } }).select('storageKey').lean()).map((a) => a.storageKey));
      let removedFiles = 0;
      let reclaimedBytes = 0;
      for (const f of old) {
        if (known.has(f.key)) continue;
        if (await storage.remove(f.key).catch(() => false)) {
          removedFiles++;
          reclaimedBytes += f.size;
        }
      }
      let removedTemp = 0;
      for (const t of await storage.listTempFiles()) {
        if (t.mtimeMs < cutoff) {
          await discard(t.path);
          removedTemp++;
        }
      }
      logger.info({ removedFiles, removedTemp, reclaimedBytes }, 'media cleanup finished');
      return { removedFiles, removedTemp, reclaimedBytes };
    },
  };
}

function sanitizeName(name) {
  if (!name) return undefined;
  // Display-only; never used for storage paths.
  return String(name).replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 255);
}
