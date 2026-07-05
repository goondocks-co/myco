/**
 * `handleRun` and `handleResumeRun` reject a governed task before dispatch
 * when its capability is off, with an actionable `capability_disabled` error.
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
import { makeTestRequestContext } from '../../helpers/request-context';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';
import { _clearNotifyDedupForTests } from '@myco/notifications/notify.js';

const epochNow = () => Math.floor(Date.now() / 1000);

const BASE_YAML = 'version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n';

/**
 * `vault_evolution.enabled` is grove-scoped; writing it into project-tier
 * myco.yaml gets silently pruned by the scope-aware sparse merge, so toggle
 * it via local.yaml instead.
 */
function writeConfig(vaultDir: string, vaultEvolutionEnabled: boolean) {
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), BASE_YAML, 'utf-8');
  fs.writeFileSync(
    path.join(vaultDir, 'local.yaml'),
    `vault_evolution:\n  enabled: ${vaultEvolutionEnabled}\n`,
    'utf-8',
  );
}

const runAgentSpy = vi.fn(async () => ({ runId: 'stub', status: 'completed' as const }));
mock.module('@myco/agent/executor.js', () => ({
  runAgent: (...args: unknown[]) => runAgentSpy(...args),
}));
mock.module('@myco/agent/config-resolver.js', () => ({
  hasConfiguredProvider: () => true,
  resolveTaskDefinitionExecution: () => ({}),
}));

function makeRequest(vaultDir: string, overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    pathname: '/',
    requestContext: makeTestRequestContext({ vaultDir }),
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

describe('POST /api/agent/run — capability gate', () => {
  let vaultDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    _clearNotifyDedupForTests();
    runAgentSpy.mockClear();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'Test', created_at: epochNow() });
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-agent-runs-cap-'));
  });

  it('rejects manual vault-seed dispatch with capability_disabled when vault_evolution is off', async () => {
    writeConfig(vaultDir, false);
    const { handleRun } = makeHandlers(vaultDir);
    const response = await handleRun(makeRequest(vaultDir, {
      body: { task: 'vault-seed', instruction: 'seed it' },
    }));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      error: 'capability_disabled',
      capability: 'vault_evolution',
    });
    expect(runAgentSpy).not.toHaveBeenCalled();
  });

  it('admits manual vault-seed dispatch once vault_evolution is enabled', async () => {
    writeConfig(vaultDir, true);
    const { handleRun } = makeHandlers(vaultDir);
    const response = await handleRun(makeRequest(vaultDir, {
      body: { task: 'vault-seed', instruction: 'seed it' },
    }));

    expect(response.body).toMatchObject({ ok: true, message: 'Agent started' });
    expect(runAgentSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves an ungoverned task (title-summary) unaffected by vault_evolution being off', async () => {
    writeConfig(vaultDir, false);
    const { handleRun } = makeHandlers(vaultDir);
    const response = await handleRun(makeRequest(vaultDir, {
      body: { task: 'title-summary', instruction: 'go' },
    }));

    expect(response.body).toMatchObject({ ok: true, message: 'Agent started' });
    expect(runAgentSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects vault-evolve dispatch too (pattern applies to every governed task, not a vault-seed special case)', async () => {
    writeConfig(vaultDir, false);
    const { handleRun } = makeHandlers(vaultDir);
    const response = await handleRun(makeRequest(vaultDir, {
      body: { task: 'vault-evolve', instruction: 'go' },
    }));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'capability_disabled', capability: 'vault_evolution' });
    expect(runAgentSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/agent/runs/:id/resume — capability gate', () => {
  let vaultDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    _clearNotifyDedupForTests();
    runAgentSpy.mockClear();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'Test', created_at: epochNow() });
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-agent-runs-cap-resume-'));
  });

  it('gates resume of a governed task identically — capability disabled since dispatch must not bypass it', async () => {
    writeConfig(vaultDir, false);
    insertRun({
      id: 'run-resume-gate-off',
      agent_id: DEFAULT_AGENT_ID,
      task: 'vault-seed',
      instruction: 'seed it',
      status: 'failed',
      resumable: 1,
      started_at: epochNow(),
    });

    const { handleResumeRun } = makeHandlers(vaultDir);
    const response = await handleResumeRun(makeRequest(vaultDir, {
      params: { id: 'run-resume-gate-off' },
      body: { mode: 'manual' },
    }));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'capability_disabled', capability: 'vault_evolution' });
    expect(runAgentSpy).not.toHaveBeenCalled();
  });

  it('admits resume of a governed task once the capability is enabled', async () => {
    writeConfig(vaultDir, true);
    insertRun({
      id: 'run-resume-gate-on',
      agent_id: DEFAULT_AGENT_ID,
      task: 'vault-seed',
      instruction: 'seed it',
      status: 'failed',
      resumable: 1,
      started_at: epochNow(),
    });

    const { handleResumeRun } = makeHandlers(vaultDir);
    const response = await handleResumeRun(makeRequest(vaultDir, {
      params: { id: 'run-resume-gate-on' },
      body: { mode: 'manual' },
    }));

    expect(response.body).toMatchObject({ ok: true, message: 'Agent resume started' });
    expect(runAgentSpy).toHaveBeenCalledTimes(1);
  });
});
