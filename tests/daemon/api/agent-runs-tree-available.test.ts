/**
 * `handleRun` / `handleResumeRun` — hostServed-vs-treeAvailable audit for
 * user-triggered dispatches (Task C-6 item 2 / inventory follow-up 8).
 *
 * The scheduler (`task-scheduling.ts`) already fed `RegisteredProjectScope
 * .treeAvailable` through to `dispatchAgentRun`'s `RunOptions.treeAvailable`
 * and `buildTaskInstruction`'s `treeAvailable` arg, so a Team Host's SCHEDULED tasks
 * against a served treeless project correctly skip `requiresProjectTree`
 * phases. The two USER-TRIGGERED dispatch entry points in `agent-runs.ts`
 * (`handleRun`, `handleResumeRun`) computed `treeAvailableForRequest` only
 * for the config merge's `projectTierOptional` — never passed it to
 * `dispatchAgentRun`/`buildTaskInstruction` — so a manually triggered
 * skill-generate/evolve for the same served-treeless project ran its
 * tree-requiring phases un-degraded (phase-loop's `ctx.treeAvailable ===
 * false` gate never sees `false`; `undefined` reads as available) and could
 * mkdir a phantom root. This file proves the fix at the dispatch boundary:
 * `runAgent` (mocked here — the same seam `agent-runs-capability-gate.test.ts`
 * uses) receives the correct `treeAvailable` in both the served-treeless and
 * the normal (tree-present) case.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { createAgentRunHandlers } from '@myco/daemon/api/agent-runs';
import type { RouteRequest } from '@myco/daemon/router';
import { resolveLegacyRequestContext } from '@myco/grove/request-context.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';
import { _clearNotifyDedupForTests } from '@myco/notifications/notify.js';

const epochNow = () => Math.floor(Date.now() / 1000);
const TEST_PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

const runAgentSpy = vi.fn(async () => ({ runId: 'stub', status: 'completed' as const }));
mock.module('@myco/agent/executor.js', () => ({
  runAgent: (...args: unknown[]) => runAgentSpy(...args),
}));
mock.module('@myco/agent/config-resolver.js', () => ({
  hasConfiguredProvider: () => true,
  resolveTaskDefinitionExecution: () => ({}),
}));

/** A `MycoRequestContext` whose `projectVaultDir` is passed through
 *  verbatim, so the test controls `projectTreeAvailable`/`treeAvailableForRequest`
 *  by controlling whether `path.dirname(vaultDir)` exists on disk. */
function contextFor(vaultDir: string): MycoRequestContext {
  return resolveLegacyRequestContext(vaultDir, {
    projectId: TEST_PROJECT_ID,
    groveId: null,
    tenancySource: 'caller',
  });
}

function makeRequest(vaultDir: string, overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    pathname: '/',
    requestContext: contextFor(vaultDir),
    ...overrides,
  } as RouteRequest;
}

function makeHandlers(vaultDir: string) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return createAgentRunHandlers({
    vaultDir,
    resolveEmbeddingManager: () => ({} as never),
    logger: logger as never,
  });
}

describe('POST /api/agent/run — user-triggered treeAvailable feed', () => {
  let treeVaultDir: string;
  let treelessVaultDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    _clearNotifyDedupForTests();
    runAgentSpy.mockClear();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'Test', created_at: epochNow() });

    // Normal case: the project root (vaultDir's parent) exists.
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-agent-runs-tree-'));
    treeVaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(treeVaultDir, { recursive: true });
    fs.writeFileSync(path.join(treeVaultDir, 'myco.yaml'), 'version: 3\n', 'utf-8');

    // Served-treeless case: nothing on disk under this root at all — a
    // Team Host serving a member's registered project has no local
    // working tree, so neither the project root nor its `.myco` exists
    // on THIS machine.
    treelessVaultDir = path.join(
      os.tmpdir(),
      `myco-agent-runs-treeless-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      '.myco',
    );
    expect(fs.existsSync(path.dirname(treelessVaultDir))).toBe(false);
  });

  it('feeds treeAvailable:true to dispatchAgentRun when the project root exists', async () => {
    const { handleRun } = makeHandlers(treeVaultDir);
    const response = await handleRun(makeRequest(treeVaultDir, {
      body: { task: 'title-summary', instruction: 'go' },
    }));

    expect(response.body).toMatchObject({ ok: true, message: 'Agent started' });
    expect(runAgentSpy).toHaveBeenCalledTimes(1);
    const options = runAgentSpy.mock.calls[0]![1] as { treeAvailable?: boolean };
    expect(options.treeAvailable).toBe(true);
  });

  it('feeds treeAvailable:false to dispatchAgentRun for a served-treeless project — the mkdir-phantom-root fix', async () => {
    const { handleRun } = makeHandlers(treelessVaultDir);
    const response = await handleRun(makeRequest(treelessVaultDir, {
      body: { task: 'title-summary', instruction: 'go' },
    }));

    expect(response.body).toMatchObject({ ok: true, message: 'Agent started' });
    expect(runAgentSpy).toHaveBeenCalledTimes(1);
    const options = runAgentSpy.mock.calls[0]![1] as { treeAvailable?: boolean };
    expect(options.treeAvailable).toBe(false);
  });
});

describe('POST /api/agent/runs/:id/resume — user-triggered treeAvailable feed', () => {
  let treelessVaultDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    _clearNotifyDedupForTests();
    runAgentSpy.mockClear();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'Test', created_at: epochNow() });

    treelessVaultDir = path.join(
      os.tmpdir(),
      `myco-agent-runs-resume-treeless-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      '.myco',
    );
  });

  it('feeds treeAvailable:false to dispatchAgentRun on a manual resume for a served-treeless project', async () => {
    insertRun({
      id: 'run-resume-treeless',
      agent_id: DEFAULT_AGENT_ID,
      task: 'title-summary',
      instruction: 'go',
      status: 'failed',
      resumable: 1,
      started_at: epochNow(),
    });

    const { handleResumeRun } = makeHandlers(treelessVaultDir);
    const response = await handleResumeRun(makeRequest(treelessVaultDir, {
      params: { id: 'run-resume-treeless' },
      body: { mode: 'manual' },
    }));

    expect(response.body).toMatchObject({ ok: true, message: 'Agent resume started' });
    expect(runAgentSpy).toHaveBeenCalledTimes(1);
    const options = runAgentSpy.mock.calls[0]![1] as { treeAvailable?: boolean };
    expect(options.treeAvailable).toBe(false);
  });
});
