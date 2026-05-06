import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vaultDbPath } from '@myco/db/client.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { resolveDaemonDataPaths } from '@myco/daemon/data-paths.js';
import {
  GROVE_VECTORS_FILENAME,
  resolveGroveDbPath,
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

  it('uses legacy project-local data paths when no Grove binding exists', () => {
    // A project manifest is required (Grove brand) but the manifest
    // need not carry a grove binding — the daemon falls back to the
    // legacy vault DB path in that case.
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
  });
});
