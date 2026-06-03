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

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeSkillNameForFs } from '@myco/skills/names.js';
import {
  publishedSkillRelativePath,
  removePublishedSkillFileOrDirectory,
  writePublishedSkillFile,
} from '@myco/skills/publication.js';

const roots: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'myco-skill-publication-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('skills publication helpers', () => {
  it('uses the canonical filesystem-safe skill-name predicate', () => {
    expect(isSafeSkillNameForFs('my-skill')).toBe(true);
    expect(isSafeSkillNameForFs('UPPER')).toBe(false);
    expect(isSafeSkillNameForFs('../etc')).toBe(false);
    expect(isSafeSkillNameForFs('a'.repeat(101))).toBe(false);
  });

  it('writes and removes a published skill artifact under .agents/skills', () => {
    const root = tempProject();
    const writeResult = writePublishedSkillFile(root, 'published-skill', '# Published');

    expect(writeResult.ok).toBe(true);
    if (!writeResult.ok) throw new Error('expected write to succeed');
    expect(writeResult.paths.relativePath).toBe(publishedSkillRelativePath('published-skill'));
    expect(existsSync(writeResult.paths.skillPath)).toBe(true);

    const removeResult = removePublishedSkillFileOrDirectory(root, 'published-skill');
    expect(removeResult.ok).toBe(true);
    expect(existsSync(writeResult.paths.skillDir)).toBe(false);
  });

  it('refuses path escapes before recursive removal', () => {
    const root = tempProject();
    const sentinel = join(root, '.agents', 'sentinel');
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(sentinel, 'keep', 'utf-8');

    const result = removePublishedSkillFileOrDirectory(root, '..');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected path escape refusal');
    expect(result.reason).toBe('path_escape');
    expect(existsSync(sentinel)).toBe(true);
  });
});
