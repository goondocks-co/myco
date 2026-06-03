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

import { describe, expect, it } from 'bun:test';
import {
  NOTIFICATION_ROUTE_SCOPES,
  registerNotificationRoutes,
} from '@myco/daemon/routes/notifications.js';
import type { DaemonLogger } from '@myco/daemon/logger.js';
import type { RouteHandler } from '@myco/daemon/router.js';

describe('registerNotificationRoutes', () => {
  it('registers the notification route surface without path or method drift', () => {
    const routes: string[] = [];
    const logger = {} as DaemonLogger;

    registerNotificationRoutes({
      registerRoute(method: string, routePath: string, _handler: RouteHandler): void {
        routes.push(`${method} ${routePath}`);
      },
    }, { machineId: 'machine-test', logger });

    expect(routes).toEqual(Object.keys(NOTIFICATION_ROUTE_SCOPES));
  });

  it('keeps global banner routes separate from the tenant-scoped create route', () => {
    expect(NOTIFICATION_ROUTE_SCOPES).toEqual({
      'GET /api/notifications': 'global',
      'POST /api/notifications': 'tenant',
      'PATCH /api/notifications/:id': 'global',
      'POST /api/notifications/dismiss-all': 'global',
      'POST /api/notifications/mark-all-read': 'global',
      'GET /api/notifications/registry': 'global',
      'GET /api/notifications/unread-count': 'global',
    });
  });
});
