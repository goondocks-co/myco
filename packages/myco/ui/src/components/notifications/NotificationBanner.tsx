import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, CheckCircle2, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { cn } from '../../lib/cn';
import { POLL_INTERVALS } from '../../lib/constants';
import { useNotifications, useUpdateNotification, type Notification, type NotificationLevel } from '../../hooks/use-notifications';

const BANNER_MAX_VISIBLE = 3;
const BANNER_AUTO_DISMISS_MS = 5_000;
const BANNER_EDGE_OFFSET_PX = 12;
const BANNER_PANEL_OFFSET_PX = 400;
const NOTIFICATION_NAVIGATION_SOURCE = 'notification-banner';

const LEVEL_STYLES: Record<NotificationLevel, string> = {
  info: 'bg-primary/10 border-primary/20 text-primary',
  success: 'bg-green-500/10 border-green-500/20 text-green-600 dark:text-green-400',
  warning: 'bg-secondary/10 border-secondary/20 text-secondary',
  error: 'bg-tertiary/10 border-tertiary/20 text-tertiary',
};

const LEVEL_ICONS: Record<NotificationLevel, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
};

export function NotificationBanner({ panelOpen = false }: { panelOpen?: boolean }) {
  const { data } = useNotifications({
    status: 'unread',
    mode: 'banner',
    limit: BANNER_MAX_VISIBLE,
    pollCategory: 'realtime',
    refetchInterval: POLL_INTERVALS.LOGS,
  });
  const updateNotification = useUpdateNotification();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const banners = (data?.items ?? []).filter((n) => !dismissed.has(n.id));

  // Banner mode is intentionally transient. Even failure banners should clear
  // quickly so the notification center remains the durable record.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const n of banners) {
      timers.push(
        setTimeout(() => {
          setDismissed((prev) => new Set(prev).add(n.id));
          updateNotification.mutate({ id: n.id, status: 'read' });
        }, BANNER_AUTO_DISMISS_MS),
      );
    }
    return () => timers.forEach(clearTimeout);
  }, [banners.map((n) => n.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (banners.length === 0) return null;

  const handleClick = (n: Notification) => {
    updateNotification.mutate({ id: n.id, status: 'read' });
    setDismissed((prev) => new Set(prev).add(n.id));
    if (n.link) {
      navigate(n.link, {
        state: {
          source: NOTIFICATION_NAVIGATION_SOURCE,
          triggeredAt: Date.now(),
        },
      });
    }
  };

  const handleDismiss = (e: React.MouseEvent, n: Notification) => {
    e.stopPropagation();
    setDismissed((prev) => new Set(prev).add(n.id));
    updateNotification.mutate({ id: n.id, status: 'read' });
  };

  return (
    <div
      className="fixed top-3 z-[60] flex w-80 flex-col gap-2"
      style={{ right: panelOpen ? BANNER_PANEL_OFFSET_PX : BANNER_EDGE_OFFSET_PX }}
    >
      {banners.map((n) => {
        const Icon = LEVEL_ICONS[n.level];
        return (
          <div
            key={n.id}
            onClick={() => handleClick(n)}
            className={cn(
              'flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm shadow-lg cursor-pointer transition-all animate-in slide-in-from-right-5 fade-in duration-200',
              LEVEL_STYLES[n.level],
            )}
          >
            <Icon className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{n.title}</div>
              {n.message && (
                <div className="text-xs mt-0.5 opacity-80 line-clamp-2">{n.message}</div>
              )}
            </div>
            <button
              onClick={(e) => handleDismiss(e, n)}
              className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100 transition-opacity"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
