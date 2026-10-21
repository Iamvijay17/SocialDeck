import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, FilePlus2, ListChecks, Pencil, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/AppShell';
import { MediaThumb } from '@/components/media';
import { PostResults } from '@/components/post-results';
import { STATUS_DOT, StatusBadge } from '@/components/status';
import { Button, Card, EmptyState, ErrorNotice, Input, Select, Skeleton } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/dialog';
import { useTimezone } from '@/hooks/auth';
import { usePosts } from '@/hooks/queries';
import { api } from '@/lib/api';
import { PlatformIcon, platformLabel } from '@/lib/platforms';
import { formatInZone } from '@/lib/time';
import { cn, truncate } from '@/lib/utils';

const STATUS_OPTIONS = ['draft', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled'];

export function PostsPage() {
  const tz = useTimezone();
  const qc = useQueryClient();
  const [filters, setFilters] = useState({ status: '', platform: '', q: '', page: 1 });
  const [expanded, setExpanded] = useState(null);
  const [toDelete, setToDelete] = useState(null);
  const set = (patch) => setFilters((f) => ({ ...f, page: 1, ...patch }));
  const posts = usePosts({ ...filters, limit: 15 });

  const remove = useMutation({
    mutationFn: (id) => api(`/posts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Post deleted');
      setToDelete(null);
      qc.invalidateQueries({ queryKey: ['posts'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => toast.error(err.message),
  });

  const total = posts.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 15));

  return (
    <>
      <PageHeader title="All posts" description="Every draft, scheduled and published post with its per-account results." actions={<Button asChild><Link to="/compose"><FilePlus2 /> New post</Link></Button>} />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search text…" aria-label="Search posts" value={filters.q} onChange={(e) => set({ q: e.target.value })} />
        </div>
        <Select className="w-44" aria-label="Filter by status" value={filters.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </Select>
        <Select className="w-44" aria-label="Filter by platform" value={filters.platform} onChange={(e) => set({ platform: e.target.value })}>
          <option value="">All platforms</option>
          {['bluesky', 'mastodon', 'mock'].map((p) => <option key={p} value={p}>{platformLabel(p)}</option>)}
        </Select>
      </div>

      {posts.error && <ErrorNotice error={posts.error} onRetry={() => posts.refetch()} />}
      {posts.isLoading ? (
        <div className="space-y-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : posts.data?.items.length === 0 ? (
        <EmptyState icon={ListChecks} title={filters.q || filters.status || filters.platform ? 'No posts match these filters' : 'No posts yet'} description="Create your first post to see it here." action={<Button asChild><Link to="/compose">Create post</Link></Button>} />
      ) : (
        <ul className="space-y-2">
          {posts.data?.items.map((p) => {
            const open = expanded === p.id;
            const when = p.status === 'scheduled' ? p.scheduledAt : (p.publishedAt ?? p.scheduledAt ?? p.createdAt);
            return (
              <li key={p.id}>
                <Card className="overflow-hidden">
                  <div className="flex items-start gap-3 p-4">
                    <button type="button" onClick={() => setExpanded(open ? null : p.id)} aria-expanded={open} aria-label={open ? 'Hide results' : 'Show results'} className="mt-0.5 rounded p-1 text-muted-foreground hover:bg-accent">
                      <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
                    </button>
                    <div className="min-w-0 flex-1 space-y-2">
                      <p className="line-clamp-2 break-words text-sm">{p.text ? truncate(p.text, 220) : <em className="text-muted-foreground">No text</em>}</p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <StatusBadge status={p.status} />
                        <span className="text-xs text-muted-foreground">{formatInZone(when, tz)}</span>
                        <span className="flex items-center gap-1.5">
                          {p.targets.map((t) => (
                            <span key={t.id} className="relative" title={`${platformLabel(t.platform)} · ${t.account?.displayName ?? ''} · ${t.status}`}>
                              <PlatformIcon platform={t.platform} size="sm" />
                              <span className={cn('absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-card', STATUS_DOT[t.status])} />
                            </span>
                          ))}
                        </span>
                        {p.media.length > 0 && (
                          <span className="flex -space-x-2">{p.media.slice(0, 3).map((m) => <MediaThumb key={m.id} media={m} className="size-6 rounded ring-2 ring-card" />)}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button asChild variant="ghost" size="icon" aria-label="Open in composer"><Link to={`/compose/${p.id}`}><Pencil /></Link></Button>
                      <Button variant="ghost" size="icon" aria-label="Delete post" onClick={() => setToDelete(p)}><Trash2 /></Button>
                    </div>
                  </div>
                  {open && (
                    <div className="border-t border-border bg-background/40 p-4"><PostResults post={p} /></div>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {total > 15 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>{total} posts</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Previous page" disabled={filters.page <= 1} onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}><ChevronLeft /></Button>
            <span>Page {filters.page} of {pages}</span>
            <Button variant="outline" size="icon" aria-label="Next page" disabled={filters.page >= pages} onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}><ChevronRight /></Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete this post?"
        description={
          toDelete?.targets.some((t) => t.status === 'published')
            ? 'This removes it from this app only. Copies already published on the platforms stay there and must be deleted on each platform.'
            : 'Any scheduled publishing for this post is cancelled. This cannot be undone.'
        }
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate(toDelete.id)}
      />
    </>
  );
}
