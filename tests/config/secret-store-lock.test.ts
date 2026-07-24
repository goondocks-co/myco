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
  secretStoreIdentity,
  secretStoreLockKeys,
} from '@myco/config/secret-store-lock.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-secret-store-lock-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('secret store lock identity', () => {
  test.skipIf(process.platform === 'win32')(
    'maps filesystem aliases of one store to the same identity and lock keys',
    () => {
      const store = path.join(root, 'store');
      const alias = path.join(root, 'store-alias');
      fs.mkdirSync(store);
      fs.symlinkSync(store, alias, 'dir');

      expect(secretStoreIdentity(alias)).toBe(secretStoreIdentity(store));
      expect(secretStoreLockKeys(alias)).toEqual(secretStoreLockKeys(store));
    },
  );

  test('keeps distinct stores in distinct lock domains', () => {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);

    expect(secretStoreIdentity(first)).not.toBe(secretStoreIdentity(second));
    expect(secretStoreLockKeys(first)).not.toEqual(secretStoreLockKeys(second));
  });

  test('keeps lock keys stable when the secrets file is replaced', () => {
    const store = path.join(root, 'store');
    const secrets = path.join(store, 'secrets.env');
    fs.mkdirSync(store);
    fs.writeFileSync(secrets, 'TOKEN=first\n');
    const before = secretStoreLockKeys(store);

    fs.renameSync(secrets, `${secrets}.old`);
    fs.writeFileSync(secrets, 'TOKEN=second\n');

    expect(secretStoreLockKeys(store)).toEqual(before);
  });
});
