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
  for (const [id, name, slug] of [
    ['grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Default', 'default'],
    ['grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Dogfood', 'dogfood'],
  ] as const) {
    const groveDir = path.join(mycoHome, 'groves', id);
    mkdirSync(groveDir, { recursive: true });
    writeFileSync(path.join(groveDir, 'grove.toml'),
      `[grove]\nid = "${id}"\nname = "${name}"\nslug = "${slug}"\nmode = "local"\ncreated_at = "2026-01-01T00:00:00Z"\n`);
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

  it('visits all Groves in the home', async () => {
    // Home is the boundary; forEachGrove returns every Grove in the home.
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
 * Request seam: the daemon's inbound resolution must refuse a Grove that
 * lives in a DIFFERENT home BEFORE any handler runs or the Grove's
 * database is opened. Ownership is the home — a foreign-home Grove is not
 * present in this daemon's home, so the home-scoped lookup returns null
 * and the resolver fails loud (404) rather than resolving a context whose
 * databasePath points into a foreign Grove. The cases below run the
 * daemon under home A (`sandbox.mycoHome`) and put the foreign Grove +
 * its project under home B (`foreignHome`) — a no-op gate would serve
 * them.
 */
describe('DaemonServer home ownership gate on inbound requests', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;
  let foreignHome: string;
  let tmp: string;
  let logger: DaemonLogger;
  let server: DaemonServer;
  let foreignGrove: GroveRecord;
  let ownedGrove: GroveRecord;
  let foreignRoot: string;
  let ownedRoot: string;

  beforeEach(async () => {
    sandbox = sandboxMycoHome('myco-home-daemon-');
    tmp = mkdtempSync(path.join(tmpdir(), 'myco-home-seam-'));
    foreignHome = path.join(tmp, 'home-B', '.myco');
    mkdirSync(path.join(foreignHome, 'groves'), { recursive: true });

    // Foreign Grove + registered project under home B — both header shapes
    // below must be refused by the home-A daemon.
    foreignGrove = createGrove('Dogfood', foreignHome);
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
    }, foreignHome);

    // Owned Grove under home A (the daemon's home) — control.
    ownedGrove = createGrove('Work', sandbox.mycoHome);
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
    fs.rmSync(tmp, { recursive: true, force: true });
    sandbox.restore();
  });

  async function request(headers: Record<string, string>) {
    return fetch(`http://127.0.0.1:${server.port}/test/ctx`, {
      headers: { 'x-myco-auth': server.getAuthToken(), ...headers },
    });
  }

  it('refuses a foreign-home Grove named by x-myco-grove-id, without creating its DB in this home', async () => {
    const res = await request({
      'x-myco-grove-id': foreignGrove.id,
      'x-myco-project-id': 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    // A foreign-home Grove is unknown to this daemon → unknown_tenancy (404),
    // never a context pointing into the foreign Grove.
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('unknown_tenancy');
    // The refusal happened before any DB was created under THIS home.
    expect(fs.existsSync(resolveGroveDbPath(foreignGrove.id, sandbox.mycoHome))).toBe(false);
  });

  it('refuses when only x-myco-project-root names the foreign-home project (manifest funnel)', async () => {
    const res = await request({ 'x-myco-project-root': foreignRoot });
    // The manifest names a project that is registered only under home B;
    // `findRegisteredProject` walks this daemon's home (A) and cannot find
    // it, so the funnel refuses to resolve a context. The security-relevant
    // invariant is that the foreign Grove is never served and its DB is
    // never created under this daemon's home. (The funnel's not-registered
    // refusal surfaces as a generic 500 rather than a typed 404 — see the
    // report; it is not the ownership gate and is out of T7b scope.)
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(resolveGroveDbPath(foreignGrove.id, sandbox.mycoHome))).toBe(false);
  });

  it('serves a Grove owned by this daemon (same home)', async () => {
    const res = await request({
      'x-myco-grove-id': ownedGrove.id,
      'x-myco-project-id': 'proj_cccccccccccccccccccccccccccccccc',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { grove_id: string };
    expect(body.grove_id).toBe(ownedGrove.id);
  });

  it('translates handler-thrown gate errors on the body-scope channel to 404 grove_not_found', async () => {
    // Body-scope `grove_id` bypasses the header funnel; the handler's
    // assertOwnedGrove throws for both a foreign-home id and an unknown id
    // (home-scoped lookup returns null) and the server catch translates to
    // 404 grove_not_found — without creating any grove dir in this home.
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
    expect(foreignRes.status).toBe(404);
    const foreignBody = await foreignRes.json() as { error: string };
    expect(foreignBody.error).toBe('grove_not_found');
    expect(fs.existsSync(resolveGroveDbPath(foreignGrove.id, sandbox.mycoHome))).toBe(false);
    // The foreign Grove was never materialized under this daemon's home.
    expect(fs.existsSync(path.join(sandbox.mycoHome, 'groves', foreignGrove.id))).toBe(false);

    const unknownId = 'grove_' + 'f'.repeat(32);
    const unknownRes = await optimize(unknownId);
    expect(unknownRes.status).toBe(404);
    const unknownBody = await unknownRes.json() as { error: string };
    expect(unknownBody.error).toBe('grove_not_found');
    expect(fs.existsSync(path.join(sandbox.mycoHome, 'groves', unknownId))).toBe(false);
  });
});
