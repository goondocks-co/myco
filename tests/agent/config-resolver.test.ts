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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerBuiltInAgentsAndTasks } from '@myco/agent/loader.js';
import { resolveRunConfig } from '@myco/agent/config-resolver.js';
import { cleanTestDb, setupTestDb, teardownTestDb } from '../helpers/db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFINITIONS_DIR = path.resolve(__dirname, '..', '..', 'packages', 'myco', 'src', 'agent', 'definitions');

describe('resolveRunConfig', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('uses user task YAML when a requested task has no DB row', () => {
    registerBuiltInAgentsAndTasks(DEFINITIONS_DIR);

    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-config-resolver-'));
    fs.mkdirSync(path.join(vaultDir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'tasks', 'custom-smoke.yaml'), `name: custom-smoke
displayName: Custom Smoke
description: User task loaded only from the vault task registry.
agent: myco-agent
prompt: Run the custom smoke task.
isDefault: false
maxTurns: 7
timeoutSeconds: 123
phases:
  - name: exact
    prompt: Call the exact tool sequence.
    tools:
      - vault_report
    maxTurns: 3
    required: true
`, 'utf8');

    try {
      const resolved = resolveRunConfig('myco-agent', 'custom-smoke', vaultDir, null);

      expect(resolved.taskName).toBe('custom-smoke');
      expect(resolved.config.taskName).toBe('custom-smoke');
      expect(resolved.config.taskDisplayName).toBe('Custom Smoke');
      expect(resolved.config.taskPrompt).toBe('Run the custom smoke task.');
      expect(resolved.config.maxTurns).toBe(7);
      expect(resolved.config.timeoutSeconds).toBe(123);
      expect(resolved.config.phases?.map((phase) => phase.name)).toEqual(['exact']);
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });
});
