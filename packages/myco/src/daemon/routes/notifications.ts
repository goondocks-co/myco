/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  handleCreateNotification,
  handleDismissAll,
  handleGetRegistry,
  handleListNotifications,
  handleMarkAllRead,
  handleUnreadCount,
  handleUpdateNotification,
} from '../api/notifications.js';
import { tenantRoute } from '../api/route-helpers.js';
import type { DaemonLogger } from '../logger.js';
import type { RouteHandler } from '../router.js';

export type NotificationRouteScope = 'global' | 'tenant';

export const NOTIFICATION_ROUTE_SCOPES = {
  'GET /api/notifications': 'global',
  'POST /api/notifications': 'tenant',
  'PATCH /api/notifications/:id': 'global',
  'POST /api/notifications/dismiss-all': 'global',
  'POST /api/notifications/mark-all-read': 'global',
  'GET /api/notifications/registry': 'global',
  'GET /api/notifications/unread-count': 'global',
} as const satisfies Record<string, NotificationRouteScope>;

export interface NotificationRouteServer {
  registerRoute(method: string, routePath: string, handler: RouteHandler): void;
}

export interface NotificationRouteDeps {
  machineId: string;
  logger: DaemonLogger;
}

export function registerNotificationRoutes(
  server: NotificationRouteServer,
  deps: NotificationRouteDeps,
): void {
  // The READ/MUTATE routes (list, unread-count, PATCH status, dismiss-all,
  // mark-all-read) are the GLOBAL notification banner poll: the UI hits them on
  // EVERY page, including global pages (/settings, /logs, /groves) that carry
  // NO selected-project context. So they are deliberately NOT wrapped in
  // tenantRoute. This is a reviewed exemption, not a leak: no-context reads
  // scope to daemon rows plus the request project when one is supplied. See
  // tests/meta/no-anchor-as-tenancy.test.ts and notifications read-scope tests.
  //
  // The CREATE route stays wrapped in tenantRoute: the UI never calls it (it is
  // API-only), so it has no global-poll regression, and a create must land a
  // project-scoped row tagged with the authorized caller's project.
  server.registerRoute('GET', '/api/notifications', async (req) => handleListNotifications(req));
  server.registerRoute('POST', '/api/notifications', tenantRoute(deps, handleCreateNotification));
  server.registerRoute('PATCH', '/api/notifications/:id', async (req) => handleUpdateNotification(req));
  server.registerRoute('POST', '/api/notifications/dismiss-all', async (req) => handleDismissAll(req));
  server.registerRoute('POST', '/api/notifications/mark-all-read', async (req) => handleMarkAllRead(req));
  server.registerRoute('GET', '/api/notifications/registry', async () => handleGetRegistry());
  server.registerRoute('GET', '/api/notifications/unread-count', async (req) => handleUnreadCount(req));
}
