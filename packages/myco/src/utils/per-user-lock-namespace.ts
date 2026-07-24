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
import path from 'node:path';

import { resolvePerUserLocksDir } from '@myco/utils/user-lock-root.js';

export type PerUserLockNamespaceName =
  | 'secrets'
  | 'host-membership'
  | 'host-operations'
  | 'legacy-team-home'
  | 'external-mcp-activation';

const perUserLockNamespaceBrand: unique symbol = Symbol('PerUserLockNamespace');

export interface PerUserLockNamespace {
  readonly [perUserLockNamespaceBrand]: true;
  resolve(name: PerUserLockNamespaceName): string;
}

export type PerUserLockRootProvider = () => string;

export function createPerUserLockNamespace(
  resolveRoot: PerUserLockRootProvider,
): PerUserLockNamespace {
  let resolvedRoot: string | undefined;
  return Object.freeze({
    [perUserLockNamespaceBrand]: true as const,
    resolve(name: PerUserLockNamespaceName): string {
      const root = resolveRoot();
      const rawName: string = name;
      if (!path.isAbsolute(root) || root.includes('\0')) {
        throw new Error('Per-user lock namespace root must be an absolute path');
      }
      if (resolvedRoot !== undefined && resolvedRoot !== root) {
        throw new Error('Per-user lock namespace root changed after initialization');
      }
      if (!rawName
        || rawName === '.'
        || rawName === '..'
        || rawName.includes('\0')
        || rawName.includes('/')
        || rawName.includes('\\')
        || path.isAbsolute(rawName)) {
        throw new Error(`Invalid per-user lock namespace: ${rawName}`);
      }
      resolvedRoot ??= root;
      return path.join(root, rawName);
    },
  });
}

export const nativePerUserLockNamespace = createPerUserLockNamespace(
  resolvePerUserLocksDir,
);
