import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DaemonServer } from '@myco/daemon/server';
import { testPerUserLockNamespace } from '../../helpers/per-user-lock-namespace.js';
import { DaemonLogger } from '@myco/daemon/logger';
import {
  REQUEST_CONTEXT_AUTH_HEADER,
  requestContextHeaders,
  resolveLegacyRequestContext,
} from '@myco/grove/request-context';
import { ensureProjectManifest, saveProjectManifest } from '@myco/config/project-manifest';
import { resolveProjectVaultDir } from '@myco/grove/paths';
import {
  clearGroveRegistryCaches,
  createGrove,
  pauseProject,
  registerProjectInGrove,
  resumeProject,
} from '@myco/grove/registry';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('pause enforcement at write paths', () => {
  let tmp: string;
  let bootstrapVault: string;
  let logger: DaemonLogger;
  let server: DaemonServer;
  let groveId: string;
  const projectId = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  let projectVaultDir: string;
  let projectRoot: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pause-enforce-'));
    bootstrapVault = path.join(tmp, 'bootstrap');
    fs.mkdirSync(bootstrapVault, { recursive: true });
    ensureProjectManifest(bootstrapVault, { projectName: 'bootstrap' });
    fs.mkdirSync(path.join(bootstrapVault, 'logs'), { recursive: true });
    logger = new DaemonLogger(path.join(bootstrapVault, 'logs'));

    previousHome = process.env.MYCO_HOME;
    const home = path.join(tmp, 'home');
    process.env.MYCO_HOME = home;
    clearGroveRegistryCaches();

    projectRoot = path.join(tmp, 'project-a');
    projectVaultDir = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(projectVaultDir, { recursive: true });
    const grove = createGrove('Work', home);
    groveId = grove.id;
    saveProjectManifest(projectVaultDir, {
      project: { id: projectId, name: 'Project A' },
      grove: { binding_id: 'gbind-a', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'Project A',
      projectRoot,
      bindingId: 'gbind-a',
    }, home);

    server = new DaemonServer({
      vaultDir: bootstrapVault,
      logger,
      lockNamespace: testPerUserLockNamespace,
    });
    server.registerRoute('POST', '/api/test-write', async () => ({ body: { ok: true } }));
    server.registerRoute('GET', '/api/test-read', async () => ({ body: { ok: true } }));
    // Stand-ins for the move route and its archive sibling, matching the
    // real registrations in daemon/main.ts — the pause gate's move-retry
    // exemption keys on this exact route shape.
    server.registerRoute('POST', '/api/groves/:id/projects/:projectId', async () => ({
      body: { ok: true, move: true },
    }));
    server.registerRoute('POST', '/api/groves/:id/projects/:projectId/archive', async () => ({
      body: { ok: true },
    }));
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    logger.close();
    clearGroveRegistryCaches();
    if (previousHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function buildHeaders(): Record<string, string> {
    const ctx = resolveLegacyRequestContext(projectVaultDir, {
      projectRoot,
      projectId,
      groveId,
      machineId: 'machine-a',
      source: 'explicit',
    });
    return {
      ...requestContextHeaders(ctx),
      [REQUEST_CONTEXT_AUTH_HEADER]: server.getAuthToken(),
      'Content-Type': 'application/json',
    };
  }

  it('returns 409 with project_paused envelope when the project is paused', async () => {
    pauseProject(groveId, projectId, 'grove-move', 'op-1');

    const res = await fetch(`http://127.0.0.1:${server.port}/api/test-write`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as {
      error: { code: string; message: string };
      paused: { reason: string; owner_op: string; grove_id: string; since: number };
    };
    expect(body.error.code).toBe('project_paused');
    expect(body.error.message).toContain(projectId);
    expect(body.paused.reason).toBe('grove-move');
    expect(body.paused.owner_op).toBe('op-1');
    expect(body.paused.grove_id).toBe(groveId);
    expect(typeof body.paused.since).toBe('number');
  });

  it('allows writes for an unpaused project', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/test-write`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('allows writes again after resume', async () => {
    pauseProject(groveId, projectId, 'grove-move', 'op-1');
    resumeProject(groveId, projectId, 'op-1');

    const res = await fetch(`http://127.0.0.1:${server.port}/api/test-write`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  it('does not block reads on a paused project', async () => {
    pauseProject(groveId, projectId, 'grove-move', 'op-1');

    const res = await fetch(`http://127.0.0.1:${server.port}/api/test-read`, {
      headers: buildHeaders(),
    });
    expect(res.status).toBe(200);
  });

  it('lets the move POST through a grove-move pause for the SAME project (crash-orphaned move retry)', async () => {
    pauseProject(groveId, projectId, 'grove-move', `grove-move-${projectId}-123`);

    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/groves/${groveId}/projects/${projectId}`,
      { method: 'POST', headers: buildHeaders(), body: JSON.stringify({}) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; move: boolean };
    expect(body.move).toBe(true);
  });

  it('still 409s the move POST when the URL names a DIFFERENT project than the paused one', async () => {
    pauseProject(groveId, projectId, 'grove-move', `grove-move-${projectId}-123`);

    // Context headers carry the paused project; the URL names another.
    const otherProjectId = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/groves/${groveId}/projects/${otherProjectId}`,
      { method: 'POST', headers: buildHeaders(), body: JSON.stringify({}) },
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('project_paused');
  });

  it('still 409s the archive sibling route during a grove-move pause', async () => {
    pauseProject(groveId, projectId, 'grove-move', `grove-move-${projectId}-123`);

    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/groves/${groveId}/projects/${projectId}/archive`,
      { method: 'POST', headers: buildHeaders(), body: JSON.stringify({}) },
    );
    expect(res.status).toBe(409);
  });

  it('still 409s the move POST when the pause belongs to a different owner-op class', async () => {
    pauseProject(groveId, projectId, 'vacuum', 'vacuum-op-1');

    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/groves/${groveId}/projects/${projectId}`,
      { method: 'POST', headers: buildHeaders(), body: JSON.stringify({}) },
    );
    expect(res.status).toBe(409);
  });
});
