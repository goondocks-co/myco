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
import YAML from 'yaml';

import {
  loadConfig,
  saveConfig,
  updateConfig,
} from '../../packages/myco/src/config/loader';
import { MycoConfigSchema } from '../../packages/myco/src/config/schema';

let rootDir: string | null = null;

afterEach(() => {
  if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  rootDir = null;
});

function makeVault(): string {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-save-sparse-'));
  const vaultDir = path.join(rootDir, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n');
  return vaultDir;
}

function readProjectYaml(vaultDir: string): Record<string, unknown> {
  return YAML.parse(fs.readFileSync(path.join(vaultDir, 'myco.yaml'), 'utf-8')) as Record<string, unknown>;
}

describe('saveConfig sparsity', () => {
  it('does not materialize default project sections, and still reloads', () => {
    const vaultDir = makeVault();

    updateConfig(vaultDir, (config) => ({
      ...config,
      release_provenance: {
        ...config.release_provenance,
        integration_refs: ['main'],
      },
    }));

    const raw = readProjectYaml(vaultDir);
    expect(raw.version).toBe(3);
    expect(raw.cortex).toBeUndefined();
    expect(raw.symbionts).toBeUndefined();
    expect((raw.release_provenance as Record<string, unknown>).integration_refs).toEqual(['main']);

    const reloaded = loadConfig(vaultDir);
    expect(reloaded.version).toBe(3);
    expect(reloaded.release_provenance.integration_refs).toEqual(['main']);
  });

  it('preserves config_version when present', () => {
    const vaultDir = makeVault();
    const config = MycoConfigSchema.parse({
      version: 3,
      config_version: 7,
      release_provenance: { integration_refs: ['release'] },
    });

    saveConfig(vaultDir, config);

    const raw = readProjectYaml(vaultDir);
    expect(raw.version).toBe(3);
    expect(raw.config_version).toBe(7);
  });
});
