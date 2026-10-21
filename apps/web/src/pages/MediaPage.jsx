import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileVideo, HardDrive, Images, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/AppShell';
import { MediaThumb, UploadButton } from '@/components/media';
import { Badge, Button, Card, CardContent, EmptyState, ErrorNotice, Field, Skeleton, Textarea } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTimezone } from '@/hooks/auth';
import { useMedia } from '@/hooks/queries';
import { api } from '@/lib/api';
import { formatInZone } from '@/lib/time';
import { cn, formatBytes } from '@/lib/utils';

export function MediaPage() {
  const tz = useTimezone();
  const qc = useQueryClient();
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [toDelete, setToDelete] = useState(null);
  const media = useMedia({ kind, page, limit: 24 });
  const usage = useQuery({ queryKey: ['media-usage'], queryFn: () => api('/media/usage') });

  const remove = useMutation({
    mutationFn: (id) => api(`/media/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('File deleted');
      setToDelete(null);
      setSelected(null);
      qc.invalidateQueries({ queryKey: ['media'] });
      qc.invalidateQueries({ queryKey: ['media-usage'] });
    },
    onError: (err) => {
      toast.error(err.message);
      setToDelete(null);
    },
  });

  const total = media.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 24));
  const u = usage.data;

  return (
    <>
      <PageHeader
        title="Media library"
        description="Images and videos are validated by content, stored in a private folder and only served to you."
        actions={<UploadButton onUploaded={() => qc.invalidateQueries({ queryKey: ['media-usage'] })}>Upload</UploadButton>}
      />

      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3 pt-5 text-sm">
          <span className="flex items-center gap-2"><HardDrive className="size-4 text-muted-foreground" />
            {usage.isLoading ? <Skeleton className="h-4 w-24" /> : <><strong>{formatBytes(u?.totalBytes)}</strong> in {u?.fileCount ?? 0} files</>}
          </span>
          {u?.disk && <span className="text-xs text-muted-foreground">{formatBytes(u.disk.freeBytes)} free on disk</span>}
          {u && <span className="text-xs text-muted-foreground">Limits: images {formatBytes(u.limits.maxImageBytes)}, videos {formatBytes(u.limits.maxVideoBytes)} · JPEG, PNG, GIF, WebP, MP4, WebM</span>}
        </CardContent>
      </Card>

      <div className="mb-4 flex gap-2" role="group" aria-label="Filter by type">
        {[['', 'All'], ['image', 'Images'], ['video', 'Videos']].map(([v, label]) => (
          <Button key={v} size="sm" variant={kind === v ? 'default' : 'outline'} onClick={() => { setKind(v); setPage(1); }}>{label}</Button>
        ))}
      </div>

      {media.error && <ErrorNotice error={media.error} onRetry={() => media.refetch()} />}
      {media.isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">{Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="aspect-square" />)}</div>
      ) : media.data?.items.length === 0 ? (
        <EmptyState icon={Images} title="Your library is empty" description="Upload images or videos to reuse them across posts." action={<UploadButton>Upload files</UploadButton>} />
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {media.data.items.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => setSelected(m)} className="group relative block aspect-square w-full overflow-hidden rounded-xl border border-border focus-visible:outline-2">
                  <MediaThumb media={m} className="size-full transition-transform group-hover:scale-105" />
                  {m.kind === 'video' && <FileVideo className="absolute bottom-2 left-2 size-4 text-white drop-shadow" />}
                  {m.usedByPosts > 0 && <Badge tone="primary" className="absolute right-2 top-2">In {m.usedByPosts} post{m.usedByPosts === 1 ? '' : 's'}</Badge>}
                  <span className="sr-only">{m.originalName}</span>
                </button>
              </li>
            ))}
          </ul>
          {total > 24 && (
            <div className="mt-4 flex items-center justify-center gap-3 text-sm text-muted-foreground">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              Page {page} of {pages}
              <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          )}
        </>
      )}

      <MediaDetail media={selected} tz={tz} onClose={() => setSelected(null)} onDelete={() => setToDelete(selected)} />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete this file?"
        description={toDelete?.usedByPosts ? 'This file is attached to posts and cannot be deleted until it is removed from them.' : 'The file is permanently removed from storage.'}
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate(toDelete.id)}
      />
    </>
  );
}

function MediaDetail({ media, tz, onClose, onDelete }) {
  const qc = useQueryClient();
  const [alt, setAlt] = useState('');
  useEffect(() => setAlt(media?.altText ?? ''), [media]);
  const save = useMutation({
    mutationFn: () => api(`/media/${media.id}`, { method: 'PATCH', body: { altText: alt || null } }),
    onSuccess: () => {
      toast.success('Alt text saved');
      qc.invalidateQueries({ queryKey: ['media'] });
    },
    onError: (err) => toast.error(err.message),
  });
  return (
    <Dialog open={Boolean(media)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        {media && (
          <>
            <DialogHeader>
              <DialogTitle className="truncate">{media.originalName ?? 'Media'}</DialogTitle>
              <DialogDescription>Uploaded {formatInZone(media.createdAt, tz)}</DialogDescription>
            </DialogHeader>
            <MediaThumb media={media} controls className={cn('max-h-80 w-full rounded-lg object-contain')} />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              <div><dt className="text-muted-foreground">Type</dt><dd>{media.mimeType}</dd></div>
              <div><dt className="text-muted-foreground">Size</dt><dd>{formatBytes(media.size)}</dd></div>
              <div><dt className="text-muted-foreground">Dimensions</dt><dd>{media.width ? `${media.width} × ${media.height}` : '—'}</dd></div>
              <div><dt className="text-muted-foreground">SHA-256</dt><dd className="truncate font-mono" title={media.checksumSha256}>{media.checksumSha256.slice(0, 12)}…</dd></div>
            </dl>
            {media.kind === 'image' && (
              <Field label="Alt text" htmlFor="alt" hint="Describes the image for people using screen readers. Sent to platforms that support it.">
                <Textarea id="alt" rows={3} value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={1500} />
              </Field>
            )}
            <DialogFooter>
              <Button variant="destructive" onClick={onDelete}><Trash2 /> Delete</Button>
              {media.kind === 'image' && <Button onClick={() => save.mutate()} loading={save.isPending} disabled={(media.altText ?? '') === alt}>Save alt text</Button>}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
