import { useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X,
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

export function NotificationPanel({ open, onClose }: NotificationPanelProps) {
  const { data, refetch } = useNotifications({ limit: 50 });
  const updateNotification = useUpdateNotification();
  const markAllRead = useMarkAllRead();
  const dismissAll = useDismissAll();
  const navigate = useNavigate();

  // Refetch when panel opens
  useEffect(() => {
    if (open) refetch();
  }, [open, refetch]);

  // Close on Escape
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
    (n: Notification) => {
      if (n.status === 'unread') {
        updateNotification.mutate({ id: n.id, status: 'read' });
      }
      if (n.link) {
        navigate(n.link);
        onClose();
      }
    },
    [updateNotification, navigate, onClose],
  );

  const handleDismiss = useCallback(
    (e: React.MouseEvent, n: Notification) => {
      e.stopPropagation();
      updateNotification.mutate({ id: n.id, status: 'dismissed' });
    },
    [updateNotification],
  );

  const items = (data?.items ?? []).filter(n => n.status !== 'dismissed');
  const unreadCount = data?.unread_count ?? 0;

  return (
    <>
      {/* Overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-surface-dim/40 backdrop-blur-sm transition-opacity"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Panel */}
      <aside
        className={cn(
          'fixed top-0 right-0 bottom-0 z-50 w-96 max-w-[calc(100vw-3rem)] flex flex-col bg-surface-container border-l border-outline-variant/20 shadow-2xl transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/20">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-on-surface">Notifications</h2>
            {unreadCount > 0 && (
              <span className="inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full bg-primary/15 text-primary text-xs font-medium">
                {unreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => markAllRead.mutate(undefined)}
                title="Mark all as read"
                className="h-7 px-2 gap-1 text-xs text-on-surface-variant"
              >
                <MailCheck className="h-3.5 w-3.5" />
                Read all
              </Button>
            )}
            {items.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => dismissAll.mutate(undefined)}
                title="Clear all notifications"
                className="h-7 px-2 gap-1 text-xs text-on-surface-variant"
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

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-sm text-on-surface-variant">
              No notifications
            </div>
          ) : (
            <div className="divide-y divide-outline-variant/10">
              {items.map((n) => {
                const Icon = LEVEL_ICONS[n.level];
                return (
                  <div
                    key={n.id}
                    onClick={() => handleClick(n)}
                    className={cn(
                      'flex items-start gap-3 px-4 py-3 transition-colors cursor-pointer hover:bg-surface-container-high',
                      n.status === 'unread' && 'bg-primary/[0.03]',
                    )}
                  >
                    <div className="relative mt-0.5 shrink-0">
                      <Icon className="h-4 w-4 text-on-surface-variant" />
                      {n.status === 'unread' && (
                        <span className={cn('absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full', LEVEL_DOT[n.level])} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={cn('text-sm font-medium truncate', n.status === 'unread' ? 'text-on-surface' : 'text-on-surface-variant')}>
                          {n.title}
                        </span>
                        <span className="text-[10px] text-on-surface-variant/60 shrink-0 font-mono">
                          {timeAgo(n.created_at)}
                        </span>
                      </div>
                      {n.message && (
                        <MarkdownContent
                          content={n.message}
                          compact
                          className="text-xs mt-0.5 line-clamp-2"
                        />
                      )}
                      <span className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider mt-1 inline-block">
                        {n.domain}
                      </span>
                    </div>
                    {n.status !== 'dismissed' && (
                      <button
                        onClick={(e) => handleDismiss(e, n)}
                        className="shrink-0 mt-0.5 rounded p-0.5 text-on-surface-variant/40 hover:text-on-surface-variant transition-colors"
                        aria-label="Dismiss"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
