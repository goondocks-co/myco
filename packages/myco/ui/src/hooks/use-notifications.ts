import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../lib/api';
import { usePowerQuery, type PollCategory } from './use-power-query';
import { POLL_INTERVALS } from '../lib/constants';

// ---------------------------------------------------------------------------
// Types (mirror backend)
// ---------------------------------------------------------------------------

export type NotificationMode = 'banner' | 'summary';
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';
export type NotificationStatus = 'unread' | 'read' | 'dismissed';

export interface Notification {
  id: string;
  domain: string;
  type: string;
  level: NotificationLevel;
  title: string;
  message: string | null;
  mode: NotificationMode;
  status: NotificationStatus;
  link: string | null;
  metadata: Record<string, unknown> | null;
  created_at: number;
}

export interface NotificationTypeDescriptor {
  id: string;
  label: string;
  defaultMode: NotificationMode;
  defaultLevel: NotificationLevel;
}

export interface NotificationDomainDescriptor {
  domain: string;
  label: string;
  types: NotificationTypeDescriptor[];
}

interface NotificationListResponse {
  items: Notification[];
  unread_count: number;
}

interface UnreadCountResponse {
  count: number;
}

interface RegistryResponse {
  domains: NotificationDomainDescriptor[];
}

// ---------------------------------------------------------------------------
// Poll interval for unread count badge
// ---------------------------------------------------------------------------

const UNREAD_COUNT_POLL_MS = POLL_INTERVALS.LOGS;

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Poll for unread notification count (lightweight endpoint). */
export function useUnreadCount() {
  return usePowerQuery<UnreadCountResponse>({
    queryKey: ['notifications', 'unread-count'],
    queryFn: ({ signal }) => fetchJson<UnreadCountResponse>('/notifications/unread-count', { signal }),
    refetchInterval: UNREAD_COUNT_POLL_MS,
    pollCategory: 'standard',
  });
}

/** Fetch notifications with optional filters. */
export function useNotifications(opts?: {
  status?: NotificationStatus;
  domain?: string;
  mode?: NotificationMode;
  limit?: number;
  enabled?: boolean;
  pollCategory?: PollCategory;
  refetchInterval?: number | false;
}) {
  const params = new URLSearchParams();
  if (opts?.status) params.set('status', opts.status);
  if (opts?.domain) params.set('domain', opts.domain);
  if (opts?.mode) params.set('mode', opts.mode);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const path = qs ? `/notifications?${qs}` : '/notifications';

  return useQuery<NotificationListResponse>({
    queryKey: ['notifications', 'list', opts],
    queryFn: ({ signal }) => fetchJson<NotificationListResponse>(path, { signal }),
    enabled: opts?.enabled,
  });
}

/** Fetch notifications with power-aware polling support. */
export function useLiveNotifications(opts?: {
  status?: NotificationStatus;
  domain?: string;
  mode?: NotificationMode;
  limit?: number;
  enabled?: boolean;
  pollCategory: PollCategory;
  refetchInterval: number;
}) {
  const params = new URLSearchParams();
  if (opts?.status) params.set('status', opts.status);
  if (opts?.domain) params.set('domain', opts.domain);
  if (opts?.mode) params.set('mode', opts.mode);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const path = qs ? `/notifications?${qs}` : '/notifications';

  return usePowerQuery<NotificationListResponse>({
    queryKey: ['notifications', 'list', opts],
    queryFn: ({ signal }) => fetchJson<NotificationListResponse>(path, { signal }),
    enabled: opts?.enabled,
    pollCategory: opts.pollCategory,
    refetchInterval: opts.refetchInterval,
  });
}

/** Fetch the notification registry (registered domains and types). */
export function useNotificationRegistry() {
  return useQuery<RegistryResponse>({
    queryKey: ['notifications', 'registry'],
    queryFn: ({ signal }) => fetchJson<RegistryResponse>('/notifications/registry', { signal }),
    staleTime: 60_000,
  });
}

/** Mark a single notification as read or dismissed. */
export function useUpdateNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'read' | 'dismissed' }) =>
      fetchJson(`/notifications/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
        headers: { 'Content-Type': 'application/json' },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

/** Dismiss all notifications (optionally per domain). */
export function useDismissAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain?: string) =>
      postJson('/notifications/dismiss-all', domain ? { domain } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

/** Mark all unread as read. */
export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain?: string) =>
      postJson('/notifications/mark-all-read', domain ? { domain } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
