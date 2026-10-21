import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, BarChart3, CalendarClock, CheckCircle2, ExternalLink, FilePlus2, Server, Share2, XCircle } from 'lucide-react';
import { PageHeader } from '@/components/AppShell';
import { StatusBadge } from '@/components/status';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ErrorNotice, Skeleton } from '@/components/ui/primitives';
import { useTimezone } from '@/hooks/auth';
import { usePlatforms } from '@/hooks/queries';
import { api } from '@/lib/api';
import { PlatformIcon, platformLabel } from '@/lib/platforms';
import { formatInZone, relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

function Stat({ label, value, icon: Icon, tone, to }) {
  const body = (
    <Card className="p-4 transition-colors hover:bg-accent/40">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{label}</p>
        <Icon className={cn('size-4', tone ?? 'text-muted-foreground')} aria-hidden="true" />
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value ?? <Skeleton className="h-8 w-12" />}</div>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export function DashboardPage() {
  const tz = useTimezone();
  const summary = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/dashboard/summary'), refetchInterval: 10_000 });
  const analytics = useQuery({ queryKey: ['analytics', 30], queryFn: () => api('/analytics/overview?days=30'), staleTime: 60_000 });
  const platforms = usePlatforms();
  const d = summary.data;

  return (
    <>
      <PageHeader title="Dashboard" description="What is published, what is coming up, and what needs attention." actions={<Button asChild><Link to="/compose"><FilePlus2 /> Create post</Link></Button>} />
      {summary.error && <ErrorNotice error={summary.error} onRetry={() => summary.refetch()} className="mb-4" />}

      {d && !d.system.workerOnline && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p><strong>The publishing worker is not running.</strong> Posts will stay queued and scheduled posts will not go out until it is started (<code className="rounded bg-black/30 px-1">npm run dev:worker</code> or <code className="rounded bg-black/30 px-1">docker compose up worker</code>).</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Connected accounts" value={d?.counts.connectedAccounts} icon={Share2} to="/accounts" />
        <Stat label="Published posts" value={d?.counts.publishedPosts} icon={CheckCircle2} tone="text-success" to="/posts" />
        <Stat label="Scheduled posts" value={d?.counts.scheduledPosts} icon={CalendarClock} tone="text-sky-400" to="/calendar" />
        <Stat label="Failed publishing jobs" value={d?.counts.failedTargets} icon={XCircle} tone={d?.counts.failedTargets ? 'text-red-400' : undefined} to="/posts" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="flex items-center gap-2"><Activity className="size-4" /> Recent publishing activity</CardTitle></CardHeader>
          <CardContent>
            {summary.isLoading ? <Skeleton className="h-40" /> : d.recentActivity.length === 0 ? (
              <EmptyState icon={Activity} title="Nothing published yet" description="Results for every account will show up here as soon as you publish." className="py-8" />
            ) : (
              <ul className="divide-y divide-border">
                {d.recentActivity.map((a) => <ActivityRow key={a.targetId} a={a} tz={tz} />)}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><CalendarClock className="size-4" /> Upcoming</CardTitle></CardHeader>
            <CardContent>
              {summary.isLoading ? <Skeleton className="h-24" /> : d.upcoming.length === 0 ? (
                <p className="text-sm text-muted-foreground">No scheduled posts. <Link to="/compose" className="text-violet-300 hover:underline">Schedule one</Link>.</p>
              ) : (
                <ul className="space-y-2">
                  {d.upcoming.map((p) => (
                    <li key={p.id}>
                      <Link to={`/compose/${p.id}`} className="block rounded-md p-2 hover:bg-accent">
                        <p className="truncate text-sm">{p.text || 'Media post'}</p>
                        <p className="text-xs text-muted-foreground">{formatInZone(p.scheduledAt, tz)} · {relativeTime(p.scheduledAt)}</p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Server className="size-4" /> Integrations</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {summary.isLoading ? <Skeleton className="h-20" /> : d.integrations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No accounts connected. <Link to="/accounts" className="text-violet-300 hover:underline">Connect one</Link>.</p>
              ) : d.integrations.map((i) => (
                <div key={i.id} className="flex items-center gap-2">
                  <PlatformIcon platform={i.platform} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm">{i.displayName}</span>
                  <StatusBadge status={i.status} />
                </div>
              ))}
              {d && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                  <Badge tone={d.system.queueConnected ? 'success' : 'danger'}>Queue {d.system.queueConnected ? 'connected' : 'offline'}</Badge>
                  <Badge tone={d.system.workerOnline ? 'success' : 'warning'}>Worker {d.system.workerOnline ? 'online' : 'offline'}</Badge>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BarChart3 className="size-4" /> Publishing analytics</CardTitle>
          <CardDescription>Only real data: your publishing results, and engagement metrics that each platform's official API actually provides. Unavailable is shown as unavailable, never as zero.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {analytics.isLoading ? <Skeleton className="h-40" /> : analytics.error ? <ErrorNotice error={analytics.error} onRetry={() => analytics.refetch()} /> : (
            <>
              <PerDayChart rows={analytics.data.publishedPerDay} days={analytics.data.days} />
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <caption className="sr-only">Metrics available per platform</caption>
                  <thead className="text-muted-foreground"><tr><th className="py-2 pr-4 font-medium">Platform</th><th className="py-2 pr-4 font-medium">Published (30d)</th><th className="py-2 pr-4 font-medium">Failed (30d)</th><th className="py-2 font-medium">Engagement metrics via official API</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {analytics.data.platformMetrics.filter((p) => p.enabled).map((p) => {
                      const count = (s) => analytics.data.publishing.filter((r) => r.platform === p.platform && r.status === s).reduce((n, r) => n + r.count, 0);
                      return (
                        <tr key={p.platform}>
                          <td className="py-2 pr-4"><span className="flex items-center gap-2"><PlatformIcon platform={p.platform} size="sm" />{p.label}</span></td>
                          <td className="py-2 pr-4 tabular-nums">{count('published')}</td>
                          <td className="py-2 pr-4 tabular-nums">{count('failed') + count('needs_reauthorization')}</td>
                          <td className="py-2">{p.availableMetrics.length ? p.availableMetrics.join(', ') : <span className="text-muted-foreground">Not available</span>}</td>
                        </tr>
                      );
                    })}
                    {(platforms.data ?? []).filter((p) => !p.enabled).map((p) => (
                      <tr key={p.id} className="text-muted-foreground"><td className="py-2 pr-4">{p.label}</td><td colSpan={3} className="py-2">Integration not available yet – no analytics.</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function ActivityRow({ a, tz }) {
  const metrics = useMutation({ mutationFn: () => api(`/analytics/targets/${a.targetId}/metrics`) });
  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <PlatformIcon platform={a.platform} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{a.excerpt || 'Media post'}</p>
          <p className="text-xs text-muted-foreground">{a.account ?? platformLabel(a.platform)} · {formatInZone(a.at, tz)}</p>
        </div>
        <StatusBadge status={a.status} />
      </div>
      {a.errorMessage && a.status !== 'published' && <p className="mt-1.5 pl-11 text-xs text-muted-foreground">{a.errorMessage}</p>}
      {a.status === 'published' && (
        <div className="mt-1.5 flex flex-wrap items-center gap-3 pl-11 text-xs">
          {a.remoteUrl && <a href={a.remoteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-violet-300 hover:underline">View <ExternalLink className="size-3" /></a>}
          {!metrics.data && <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => metrics.mutate()} disabled={metrics.isPending}>{metrics.isPending ? 'Loading…' : 'Load engagement'}</button>}
          {metrics.data?.available && <span className="text-muted-foreground">{Object.entries(metrics.data.metrics).map(([k, v]) => `${v} ${k}`).join(' · ')}</span>}
          {metrics.data && !metrics.data.available && <span className="text-muted-foreground">Unavailable: {metrics.data.reason}</span>}
          {metrics.error && <span className="text-red-400">{metrics.error.message}</span>}
        </div>
      )}
    </li>
  );
}

function PerDayChart({ rows, days }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">No posts were published in the last {days} days.</p>;
  const totals = new Map();
  for (const r of rows) totals.set(r.day, (totals.get(r.day) ?? 0) + r.count);
  const entries = [...totals.entries()];
  const max = Math.max(...totals.values());
  return (
    <figure>
      <figcaption className="mb-2 text-xs text-muted-foreground">Posts published per day (all accounts, UTC days)</figcaption>
      <div className="flex h-24 items-end gap-1" role="img" aria-label={`Bar chart of posts published per day over the last ${days} days`}>
        {entries.map(([day, n]) => (
          <div key={day} className="group relative flex-1" title={`${day}: ${n}`}>
            <div className="w-full min-w-1 rounded-t bg-primary/80 transition-colors group-hover:bg-primary" style={{ height: `${Math.max(6, (n / max) * 100)}%` }} />
          </div>
        ))}
      </div>
    </figure>
  );
}
