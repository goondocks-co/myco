import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vaultDbPath } from '@myco/db/client.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { resolveDaemonDataPaths } from '@myco/daemon/data-paths.js';
import { resolveDaemonLogDir } from '@myco/daemon/service-state.js';
import {
  GROVE_VECTORS_FILENAME,
  resolveGroveDbPath,
  resolveServiceDir,
  resolveGroveVectorsPath,
} from '@myco/grove/paths.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';

describe('resolveDaemonDataPaths', () => {
  let tempDir: string;
  let projectRoot: string;
  let vaultDir: string;
  let mycoHome: string;
  let previousMycoHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-daemon-paths-'));
    projectRoot = path.join(tempDir, 'project');
    vaultDir = path.join(projectRoot, '.myco');
    mycoHome = path.join(tempDir, 'home');
    fs.mkdirSync(vaultDir, { recursive: true });
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
  });

  afterEach(() => {
    if (previousMycoHome === undefined) {
      delete process.env.MYCO_HOME;
    } else {
      process.env.MYCO_HOME = previousMycoHome;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('falls back to vault paths for data and the global service dir for logs when no Grove binding exists', () => {
    // A project manifest is required (Grove brand) but the manifest
    // need not carry a Grove binding — the per-request data paths fall
    // back to the legacy vault DB/vector locations, while the daemon log
    // dir is always under the global service dir post-Grove.
    saveProjectManifest(vaultDir, {
      project: { id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'project' },
    });

    const paths = resolveDaemonDataPaths(vaultDir, {
      MYCO_HOME: mycoHome,
      MYCO_MACHINE_ID: 'machine-test',
    });

    expect(paths.usingGrove).toBe(false);
    expect(paths.databasePath).toBe(vaultDbPath(vaultDir));
    expect(paths.vectorsPath).toBe(path.join(vaultDir, GROVE_VECTORS_FILENAME));
    expect(paths.requestContext.groveId).toBeNull();
    expect(resolveDaemonLogDir(vaultDir, {
      requestContext: paths.requestContext,
      env: { MYCO_HOME: mycoHome },
    })).toBe(path.join(resolveServiceDir(mycoHome), 'logs'));
  });

  it('uses Grove data paths for a registered bound project', () => {
    const grove = createGrove('Dogfood', mycoHome);
    saveProjectManifest(vaultDir, {
      project: { id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'project' },
      grove: { binding_id: 'gbind_test', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, {
      projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      projectName: 'project',
      projectRoot,
      bindingId: 'gbind_test',
    }, mycoHome);

    const paths = resolveDaemonDataPaths(vaultDir, {
      MYCO_HOME: mycoHome,
      MYCO_MACHINE_ID: 'machine-test',
    });

    expect(paths.usingGrove).toBe(true);
    expect(paths.databasePath).toBe(resolveGroveDbPath(grove.id, mycoHome));
    expect(paths.vectorsPath).toBe(resolveGroveVectorsPath(grove.id, mycoHome));
    expect(paths.requestContext.projectId).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(paths.requestContext.groveId).toBe(grove.id);
    expect(paths.requestContext.projectVaultDir).toBe(vaultDir);
    expect(resolveDaemonLogDir(vaultDir, {
      requestContext: paths.requestContext,
      env: { MYCO_HOME: mycoHome },
    })).toBe(path.join(resolveServiceDir(mycoHome), 'logs'));
  });
});
