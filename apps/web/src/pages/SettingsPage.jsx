import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, HardDrive, LogOut, Server, ScrollText } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/AppShell';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorNotice, Field, Select, Skeleton } from '@/components/ui/primitives';
import { useAuth } from '@/hooks/auth';
import { api } from '@/lib/api';
import { commonTimezones, formatInZone, localTimezone } from '@/lib/time';
import { formatBytes } from '@/lib/utils';

export function SettingsPage() {
  const { user, logout } = useAuth();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api('/settings'), refetchInterval: 15_000 });
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => api('/settings/audit-log?limit=15') });
  const zones = useMemo(() => commonTimezones(), []);
  const [tz, setTz] = useState(user.preferences.timezone);
  useEffect(() => setTz(user.preferences.timezone), [user.preferences.timezone]);

  const save = useMutation({
    mutationFn: () => api('/settings/preferences', { method: 'PATCH', body: { timezone: tz } }),
    onSuccess: (res) => {
      toast.success('Timezone saved');
      qc.setQueryData(['me'], (old) => ({ ...old, user: res.user }));
    },
    onError: (err) => toast.error(err.message),
  });

  const s = settings.data;
  const detected = localTimezone();

  return (
    <>
      <PageHeader title="Settings" description="Display preferences and the state of this installation." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Globe className="size-4" /> Timezone</CardTitle><CardDescription>All times are stored in UTC and displayed in this timezone. Scheduling uses it too.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <Field label="Display timezone" htmlFor="tz" hint={detected !== tz ? `Your browser reports ${detected}.` : undefined}>
              <Select id="tz" value={tz} onChange={(e) => setTz(e.target.value)}>
                {!zones.includes(tz) && <option value={tz}>{tz}</option>}
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </Select>
            </Field>
            <p className="text-xs text-muted-foreground">Now: {formatInZone(Date.now(), tz, { dateStyle: 'full', timeStyle: 'short' })}</p>
            <div className="flex gap-2">
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={tz === user.preferences.timezone}>Save</Button>
              {detected !== tz && <Button variant="outline" onClick={() => setTz(detected)}>Use browser timezone</Button>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Server className="size-4" /> System</CardTitle><CardDescription>Health of the services that publish your posts.</CardDescription></CardHeader>
          <CardContent>
            {settings.isLoading ? <Skeleton className="h-28" /> : settings.error ? <ErrorNotice error={settings.error} onRetry={() => settings.refetch()} /> : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Version</dt><dd>{s.app.version} ({s.app.environment})</dd>
                <dt className="text-muted-foreground">Queue (Redis)</dt><dd><Badge tone={s.system.queueConnected ? 'success' : 'danger'}>{s.system.queueConnected ? 'Connected' : 'Offline'}</Badge></dd>
                <dt className="text-muted-foreground">Publishing worker</dt><dd><Badge tone={s.system.workerOnline ? 'success' : 'warning'}>{s.system.workerOnline ? 'Online' : 'Offline'}</Badge></dd>
                <dt className="text-muted-foreground">Retry limit</dt><dd>{s.publishing.maxAttempts} attempts per account</dd>
                <dt className="text-muted-foreground">Public URL</dt><dd className="break-all">{s.system.publicUrl}</dd>
                <dt className="text-muted-foreground">Mock platform</dt><dd>{s.system.mockPlatformEnabled ? <Badge tone="warning">Enabled (development)</Badge> : 'Disabled'}</dd>
              </dl>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><HardDrive className="size-4" /> Media storage</CardTitle></CardHeader>
          <CardContent>
            {s ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Used</dt><dd>{formatBytes(s.media.totalBytes)} in {s.media.fileCount} files</dd>
                <dt className="text-muted-foreground">Disk free</dt><dd>{s.media.disk ? formatBytes(s.media.disk.freeBytes) : 'unknown'}</dd>
                <dt className="text-muted-foreground">Upload limits</dt><dd>Images {formatBytes(s.media.limits.maxImageBytes)}, videos {formatBytes(s.media.limits.maxVideoBytes)}</dd>
                <dt className="text-muted-foreground">Public media URLs</dt><dd>{s.media.publicDeliveryConfigured ? <Badge tone="success">Configured</Badge> : 'Not configured (needed only for Instagram / Threads)'}</dd>
              </dl>
            ) : <Skeleton className="h-20" />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><LogOut className="size-4" /> Account</CardTitle><CardDescription>Signed in as {user.email}.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">Passwords are changed from the command line: <code className="rounded bg-secondary px-1">npm run reset-password</code>. Sessions expire automatically after inactivity.</p>
            <Button variant="outline" onClick={logout}><LogOut /> Sign out</Button>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle className="flex items-center gap-2"><ScrollText className="size-4" /> Recent activity log</CardTitle><CardDescription>Security-relevant actions. Contains no secrets.</CardDescription></CardHeader>
        <CardContent>
          {audit.isLoading ? <Skeleton className="h-32" /> : (
            <ul className="divide-y divide-border text-xs">
              {(audit.data?.items ?? []).map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="font-mono">{e.action}</span>
                  <span className="text-muted-foreground">{formatInZone(e.createdAt, user.preferences.timezone)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
