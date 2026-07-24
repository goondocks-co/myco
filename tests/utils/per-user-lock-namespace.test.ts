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
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
  createPerUserLockNamespace,
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';
import { resolvePerUserLocksDir } from '@myco/utils/user-lock-root.js';
import {
  TEST_PER_USER_LOCKS_ROOT_ENV,
  testPerUserLockNamespace,
  testPerUserLocksRoot,
} from '../helpers/per-user-lock-namespace.js';

type StructurallyForgedNamespace = Pick<PerUserLockNamespace, 'resolve'>;
// @ts-expect-error The private brand admits only factory-created namespaces.
const structurallyForgedNamespace: PerUserLockNamespace = {} as StructurallyForgedNamespace;
void structurallyForgedNamespace;

describe('per-user lock namespace', () => {
  test('resolves legacy namespace directories beneath an explicitly injected root', () => {
    const root = path.resolve('/tmp/myco-explicit-lock-root');
    const namespace = createPerUserLockNamespace(() => root);

    expect(namespace.resolve('secrets')).toBe(path.join(root, 'secrets'));
    expect(namespace.resolve('host-membership')).toBe(path.join(root, 'host-membership'));
    expect(namespace.resolve('host-operations')).toBe(path.join(root, 'host-operations'));
    expect(namespace.resolve('legacy-team-home')).toBe(path.join(root, 'legacy-team-home'));
    expect(namespace.resolve('external-mcp-activation'))
      .toBe(path.join(root, 'external-mcp-activation'));
  });

  test('rejects paths that could escape the injected root', () => {
    const namespace = createPerUserLockNamespace(() => path.resolve('/tmp/myco-lock-root'));

    for (const invalid of ['', '.', '..', '../escape', 'nested/escape', '/absolute']) {
      expect(() => namespace.resolve(invalid as never)).toThrow();
    }
  });

  test('pins the first verified root and rejects provider drift', () => {
    let root = path.resolve('/tmp/myco-lock-root-a');
    const namespace = createPerUserLockNamespace(() => root);

    expect(namespace.resolve('secrets')).toBe(path.join(root, 'secrets'));
    root = path.resolve('/tmp/myco-lock-root-b');
    expect(() => namespace.resolve('secrets'))
      .toThrow('Per-user lock namespace root changed after initialization');
    expect(Object.isFrozen(namespace)).toBe(true);
  });

  test('revalidates its provider on every resolution', () => {
    const root = path.resolve('/tmp/myco-lock-root');
    let calls = 0;
    const namespace = createPerUserLockNamespace(() => {
      calls += 1;
      if (calls === 2) throw new Error('root failed ownership revalidation');
      return root;
    });

    expect(namespace.resolve('secrets')).toBe(path.join(root, 'secrets'));
    expect(() => namespace.resolve('secrets'))
      .toThrow('root failed ownership revalidation');
    expect(calls).toBe(2);
  });

  test('the production namespace resolves only through the native verified provider', () => {
    const previous = process.env.MYCO_LOCK_ROOT;
    process.env.MYCO_LOCK_ROOT = path.resolve('/tmp/untrusted-lock-root');
    try {
      expect(nativePerUserLockNamespace.resolve('secrets'))
        .toBe(path.join(resolvePerUserLocksDir(), 'secrets'));
    } finally {
      if (previous === undefined) delete process.env.MYCO_LOCK_ROOT;
      else process.env.MYCO_LOCK_ROOT = previous;
    }
  });

  test('all tests in one runner process use the runner-owned explicit root', () => {
    expect(path.isAbsolute(testPerUserLocksRoot)).toBe(true);
    expect(process.env[TEST_PER_USER_LOCKS_ROOT_ENV]).toBe(testPerUserLocksRoot);
    expect(testPerUserLockNamespace.resolve('secrets'))
      .toBe(path.join(testPerUserLocksRoot, 'secrets'));
  });
});
