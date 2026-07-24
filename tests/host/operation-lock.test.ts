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
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertHostOperationLease,
  createHostOperationLock,
  type HostOperationLease,
} from '@myco/host/operation-lock.js';
import { createPerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';

let root: string;
let previousTeamHome: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-operation-lock-'));
  previousTeamHome = process.env.MYCO_TEAM_HOME;
  process.env.MYCO_TEAM_HOME = path.join(root, 'team-home');
});

afterEach(() => {
  if (previousTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
  else process.env.MYCO_TEAM_HOME = previousTeamHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function operationLock() {
  const namespace = createPerUserLockNamespace(() => path.join(root, 'locks'));
  return createHostOperationLock(namespace);
}

describe('host operation lock', () => {
  test('keeps a matching lease active only for the callback lifetime', async () => {
    let captured: HostOperationLease | undefined;

    await operationLock()('host-1', 'join', async (lease) => {
      captured = lease;
      expect(() => assertHostOperationLease(lease, 'host-1', 'join')).not.toThrow();
      expect(() => assertHostOperationLease(lease, 'host-1', 'leave')).toThrow(/Invalid or inactive/);
      expect(() => assertHostOperationLease(lease, 'host-2')).toThrow(/Invalid or inactive/);
    });

    expect(captured).toBeDefined();
    expect(() => assertHostOperationLease(captured!, 'host-1', 'join')).toThrow(/Invalid or inactive/);
  });

  test('rejects a concurrent operation for the same host', async () => {
    let releaseFirst!: () => void;
    let firstAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      firstAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const withOperationLock = operationLock();
    const first = withOperationLock('host-1', 'join', async () => {
      firstAcquired();
      await release;
    });

    await acquired;
    try {
      await expect(withOperationLock('host-1', 'leave', async () => {}))
        .rejects.toThrow(/already has a join or leave operation in progress/);
    } finally {
      releaseFirst();
      await first;
    }
  });

  test('releases the lock when the callback fails', async () => {
    const withOperationLock = operationLock();

    await expect(withOperationLock('host-1', 'join', async () => {
      throw new Error('join failed');
    })).rejects.toThrow('join failed');

    await expect(withOperationLock('host-1', 'leave', async () => 'released'))
      .resolves.toBe('released');
  });
});
