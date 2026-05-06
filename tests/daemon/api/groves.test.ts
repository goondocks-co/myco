import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createListGroveProjectsHandler, createListGrovesHandler } from '@myco/daemon/api/groves.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';

describe('Grove discovery API', () => {
  let testDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-groves-api-'));
    previousHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = path.join(testDir, 'home');
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

    const response = await createListGrovesHandler()({
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

  it('lists projects for one Grove by id', async () => {
    const grove = createGrove('Work');
    registerProjectInGrove(grove.id, {
      projectId: 'proj_a',
      projectName: 'Project A',
      projectRoot: path.join(testDir, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    });

    const response = await createListGroveProjectsHandler()({
      body: undefined,
      query: {},
      params: { id: grove.id },
      pathname: `/api/groves/${grove.id}/projects`,
    });
    const body = response.body as { projects: Array<{ project_id: string }> };

    expect(body.projects.map((project) => project.project_id)).toEqual(['proj_a']);
  });
});
