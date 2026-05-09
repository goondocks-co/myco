import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger } from '@myco/daemon/logger';
import { requestContextHeaders, resolveLegacyRequestContext, REQUEST_CONTEXT_AUTH_HEADER } from '@myco/tools/request-context';
import { ensureProjectManifest, saveProjectManifest } from '@myco/config/project-manifest';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry';
import { getDatabase, openDatabase } from '@myco/db/client';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('DaemonServer', () => {
  let vaultDir: string;
  let logger: DaemonLogger;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-srv-'));
    ensureProjectManifest(vaultDir, { projectName: 'srv-test' });
    fs.mkdirSync(path.join(vaultDir, 'logs'), { recursive: true });
    logger = new DaemonLogger(path.join(vaultDir, 'logs'));
  });

  afterEach(async () => {
    logger.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('starts on a random port and writes daemon.json', async () => {
    const server = new DaemonServer({ vaultDir, logger });
    await server.start();

    const info = JSON.parse(fs.readFileSync(path.join(vaultDir, 'daemon.json'), 'utf-8'));
    expect(info.port).toBeGreaterThan(0);
    expect(info.pid).toBe(process.pid);

    await server.stop();
  });

  it('responds to /health with myco: true', async () => {
    const server = new DaemonServer({ vaultDir, logger });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    const body = await res.json();
    expect(body.myco).toBe(true);
    expect(body.pid).toBe(process.pid);

    await server.stop();
  });

  it('returns 404 for unknown routes', async () => {
    const server = new DaemonServer({ vaultDir, logger });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${server.port}/unknown`);
    expect(res.status).toBe(404);

    await server.stop();
  });

  it('returns JSON 404 for unknown API routes instead of the SPA shell', async () => {
    const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-ui-'));
    // The HTML must include </head> so the auth-bootstrap injector
    // (`injectDashboardBootstrap`) can attach the daemon's bearer token
    // — the production Vite build always has one, and the injector now
    // throws on a missing marker rather than silently no-op'ing.
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<html><head></head><body>Dashboard</body></html>');
    const server = new DaemonServer({ vaultDir, logger, uiDir });
    try {
      await server.start();

      const apiRes = await fetch(`http://127.0.0.1:${server.port}/api/missing`);
      expect(apiRes.status).toBe(404);
      expect(apiRes.headers.get('content-type')).toContain('application/json');
      expect(await apiRes.json()).toEqual({ error: 'not found' });

      const dashboardRes = await fetch(`http://127.0.0.1:${server.port}/some/dashboard/path`);
      expect(dashboardRes.status).toBe(200);
      expect(await dashboardRes.text()).toContain('Dashboard');
    } finally {
      await server.stop();
      fs.rmSync(uiDir, { recursive: true, force: true });
    }
  });

  it('attaches request context to daemon routes', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-srv-context-'));
    const previousHome = process.env.MYCO_HOME;
    const server = new DaemonServer({ vaultDir, logger });
    try {
      const home = path.join(tmp, 'home');
      process.env.MYCO_HOME = home;
      const projectRoot = path.join(tmp, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const projectVaultDir = resolveProjectVaultDir(projectRoot);
      fs.mkdirSync(projectVaultDir, { recursive: true });
      const grove = createGrove('Work', home);
      saveProjectManifest(projectVaultDir, {
        project: { id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Project A' },
        grove: { binding_id: 'gbind-a', slug: grove.slug, mode: 'local' },
      });
      registerProjectInGrove(grove.id, {
        projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        projectName: 'Project A',
        projectRoot,
        bindingId: 'gbind-a',
      }, home);

      server.registerRoute('GET', '/api/context-echo', async (req) => ({
        body: { context: req.requestContext },
      }));
      await server.start();

      const context = resolveLegacyRequestContext(projectVaultDir, {
        projectRoot,
        projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        groveId: grove.id,
        machineId: 'machine-a',
        sessionId: 'sess-a',
        source: 'explicit',
      });
      const res = await fetch(`http://127.0.0.1:${server.port}/api/context-echo`, {
        headers: { ...requestContextHeaders(context), [REQUEST_CONTEXT_AUTH_HEADER]: server.getAuthToken() },
      });
      const body = await res.json() as { context: { projectId: string; groveId: string; source: string } };

      expect(body.context.projectId).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(body.context.groveId).toBe(grove.id);
      expect(body.context.source).toBe('headers');
    } finally {
      await server.stop();
      if (previousHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('scopes daemon route database helpers to the request-context Grove', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-srv-db-context-'));
    const previousHome = process.env.MYCO_HOME;
    const server = new DaemonServer({ vaultDir, logger });
    try {
      const home = path.join(tmp, 'home');
      process.env.MYCO_HOME = home;
      const projectRootA = path.join(tmp, 'project-a');
      const projectRootB = path.join(tmp, 'project-b');
      const projectVaultDirA = resolveProjectVaultDir(projectRootA);
      const projectVaultDirB = resolveProjectVaultDir(projectRootB);
      fs.mkdirSync(projectVaultDirA, { recursive: true });
      fs.mkdirSync(projectVaultDirB, { recursive: true });
      const groveA = createGrove('Work A', home);
      const groveB = createGrove('Work B', home);
      saveProjectManifest(projectVaultDirA, {
        project: { id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Project A' },
        grove: { binding_id: 'gbind-a', slug: groveA.slug, mode: 'local' },
      });
      saveProjectManifest(projectVaultDirB, {
        project: { id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Project B' },
        grove: { binding_id: 'gbind-b', slug: groveB.slug, mode: 'local' },
      });
      registerProjectInGrove(groveA.id, {
        projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        projectName: 'Project A',
        projectRoot: projectRootA,
        bindingId: 'gbind-a',
      }, home);
      registerProjectInGrove(groveB.id, {
        projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        projectName: 'Project B',
        projectRoot: projectRootB,
        bindingId: 'gbind-b',
      }, home);

      for (const [groveId, marker] of [[groveA.id, 'db-a'], [groveB.id, 'db-b']] as const) {
        const db = openDatabase(resolveGroveDbPath(groveId, home));
        db.run('CREATE TABLE route_marker (value TEXT NOT NULL)');
        db.query('INSERT INTO route_marker (value) VALUES (?)').run(marker);
        db.close();
      }

      server.registerRoute('GET', '/api/db-marker', async () => {
        const row = getDatabase().query('SELECT value FROM route_marker').get() as { value: string };
        return { body: row };
      });
      await server.start();

      const contextA = resolveLegacyRequestContext(projectVaultDirA, {
        projectRoot: projectRootA,
        projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        groveId: groveA.id,
        machineId: 'machine-a',
        source: 'explicit',
      });
      const contextB = resolveLegacyRequestContext(projectVaultDirB, {
        projectRoot: projectRootB,
        projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        groveId: groveB.id,
        machineId: 'machine-b',
        source: 'explicit',
      });

      const resA = await fetch(`http://127.0.0.1:${server.port}/api/db-marker`, {
        headers: { ...requestContextHeaders(contextA), [REQUEST_CONTEXT_AUTH_HEADER]: server.getAuthToken() },
      });
      const resB = await fetch(`http://127.0.0.1:${server.port}/api/db-marker`, {
        headers: { ...requestContextHeaders(contextB), [REQUEST_CONTEXT_AUTH_HEADER]: server.getAuthToken() },
      });

      expect(await resA.json()).toEqual({ value: 'db-a' });
      expect(await resB.json()).toEqual({ value: 'db-b' });
    } finally {
      await server.stop();
      if (previousHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('cleans up daemon.json on stop', async () => {
    const server = new DaemonServer({ vaultDir, logger });
    await server.start();
    await server.stop();

    expect(fs.existsSync(path.join(vaultDir, 'daemon.json'))).toBe(false);
  });

  it('does not delete daemon.json on stop if another daemon has taken over', async () => {
    const server = new DaemonServer({ vaultDir, logger });
    await server.start();

    // Simulate a successor daemon overwriting daemon.json with a different PID
    const jsonPath = path.join(vaultDir, 'daemon.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ pid: 999888, port: 55555, started: new Date().toISOString(), sessions: [] }));

    await server.stop();

    // daemon.json should still exist — the successor owns it
    expect(fs.existsSync(jsonPath)).toBe(true);
    const info = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    expect(info.pid).toBe(999888);
  });

  it('evicts an existing daemon on startup', async () => {
    // Spawn a dummy process that stays alive until killed
    const dummy = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const dummyPid = dummy.pid!;
    dummy.unref();

    // Write a daemon.json pointing at the dummy process
    fs.writeFileSync(
      path.join(vaultDir, 'daemon.json'),
      JSON.stringify({ pid: dummyPid, port: 99999, started: new Date().toISOString(), sessions: [] }),
    );

    // Evicting + starting a new server should kill the dummy
    const server = new DaemonServer({ vaultDir, logger });
    await server.evictExistingDaemon();
    await server.start();

    // The dummy process should be dead
    let alive = false;
    try { process.kill(dummyPid, 0); alive = true; } catch { /* dead */ }
    expect(alive).toBe(false);

    // daemon.json should now point at the new server
    const info = JSON.parse(fs.readFileSync(path.join(vaultDir, 'daemon.json'), 'utf-8'));
    expect(info.pid).toBe(process.pid);

    await server.stop();
  });

  it('handles stale daemon.json with dead PID gracefully', async () => {
    // Write daemon.json with a PID that doesn't exist
    fs.writeFileSync(
      path.join(vaultDir, 'daemon.json'),
      JSON.stringify({ pid: 999999, port: 99999, started: new Date().toISOString(), sessions: [] }),
    );

    // Should start without error
    const server = new DaemonServer({ vaultDir, logger });
    await server.start();

    const info = JSON.parse(fs.readFileSync(path.join(vaultDir, 'daemon.json'), 'utf-8'));
    expect(info.pid).toBe(process.pid);

    await server.stop();
  });

  it('registers routes for /sessions/register and /sessions/unregister', async () => {
    const server = new DaemonServer({ vaultDir, logger });
    const { SessionRegistry } = await import('@myco/daemon/lifecycle');
    const registry = new SessionRegistry({ gracePeriod: 30, onEmpty: () => {} });

    server.registerRoute('POST', '/sessions/register', async (req: any) => {
      registry.register(req.body.session_id);
      return { body: { ok: true, sessions: registry.sessions } };
    });

    server.registerRoute('POST', '/sessions/unregister', async (req: any) => {
      registry.unregister(req.body.session_id);
      return { body: { ok: true, sessions: registry.sessions } };
    });

    await server.start();

    const regRes = await fetch(`http://127.0.0.1:${server.port}/sessions/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'test-session' }),
    });
    expect((await regRes.json()).sessions).toContain('test-session');

    const unregRes = await fetch(`http://127.0.0.1:${server.port}/sessions/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'test-session' }),
    });
    expect((await unregRes.json()).sessions).not.toContain('test-session');

    await server.stop();
  });
});
