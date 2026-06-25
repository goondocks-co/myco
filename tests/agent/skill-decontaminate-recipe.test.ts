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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { resolveDefinitionsDir, loadAgentTasks } from '@myco/agent/loader.js';
import { loadAllTasks } from '@myco/agent/registry.js';
import { AgentTaskSchema } from '@myco/agent/schemas.js';
import { validatePhaseGatesAgainstWaves } from '@myco/agent/wave-computation.js';

const repoRoot = process.cwd();
const recipePath = path.join(repoRoot, 'docs/examples/skill-decontaminate.yaml');
const tmpRoots: string[] = [];

function readRecipe(): string {
  return fs.readFileSync(recipePath, 'utf8');
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('skill decontaminate custom task recipe', () => {
  it('is a valid user-task YAML recipe and not a built-in task', () => {
    const raw = readRecipe();
    const task = AgentTaskSchema.parse(parseYaml(raw));

    expect(task.name).toBe('skill-decontaminate');
    expect(task.isDefault).toBe(false);
    expect(task.schedule?.enabled).toBe(false);
    expect(task.phases).toHaveLength(1);
    validatePhaseGatesAgainstWaves(task.phases ?? []);

    const phase = task.phases![0];
    expect(phase.tools).toEqual([
      'vault_skill_records',
      'vault_scan_skill_contamination',
      'vault_write_skill',
      'vault_report',
    ]);
    expect(phase.prompt).toContain('strict: true');
    expect(phase.prompt).toContain('Process every active skill');
    expect(phase.prompt).not.toContain('at most 3');

    const builtIns = loadAgentTasks(resolveDefinitionsDir()).map(candidate => candidate.name);
    expect(builtIns).not.toContain('skill-decontaminate');
  });

  it('loads from vault tasks as a user task', () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-skill-decontaminate-'));
    tmpRoots.push(vaultDir);
    const tasksDir = path.join(vaultDir, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'skill-decontaminate.yaml'), readRecipe(), 'utf8');

    const tasks = loadAllTasks(resolveDefinitionsDir(), vaultDir);
    const task = tasks.get('skill-decontaminate');

    expect(task?.source).toBe('user');
    expect(task?.isBuiltin).toBe(false);
    expect(task?.phases?.[0]?.tools).toContain('vault_scan_skill_contamination');
  });
});
