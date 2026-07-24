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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROVIDER_ROUTE_SCOPES,
  registerProviderRoutes,
} from '@myco/daemon/routes/providers.js';
import type { RouteHandler } from '@myco/daemon/router.js';
import {
  testPerUserLockNamespace,
  testPerUserLocksRoot,
} from '../../helpers/per-user-lock-namespace.js';

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

  it('routes provider-secret mutations through the injected lock namespace', async () => {
    const handlers = new Map<string, RouteHandler>();
    registerProviderRoutes({
      registerRoute(method: string, routePath: string, handler: RouteHandler): void {
        handlers.set(`${method} ${routePath}`, handler);
      },
    }, { lockNamespace: testPerUserLockNamespace });

    const mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-routes-'));
    const previousMycoHome = process.env.MYCO_HOME;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const lockDir = path.join(testPerUserLocksRoot, 'secrets');
    const locksBefore = new Set(fs.existsSync(lockDir) ? fs.readdirSync(lockDir) : []);

    try {
      process.env.MYCO_HOME = mycoHome;
      const put = handlers.get('PUT /api/providers/secrets/:provider');
      const remove = handlers.get('DELETE /api/providers/secrets/:provider');
      expect(put).toBeDefined();
      expect(remove).toBeDefined();

      const putResponse = await put!({
        body: { secret: 'route-test-secret' },
        params: { provider: 'openai' },
        pathname: '/api/providers/secrets/openai',
        query: {},
      });
      expect(putResponse.status).toBeUndefined();

      const newLocks = fs.readdirSync(lockDir).filter((name) => !locksBefore.has(name));
      expect(newLocks.length).toBeGreaterThan(0);

      const deleteResponse = await remove!({
        body: undefined,
        params: { provider: 'openai' },
        pathname: '/api/providers/secrets/openai',
        query: { scope: 'machine' },
      });
      expect(deleteResponse.status).toBeUndefined();
    } finally {
      if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousMycoHome;
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      fs.rmSync(mycoHome, { recursive: true, force: true });
    }
  });
});
