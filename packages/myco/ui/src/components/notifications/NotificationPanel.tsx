import { useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X,
  Bell,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Info,
  MailCheck,
  Trash2,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';
import { MarkdownContent } from '../ui/markdown-content';
import {
  useNotifications,
  useUpdateNotification,
  useMarkAllRead,
  useDismissAll,
  type Notification,
  type NotificationLevel,
} from '../../hooks/use-notifications';

const LEVEL_DOT: Record<NotificationLevel, string> = {
  info: 'bg-primary',
  success: 'bg-green-500',
  warning: 'bg-secondary',
  error: 'bg-tertiary',
};

const LEVEL_ICONS: Record<NotificationLevel, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
};

const SECTION_TITLES = {
  unread: 'New',
  read: 'Earlier',
} as const;

function timeAgo(epochSec: number): string {
  const seconds = Math.floor(Date.now() / 1000) - epochSec;
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface NotificationPanelProps {
  open: boolean;
  onClose: () => void;
}

function NotificationSectionLabel({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center justify-between px-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-on-surface-variant">
        {title}
      </span>
      <span className="text-[11px] text-on-surface-variant/70">{count}</span>
    </div>
  );
}

function NotificationRow({
  notification,
  onOpen,
  onDismiss,
}: {
  notification: Notification;
  onOpen: (notification: Notification) => void;
  onDismiss: (e: React.MouseEvent, notification: Notification) => void;
}) {
  const Icon = LEVEL_ICONS[notification.level];
  const isUnread = notification.status === 'unread';

  return (
    <div
      onClick={() => onOpen(notification)}
      className={cn(
        'group cursor-pointer rounded-lg border border-transparent px-4 py-3 transition-colors hover:border-outline-variant/20 hover:bg-surface-container-high/70',
        isUnread && 'border-primary/10 bg-primary/[0.04]',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="relative mt-0.5 shrink-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
            <Icon className="h-4 w-4" />
          </div>
          {isUnread && (
            <span
              className={cn(
                'absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface-container',
                LEVEL_DOT[notification.level],
              )}
            />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn('text-sm font-medium', isUnread ? 'text-on-surface' : 'text-on-surface-variant')}>
                  {notification.title}
                </span>
                <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] uppercase tracking-wider text-on-surface-variant">
                  {notification.domain}
                </span>
              </div>
              {notification.message && (
                <MarkdownContent
                  content={notification.message}
                  compact
                  className="line-clamp-3 text-xs leading-5 text-on-surface-variant"
                />
              )}
            </div>

            <div className="flex shrink-0 items-start gap-2">
              <span className="pt-0.5 text-[10px] font-mono text-on-surface-variant/70">
                {timeAgo(notification.created_at)}
              </span>
              <button
                onClick={(e) => onDismiss(e, notification)}
                className="rounded p-0.5 text-on-surface-variant/40 opacity-0 transition hover:text-on-surface-variant group-hover:opacity-100"
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function NotificationPanel({ open, onClose }: NotificationPanelProps) {
  const { data, refetch } = useNotifications({ limit: 50 });
  const updateNotification = useUpdateNotification();
  const markAllRead = useMarkAllRead();
  const dismissAll = useDismissAll();
  const navigate = useNavigate();

  useEffect(() => {
    if (open) refetch();
  }, [open, refetch]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const handleClick = useCallback(
    (notification: Notification) => {
      if (notification.status === 'unread') {
        updateNotification.mutate({ id: notification.id, status: 'read' });
      }
      if (notification.link) {
        navigate(notification.link);
        onClose();
      }
    },
    [updateNotification, navigate, onClose],
  );

  const handleDismiss = useCallback(
    (e: React.MouseEvent, notification: Notification) => {
      e.stopPropagation();
      updateNotification.mutate({ id: notification.id, status: 'dismissed' });
    },
    [updateNotification],
  );

  const items = (data?.items ?? []).filter((notification) => notification.status !== 'dismissed');
  const unreadCount = data?.unread_count ?? 0;
  const unreadItems = items.filter((notification) => notification.status === 'unread');
  const readItems = items.filter((notification) => notification.status !== 'unread');

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-surface-dim/40 backdrop-blur-sm transition-opacity"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          'fixed top-0 right-0 bottom-0 z-50 flex w-96 max-w-[calc(100vw-3rem)] flex-col border-l border-outline-variant/20 bg-surface-container shadow-2xl transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="border-b border-outline-variant/20 px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-medium text-on-surface">Notifications</h2>
                {unreadCount > 0 && (
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-medium text-primary">
                    {unreadCount}
                  </span>
                )}
              </div>
              <p className="text-xs text-on-surface-variant">
                New items stay here until read or dismissed. Summary notifications live here even when no banner was shown.
              </p>
            </div>

            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => markAllRead.mutate(undefined)}
                  title="Mark all as read"
                  className="h-7 gap-1 px-2 text-xs text-on-surface-variant"
                >
                  <MailCheck className="h-3.5 w-3.5" />
                  Mark all read
                </Button>
              )}
              {items.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => dismissAll.mutate(undefined)}
                  title="Clear all notifications"
                  className="h-7 gap-1 px-2 text-xs text-on-surface-variant"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onClose} className="h-7 px-2">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 px-6 text-center">
              <Bell className="h-5 w-5 text-on-surface-variant/50" />
              <div className="text-sm text-on-surface-variant">No notifications yet</div>
              <div className="text-xs text-on-surface-variant/70">
                New events will appear here whether they display as banners or summary-only items.
              </div>
            </div>
          ) : (
            <div className="space-y-4 px-3 py-3">
              {unreadItems.length > 0 && (
                <section className="space-y-2">
                  <NotificationSectionLabel title={SECTION_TITLES.unread} count={unreadItems.length} />
                  <div className="space-y-2">
                    {unreadItems.map((notification) => (
                      <NotificationRow
                        key={notification.id}
                        notification={notification}
                        onOpen={handleClick}
                        onDismiss={handleDismiss}
                      />
                    ))}
                  </div>
                </section>
              )}

              {readItems.length > 0 && (
                <section className="space-y-2">
                  <NotificationSectionLabel title={SECTION_TITLES.read} count={readItems.length} />
                  <div className="space-y-2">
                    {readItems.map((notification) => (
                      <NotificationRow
                        key={notification.id}
                        notification={notification}
                        onOpen={handleClick}
                        onDismiss={handleDismiss}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
