import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setCsrfToken } from '@/lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const qc = useQueryClient();

  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const data = await api('/auth/me');
        setCsrfToken(data.csrfToken);
        return data;
      } catch (err) {
        if (err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  useEffect(() => {
    const onUnauthorized = () => {
      setCsrfToken(null);
      qc.setQueryData(['me'], null);
    };
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, [qc]);

  const login = useMutation({
    mutationFn: (credentials) => api('/auth/login', { method: 'POST', body: credentials }),
    onSuccess: (data) => {
      setCsrfToken(data.csrfToken);
      qc.setQueryData(['me'], data);
    },
  });

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      setCsrfToken(null);
      qc.clear();
      qc.setQueryData(['me'], null);
    }
  }, [qc]);

  const value = useMemo(
    () => ({ user: me.data?.user ?? null, appName: me.data?.appName ?? 'Private Social Manager', loading: me.isLoading, error: me.error, login, logout }),
    [me.data, me.isLoading, me.error, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The user's configured IANA timezone; all timestamps are displayed in it. */
export function useTimezone() {
  const { user } = useAuth();
  return user?.preferences?.timezone ?? 'UTC';
}
