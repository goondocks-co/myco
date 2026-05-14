/**
 * Regression: `PUT /api/backup/config` must persist `backup.dir` at Grove
 * tier (`~/.myco/groves/<id>/grove.yaml`), not at project tier
 * (`<project>/.myco/myco.yaml`).
 *
 * `backup` lives in `GroveConfigSchema` and is listed in
 * `PROJECT_TIER_LEGACY_FIELDS`, which means any project-tier write is
 * silently stripped on the next load. The previous implementation routed
 * writes through `updateBackupConfig(vaultDir, ...)` and lost the value
 * after a restart. This test fixes the API path on disk: the write must
 * land in grove.yaml and survive a fresh `loadGroveConfig`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { createBackupConfigHandlers } from '@myco/daemon/api/backup';
import { loadGroveConfig } from '@myco/config/loader';
import { resolveGroveConfigPath, resolveGroveDir } from '@myco/grove/paths';
import {
  ensureGroveExistsLocally,
  registerProjectInGrove,
} from '@myco/grove/registry';
import { ensureProjectManifest } from '@myco/config/project-manifest';
import { resolveLegacyRequestContext } from '@myco/tools/request-context';
import type { RouteRequest } from '@myco/daemon/router';

describe('PUT /api/backup/config — persists at Grove tier', () => {
  let mycoHome: string;
  let groveId: string;
  let vaultDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.MYCO_HOME;
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bk-home-'));
    process.env.MYCO_HOME = mycoHome;

    groveId = 'grove_aaaa1111bbbb2222cccc3333dddd4444';
    ensureGroveExistsLocally(groveId, { name: 'Test', slug: 'test' }, mycoHome);

    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bk-proj-'));
    vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    // Seed a minimal myco.yaml so loadMergedConfig (used by GET) finds a project tier.
    fs.writeFileSync(
      path.join(vaultDir, 'myco.yaml'),
      'version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n',
    );
    const manifest = ensureProjectManifest(vaultDir, { projectName: 'bk-test' });
    projectId = manifest.project.id;
    registerProjectInGrove(groveId, {
      projectId,
      projectName: 'bk-test',
      projectRoot,
      bindingId: 'gbind_aaaa1111bbbb2222cccc3333dddd4444',
    }, mycoHome);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalHome;
    fs.rmSync(mycoHome, { recursive: true, force: true });
    fs.rmSync(path.dirname(vaultDir), { recursive: true, force: true });
  });

  function makeRequest(body: unknown): RouteRequest {
    return {
      params: {},
      query: {},
      body,
      requestContext: resolveLegacyRequestContext(vaultDir, {
        projectId: projectId as `proj_${string}`,
        groveId,
        machineId: 'test-machine',
      }),
    } as RouteRequest;
  }

  it('writes backup.dir to grove.yaml, not project myco.yaml', async () => {
    const handlers = createBackupConfigHandlers({
      bootstrapVaultDir: vaultDir,
      bootGroveId: null,
      mycoHome,
    });
    const res = await handlers.handlePutBackupConfig(makeRequest({ dir: '/var/test-backups' }));
    expect(res.status).toBeUndefined();
    expect((res.body as { dir: string }).dir).toBe('/var/test-backups');

    const groveYaml = resolveGroveConfigPath(groveId, mycoHome);
    expect(fs.existsSync(groveYaml)).toBe(true);
    const written = YAML.parse(fs.readFileSync(groveYaml, 'utf-8')) as Record<string, unknown>;
    expect((written.backup as { dir?: string })?.dir).toBe('/var/test-backups');

    // Critically: project myco.yaml has not gained a backup block (it
    // would be stripped on load anyway, but the write must not touch it).
    const projectYaml = path.join(vaultDir, 'myco.yaml');
    if (fs.existsSync(projectYaml)) {
      const projectDoc = YAML.parse(fs.readFileSync(projectYaml, 'utf-8'));
      expect(projectDoc?.backup).toBeUndefined();
    }
  });

  it('survives a fresh loadGroveConfig after restart simulation', async () => {
    const handlers = createBackupConfigHandlers({
      bootstrapVaultDir: vaultDir,
      bootGroveId: null,
      mycoHome,
    });
    await handlers.handlePutBackupConfig(makeRequest({ dir: '~/persistent-backups' }));

    // Simulate a daemon restart by reading Grove config fresh from disk.
    const groveConfig = loadGroveConfig(groveId, mycoHome);
    expect(groveConfig.backup.dir).toBe('~/persistent-backups');
  });

  it('GET reflects the Grove-tier value after a write', async () => {
    const handlers = createBackupConfigHandlers({
      bootstrapVaultDir: vaultDir,
      bootGroveId: null,
      mycoHome,
    });
    await handlers.handlePutBackupConfig(makeRequest({ dir: '/var/grove-backups' }));

    const res = await handlers.handleGetBackupConfig(makeRequest({}));
    expect((res.body as { dir: string | null }).dir).toBe('/var/grove-backups');
    expect((res.body as { default_dir: string }).default_dir)
      .toBe(path.resolve(resolveGroveDir(groveId, mycoHome), 'backups'));
  });

  it('returns 404 when no Grove is bound to the request', async () => {
    const handlers = createBackupConfigHandlers({
      bootstrapVaultDir: vaultDir,
      bootGroveId: null,
      mycoHome,
    });
    const legacyReq = {
      params: {},
      query: {},
      body: { dir: '/x' },
      requestContext: resolveLegacyRequestContext(vaultDir, {
        projectId: projectId as `proj_${string}`,
        groveId: null,
        machineId: 'test-machine',
      }),
    } as RouteRequest;
    const res = await handlers.handlePutBackupConfig(legacyReq);
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe('no_grove_in_context');
  });
});
