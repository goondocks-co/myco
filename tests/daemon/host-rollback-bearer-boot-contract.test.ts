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
      'reconciledHostBearers = reconcileHostRollbackBearers()',
    );
    const bootstrapResolution = source.indexOf(
      "await import('../vault/bootstrap.js')",
    );

    expect(containment).toBeGreaterThan(-1);
    expect(reconciliation).toBeGreaterThan(containment);
    expect(bootstrapResolution).toBeGreaterThan(reconciliation);
  });

  test('a reconcile failure cannot abort boot — the call sits in a try that continues', () => {
    // The other half of the contract. The reconcile must RUN at its ordered
    // place, and it must not be able to take the daemon down: one corrupt host
    // directory threw out of this call on the rig and killed the whole daemon,
    // purely local capture included. The registry quarantines per host now;
    // this pins the boot-level backstop for what the enumerators cannot
    // contain (an unreadable hosts dir, an untakeable lock).
    const source = fs.readFileSync(
      'packages/myco/src/daemon/main.ts',
      'utf-8',
    );
    const call = source.indexOf('reconciledHostBearers = reconcileHostRollbackBearers()');
    expect(call).toBeGreaterThan(-1);
    const windowBefore = source.slice(Math.max(0, call - 400), call);
    expect(windowBefore).toContain('try {');
    const windowAfter = source.slice(call, call + 600);
    expect(windowAfter).toContain('catch');
    expect(windowAfter).toContain('hostBearerReconcileFailure');
  });
});
