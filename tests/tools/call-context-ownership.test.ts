/**
 * Ownership is the home, enforced by path.
 *
 * A daemon runs under one MYCO_HOME and owns every Grove under
 * `<MYCO_HOME>/groves/`. The on-demand seams — a `grove_id` tool-call
 * pivot and the daemon's header resolution — must refuse a Grove that
 * lives in a DIFFERENT home BEFORE the dispatcher opens (and
 * createSchema-migrates) that Grove's database. Under physical home
 * separation a foreign-home Grove is simply not present in this home, so
 * the home-scoped lookup returns null and the seam refuses it. The
 * `groveOwnedByThisDaemon` predicate is the soft gate; it must stay a
 * real predicate (false for a foreign-home record), never a no-op that
 * always returns "owned". The client-side resolvers (hooks, stdio
 * bridge, CLI env) must stay non-throwing — a throw there is silently
 * swallowed and drops capture headers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import type { DaemonClient } from '@myco/daemon/client.js';
import { createMycoTools } from '@myco/tools/index.js';
import { isToolError } from '@myco/tools/error.js';
import {
  ForeignGroveError,
  requestContextFromEnvironment,
  requestContextFromHttpHeaders,
  resolveLegacyRequestContext,
  UnknownRequestContextError,
  type MycoRequestContext,
} from '@myco/grove/request-context.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import {
  createGrove,
  groveOwnedByThisDaemon,
  registerProjectInGrove,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { sandboxMycoHome } from '../helpers/myco-home-sandbox.js';
import { vi } from '../helpers/vi-shim.js';

const BASE_PROJECT_ID = assertGroveProjectId(createProjectId());

function mockClient(): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  } as unknown as DaemonClient;
}

/** Base vault + caller context the tool runtime launches under. */
function createFixture(): {
  vaultDir: string;
  requestContext: MycoRequestContext;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-gate-'));
  const vaultDir = path.join(root, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  const db: Database = openDatabase(path.join(vaultDir, 'myco.db'));
  createSchema(db);
  db.close();
  const requestContext = resolveLegacyRequestContext(vaultDir, {
    projectRoot: root,
    projectId: BASE_PROJECT_ID,
    groveId: 'grove-base',
    machineId: 'machine-a',
    source: 'explicit',
    tenancySource: 'caller',
  });
  return {
    vaultDir,
    requestContext,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function callToolError(
  tools: ReturnType<typeof createMycoTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    await tools.callTool(name, args);
    return null;
  } catch (err) {
    return err;
  }
}

describe('grove_id pivot home-ownership gate', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;
  // A second, foreign home on disk — the daemon never points MYCO_HOME at
  // it, so a Grove created here is invisible to the home-scoped lookup.
  let foreignHome: string;

  beforeEach(() => {
    sandbox = sandboxMycoHome('myco-home-gate-');
    foreignHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-gate-foreign-'));
  });

  afterEach(() => {
    fs.rmSync(foreignHome, { recursive: true, force: true });
    sandbox.restore();
  });

  it('rejects a pivot into a foreign-home Grove before its database is created, and allows same-home pivots', async () => {
    const fixture = createFixture();
    try {
      // `foreign` lives under a different MYCO_HOME → not present in this
      // daemon's home. `owned` lives in this daemon's home.
      const foreign = createGrove('Dogfood', foreignHome);
      const owned = createGrove('Work', sandbox.mycoHome);
      const tools = createMycoTools(fixture.vaultDir, mockClient(), { requestContext: fixture.requestContext });

      // Driven through callTool so the gate is proven to fire before
      // runWithRequestDatabase opens (and createSchema-migrates) the
      // target Grove's DB. The foreign-home Grove resolves to null in this
      // home, so the pivot is refused as an unknown Grove and no DB is
      // created under THIS home.
      const caught = await callToolError(tools, 'myco_plans', { grove_id: foreign.id });
      expect(isToolError(caught)).toBe(true);
      expect((caught as Error).message).toContain(foreign.id);
      expect(fs.existsSync(resolveGroveDbPath(foreign.id, sandbox.mycoHome))).toBe(false);

      // Same-home pivot resolves and opens the owned Grove's DB.
      const plans = await tools.callTool('myco_plans', { grove_id: owned.id });
      expect(Array.isArray(plans)).toBe(true);
      expect(fs.existsSync(resolveGroveDbPath(owned.id, sandbox.mycoHome))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('admits any Grove in this home regardless of legacy TOML content', async () => {
    // Ownership is the home now: an in-home record is owned.
    const fixture = createFixture();
    try {
      const grove = createGrove('LegacyDev', sandbox.mycoHome);
      const tools = createMycoTools(fixture.vaultDir, mockClient(), { requestContext: fixture.requestContext });
      expect(Array.isArray(await tools.callTool('myco_plans', { grove_id: grove.id }))).toBe(true);
      expect(fs.existsSync(resolveGroveDbPath(grove.id, sandbox.mycoHome))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('applies an optional exact-Grove constraint before resolving a body pivot', async () => {
    const fixture = createFixture();
    try {
      const served = createGrove('Served', sandbox.mycoHome);
      const other = createGrove('Other', sandbox.mycoHome);
      const tools = createMycoTools(fixture.vaultDir, mockClient(), {
        requestContext: { ...fixture.requestContext, groveId: served.id },
        callContextConstraint: { allowedGroveId: served.id },
      });

      const caught = await callToolError(tools, 'myco_plans', { grove_id: other.id });

      expect(isToolError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe('invalid_input');
      expect((caught as Error).message).toBe(
        "Requested Grove is outside this tool surface's authorized scope",
      );
      expect((caught as Error).message).not.toContain(other.id);

      const unconstrained = createMycoTools(fixture.vaultDir, mockClient(), {
        requestContext: { ...fixture.requestContext, groveId: served.id },
      });
      expect(Array.isArray(await unconstrained.callTool('myco_plans', { grove_id: other.id }))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('groveOwnedByThisDaemon — home predicate is not a no-op', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;
  let foreignHome: string;

  beforeEach(() => {
    sandbox = sandboxMycoHome('myco-home-predicate-');
    foreignHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-predicate-foreign-'));
  });

  afterEach(() => {
    fs.rmSync(foreignHome, { recursive: true, force: true });
    sandbox.restore();
  });


  it('every ownership re-check names its home explicitly — one home per resolution', () => {
    // The regression this pins: `groveOwnedByThisDaemon(record)` with the home
    // DEFAULTED re-resolves MYCO_HOME at check time, making it the one read in
    // a resolution that can answer against a different home than the one that
    // produced the record. In a process where the env shifts under async work
    // (the bundled test runner), the lookup that had just succeeded came back
    // "foreign", and a request due a 404 from the served-grove filter got a
    // 403 here instead — observed exactly once on CI, which is how races
    // introduce themselves. The entry point resolves the home once and every
    // read in that resolution uses it.
    const source = fs.readFileSync('packages/myco/src/grove/request-context.ts', 'utf-8');
    const calls = source.match(/groveOwnedByThisDaemon\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.includes(','), `home defaulted in: ${call}`).toBe(true);
    }
  });

  it('is true for a Grove in this home and false for a Grove that lives in another home', () => {
    const owned = createGrove('Owned', sandbox.mycoHome);
    const foreign = createGrove('Foreign', foreignHome);

    // The foreign record exists on disk (under its own home) but is NOT in
    // this daemon's home, so the home-scoped predicate reads it as not
    // owned. A no-op gate that always returned true would fail this line.
    expect(groveOwnedByThisDaemon(owned, sandbox.mycoHome)).toBe(true);
    expect(groveOwnedByThisDaemon(foreign, sandbox.mycoHome)).toBe(false);
    // Symmetry: from the foreign home, ownership flips.
    expect(groveOwnedByThisDaemon(foreign, foreignHome)).toBe(true);
    expect(groveOwnedByThisDaemon(owned, foreignHome)).toBe(false);
  });
});

describe('daemon request resolution refuses a foreign-home Grove', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;
  let foreignHome: string;
  let projectRoot: string;
  let vaultDir: string;
  let foreign: GroveRecord;
  let projectId: string;

  beforeEach(() => {
    sandbox = sandboxMycoHome('myco-home-daemon-');
    foreignHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-daemon-foreign-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-daemon-proj-'));
    vaultDir = path.join(projectRoot, '.myco');
    const manifest = ensureProjectManifest(vaultDir, { projectName: 'foreign-home-project' });
    // The Grove + its registered project live under the FOREIGN home.
    foreign = createGrove('Dogfood', foreignHome);
    projectId = manifest.project.id;
    registerProjectInGrove(foreign.id, {
      projectId,
      projectName: 'Foreign project',
      projectRoot,
    }, foreignHome);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(foreignHome, { recursive: true, force: true });
    sandbox.restore();
  });

  it('throws unknown-tenancy (404 class) for a foreign-home Grove named by header', () => {
    // The daemon owns sandbox.mycoHome; the named Grove lives in
    // foreignHome → the home-scoped lookup returns null and the resolver
    // fails loud rather than resolving a context whose databasePath points
    // into a foreign Grove.
    const headers = {
      'x-myco-grove-id': foreign.id,
      'x-myco-project-id': projectId,
    };
    expect(() => requestContextFromHttpHeaders(headers, vaultDir, { enforceGroveOwnership: true }))
      .toThrow(UnknownRequestContextError);
  });

  it('still wires the ForeignGroveError → 403 gate (constructable + typed)', () => {
    // The ownership gate that translates to 403 `foreign_grove` is kept as
    // a defense-in-depth backstop. Ownership is the home; the error carries
    // the grove id and a fixed message.
    const err = new ForeignGroveError(foreign.id);
    expect(err.groveId).toBe(foreign.id);
    expect(err.message).toContain(foreign.id);
    expect(err.message).not.toContain('claim');
  });
});

describe('client-side resolvers stay non-throwing for foreign-home Groves', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;
  let projectRoot: string;
  let vaultDir: string;
  let owned: GroveRecord;
  let projectId: string;

  beforeEach(() => {
    sandbox = sandboxMycoHome('myco-home-client-');
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-client-proj-'));
    vaultDir = path.join(projectRoot, '.myco');
    const manifest = ensureProjectManifest(vaultDir, { projectName: 'home-client' });
    // Registered in THIS daemon's home — the client-side resolver contract
    // is non-throwing regardless of ownership enforcement being off.
    owned = createGrove('Work', sandbox.mycoHome);
    projectId = manifest.project.id;
    registerProjectInGrove(owned.id, {
      projectId,
      projectName: 'Owned project',
      projectRoot,
    }, sandbox.mycoHome);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    sandbox.restore();
  });

  it('requestContextFromEnvironment resolves an in-home Grove without throwing (hooks/CLI contract)', () => {
    const context = requestContextFromEnvironment({
      MYCO_GROVE_ID: owned.id,
      MYCO_PROJECT_ID: projectId,
    }, vaultDir);
    expect(context.groveId).toBe(owned.id);
    expect(context.tenancySource).toBe('caller');
  });

  it('requestContextFromHttpHeaders resolves an in-home Grove without throwing when enforcement is off', () => {
    const headers = {
      'x-myco-grove-id': owned.id,
      'x-myco-project-id': projectId,
    };
    const context = requestContextFromHttpHeaders(headers, vaultDir);
    expect(context.groveId).toBe(owned.id);
  });
});
