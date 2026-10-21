import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { CalendarDays, FilePlus2, Images, LayoutDashboard, ListChecks, LogOut, Menu, Settings, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/auth';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/compose', label: 'Create Post', icon: FilePlus2 },
  { to: '/calendar', label: 'Content Calendar', icon: CalendarDays },
  { to: '/posts', label: 'All Posts', icon: ListChecks },
  { to: '/accounts', label: 'Social Accounts', icon: Share2 },
  { to: '/media', label: 'Media Library', icon: Images },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function NavList({ onNavigate }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive ? 'bg-primary/15 text-violet-200' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )
          }
        >
          <Icon className="size-4" aria-hidden="true" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function Brand({ name }) {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-white" aria-hidden="true">
        <Share2 className="size-4" />
      </span>
      <span className="truncate text-sm font-semibold">{name}</span>
    </div>
  );
}

function UserBox({ user, onLogout }) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border px-3 pt-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{user?.displayName ?? user?.email}</p>
        <p className="truncate text-xs text-muted-foreground">{user?.role === 'owner' ? 'Owner' : 'Guest'}</p>
      </div>
      <Button variant="ghost" size="icon" onClick={onLogout} aria-label="Sign out" title="Sign out">
        <LogOut />
      </Button>
    </div>
  );
}

export function AppShell() {
  const { user, appName, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col justify-between border-r border-border bg-background py-5 lg:flex">
        <div className="space-y-6">
          <Brand name={appName} />
          <div className="px-2"><NavList /></div>
        </div>
        <UserBox user={user} onLogout={logout} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background/90 px-4 py-3 backdrop-blur lg:hidden">
          <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Open menu"><Menu /></Button>
          <Brand name={appName} />
        </header>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="left-0 top-0 h-full max-h-none w-72 max-w-[85vw] translate-x-0 translate-y-0 content-between rounded-none rounded-r-xl p-4">
            <DialogTitle className="sr-only">Navigation</DialogTitle>
            <DialogDescription className="sr-only">Main navigation</DialogDescription>
            <div className="space-y-6"><Brand name={appName} /><NavList onNavigate={() => setOpen(false)} /></div>
            <UserBox user={user} onLogout={logout} />
          </DialogContent>
        </Dialog>

        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
