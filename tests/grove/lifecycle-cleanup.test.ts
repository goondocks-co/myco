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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { createSchema } from '@myco/db/schema.js';
import { openDatabase } from '@myco/db/client.js';
import {
  archiveProject,
  deleteProjectPermanently,
  removeProjectVault,
  unarchiveProject,
} from '@myco/grove/project-lifecycle.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  listRegisteredProjects,
  pauseProject,
  registerProjectInGrove,
  resumeProject,
} from '@myco/grove/registry.js';
import { createProjectId } from '@myco/grove/ids.js';
import {
  resolveGroveDbPath,
  resolveGroveProjectDir,
  resolveProjectBufferDir,
  resolveProjectVaultDir,
} from '@myco/grove/paths.js';
import { listBufferSessionIds } from '@myco/capture/buffer.js';
import { resetMachineIdCache } from '@myco/machine-id.js';

let tmpDir: string;
let mycoHome: string;
let projectRoot: string;
let priorMycoHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-lifecycle-cleanup-'));
  mycoHome = path.join(tmpDir, 'home');
  projectRoot = path.join(tmpDir, 'project');
  priorMycoHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  fs.mkdirSync(projectRoot, { recursive: true });
  resetMachineIdCache();
  clearGroveRegistryCaches();
});

afterEach(() => {
  if (priorMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = priorMycoHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetMachineIdCache();
  clearGroveRegistryCaches();
});

describe('removeProjectVault', () => {
  it('removes the on-disk .myco directory', () => {
    const vault = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, 'myco.yaml'), 'version: 3\n');

    removeProjectVault(projectRoot);

    expect(fs.existsSync(vault)).toBe(false);
  });

  it('removes project-local launchers and runtime pin through the vault capability', () => {
    const vault = resolveProjectVaultDir(projectRoot);
    const agentsDir = path.join(projectRoot, '.agents');
    fs.mkdirSync(vault, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(vault, 'myco.yaml'), 'version: 3\n');
    fs.writeFileSync(path.join(vault, 'runtime.command'), '/tmp/myco-dev\n');
    fs.writeFileSync(path.join(agentsDir, 'myco-run.cjs'), '// launcher\n');
    fs.writeFileSync(path.join(agentsDir, 'myco-cli.cjs'), '// cli\n');
    fs.writeFileSync(path.join(agentsDir, 'myco-hook.cjs'), '// legacy\n');

    removeProjectVault(projectRoot);

    expect(fs.existsSync(vault)).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, 'myco-run.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, 'myco-cli.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, 'myco-hook.cjs'))).toBe(false);
  });

  it('is a no-op when .myco is already absent', () => {
    expect(() => removeProjectVault(projectRoot)).not.toThrow();
  });
});

describe('project lifecycle cleanup', () => {
  it('archive removes the project-local vault without deleting Grove data', () => {
    const { grove, projectId } = registerProjectWithVault();
    const groveDbPath = resolveGroveDbPath(grove.id, mycoHome);
    fs.mkdirSync(path.dirname(groveDbPath), { recursive: true });
    const db = openDatabase(groveDbPath);
    try {
      createSchema(db);
      db.prepare(
        `INSERT INTO sessions (
           id, agent, project_root, branch, started_at, status, created_at,
           embedded, machine_id, project_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'sess_lifecycle_cleanup',
        'codex',
        projectRoot,
        'main',
        100,
        'active',
        100,
        0,
        'test-machine',
        projectId,
      );
    } finally {
      db.close();
    }

    archiveProject(grove.id, projectId, mycoHome);

    expect(fs.existsSync(resolveProjectVaultDir(projectRoot))).toBe(false);
    expect(fs.existsSync(groveDbPath)).toBe(true);
    const verifyDb = openDatabase(groveDbPath);
    try {
      const row = verifyDb.prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?')
        .get(projectId) as { n: number };
      expect(row.n).toBe(1);
    } finally {
      verifyDb.close();
    }
    expect(listRegisteredProjects(grove.id, mycoHome)).toEqual([]);
    expect(listRegisteredProjects(grove.id, mycoHome, { includeArchived: true })[0]?.status)
      .toBe('archived');
  });

  it('archive REFUSES while a move holds the write lease — it would remove the vault mid-move', () => {
    const { grove, projectId } = registerProjectWithVault();
    pauseProject(grove.id, projectId, 'moving to a Team Host', 'residency-attach', null, mycoHome);
    try {
      expect(() => archiveProject(grove.id, projectId, mycoHome)).toThrow(/cannot be archived while a team move/);
      expect(listRegisteredProjects(grove.id, mycoHome).some((p) => p.project_id === projectId)).toBe(true);
    } finally {
      resumeProject(grove.id, projectId, 'residency-attach', mycoHome);
    }
  });

  it('permanent delete REFUSES while a move holds the project write lease (admission inside the operation)', () => {
    const { grove, projectId } = registerProjectWithVault();
    // The delete route's param is `:id`, so the central HTTP write gate never
    // binds this project — the consult must live inside the operation.
    pauseProject(grove.id, projectId, 'moving to a Team Host', 'residency-attach', null, mycoHome);
    try {
      expect(() => deleteProjectPermanently(grove.id, projectId, mycoHome)).toThrow(/cannot be deleted while a team move/);
      // Nothing was destroyed by the refusal.
      expect(listRegisteredProjects(grove.id, mycoHome).some((p) => p.project_id === projectId)).toBe(true);
    } finally {
      resumeProject(grove.id, projectId, 'residency-attach', mycoHome);
    }
    // Lease released → the delete proceeds normally.
    const result = deleteProjectPermanently(grove.id, projectId, mycoHome);
    expect(result.project_id).toBe(projectId);
  });

  it('permanent delete removes the project-local vault after deregistration', () => {
    const { grove, projectId } = registerProjectWithVault();

    const result = deleteProjectPermanently(grove.id, projectId, mycoHome);

    expect(result.project_id).toBe(projectId);
    expect(fs.existsSync(resolveProjectVaultDir(projectRoot))).toBe(false);
    expect(listRegisteredProjects(grove.id, mycoHome, { includeArchived: true })).toEqual([]);
  });

  it('permanent delete removes the Grove-side project dir (buffer included) — a same-id re-register has zero resurrection candidates', () => {
    const { grove, projectId } = registerProjectWithVault();
    const groveProjectDir = resolveGroveProjectDir(grove.id, projectId, mycoHome);
    const bufferDir = resolveProjectBufferDir(grove.id, projectId, mycoHome);
    fs.mkdirSync(bufferDir, { recursive: true });
    fs.writeFileSync(
      path.join(bufferDir, 'sess-leftover.jsonl'),
      '{"type":"user_prompt","prompt":"stale","timestamp":"2026-06-01T00:00:00Z"}\n',
    );

    deleteProjectPermanently(grove.id, projectId, mycoHome);

    // The whole Grove-side project dir is gone with the rows + tombstones;
    // the pre-delete snapshot remains the recovery path.
    expect(fs.existsSync(groveProjectDir)).toBe(false);

    // Re-registering the SAME project id presents no buffer files for the
    // reconciler to treat as resurrection candidates.
    fs.mkdirSync(projectRoot, { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'project',
      projectRoot,
    }, mycoHome);
    expect(listBufferSessionIds(resolveProjectBufferDir(grove.id, projectId, mycoHome))).toEqual([]);
  });

  it('unarchive re-provisions a fresh capture-only vault', () => {
    const { grove, projectId } = registerProjectWithVault({
      localConfig: { cortex: { enabled: true } },
    });

    archiveProject(grove.id, projectId, mycoHome);
    expect(fs.existsSync(resolveProjectVaultDir(projectRoot))).toBe(false);

    unarchiveProject(grove.id, projectId, mycoHome);

    const localRaw = YAML.parse(
      fs.readFileSync(path.join(resolveProjectVaultDir(projectRoot), 'local.yaml'), 'utf-8'),
    ) as Record<string, any>;
    expect(localRaw.cortex?.enabled).toBe(false);
    expect(localRaw.cortex?.canopy?.enabled).toBe(false);
    expect(localRaw.skills?.enabled).toBe(false);
    expect(localRaw.vault_evolution?.enabled).toBe(false);
  });
});

function registerProjectWithVault(options: { localConfig?: Record<string, unknown> } = {}) {
  const grove = createGrove('Work', mycoHome);
  const projectId = createProjectId();
  registerProjectInGrove(grove.id, {
    projectId,
    projectName: 'project',
    projectRoot,
    bindingId: 'gbind_lifecycle_cleanup',
  }, mycoHome);
  const vault = resolveProjectVaultDir(projectRoot);
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'myco.yaml'), 'version: 3\n');
  if (options.localConfig) {
    fs.writeFileSync(path.join(vault, 'local.yaml'), YAML.stringify(options.localConfig), 'utf-8');
  }
  return { grove, projectId };
}
