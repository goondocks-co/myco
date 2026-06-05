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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { resolveProvisionedVaultDir } from '@myco/hooks/vault-gate.js';
import {
  archiveProjectInGrove,
  clearGroveRegistryCaches,
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { createProjectId } from '@myco/grove/ids.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';

let tmpDir: string;
let mycoHome: string;
let projectRoot: string;
let priorMycoHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-vault-gate-readmit-'));
  mycoHome = path.join(tmpDir, 'home');
  projectRoot = path.join(tmpDir, 'project');
  priorMycoHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  fs.mkdirSync(projectRoot, { recursive: true });
  execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
  seedLeftoverVault({ cortex: { enabled: true } });
  clearGroveRegistryCaches();
});

afterEach(() => {
  if (priorMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = priorMycoHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  clearGroveRegistryCaches();
});

describe('resolveProvisionedVaultDir re-admission gate', () => {
  it('returns null on the hot path when the root is ignored', () => {
    fs.mkdirSync(mycoHome, { recursive: true });
    fs.writeFileSync(
      path.join(mycoHome, 'config.yaml'),
      YAML.stringify({ capture: { ignore: { paths: [projectRoot] } } }),
      'utf-8',
    );

    expect(resolveProvisionedVaultDir(projectRoot)).toBeNull();
  });

  it('returns null on the hot path when the root is archived', () => {
    const grove = createGrove('Work', mycoHome);
    const projectId = createProjectId();
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'project',
      projectRoot,
    }, mycoHome);
    archiveProjectInGrove(grove.id, projectId, mycoHome);

    expect(resolveProvisionedVaultDir(projectRoot)).toBeNull();
  });

  it('re-seeds capture-only for an unregistered root with a leftover vault', () => {
    const vaultDir = resolveProvisionedVaultDir(projectRoot);

    expect(vaultDir).toBe(resolveProjectVaultDir(projectRoot));
    const localRaw = YAML.parse(
      fs.readFileSync(path.join(resolveProjectVaultDir(projectRoot), 'local.yaml'), 'utf-8'),
    ) as Record<string, any>;
    expect(localRaw.cortex?.enabled).toBe(false);
    expect(localRaw.cortex?.canopy?.enabled).toBe(false);
    expect(localRaw.skills?.enabled).toBe(false);
    expect(localRaw.vault_evolution?.enabled).toBe(false);
  });
});

function seedLeftoverVault(localConfig: Record<string, unknown>): void {
  const vault = resolveProjectVaultDir(projectRoot);
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'myco.yaml'), 'version: 3\n');
  fs.writeFileSync(path.join(vault, 'local.yaml'), YAML.stringify(localConfig), 'utf-8');
}
