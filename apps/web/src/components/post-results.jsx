import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, RefreshCw, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/dialog';
import { ManualButton } from '@/components/manual-publish';
import { StatusBadge } from '@/components/status';
import { PlatformIcon, platformLabel } from '@/lib/platforms';
import { api } from '@/lib/api';
import { formatInZone } from '@/lib/time';
import { useTimezone } from '@/hooks/auth';

function useInvalidatePosts() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['post'] });
    qc.invalidateQueries({ queryKey: ['posts'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
}

/**
 * Per-account publishing results. A failure on one account never hides another account's success:
 * every target shows its own status, attempts, link and error.
 */
export function PostResults({ post }) {
  const captionFor = (t) => t.textOverride ?? post.text;
  const tz = useTimezone();
  const invalidate = useInvalidatePosts();
  const [confirmRetry, setConfirmRetry] = useState(null);

  const retry = useMutation({
    mutationFn: ({ jobId, acknowledgeDuplicateRisk }) => api(`/publishing/jobs/${jobId}/retry`, { method: 'POST', body: { acknowledgeDuplicateRisk } }),
    onSuccess: () => {
      toast.success('Retry queued');
      setConfirmRetry(null);
      invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const cancel = useMutation({
    mutationFn: (jobId) => api(`/publishing/jobs/${jobId}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Cancelled');
      invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  if (!post.targets.length) return <p className="text-sm text-muted-foreground">No accounts selected.</p>;

  return (
    <>
      <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Publishing results">
        {post.targets.map((t) => {
          const ambiguous = t.status === 'failed' && t.errorClass === 'ambiguous';
          const canRetry = ['failed', 'needs_reauthorization'].includes(t.status) && t.job && t.status !== 'needs_reauthorization';
          const canCancel = ['scheduled', 'queued'].includes(t.status) && t.job && ['pending', 'enqueued'].includes(t.job.status);
          return (
            <li key={t.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-3">
                <PlatformIcon platform={t.platform} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.account?.displayName ?? 'Removed account'}</p>
                  <p className="text-xs text-muted-foreground">
                    {platformLabel(t.platform)}
                    {t.status === 'scheduled' && t.scheduledAt && <> · {formatInZone(t.scheduledAt, tz)}</>}
                    {t.status === 'published' && t.publishedAt && <> · {formatInZone(t.publishedAt, tz)}</>}
                    {t.attemptCount > 1 && <> · {t.attemptCount} attempts</>}
                  </p>
                </div>
                <StatusBadge status={t.status} />
              </div>

              {t.status === 'queued' && t.nextRetryAt && (
                <p className="text-xs text-muted-foreground">Retrying around {formatInZone(t.nextRetryAt, tz, { timeStyle: 'medium' })}.</p>
              )}
              {t.errorMessage && ['failed', 'needs_reauthorization', 'queued', 'cancelled'].includes(t.status) && (
                <p className={`flex items-start gap-1.5 rounded-md px-2.5 py-2 text-xs ${ambiguous ? 'bg-amber-500/10 text-amber-300' : 'bg-secondary text-muted-foreground'}`}>
                  {ambiguous ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> : <XCircle className="mt-0.5 size-3.5 shrink-0" />}
                  <span>{t.errorMessage}</span>
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                {t.remoteUrl && (
                  <Button asChild size="sm" variant="outline">
                    <a href={t.remoteUrl} target="_blank" rel="noopener noreferrer"><ExternalLink /> View on {platformLabel(t.platform)}</a>
                  </Button>
                )}
                {t.status === 'needs_reauthorization' && (
                  <Button asChild size="sm" variant="outline"><Link to="/accounts">Reconnect account</Link></Button>
                )}
                {canRetry && (
                  <Button size="sm" variant="outline" onClick={() => (ambiguous ? setConfirmRetry(t) : retry.mutate({ jobId: t.job.id, acknowledgeDuplicateRisk: false }))} loading={retry.isPending && retry.variables?.jobId === t.job.id}>
                    <RefreshCw /> Retry
                  </Button>
                )}
                {['failed', 'needs_reauthorization'].includes(t.status) && (
                  <ManualButton platform={t.platform} text={captionFor(t)} variant="ghost">Post manually</ManualButton>
                )}
                {canCancel && (
                  <Button size="sm" variant="ghost" onClick={() => cancel.mutate(t.job.id)} loading={cancel.isPending && cancel.variables === t.job.id}>Cancel</Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={Boolean(confirmRetry)}
        onOpenChange={(o) => !o && setConfirmRetry(null)}
        title="This post may already be published"
        description={`The last attempt to ${platformLabel(confirmRetry?.platform)} ended without a clear answer, so the post might already be live. Check ${platformLabel(confirmRetry?.platform)} first. If you retry and it was posted, it will appear twice.`}
        confirmLabel="Retry anyway"
        destructive
        loading={retry.isPending}
        onConfirm={() => retry.mutate({ jobId: confirmRetry.job.id, acknowledgeDuplicateRisk: true })}
      />
    </>
  );
}
