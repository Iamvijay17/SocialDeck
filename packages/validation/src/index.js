import { z } from 'zod';
import { PLATFORM_IDS, POST_STATUSES, TARGET_STATUSES } from '@osh/shared';

export { z };

export const objectId = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid identifier')
  .transform((v) => v.toLowerCase());

export const MAX_POST_TEXT = 10_000; // generous upper bound; platform limits are enforced per target
export const MAX_MEDIA_PER_POST = 10;
export const MAX_TARGETS_PER_POST = 25;

export const isValidTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimezone, 'Unknown IANA timezone');

/** ISO-8601 timestamp including an explicit offset (Z or ±hh:mm), normalised to a Date. */
export const isoInstant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters');

export const setupSchema = z.object({
  setupToken: z.string().min(16).max(256),
  email: z.email().max(254),
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(80).optional(),
});

export const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
});

export const postTargetInputSchema = z.object({
  accountId: objectId,
  /** Optional platform-specific text override. null/undefined = use the shared caption. */
  text: z.string().max(MAX_POST_TEXT).nullish(),
});

const postBody = {
  text: z.string().max(MAX_POST_TEXT),
  mediaIds: z.array(objectId).max(MAX_MEDIA_PER_POST),
  targets: z.array(postTargetInputSchema).max(MAX_TARGETS_PER_POST),
  scheduledAt: isoInstant.nullable(),
  timezone: timezoneSchema.optional(),
};

const noDuplicateAccounts = (v) => {
  if (!v.targets) return true;
  const ids = v.targets.map((t) => t.accountId);
  return new Set(ids).size === ids.length;
};

export const createPostSchema = z
  .object({
    text: postBody.text.default(''),
    mediaIds: postBody.mediaIds.default([]),
    targets: postBody.targets.default([]),
    scheduledAt: postBody.scheduledAt.optional(),
    timezone: postBody.timezone,
  })
  .refine(noDuplicateAccounts, { message: 'Each account may only be selected once', path: ['targets'] });

export const updatePostSchema = z
  .object({
    text: postBody.text,
    mediaIds: postBody.mediaIds,
    targets: postBody.targets,
    scheduledAt: postBody.scheduledAt,
    timezone: postBody.timezone,
  })
  .partial()
  .refine(noDuplicateAccounts, { message: 'Each account may only be selected once', path: ['targets'] });

export const validatePostSchema = z.object({
  text: z.string().max(MAX_POST_TEXT).default(''),
  mediaIds: postBody.mediaIds.default([]),
  targets: postBody.targets,
});

export const scheduleSchema = z.object({
  scheduledAt: isoInstant,
  timezone: timezoneSchema.optional(),
});

export const retrySchema = z.object({
  acknowledgeDuplicateRisk: z.boolean().default(false),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const listPostsQuerySchema = paginationSchema.extend({
  status: z.enum(POST_STATUSES).optional(),
  platform: z.enum(PLATFORM_IDS).optional(),
  from: isoInstant.optional(),
  to: isoInstant.optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['newest', 'oldest', 'scheduled']).default('newest'),
});

export const listJobsQuerySchema = paginationSchema.extend({
  status: z.enum(['pending', 'enqueued', 'running', 'succeeded', 'failed', 'cancelled', 'abandoned']).optional(),
  targetStatus: z.enum(TARGET_STATUSES).optional(),
});

export const listMediaQuerySchema = paginationSchema.extend({
  kind: z.enum(['image', 'video']).optional(),
});

export const mediaUpdateSchema = z.object({
  altText: z.string().trim().max(1500).nullable(),
});

/** Hostname (optionally with port) of a Mastodon-compatible server. Scheme is added by the server. */
export const instanceSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/^https?:\/\//, '').replace(/\/+$/, ''))
  .refine(
    (v) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(v) && v.length <= 253,
    'Enter a server hostname such as mastodon.social',
  );

export const connectQuerySchema = z.object({
  instance: instanceSchema.optional(),
  handle: z.string().trim().min(1).max(253).optional(),
});

export const preferencesSchema = z
  .object({
    timezone: timezoneSchema,
    theme: z.enum(['dark', 'light', 'system']),
  })
  .partial();

export const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});
