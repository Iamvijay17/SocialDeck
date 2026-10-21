import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, FilePlus2, Pencil } from 'lucide-react';
import { TZDate } from '@date-fns/tz';
import { toast } from 'sonner';
import { PageHeader } from '@/components/AppShell';
import { PostResults } from '@/components/post-results';
import { STATUS_DOT, StatusBadge } from '@/components/status';
import { Button, Card, ErrorNotice, Field, Input, Skeleton, Tabs, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTimezone } from '@/hooks/auth';
import { api, qs } from '@/lib/api';
import { PlatformIcon } from '@/lib/platforms';
import { dayKey, formatInZone, formatTimeInZone, fromLocalInput, monthGrid, toLocalInput, weekDays } from '@/lib/time';
import { cn, truncate } from '@/lib/utils';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function CalendarPage() {
  const tz = useTimezone();
  const qc = useQueryClient();
  const [view, setView] = useState('month');
  const [anchor, setAnchor] = useState(() => new TZDate(Date.now(), tz));
  const [selected, setSelected] = useState(null);

  const days = useMemo(() => (view === 'month' ? monthGrid(anchor.getFullYear(), anchor.getMonth(), tz) : weekDays(anchor, tz)), [view, anchor, tz]);
  const from = days[0].getTime();
  const to = days[days.length - 1].getTime() + 86_400_000;

  const posts = useQuery({
    queryKey: ['posts', 'calendar', from, to],
    queryFn: () => api(`/posts${qs({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit: 100, sort: 'scheduled' })}`),
    placeholderData: (prev) => prev,
  });
  const drafts = useQuery({ queryKey: ['posts', 'undated-drafts'], queryFn: () => api('/posts?status=draft&limit=8') });

  const byDay = useMemo(() => {
    const map = new Map();
    for (const p of posts.data?.items ?? []) {
      const at = p.status === 'published' || p.status === 'partially_published' ? (p.publishedAt ?? p.scheduledAt) : (p.scheduledAt ?? p.publishedAt);
      if (!at) continue;
      const k = dayKey(at, tz);
      map.set(k, [...(map.get(k) ?? []), { ...p, at }]);
    }
    return map;
  }, [posts.data, tz]);

  const step = (dir) =>
    setAnchor((a) => (view === 'month' ? new TZDate(a.getFullYear(), a.getMonth() + dir, 1, tz) : new TZDate(a.getFullYear(), a.getMonth(), a.getDate() + 7 * dir, tz)));
  const todayKey = dayKey(Date.now(), tz);
  const title = new Intl.DateTimeFormat(undefined, { timeZone: tz, month: 'long', year: 'numeric' }).format(anchor);

  return (
    <>
      <PageHeader
        title="Content calendar"
        description={`Scheduled, published, draft and failed posts. Times are shown in ${tz}.`}
        actions={<Button asChild><Link to="/compose"><FilePlus2 /> New post</Link></Button>}
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Previous" onClick={() => step(-1)}><ChevronLeft /></Button>
          <Button variant="outline" size="icon" aria-label="Next" onClick={() => step(1)}><ChevronRight /></Button>
          <Button variant="outline" size="sm" onClick={() => setAnchor(new TZDate(Date.now(), tz))}>Today</Button>
          <h2 className="ml-2 text-base font-semibold" aria-live="polite">{title}</h2>
        </div>
        <Tabs value={view} onValueChange={setView}>
          <TabsList><TabsTrigger value="month">Month</TabsTrigger><TabsTrigger value="week">Week</TabsTrigger></TabsList>
        </Tabs>
      </div>

      <Legend />
      {posts.error && <ErrorNotice error={posts.error} onRetry={() => posts.refetch()} />}
      <Card className="overflow-hidden">
        <div className="grid grid-cols-7 border-b border-border bg-secondary/40 text-center text-xs font-medium text-muted-foreground">
          {WEEKDAYS.map((d) => <div key={d} className="py-2">{d}</div>)}
        </div>
        {posts.isLoading ? <Skeleton className="m-4 h-96" /> : (
          <div className={cn('grid grid-cols-7', view === 'month' ? 'auto-rows-[minmax(5.5rem,1fr)]' : 'auto-rows-[minmax(18rem,1fr)]')}>
            {days.map((d) => {
              const k = dayKey(d.getTime(), tz);
              const items = byDay.get(k) ?? [];
              const inMonth = view === 'week' || d.getMonth() === anchor.getMonth();
              return (
                <div key={k} className={cn('min-w-0 border-b border-r border-border p-1 last:border-r-0', !inMonth && 'bg-background/60 opacity-50')}>
                  <p className={cn('mb-1 flex size-6 items-center justify-center rounded-full text-xs', k === todayKey ? 'bg-primary font-semibold text-white' : 'text-muted-foreground')}>{d.getDate()}</p>
                  <ul className="space-y-0.5">
                    {items.slice(0, view === 'month' ? 3 : 20).map((p) => (
                      <li key={p.id}>
                        <button type="button" onClick={() => setSelected(p)} className="flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] hover:bg-accent" title={truncate(p.text, 140)}>
                          <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[p.status])} />
                          <span className="shrink-0 tabular-nums text-muted-foreground">{formatTimeInZone(p.at, tz)}</span>
                          <span className="truncate">{truncate(p.text, 30) || 'Media post'}</span>
                        </button>
                      </li>
                    ))}
                    {items.length > 3 && view === 'month' && <li className="px-1 text-[10px] text-muted-foreground">+{items.length - 3} more</li>}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {(drafts.data?.items ?? []).some((p) => !p.scheduledAt) && (
        <section className="mt-8" aria-labelledby="undated-h">
          <h2 id="undated-h" className="mb-2 text-sm font-semibold">Unscheduled drafts</h2>
          <ul className="space-y-1.5">
            {drafts.data.items.filter((p) => !p.scheduledAt).map((p) => (
              <li key={p.id}>
                <Link to={`/compose/${p.id}`} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent">
                  <Pencil className="size-3.5 text-muted-foreground" /><span className="truncate">{truncate(p.text, 100) || 'Untitled draft'}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PostDialog post={selected} tz={tz} onClose={() => setSelected(null)} onChanged={() => qc.invalidateQueries({ queryKey: ['posts'] })} />
    </>
  );
}

function Legend() {
  const items = [['scheduled', 'Scheduled'], ['published', 'Published'], ['draft', 'Draft'], ['failed', 'Failed'], ['publishing', 'In progress']];
  return (
    <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
      {items.map(([k, label]) => <li key={k} className="flex items-center gap-1.5"><span className={cn('size-2 rounded-full', STATUS_DOT[k])} />{label}</li>)}
    </ul>
  );
}

function PostDialog({ post, tz, onClose, onChanged }) {
  const [when, setWhen] = useState('');
  const [openFor, setOpenFor] = useState(null);
  if (post && openFor !== post.id) {
    setOpenFor(post.id);
    setWhen(post.scheduledAt ? toLocalInput(post.scheduledAt, tz) : '');
  }
  const iso = when ? fromLocalInput(when, tz) : null;
  const canReschedule = post && ['scheduled', 'draft', 'failed'].includes(post.status) && post.targets.length > 0 && !post.targets.some((t) => ['published', 'queued', 'publishing'].includes(t.status));

  const reschedule = useMutation({
    mutationFn: () => api(`/posts/${post.id}/schedule`, { method: 'POST', body: { scheduledAt: iso, timezone: tz } }),
    onSuccess: () => {
      toast.success('Rescheduled');
      onChanged();
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });
  const unschedule = useMutation({
    mutationFn: () => api(`/posts/${post.id}`, { method: 'PATCH', body: { scheduledAt: null } }),
    onSuccess: () => {
      toast.success('Moved back to drafts');
      onChanged();
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Dialog open={Boolean(post)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        {post && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><CalendarDays className="size-4" /> {formatInZone(post.at ?? post.scheduledAt, tz)}</DialogTitle>
              <DialogDescription className="flex items-center gap-2"><StatusBadge status={post.status} /> <span className="flex gap-1">{post.targets.map((t) => <PlatformIcon key={t.id} platform={t.platform} size="sm" />)}</span></DialogDescription>
            </DialogHeader>
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-secondary p-3 text-sm">{post.text || 'Media post'}</p>
            <PostResults post={post} />
            {canReschedule && (
              <Field label={`Reschedule (${tz})`} htmlFor="resched">
                <Input id="resched" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              </Field>
            )}
            <DialogFooter>
              <Button asChild variant="outline"><Link to={`/compose/${post.id}`}><Pencil /> Edit</Link></Button>
              {post.status === 'scheduled' && <Button variant="outline" onClick={() => unschedule.mutate()} loading={unschedule.isPending}>Unschedule</Button>}
              {canReschedule && <Button onClick={() => reschedule.mutate()} loading={reschedule.isPending} disabled={!iso || new Date(iso).getTime() < Date.now() + 30_000}>Reschedule</Button>}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
