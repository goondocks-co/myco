import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { usePowerQuery, type PollCategory } from './use-power-query';
import { POLL_INTERVALS } from '../lib/constants';
import { isAttachedTenancyPending, resolveAttachedEmpty } from '../lib/degrade';
import { useActiveProjectSelection } from './use-project-selection';
import { requestContextHeadersForSelection, selectionKey } from '../lib/selection';

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

/** Empty notification shapes — the zero-state an attached project's pinned
 *  scope shows before its first forwarded capture registers it host-side. */
const EMPTY_NOTIFICATIONS: NotificationListResponse = { items: [], unread_count: 0 };
const EMPTY_UNREAD_COUNT: UnreadCountResponse = { count: 0 };

interface RegistryResponse {
  domains: NotificationDomainDescriptor[];
}

interface NotificationQueryOptions {
  status?: NotificationStatus;
  domain?: string;
  mode?: NotificationMode;
  limit?: number;
  enabled?: boolean;
  pollCategory?: PollCategory;
  refetchInterval?: number | false;
  /**
   * When true, daemon-scope notifications (project_id IS NULL) are
   * merged in with the current project's. Used by the system banner
   * and Operations dashboard so daemon-global events surface
   * regardless of which project is open.
   */
  includeDaemon?: boolean;
}

// ---------------------------------------------------------------------------
// Poll interval for unread count badge
// ---------------------------------------------------------------------------

const UNREAD_COUNT_POLL_MS = POLL_INTERVALS.LOGS;

// ---------------------------------------------------------------------------
// Pinned scope — project headers independent of ambient request context
// ---------------------------------------------------------------------------

/**
 * Headers and cache key that pin every notification request to the active
 * selected project, independent of the page's ambient request context. Keeps
 * the bell, panel, and banner showing the selected project's notifications
 * even on machine-scoped pages (which otherwise carry no project header).
 */
function usePinnedNotificationScope() {
  const selection = useActiveProjectSelection();
  return {
    selection,
    headers: requestContextHeadersForSelection(selection),
    key: selection ? selectionKey(selection) : 'none',
  };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Poll for unread notification count (lightweight endpoint). */
export function useUnreadCount(opts?: { includeDaemon?: boolean }) {
  const { selection, headers, key } = usePinnedNotificationScope();
  const path = opts?.includeDaemon
    ? '/notifications/unread-count?include_daemon=1'
    : '/notifications/unread-count';
  return resolveAttachedEmpty(
    usePowerQuery<UnreadCountResponse>({
      queryKey: ['notifications', 'unread-count', { includeDaemon: !!opts?.includeDaemon }, key],
      queryFn: ({ signal }) => fetchJson<UnreadCountResponse>(path, { signal, headers }),
      refetchInterval: (query) =>
        isAttachedTenancyPending(query.state.error, selection) ? false : UNREAD_COUNT_POLL_MS,
      retry: (failureCount, err) =>
        isAttachedTenancyPending(err, selection) ? false : failureCount < 3,
      pollCategory: 'standard',
    }),
    selection,
    EMPTY_UNREAD_COUNT,
  );
}

/** Fetch notifications with optional filters. */
export function useNotifications(opts?: NotificationQueryOptions) {
  const { selection, headers, key } = usePinnedNotificationScope();
  const params = new URLSearchParams();
  if (opts?.status) params.set('status', opts.status);
  if (opts?.domain) params.set('domain', opts.domain);
  if (opts?.mode) params.set('mode', opts.mode);
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.includeDaemon) params.set('include_daemon', '1');
  const qs = params.toString();
  const path = qs ? `/notifications?${qs}` : '/notifications';

  return resolveAttachedEmpty(
    usePowerQuery<NotificationListResponse>({
      queryKey: ['notifications', 'list', opts, key],
      queryFn: ({ signal }) => fetchJson<NotificationListResponse>(path, { signal, headers }),
      enabled: opts?.enabled,
      pollCategory: opts?.pollCategory ?? 'standard',
      refetchInterval: (query) =>
        isAttachedTenancyPending(query.state.error, selection)
          ? false
          : opts?.refetchInterval ?? false,
      retry: (failureCount, err) =>
        isAttachedTenancyPending(err, selection) ? false : failureCount < 3,
    }),
    selection,
    EMPTY_NOTIFICATIONS,
  );
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
  const { headers } = usePinnedNotificationScope();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'read' | 'dismissed' }) =>
      fetchJson(`/notifications/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
        headers: { 'Content-Type': 'application/json', ...headers },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

/** Dismiss all notifications (optionally per domain). */
export function useDismissAll() {
  const qc = useQueryClient();
  const { headers } = usePinnedNotificationScope();
  return useMutation({
    mutationFn: (domain?: string) =>
      fetchJson('/notifications/dismiss-all', {
        method: 'POST',
        body: JSON.stringify(domain ? { domain } : {}),
        headers: { 'Content-Type': 'application/json', ...headers },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

/** Mark all unread as read. */
export function useMarkAllRead() {
  const qc = useQueryClient();
  const { headers } = usePinnedNotificationScope();
  return useMutation({
    mutationFn: (domain?: string) =>
      fetchJson('/notifications/mark-all-read', {
        method: 'POST',
        body: JSON.stringify(domain ? { domain } : {}),
        headers: { 'Content-Type': 'application/json', ...headers },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
