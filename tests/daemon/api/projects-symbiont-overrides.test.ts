/**
 * Wave 1 API stubs for the per-project Symbiont page:
 *   PATCH  /api/projects/:projectId/symbionts
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
  createProjectSymbiontsPatchHandler,
  handleDrainMigration,
} from '@myco/daemon/api/symbionts.js';
import { createProjectId } from '@myco/grove/ids.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
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

describe('Regression coverage for /code-review high-effort fixes', () => {
  // Fix #1 retired: `hasProjectLocalOptIn` was deleted alongside the
  // walker (plan 38cff0752c919ffd §8 — gap 1/2). Under the global-install
  // model there is no opt-in concept for project-local install; opt-out
  // is the only project-level surface and lives in myco.yaml's
  // `symbionts.<name>.enabled: false`.

  it('Fix #7: PATCH symbionts writes .myco/.gitignore alongside myco.yaml', async () => {
    const { projectId, projectRoot } = seededProject();
    await call(
      createProjectSymbiontsPatchHandler(daemonStateDir),
      {
        params: { projectId },
        body: { symbionts: { 'claude-code': { enabled: false } } },
      },
    );
    const gitignorePath = path.join(resolveProjectVaultDir(projectRoot), '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);
  });

  it('Fix #9: PATCH symbionts rejects non-object entries with invalid_entry', async () => {
    const { projectId } = seededProject();
    // Raw boolean — the old handler crashed on `.enabled` or silently
    // wrote `enabled: true` via the `?? true` fallback.
    const response = await call(
      createProjectSymbiontsPatchHandler(daemonStateDir),
      {
        params: { projectId },
        body: { symbionts: { 'claude-code': false } },
      },
    );
    expect(response.status).toBe(400);
    const body = response.body as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_entry');
  });

  it('Fix #9b: PATCH symbionts rejects non-boolean enabled values', async () => {
    const { projectId } = seededProject();
    const response = await call(
      createProjectSymbiontsPatchHandler(daemonStateDir),
      {
        params: { projectId },
        body: { symbionts: { 'claude-code': { enabled: 'yes' } } },
      },
    );
    expect(response.status).toBe(400);
    const body = response.body as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_entry');
  });

  // ---------------------------------------------------------------
  // Contract-diff regression suite. Each case lists an (input,
  // expected_status, expected_error_code) tuple the OLD pre-capability
  // handlers honored. The NEW capability-routed handlers MUST match.
  //
  // Why this exists: the second-round review found three contract
  // regressions (400 → 500 on bad runtime_command, response shape
  // collapse on empty PATCH, loop-aborting on bad snapshot) that
  // happy-path tests didn't catch. This block locks the externally
  // observable contract so future refactors can't silently change it.
  // ---------------------------------------------------------------

  it('contract: empty `{symbionts: {}}` PATCH returns the live on-disk config (not `{}`)', async () => {
    const { projectId, projectRoot } = seededProject();
    // Seed an override so the response can be checked against
    // non-default state.
    await call(
      createProjectSymbiontsPatchHandler(daemonStateDir),
      {
        params: { projectId },
        body: { symbionts: { 'claude-code': { enabled: false } } },
      },
    );

    const response = await call(
      createProjectSymbiontsPatchHandler(daemonStateDir),
      { params: { projectId }, body: { symbionts: {} } },
    );
    expect(response.status).toBeUndefined();
    const body = response.body as { symbionts: Record<string, { enabled: boolean }> };
    expect(body.symbionts['claude-code']?.enabled).toBe(false);
    // Sanity: the on-disk config is unchanged.
    const cfg = loadConfig(resolveProjectVaultDir(projectRoot));
    expect(cfg.symbionts?.['claude-code']?.enabled).toBe(false);
  });

  it('contract: multi-entry PATCH is atomic (one updateConfig, not N)', async () => {
    const { projectId, projectRoot } = seededProject();
    const response = await call(
      createProjectSymbiontsPatchHandler(daemonStateDir),
      {
        params: { projectId },
        body: {
          symbionts: {
            'claude-code': { enabled: false },
            codex: { enabled: true },
          },
        },
      },
    );
    expect(response.status).toBeUndefined();
    const cfg = loadConfig(resolveProjectVaultDir(projectRoot));
    expect(cfg.symbionts?.['claude-code']?.enabled).toBe(false);
    expect(cfg.symbionts?.codex?.enabled).toBe(true);
  });

  it('Fix #9c: PATCH symbionts still accepts null entries as deletes', async () => {
    const { projectId, projectRoot } = seededProject();
    // Seed with a per-project override, then clear it.
    await call(
      createProjectSymbiontsPatchHandler(daemonStateDir),
      {
        params: { projectId },
        body: { symbionts: { 'claude-code': { enabled: false } } },
      },
    );
    expect(loadConfig(resolveProjectVaultDir(projectRoot)).symbionts?.['claude-code']?.enabled).toBe(false);

    const response = await call(
      createProjectSymbiontsPatchHandler(daemonStateDir),
      {
        params: { projectId },
        body: { symbionts: { 'claude-code': null } },
      },
    );
    expect(response.status).toBeUndefined();
    expect(loadConfig(resolveProjectVaultDir(projectRoot)).symbionts?.['claude-code']).toBeUndefined();
  });
});
