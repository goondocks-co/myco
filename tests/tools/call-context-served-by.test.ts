/**
 * RC-5: `grove.toml served_by` ownership gate at the on-demand seams.
 *
 * A `grove_id` tool-call pivot (and the daemon's header resolution —
 * covered in tests/daemon + tests/mcp) must refuse a Grove served by the
 * other daemon variant BEFORE the dispatcher opens that Grove's database,
 * otherwise a dev daemon/CLI can create or schema-migrate a prod-served
 * Grove's DB. The client-side resolvers (hooks, stdio bridge, CLI env)
 * must stay non-throwing — a throw there is silently swallowed and drops
 * capture headers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { createMycoTools } from '@myco/tools/index.js';
import { isToolError } from '@myco/tools/error.js';
import {
  ForeignGroveError,
  requestContextFromEnvironment,
  requestContextFromHttpHeaders,
  resolveLegacyRequestContext,
  type MycoRequestContext,
} from '@myco/grove/request-context.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import {
  createGrove,
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-served-by-gate-'));
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

describe('grove_id pivot served_by ownership gate', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;
  let previousVariant: string | undefined;

  beforeEach(() => {
    sandbox = sandboxMycoHome('myco-served-by-');
    previousVariant = process.env.MYCO_SERVICE_VARIANT;
    delete process.env.MYCO_SERVICE_VARIANT;
  });

  afterEach(() => {
    if (previousVariant === undefined) delete process.env.MYCO_SERVICE_VARIANT;
    else process.env.MYCO_SERVICE_VARIANT = previousVariant;
    sandbox.restore();
  });

  it('rejects a pivot into a foreign-served Grove before its database is created, and allows same-variant pivots', async () => {
    const fixture = createFixture();
    try {
      const foreign = createGrove('Dogfood', sandbox.mycoHome, { servedBy: 'service-dev' });
      const owned = createGrove('Work', sandbox.mycoHome, { servedBy: 'service' });
      const tools = createMycoTools(fixture.vaultDir, mockClient(), { requestContext: fixture.requestContext });

      // Driven through callTool so the gate is proven to fire before
      // runWithRequestDatabase opens (and createSchema-migrates) the
      // target Grove's DB.
      const caught = await callToolError(tools, 'myco_plans', { grove_id: foreign.id });
      expect(isToolError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe('foreign_grove');
      expect((caught as Error).message).toContain('myco grove claim');
      expect(fs.existsSync(resolveGroveDbPath(foreign.id, sandbox.mycoHome))).toBe(false);

      // Same-variant pivot resolves and opens the owned Grove's DB.
      const plans = await tools.callTool('myco_plans', { grove_id: owned.id });
      expect(Array.isArray(plans)).toBe(true);
      expect(fs.existsSync(resolveGroveDbPath(owned.id, sandbox.mycoHome))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('matches the gate to the current daemon variant (service vs service-dev)', async () => {
    const fixture = createFixture();
    try {
      const devGrove = createGrove('Dogfood', sandbox.mycoHome, { servedBy: 'service-dev' });
      const prodGrove = createGrove('Prod', sandbox.mycoHome, { servedBy: 'service' });
      const tools = createMycoTools(fixture.vaultDir, mockClient(), { requestContext: fixture.requestContext });

      process.env.MYCO_SERVICE_VARIANT = 'dev';
      expect(Array.isArray(await tools.callTool('myco_plans', { grove_id: devGrove.id }))).toBe(true);
      const devCaught = await callToolError(tools, 'myco_plans', { grove_id: prodGrove.id });
      expect((devCaught as { code: string }).code).toBe('foreign_grove');
      expect((devCaught as Error).message).toContain('service');

      process.env.MYCO_SERVICE_VARIANT = 'service';
      expect(Array.isArray(await tools.callTool('myco_plans', { grove_id: prodGrove.id }))).toBe(true);
      const prodCaught = await callToolError(tools, 'myco_plans', { grove_id: devGrove.id });
      expect((prodCaught as { code: string }).code).toBe('foreign_grove');
      expect((prodCaught as Error).message).toContain('service-dev');
    } finally {
      fixture.cleanup();
    }
  });

  it('treats a legacy grove.toml without served_by as service-owned', async () => {
    const fixture = createFixture();
    const legacyId = 'grove_cccccccccccccccccccccccccccccccc';
    try {
      const groveDir = path.join(sandbox.mycoHome, 'groves', legacyId);
      fs.mkdirSync(groveDir, { recursive: true });
      fs.writeFileSync(path.join(groveDir, 'grove.toml'),
        `[grove]\nid = "${legacyId}"\nname = "Legacy"\nslug = "legacy"\nmode = "local"\ncreated_at = "2026-01-01T00:00:00Z"\n`);
      const tools = createMycoTools(fixture.vaultDir, mockClient(), { requestContext: fixture.requestContext });

      // Normalized to 'service' on read: the production variant passes…
      expect(Array.isArray(await tools.callTool('myco_plans', { grove_id: legacyId }))).toBe(true);

      // …and the dev variant is refused.
      process.env.MYCO_SERVICE_VARIANT = 'dev';
      const caught = await callToolError(tools, 'myco_plans', { grove_id: legacyId });
      expect((caught as { code: string }).code).toBe('foreign_grove');
    } finally {
      fixture.cleanup();
    }
  });

  it('admits a pivot into a service-dev Grove when the variant matches', async () => {
    const fixture = createFixture();
    try {
      process.env.MYCO_SERVICE_VARIANT = 'dev';
      const devGrove = createGrove('DevOwned', sandbox.mycoHome, { servedBy: 'service-dev' });
      const prodGrove = createGrove('ProdOwned', sandbox.mycoHome, { servedBy: 'service' });
      const tools = createMycoTools(fixture.vaultDir, mockClient(), { requestContext: fixture.requestContext });

      // Prod-owned Grove is refused by the dev variant.
      const caught = await callToolError(tools, 'myco_plans', { grove_id: prodGrove.id });
      expect((caught as { code: string }).code).toBe('foreign_grove');

      // Dev-owned Grove is admitted.
      expect(Array.isArray(await tools.callTool('myco_plans', { grove_id: devGrove.id }))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('client-side resolvers stay non-throwing for foreign-served Groves', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;
  let previousVariant: string | undefined;
  let projectRoot: string;
  let vaultDir: string;
  let foreign: GroveRecord;
  let projectId: string;

  beforeEach(() => {
    sandbox = sandboxMycoHome('myco-served-by-client-');
    previousVariant = process.env.MYCO_SERVICE_VARIANT;
    delete process.env.MYCO_SERVICE_VARIANT;
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-served-by-proj-'));
    vaultDir = path.join(projectRoot, '.myco');
    const manifest = ensureProjectManifest(vaultDir, { projectName: 'served-by-client' });
    foreign = createGrove('Dogfood', sandbox.mycoHome, { servedBy: 'service-dev' });
    // Registered id must match the manifest's minted project id — the
    // resolver cross-checks the registered root's project.toml.
    projectId = manifest.project.id;
    registerProjectInGrove(foreign.id, {
      projectId,
      projectName: 'Foreign project',
      projectRoot,
    }, sandbox.mycoHome);
  });

  afterEach(() => {
    if (previousVariant === undefined) delete process.env.MYCO_SERVICE_VARIANT;
    else process.env.MYCO_SERVICE_VARIANT = previousVariant;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    sandbox.restore();
  });

  it('requestContextFromEnvironment resolves a foreign-served Grove without throwing (hooks/CLI contract)', () => {
    const context = requestContextFromEnvironment({
      MYCO_GROVE_ID: foreign.id,
      MYCO_PROJECT_ID: projectId,
    }, vaultDir);
    expect(context.groveId).toBe(foreign.id);
    expect(context.tenancySource).toBe('caller');
  });

  it('requestContextFromHttpHeaders only enforces ownership when the daemon opts in', () => {
    const headers = {
      'x-myco-grove-id': foreign.id,
      'x-myco-project-id': projectId,
    };

    // Default (client-side / shared) behavior: resolves, no throw.
    const context = requestContextFromHttpHeaders(headers, vaultDir);
    expect(context.groveId).toBe(foreign.id);

    // Daemon-side opt-in: the same headers are refused.
    let caught: unknown;
    try {
      requestContextFromHttpHeaders(headers, vaultDir, { enforceGroveOwnership: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForeignGroveError);
    expect((caught as ForeignGroveError).groveId).toBe(foreign.id);
    expect((caught as ForeignGroveError).servedBy).toBe('service-dev');
  });
});
