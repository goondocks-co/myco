/**
 * Notification API handlers.
 *
 * Thin handlers that delegate to DB queries and the notification registry.
 */

import { z } from 'zod';
import crypto from 'node:crypto';
import type { RouteResponse } from '../router.js';
import {
  insertNotification,
  listNotifications,
  countNotifications,
  getNotification,
  updateNotificationStatus,
  dismissAllNotifications,
  markAllRead,
} from '../../db/queries/notifications.js';
import { getAllDomains, getType } from '../../notifications/registry.js';
import { loadConfig } from '../../config/loader.js';
import type { NotificationMode, NotificationLevel } from '../../notifications/types.js';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreateNotificationBody = z.object({
  domain: z.string().min(1),
  type: z.string().min(1),
  level: z.enum(['info', 'success', 'warning', 'error']).optional(),
  title: z.string().min(1),
  message: z.string().optional(),
  mode: z.enum(['banner', 'summary']).optional(),
  link: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const UpdateStatusBody = z.object({
  status: z.enum(['read', 'dismissed']),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** GET /api/notifications — list notifications with optional filters. */
export async function handleListNotifications(
  _vaultDir: string,
  query: Record<string, string>,
): Promise<RouteResponse> {
  const status = query.status as 'unread' | 'read' | 'dismissed' | undefined;
  const domain = query.domain;
  const mode = query.mode as NotificationMode | undefined;
  const limit = query.limit ? Number(query.limit) : undefined;
  const offset = query.offset ? Number(query.offset) : undefined;

  const items = listNotifications({ status, domain, mode, limit, offset });
  const unreadCount = countNotifications('unread');

  return {
    body: {
      items: items.map(parseNotificationRow),
      unread_count: unreadCount,
    },
  };
}

/** POST /api/notifications — create a notification. */
export async function handleCreateNotification(
  vaultDir: string,
  body: unknown,
): Promise<RouteResponse> {
  const parsed = CreateNotificationBody.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: 'validation_failed', issues: parsed.error.issues } };
  }

  const { domain, type, title, message, link, metadata } = parsed.data;

  // Check global + domain enabled
  const config = loadConfig(vaultDir);
  if (!config.notifications.enabled) {
    return { body: { ok: true, suppressed: true, reason: 'notifications_disabled' } };
  }

  const domainConfig = config.notifications.domains[domain];
  if (domainConfig && !domainConfig.enabled) {
    return { body: { ok: true, suppressed: true, reason: 'domain_disabled' } };
  }

  // Resolve mode and level from registry defaults or request overrides
  const registeredType = getType(type);
  const mode: NotificationMode = parsed.data.mode
    ?? registeredType?.type.defaultMode
    ?? config.notifications.default_mode;
  const level: NotificationLevel = parsed.data.level
    ?? registeredType?.type.defaultLevel
    ?? 'info';

  const id = crypto.randomUUID();

  insertNotification({
    id,
    domain,
    type,
    level,
    title,
    message: message ?? null,
    mode,
    link: link ?? null,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });

  return {
    body: {
      ok: true,
      id,
      notification: parseNotificationRow(getNotification(id)!),
    },
  };
}

/** PATCH /api/notifications/:id — update status (read/dismissed). */
export async function handleUpdateNotification(
  _vaultDir: string,
  id: string,
  body: unknown,
): Promise<RouteResponse> {
  const parsed = UpdateStatusBody.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: 'validation_failed', issues: parsed.error.issues } };
  }

  const updated = updateNotificationStatus(id, parsed.data.status);
  if (!updated) {
    return { status: 404, body: { error: 'not_found' } };
  }

  return { body: { ok: true } };
}

/** POST /api/notifications/dismiss-all — dismiss all (optionally per domain). */
export async function handleDismissAll(
  _vaultDir: string,
  body: unknown,
): Promise<RouteResponse> {
  const domain = (body as Record<string, unknown>)?.domain as string | undefined;
  const count = dismissAllNotifications(domain);
  return { body: { ok: true, dismissed: count } };
}

/** POST /api/notifications/mark-all-read — mark all unread as read. */
export async function handleMarkAllRead(
  _vaultDir: string,
  body: unknown,
): Promise<RouteResponse> {
  const domain = (body as Record<string, unknown>)?.domain as string | undefined;
  const count = markAllRead(domain);
  return { body: { ok: true, marked: count } };
}

/** GET /api/notifications/registry — return all registered domain descriptors. */
export async function handleGetRegistry(): Promise<RouteResponse> {
  return { body: { domains: getAllDomains() } };
}

/** GET /api/notifications/unread-count — lightweight unread count endpoint. */
export async function handleUnreadCount(): Promise<RouteResponse> {
  return { body: { count: countNotifications('unread') } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseNotificationRow(row: ReturnType<typeof getNotification>) {
  if (!row) return null;
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}
