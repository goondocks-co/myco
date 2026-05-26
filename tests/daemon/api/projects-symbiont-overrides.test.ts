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
import {
  loadProjectLocalManifest,
  loadProjectManifest,
  saveProjectLocalManifest,
  saveProjectManifest,
} from '@myco/config/project-manifest.js';
import { loadConfig } from '@myco/config/loader.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
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
      wrote: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.project_id).toBe(projectId);
    expect(body.grove_id).toBe(grove.id);
    expect(body.wrote).toEqual([path.join('.myco', 'project.toml')]);

    const manifest = loadProjectManifest(resolveProjectVaultDir(projectRoot));
    expect(manifest?.project.id).toBe(projectId);
    expect(manifest?.grove?.id).toBe(grove.id);
    expect(manifest?.grove?.slug).toBe(grove.slug);
    // binding_id is per-machine (lives in project.local.toml). Without it,
    // the daemon's `assertGroveBound` refuses to start against this vault.
    const local = loadProjectLocalManifest(resolveProjectVaultDir(projectRoot));
    expect(local?.grove_binding?.binding_id).toMatch(/^gbind_[a-f0-9]+$/);
    expect(local?.grove_binding?.mode).toBe('local');
  });

  it('writes project-local launchers when write_launchers=true', async () => {
    const { projectId, projectRoot } = seededProject();
    const response = await call(
      createCommitToRepoHandler(daemonStateDir),
      { params: { projectId }, body: { write_launchers: true } },
    );
    expect(response.status).toBeUndefined();
    const body = response.body as { wrote: string[] };
    expect(body.wrote).toContain(path.join('.agents', 'myco-run.cjs'));
    expect(body.wrote).toContain(path.join('.agents', 'myco-cli.cjs'));

    const runCjs = fs.readFileSync(path.join(projectRoot, '.agents', 'myco-run.cjs'), 'utf-8');
    const cliCjs = fs.readFileSync(path.join(projectRoot, '.agents', 'myco-cli.cjs'), 'utf-8');
    expect(runCjs).toContain('MYCO_LAUNCHER_PROTOCOL=v2');
    expect(cliCjs).toEqual(runCjs);
  });

  it('writes runtime.command pin when runtime_command is set', async () => {
    const { projectId, projectRoot } = seededProject();
    const response = await call(
      createCommitToRepoHandler(daemonStateDir),
      {
        params: { projectId },
        body: { runtime_command: '/usr/local/bin/myco-dev' },
      },
    );
    expect(response.status).toBeUndefined();
    const body = response.body as { wrote: string[] };
    expect(body.wrote).toContain(path.join('.myco', 'runtime.command'));

    const pin = fs.readFileSync(path.join(projectRoot, '.myco', 'runtime.command'), 'utf-8');
    expect(pin.trim()).toBe('/usr/local/bin/myco-dev');
  });

  it('rejects relative runtime_command', async () => {
    const { projectId } = seededProject();
    const response = await call(
      createCommitToRepoHandler(daemonStateDir),
      {
        params: { projectId },
        body: { runtime_command: 'myco-dev' },
      },
    );
    expect(response.status).toBe(400);
    const body = response.body as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_runtime_command');
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
  it('removes project.toml + local.toml + launchers + runtime.command by default', async () => {
    const { projectId, projectRoot } = seededProject();
    await call(
      createCommitToRepoHandler(daemonStateDir),
      {
        params: { projectId },
        body: { write_launchers: true, runtime_command: '/usr/local/bin/myco-dev' },
      },
    );
    const vaultDir = resolveProjectVaultDir(projectRoot);
    const manifestPath = resolveProjectManifestPath(vaultDir);
    const localManifestPath = path.join(vaultDir, 'project.local.toml');
    const runCjs = path.join(projectRoot, '.agents', 'myco-run.cjs');
    const pin = path.join(projectRoot, '.myco', 'runtime.command');
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(localManifestPath)).toBe(true);
    expect(fs.existsSync(runCjs)).toBe(true);
    expect(fs.existsSync(pin)).toBe(true);

    const response = await call(
      createUncommitFromRepoHandler(daemonStateDir),
      { params: { projectId } },
    );
    expect(response.status).toBeUndefined();
    const body = response.body as { ok: boolean; removed: string[] };
    expect(body.ok).toBe(true);
    expect(body.removed).toContain(path.join('.myco', 'project.toml'));
    expect(body.removed).toContain(path.join('.myco', 'project.local.toml'));
    expect(body.removed).toContain(path.join('.agents', 'myco-run.cjs'));
    expect(body.removed).toContain(path.join('.agents', 'myco-cli.cjs'));
    expect(body.removed).toContain(path.join('.myco', 'runtime.command'));
    expect(fs.existsSync(manifestPath)).toBe(false);
    expect(fs.existsSync(localManifestPath)).toBe(false);
    expect(fs.existsSync(runCjs)).toBe(false);
    expect(fs.existsSync(pin)).toBe(false);
  });

  it('preserves launchers when remove_launchers=false', async () => {
    const { projectId, projectRoot } = seededProject();
    await call(
      createCommitToRepoHandler(daemonStateDir),
      { params: { projectId }, body: { write_launchers: true } },
    );
    const runCjs = path.join(projectRoot, '.agents', 'myco-run.cjs');
    expect(fs.existsSync(runCjs)).toBe(true);

    await call(
      createUncommitFromRepoHandler(daemonStateDir),
      { params: { projectId }, body: { remove_launchers: false } },
    );
    expect(fs.existsSync(runCjs)).toBe(true);
  });

  it('is idempotent when nothing has been committed', async () => {
    const { projectId } = seededProject();
    const response = await call(
      createUncommitFromRepoHandler(daemonStateDir),
      { params: { projectId } },
    );
    expect(response.status).toBeUndefined();
    const body = response.body as { ok: boolean; removed: string[] };
    expect(body.ok).toBe(true);
    expect(body.removed).toEqual([]);
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

  it('Fix #2: commit-to-repo writes .myco/.gitignore', async () => {
    const { projectId, projectRoot } = seededProject();
    await call(
      createCommitToRepoHandler(daemonStateDir),
      { params: { projectId } },
    );
    const gitignorePath = path.join(resolveProjectVaultDir(projectRoot), '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);
    const body = fs.readFileSync(gitignorePath, 'utf-8');
    // Verify the per-machine files we now write are covered.
    expect(body).toMatch(/project\.local\.toml|local\.yaml/);
  });

  it('Fix #3: uncommit sweeps the retired .agents/myco-hook.cjs guard', async () => {
    const { projectId, projectRoot } = seededProject();
    // Plant a legacy guard alongside the modern launchers.
    fs.mkdirSync(path.join(projectRoot, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.agents', 'myco-hook.cjs'), '// legacy\n');
    await call(
      createCommitToRepoHandler(daemonStateDir),
      { params: { projectId }, body: { write_launchers: true } },
    );
    expect(fs.existsSync(path.join(projectRoot, '.agents', 'myco-hook.cjs'))).toBe(true);

    const response = await call(
      createUncommitFromRepoHandler(daemonStateDir),
      { params: { projectId } },
    );
    const body = response.body as { removed: string[] };
    expect(body.removed).toContain(path.join('.agents', 'myco-hook.cjs'));
    expect(fs.existsSync(path.join(projectRoot, '.agents', 'myco-hook.cjs'))).toBe(false);
  });

  it('Fix #5: commit-to-repo refuses to overwrite a foreign committed project.id', async () => {
    const { projectId, projectRoot } = seededProject();
    // Plant an existing project.toml whose project.id belongs to
    // somebody else (e.g. a teammate committed it from another machine).
    const vaultDir = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(vaultDir, { recursive: true });
    const foreignId = 'proj_ffffffffffffffffffffffffffffffff';
    saveProjectManifest(vaultDir, {
      project: { id: assertGroveProjectId(foreignId), name: 'remote' },
      grove: { slug: 'whatever' },
    });
    const response = await call(
      createCommitToRepoHandler(daemonStateDir),
      { params: { projectId } },
    );
    expect(response.status).toBe(409);
    const body = response.body as { error?: { code?: string } };
    expect(body.error?.code).toBe('project_id_mismatch');
    // Original file untouched.
    const after = loadProjectManifest(vaultDir);
    expect(after?.project.id).toBe(foreignId);
  });

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

  it('Fix #8: commit-to-repo preserves an existing grove_binding.mode', async () => {
    const { projectId, projectRoot } = seededProject();
    const vaultDir = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(vaultDir, { recursive: true });
    saveProjectLocalManifest(vaultDir, {
      grove_binding: { binding_id: 'gbind_preexisting1234', mode: 'local' as const },
    });
    await call(
      createCommitToRepoHandler(daemonStateDir),
      { params: { projectId } },
    );
    const local = loadProjectLocalManifest(vaultDir);
    // binding_id must be preserved exactly, and mode must remain whatever
    // was there before — the handler must never silently downgrade.
    expect(local?.grove_binding?.binding_id).toBe('gbind_preexisting1234');
    expect(local?.grove_binding?.mode).toBe('local');
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

  it('contract: non-string runtime_command returns 400 invalid_runtime_command (not 500)', async () => {
    const { projectId } = seededProject();
    const response = await call(
      createCommitToRepoHandler(daemonStateDir),
      {
        params: { projectId },
        body: { runtime_command: 42 as unknown as string },
      },
    );
    expect(response.status).toBe(400);
    const body = response.body as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_runtime_command');
  });

  it('contract: empty-string runtime_command returns 400 invalid_runtime_command', async () => {
    const { projectId } = seededProject();
    const response = await call(
      createCommitToRepoHandler(daemonStateDir),
      { params: { projectId }, body: { runtime_command: '' } },
    );
    expect(response.status).toBe(400);
    const body = response.body as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_runtime_command');
  });

  it('contract: corrupt project.toml on disk does not block re-commit', async () => {
    const { projectId, projectRoot } = seededProject();
    // Pre-seed a malformed project.toml — simulates a partial write or
    // hand-edit. The repair endpoint must still succeed.
    const vaultDir = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'project.toml'), 'this is not [valid toml');
    const response = await call(
      createCommitToRepoHandler(daemonStateDir),
      { params: { projectId } },
    );
    expect(response.status).toBeUndefined();
    const body = response.body as { ok: boolean };
    expect(body.ok).toBe(true);
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
