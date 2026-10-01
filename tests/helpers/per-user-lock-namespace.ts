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
import path from 'node:path';

import { createPerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';

export const TEST_PER_USER_LOCKS_ROOT_ENV = 'MYCO_TEST_PER_USER_LOCKS_ROOT';

/** The lock root the runner or the test preload (tests/setup/sandbox-preload.ts) made for this test process. */
function resolveTestPerUserLocksRoot(): string {
  const root = process.env[TEST_PER_USER_LOCKS_ROOT_ENV];
  if (root === undefined || !path.isAbsolute(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`${TEST_PER_USER_LOCKS_ROOT_ENV} must name an existing absolute directory`);
  }
  return root;
}

export const testPerUserLocksRoot = resolveTestPerUserLocksRoot();
export const testPerUserLockNamespace = createPerUserLockNamespace(
  () => testPerUserLocksRoot,
);
