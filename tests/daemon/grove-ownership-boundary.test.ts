import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs, { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { forEachGrove } from '@myco/daemon/scope-iteration.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { DaemonServer } from '@myco/daemon/server.js';
import { createDatabaseMaintenanceHandlers } from '@myco/daemon/api/database.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import type { Logger } from '@myco/daemon/logger.js';
import { createGrove, registerProjectInGrove, type GroveRecord } from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { sandboxMycoHome } from '../helpers/myco-home-sandbox.js';

const noopLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;

function seedTwoGroves(mycoHome: string) {
  for (const [id, name, slug, served] of [
    ['grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Default', 'default', 'service'],
    ['grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Dogfood', 'dogfood', 'service-dev'],
  ] as const) {
    const groveDir = path.join(mycoHome, 'groves', id);
    mkdirSync(groveDir, { recursive: true });
    writeFileSync(path.join(groveDir, 'grove.toml'),
      `[grove]\nid = "${id}"\nname = "${name}"\nslug = "${slug}"\nmode = "local"\ncreated_at = "2026-01-01T00:00:00Z"\nserved_by = "${served}"\n`);
  }
}

describe('forEachGrove home-as-filter', () => {
  let mycoHome: string;
  beforeEach(() => {
    mycoHome = mkdtempSync(path.join(tmpdir(), 'myco-feg-'));
    mkdirSync(path.join(mycoHome, 'groves'), { recursive: true });
    mkdirSync(path.join(mycoHome, 'service'), { recursive: true });
    mkdirSync(path.join(mycoHome, 'service-dev'), { recursive: true });
    seedTwoGroves(mycoHome);
  });

  it('visits all Groves in the home regardless of served_by', async () => {
    // Home is the boundary; served_by no longer filters forEachGrove.
    const visited: string[] = [];
    const cache = new GroveRuntimeCache();
    await forEachGrove(
      cache,
      noopLogger,
      ({ grove }) => { visited.push(grove.slug); },
      { mycoHome },
    );
    expect(visited.sort()).toEqual(['default', 'dogfood']);
  });
});

/**
 * RC-5 request seam: the daemon's inbound header resolution must refuse a
 * Grove served by the other variant with a 403 `foreign_grove` BEFORE any
 * handler runs or the Grove's database is opened — every grove-resolving
 * header branch funnels through the same gate.
 */
describe('DaemonServer served_by ownership gate on inbound requests', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;
  let previousVariant: string | undefined;
  let tmp: string;
  let logger: DaemonLogger;
  let server: DaemonServer;
  let foreignGrove: GroveRecord;
  let ownedGrove: GroveRecord;
  let foreignRoot: string;
  let ownedRoot: string;

  beforeEach(async () => {
    sandbox = sandboxMycoHome('myco-served-by-daemon-');
    previousVariant = process.env.MYCO_SERVICE_VARIANT;
    // This test server runs as the production 'service' variant.
    delete process.env.MYCO_SERVICE_VARIANT;
    tmp = mkdtempSync(path.join(tmpdir(), 'myco-served-by-seam-'));

    // Foreign Grove (dev-served) with a registered project — both header
    // shapes below must be refused.
    foreignGrove = createGrove('Dogfood', sandbox.mycoHome, { servedBy: 'service-dev' });
    foreignRoot = path.join(tmp, 'foreign-project');
    const foreignVault = path.join(foreignRoot, '.myco');
    mkdirSync(foreignVault, { recursive: true });
    saveProjectManifest(foreignVault, {
      project: { id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Foreign' },
      grove: { binding_id: 'gbind-foreign', slug: foreignGrove.slug, mode: 'local' },
    });
    registerProjectInGrove(foreignGrove.id, {
      projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      projectName: 'Foreign',
      projectRoot: foreignRoot,
      bindingId: 'gbind-foreign',
    }, sandbox.mycoHome);

    // Owned Grove (service-served) control.
    ownedGrove = createGrove('Work', sandbox.mycoHome, { servedBy: 'service' });
    ownedRoot = path.join(tmp, 'owned-project');
    mkdirSync(path.join(ownedRoot, '.myco'), { recursive: true });
    registerProjectInGrove(ownedGrove.id, {
      projectId: 'proj_cccccccccccccccccccccccccccccccc',
      projectName: 'Owned',
      projectRoot: ownedRoot,
    }, sandbox.mycoHome);

    const anchorVault = path.join(tmp, 'anchor', '.myco');
    mkdirSync(path.join(anchorVault, 'logs'), { recursive: true });
    logger = new DaemonLogger(path.join(anchorVault, 'logs'));
    server = new DaemonServer({ vaultDir: anchorVault, logger });
    server.registerRoute('GET', '/test/ctx', async (req) => ({
      body: { grove_id: req.requestContext?.groveId ?? null },
    }));
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    logger.close();
    if (previousVariant === undefined) delete process.env.MYCO_SERVICE_VARIANT;
    else process.env.MYCO_SERVICE_VARIANT = previousVariant;
    fs.rmSync(tmp, { recursive: true, force: true });
    sandbox.restore();
  });

  async function request(headers: Record<string, string>) {
    return fetch(`http://127.0.0.1:${server.port}/test/ctx`, {
      headers: { 'x-myco-auth': server.getAuthToken(), ...headers },
    });
  }

  it('returns 403 foreign_grove for a foreign Grove named by x-myco-grove-id, without creating its DB', async () => {
    const res = await request({
      'x-myco-grove-id': foreignGrove.id,
      'x-myco-project-id': 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; grove_id: string; served_by: string };
    expect(body.error).toBe('foreign_grove');
    expect(body.grove_id).toBe(foreignGrove.id);
    expect(body.served_by).toBe('service-dev');
    // The refusal happened before the runtime cache opened the Grove DB.
    expect(fs.existsSync(resolveGroveDbPath(foreignGrove.id, sandbox.mycoHome))).toBe(false);
  });

  it('returns 403 foreign_grove when only x-myco-project-root names the foreign project (manifest funnel)', async () => {
    const res = await request({ 'x-myco-project-root': foreignRoot });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; grove_id: string };
    expect(body.error).toBe('foreign_grove');
    expect(body.grove_id).toBe(foreignGrove.id);
    expect(fs.existsSync(resolveGroveDbPath(foreignGrove.id, sandbox.mycoHome))).toBe(false);
  });

  it('serves a Grove owned by this daemon variant', async () => {
    const res = await request({
      'x-myco-grove-id': ownedGrove.id,
      'x-myco-project-id': 'proj_cccccccccccccccccccccccccccccccc',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { grove_id: string };
    expect(body.grove_id).toBe(ownedGrove.id);
  });

  it('translates handler-thrown gate errors on the body-scope channel: 403 foreign_grove / 404 grove_not_found', async () => {
    // Body-scope `grove_id` bypasses the header funnel; the handler's
    // assertOwnedGrove throws and the server catch does the translation.
    const dbHandlers = createDatabaseMaintenanceHandlers({
      createManager: () => {
        throw new Error('details endpoint not used in this test');
      },
      cache: new GroveRuntimeCache(),
      logger,
      vaultDir: path.join(tmp, 'anchor', '.myco'),
      daemonStateDir: path.join(sandbox.mycoHome, 'service'),
      mycoHome: sandbox.mycoHome,
    });
    server.registerRoute('POST', '/test/database/optimize', dbHandlers.handleOptimize);

    async function optimize(groveId: string) {
      return fetch(`http://127.0.0.1:${server.port}/test/database/optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: { kind: 'grove', grove_id: groveId } }),
      });
    }

    const foreignRes = await optimize(foreignGrove.id);
    expect(foreignRes.status).toBe(403);
    const foreignBody = await foreignRes.json() as { error: string; served_by: string };
    expect(foreignBody.error).toBe('foreign_grove');
    expect(foreignBody.served_by).toBe('service-dev');
    expect(fs.existsSync(resolveGroveDbPath(foreignGrove.id, sandbox.mycoHome))).toBe(false);

    const unknownId = 'grove_' + 'f'.repeat(32);
    const unknownRes = await optimize(unknownId);
    expect(unknownRes.status).toBe(404);
    const unknownBody = await unknownRes.json() as { error: string };
    expect(unknownBody.error).toBe('grove_not_found');
    expect(fs.existsSync(path.join(sandbox.mycoHome, 'groves', unknownId))).toBe(false);
  });
});
