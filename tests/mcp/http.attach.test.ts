/**
 * Chokepoint 2 (raw `/mcp`) integration for the Team Host attach short-circuit +
 * host proxy, driven through the real handler `createStreamableMcpHttpHandler`
 * returns, wired into a real HTTP server and forwarding to a real fixture host.
 *
 * Proves:
 *   - an attached project's non-Canopy `/mcp` tool call is proxied to the host
 *     WITHOUT resolving a database (`resolveDatabase` spy never called);
 *   - an attached project's Canopy tool call is degraded with the uniform
 *     JSON-RPC refusal (`capability_unavailable_hosted`) and never crosses the
 *     wire — the per-tool `/mcp` degrade;
 *   - a non-attached request falls through to normal local resolution (the
 *     existing `legacy_vault` soft-fail), never the seam.
 *
 * Hermetic: `MYCO_TEAM_HOME` is a fresh tmpdir (the attach registry), `vaultDir`
 * is a tmpdir with no manifest (so the local path resolves the daemon anchor),
 * and `MYCO_DAEMON_AUTH` is cleared so the bearer gate is disabled for the test.
 */
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  assertGroveProjectId,
  createGroveId,
  createHostId,
  createProjectId,
} from '@myco/grove/ids';
import { REQUEST_CONTEXT_HEADERS } from '@myco/grove/request-context';
import { writeHostSecret, type HostRecord } from '@myco/host/registry';
import { HOST_BEARER_SECRET } from '@myco/constants';
import { createStreamableMcpHttpHandler } from '@myco/mcp/http';

interface HostHit { url: string; body: string; }

function mcpBody(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

describe('/mcp attach short-circuit + proxy (chokepoint 2)', () => {
  let tmp: string;
  let vaultDir: string;
  let savedTeamHome: string | undefined;
  let savedAuth: string | undefined;
  let dbCalls: number;
  let member: http.Server;
  let memberPort: number;
  let hostServer: http.Server;
  let hostHits: HostHit[];
  let overlayAddress: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mcp-attach-'));
    vaultDir = path.join(tmp, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    savedAuth = process.env.MYCO_DAEMON_AUTH;
    process.env.MYCO_TEAM_HOME = tmp;
    delete process.env.MYCO_DAEMON_AUTH;
    dbCalls = 0;

    hostHits = [];
    hostServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        hostHits.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('utf-8') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
      });
    });
    const hostPort = await new Promise<number>((resolve) =>
      hostServer.listen(0, '127.0.0.1', () => resolve((hostServer.address() as AddressInfo).port)));
    overlayAddress = `127.0.0.1:${hostPort}`;

    const handler = createStreamableMcpHttpHandler(vaultDir, {
      resolveDatabase: () => {
        dbCalls += 1;
        return {} as never;
      },
    });
    member = http.createServer((req, res) => { void handler(req, res); });
    memberPort = await new Promise<number>((resolve) =>
      member.listen(0, '127.0.0.1', () => resolve((member.address() as AddressInfo).port)));
  });

  afterEach(async () => {
    (member as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    (hostServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => member.close(() => resolve()));
    await new Promise<void>((resolve) => hostServer.close(() => resolve()));
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
      overlay_address: overlayAddress,
      protocol_version: 1,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: createGroveId(), project_id: projectId }],
    };
    writeHostRecordFixture(host);
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, 'host-bearer');
    return projectId;
  }

  const memberUrl = () => `http://127.0.0.1:${memberPort}/mcp`;

  test('an attached non-Canopy tool call is proxied to the host and never resolves a database', async () => {
    const projectId = attach();
    const res = await fetch(memberUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [REQUEST_CONTEXT_HEADERS.projectId]: projectId },
      body: mcpBody('myco_search', { type: 'session', query: 'x' }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(hostHits).toHaveLength(1);
    expect(JSON.parse(hostHits[0].body).params.name).toBe('myco_search');
    expect(dbCalls).toBe(0);
  });

  test('an attached Canopy tool call is degraded (JSON-RPC refusal) and never crosses the wire', async () => {
    const projectId = attach();
    const res = await fetch(memberUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [REQUEST_CONTEXT_HEADERS.projectId]: projectId },
      body: mcpBody('myco_cortex', { op: 'canopy_map' }),
    });
    const parsed = await res.json();
    expect(parsed.error.code).toBe(-32004);
    expect(parsed.error.data.code).toBe('capability_unavailable_hosted');
    expect(hostHits).toHaveLength(0);
    expect(dbCalls).toBe(0);
  });

  test('a non-attached request falls through to local resolution (never the seam)', async () => {
    const res = await fetch(memberUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: mcpBody('myco_search', { type: 'session' }),
    });
    const body = await res.json();
    const code = body.error?.data?.code ?? body.error;
    expect(code).not.toBe('host_proxy_not_implemented');
    expect(code).toBe('legacy_vault');
    expect(hostHits).toHaveLength(0);
    expect(dbCalls).toBe(0);
  });
});
