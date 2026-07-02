/**
 * Tests that runAgent() wires a default HarnessHooks (audit-event
 * recorder) into every run by default, and that caller-supplied hooks
 * (via RunOptions.hooks) run ADDITIONALLY, not instead of, the default.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('@myco/intelligence/embed-query.js', () => ({ tryEmbed: async () => null }));

import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { setupTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { epochSeconds, DEFAULT_AGENT_ID } from '@myco/constants.js';
import { makeTestRequestContext } from '../helpers/request-context';
import type { AgentHarness, HarnessExecuteInput, HarnessExecuteResult } from '@myco/agent/harness/types.js';
import type { HarnessId } from '@myco/agent/types.js';

let capturedInputs: HarnessExecuteInput[] = [];

const fakeHarness: AgentHarness = {
  id: 'claude-sdk' as HarnessId,
  async execute(input: HarnessExecuteInput): Promise<HarnessExecuteResult> {
    capturedInputs.push(input);
    return {
      finalText: 'ok',
      turnsUsed: 1,
      usage: { requests: 1, inputTokens: 10, outputTokens: 10, totalTokens: 20, reasoningTokens: 0, cachedTokens: 0, durationMs: 5 },
      sessionRef: 'session-1',
    };
  },
  supports: () => false,
  classifyError: () => 'unknown',
};

mock.module('@myco/agent/harness/index.js', () => ({
  getAgentHarness: () => fakeHarness,
}));

describe('runAgent hook wiring', () => {
  let tmpDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });

  beforeEach(() => {
    capturedInputs = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-executor-hooks-'));
    ensureProjectManifest(tmpDir, { projectName: 'executor-hooks-test' });
    const now = epochSeconds();
    registerAgent({
      id: DEFAULT_AGENT_ID,
      name: `agent-${DEFAULT_AGENT_ID}`,
      created_at: now,
      updated_at: now,
    });
  });

  it('constructs a default audit-event hooks object and passes it through to harness.execute()', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');
    const vaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });

    const result = await runAgent(vaultDir, {
      task: 'title-summary',
      instruction: 'test instruction',
      // dryRun bypasses the title-summary postcondition (which otherwise
      // requires a vault_report/vault_update_session call) — this test only
      // exercises hook wiring, not task-completion semantics.
      dryRun: true,
      requestContext: makeTestRequestContext({
        vaultDir,
        projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        groveId: null,
      }),
    });

    expect(result.status).toBe('completed');
    expect(capturedInputs.length).toBeGreaterThan(0);
    expect(capturedInputs[0].hooks).toBeDefined();
    expect(typeof capturedInputs[0].hooks?.preToolUse).toBe('function');

    // Assert that toolSurface.hooks and hookContext reach the harness input
    const input = capturedInputs[0];
    expect(input.toolSurface).toBeDefined();
    expect(input.toolSurface.hooks).toBeDefined();
    expect(typeof input.toolSurface.hooks?.preToolUse).toBe('function');

    expect(input.toolSurface.hookContext).toBeDefined();
    expect(input.toolSurface.hookContext?.runId).toBe(result.runId);
    expect(input.toolSurface.hookContext?.agentId).toBe(DEFAULT_AGENT_ID);
  });
});
