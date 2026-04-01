import { useEffect, useRef } from 'react';
import { useNotifications, type Notification } from '../../hooks/use-notifications';
import { useConfig } from '../../hooks/use-config';

/**
 * Invisible component that fires browser Notification API alerts
 * for new unread notifications when the page is not focused.
 *
 * Only active when `notifications.system_notifications` is enabled in config.
 */
export function SystemNotifications() {
  const { config } = useConfig();
  const enabled = config?.notifications?.system_notifications ?? false;
  const { data } = useNotifications({ status: 'unread', limit: 5 });
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
