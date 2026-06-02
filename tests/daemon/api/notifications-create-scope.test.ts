/**
 * Regression: `POST /api/notifications` (create) must resolve its enabled-gate
 * config against the REQUEST's grove + vault — not the daemon's bootstrap
 * anchor project.
 *
 * The leak: the create handler read `loadMergedConfig` against the anchor
 * `bootstrapVaultDir`, so whether a notification was suppressed was decided by
 * the *anchor* project's config tiers, not the request's. Notification settings
 * are a per-machine/user preference (Grove-tier default + personal/local
 * override, NEVER project `myco.yaml`), so the request's grove is authoritative.
 *
 * These tests pin distinct groves for the anchor (A) and the request tenant
 * (B) and prove:
 *   1. A grove-tier `notifications.enabled = false` on B's grove suppresses a
 *      create that carries B's caller context — even though the anchor grove's
 *      setting (and anchor vault) say enabled. The anchor has no say.
 *   2. The notification row lands tagged with the REQUEST's project id (the
 *      project-scope regression guard).
 *   3. A synthesized/anchor-fallback context is rejected by `tenantRoute` with
 *      400 + `tenancy.violation`, and no row is created.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { useIsolatedHome } from '../../support/isolated-home';
import { getDatabase } from '@myco/db/client.js';
import { handleCreateNotification } from '@myco/daemon/api/notifications.js';
import { tenantRoute } from '@myco/daemon/api/route-helpers.js';
import { invalidateMergedConfigCache } from '@myco/config/loader.js';
import { _clearNotifyDedupForTests } from '@myco/notifications/notify.js';
import {
  ensureGroveExistsLocally,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { resolveGroveConfigPath } from '@myco/grove/paths.js';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { resolveLegacyRequestContext, type MycoRequestContext } from '@myco/tools/request-context.js';
import { assertGroveProjectId, type GroveProjectId } from '@myco/grove/ids.js';
import type { RequestPrincipal } from '@myco/daemon/request-principal.js';
import type { RouteRequest } from '@myco/daemon/router.js';

const GROVE_ANCHOR = 'grove_aaaa1111aaaa1111aaaa1111aaaa1111';
const GROVE_TENANT_B = 'grove_bbbb2222bbbb2222bbbb2222bbbb2222';

/** Build a caller-sourced (authorized) request context for a tenant project. */
function callerContext(opts: {
  vaultDir: string;
  projectId: GroveProjectId;
  groveId: string;
}): MycoRequestContext {
  return resolveLegacyRequestContext(opts.vaultDir, {
    projectId: opts.projectId,
    groveId: opts.groveId,
    machineId: 'machine-a',
    tenancySource: 'caller',
  });
}

/** Derive the principal a `tenantRoute` would hand the create handler. */
function principalFor(ctx: MycoRequestContext): RequestPrincipal {
  return {
    identity: { machineId: ctx.machineId, userId: null },
    tenancy: {
      projectVaultDir: ctx.projectVaultDir as RequestPrincipal['tenancy']['projectVaultDir'],
      projectId: ctx.projectId,
      groveId: ctx.groveId ?? '',
      requestContext: {
        projectVaultDir: ctx.projectVaultDir,
        projectId: ctx.projectId,
        groveId: ctx.groveId ?? '',
      },
    },
  };
}

/** Minimal logger that records `warn` kinds for assertions. */
function recordingLogger(kinds: string[]) {
  return {
    info: () => {},
    warn: (kind: string) => { kinds.push(kind); },
    error: () => {},
    debug: () => {},
  } as never;
}

/** Write a raw `notifications` block into a Grove's grove.yaml. */
function writeGroveNotifications(groveId: string, mycoHome: string, enabled: boolean): void {
  const grovePath = resolveGroveConfigPath(groveId, mycoHome);
  fs.mkdirSync(path.dirname(grovePath), { recursive: true });
  fs.writeFileSync(grovePath, `notifications:\n  enabled: ${enabled}\n`, 'utf-8');
  invalidateMergedConfigCache();
}

/** Create a project on disk + register it in a Grove. Returns vault + id. */
function makeProject(prefix: string, groveId: string, mycoHome: string): {
  projectRoot: string;
  vaultDir: string;
  projectId: GroveProjectId;
} {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const vaultDir = path.join(projectRoot, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  // Seed a minimal project myco.yaml. Notification settings deliberately do
  // NOT live here (project tier), so this file says nothing about enablement.
  fs.writeFileSync(
    path.join(vaultDir, 'myco.yaml'),
    'version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n',
    'utf-8',
  );
  const manifest = ensureProjectManifest(vaultDir, { projectName: prefix });
  const projectId = assertGroveProjectId(manifest.project.id);
  registerProjectInGrove(groveId, {
    projectId,
    projectName: prefix,
    projectRoot,
    bindingId: `gbind_${groveId.slice(6, 38)}`,
  }, mycoHome);
  return { projectRoot, vaultDir, projectId };
}

describe('POST /api/notifications — enabled-gate resolves against the request grove, not the anchor', () => {
  const home = useIsolatedHome('myco-notif-home-');
  let anchor: ReturnType<typeof makeProject>;
  let tenantB: ReturnType<typeof makeProject>;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });

  beforeEach(() => {
    cleanTestDb();
    _clearNotifyDedupForTests();

    ensureGroveExistsLocally(GROVE_ANCHOR, { name: 'Anchor', slug: 'anchor' }, home.path);
    ensureGroveExistsLocally(GROVE_TENANT_B, { name: 'Tenant B', slug: 'tenant-b' }, home.path);

    anchor = makeProject('myco-notif-anchor-', GROVE_ANCHOR, home.path);
    tenantB = makeProject('myco-notif-tenant-', GROVE_TENANT_B, home.path);
  });

  afterEach(() => {
    fs.rmSync(path.dirname(anchor.vaultDir), { recursive: true, force: true });
    fs.rmSync(path.dirname(tenantB.vaultDir), { recursive: true, force: true });
  });

  it('suppresses when B’s grove disables notifications — anchor grove stays enabled', async () => {
    // Anchor's grove says ENABLED; B's grove says DISABLED. The old code read
    // the anchor and would have created the row. The fix reads B's grove.
    writeGroveNotifications(GROVE_ANCHOR, home.path, true);
    writeGroveNotifications(GROVE_TENANT_B, home.path, false);

    const ctx = callerContext({ vaultDir: tenantB.vaultDir, projectId: tenantB.projectId, groveId: GROVE_TENANT_B });
    const response = await handleCreateNotification(
      { body: { domain: 'agent', type: 'task_complete', title: 'Done' }, requestContext: ctx } as RouteRequest,
      principalFor(ctx),
    );

    expect(response.body).toMatchObject({ ok: true, suppressed: true, reason: 'notifications_disabled' });
    const n = getDatabase().prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('creates when B’s grove enables notifications — anchor grove disabled has no effect', async () => {
    // Inverse: anchor grove DISABLED, B's grove ENABLED. The fix must let B's
    // notification through despite the anchor being off.
    writeGroveNotifications(GROVE_ANCHOR, home.path, false);
    writeGroveNotifications(GROVE_TENANT_B, home.path, true);

    const ctx = callerContext({ vaultDir: tenantB.vaultDir, projectId: tenantB.projectId, groveId: GROVE_TENANT_B });
    const response = await handleCreateNotification(
      { body: { domain: 'agent', type: 'task_complete', title: 'Done' }, requestContext: ctx } as RouteRequest,
      principalFor(ctx),
    );

    const body = response.body as { ok: boolean; id?: string; suppressed?: boolean };
    expect(body.ok).toBe(true);
    expect(body.suppressed).toBeUndefined();
    expect(body.id).toBeDefined();

    // Regression guard: the row lands tagged with the REQUEST's project id.
    const row = getDatabase().prepare('SELECT project_id FROM notifications WHERE id = ?')
      .get(body.id) as { project_id: string };
    expect(row.project_id).toBe(tenantB.projectId);
  });

  it('rejects a synthesized (anchor-fallback) context with 400 + tenancy-violation and creates no row', async () => {
    // Both groves enabled — the only reason nothing should be created is the
    // tenancy gate, not a config suppression.
    writeGroveNotifications(GROVE_ANCHOR, home.path, true);
    writeGroveNotifications(GROVE_TENANT_B, home.path, true);

    const kinds: string[] = [];
    const wrapped = tenantRoute(
      { machineId: 'machine-a', logger: recordingLogger(kinds) },
      handleCreateNotification,
    );

    // tenancySource omitted -> 'synthesized' (the daemon's anchor fallback).
    const synthesized = resolveLegacyRequestContext(tenantB.vaultDir, {
      projectId: tenantB.projectId,
      groveId: GROVE_TENANT_B,
      machineId: 'machine-a',
    });

    const response = await wrapped({
      body: { domain: 'agent', type: 'task_complete', title: 'Done' },
      requestContext: synthesized,
      pathname: '/api/notifications',
    } as RouteRequest);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'tenancy-violation' } });
    expect(kinds).toContain('tenancy.violation');
    const n = getDatabase().prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number };
    expect(n.n).toBe(0);
  });
});
