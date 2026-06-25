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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, 'packages/myco/scripts/lint-skill-content.ts');
const tsxBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);
const tmpRoots: string[] = [];
const repoSkillDirs: string[] = [];

function skill(body: string): string {
  return `---\nname: myco:test\ndescription: Test skill\n---\n\n${body}\n`;
}

function makeSkillDir(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-skill-lint-'));
  tmpRoots.push(root);
  const skillDir = path.join(root, 'test-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill(body));
  return root;
}

function runLint(args: string[]) {
  return spawnSync(tsxBin, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  for (const skillDir of repoSkillDirs.splice(0)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
});

describe('lint-skill-content script', () => {
  it('fails default mode on hard contamination', () => {
    const root = makeSkillDir('Critical discovery (v0.27.17): use the old migration path.');

    const result = runLint([root]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('HARD myco-version-parenthetical');
    expect(result.stdout).toContain('1 hard');
  });

  it('allows warn-only contamination by default and fails it in strict mode', () => {
    const root = makeSkillDir('SQLite does not support DROP COLUMN before version 3.35.0.');

    const defaultResult = runLint([root]);
    expect(defaultResult.status).toBe(0);
    expect(defaultResult.stdout).toContain('0 hard, 1 warnings');

    const strictResult = runLint(['--strict', root]);
    expect(strictResult.status).toBe(1);
    expect(strictResult.stdout).toContain('WARN third-party-version');
    expect(strictResult.stdout).toContain('(strict)');
  });

  it('scans untracked default skill files in the worktree', () => {
    const skillDir = path.join(repoRoot, '.agents', 'skills', `lint-untracked-${process.pid}`);
    repoSkillDirs.push(skillDir);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      skill('Critical discovery (v0.27.17): this untracked file must not be skipped.'),
      'utf8',
    );

    const result = runLint(['--strict']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`.agents/skills/lint-untracked-${process.pid}/SKILL.md`);
    expect(result.stdout).toContain('HARD myco-version-parenthetical');
  });

  it('fails when an explicit target matches no SKILL.md files', () => {
    const result = runLint(['--strict', 'does-not-exist']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Skill content lint: 0 files, 0 hard, 0 warnings (strict).');
    expect(result.stderr).toContain('Skill content lint target did not match any SKILL.md file: does-not-exist');
  });
});
