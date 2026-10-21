import { Copy, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/primitives';
import { copyText, MANUAL_TARGETS, manualUrl } from '@/lib/manual';
import { PlatformIcon } from '@/lib/platforms';

/** Copy the caption, then open the platform to post it yourself. Never records a status. */
export async function postManually(platform, text) {
  const copied = await copyText(text ?? '');
  toast[copied ? 'success' : 'warning'](copied ? 'Caption copied – paste it on the platform.' : 'Could not copy automatically – select the text and copy it.');
  window.open(manualUrl(platform, text), '_blank', 'noopener,noreferrer');
}

export function ManualButton({ platform, text, size = 'sm', variant = 'outline', children }) {
  const t = MANUAL_TARGETS[platform];
  return (
    <Button size={size} variant={variant} onClick={() => postManually(platform, text)} title={t?.prefilled ? 'Opens the platform with your caption filled in' : 'Copies your caption, then opens the platform'}>
      <ExternalLink /> {children ?? `Post on ${t?.label ?? platform} manually`}
    </Button>
  );
}

/**
 * Shown in the composer for platforms where no account is connected (not set up, unavailable, or paid).
 * @param {{platforms: string[], text: string, reasons?: Record<string,string>}} props
 */
export function ManualPublishCard({ platforms, text, reasons = {} }) {
  if (!platforms.length) return null;
  return (
    <details className="rounded-xl border border-border bg-card p-4">
      <summary className="cursor-pointer text-sm font-medium">Post manually on other platforms ({platforms.length})</summary>
      <p className="mt-2 text-xs text-muted-foreground">
        These platforms have no connected account here. SocialDeck copies your caption and opens the platform so you can post it yourself; nothing is
        published by the app and no result is recorded.
      </p>
      <ul className="mt-3 space-y-2">
        {platforms.map((p) => (
          <li key={p} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-2.5">
            <PlatformIcon platform={p} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{MANUAL_TARGETS[p]?.label ?? p}</span>
              {reasons[p] && <span className="block text-xs text-muted-foreground">{reasons[p]}</span>}
            </span>
            <Button size="sm" variant="ghost" onClick={async () => toast[(await copyText(text)) ? 'success' : 'warning']('Caption copied')}>
              <Copy /> Copy caption
            </Button>
            <ManualButton platform={p} text={text}>Open {MANUAL_TARGETS[p]?.label}</ManualButton>
          </li>
        ))}
      </ul>
    </details>
  );
}
