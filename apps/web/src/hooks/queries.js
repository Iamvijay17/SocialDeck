import { useQuery } from '@tanstack/react-query';
import { api, qs } from '@/lib/api';

export const usePlatforms = () =>
  useQuery({ queryKey: ['platforms'], queryFn: () => api('/platforms').then((r) => r.items), staleTime: 5 * 60_000 });

export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => api('/accounts').then((r) => r.items) });

export const usePost = (id, { poll = false } = {}) =>
  useQuery({
    queryKey: ['post', id],
    enabled: Boolean(id),
    queryFn: () => api(`/posts/${id}`).then((r) => r.post),
    // Keep refreshing while any target is still in flight so results appear as they happen.
    refetchInterval: (q) => (poll && q.state.data?.targets?.some((t) => ['queued', 'publishing'].includes(t.status)) ? 2000 : false),
  });

export const usePosts = (params) =>
  useQuery({ queryKey: ['posts', params], queryFn: () => api(`/posts${qs(params)}`), placeholderData: (prev) => prev });

export const useMedia = (params) =>
  useQuery({ queryKey: ['media', params], queryFn: () => api(`/media${qs(params)}`), placeholderData: (prev) => prev });

/** Post is "in flight" while the worker still owns at least one target. */
export const isInFlight = (post) => post?.targets?.some((t) => ['queued', 'publishing'].includes(t.status));
