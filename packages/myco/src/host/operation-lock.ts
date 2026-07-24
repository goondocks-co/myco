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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveHostsDir } from '@myco/grove/paths.js';
import {
  LifecycleLock,
  type LockHandle,
} from '@myco/utils/lifecycle-lock.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';
import { physicalPathLockIdentities } from '@myco/utils/physical-path-identity.js';

const HOST_OPERATION_LOCK_DIR_MODE = 0o700;
const HOST_OPERATION_LOCK_RETRIES = 8;
const HOST_OPERATION_LOCK_NAMESPACE = 'host-operation';
const activeLeases = new WeakSet<object>();
declare const hostOperationLeaseBrand: unique symbol;

export interface HostOperationLease {
  readonly hostId: string;
  readonly operation: 'join' | 'leave';
  readonly [hostOperationLeaseBrand]: true;
}

function hostOperationLockPath(
  identity: string,
  hostId: string,
  lockNamespace: PerUserLockNamespace,
): string {
  const key = createHash('sha256')
    .update(`${HOST_OPERATION_LOCK_NAMESPACE}\0${identity}\0${hostId}`)
    .digest('hex');
  return path.join(lockNamespace.resolve('host-operations'), `${key}.lock`);
}

function hostOperationLockPaths(
  hostId: string,
  lockNamespace: PerUserLockNamespace,
): string[] {
  const lockDir = lockNamespace.resolve('host-operations');
  fs.mkdirSync(lockDir, { recursive: true, mode: HOST_OPERATION_LOCK_DIR_MODE });
  try { fs.chmodSync(lockDir, HOST_OPERATION_LOCK_DIR_MODE); } catch { /* platform ACLs apply */ }
  fs.mkdirSync(resolveHostsDir(), { recursive: true, mode: HOST_OPERATION_LOCK_DIR_MODE });
  return physicalPathLockIdentities(resolveHostsDir())
    .map((identity) => hostOperationLockPath(identity, hostId, lockNamespace))
    .sort();
}

function releaseLocks(locks: LockHandle[]): void {
  for (const lock of locks.reverse()) lock.release();
}

async function withAcquiredHostOperationLocks<T>(
  hostId: string,
  operation: 'join' | 'leave',
  fn: (lease: HostOperationLease) => Promise<T>,
  lockNamespace: PerUserLockNamespace,
): Promise<T> {
  for (let attempt = 0; attempt < HOST_OPERATION_LOCK_RETRIES; attempt += 1) {
    const paths = hostOperationLockPaths(hostId, lockNamespace);
    const locks: LockHandle[] = [];
    for (const lockPath of paths) {
      const result = LifecycleLock.acquire(lockPath, {
        command: `myco host ${operation} ${hostId}`,
      });
      if (!result.acquired) {
        releaseLocks(locks);
        const holder = result.holderPid === null ? '' : ` by process ${result.holderPid}`;
        throw new Error(
          `Host ${hostId} already has a join or leave operation in progress${holder}; retry after it finishes.`,
        );
      }
      locks.push(result.lock);
    }

    const freshPaths = hostOperationLockPaths(hostId, lockNamespace);
    if (freshPaths.length !== paths.length
      || freshPaths.some((lockPath, index) => lockPath !== paths[index])) {
      releaseLocks(locks);
      continue;
    }

    const lease = { hostId, operation } as HostOperationLease;
    activeLeases.add(lease);
    try {
      return await fn(lease);
    } finally {
      activeLeases.delete(lease);
      releaseLocks(locks);
    }
  }
  throw new Error(`Host ${hostId} operation-lock identity did not stabilize.`);
}

/**
 * Serialize the full async join/leave lifecycle for one host.
 * The kernel releases every held lock if the process exits unexpectedly.
 */
export function withHostOperationLock<T>(
  hostId: string,
  operation: 'join' | 'leave',
  fn: (lease: HostOperationLease) => Promise<T>,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): Promise<T> {
  return withAcquiredHostOperationLocks(hostId, operation, fn, lockNamespace);
}

export function createHostOperationLock(lockNamespace: PerUserLockNamespace) {
  return <T>(
    hostId: string,
    operation: 'join' | 'leave',
    fn: (lease: HostOperationLease) => Promise<T>,
  ): Promise<T> => withHostOperationLock(hostId, operation, fn, lockNamespace);
}

export function assertHostOperationLease(
  lease: HostOperationLease,
  hostId: string,
  operation?: HostOperationLease['operation'],
): void {
  if (!activeLeases.has(lease)
    || lease.hostId !== hostId
    || (operation !== undefined && lease.operation !== operation)) {
    throw new Error(`Invalid or inactive host operation lease for ${hostId}.`);
  }
}
