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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_SRC_ROOT = path.join(REPO_ROOT, 'packages', 'myco', 'src', 'db');

const BANNED_IDENTITY_IMPORTS = [
  '@myco/daemon/team-context',
  '@myco/daemon/machine-id',
  '../daemon/team-context',
  '../daemon/machine-id',
] as const;

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('DB team identity boundary', () => {
  it('keeps DB code off daemon-owned Team Sync identity modules', () => {
    const offenders: string[] = [];

    for (const file of listTsFiles(DB_SRC_ROOT)) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const banned of BANNED_IDENTITY_IMPORTS) {
        if (source.includes(banned)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} imports ${banned}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
