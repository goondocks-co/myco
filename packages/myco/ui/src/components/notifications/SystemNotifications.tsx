import { useEffect, useRef } from 'react';
import { useNotifications, type Notification } from '../../hooks/use-notifications';
import { useScopedConfig } from '../../hooks/use-scoped-config';
import { POLL_INTERVALS } from '../../lib/constants';

/**
 * Invisible component that fires browser Notification API alerts
 * for new unread notifications when the page is not focused.
 *
 * Only active when `notifications.system_notifications` is enabled in config.
 */
export function SystemNotifications() {
  const { effective } = useScopedConfig();
  const enabled = effective?.notifications?.system_notifications ?? false;
  const { data, refetch } = useNotifications({
    status: 'unread',
    mode: 'banner',
    limit: 5,
    enabled,
    pollCategory: 'heartbeat',
    refetchInterval: POLL_INTERVALS.PROGRESS,
  });
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.hasFocus()) return;

    const items = data?.items ?? [];
    for (const n of items) {
      if (seenRef.current.has(n.id)) continue;
      seenRef.current.add(n.id);
      showSystemNotification(n);
    }
  }, [enabled, data]);

  useEffect(() => {
    if (!enabled) return;

    const refetchWhenHidden = () => {
      if (document.hidden || !document.hasFocus()) {
        void refetch();
      }
    };

    document.addEventListener('visibilitychange', refetchWhenHidden);
    window.addEventListener('blur', refetchWhenHidden);

    return () => {
      document.removeEventListener('visibilitychange', refetchWhenHidden);
      window.removeEventListener('blur', refetchWhenHidden);
    };
  }, [enabled, refetch]);

  return null;
}

function showSystemNotification(n: Notification) {
  try {
    new window.Notification(n.title, {
      body: n.message ?? undefined,
      tag: n.id,
      icon: '/favicon.svg',
    });
  } catch {
    // Ignore — system notifications may fail silently in some environments
  }
}
