/**
 * Wave 1 API stubs for the per-project Symbiont page:
 *   PATCH  /api/projects/:projectId/symbionts
 *   POST   /api/projects/:projectId/commit-to-repo
 *   DELETE /api/projects/:projectId/commit-to-repo
 *   POST   /api/symbionts/drain-migration
 *
 * Wave 2 (the UI implementation) consumes these. The contract is locked
 * down here so the UI implementer can rely on the response shapes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createCommitToRepoHandler,
  createUncommitFromRepoHandler,
} from '@myco/daemon/api/projects.js';
import {
  createProjectSymbiontsPatchHandler,
  handleDrainMigration,
} from '@myco/daemon/api/symbionts.js';
import { createProjectId } from '@myco/grove/ids.js';
import {
  resolveProjectManifestPath,
  resolveProjectVaultDir,
} from '@myco/grove/paths.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { loadProjectManifest } from '@myco/config/project-manifest.js';
import { loadConfig } from '@myco/config/loader.js';
import type { RouteHandler, RouteResponse } from '@myco/daemon/router.js';

let testDir: string;
let mycoHome: string;
let daemonStateDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-symbiont-overrides-api-'));
  mycoHome = path.join(testDir, 'home');
  daemonStateDir = path.join(mycoHome, 'service');
  previousHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  fs.mkdirSync(mycoHome, { recursive: true });
  clearGroveRegistryCaches();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = previousHome;
  fs.rmSync(testDir, { recursive: true, force: true });
  clearGroveRegistryCaches();
});

function seededProject(): {
  grove: ReturnType<typeof createGrove>;
  projectId: string;
  projectRoot: string;
} {
  const grove = createGrove('Override Subject');
  const projectId = createProjectId();
  const projectRoot = path.join(testDir, 'project-a');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(resolveProjectVaultDir(projectRoot), { recursive: true });
  registerProjectInGrove(grove.id, {
    projectId,
    projectName: 'Override Subject',
    projectRoot,
  });
  return { grove, projectId, projectRoot };
}

function call(
  handler: RouteHandler,
  init: { body?: unknown; params: Record<string, string> },
): Promise<RouteResponse> {
  return handler({
    body: init.body,
    query: {},
    params: init.params,
    pathname: '',
  });
}

describe('PATCH /api/projects/:projectId/symbionts', () => {
  it('writes a per-project enabled flag into myco.yaml', async () => {
    const { projectId, projectRoot } = seededProject();
    const response = await call(
      createProjectSymbiontsPatchHandler(daemonStateDir),
      {
        params: { projectId },
        body: { symbionts: { 'claude-code': { enabled: false } } },
      },
    );

    expect(response.status).toBeUndefined();
    const body = response.body as { symbionts: Record<string, { enabled: boolean }> };
    expect(body.symbionts['claude-code']?.enabled).toBe(false);

    const config = loadConfig(resolveProjectVaultDir(projectRoot));
    expect(config.symbionts?.['claude-code']?.enabled).toBe(false);
  });

  it('rejects unknown symbiont names', async () => {
    const { projectId } = seededProject();
    const response = await call(
      createProjectSymbiontsPatchHandler(daemonStateDir),
      {
        params: { projectId },
        body: { symbionts: { 'imaginary-agent': { enabled: false } } },
      },
    );
    expect(response.status).toBe(400);
    const body = response.body as { error?: { code?: string } };
    expect(body.error?.code).toBe('unknown_symbiont');
  });

  it('rejects bodies missing a symbionts object', async () => {
    const { projectId } = seededProject();
    const response = await call(
      createProjectSymbiontsPatchHandler(daemonStateDir),
      { params: { projectId }, body: {} },
    );
    expect(response.status).toBe(400);
  });

  it('returns 404 for an unregistered project', async () => {
    const response = await call(
      createProjectSymbiontsPatchHandler(daemonStateDir),
      {
        params: { projectId: createProjectId() },
        body: { symbionts: { 'claude-code': { enabled: false } } },
      },
    );
    expect(response.status).toBe(404);
  });
});

describe('POST /api/projects/:projectId/commit-to-repo', () => {
  it('writes project.toml with project + grove identity', async () => {
    const { projectId, projectRoot, grove } = seededProject();
    const response = await call(
      createCommitToRepoHandler(daemonStateDir),
      { params: { projectId } },
    );

    expect(response.status).toBeUndefined();
    const body = response.body as {
      ok: boolean;
      project_id: string;
      grove_id: string;
      manifest_path: string;
      not_implemented_flags?: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.project_id).toBe(projectId);
    expect(body.grove_id).toBe(grove.id);
    expect(body.not_implemented_flags).toBeUndefined();

    const manifest = loadProjectManifest(resolveProjectVaultDir(projectRoot));
    expect(manifest?.project.id).toBe(projectId);
    expect(manifest?.grove?.id).toBe(grove.id);
    expect(manifest?.grove?.slug).toBe(grove.slug);
  });

  it('echoes deferred flags from the request body', async () => {
    const { projectId } = seededProject();
    const response = await call(
      createCommitToRepoHandler(daemonStateDir),
      {
        params: { projectId },
        body: { write_launchers: true, runtime_command: '/usr/local/bin/myco-dev' },
      },
    );
    const body = response.body as { not_implemented_flags?: string[] };
    expect(body.not_implemented_flags).toEqual(['write_launchers', 'runtime_command']);
  });

  it('returns 404 for an unregistered project', async () => {
    const response = await call(
      createCommitToRepoHandler(daemonStateDir),
      { params: { projectId: createProjectId() } },
    );
    expect(response.status).toBe(404);
  });
});

describe('DELETE /api/projects/:projectId/commit-to-repo', () => {
  it('removes a previously written project.toml', async () => {
    const { projectId, projectRoot } = seededProject();
    await call(createCommitToRepoHandler(daemonStateDir), { params: { projectId } });
    const manifestPath = resolveProjectManifestPath(resolveProjectVaultDir(projectRoot));
    expect(fs.existsSync(manifestPath)).toBe(true);

    const response = await call(
      createUncommitFromRepoHandler(daemonStateDir),
      { params: { projectId } },
    );
    expect(response.status).toBeUndefined();
    const body = response.body as { ok: boolean; removed: boolean };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it('is idempotent when project.toml is already absent', async () => {
    const { projectId } = seededProject();
    const response = await call(
      createUncommitFromRepoHandler(daemonStateDir),
      { params: { projectId } },
    );
    expect(response.status).toBeUndefined();
    const body = response.body as { ok: boolean; removed: boolean };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(false);
  });
});

describe('POST /api/symbionts/drain-migration', () => {
  it('returns a migration pass result with the expected shape', async () => {
    const response = await handleDrainMigration();
    expect(response.status).toBeUndefined();
    const body = response.body as {
      migration: {
        passId: string;
        passedAt: number;
        projectsVisited: number;
        projectsCleaned: number;
        projectsErrored: number;
        outcomes: unknown[];
      };
    };
    expect(typeof body.migration.passId).toBe('string');
    expect(typeof body.migration.passedAt).toBe('number');
    expect(typeof body.migration.projectsVisited).toBe('number');
    expect(Array.isArray(body.migration.outcomes)).toBe(true);
  });
});
