import { AlertTriangle, Ban, CheckCircle2, CircleDashed, Clock, KeyRound, Loader2, Send, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';

/** One source of truth for how statuses look. Covers both target and post statuses. */
export const STATUS = {
  draft: { label: 'Draft', tone: 'neutral', icon: CircleDashed },
  scheduled: { label: 'Scheduled', tone: 'info', icon: Clock },
  queued: { label: 'Queued', tone: 'primary', icon: Send },
  publishing: { label: 'Publishing', tone: 'primary', icon: Loader2, spin: true },
  published: { label: 'Published', tone: 'success', icon: CheckCircle2 },
  partially_published: { label: 'Partially published', tone: 'warning', icon: AlertTriangle },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  needs_reauthorization: { label: 'Reconnect needed', tone: 'warning', icon: KeyRound },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban },
  active: { label: 'Connected', tone: 'success', icon: CheckCircle2 },
  revoked: { label: 'Disconnected', tone: 'neutral', icon: Ban },
};

export function StatusBadge({ status, className }) {
  const s = STATUS[status] ?? { label: status, tone: 'neutral', icon: CircleDashed };
  const Icon = s.icon;
  return (
    <Badge tone={s.tone} className={className}>
      <Icon className={`size-3 ${s.spin ? 'animate-spin' : ''}`} aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

export const STATUS_DOT = {
  draft: 'bg-zinc-500',
  scheduled: 'bg-sky-400',
  queued: 'bg-violet-400',
  publishing: 'bg-violet-400',
  published: 'bg-green-500',
  partially_published: 'bg-amber-500',
  failed: 'bg-red-500',
  needs_reauthorization: 'bg-amber-500',
  cancelled: 'bg-zinc-600',
};
