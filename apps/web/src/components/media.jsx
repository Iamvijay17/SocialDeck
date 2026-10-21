import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, FileVideo, Images, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button, EmptyState, Skeleton } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';
import { useMedia } from '@/hooks/queries';

export const mediaUrl = (id) => `/api/media/${id}/file`;

/** Image or video preview served through the authenticated, ownership-checked endpoint. */
export function MediaThumb({ media, className, controls = false }) {
  if (!media) return null;
  return media.kind === 'video' ? (
    <video src={mediaUrl(media.id)} preload="metadata" controls={controls} muted={!controls} playsInline className={cn('bg-black object-cover', className)} aria-label={media.originalName ?? 'Video'} />
  ) : (
    <img src={mediaUrl(media.id)} alt={media.altText ?? media.originalName ?? ''} loading="lazy" className={cn('bg-black object-cover', className)} />
  );
}

/** Upload one or more files sequentially; reports per-file errors with toasts. */
export function useUploadMedia() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (files) => {
      const uploaded = [];
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        try {
          const res = await api('/media', { method: 'POST', formData });
          uploaded.push(res.media);
        } catch (err) {
          toast.error(`${file.name}: ${err.message}`);
        }
      }
      return uploaded;
    },
    onSuccess: (uploaded) => {
      if (uploaded.length) toast.success(`Uploaded ${uploaded.length} file${uploaded.length === 1 ? '' : 's'}`);
      qc.invalidateQueries({ queryKey: ['media'] });
    },
  });
}

export function UploadButton({ onUploaded, variant = 'default', children = 'Upload', size }) {
  const input = useRef(null);
  const upload = useUploadMedia();
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm"
        onChange={async (e) => {
          const files = [...e.target.files];
          e.target.value = '';
          if (files.length) onUploaded?.(await upload.mutateAsync(files));
        }}
      />
      <Button variant={variant} size={size} loading={upload.isPending} onClick={() => input.current?.click()}>
        <Upload /> {children}
      </Button>
    </>
  );
}

/** Choose existing library items (multi-select) or upload new ones. */
export function MediaPicker({ open, onOpenChange, selectedIds, onConfirm, max = 10 }) {
  const [picked, setPicked] = useState(selectedIds);
  const { data, isLoading } = useMedia({ limit: 100 });
  const items = data?.items ?? [];
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < max ? [...p, id] : p));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setPicked(selectedIds);
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Attach media</DialogTitle>
          <DialogDescription>Select from your library or upload new files. Up to {max} items.</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <UploadButton variant="outline" size="sm" onUploaded={(u) => setPicked((p) => [...p, ...u.map((m) => m.id)].slice(0, max))}>
            Upload new
          </UploadButton>
        </div>
        {isLoading ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-square" />)}</div>
        ) : items.length === 0 ? (
          <EmptyState icon={Images} title="No media yet" description="Upload an image or video to attach it to your post." />
        ) : (
          <ul className="scroll-thin grid max-h-96 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
            {items.map((m) => {
              const on = picked.includes(m.id);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => toggle(m.id)}
                    aria-pressed={on}
                    className={cn('relative block aspect-square w-full overflow-hidden rounded-lg border-2', on ? 'border-primary' : 'border-transparent hover:border-border')}
                  >
                    <MediaThumb media={m} className="size-full" />
                    {m.kind === 'video' && <FileVideo className="absolute bottom-1 left-1 size-4 text-white drop-shadow" />}
                    {on && <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-primary"><Check className="size-3 text-white" /></span>}
                    <span className="sr-only">{m.originalName}</span>
                  </button>
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{formatBytes(m.size)}</p>
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => { onConfirm(picked, items); onOpenChange(false); }}>Attach {picked.length > 0 ? `(${picked.length})` : ''}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
