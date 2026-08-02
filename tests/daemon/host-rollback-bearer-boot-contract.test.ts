/*
 * Copyright 2026 Myco Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import fs from 'node:fs';

import { describe, expect, test } from 'bun:test';

describe('host rollback bearer startup contract', () => {
  test('reconciles committed host bearers inside containment and before fallible bootstrap work', () => {
    const source = fs.readFileSync(
      'packages/myco/src/daemon/main.ts',
      'utf-8',
    );
    const containment = source.indexOf(
      "externalMcpContainment.containWhile('reconcile'",
    );
    const reconciliation = source.indexOf(
      'const reconciledHostBearers = reconcileHostRollbackBearers()',
    );
    const bootstrapResolution = source.indexOf(
      "await import('../vault/bootstrap.js')",
    );

    expect(containment).toBeGreaterThan(-1);
    expect(reconciliation).toBeGreaterThan(containment);
    expect(bootstrapResolution).toBeGreaterThan(reconciliation);
  });
});
