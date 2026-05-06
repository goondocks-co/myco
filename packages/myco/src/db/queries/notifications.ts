/**
 * Notification CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 */

import { getDatabase } from '@myco/db/client.js';
import { epochSeconds } from '@myco/constants.js';
import type { GroveProjectId } from '@myco/grove/ids.js';
import type { NotificationStatus, NotificationMode, NotificationLevel } from '@myco/notifications/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of notifications per list query. */
const DEFAULT_LIMIT = 50;

/** Max age for auto-pruning dismissed notifications (30 days). */
export const NOTIFICATION_PRUNE_AGE_SECONDS = 30 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required when inserting a notification. */
export interface NotificationInsert {
  id: string;
  domain: string;
  type: string;
  level: NotificationLevel;
  title: string;
  message: string | null;
  mode: NotificationMode;
  link: string | null;
  metadata: string | null;
  /** Branded Grove project id this notification belongs to. */
  project_id: GroveProjectId;
}

/** Row shape returned from notifications queries. */
export interface NotificationRow {
  id: string;
  domain: string;
  type: string;
  level: string;
  title: string;
  message: string | null;
  mode: string;
  status: string;
  link: string | null;
  metadata: string | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Insert a new notification. */
export function insertNotification(n: NotificationInsert): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO notifications (id, domain, type, level, title, message, mode, status, link, metadata, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?, ?, ?)`,
  ).run(n.id, n.domain, n.type, n.level, n.title, n.message, n.mode, n.link, n.metadata, n.project_id, epochSeconds());
}

/** List notifications, newest first. Optionally filter by status and/or domain. */
export function listNotifications(opts: {
  status?: NotificationStatus;
  domain?: string;
  mode?: NotificationMode;
  limit?: number;
  offset?: number;
} = {}): NotificationRow[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.status) {
    conditions.push('status = ?');
    params.push(opts.status);
  }
  if (opts.domain) {
    conditions.push('domain = ?');
    params.push(opts.domain);
  }
  if (opts.mode) {
    conditions.push('mode = ?');
    params.push(opts.mode);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const offset = opts.offset ?? 0;

  return db.prepare(
    `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as NotificationRow[];
}

/** Count notifications by status. */
export function countNotifications(status?: NotificationStatus): number {
  const db = getDatabase();
  if (status) {
    const row = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE status = ?').get(status) as { count: number };
    return row.count;
  }
  const row = db.prepare('SELECT COUNT(*) as count FROM notifications').get() as { count: number };
  return row.count;
}

/** Get a single notification by ID. */
export function getNotification(id: string): NotificationRow | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRow | undefined;
}

/** Update notification status (read, dismissed). */
export function updateNotificationStatus(id: string, status: NotificationStatus): boolean {
  const db = getDatabase();
  const result = db.prepare('UPDATE notifications SET status = ? WHERE id = ?').run(status, id);
  return result.changes > 0;
}

/** Dismiss all notifications (or all within a domain). */
export function dismissAllNotifications(domain?: string): number {
  const db = getDatabase();
  if (domain) {
    const result = db.prepare("UPDATE notifications SET status = 'dismissed' WHERE domain = ? AND status != 'dismissed'").run(domain);
    return result.changes;
  }
  const result = db.prepare("UPDATE notifications SET status = 'dismissed' WHERE status != 'dismissed'").run();
  return result.changes;
}

/** Mark all unread notifications as read (or within a domain). */
export function markAllRead(domain?: string): number {
  const db = getDatabase();
  if (domain) {
    const result = db.prepare("UPDATE notifications SET status = 'read' WHERE domain = ? AND status = 'unread'").run(domain);
    return result.changes;
  }
  const result = db.prepare("UPDATE notifications SET status = 'read' WHERE status = 'unread'").run();
  return result.changes;
}

/** Prune dismissed notifications older than the given threshold. */
export function pruneOldNotifications(maxAgeSeconds: number = NOTIFICATION_PRUNE_AGE_SECONDS): number {
  const db = getDatabase();
  const cutoff = epochSeconds() - maxAgeSeconds;
  const result = db.prepare("DELETE FROM notifications WHERE status = 'dismissed' AND created_at < ?").run(cutoff);
  return result.changes;
}
