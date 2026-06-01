/**
 * Notification API handlers.
 *
 * Thin handlers that delegate to DB queries and the notification registry.
 */

import { z } from 'zod';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { RequestPrincipal } from '../request-principal.js';
import {
  listNotifications,
  countNotifications,
  getNotification,
  updateNotificationStatus,
  dismissAllNotifications,
  markAllRead,
} from '../../db/queries/notifications.js';
import { getAllDomains } from '../../notifications/registry.js';
import { notify } from '../../notifications/notify.js';
import { loadMergedConfig } from '../../config/loader.js';
import type { NotificationMode } from '../../notifications/types.js';
import { projectScopeFromRequestContext, type MycoRequestContext } from '../../tools/request-context.js';
import type { GroveProjectId } from '../../grove/ids.js';

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
  requestContext?: MycoRequestContext,
): Promise<RouteResponse> {
  const status = query.status as 'unread' | 'read' | 'dismissed' | undefined;
  const domain = query.domain;
  const mode = query.mode as NotificationMode | undefined;
  const limit = query.limit ? Number(query.limit) : undefined;
  const offset = query.offset ? Number(query.offset) : undefined;
  // ?include_daemon=1 (or =true) merges daemon-scope rows in alongside
  // the request's project rows so a single feed surfaces both layers.
  const includeDaemon = query.include_daemon === '1' || query.include_daemon === 'true';

  const scope = projectScopeFromRequestContext(requestContext);
  const items = listNotifications({
    status,
    domain,
    mode,
    scope,
    include_daemon_scope: includeDaemon,
    limit,
    offset,
  });
  const unreadCount = countNotifications('unread', scope, { includeDaemonScope: includeDaemon });

  return {
    body: {
      items: items.map(parseNotificationRow),
      unread_count: unreadCount,
    },
  };
}

/**
 * POST /api/notifications — create a notification.
 *
 * Registered as a `tenantRoute`, so this handler always runs with an
 * authorized `principal` — a synthesized/anchor context is rejected (400 +
 * `tenancy.violation`) by the wrapper before we get here. The route is purely
 * tenant-scoped: every HTTP create lands a project-scoped row tagged with the
 * REQUEST's project id. Daemon-scope rows (`project_id = NULL`) are never
 * produced here — those come exclusively from the internal `notify(..., {
 * scope: 'daemon' })` callers (power-jobs, version-sync), which bypass HTTP.
 *
 * The enabled-gate config resolves from the REQUEST's tenancy
 * (`principal.tenancy.projectVaultDir` for the personal/local tier, its
 * `groveId` for the Grove-tier default), NOT the daemon's bootstrap anchor.
 * Notification settings are a per-machine/user preference (Grove default +
 * personal/local override, never project `myco.yaml`), so the anchor project's
 * config must have no say over whether a notification on project B is
 * suppressed.
 */
export async function handleCreateNotification(
  req: RouteRequest,
  principal: RequestPrincipal,
): Promise<RouteResponse> {
  const parsed = CreateNotificationBody.safeParse(req.body);
  if (!parsed.success) {
    return { status: 400, body: { error: 'validation_failed', issues: parsed.error.issues } };
  }

  const { domain, type, title, message, link, metadata } = parsed.data;

  const vaultDir = principal.tenancy.projectVaultDir;
  const requestContext = req.requestContext;

  // Resolve the enabled-gate against the REQUEST's grove + vault (Grove-tier
  // default merged under the personal/local override), never the bootstrap
  // anchor. Passing groveId keeps the Grove-tier notification settings in the
  // merge and the cache slots aligned with Grove-aware callers.
  const config = loadMergedConfig(vaultDir, { groveId: principal.tenancy.groveId });
  if (!config.notifications.enabled) {
    return { body: { ok: true, suppressed: true, reason: 'notifications_disabled' } };
  }
  const domainConfig = config.notifications.domains[domain];
  if (domainConfig && !domainConfig.enabled) {
    return { body: { ok: true, suppressed: true, reason: 'domain_disabled' } };
  }

  // Delegate resolution + insertion to notify() — pass config to avoid re-reading.
  // The row is tagged with the request's project id (project scope).
  const id = notify(vaultDir, {
    domain, type, title, message, link, metadata,
    level: parsed.data.level,
    mode: parsed.data.mode,
  }, config, { projectId: principal.tenancy.projectId as GroveProjectId });

  if (!id) {
    return { body: { ok: true, suppressed: true, reason: 'unknown' } };
  }
  const scope = projectScopeFromRequestContext(requestContext);

  return {
    body: {
      ok: true,
      id,
      notification: parseNotificationRow(getNotification(id, scope)!),
    },
  };
}

/** PATCH /api/notifications/:id — update status (read/dismissed). */
export async function handleUpdateNotification(
  _vaultDir: string,
  id: string,
  body: unknown,
  requestContext?: MycoRequestContext,
): Promise<RouteResponse> {
  const parsed = UpdateStatusBody.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: 'validation_failed', issues: parsed.error.issues } };
  }

  const updated = updateNotificationStatus(id, parsed.data.status, projectScopeFromRequestContext(requestContext));
  if (!updated) {
    return { status: 404, body: { error: 'not_found' } };
  }

  return { body: { ok: true } };
}

/** POST /api/notifications/dismiss-all — dismiss all (optionally per domain). */
export async function handleDismissAll(
  _vaultDir: string,
  body: unknown,
  requestContext?: MycoRequestContext,
): Promise<RouteResponse> {
  const domain = (body as Record<string, unknown>)?.domain as string | undefined;
  const count = dismissAllNotifications(domain, projectScopeFromRequestContext(requestContext));
  return { body: { ok: true, dismissed: count } };
}

/** POST /api/notifications/mark-all-read — mark all unread as read. */
export async function handleMarkAllRead(
  _vaultDir: string,
  body: unknown,
  requestContext?: MycoRequestContext,
): Promise<RouteResponse> {
  const domain = (body as Record<string, unknown>)?.domain as string | undefined;
  const count = markAllRead(domain, projectScopeFromRequestContext(requestContext));
  return { body: { ok: true, marked: count } };
}

/** GET /api/notifications/registry — return all registered domain descriptors. */
export async function handleGetRegistry(): Promise<RouteResponse> {
  return { body: { domains: getAllDomains() } };
}

/** GET /api/notifications/unread-count — lightweight unread count endpoint. */
export async function handleUnreadCount(
  requestContext?: MycoRequestContext,
  query: Record<string, string> = {},
): Promise<RouteResponse> {
  const includeDaemon = query.include_daemon === '1' || query.include_daemon === 'true';
  return {
    body: {
      count: countNotifications('unread', projectScopeFromRequestContext(requestContext), {
        includeDaemonScope: includeDaemon,
      }),
    },
  };
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
