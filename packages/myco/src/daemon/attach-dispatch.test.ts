/**
 * Chokepoint 1 (router dispatch) integration for the Team Host attach
 * short-circuit — driven through a real `DaemonServer` over loopback HTTP.
 *
 * Proves, at the actual dispatch site:
 *   - an attached project + `serve` route reaches the proxy seam (503
 *     `host_proxy_not_implemented`), the route handler never runs, and no local
 *     Grove DB is opened;
 *   - an attached project + `degrade` route returns the uniform refusal (409
 *     `capability_unavailable_hosted`), handler never runs, no DB opened;
 *   - a non-attached request is byte-identical to today — it reaches the handler.
 *
 * Hermetic: `MYCO_TEAM_HOME` (attach registry) and the daemon log dir are fresh
 * tmpdirs; the daemon state authority is stubbed so no `daemon.json` is written.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DaemonServer } from './server.js';
import { DaemonLogger } from './logger.js';
import { GroveRuntimeCache } from './grove-runtime-cache.js';
import type { DaemonStateAuthority } from './daemon-state-authority.js';
import {
  assertGroveProjectId,
  createGroveId,
  createHostId,
  createProjectId,
} from '../grove/ids.js';
import { upsertHost, type HostRecord } from '../host/registry.js';

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;

describe('attach short-circuit at router dispatch (chokepoint 1)', () => {
  let tmp: string;
  let server: DaemonServer;
  let runtimeCache: GroveRuntimeCache;
  let dbOpens: number;
  let sessionsHandlerCalls: number;
  let gitHandlerCalls: number;
  let savedTeamHome: string | undefined;
  let savedAuth: string | undefined;
  let base: string;
  let authToken: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-dispatch-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    savedAuth = process.env.MYCO_DAEMON_AUTH;
    process.env.MYCO_TEAM_HOME = tmp;

    dbOpens = 0;
    sessionsHandlerCalls = 0;
    gitHandlerCalls = 0;
    runtimeCache = new GroveRuntimeCache();
    const origGetDatabase = runtimeCache.getDatabase.bind(runtimeCache);
    (runtimeCache as unknown as { getDatabase: (p: string) => unknown }).getDatabase = (p: string) => {
      dbOpens += 1;
      return origGetDatabase(p);
    };

    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      runtimeCache,
    });
    server.registerRoute('GET', '/api/sessions', async () => {
      sessionsHandlerCalls += 1;
      return { body: { ok: true } };
    });
    server.registerRoute('GET', '/api/git/status', async () => {
      gitHandlerCalls += 1;
      return { body: { ok: true } };
    });

    await server.start(0);
    base = `http://127.0.0.1:${server.port}`;
    authToken = server.getAuthToken();
  });

  afterEach(async () => {
    await server.stop();
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    if (savedAuth === undefined) delete process.env.MYCO_DAEMON_AUTH;
    else process.env.MYCO_DAEMON_AUTH = savedAuth;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function attach(): string {
    const projectId = assertGroveProjectId(createProjectId());
    const host: HostRecord = {
      host_id: createHostId(),
      label: 'Mac Studio',
      overlay_address: '100.64.0.1:7433',
      protocol_version: 1,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: createGroveId(), project_id: projectId }],
    };
    upsertHost(host);
    return projectId;
  }

  test('attached + serve route → proxy seam (503), handler never runs, no DB opened', async () => {
    const projectId = attach();
    const res = await fetch(`${base}/api/sessions`, {
      headers: { 'x-myco-project-id': projectId, 'x-myco-auth': authToken },
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('host_proxy_not_implemented');
    expect(sessionsHandlerCalls).toBe(0);
    expect(dbOpens).toBe(0);
  });

  test('attached + degrade route → uniform refusal (409), handler never runs, no DB opened', async () => {
    const projectId = attach();
    const res = await fetch(`${base}/api/git/status`, {
      headers: { 'x-myco-project-id': projectId, 'x-myco-auth': authToken },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('capability_unavailable_hosted');
    expect(body.capability).toBe('Git provenance');
    expect(gitHandlerCalls).toBe(0);
    expect(dbOpens).toBe(0);
  });

  test('non-attached request is byte-identical: it reaches the route handler', async () => {
    const res = await fetch(`${base}/api/sessions`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(sessionsHandlerCalls).toBe(1);
  });
});
