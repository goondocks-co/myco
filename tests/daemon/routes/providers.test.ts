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
  PROVIDER_ROUTE_SCOPES,
  registerProviderRoutes,
} from '@myco/daemon/routes/providers.js';
import type { RouteHandler } from '@myco/daemon/router.js';

describe('registerProviderRoutes', () => {
  it('registers the provider route surface without path or method drift', () => {
    const routes: string[] = [];

    registerProviderRoutes({
      registerRoute(method: string, routePath: string, _handler: RouteHandler): void {
        routes.push(`${method} ${routePath}`);
      },
    });

    expect(routes).toEqual(Object.keys(PROVIDER_ROUTE_SCOPES));
  });

  it('classifies provider and provider-secret routes as machine-scoped', () => {
    expect(PROVIDER_ROUTE_SCOPES).toEqual({
      'GET /api/providers': 'machine',
      'POST /api/providers/test': 'machine',
      'GET /api/providers/secrets': 'machine',
      'PUT /api/providers/secrets/:provider': 'machine',
      'DELETE /api/providers/secrets/:provider': 'machine',
    });
  });
});
