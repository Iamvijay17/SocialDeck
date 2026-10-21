import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ImagePlus, Lock, PenLine, Save, Send, Share2, X } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/AppShell';
import { MediaPicker, MediaThumb } from '@/components/media';
import { ManualPublishCard } from '@/components/manual-publish';
import { PostPreview } from '@/components/post-preview';
import { PostResults } from '@/components/post-results';
import { StatusBadge } from '@/components/status';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, EmptyState, ErrorNotice, Field, Input, Skeleton, Switch, Textarea } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/dialog';
import { useTimezone } from '@/hooks/auth';
import { useAccounts, usePlatforms, usePost } from '@/hooks/queries';
import { api } from '@/lib/api';
import { PlatformIcon, platformLabel } from '@/lib/platforms';
import { countFor } from '@/lib/text';
import { formatInZone, fromLocalInput, toLocalInput } from '@/lib/time';
import { cn } from '@/lib/utils';

function useDebounced(value, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ComposerPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const tz = useTimezone();
  const platforms = usePlatforms();
  const accounts = useAccounts();
  const existing = usePost(id, { poll: true });

  const [text, setText] = useState('');
  const [media, setMedia] = useState([]); // full media objects, ordered
  const [selected, setSelected] = useState({}); // accountId -> { custom: string|null }
  const [scheduleLocal, setScheduleLocal] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [submittedId, setSubmittedId] = useState(null);
  const [serverIssues, setServerIssues] = useState({});
  const [hydratedFor, setHydratedFor] = useState(null);

  // Load an existing post into the form (once per post id).
  useEffect(() => {
    const p = existing.data;
    if (!p || hydratedFor === p.id) return;
    setText(p.text);
    setMedia(p.media ?? []);
    setSelected(Object.fromEntries(p.targets.map((t) => [t.accountId, { custom: t.textOverride ?? null }])));
    setScheduleLocal(p.scheduledAt ? toLocalInput(p.scheduledAt, tz) : '');
    setHydratedFor(p.id);
  }, [existing.data, hydratedFor, tz]);

  // Switching from /compose/:id to /compose resets the form.
  useEffect(() => {
    if (!id && hydratedFor) {
      setText('');
      setMedia([]);
      setSelected({});
      setScheduleLocal('');
      setSubmittedId(null);
      setHydratedFor(null);
    }
  }, [id, hydratedFor]);

  const post = existing.data;
  const locked = Boolean(post?.targets.some((t) => ['queued', 'publishing', 'published'].includes(t.status)));
  const platformById = useMemo(() => Object.fromEntries((platforms.data ?? []).map((p) => [p.id, p])), [platforms.data]);
  const usableAccounts = (accounts.data ?? []).filter((a) => a.status !== 'revoked' && platformById[a.platform]?.enabled);
  const selectedAccounts = usableAccounts.filter((a) => selected[a.id]);

  // Platforms with no working connected account get a manual fallback (copy caption + open the platform).
  const connectedPlatforms = new Set(usableAccounts.filter((a) => a.status === 'active').map((a) => a.platform));
  const manualPlatforms = ['instagram', 'facebook', 'threads', 'linkedin', 'x', 'bluesky', 'mastodon'].filter((p) => !connectedPlatforms.has(p));
  const manualReasons = Object.fromEntries(
    manualPlatforms.map((p) => {
      const info = platformById[p];
      const reason = info?.maturity === 'paid' ? "X's posting API is paid, so SocialDeck does not connect to it." : info && !info.configured ? 'Not set up yet – see Social Accounts.' : 'No account connected.';
      return [p, reason];
    }),
  );

  const targets = selectedAccounts.map((a) => ({ accountId: a.id, text: selected[a.id].custom }));
  const mediaIds = media.map((m) => m.id);

  // Live per-account validation from the server (adapters are the source of truth for limits).
  const debounced = useDebounced(JSON.stringify({ text, mediaIds, targets }));
  const validation = useQuery({
    queryKey: ['validate', debounced],
    enabled: targets.length > 0 && !locked,
    queryFn: () => api('/posts/validate', { method: 'POST', body: JSON.parse(debounced) }),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
  const validationByAccount = Object.fromEntries((validation.data?.targets ?? []).map((t) => [t.accountId, t]));
  const issuesFor = (accountId) => ({ issues: [...(validationByAccount[accountId]?.issues ?? []), ...(serverIssues[accountId] ?? [])], valid: true });
  const hasErrors = selectedAccounts.some((a) => issuesFor(a.id).issues.some((i) => i.severity === 'error'));

  const scheduledIso = scheduleLocal ? fromLocalInput(scheduleLocal, tz) : null;
  const scheduleInPast = scheduledIso && new Date(scheduledIso).getTime() < Date.now() + 30_000;

  const save = useMutation({
    mutationFn: async (action) => {
      const body = { text, mediaIds, targets };
      let saved;
      if (post) {
        saved = (await api(`/posts/${post.id}`, { method: 'PATCH', body: { ...body, timezone: tz } })).post;
      } else {
        saved = (await api('/posts', { method: 'POST', body: { ...body, timezone: tz, scheduledAt: action === 'draft' ? scheduledIso : null } })).post;
      }
      if (action === 'schedule') saved = (await api(`/posts/${saved.id}/schedule`, { method: 'POST', body: { scheduledAt: scheduledIso, timezone: tz } })).post;
      if (action === 'publish') saved = (await api(`/posts/${saved.id}/publish`, { method: 'POST' })).post;
      return { saved, action };
    },
    onSuccess: ({ saved, action }) => {
      setServerIssues({});
      qc.setQueryData(['post', saved.id], saved);
      qc.invalidateQueries({ queryKey: ['posts'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      if (action === 'draft') {
        toast.success('Draft saved');
        if (!id) navigate(`/compose/${saved.id}`, { replace: true });
      } else {
        toast.success(action === 'schedule' ? 'Post scheduled' : 'Publishing started');
        setSubmittedId(saved.id);
        setHydratedFor(saved.id);
        if (!id) navigate(`/compose/${saved.id}`, { replace: true });
      }
    },
    onError: (err) => {
      const perTarget = err.details?.targets;
      if (perTarget) {
        setServerIssues(Object.fromEntries(perTarget.map((t) => [t.accountId, t.issues])));
        toast.error('Some accounts cannot be published to. See the previews for details.');
      } else {
        toast.error(err.message);
      }
    },
  });

  const toggleAccount = (a, on) =>
    setSelected((s) => {
      const next = { ...s };
      if (on) next[a.id] = { custom: null };
      else delete next[a.id];
      return next;
    });

  const canSubmit = targets.length > 0 && (text.trim() || media.length) && !hasErrors && !save.isPending;
  const loadingInitial = platforms.isLoading || accounts.isLoading || (id && existing.isLoading);

  if (loadingInitial) {
    return (
      <div className="space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /><Skeleton className="h-40 w-full" /></div>
    );
  }
  if (id && existing.error) return <ErrorNotice error={existing.error} onRetry={() => existing.refetch()} />;

  const showResults = post && post.targets.some((t) => t.status !== 'draft');

  return (
    <>
      <PageHeader
        title={post ? 'Edit post' : 'Create post'}
        description="Write once, pick the accounts, and publish now or schedule for later. Each account is validated and published independently."
        actions={post && <StatusBadge status={post.status} />}
      />

      {usableAccounts.length === 0 && (
        <EmptyState
          icon={Share2}
          title="Connect an account first"
          description="You need at least one connected account before you can publish."
          action={<Button asChild><Link to="/accounts">Connect an account</Link></Button>}
          className="mb-6"
        />
      )}

      {locked && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-secondary p-3 text-sm text-muted-foreground">
          <Lock className="mt-0.5 size-4 shrink-0" />
          <p>This post is being published or has been published, so its content can no longer be edited. Results are shown below.</p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Content</CardTitle><CardDescription>Shared caption for every selected account. You can customise it per account in the previews.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <Field label="Caption" htmlFor="caption">
                <Textarea id="caption" rows={7} value={text} onChange={(e) => setText(e.target.value)} disabled={locked} placeholder="What do you want to share?" />
              </Field>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium">Media</p>
                  <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)} disabled={locked}><ImagePlus /> Attach</Button>
                </div>
                {media.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No media attached.</p>
                ) : (
                  <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {media.map((m) => (
                      <li key={m.id} className="group relative">
                        <MediaThumb media={m} className="aspect-square w-full rounded-lg" />
                        {!locked && (
                          <button type="button" onClick={() => setMedia((cur) => cur.filter((x) => x.id !== m.id))} className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white hover:bg-black" aria-label={`Remove ${m.originalName ?? 'media'}`}>
                            <X className="size-3" />
                          </button>
                        )}
                        {!m.altText && m.kind === 'image' && <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[10px] text-amber-300">No alt text</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Accounts</CardTitle><CardDescription>Choose where to publish.</CardDescription></CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {(accounts.data ?? []).filter((a) => a.status !== 'revoked').map((a) => {
                  const platformOn = platformById[a.platform]?.enabled;
                  const disabled = locked || !platformOn || a.status !== 'active';
                  const on = Boolean(selected[a.id]);
                  return (
                    <li key={a.id}>
                      <label className={cn('flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors', on ? 'border-primary/60 bg-primary/5' : 'border-border hover:bg-accent', disabled && !on && 'cursor-not-allowed opacity-60')}>
                        <Checkbox checked={on} disabled={disabled && !on} onCheckedChange={(v) => toggleAccount(a, v === true)} aria-label={`Publish to ${a.displayName}`} />
                        <PlatformIcon platform={a.platform} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{a.displayName}</span>
                          <span className="block truncate text-xs text-muted-foreground">{a.handle ?? platformLabel(a.platform)}</span>
                        </span>
                        {a.status !== 'active' && <StatusBadge status={a.status} />}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>

          {!locked && (
            <Card>
              <CardHeader><CardTitle>When</CardTitle><CardDescription>Times are entered and shown in <strong>{tz}</strong> (change in Settings). They are stored in UTC.</CardDescription></CardHeader>
              <CardContent className="space-y-4">
                <Field label="Schedule for" htmlFor="schedule" error={scheduleInPast ? 'Choose a time at least a minute in the future.' : undefined} hint={scheduledIso ? `= ${formatInZone(scheduledIso, 'UTC', { dateStyle: 'medium', timeStyle: 'short' })} UTC` : 'Leave empty to publish now or save as a draft.'}>
                  <Input id="schedule" type="datetime-local" value={scheduleLocal} onChange={(e) => setScheduleLocal(e.target.value)} className="max-w-xs" />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => save.mutate('draft')} loading={save.isPending && save.variables === 'draft'} disabled={save.isPending || (!text.trim() && media.length === 0 && targets.length === 0)}>
                    <Save /> Save draft
                  </Button>
                  <Button variant="outline" onClick={() => save.mutate('schedule')} loading={save.isPending && save.variables === 'schedule'} disabled={!canSubmit || !scheduledIso || scheduleInPast}>
                    <CalendarClock /> Schedule
                  </Button>
                  <Button onClick={() => setConfirmPublish(true)} disabled={!canSubmit}>
                    <Send /> Publish now
                  </Button>
                </div>
                {hasErrors && <p className="text-xs text-red-400">Fix the issues shown in the previews to enable publishing.</p>}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader><CardTitle>Previews</CardTitle><CardDescription>How your post will look and whether each platform accepts it.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              {selectedAccounts.length === 0 ? (
                <EmptyState icon={PenLine} title="Nothing to preview" description="Select one or more accounts to see per-platform previews and validation." className="py-8" />
              ) : (
                selectedAccounts.map((a) => {
                  const cap = platformById[a.platform]?.capabilities;
                  const custom = selected[a.id].custom;
                  const effective = custom ?? text;
                  return (
                    <div key={a.id} className="space-y-2">
                      <PostPreview
                        account={a}
                        text={effective}
                        media={media}
                        validation={validation.data || serverIssues[a.id] ? issuesFor(a.id) : null}
                        limit={cap?.text.maxLength}
                        counted={countFor(cap?.text.counting, effective)}
                      />
                      {!locked && (
                        <div className="space-y-2 px-1">
                          <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Switch checked={custom !== null} onCheckedChange={(on) => setSelected((s) => ({ ...s, [a.id]: { custom: on ? text : null } }))} aria-label={`Customise text for ${a.displayName}`} />
                            Customise text for this account
                          </label>
                          {custom !== null && (
                            <Textarea rows={4} value={custom} onChange={(e) => setSelected((s) => ({ ...s, [a.id]: { custom: e.target.value } }))} aria-label={`Text for ${a.displayName}`} />
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="mt-6">
        <ManualPublishCard platforms={manualPlatforms} text={text} reasons={manualReasons} />
      </div>

      {showResults && (
        <Card className={cn('mt-6', submittedId && 'border-primary/40')}>
          <CardHeader>
            <CardTitle>Publishing results</CardTitle>
            <CardDescription>Each account is published separately; a failure on one never affects the others.</CardDescription>
          </CardHeader>
          <CardContent>
            <PostResults post={post} />
            <div className="mt-4 flex gap-2">
              <Button variant="outline" asChild><Link to="/compose" onClick={() => setSubmittedId(null)}>Create another post</Link></Button>
              <Button variant="ghost" asChild><Link to="/posts">All posts</Link></Button>
            </div>
          </CardContent>
        </Card>
      )}

      <MediaPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selectedIds={mediaIds}
        onConfirm={(ids, items) => {
          const byId = new Map([...media, ...items].map((m) => [m.id, m]));
          setMedia(ids.map((i) => byId.get(i)).filter(Boolean));
        }}
      />

      <ConfirmDialog
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        title={`Publish to ${targets.length} account${targets.length === 1 ? '' : 's'} now?`}
        description="Posts are published through each platform's official API. Once published they can only be removed on the platform itself."
        confirmLabel="Publish now"
        loading={save.isPending}
        onConfirm={() => {
          setConfirmPublish(false);
          save.mutate('publish');
        }}
      />
    </>
  );
}
