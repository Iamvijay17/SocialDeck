import { Navigate, Route, Routes } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { Skeleton } from '@/components/ui/primitives';
import { useAuth } from '@/hooks/auth';
import { AccountsPage } from '@/pages/AccountsPage';
import { CalendarPage } from '@/pages/CalendarPage';
import { ComposerPage } from '@/pages/ComposerPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { LoginPage } from '@/pages/LoginPage';
import { MediaPage } from '@/pages/MediaPage';
import { PostsPage } from '@/pages/PostsPage';
import { SettingsPage } from '@/pages/SettingsPage';

function RequireAuth({ children }) {
  const { user, loading, error } = useAuth();
  if (loading) {
    return (
      <div className="mx-auto max-w-md space-y-3 p-10" aria-busy="true">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (error) {
    return <p className="p-10 text-center text-sm text-red-300">Cannot reach the server: {error.message}</p>;
  }
  return user ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="compose" element={<ComposerPage />} />
        <Route path="compose/:id" element={<ComposerPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="posts" element={<PostsPage />} />
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="media" element={<MediaPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
