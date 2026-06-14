/**
 * Notification CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 */

import { getDatabase } from '@myco/db/client.js';
import { epochSeconds } from '@myco/constants.js';
import { appendProjectCondition, type ProjectScope } from '@myco/db/queries/project-scope.js';
import type { GroveProjectId } from '@myco/grove/ids.js';
import type { NotificationStatus, NotificationMode, NotificationLevel } from '@myco/notifications/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of notifications per list query. */
const DEFAULT_LIMIT = 50;

/** Default retention for acknowledged notifications (30 days). */
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
  /**
   * Grove project id this notification belongs to, or `null` for
   * daemon-scope notifications that aren't tied to any single
   * project (e.g. backup failure for a Grove with no recently-active
   * project).
   */
  project_id: GroveProjectId | null;
}

/** Row shape returned from notifications queries. */
export interface NotificationRow {
  id: string;
  project_id: string | null;
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
  scope: ProjectScope;
  /**
   * When `true` and `scope` is `{ kind: 'project' }`, also include
   * daemon-scope rows (`project_id IS NULL`). Used by UI surfaces that
   * should show daemon-level notifications alongside the current
   * project's.
   */
  include_daemon_scope?: boolean;
  limit?: number;
  offset?: number;
}): NotificationRow[] {
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
  if (opts.include_daemon_scope && opts.scope.kind === 'project') {
    conditions.push('(project_id = ? OR project_id IS NULL)');
    params.push(opts.scope.id);
  } else {
    appendProjectCondition(conditions, params, opts.scope);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const offset = opts.offset ?? 0;

  return db.prepare(
    `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as NotificationRow[];
}

/** Count notifications by status. */
export function countNotifications(
  status: NotificationStatus | undefined,
  scope: ProjectScope,
  options: { includeDaemonScope?: boolean } = {},
): number {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (options.includeDaemonScope && scope.kind === 'project') {
    conditions.push('(project_id = ? OR project_id IS NULL)');
    params.push(scope.id);
  } else {
    appendProjectCondition(conditions, params, scope);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const row = db.prepare(`SELECT COUNT(*) as count FROM notifications ${where}`).get(...params) as { count: number };
  return row.count;
}

/** Get a single notification by ID. */
export function getNotification(id: string, scope: ProjectScope): NotificationRow | undefined {
  const db = getDatabase();
  const conditions = ['id = ?'];
  const params: unknown[] = [id];
  appendProjectCondition(conditions, params, scope);
  const row = db.prepare(`SELECT * FROM notifications WHERE ${conditions.join(' AND ')}`).get(...params) as NotificationRow | null | undefined;
  return row ?? undefined;
}

/** Update notification status (read, dismissed). */
export function updateNotificationStatus(
  id: string,
  status: NotificationStatus,
  scope: ProjectScope,
  options: { includeDaemonScope?: boolean } = {},
): boolean {
  const db = getDatabase();
  const conditions = ['id = ?'];
  const params: unknown[] = [id];
  if (options.includeDaemonScope && scope.kind === 'project') {
    conditions.push('(project_id = ? OR project_id IS NULL)');
    params.push(scope.id);
  } else {
    appendProjectCondition(conditions, params, scope);
  }
  const result = db.prepare(
    `UPDATE notifications SET status = ? WHERE ${conditions.join(' AND ')}`,
  ).run(status, ...params);
  return result.changes > 0;
}

/** Dismiss all notifications (or all within a domain). */
export function dismissAllNotifications(
  domain: string | undefined,
  scope: ProjectScope,
  options: { includeDaemonScope?: boolean } = {},
): number {
  const db = getDatabase();
  const conditions = ["status != 'dismissed'"];
  const params: unknown[] = [];
  if (domain) {
    conditions.push('domain = ?');
    params.push(domain);
  }
  if (options.includeDaemonScope && scope.kind === 'project') {
    conditions.push('(project_id = ? OR project_id IS NULL)');
    params.push(scope.id);
  } else {
    appendProjectCondition(conditions, params, scope);
  }
  const result = db.prepare(
    `UPDATE notifications SET status = 'dismissed' WHERE ${conditions.join(' AND ')}`,
  ).run(...params);
  return result.changes;
}

/** Mark all unread notifications as read (or within a domain). */
export function markAllRead(
  domain: string | undefined,
  scope: ProjectScope,
  options: { includeDaemonScope?: boolean } = {},
): number {
  const db = getDatabase();
  const conditions = ["status = 'unread'"];
  const params: unknown[] = [];
  if (domain) {
    conditions.push('domain = ?');
    params.push(domain);
  }
  if (options.includeDaemonScope && scope.kind === 'project') {
    conditions.push('(project_id = ? OR project_id IS NULL)');
    params.push(scope.id);
  } else {
    appendProjectCondition(conditions, params, scope);
  }
  const result = db.prepare(
    `UPDATE notifications SET status = 'read' WHERE ${conditions.join(' AND ')}`,
  ).run(...params);
  return result.changes;
}

/** Prune read/dismissed notifications older than the given threshold. */
export function pruneOldNotifications(
  maxAgeSeconds: number,
  scope: ProjectScope,
  options: { includeDaemonScope?: boolean } = {},
): number {
  const db = getDatabase();
  const cutoff = epochSeconds() - maxAgeSeconds;
  const conditions = ["status IN ('read', 'dismissed')", 'created_at < ?'];
  const params: unknown[] = [cutoff];
  if (options.includeDaemonScope && scope.kind === 'project') {
    conditions.push('(project_id = ? OR project_id IS NULL)');
    params.push(scope.id);
  } else {
    appendProjectCondition(conditions, params, scope);
  }
  const result = db.prepare(`DELETE FROM notifications WHERE ${conditions.join(' AND ')}`).run(...params);
  return result.changes;
}
