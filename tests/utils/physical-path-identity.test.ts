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
  physicalPathIdentity,
  physicalPathLockIdentities,
} from '@myco/utils/physical-path-identity.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-physical-path-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('physical path identity', () => {
  test('uses inode identity for an existing path', () => {
    const target = path.join(root, 'existing');
    fs.mkdirSync(target);

    expect(physicalPathIdentity(target)).toMatch(/^inode:/);
    expect(physicalPathLockIdentities(target)).toEqual(
      expect.arrayContaining([
        `path:${fs.realpathSync(target)}`,
        physicalPathIdentity(target),
      ]),
    );
  });

  test('anchors a missing suffix to its nearest existing ancestor', () => {
    const missing = path.join(root, 'missing', 'child');
    const canonicalMissing = path.join(fs.realpathSync(root), 'missing', 'child');

    expect(physicalPathIdentity(missing)).toMatch(/^ancestor:.*:missing:/);
    expect(physicalPathLockIdentities(missing)).toEqual(
      expect.arrayContaining([
        `path:${canonicalMissing}`,
        `casefold:${canonicalMissing.toLowerCase()}`,
      ]),
    );

    fs.mkdirSync(missing, { recursive: true });
    expect(physicalPathIdentity(missing)).toMatch(/^inode:/);
  });

  test.skipIf(process.platform === 'win32')(
    'maps a directory symlink to the same physical identity',
    () => {
      const target = path.join(root, 'target');
      const alias = path.join(root, 'alias');
      fs.mkdirSync(target);
      fs.symlinkSync(target, alias, 'dir');

      expect(physicalPathIdentity(alias)).toBe(physicalPathIdentity(target));
      expect(physicalPathLockIdentities(alias)).toEqual(physicalPathLockIdentities(target));
    },
  );
});
