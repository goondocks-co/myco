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
  pruneOldNotifications,
} from '../../db/queries/notifications.js';
import { getAllDomains } from '../../notifications/registry.js';
import { notify } from '../../notifications/notify.js';
import { loadMachineConfig, loadMergedConfig } from '../../config/loader.js';
import type { NotificationMode } from '../../notifications/types.js';
import { projectScopeFromRequestContext } from '../../grove/request-context.js';
import { projectScope, type GroveProjectId, type ProjectScope } from '../../grove/ids.js';

const DEFAULT_NOTIFICATION_RETENTION_DAYS = 30;
const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Tenant scope for the CREATE route, which runs through `tenantRoute`. The
 * wrapper has already proved `principal.tenancy.projectId`/`groveId` are
 * caller-supplied (a synthesized/anchor context was rejected with 400 before we
 * got here), so a create is always scoped to the request's own project — never
 * the daemon's bootstrap anchor.
 *
 * The READ/MUTATE routes do NOT use this — they are the global, no-context
 * notification banner poll and scope by `projectScopeFromRequestContext` (which
 * resolves to the global/phantom scope when no project is selected). See the
 * route registrations in daemon/main.ts for why they are intentionally
 * unwrapped.
 */
function tenantProjectScope(principal: RequestPrincipal): ProjectScope {
  return projectScope(principal.tenancy.projectId as GroveProjectId);
}

function retentionSecondsForRequest(): number {
  const config = loadMachineConfig();
  return (config.notifications.retention_days ?? DEFAULT_NOTIFICATION_RETENTION_DAYS) * SECONDS_PER_DAY;
}

function pruneAcknowledgedForRequest(
  _req: RouteRequest,
  scope: ProjectScope,
  options: { includeDaemonScope?: boolean } = {},
): void {
  pruneOldNotifications(retentionSecondsForRequest(), scope, options);
}

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

/**
 * GET /api/notifications — list notifications with optional filters.
 *
 * GLOBAL, no-context banner poll: NOT wrapped in `tenantRoute`. The UI polls
 * this on every page, including global pages (`/settings`, `/logs`, `/groves`)
 * that carry no selected-project context, so a synthesized (no project/grove)
 * context must SUCCEED — not 400. It is leak-safe: with no project context
 * `projectScopeFromRequestContext` resolves to the global/phantom scope, so a
 * synthesized read returns no project rows (the phantom home has none) and only
 * the daemon-scope (`project_id IS NULL`) rows under `?include_daemon`. With a
 * caller-supplied context the read is scoped to the REQUEST's project; the
 * daemon-scope rows are merged in only when `?include_daemon` is passed.
 */
export async function handleListNotifications(
  req: RouteRequest,
): Promise<RouteResponse> {
  const query = req.query;
  const status = query.status as 'unread' | 'read' | 'dismissed' | undefined;
  const domain = query.domain;
  const mode = query.mode as NotificationMode | undefined;
  const limit = query.limit ? Number(query.limit) : undefined;
  const offset = query.offset ? Number(query.offset) : undefined;
  // ?include_daemon=1 (or =true) merges daemon-scope rows in alongside
  // the request's project rows so a single feed surfaces both layers.
  const includeDaemon = query.include_daemon === '1' || query.include_daemon === 'true';

  const scope = projectScopeFromRequestContext(req.requestContext);
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
  const scope = tenantProjectScope(principal);

  return {
    body: {
      ok: true,
      id,
      notification: parseNotificationRow(getNotification(id, scope)!),
    },
  };
}

/**
 * PATCH /api/notifications/:id — update status (read/dismissed).
 *
 * GLOBAL, no-context route (NOT wrapped in `tenantRoute`): the banner marks a
 * notification read/dismissed from any page. The update is scoped by
 * `projectScopeFromRequestContext`, so a synthesized/no-project context can
 * only ever match a global/phantom row — never another tenant's notification.
 */
export async function handleUpdateNotification(
  req: RouteRequest,
): Promise<RouteResponse> {
  const parsed = UpdateStatusBody.safeParse(req.body);
  if (!parsed.success) {
    return { status: 400, body: { error: 'validation_failed', issues: parsed.error.issues } };
  }

  const scope = projectScopeFromRequestContext(req.requestContext);
  const updated = updateNotificationStatus(
    req.params.id,
    parsed.data.status,
    scope,
    { includeDaemonScope: true },
  );
  if (!updated) {
    return { status: 404, body: { error: 'not_found' } };
  }
  pruneAcknowledgedForRequest(req, scope, { includeDaemonScope: true });

  return { body: { ok: true } };
}

/**
 * POST /api/notifications/dismiss-all — dismiss all (optionally per domain).
 *
 * GLOBAL, no-context route (NOT wrapped in `tenantRoute`): scoped by
 * `projectScopeFromRequestContext`, so a synthesized/no-project context only
 * dismisses global/phantom rows, never a tenant's.
 */
export async function handleDismissAll(
  req: RouteRequest,
): Promise<RouteResponse> {
  const domain = (req.body as Record<string, unknown>)?.domain as string | undefined;
  const scope = projectScopeFromRequestContext(req.requestContext);
  const count = dismissAllNotifications(domain, scope, { includeDaemonScope: true });
  pruneAcknowledgedForRequest(req, scope, { includeDaemonScope: true });
  return { body: { ok: true, dismissed: count } };
}

/**
 * POST /api/notifications/mark-all-read — mark all unread as read.
 *
 * GLOBAL, no-context route (NOT wrapped in `tenantRoute`): scoped by
 * `projectScopeFromRequestContext`, so a synthesized/no-project context only
 * marks global/phantom rows, never a tenant's.
 */
export async function handleMarkAllRead(
  req: RouteRequest,
): Promise<RouteResponse> {
  const domain = (req.body as Record<string, unknown>)?.domain as string | undefined;
  const scope = projectScopeFromRequestContext(req.requestContext);
  const count = markAllRead(domain, scope, { includeDaemonScope: true });
  pruneAcknowledgedForRequest(req, scope, { includeDaemonScope: true });
  return { body: { ok: true, marked: count } };
}

/** GET /api/notifications/registry — return all registered domain descriptors. */
export async function handleGetRegistry(): Promise<RouteResponse> {
  return { body: { domains: getAllDomains() } };
}

/**
 * GET /api/notifications/unread-count — lightweight unread count endpoint.
 *
 * GLOBAL, no-context badge poll (NOT wrapped in `tenantRoute`): the unread
 * badge polls on every page. Scoped by `projectScopeFromRequestContext`, so a
 * synthesized/no-project context counts only global/phantom rows (zero unless
 * `?include_daemon` merges the daemon-scope rows) — never a tenant's. With a
 * caller context the base count is the request's project; daemon-scope rows are
 * merged in only when `?include_daemon` is set.
 */
export async function handleUnreadCount(
  req: RouteRequest,
): Promise<RouteResponse> {
  const includeDaemon = req.query.include_daemon === '1' || req.query.include_daemon === 'true';
  return {
    body: {
      count: countNotifications('unread', projectScopeFromRequestContext(req.requestContext), {
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
