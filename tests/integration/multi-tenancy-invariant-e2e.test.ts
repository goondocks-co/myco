/**
 * Multi-tenancy invariant end-to-end integration test.
 *
 * Drives the real `createEventDispatcher` for two distinct Grove-bound
 * request contexts in the same process and asserts that each project's
 * data is invisible to the other under scoped queries.
 *
 * Catches the bug class fixed by #235 (`fix(daemon): close cross-project
 * data leaks (multi-tenancy invariant)`) and #280 (`fix(daemon): route
 * /api/config* through the per-request project vault`) — silent
 * cross-project reads when a code path forgets to apply the request
 * context's project scope.
 *
 * This complements the scope-helper unit tests in `tests/tools/` (which
 * verify `projectScopeFromRequestContext` in isolation) by proving the
 * full chain: real dispatcher → DB write under context A → real
 * scoped query under context A returns A-only; under context B
 * returns B-only; under ALL_PROJECTS_SCOPE returns both. If any link
 * regresses, this test fails loudly.
 *
 * Second canary in Phase 3 of the suite audit (#295, #296, #297).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { makeTestRequestContext } from '../helpers/request-context';
import { createEventDispatcher } from '@myco/daemon/event-dispatch.js';
import { SessionRegistry } from '@myco/daemon/lifecycle.js';
import { PowerManager } from '@myco/daemon/power.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { getSession, listSessions } from '@myco/db/queries/sessions.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { ALL_PROJECTS_SCOPE, projectScope } from '@myco/grove/ids.js';
import type { GroveProjectId } from '@myco/grove/ids.js';
import {
  handleGetConfig,
  handlePutScopedConfig,
} from '@myco/daemon/api/config.js';
import { saveConfig } from '@myco/config/loader.js';
import { MycoConfigSchema } from '@myco/config/schema.js';

const GROVE_A = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
const PROJECT_A = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' as GroveProjectId;
const GROVE_B = 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';
const PROJECT_B = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2' as GroveProjectId;

function makeDispatcher() {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tenant-e2e-log-'));
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tenant-e2e-vault-'));
  const logger = new DaemonLogger(logDir, { level: 'warn' });
  const registry = new SessionRegistry({ gracePeriod: 1, onEmpty: () => {} });
  const powerManager = new PowerManager({
    idleThresholdMs: 60_000,
    sleepThresholdMs: 120_000,
    deepSleepThresholdMs: 180_000,
    activeIntervalMs: 60_000,
    sleepIntervalMs: 60_000,
    logger,
  });

  const handler = createEventDispatcher({
    registry,
    sessionBuffers: new Map(),
    powerManager,
    logger,
    machineId: 'local',
    liveConfig: {
      current: {
        agent: { summary_batch_interval: 20 },
        canopy: { exclude: { patterns: [] } },
      } as never,
    },
    vaultDir,
    reconcileSession: () => {},
    planWatchConfig: { watchDirs: [], projectRoot: vaultDir },
    triggerTitleSummary: async () => {},
  });

  return handler;
}

function post(
  handler: ReturnType<typeof makeDispatcher>,
  requestContext: ReturnType<typeof makeTestRequestContext>,
  body: Record<string, unknown>,
) {
  return handler({
    requestContext,
    body,
    query: {},
    params: {},
    pathname: '/events',
  });
}

describe('multi-tenancy invariant — end-to-end through dispatcher', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('a session captured under project A is invisible under project B\'s scope', async () => {
    const handler = makeDispatcher();
    const contextA = makeTestRequestContext({ groveId: GROVE_A, projectId: PROJECT_A });
    const contextB = makeTestRequestContext({ groveId: GROVE_B, projectId: PROJECT_B });

    const sessionA = 'tenant-a-session-001';
    const sessionB = 'tenant-b-session-001';
    const agent = 'claude-code';

    await post(handler, contextA, {
      type: 'user_prompt',
      session_id: sessionA,
      agent,
      prompt: 'project A — first turn',
      transcript_path: '/tmp/fake-transcript-a.jsonl',
    });
    await post(handler, contextA, {
      type: 'tool_use',
      session_id: sessionA,
      agent,
      tool_name: 'Read',
      tool_input: { file_path: '/repo-a/file.ts' },
    });

    await post(handler, contextB, {
      type: 'user_prompt',
      session_id: sessionB,
      agent,
      prompt: 'project B — first turn',
      transcript_path: '/tmp/fake-transcript-b.jsonl',
    });
    await post(handler, contextB, {
      type: 'tool_use',
      session_id: sessionB,
      agent,
      tool_name: 'Read',
      tool_input: { file_path: '/repo-b/file.ts' },
    });

    // --- Each session is visible only under its own project scope ---
    expect(getSession(sessionA, projectScope(PROJECT_A))).not.toBeNull();
    expect(getSession(sessionA, projectScope(PROJECT_B))).toBeNull();

    expect(getSession(sessionB, projectScope(PROJECT_B))).not.toBeNull();
    expect(getSession(sessionB, projectScope(PROJECT_A))).toBeNull();

    // --- listSessions scoped to A returns only A; same for B ---
    const sessionsInA = listSessions({ scope: projectScope(PROJECT_A) });
    expect(sessionsInA.map((s) => s.id).sort()).toEqual([sessionA]);

    const sessionsInB = listSessions({ scope: projectScope(PROJECT_B) });
    expect(sessionsInB.map((s) => s.id).sort()).toEqual([sessionB]);

    // --- ALL_PROJECTS_SCOPE returns both ---
    const allSessions = listSessions({ scope: ALL_PROJECTS_SCOPE });
    expect(allSessions.map((s) => s.id).sort()).toEqual([sessionA, sessionB].sort());

    // --- Batches scoped to A find session A's batch but not session B's ---
    const batchesAfromA = listBatchesBySession(sessionA, { scope: projectScope(PROJECT_A) });
    expect(batchesAfromA.length).toBe(1);
    expect(batchesAfromA[0].user_prompt).toBe('project A — first turn');

    const batchesAfromB = listBatchesBySession(sessionA, { scope: projectScope(PROJECT_B) });
    expect(batchesAfromB.length).toBe(0);

    // --- And the symmetric check for B ---
    const batchesBfromB = listBatchesBySession(sessionB, { scope: projectScope(PROJECT_B) });
    expect(batchesBfromB.length).toBe(1);
    expect(batchesBfromB[0].user_prompt).toBe('project B — first turn');

    const batchesBfromA = listBatchesBySession(sessionB, { scope: projectScope(PROJECT_A) });
    expect(batchesBfromA.length).toBe(0);
  });

  it('config handlers honor the per-request projectVaultDir (no cross-vault leak — #280 surface)', async () => {
    // The #280 regression was that /api/config* fell back to the daemon's
    // bootstrap vault, so a project-A request would see project-B's
    // myco.yaml. The fix routes vaultDir per-request via
    // `req.requestContext?.projectVaultDir ?? bootstrapVaultDir`. The
    // handlers themselves still take `vaultDir` as a plain argument, so
    // we test the contract by writing distinct configs to two temp vaults
    // and proving handleGetConfig returns the right one for each.
    const vaultA = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cfg-tenant-a-'));
    const vaultB = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cfg-tenant-b-'));
    try {
      saveConfig(
        vaultA,
        MycoConfigSchema.parse({
          version: 3,
          appearance: { theme: 'sage', mode: 'dark', font: 'default', density: 'compact' },
        }),
      );
      saveConfig(
        vaultB,
        MycoConfigSchema.parse({
          version: 3,
          appearance: { theme: 'sage', mode: 'dark', font: 'default', density: 'normal' },
        }),
      );

      // Each handler call must return the config that matches the
      // vaultDir we passed — never the other project's.
      const resA = await handleGetConfig(vaultA);
      const resB = await handleGetConfig(vaultB);
      const bodyA = resA.body as { appearance?: { density?: string } };
      const bodyB = resB.body as { appearance?: { density?: string } };

      // Density is a stable, low-side-effect field. Both reads should
      // come back as the value we wrote, never crossed.
      expect(bodyA.appearance?.density).toBe('compact');
      expect(bodyB.appearance?.density).toBe('normal');

      // And a PUT under vaultA must never bleed into vaultB. handlePutScopedConfig
      // writes to the project tier (vaultDir/myco.yaml), so the post-write
      // re-read should show the patched density only in the vault we
      // targeted.
      await handlePutScopedConfig(vaultA, {
        scope: 'project',
        patch: { appearance: { density: 'comfy' } },
      });
      const resA2 = await handleGetConfig(vaultA);
      const resB2 = await handleGetConfig(vaultB);
      expect((resA2.body as { appearance?: { density?: string } }).appearance?.density).toBe('comfy');
      expect((resB2.body as { appearance?: { density?: string } }).appearance?.density).toBe('normal');
    } finally {
      fs.rmSync(vaultA, { recursive: true, force: true });
      fs.rmSync(vaultB, { recursive: true, force: true });
    }
  });

  it('the dispatcher stamps the project_id from the request context onto inserted rows', async () => {
    const handler = makeDispatcher();
    const contextA = makeTestRequestContext({ groveId: GROVE_A, projectId: PROJECT_A });

    await post(handler, contextA, {
      type: 'user_prompt',
      session_id: 'tenant-a-stamp-001',
      agent: 'claude-code',
      prompt: 'stamp check',
      transcript_path: '/tmp/fake-transcript.jsonl',
    });

    // The session row must carry PROJECT_A as its project_id — if the
    // dispatcher were stripping or defaulting context, scoping queries
    // would silently match the wrong rows.
    const session = getSession('tenant-a-stamp-001', projectScope(PROJECT_A));
    expect(session).not.toBeNull();
    expect(session!.project_id).toBe(PROJECT_A);
  });
});
