import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Info, Plus, RefreshCw, Share2, ShieldCheck, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/AppShell';
import { StatusBadge } from '@/components/status';
import { Badge, Button, Card, CardContent, EmptyState, ErrorNotice, Field, Input, Skeleton } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth, useTimezone } from '@/hooks/auth';
import { useAccounts, usePlatforms } from '@/hooks/queries';
import { api, qs } from '@/lib/api';
import { PlatformIcon, platformLabel } from '@/lib/platforms';
import { formatInZone } from '@/lib/time';

const MATURITY = {
  implemented: { label: 'Implemented – verify with your account', tone: 'info' },
  mock: { label: 'Development only', tone: 'warning' },
  planned: { label: 'Not available yet', tone: 'neutral' },
  evaluating: { label: 'Not enabled', tone: 'neutral' },
};

export function AccountsPage() {
  const tz = useTimezone();
  const { user } = useAuth();
  const isOwner = user.role === 'owner';
  const qc = useQueryClient();
  const platforms = usePlatforms();
  const accounts = useAccounts();
  const [params, setParams] = useSearchParams();
  const [connectFor, setConnectFor] = useState(null);
  const [toDisconnect, setToDisconnect] = useState(null);

  // Result of the OAuth round trip arrives as query parameters.
  useEffect(() => {
    const connected = params.get('connected');
    const error = params.get('error');
    if (!connected && !error) return;
    if (connected) toast.success(`${platformLabel(connected)} account connected`);
    if (error) toast.error(params.get('message') || 'The account could not be connected.');
    qc.invalidateQueries({ queryKey: ['accounts'] });
    setParams({}, { replace: true });
  }, [params, setParams, qc]);

  const verify = useMutation({
    mutationFn: (id) => api(`/accounts/${id}/verify`, { method: 'POST' }),
    onSuccess: (res) => {
      toast[res.account.status === 'active' ? 'success' : 'warning'](res.account.status === 'active' ? 'Connection is working' : 'This account needs to be reconnected');
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err) => toast.error(err.message),
  });
  const disconnect = useMutation({
    mutationFn: (id) => api(`/accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Account disconnected');
      setToDisconnect(null);
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['posts'] });
    },
    onError: (err) => toast.error(err.message),
  });

  const list = (accounts.data ?? []).filter((a) => a.status !== 'revoked');
  const byId = Object.fromEntries((platforms.data ?? []).map((p) => [p.id, p]));

  return (
    <>
      <PageHeader
        title="Social accounts"
        description={isOwner ? "Connect accounts through each platform's official authorization. Passwords are never collected, and tokens are encrypted at rest." : 'Accounts the owner has shared with you. You can publish to them; credentials are never visible to you.'}
        actions={isOwner && <Button onClick={() => setConnectFor('choose')}><Plus /> Connect account</Button>}
      />

      {accounts.error && <ErrorNotice error={accounts.error} onRetry={() => accounts.refetch()} />}
      {accounts.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">{[0, 1].map((i) => <Skeleton key={i} className="h-36" />)}</div>
      ) : list.length === 0 ? (
        <EmptyState icon={Share2} title="No accounts connected" description={isOwner ? 'Connect a Bluesky or Mastodon account to start publishing.' : 'Ask the owner to share an account with you.'} action={isOwner && <Button onClick={() => setConnectFor('choose')}><Plus /> Connect account</Button>} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.map((a) => (
            <li key={a.id}>
              <Card>
                <CardContent className="space-y-3 pt-5">
                  <div className="flex items-start gap-3">
                    <PlatformIcon platform={a.platform} size="lg" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{a.displayName}</p>
                      <p className="truncate text-xs text-muted-foreground">{a.handle ?? platformLabel(a.platform)}</p>
                    </div>
                    {a.shared && <Badge tone="primary">Shared with you</Badge>}
                    <StatusBadge status={a.status} />
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Connected</dt><dd>{formatInZone(a.connectedAt, tz, { dateStyle: 'medium' })}</dd>
                    <dt className="text-muted-foreground">Last checked</dt><dd>{a.lastVerifiedAt ? formatInZone(a.lastVerifiedAt, tz) : 'never'}</dd>
                    <dt className="text-muted-foreground">Token expiry</dt><dd>{a.tokenExpiresAt ? formatInZone(a.tokenExpiresAt, tz) : 'Not reported by this platform'}</dd>
                    <dt className="text-muted-foreground">Permissions</dt><dd className="break-words">{a.scopes?.length ? a.scopes.join(', ') : '—'}</dd>
                  </dl>
                  {a.statusReason && a.status !== 'active' && <p className="rounded-md bg-amber-500/10 px-2.5 py-2 text-xs text-amber-300">{a.statusReason}</p>}
                  {isOwner && <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => verify.mutate(a.id)} loading={verify.isPending && verify.variables === a.id}><ShieldCheck /> Check connection</Button>
                    {a.status !== 'active' && <Button size="sm" onClick={() => setConnectFor(a.platform)}><RefreshCw /> Reconnect</Button>}
                    <Button size="sm" variant="ghost" onClick={() => setToDisconnect(a)}><Unplug /> Disconnect</Button>
                  </div>}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {isOwner && <section className="mt-10" aria-labelledby="platforms-h">
        <h2 id="platforms-h" className="mb-3 text-sm font-semibold">Supported platforms</h2>
        <ul className="grid gap-3 md:grid-cols-2">
          {(platforms.data ?? []).map((p) => (
            <li key={p.id} className="rounded-xl border border-border p-4">
              <div className="flex items-center gap-3">
                <PlatformIcon platform={p.id} />
                <p className="font-medium">{p.label}</p>
                <Badge tone={MATURITY[p.maturity]?.tone} className="ml-auto">{MATURITY[p.maturity]?.label ?? p.maturity}</Badge>
              </div>
              {p.capabilities.requiredScopes?.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground"><span className="font-medium text-foreground">Permissions requested:</span> {p.capabilities.requiredScopes.join(', ')}</p>
              )}
              <ul className="mt-2 space-y-1">
                {(p.capabilities.notes ?? []).map((n) => (
                  <li key={n} className="flex gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 size-3 shrink-0" /> {n}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>}

      <ConnectDialog target={connectFor} onClose={() => setConnectFor(null)} platforms={platforms.data ?? []} onPick={setConnectFor} byId={byId} />

      <ConfirmDialog
        open={Boolean(toDisconnect)}
        onOpenChange={(o) => !o && setToDisconnect(null)}
        title={`Disconnect ${toDisconnect?.displayName}?`}
        description="Scheduled posts for this account will be cancelled and its authorization will be revoked on the platform where possible. Past posts and their results are kept."
        confirmLabel="Disconnect"
        destructive
        loading={disconnect.isPending}
        onConfirm={() => disconnect.mutate(toDisconnect.id)}
      />
    </>
  );
}

function ConnectDialog({ target, onClose, platforms, onPick, byId }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const open = Boolean(target);
  const platform = target && target !== 'choose' ? byId[target] : null;
  const input = platform?.capabilities.authInputs?.[0];

  useEffect(() => {
    setValue('');
    setError(null);
  }, [target]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { authorizationUrl } = await api(`/accounts/${platform.id}/connect${qs(input ? { [input.name]: value } : {})}`);
      window.location.assign(authorizationUrl); // leaves the app for the platform's own consent screen
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {!platform ? (
          <>
            <DialogHeader>
              <DialogTitle>Connect an account</DialogTitle>
              <DialogDescription>Choose a platform. You will be sent to its official sign-in and permission screen.</DialogDescription>
            </DialogHeader>
            <ul className="space-y-2">
              {platforms.map((p) => (
                <li key={p.id}>
                  <button type="button" disabled={!p.enabled} onClick={() => onPick(p.id)} className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50">
                    <PlatformIcon platform={p.id} />
                    <span className="flex-1 text-sm font-medium">{p.label}</span>
                    {!p.enabled && <Badge>Not available yet</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); start(); }} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Connect {platform.label}</DialogTitle>
              <DialogDescription>You will approve access on {platform.label}. Requested permissions: {platform.capabilities.requiredScopes.join(', ') || 'none'}.</DialogDescription>
            </DialogHeader>
            {input && (
              <Field label={input.label} htmlFor="connect-input" hint={platform.id === 'bluesky' ? 'Leave empty to sign in at bsky.social.' : undefined} error={error}>
                <Input id="connect-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder={input.placeholder} required={input.required} autoFocus autoComplete="off" />
              </Field>
            )}
            {!input && error && <p className="text-xs text-destructive">{error}</p>}
            <ul className="space-y-1">
              {platform.capabilities.notes.map((n) => <li key={n} className="flex gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 size-3 shrink-0" />{n}</li>)}
            </ul>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" loading={busy} disabled={input?.required && !value.trim()}>Continue to {platform.label}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
