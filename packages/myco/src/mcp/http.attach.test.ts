/**
 * Chokepoint 2 (raw `/mcp`) integration for the Team Host attach short-circuit.
 *
 * Drives the real handler `createStreamableMcpHttpHandler` returns, with a fake
 * request/response, to prove: an attached project short-circuits to the proxy
 * seam (503 `host_proxy_not_implemented`) WITHOUT resolving a database (the
 * `resolveDatabase` spy is never called), while a non-attached request falls
 * through to the normal local resolution (it never sees the seam).
 *
 * Hermetic: `MYCO_TEAM_HOME` is a fresh tmpdir (the attach registry), `vaultDir`
 * is a tmpdir with no manifest (so the local path resolves the daemon anchor),
 * and `MYCO_DAEMON_AUTH` is cleared so the bearer gate is disabled for the test.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertGroveProjectId,
  createGroveId,
  createHostId,
  createProjectId,
} from '../grove/ids.js';
import { REQUEST_CONTEXT_HEADERS } from '../grove/request-context.js';
import { upsertHost, type HostRecord } from '../host/registry.js';
import { createStreamableMcpHttpHandler } from './http.js';

function fakeResponse() {
  const captured: { status: number; body: string } = { status: 0, body: '' };
  const res = {
    statusCode: 200,
    setHeader() {},
    on() {},
    end(body?: string) {
      captured.status = this.statusCode;
      captured.body = body ?? '';
    },
  };
  return { res: res as unknown as http.ServerResponse, captured };
}

function fakeRequest(headers: Record<string, string>): http.IncomingMessage {
  return { method: 'POST', headers } as unknown as http.IncomingMessage;
}

describe('/mcp attach short-circuit (chokepoint 2)', () => {
  let tmp: string;
  let vaultDir: string;
  let savedTeamHome: string | undefined;
  let savedAuth: string | undefined;
  let dbCalls: number;
  let handler: ReturnType<typeof createStreamableMcpHttpHandler>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mcp-attach-'));
    vaultDir = path.join(tmp, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    savedAuth = process.env.MYCO_DAEMON_AUTH;
    process.env.MYCO_TEAM_HOME = tmp;
    delete process.env.MYCO_DAEMON_AUTH;
    dbCalls = 0;
    handler = createStreamableMcpHttpHandler(vaultDir, {
      resolveDatabase: () => {
        dbCalls += 1;
        return {} as never;
      },
    });
  });

  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    if (savedAuth === undefined) delete process.env.MYCO_DAEMON_AUTH;
    else process.env.MYCO_DAEMON_AUTH = savedAuth;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('an attached project hits the proxy seam (503) and never resolves a database', async () => {
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

    const { res, captured } = fakeResponse();
    await handler(fakeRequest({ [REQUEST_CONTEXT_HEADERS.projectId]: projectId }), res);

    expect(captured.status).toBe(503);
    expect(JSON.parse(captured.body).error).toBe('host_proxy_not_implemented');
    expect(dbCalls).toBe(0);
  });

  test('a non-attached request falls through to local resolution (never the seam)', async () => {
    const { res, captured } = fakeResponse();
    // No project-id header → anchor / no tenancy → local branch → the existing
    // legacy_vault soft-fail, NOT the attach seam.
    await handler(fakeRequest({}), res);

    const body = JSON.parse(captured.body);
    const code = body.error?.data?.code ?? body.error;
    expect(code).not.toBe('host_proxy_not_implemented');
    expect(code).toBe('legacy_vault');
    expect(dbCalls).toBe(0);
  });
});
