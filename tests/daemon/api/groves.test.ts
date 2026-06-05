import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invalidateMergedConfigCache } from '@myco/config/loader.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createListGroveProjectsHandler, createListGrovesHandler, servedGroveScopeForDaemon } from '@myco/daemon/api/groves.js';
import type { GroveProjectSummary } from '@myco/daemon/api/groves.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';

describe('Grove discovery API', () => {
  let testDir: string;
  let mycoHome: string;
  let serviceDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-groves-api-'));
    mycoHome = path.join(testDir, 'home');
    previousHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    serviceDir = path.join(mycoHome, 'service');
    fs.mkdirSync(serviceDir, { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousHome;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('lists Groves with registered projects and URL slugs', async () => {
    const grove = createGrove('Client Work');
    const projectRoot = path.join(testDir, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const vaultDir = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(vaultDir, { recursive: true });
    saveProjectManifest(vaultDir, {
      project: { id: 'proj_a', name: 'Project A' },
      grove: { binding_id: 'gbind_a', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, {
      projectId: 'proj_a',
      projectName: 'Project A',
      projectRoot,
      bindingId: 'gbind_a',
    });

    const response = await createListGrovesHandler({ groveIds: null }, serviceDir)({
      body: undefined,
      query: {},
      params: {},
      pathname: '/api/groves',
    });
    const body = response.body as { groves: Array<{ slug: string; project_count: number; projects: Array<{ project_id: string; slug: string; manifest_state: string }> }> };

    expect(body.groves).toHaveLength(1);
    expect(body.groves[0].slug).toBe('client-work');
    expect(body.groves[0].project_count).toBe(1);
    expect(body.groves[0].projects[0].project_id).toBe('proj_a');
    expect(body.groves[0].projects[0].slug).toMatch(/^project-a-[0-9a-f]{6}$/);
    expect(body.groves[0].projects[0].manifest_state).toBe('present');
  });

  it('filters to served Groves when scope.groveIds is non-null (project-local daemon mode)', async () => {
    const dogfood = createGrove('Myco Dogfood');
    const otherGrove = createGrove('Default Projects');
    registerProjectInGrove(dogfood.id, {
      projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      projectName: 'myco',
      projectRoot: path.join(testDir, 'myco'),
    });
    registerProjectInGrove(otherGrove.id, {
      projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      projectName: 'ten-second-tom',
      projectRoot: path.join(testDir, 'ten-second-tom'),
    });

    const response = await createListGrovesHandler({ groveIds: [dogfood.id] }, serviceDir)({
      body: undefined,
      query: {},
      params: {},
      pathname: '/api/groves',
    });
    const body = response.body as { groves: Array<{ id: string; name: string }> };

    expect(body.groves).toHaveLength(1);
    expect(body.groves[0].id).toBe(dogfood.id);
    expect(body.groves[0].name).toBe('Myco Dogfood');
  });

  it('serves the full registry for the global daemon', async () => {
    createGrove('Myco Dogfood');
    createGrove('Default Projects');

    const scope = servedGroveScopeForDaemon();
    const result = await listNames(scope, serviceDir);

    expect(scope.groveIds).toBeNull();
    expect(result).toHaveLength(2);
    expect(result).toContain('Myco Dogfood');
    expect(result).toContain('Default Projects');
  });

  it('lists projects for one Grove by id', async () => {
    const grove = createGrove('Work');
    registerProjectInGrove(grove.id, {
      projectId: 'proj_a',
      projectName: 'Project A',
      projectRoot: path.join(testDir, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    });

    const response = await createListGroveProjectsHandler({ groveIds: null }, serviceDir)({
      body: undefined,
      query: {},
      params: { id: grove.id },
      pathname: `/api/groves/${grove.id}/projects`,
    });
    const body = response.body as { projects: Array<{ project_id: string }> };

    expect(body.projects.map((project) => project.project_id)).toEqual(['proj_a']);
  });

  it('returns capability gates per project; cortex=false when local.yaml disables it', async () => {
    const grove = createGrove('Capability Test Grove');
    const projectRoot = path.join(testDir, 'captest');
    const vaultDir = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(vaultDir, { recursive: true });

    // Minimal myco.yaml required by loadMergedConfig.
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n', 'utf-8');
    // local.yaml disables the cortex master gate.
    fs.writeFileSync(path.join(vaultDir, 'local.yaml'), 'cortex:\n  enabled: false\n', 'utf-8');
    invalidateMergedConfigCache(vaultDir);

    saveProjectManifest(vaultDir, {
      project: { id: 'proj_cap', name: 'Cap Test' },
      grove: { binding_id: 'gbind_cap', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, {
      projectId: 'proj_cap',
      projectName: 'Cap Test',
      projectRoot,
      bindingId: 'gbind_cap',
    });

    const response = await createListGrovesHandler({ groveIds: null }, serviceDir)({
      body: undefined,
      query: {},
      params: {},
      pathname: '/api/groves',
    });
    const body = response.body as { groves: Array<{ projects: GroveProjectSummary[] }> };
    const project = body.groves.flatMap((g) => g.projects).find((p) => p.project_id === 'proj_cap');

    expect(project).toBeDefined();
    expect(project!.capabilities.cortex).toBe(false);
    expect(project!.capabilities.canopy).toBe(true);
    expect(project!.capabilities.skills).toBe(true);
    expect(project!.capabilities.vault_evolution).toBe(true);
  });
});

async function listNames(
  scope: ReturnType<typeof servedGroveScopeForDaemon>,
  daemonStateDir: string,
): Promise<string[]> {
  const result = await createListGrovesHandler(scope, daemonStateDir)({
    body: undefined,
    query: {},
    params: {},
    pathname: '/api/groves',
  });
  const body = result.body as { groves: Array<{ name: string }> };
  return body.groves.map((grove) => grove.name);
}
