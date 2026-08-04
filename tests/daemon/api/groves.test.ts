import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { writeHostRecordFixture } from '../../helpers/host-registry-fixture.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invalidateMergedConfigCache } from '@myco/config/loader.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import {
  createListGroveProjectsHandler as createListGroveProjectsHandlerWith,
  createListGrovesHandler as createListGrovesHandlerWith,
  servedGroveScopeForDaemon,
} from '@myco/daemon/api/groves.js';
import type {
  GrovesLogger,
  GroveProjectSummary,
  ServedGroveScope,
} from '@myco/daemon/api/groves.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import { createGrove, deleteGrove, registerProjectInGrove, setDefaultGrove } from '@myco/grove/registry.js';
import { createGroveId, createProjectId, createTeamId, projectUrlSlug } from '@myco/grove/ids.js';
import { type HostRecord } from '@myco/host/registry.js';
import { teamRegistry } from '@myco/team/registry.js';
import { testPerUserLockNamespace } from '../../helpers/per-user-lock-namespace.js';

const createListGrovesHandler = (
  scope: ServedGroveScope,
  daemonStateDir: string,
  logger?: GrovesLogger,
) => createListGrovesHandlerWith(
  scope,
  daemonStateDir,
  logger,
  testPerUserLockNamespace,
);

const createListGroveProjectsHandler = (
  scope: ServedGroveScope,
  daemonStateDir: string,
  logger?: GrovesLogger,
) => createListGroveProjectsHandlerWith(
  scope,
  daemonStateDir,
  logger,
  testPerUserLockNamespace,
);

describe('Grove discovery API', () => {
  let testDir: string;
  let mycoHome: string;
  let serviceDir: string;
  let previousHome: string | undefined;
  let previousTeamHome: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-groves-api-'));
    mycoHome = path.join(testDir, 'home');
    previousHome = process.env.MYCO_HOME;
    previousTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_TEAM_HOME = path.join(mycoHome, 'team-home');
    serviceDir = path.join(mycoHome, 'service');
    fs.mkdirSync(serviceDir, { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousHome;
    if (previousTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = previousTeamHome;
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

  it('omits tenancy metadata by default (legacy shape unchanged)', async () => {
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
    const body = response.body as { projects: Array<Record<string, unknown>> };

    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).not.toHaveProperty('grove');
    expect(body.projects[0]).not.toHaveProperty('team');
  });

  it('includes resolved grove + team membership when include=grove,team', async () => {
    const grove = createGrove('Work');
    registerProjectInGrove(grove.id, {
      projectId: 'proj_a',
      projectName: 'Project A',
      projectRoot: path.join(testDir, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    });
    const teamId = createTeamId();
    teamRegistry.save({
      team_id: teamId,
      name: 'Goondocks OSS',
      worker_url: 'https://team.example.workers.dev',
      domain: null,
      mcp_endpoint: null,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: grove.id, project_id: 'proj_a' }],
    });

    const response = await createListGroveProjectsHandler({ groveIds: null }, serviceDir)({
      body: undefined,
      query: { include: 'grove,team' },
      params: { id: grove.id },
      pathname: `/api/groves/${grove.id}/projects`,
    });
    const body = response.body as {
      projects: Array<{
        project_id: string;
        grove: { id: string; name: string; slug: string };
        team: { team_id: string } | null;
      }>;
    };

    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].grove).toEqual({
      id: grove.id,
      name: grove.name,
      slug: grove.slug,
    });
    expect(body.projects[0].team).toEqual({ team_id: teamId });
  });

  it('returns team=null for a project that is in no team', async () => {
    const grove = createGrove('Work');
    registerProjectInGrove(grove.id, {
      projectId: 'proj_a',
      projectName: 'Project A',
      projectRoot: path.join(testDir, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    });

    const response = await createListGroveProjectsHandler({ groveIds: null }, serviceDir)({
      body: undefined,
      query: { include: 'grove,team' },
      params: { id: grove.id },
      pathname: `/api/groves/${grove.id}/projects`,
    });
    const body = response.body as {
      projects: Array<{ grove: { id: string }; team: { team_id: string } | null }>;
    };

    expect(body.projects[0].grove.id).toBe(grove.id);
    expect(body.projects[0].team).toBeNull();
  });

  it('honors include=grove alone (team key omitted) and include=team alone (grove key omitted)', async () => {
    const grove = createGrove('Work');
    registerProjectInGrove(grove.id, {
      projectId: 'proj_a',
      projectName: 'Project A',
      projectRoot: path.join(testDir, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    });

    const groveOnly = await createListGroveProjectsHandler({ groveIds: null }, serviceDir)({
      body: undefined,
      query: { include: 'grove' },
      params: { id: grove.id },
      pathname: `/api/groves/${grove.id}/projects`,
    });
    const groveBody = groveOnly.body as { projects: Array<Record<string, unknown>> };
    expect(groveBody.projects[0]).toHaveProperty('grove');
    expect(groveBody.projects[0]).not.toHaveProperty('team');

    const teamOnly = await createListGroveProjectsHandler({ groveIds: null }, serviceDir)({
      body: undefined,
      query: { include: 'team' },
      params: { id: grove.id },
      pathname: `/api/groves/${grove.id}/projects`,
    });
    const teamBody = teamOnly.body as { projects: Array<Record<string, unknown>> };
    expect(teamBody.projects[0]).toHaveProperty('team');
    expect(teamBody.projects[0]).not.toHaveProperty('grove');
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

describe('Grove discovery API — attached-project merge (E-4 local-view)', () => {
  let testDir: string;
  let mycoHome: string;
  let serviceDir: string;
  let previousHome: string | undefined;
  let previousTeamHome: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-groves-attach-'));
    mycoHome = path.join(testDir, 'home');
    previousHome = process.env.MYCO_HOME;
    previousTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_TEAM_HOME = path.join(mycoHome, 'team-home');
    serviceDir = path.join(mycoHome, 'service');
    fs.mkdirSync(serviceDir, { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousHome;
    if (previousTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = previousTeamHome;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** Write a member-local checkout whose manifest names the project, so the
   *  merge's manifest-name resolution picks it up. Returns the checkout root. */
  function writeAttachedCheckout(projectId: string, name: string): string {
    const root = path.join(testDir, `checkout-${projectId}`);
    const vaultDir = resolveProjectVaultDir(root);
    fs.mkdirSync(vaultDir, { recursive: true });
    saveProjectManifest(vaultDir, { project: { id: projectId, name } });
    return root;
  }

  function seedHost(projects: HostRecord['projects'], label = 'Mac Studio'): HostRecord {
    const record: HostRecord = {
      host_id: createGroveId().replace('grove_', 'host_'),
      label,
      host_url: 'https://host-b.tailnet.ts.net:8443',
      protocol_version: 1,
      created_at: new Date().toISOString(),
      projects,
    };
    writeHostRecordFixture(record);
    return record;
  }

  async function summaries(): Promise<{ groves: Array<{ id: string; slug: string; project_count: number; projects: GroveProjectSummary[] }> }> {
    const response = await createListGrovesHandler({ groveIds: null }, serviceDir)({
      body: undefined,
      query: {},
      params: {},
      pathname: '/api/groves',
    });
    return response.body as { groves: Array<{ id: string; slug: string; project_count: number; projects: GroveProjectSummary[] }> };
  }

  it('appends an attached project under its recorded local_grove_id, flagged with host + no capabilities', async () => {
    const displayGrove = createGrove('Team Projects');
    createGrove('Elsewhere'); // a second grove the attach must NOT land in
    const attachedId = createProjectId();
    const root = writeAttachedCheckout(attachedId, 'Shared Service');
    const host = seedHost([
      { grove_id: createGroveId(), project_id: attachedId, root, local_grove_id: displayGrove.id },
    ]);

    const body = await summaries();
    const section = body.groves.find((g) => g.id === displayGrove.id)!;
    const elsewhere = body.groves.find((g) => g.slug === 'elsewhere')!;

    expect(section.project_count).toBe(1);
    expect(elsewhere.project_count).toBe(0);
    const entry = section.projects[0];
    expect(entry.project_id).toBe(attachedId);
    expect(entry.name).toBe('Shared Service');
    expect(entry.slug).toBe(projectUrlSlug('Shared Service', attachedId));
    expect(entry.root).toBe(root);
    expect(entry.attached).toBe(true);
    expect(entry.host_id).toBe(host.host_id);
    expect(entry.host_label).toBe('Mac Studio');
    expect(entry.capabilities).toBeUndefined();
    expect(entry.manifest_state).toBe('present');
  });

  it('falls back to the machine default Grove when local_grove_id dangles (chosen Grove deleted)', async () => {
    const keep = createGrove('Keep'); // becomes default (first grove)
    const doomed = createGrove('Doomed');
    setDefaultGrove(keep.id);
    deleteGrove(doomed.id);

    const attachedId = createProjectId();
    const root = writeAttachedCheckout(attachedId, 'Orphaned Home');
    seedHost([
      { grove_id: createGroveId(), project_id: attachedId, root, local_grove_id: doomed.id },
    ]);

    const body = await summaries();
    const keepSection = body.groves.find((g) => g.id === keep.id)!;
    expect(keepSection.projects.map((p) => p.project_id)).toContain(attachedId);
  });

  it('skips an attached project when the machine has no Groves at all (null home)', async () => {
    const attachedId = createProjectId();
    const root = writeAttachedCheckout(attachedId, 'Nowhere');
    seedHost([{ grove_id: createGroveId(), project_id: attachedId, root, local_grove_id: createGroveId() }]);

    const body = await summaries();
    expect(body.groves).toEqual([]); // no sections, no crash
  });

  it('derives a deterministic name from the project id when the ref carries no root', async () => {
    const grove = createGrove('Team Projects');
    const attachedId = createProjectId();
    seedHost([{ grove_id: createGroveId(), project_id: attachedId, local_grove_id: grove.id }]);

    const body = await summaries();
    const entry = body.groves.find((g) => g.id === grove.id)!.projects[0];
    expect(entry.root).toBeNull();
    expect(entry.name).toBe(`Project ${attachedId.replace(/^proj_/, '').slice(0, 8)}`);
    expect(entry.slug).toBe(projectUrlSlug(entry.name, attachedId));
  });

  it('gives two same-named attached projects distinct, stable slugs', async () => {
    const grove = createGrove('Team Projects');
    const a = createProjectId();
    const b = createProjectId();
    seedHost([
      { grove_id: createGroveId(), project_id: a, root: writeAttachedCheckout(a, 'Docs'), local_grove_id: grove.id },
      { grove_id: createGroveId(), project_id: b, root: writeAttachedCheckout(b, 'Docs'), local_grove_id: grove.id },
    ]);

    const entries = (await summaries()).groves.find((g) => g.id === grove.id)!.projects;
    const slugs = entries.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(2);
    expect(slugs).toContain(projectUrlSlug('Docs', a));
    expect(slugs).toContain(projectUrlSlug('Docs', b));
  });

  it('prefers the local row and skips the attached copy on a project_id collision (never-materialize defense)', async () => {
    const grove = createGrove('Team Projects');
    const collisionId = createProjectId();
    const localRoot = path.join(testDir, 'local-checkout');
    registerProjectInGrove(grove.id, {
      projectId: collisionId,
      projectName: 'Local Wins',
      projectRoot: localRoot,
    });
    seedHost([
      { grove_id: createGroveId(), project_id: collisionId, root: writeAttachedCheckout(collisionId, 'Attached Loses'), local_grove_id: grove.id },
    ]);

    const section = (await summaries()).groves.find((g) => g.id === grove.id)!;
    const rows = section.projects.filter((p) => p.project_id === collisionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Local Wins');
    expect(rows[0].attached).toBeUndefined();
  });

  it('emits a structured warn (not console.warn) through the injected logger on a collision', async () => {
    const grove = createGrove('Team Projects');
    const collisionId = createProjectId();
    const localRoot = path.join(testDir, 'local-checkout-2');
    registerProjectInGrove(grove.id, {
      projectId: collisionId,
      projectName: 'Local Wins',
      projectRoot: localRoot,
    });
    const host = seedHost([
      { grove_id: createGroveId(), project_id: collisionId, root: writeAttachedCheckout(collisionId, 'Attached Loses'), local_grove_id: grove.id },
    ]);

    const warnCalls: Array<{ kind: string; message: string; data?: Record<string, unknown> }> = [];
    const logger = { warn: (kind: string, message: string, data?: Record<string, unknown>) => { warnCalls.push({ kind, message, data }); } };

    await createListGrovesHandler({ groveIds: null }, serviceDir, logger)({
      body: undefined, query: {}, params: {}, pathname: '/api/groves',
    });

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0].kind).toBe('groves.attached-collision');
    expect(warnCalls[0].data).toEqual({ project_id: collisionId, host_id: host.host_id });
  });

  it('never warns when no collision occurred', async () => {
    const grove = createGrove('Team Projects');
    const attachedId = createProjectId();
    seedHost([{ grove_id: createGroveId(), project_id: attachedId, root: writeAttachedCheckout(attachedId, 'No Collision'), local_grove_id: grove.id }]);

    const warnCalls: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => { warnCalls.push(args); } };

    await createListGrovesHandler({ groveIds: null }, serviceDir, logger)({
      body: undefined, query: {}, params: {}, pathname: '/api/groves',
    });
    await createListGroveProjectsHandler({ groveIds: null }, serviceDir, logger)({
      body: undefined, query: {}, params: { id: grove.id }, pathname: `/api/groves/${grove.id}/projects`,
    });

    expect(warnCalls).toHaveLength(0);
  });

  it('dials no host while building the merge (pure disk read of the host registry)', async () => {
    const grove = createGrove('Team Projects');
    const attachedId = createProjectId();
    seedHost([{ grove_id: createGroveId(), project_id: attachedId, root: writeAttachedCheckout(attachedId, 'No Dial'), local_grove_id: grove.id }]);

    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      return realFetch(...args);
    }) as typeof fetch;
    try {
      const body = await summaries();
      expect(body.groves.find((g) => g.id === grove.id)!.project_count).toBe(1);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
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
