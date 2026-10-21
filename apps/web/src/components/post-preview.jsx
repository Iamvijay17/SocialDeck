import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { PlatformIcon, platformLabel } from '@/lib/platforms';
import { MediaThumb } from '@/components/media';
import { cn } from '@/lib/utils';

/** Linkify http(s) URLs the way most platforms render them. */
function RichText({ text }) {
  const parts = (text ?? '').split(/(https?:\/\/[^\s<>"']+)/g);
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? <span key={i} className="text-sky-400">{p}</span> : /^@\S+/.test(p) ? <span key={i} className="text-sky-400">{p}</span> : <span key={i}>{p}</span>,
      )}
    </p>
  );
}

function MediaGrid({ media }) {
  if (!media.length) return null;
  const cols = media.length === 1 ? 'grid-cols-1' : 'grid-cols-2';
  return (
    <div className={cn('mt-2 grid gap-1 overflow-hidden rounded-lg', cols)}>
      {media.slice(0, 4).map((m) => (
        <MediaThumb key={m.id} media={m} className={cn('w-full', media.length === 1 ? 'max-h-64' : 'aspect-square')} />
      ))}
    </div>
  );
}

/**
 * Approximate, platform-flavoured preview of how a post will look, plus every validation issue the server found
 * for this account. The server (the platform adapter) is the source of truth for limits; this only displays them.
 */
export function PostPreview({ account, text, media, validation, limit, counted }) {
  const issues = validation?.issues ?? [];
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const over = limit && counted > limit;

  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <div className="flex items-center gap-3">
        <PlatformIcon platform={account.platform} size="lg" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{account.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">{account.handle ?? platformLabel(account.platform)}</p>
        </div>
        <div className="ml-auto text-right">
          {limit ? (
            <p className={cn('text-xs tabular-nums', over ? 'font-semibold text-red-400' : 'text-muted-foreground')} aria-live="polite">
              {counted}/{limit}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-3">
        {text?.trim() ? <RichText text={text} /> : <p className="text-sm italic text-muted-foreground">Nothing to show yet.</p>}
        <MediaGrid media={media} />
      </div>
      <div className="mt-3 space-y-1.5">
        {validation && errors.length === 0 && (
          <p className="flex items-center gap-1.5 text-xs text-success"><CheckCircle2 className="size-3.5" /> Ready for {platformLabel(account.platform)}</p>
        )}
        {errors.map((i) => (
          <p key={i.code + i.message} className="flex items-start gap-1.5 text-xs text-red-400"><AlertCircle className="mt-0.5 size-3.5 shrink-0" /> {i.message}</p>
        ))}
        {warnings.map((i) => (
          <p key={i.code + i.message} className="flex items-start gap-1.5 text-xs text-amber-400"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {i.message}</p>
        ))}
      </div>
    </div>
  );
}
