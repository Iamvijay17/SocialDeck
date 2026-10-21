import { useState } from 'react';
import { Navigate } from 'react-router';
import { Lock, Share2 } from 'lucide-react';
import { Button, Card, Field, Input } from '@/components/ui/primitives';
import { useAuth } from '@/hooks/auth';

export function LoginPage() {
  const { user, appName, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  if (user) return <Navigate to="/" replace />;

  const submit = (e) => {
    e.preventDefault();
    login.mutate({ email, password });
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-primary text-white"><Share2 className="size-6" /></span>
          <div>
            <h1 className="text-xl font-semibold">{appName}</h1>
            <p className="text-sm text-muted-foreground">Private access only. Sign in to continue.</p>
          </div>
        </div>
        <Card className="p-6">
          <form onSubmit={submit} className="space-y-4" noValidate>
            <Field label="Email" htmlFor="email">
              <Input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {login.error && (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-red-300">
                {login.error.message}
              </p>
            )}
            <Button type="submit" className="w-full" loading={login.isPending} disabled={!email || !password}>
              <Lock /> Sign in
            </Button>
          </form>
        </Card>
        <p className="text-center text-xs text-muted-foreground">There is no public registration. Accounts are created by the installation owner.</p>
      </div>
    </div>
  );
}
