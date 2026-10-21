/**
 * Reconcile MongoDB with the queue. Runs once at startup (before the worker takes jobs) and then periodically
 * from the scheduler sweep. See PublishingService.recoverJobs for the exact rules; notably, jobs that died while
 * sending to a platform without idempotency keys are marked as ambiguous failures and never retried automatically.
 */
export async function runRecovery(ctx, reason) {
  try {
    const summary = await ctx.services.publishing.recoverJobs();
    ctx.logger.info({ reason, ...summary }, 'recovery sweep finished');
    return summary;
  } catch (err) {
    ctx.logger.error({ err, reason }, 'recovery sweep failed');
    return null;
  }
}
