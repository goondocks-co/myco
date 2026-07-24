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
  handleGetProviders,
  handleTestProvider,
} from '../api/providers.js';
import {
  handleDeleteProviderSecret,
  handleGetProviderSecrets,
  handlePutProviderSecret,
} from '../api/provider-secrets.js';
import type { DaemonLogger } from '../logger.js';
import type { RouteRegistrar } from '../router.js';
import type { PerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';

export type ProviderRouteScope = 'machine';

export const PROVIDER_ROUTE_SCOPES = {
  'GET /api/providers': 'machine',
  'POST /api/providers/test': 'machine',
  'GET /api/providers/secrets': 'machine',
  'PUT /api/providers/secrets/:provider': 'machine',
  'DELETE /api/providers/secrets/:provider': 'machine',
} as const satisfies Record<string, ProviderRouteScope>;

export interface ProviderRouteDeps {
  logger?: DaemonLogger;
  lockNamespace?: PerUserLockNamespace;
}

export function registerProviderRoutes(
  server: RouteRegistrar,
  deps: ProviderRouteDeps = {},
): void {
  server.registerRoute('GET', '/api/providers', async () => handleGetProviders(deps.logger));
  server.registerRoute('POST', '/api/providers/test', async (req) => handleTestProvider(req));

  // Machine-scoped, daemon-global: these read/write `~/.myco/secrets.env`
  // (machine-level keys), not any tenant's vault, so they are deliberately
  // classified as machine routes instead of tenantRoute-wrapped handlers.
  server.registerRoute('GET', '/api/providers/secrets', async (req) => handleGetProviderSecrets(req));
  server.registerRoute(
    'PUT',
    '/api/providers/secrets/:provider',
    async (req) => handlePutProviderSecret(req, deps.lockNamespace),
  );
  server.registerRoute(
    'DELETE',
    '/api/providers/secrets/:provider',
    async (req) => handleDeleteProviderSecret(req, deps.lockNamespace),
  );
}
